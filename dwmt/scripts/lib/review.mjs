// dwmt: diff i wejście recenzji (`diff`, `review-input`), wyniki rund i dowody.
import { writeFileSync, existsSync, readdirSync, renameSync, rmSync, copyFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { is210, is211, entityText, sweepItems, pathsFor } from '../plan.mjs';
import { batchCtx, splitReviews, findingSection, resolveIds, itemMax, closedIds, remainingItems } from '../batch.mjs';
import { ROOT, fwd, read, asList, str } from './util.mjs';
import { splitHeader, parseYaml, withHeader, tryHeader, section } from './headers.mjs';
import { globToRegExp, pickLenses } from './text.mjs';
import { parseRisks, planUnits, splitPatch, maxFinding, unitFindings, namedSection, sectionBody, idOf } from './risks.mjs';
import { gitRaw, git } from './git.mjs';
import { loadConfig } from './config.mjs';
import { runDir, loadRun, saveRun, isLegacy, taskCtx } from './run.mjs';
import { computeState, fixNow } from './state.mjs';
import { planInfo } from './plan-state.mjs';
import { readPairs, screensTable } from './ui.mjs';
import { productConfig } from './product-config.mjs';
import { knownRed, knownRedSection } from './known-red.mjs';
import { scriptSection, scopeOf } from './script-checks.mjs';

// ---------- diff (D-3) ----------

export function snapshotTree(top) {
  const idx = join(tmpdir(), `dwmt-idx-${process.pid}-${Date.now()}`);
  const env = { GIT_INDEX_FILE: idx };
  try {
    // Kopia prawdziwego indeksu zachowuje cache stat, więc `add -A` nie haszuje całego repo od nowa.
    const real = resolve(top, git(['rev-parse', '--git-path', 'index'], { cwd: top }));
    if (existsSync(real)) copyFileSync(real, idx);
    else git(['read-tree', 'HEAD'], { cwd: top, env });
    git(['add', '-A'], { cwd: top, env });
    return git(['write-tree'], { cwd: top, env });
  } finally { rmSync(idx, { force: true }); }
}

// K2 (D-2), kr1 (D-8, D-16): every path-like token of each `outOfScopeChanges` entry, de-duplicated in order. Tokens split
// on whitespace and commas; wrapping backticks, quotes, brackets and trailing `.,;:!?` stripped from the ends; cut at the
// first `#` and the first `:` after an optional drive letter, then the ends stripped again; `\` → `/`, no leading `./`; an absolute path under `root`
// (prefix compared case-insensitively) made relative. Path-like: contains `/` or ends in a file extension.
const WRAP = /^[`'"()[\]{}<>]+|[`'"()[\]{}<>.,;:!?]+$/g;
export function reportedPaths(entries, root = null) {
  const base = root ? String(root).replace(/\\/g, '/').replace(/\/+$/, '') : '';
  const unwrap = (s) => { let t = s; for (let prev = null; prev !== t;) { prev = t; t = t.replace(WRAP, ''); } return t; };
  const clean = (tok) => {
    let t = unwrap(tok);
    t = t.split('#')[0];
    const colon = t.indexOf(':', /^[A-Za-z]:/.test(t) ? 2 : 0);
    if (colon >= 0) t = t.slice(0, colon);
    // A suffix outside the wrapping (`a.ts`:12, "a.ts"#f) exposes the closing backtick or quote only after the cut.
    t = unwrap(t).replace(/\\/g, '/').replace(/^(\.\/)+/, '');
    if (base && t.length > base.length && t.slice(0, base.length).toLowerCase() === base.toLowerCase() && t[base.length] === '/') t = t.slice(base.length + 1);
    return t;
  };
  const out = asList(entries).flatMap((e) => str(e).split(/[\s,]+/).map(clean))
    .filter((t) => /[^/]/.test(t) && (t.includes('/') || /\.[A-Za-z0-9]+$/.test(t)));
  return [...new Set(out)];
}

// K2 (D-1, D-2): changed files split into `content` (scope glob or reported path), `outside` (the rest) and `product`
// (under the product directory or the published page, checked first). Without a scope list every non-product file is content.
export function diffParts(files, { scope, reported = [], productDir = null, publish = null } = {}) {
  const globs = asList(scope).length ? asList(scope).map((g) => globToRegExp(String(g))) : null;
  const rep = new Set(asList(reported));
  const dir = productDir ? String(productDir).replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '') : '';
  const page = publish ? String(publish).replace(/\\/g, '/').replace(/^(\.\/)+/, '') : '';
  const out = { content: [], outside: [], product: [] };
  for (const f of files) {
    if ((dir && (f === dir || f.startsWith(`${dir}/`))) || (page && f === page)) out.product.push(f);
    else if (!globs || rep.has(f) || globs.some((g) => g.test(f))) out.content.push(f);
    else out.outside.push(f);
  }
  return out;
}

// Filter of the task diff (the batch, D-11: the union of every task plan's scope), reported paths and the product layer.
export function diffFilter(top, ctx) {
  const scopeOf = (f) => asList(tryHeader(f)?.scope).map(String);
  let scope;
  if (ctx.batch) {
    const tasks = join(ctx.root, 'tasks');
    const lists = existsSync(tasks) ? readdirSync(tasks).map((k) => scopeOf(join(tasks, k, 'brief.md'))) : [];
    scope = [...new Set(lists.flat())];
  } else scope = scopeOf(join(ctx.dir, 'brief.md'));
  const reported = reportedPaths(resultHeaders(ctx.dir).flatMap((r) => asList(r.outOfScopeChanges)), top);
  // Batch T-3/F-2: the file a batch item's evidence names is that item's fix (e.g. reverting an unreported out-of-scope file), not a scope hit.
  if (ctx.batch) reported.push(...asList(ctx.t?.items).map((x) => x?.file).filter((f) => f && !reported.includes(f)));
  let pc = null;
  try { pc = productConfig(top, loadConfig(top)); } catch { /* bez warstwy produktowej */ }
  return { scope, reported, productDir: pc?.present ? pc.dir : null, publish: pc?.present ? pc.view?.publish : null };
}

export function diffRun(top, run, ctx, round) {
  const { dir, t } = ctx;
  const tree = snapshotTree(top);
  t.trees = { ...t.trees, [round]: tree };
  const flags = ['diff', '--no-color', '--no-ext-diff'];
  // K2 (D-1, D-2): the full patch split losslessly per file (no pathspecs: Windows command-line limit); content files kept.
  const filter = diffFilter(top, ctx);
  const filtered = (from) => {
    const chunks = splitPatch(git([...flags, from, tree], { cwd: top }));
    const parts = diffParts(chunks.map((x) => x.file), filter);
    return { parts, text: chunks.filter((x) => parts.content.includes(x.file)).map((x) => x.text).join('') };
  };
  const main = filtered(t.baseline);
  writeFileSync(join(dir, 'diff.patch'), main.text);
  const prev = t.trees[round - 1];
  if (round > 1 && prev) writeFileSync(join(dir, 'fix-delta.patch'), filtered(prev).text);
  const stat = git(['diff', '--numstat', t.baseline, tree], { cwd: top }).split(/\r?\n/).filter(Boolean).map((l) => l.split('\t'));
  saveRun(top, run);
  return {
    files: stat.map((s) => s[2]), added: stat.reduce((a, s) => a + (Number(s[0]) || 0), 0), removed: stat.reduce((a, s) => a + (Number(s[1]) || 0), 0),
    patch: fwd(join(dir, 'diff.patch')), delta: round > 1 && prev ? fwd(join(dir, 'fix-delta.patch')) : null,
    outside: main.parts.outside, product: main.parts.product,
  };
}

// K2 (D-2): review-input lines naming the changed files left out of the diff (first 10 each), each only when non-empty.
export function leftOutLines(d) {
  const names = (fs) => `${fs.slice(0, 10).map((f) => `\`${f}\``).join(', ')}${fs.length > 10 ? ` and ${fs.length - 10} more` : ''}`;
  const out = [];
  if (asList(d.outside).length) out.push(`Changed outside the task scope and not reported by the executor (names only, not in the diff; read the file to review it): ${names(d.outside)}.`, '');
  if (asList(d.product).length) out.push(`Product-layer files changed on the branch (not part of the task, not in the diff): ${names(d.product)}.`, '');
  return out;
}

export function cmdDiff(top, id) {
  const run = loadRun(top, id);
  const root = runDir(top, id);
  const st = computeState(root, run, loadConfig(top));
  const d = diffRun(top, run, st.batch ? batchCtx(root, run) : taskCtx(root, run), st.round);
  return { ok: true, count: d.files.length, added: d.added, removed: d.removed, files: d.files.slice(0, 10), patch: d.patch, delta: d.delta, outside: d.outside.length, product: d.product.length };
}

// ---------- wejście recenzji ----------

// v2.9: trafienia wzorców `check:` punktów `[sweep]` w drzewie roboczym (pliki śledzone i nowe), do 30 na punkt.
// Pliki z `git ls-files` (śledzone i nowe, bez ignorowanych) filtrowane globem dwmt (z `{a,b}`), wzorzec jako wyrażenie
// regularne JS (`\d` działa); recenzja v2.9: `git grep -E` z `:(glob)` po cichu dawał „no hits” dla `{ts,tsx}` i `\d`.
export function sweepChecks(top, briefText) {
  const out = [];
  const items = sweepItems(briefText).filter((s) => s.check && s.globs.length);
  if (!items.length) return out;
  const files = gitRaw(['ls-files', '-co', '--exclude-standard', '-z'], { cwd: top }).stdout.split('\0').filter((f) => f && !f.startsWith('.dwmt/'));
  for (const s of items) {
    const what = `\`${s.check}\` in ${s.globs.map((g) => `\`${g}\``).join(', ')}`;
    let re;
    try { re = new RegExp(s.check); } catch (e) { out.push(`- ${what}: the check could not run (invalid pattern: ${e.message})`); continue; }
    const globs = s.globs.map((g) => globToRegExp(g));
    const hits = [];
    for (const f of files.filter((x) => globs.some((g) => g.test(x)))) {
      let text;
      try { if (statSync(join(top, f)).size > 2e6) continue; text = read(join(top, f)); } catch { continue; }
      if (text.includes('\0')) continue;
      text.split(/\r?\n/).forEach((l, i) => { if (re.test(l)) hits.push(`${f}:${i + 1}:${l.trim()}`); });
    }
    if (!hits.length) out.push(`- ${what}: no hits.`);
    else out.push(`- ${what}: ${hits.length} hit(s)${hits.length > 30 ? ', first 30' : ''}; judge whether each is allowed by the plan:`, ...hits.slice(0, 30).map((h) => `  - \`${h.slice(0, 200)}\``));
  }
  return out;
}

export function cmdReviewInput(top, id) {
  const run = loadRun(top, id);
  const root = runDir(top, id);
  const cfg0 = loadConfig(top);
  if (!isLegacy(run)) {
    splitReviews(top, root, run, cfg0, taskCtx(root, run));
    if (computeState(root, run, cfg0).batch) return batchReviewInput(top, run, cfg0, root);
  }
  const ctx = taskCtx(root, run);
  const { dir, t } = ctx;
  const cfg = cfg0;
  const p = (n) => fwd(join(dir, n));
  const round = computeState(root, run, cfg).round;
  const d = diffRun(top, run, ctx, round);
  const briefText = read(join(dir, 'brief.md'));
  const brief = parseYaml(splitHeader(briefText).yaml);
  const risks = parseRisks(briefText);
  const uiIds = risks.filter((r) => r.method === 'ui').map((r) => r.id);
  const evidence = collectEvidence(dir);
  const full = [].concat(cfg.verify.full || []);
  // D2: diff po plikach; pliki generowane (review.ignoreGlobs) poza szacunkiem, jednostkami i diffem recenzenta.
  const parts = splitPatch(read(join(dir, 'diff.patch')));
  const ignored = (f) => asList(cfg.review.ignoreGlobs).some((g) => globToRegExp(g).test(f));
  const reviewed = parts.filter((x) => !ignored(x.file));
  const generated = parts.filter((x) => ignored(x.file)).map((x) => x.file);
  const files = reviewed.map((x) => x.file);
  // v2.10 (tryb pośredni): zmiana bez plików kodu (każdy zmieniony plik, także generowany, pasuje do review.docsGlobs)
  // idzie do recenzenta `review.docsOnlyRole` (domyślnie `reviewer-high`: te same perspektywy, effort high zamiast xhigh).
  // kr1 (D-7): plus the unreported out-of-scope names (no content, but changed by the task); product files never join.
  const reviewer = reviewerFor(run, cfg, [...parts.map((x) => x.file), ...d.outside]);
  const patchOf = (fs) => reviewed.filter((x) => fs.includes(x.file)).map((x) => x.text).join('');
  const stale = new RegExp(`^(review-input-\\d+\\.md|review-${round}-\\d+\\.md|diff-\\d+\\.patch|diff-review\\.patch)$`);
  for (const f of readdirSync(dir).filter((n) => stale.test(n))) rmSync(join(dir, f), { force: true });
  let reviewDiff = d.patch;
  if (generated.length) { writeFileSync(join(dir, 'diff-review.patch'), patchOf(files)); reviewDiff = p('diff-review.patch'); }
  const tests = tryHeader(join(dir, 'tests.md')) || {};
  const repair = tryHeader(join(dir, `repair-${round}.md`));
  const changes = verifyChanges(t, brief);
  // v2.9: wzorce `check:` punktów `[sweep]` uruchamia skrypt (recenzenci sprinty 6+7 powtarzali te grepy, 23% ich odczytów).
  const sweeps = sweepChecks(top, briefText);
  // §5.9: recenzent zadania wie, które zadanie ocenia, czego nie zgłaszać jako braku i jakie kontrakty z planu go dotyczą.
  const plan = ctx.legacy ? null : planInfo(root);
  // K4 (D-15, D-21): przebieg 2.11 z planem sprintu: wejście samowystarczalne, bez ścieżki planu zadania.
  const one = !ctx.legacy && oneSource(run, root);
  const owners = one ? ownerSections({ root, k: ctx.k, briefText, brief, plan }) : null;
  // K4 (D-24, D-32): trafienia kontroli skryptu ostatniego verify rundy, z S-n zapisanymi w stanie (pierwsza jednostka kodu).
  const scriptLines = one ? scriptSection(t, round, { dir }) : [];
  const sprintContext = [];
  if (plan && ctx.n > 1) {
    const me = plan.tasks.find((x) => x.k === ctx.k);
    const later = plan.tasks.filter((x) => x.k > ctx.k);
    sprintContext.push('## Sprint', '', `This change is task ${ctx.k} of ${ctx.n} (T-${ctx.k} ${me?.title ?? ''}); the diff holds only this task.`, '');
    if (later.length) sprintContext.push('Later tasks of the sprint (their scope is not missing here, do not report it):', '', ...later.map((x) => `- T-${x.k} ${x.title}${x.goal ? `: ${x.goal}` : ''}`), '');
    const contracts = (me?.contracts ?? []).map((c) => section(plan.text, c)).filter(Boolean);
    if (contracts.length && !one) sprintContext.push('Contracts between tasks that this task touches (from the sprint plan):', '', ...contracts.flatMap((c) => [c, '']));
  }
  // D4 (spec warstwy produktowej §6.1, 1 linia recenzenta): intencja pozycji backlogu po identyfikatorze śladu z backlogu
  // (Grep, recenzent nie ma Basha), nie z dokumentów planowania; tylko w przebiegu z pliku sprintu albo pozycji.
  if (run.spec || asList(run.items).length) {
    let pc = null;
    try { pc = productConfig(top, cfg); } catch { /* bez warstwy */ }
    if (pc?.present) sprintContext.push(`Backlog items (B-n) named in the plan: take an item's intent by grepping its id in \`${fwd(pc.dir).replace(/\/$/, '')}/backlog*.jsonl\` (one JSON line each), not from planning documents.`, '');
  }
  const intro = (title, fs, others) => {
    const head = [`# Review input: ${brief.goal} (round ${round}${title ? `, unit: ${title}` : ''})`, ''];
    const body = owners ? [...head, ...owners] : [...head, '## Criteria', '', ...(brief.acceptance || []).map((a) => `- ${a}`), ''];
    const decisions = owners ? null : (section(briefText, 'Decisions') || section(briefText, 'Decyzje'));
    if (decisions) body.push(decisions, '');
    body.push(...sprintContext);
    body.push('## Changed files', '', ...fs.slice(0, 40).map((f) => `- ${f}`), ...(fs.length > 40 ? [`- … and ${fs.length - 40} more`] : []), '');
    if (generated.length) body.push(`Generated, not in the diff (\`review.ignoreGlobs\`): ${generated.slice(0, 10).map((f) => `\`${f}\``).join(', ')}${generated.length > 10 ? ` and ${generated.length - 10} more` : ''}.`, '');
    body.push(...leftOutLines(d));
    if (others) body.push(`Other review units cover the remaining ${others} changed files: review only the files above.`, '');
    body.push('## Tests', '', `\`tests.md\` holds this round's targeted tests. The script runs the full suite${full.length ? ` (${full.map((c) => `\`${c}\``).join(', ')})` : ''} at finish, after the review: its absence from \`tests.md\` is not a finding. ${e2eLine(cfg)}`, '');
    // sprint 3: niestabilny test przechodzi dalej, ale niestabilność w zmienionym kodzie to możliwy wyścig.
    if (asList(tests.flaky).length) body.push(`\`tests.md\` marks ${asList(tests.flaky).length} command(s) flaky: red, then green on an immediate rerun. A flaky test that this change adds or touches is a finding (likely race).`, '');
    // v2.9: także czerwień zapowiedziana w planie (`expectedRed`) i przypisana przez wykonawcę już w wyniku rundy.
    const resRed = asList(tryHeader(join(dir, `result-${round}.md`))?.unrelatedRed);
    const known = ctx.legacy ? [] : knownRed(root, run, ctx.k);
    const claimed = [...asList(repair?.unrelatedRed), ...resRed].filter((x) => !known.some((o) => o.claim === str(x)));
    if (tests.result === 'fail' && (claimed.length || asList(brief.expectedRed).length)) {
      if (asList(brief.expectedRed).length) body.push('## Red tests the plan expects', '', ...asList(brief.expectedRed).map((x) => `- ${typeof x === 'string' ? x : JSON.stringify(x)}`), '');
      if (claimed.length) body.push('## Red tests the executor attributes to other causes', '', ...claimed.map((x) => `- ${typeof x === 'string' ? x : JSON.stringify(x)}`), '');
      body.push('Check each claim against `tests.md` and the diff: a red this change caused is a finding.', '');
    }
    // Przegląd sprintu 16 (UI): czerwień zatwierdzona już w recenzji wcześniejszego zadania (bez ponownego badania przyczyny).
    if (tests.result === 'fail') body.push(...knownRedSection(known));
    if (sweeps.length) body.push('## Sweep checks (run by the script on the working tree)', '', ...sweeps, '');
    // Przegląd 2026-10-09 (W-8): sprint M: wykonawca skrócił prompt agenta pod test długości i tego nie zgłosił. Recenzent
    // nie czyta wyników wykonawcy, więc zgłoszone zmiany poza planem dostaje tutaj (zmiana pod test, której tu nie ma: major).
    const reported = [...new Set(resultHeaders(dir).flatMap((r) => asList(r.outOfScopeChanges)).map(str))];
    body.push('## Changes the executor reports outside the plan', '', ...(reported.length ? reported.map((x) => `- ${x}`) : ['- None reported.']), '');
    if (changes.length) {
      body.push('## Verify commands changed after planning', '', ...changes.map((c) => `- ${c.startsWith('+') ? 'now' : 'planned'}: \`${c.slice(2)}\``), '',
        'The executor may fix only how a command runs (syntax, runner project, path), never what it runs: a narrowed or dropped command is a finding.', '');
    }
    return body;
  };
  const riskText = (r) => [r.text, `- Evidence (executor): ${(evidence[r.id] || []).join('; ') || 'none listed'}`, ''];
  const lensText = (lens, i) => [`## Pass ${i + 1}: ${lens}`, '', read(join(ROOT, 'templates', 'lenses', `${lens}.md`)).replace(/\r\n/g, '\n').trim(), ''];
  // Zapis wejść jednostek: przy jednej jednostce review-input.md i review-N.md, przy wielu pliki z numerem jednostki.
  const write = (units) => {
    const many = units.length > 1;
    const inputs = units.map((u) => {
      const name = (n) => (many ? n.replace(/(\.\w+)$/, `-${u.id}$1`) : n);
      const header = { schema: 'dwmt/review-input@1', run: id, round, passes: u.passes, output: p(many ? `review-${round}-${u.id}.md` : `review-${round}.md`), diff: u.diff ?? reviewDiff, tests: p('tests.md'), ...(one ? {} : { brief: p('brief.md') }), ...(u.header || {}), ...(many ? { unit: u.name } : {}) };
      writeFileSync(join(dir, name('review-input.md')), withHeader(header, `\n${u.body.join('\n')}`));
      return { unit: u.name, passes: u.passes, file: p(name('review-input.md')) };
    });
    t.units = { ...t.units, [round]: many ? units.map((u) => ({ id: u.id, name: u.name, ...(u.agent || reviewer !== REVIEWER ? { agent: u.agent ?? reviewer } : {}) })) : null };
    if (reviewer !== REVIEWER || t.reviewAgent) t.reviewAgent = { ...t.reviewAgent, [round]: reviewer };
    t.reviewInput = round;
    saveRun(top, run);
    const agent = reviewer !== REVIEWER ? { agent: reviewer } : {};
    return many ? { ok: true, round, units: inputs, files: files.length, ...agent } : { ok: true, round, passes: inputs[0].passes, files: files.length, file: inputs[0].file, ...agent };
  };
  const screensLine = (who) => ['## Screens', '', `UI risks (${uiIds.join(', ')}) ${who}: do not compare the code with the mockups; review behaviour, contracts and tests.`, ''];

  if (round === 1) {
    const sizes = Object.fromEntries(reviewed.map((x) => [x.file, x.text.length]));
    // X7/D2: ryzyka `ui` nie idą do jednostek kodu; weryfikator UI dostaje tylko pary ze zrzutem i makietą.
    const pairs = readPairs(dir, round).filter((x) => x.shot && x.mockup);
    const units = planUnits({ files, sizes, areas: brief.areas || {}, risks: risks.filter((r) => r.method !== 'ui'), budgetK: cfg.review.splitAboveK, secondLook: cfg.review.secondLookCritical });
    const maxPairs = cfg.ui?.maxPairs || 6;
    for (let i = 0; i < pairs.length; i += maxPairs) {
      const chunk = pairs.slice(i, i + maxPairs);
      units.push({ id: units.length + 1, name: pairs.length > maxPairs ? `ui-${i / maxPairs + 1}` : 'ui', areas: [], files: [], risks: chunk.map((x) => x.id), pairs: chunk, agent: 'dwmt-ui-verifier' });
    }
    const many = units.length > 1;
    for (const u of units) {
      if (many && !u.pairs) { writeFileSync(join(dir, `diff-${u.id}.patch`), patchOf(u.files)); u.diff = p(`diff-${u.id}.patch`); }
      const unitRisks = risks.filter((r) => u.risks.includes(r.id));
      u.passes = u.pairs ? ['visual', 'pragmatism'] : u.secondLook ? ['risks', 'pragmatism']
        : [...(unitRisks.length ? ['risks'] : []), ...pickLenses({ risk: brief.risk || [], changed: [...u.files, ...d.outside], lensGlobs: cfg.review.lensGlobs, max: cfg.review.maxRiskLenses })];
      const body = intro(many ? u.name : null, u.pairs ? files : u.files, many && !u.secondLook && !u.pairs ? files.length - u.files.length : 0);
      if (u === units[0] && !u.pairs) body.push(...scriptLines);
      if (u.secondLook) body.push('## Second look', '', 'Check only the critical risks below; the other passes ran in another unit.', '');
      // Sandbox X7: recenzent kodu czytał makietę html i zgłaszał te same odstępstwa co weryfikator UI.
      if (!u.pairs && uiIds.length) body.push(...screensLine(pairs.length ? 'are compared on screenshots by the ui unit' : 'are compared on screenshots once an e2e test captures them'));
      if (u.pairs) {
        body.push(...screensTable(u.pairs, 'Screens', 'Each pair: the app screenshot from this round\'s e2e run and the agreed mockup at the same viewport. The changed files above only help to locate a finding; another unit reviews the code.'));
        for (const r of unitRisks) body.push(...riskText(r));
      }
      u.passes.forEach((lens, i) => {
        body.push(...lensText(lens, i));
        if (lens === 'risks') for (const r of unitRisks) body.push(...riskText(r));
      });
      u.body = body;
    }
    return write(units);
  }

  // Recheck (runda ≥ 2). D2: uwagi i ryzyka UI sprawdza ponownie weryfikator UI na nowych zrzutach, resztę recenzent.
  const prevText = read(join(dir, `review-${round - 1}.md`));
  const prev = parseYaml(splitHeader(prevText).yaml);
  const base = maxFinding(prevText);
  // v2.8: po podziale recheck sprawdza tylko listę `now` (reszta czeka na rundę zbiorczą).
  const fix = fixNow(prev);
  const byUnit = unitFindings(prevText);
  const uiFound = new Set((t.units?.[round - 1] || []).filter((u) => u.agent === 'dwmt-ui-verifier').flatMap((u) => byUnit[u.name] || []));
  const status = {};
  for (let n = 1; n < round; n++) for (const s of asList(tryHeader(join(dir, `review-${n}.md`))?.risks)) status[String(s).split(/\s/)[0]] = String(s);
  const unproven = uiIds.filter((rid) => !/^\S+\s+proven\b/i.test(status[rid] ?? ''));
  const allPairs = readPairs(dir, round);
  const shown = allPairs.filter((x) => x.shot && x.mockup);
  const uiFix = fix.filter((f) => uiFound.has(f));
  let pairs = shown.filter((x) => unproven.includes(x.id));
  if (!pairs.length && uiFix.length) pairs = shown;
  const codeFix = pairs.length ? fix.filter((f) => !uiFix.includes(f)) : fix;
  const newIds = `Number new findings from F-${base + 1}.`;
  const findings = (ids) => ids.flatMap((fid) => [section(prevText, fid) || `### ${fid} (no section in review-${round - 1}.md)`, '']);
  const code = { id: 1, name: 'recheck', passes: ['recheck'], header: { fix: codeFix, delta: d.delta } };
  code.body = intro(pairs.length ? code.name : null, files, 0);
  code.body.push(...scriptLines);
  code.body.push('## Re-review', '', `Check only the findings on the \`fix\` list: are they fixed in the increment (\`delta\`), and does the increment add a new blocker? Each finding: \`resolved\` or \`open\` with evidence. ${newIds}`, '', ...findings(codeFix));
  const res = tryHeader(join(dir, `result-${round}.md`));
  if (res?.notReproduced?.length) code.body.push('## Fixer: NOT_REPRODUCED', '', ...res.notReproduced.map((n) => `- ${typeof n === 'string' ? n : JSON.stringify(n)}`), '');
  if (pairs.length) {
    code.body.push(...screensLine(`and the UI findings (${uiFix.join(', ') || 'none'}) are re-checked on the new screenshots by the ui unit; do not judge or record them here`));
  } else if (allPairs.length) {
    code.body.push(...screensTable(allPairs, 'Screens (this round)', 'For a finding from a ui unit, Read the new screenshot and its mockup and judge the finding on the images.'));
  }
  if (!pairs.length) return write([code]);
  const ui = { id: 2, name: 'ui', agent: 'dwmt-ui-verifier', passes: ['visual', 'pragmatism'], header: { fix: uiFix } };
  ui.body = intro(ui.name, files, 0);
  ui.body.push('## Re-review', '', `Findings from the previous round on this unit's \`fix\` list (below): compare the new screenshot with its mockup; each \`resolved\` or \`open\` with evidence (an open finding stays on \`fix\` with its id). Then compare every pair below as in the first round. ${newIds}`, '', ...findings(uiFix));
  ui.body.push(...screensTable(pairs, 'Screens (this round)', 'Each pair: the app screenshot from this round\'s e2e run and the agreed mockup at the same viewport. The changed files above only help to locate a finding.'));
  for (const r of risks.filter((x) => pairs.some((y) => y.id === x.id))) ui.body.push(...riskText(r));
  ui.passes.forEach((lens, i) => ui.body.push(...lensText(lens, i)));
  return write([code, ui]);
}

// A (noc 2026-10-05): czy e2e dodane albo zmienione przez sprint biegną przy finish (`verify.e2eChanged`); bez tego nowy
// test e2e, którego nie uruchamia żadna komenda verify, nie biegnie nigdzie (sprinty 9 i 16).
const e2eLine = (cfg) => (cfg.verify?.e2eChanged?.glob
  ? `At finish the script also runs the e2e spec files the sprint adds or changes (\`${cfg.verify.e2eChanged.glob}\`).`
  : 'Finish runs only the commands listed here: a new or changed e2e test that neither they nor a verify command in `tests.md` run never runs, which is a finding.');

const REVIEWER = 'dwmt-reviewer';
export const isDocsOnly = (files, globs) => files.length > 0 && files.every((f) => asList(globs).some((g) => globToRegExp(g).test(f)));
export function reviewerFor(run, cfg, files) {
  const role = cfg.review?.docsOnlyRole;
  if (!role || isLegacy(run) || !is210(run) || !cfg.roles?.[role]) return REVIEWER;
  return isDocsOnly(files, cfg.review.docsGlobs) ? `dwmt-${role}` : REVIEWER;
}

// v2.8: wejście recenzji rundy zbiorczej. Zawsze recheck: w rundzie 1 lista `fix` to pozycje `T-k/F-n` (delta = cały
// diff od commitu ostatniego zadania), potem lista `fix` poprzedniej rundy; jednostka `ui`, gdy pozycje pochodzą z jednostek
// `ui` i są pary zrzut–makieta.
function batchReviewInput(top, run, cfg, root) {
  const id = run.run;
  const b = batchCtx(root, run);
  const { dir, t } = b;
  const p = (n) => fwd(join(dir, n));
  const { rel } = pathsFor(run, top);
  const round = computeState(root, run, cfg).round;
  const d = diffRun(top, run, b, round);
  const parts = splitPatch(read(join(dir, 'diff.patch')));
  const ignored = (f) => asList(cfg.review.ignoreGlobs).some((g) => globToRegExp(g).test(f));
  const reviewed = parts.filter((x) => !ignored(x.file));
  const generated = parts.filter((x) => ignored(x.file)).map((x) => x.file);
  const files = reviewed.map((x) => x.file);
  const stale = new RegExp(`^(review-input-\\d+\\.md|review-${round}-\\d+\\.md|diff-\\d+\\.patch|diff-review\\.patch)$`);
  for (const f of readdirSync(dir).filter((n) => stale.test(n))) rmSync(join(dir, f), { force: true });
  let reviewDiff = d.patch;
  if (generated.length) { writeFileSync(join(dir, 'diff-review.patch'), reviewed.map((x) => x.text).join('')); reviewDiff = p('diff-review.patch'); }
  const tests = tryHeader(join(dir, 'tests.md')) || {};
  const repair = tryHeader(join(dir, `repair-${round}.md`));
  const full = [].concat(cfg.verify.full || []);
  // K4 (D-6): w przebiegu 2.11 recenzent nie dostaje ścieżek planów zadań ani pliku partii (linie `- Task plan:` zostają w batch.md dla wykonawcy).
  const one = is211(run);
  const batchText0 = read(join(dir, 'batch.md'));
  const batchText = one ? batchText0.replace(/^- Task plan: .*\r?\n/gm, '') : batchText0;
  const intro = (title) => {
    const body = [`# Review input: fix batch (round ${round}${title ? `, unit: ${title}` : ''})`, '', '## Fix batch', '',
      one ? 'The sprint\'s tasks are committed; their reviews moved these findings to one round of fixes after the last task (items `T-k/F-n`; `T-k/KR-n`: a known red test in a file the sprint changed, now to be fixed: still red = the item stays on `fix`). The diff holds only this round\'s fixes since the commit of the last task. Each item below carries its finding.'
        : `The sprint's tasks are committed; their reviews moved these findings to one round of fixes after the last task (\`${rel(join(dir, 'batch.md'))}\`, items \`T-k/F-n\`; \`T-k/KR-n\`: a known red test in a file the sprint changed, now to be fixed: still red = the item stays on \`fix\`). The diff holds only this round's fixes since the commit of the last task. Each item names the plan of its task.`, '',
      '## Changed files', '', ...files.slice(0, 40).map((f) => `- ${f}`), ...(files.length > 40 ? [`- … and ${files.length - 40} more`] : []), ''];
    if (generated.length) body.push(`Generated, not in the diff (\`review.ignoreGlobs\`): ${generated.slice(0, 10).map((f) => `\`${f}\``).join(', ')}.`, '');
    body.push(...leftOutLines(d));
    body.push('## Tests', '', `\`tests.md\` holds this round's targeted tests. The script runs the full suite${full.length ? ` (${full.map((c) => `\`${c}\``).join(', ')})` : ''} at finish, after the review: its absence from \`tests.md\` is not a finding. ${e2eLine(cfg)}`, '');
    if (asList(tests.flaky).length) body.push(`\`tests.md\` marks ${asList(tests.flaky).length} command(s) flaky: red, then green on an immediate rerun. A flaky test that this change adds or touches is a finding (likely race).`, '');
    // Przegląd sprintu 16 (UI): czerwień zatwierdzona w recenzjach zadań; wykonawca rundy kopiuje ją bez zmian, więc bez powtórki.
    const known = knownRed(root, run);
    const claimed = [...asList(repair?.unrelatedRed), ...asList(tryHeader(join(dir, `result-${round}.md`))?.unrelatedRed)].filter((x) => !known.some((o) => o.claim === str(x)));
    if (tests.result === 'fail' && claimed.length) body.push('## Red tests the executor attributes to other causes', '', ...claimed.map((x) => `- ${str(x)}`), '', 'Check each claim against `tests.md` and the diff.', '');
    if (tests.result === 'fail') body.push(...knownRedSection(known));
    return body;
  };
  const prevText = round > 1 ? read(join(dir, `review-${round - 1}.md`)) : null;
  const prev = prevText ? parseYaml(splitHeader(prevText).yaml) : null;
  // Gołe `F-n` pozycji (zgubiony przedrostek) wraca do `T-k/F-n`; pozycje zamknięte przez skrypt nie wracają na listę.
  const closed = closedIds(root, run);
  const fix = (round === 1 ? remainingItems(root, run, closed).map((x) => x.id) : resolveIds(prev.fix, t.items).ids).filter((id) => !closed.includes(id));
  const base = Math.max(prevText ? maxFinding(prevText) : 0, itemMax(t.items));
  const prevUi = (t.units?.[round - 1] || []).filter((u) => u.agent === 'dwmt-ui-verifier').map((u) => u.name);
  const byUnit = prevText ? unitFindings(prevText) : {};
  const uiIds = new Set(round === 1 ? t.items.filter((x) => x.ui).map((x) => x.id) : resolveIds(prevUi.flatMap((name) => byUnit[name] || []), t.items).ids);
  const allPairs = readPairs(dir, round);
  const shown = allPairs.filter((x) => x.shot && x.mockup);
  const uiFix = fix.filter((f) => uiIds.has(f));
  const pairs = uiFix.length ? shown : [];
  const codeFix = pairs.length ? fix.filter((f) => !uiFix.includes(f)) : fix;
  const newIds = `Number new findings from F-${base + 1}.`;
  const findings = (ids) => ids.flatMap((fid) => {
    const orig = findingSection(batchText, fid);
    const again = prevText ? findingSection(prevText, fid) ?? (fid.includes('/') ? findingSection(prevText, fid.split('/').pop()) : null) : null;
    return [...(orig ? [orig] : []), ...(again && again !== orig ? [again] : []), ...(!orig && !again ? [`### ${fid} (no section in batch.md or review-${round - 1}.md)`] : []), ''];
  });
  const lensText = (lens, i) => [`## Pass ${i + 1}: ${lens}`, '', read(join(ROOT, 'templates', 'lenses', `${lens}.md`)).replace(/\r\n/g, '\n').trim(), ''];
  const code = { id: 1, name: 'recheck', passes: ['recheck'], header: { fix: codeFix, delta: round === 1 ? d.patch : d.delta } };
  code.body = intro(pairs.length ? code.name : null);
  // K4 (D-32): kontrole skryptu rundy zbiorczej; wejście nie ma `## Scope` ani planów zadań, więc sekcja podaje sumę zakresów.
  if (oneSource(run, root)) code.body.push(...scriptSection(t, round, { scope: scopeOf(b), dir }));
  code.body.push('## Re-review', '', `Check only the findings on the \`fix\` list: are they fixed in the increment (\`delta\`), and does the increment add a new blocker? Each finding: \`resolved\` or \`open\` with evidence; an open finding stays on \`fix\` with its id (\`T-k/F-n\` for batch items). ${newIds}`, '', ...findings(codeFix));
  const res = tryHeader(join(dir, `result-${round}.md`));
  if (res?.notReproduced?.length) code.body.push('## Fixer: NOT_REPRODUCED', '', ...res.notReproduced.map((n) => `- ${str(n)}`), '');
  if (pairs.length) code.body.push('## Screens', '', `The UI findings (${uiFix.join(', ')}) are re-checked on the new screenshots by the ui unit; do not judge or record them here.`, '');
  else if (allPairs.length) code.body.push(...screensTable(allPairs, 'Screens (this round)', 'For a finding from a ui unit, Read the new screenshot and its mockup and judge the finding on the images.'));
  const units = [code];
  if (pairs.length) {
    const ui = { id: 2, name: 'ui', agent: 'dwmt-ui-verifier', passes: ['visual', 'pragmatism'], header: { fix: uiFix } };
    ui.body = intro(ui.name);
    ui.body.push('## Re-review', '', `Findings on this unit's \`fix\` list (below): compare the new screenshot with its mockup; each \`resolved\` or \`open\` with evidence (an open finding stays on \`fix\` with its id). ${newIds}`, '', ...findings(uiFix));
    ui.body.push(...screensTable(pairs, 'Screens (this round)', 'Each pair: the app screenshot from this round\'s e2e run and the agreed mockup at the same viewport. The changed files above only help to locate a finding.'));
    ui.passes.forEach((lens, i) => ui.body.push(...lensText(lens, i)));
    units.push(ui);
  }
  const many = units.length > 1;
  const inputs = units.map((u) => {
    const name = (n) => (many ? n.replace(/(\.\w+)$/, `-${u.id}$1`) : n);
    const header = { schema: 'dwmt/review-input@1', run: id, round, passes: u.passes, output: p(many ? `review-${round}-${u.id}.md` : `review-${round}.md`), diff: reviewDiff, tests: p('tests.md'), ...(one ? {} : { brief: p('batch.md') }), ...u.header, ...(many ? { unit: u.name } : {}) };
    writeFileSync(join(dir, name('review-input.md')), withHeader(header, `\n${u.body.join('\n')}`));
    return { unit: u.name, passes: u.passes, file: p(name('review-input.md')) };
  });
  t.units = { ...t.units, [round]: many ? units.map((u) => ({ id: u.id, name: u.name, ...(u.agent ? { agent: u.agent } : {}) })) : null };
  t.reviewInput = round;
  saveRun(top, run);
  return many ? { ok: true, batch: true, round, units: inputs, files: files.length } : { ok: true, batch: true, round, passes: inputs[0].passes, files: files.length, file: inputs[0].file };
}

// K4 (D-15): jedno źródło na byt planu (C-1) tylko w przebiegach z regułami 2.11+ i planem sprintu; inline i import bez zmian.
export const oneSource = (run, root) => !isLegacy(run) && is211(run) && existsSync(join(root, 'plan.md'));
const briefIds = (briefText, key) => {
  const s = splitHeader(String(briefText ?? ''));
  try { return s ? asList(parseYaml(s.yaml)[key]).map((x) => idOf(String(x))) : []; } catch { return []; }
};
const entityBlock = (e) => [`### ${e.id}${e.title ? ` ${e.title}` : ''}`, ...(e.text ? [e.text] : []), ''];
// K4 (D-20): decyzje D-n z nagłówka `decisions` planu zadania i kontrakty C-n z linii `Contracts:` zadania w planie sprintu,
// których tekst ma plan sprintu; kolejność planu zadania, D-n przed C-n.
export function sprintEntities(root, k, briefText) {
  const plan = planInfo(root);
  if (!plan) return [];
  const me = plan.tasks.find((x) => x.k === k);
  const ids = [...new Set([...briefIds(briefText, 'decisions').filter((x) => /^D-\d+$/.test(x)), ...(me?.contracts ?? [])])];
  return ids.map((x) => entityText({ planText: plan.text, briefText }, x)).filter((e) => e?.source === 'plan' && e.text);
}
export function executorBlock(root, k, briefText) {
  const list = sprintEntities(root, k, briefText);
  if (!list.length) return '';
  return `\n\nSprint decisions and contracts your task plan names (text from the sprint plan):\n\n${list.flatMap(entityBlock).join('\n').trimEnd()}`;
}
// K4 (D-21): sekcje wejścia recenzji 2.11 z właścicieli: kryteria, decyzje (sprintu i zadania), kontrakty zadania, zakres,
// poza zakresem, wyciągi. Wpis `acceptance` z tekstem po identyfikatorze (stary kształt, C-2) idzie tak, jak jest.
export function ownerSections({ root, k, briefText, brief, plan }) {
  const src = { planText: plan?.text ?? null, briefText };
  const crit = asList(brief.acceptance).map((a) => {
    const entry = String(a);
    const id = idOf(entry);
    const rest = entry.slice(id.length).trim();
    const e = /^AC-\d+$/.test(id) && (!rest || /^\(part:/i.test(rest)) ? entityText(src, id) : null;
    return `- ${e ? `${id} ${e.text}` : entry}`;
  });
  const out = ['## Criteria', '', ...crit, ''];
  const decSec = namedSection(briefText, 'Decisions') ?? namedSection(briefText, 'Decyzje') ?? '';
  const decIds = [...new Set([...briefIds(briefText, 'decisions'), ...[...decSec.matchAll(/^#{2,6}\s+[*`]*(D-\d+)\b/gm)].map((m) => m[1])].filter((x) => /^D-\d+$/.test(x)))];
  const decisions = decIds.map((x) => entityText(src, x)).filter(Boolean);
  if (decisions.length) out.push('## Decisions', '', ...decisions.flatMap(entityBlock));
  const me = plan?.tasks.find((x) => x.k === k);
  const contracts = (me?.contracts ?? []).map((c) => entityText(src, c)).filter(Boolean);
  if (contracts.length) out.push('## Contracts', '', ...contracts.flatMap(entityBlock));
  if (asList(brief.scope).length) out.push('## Scope', '', ...asList(brief.scope).map((s) => `- \`${s}\``), '');
  for (const name of ['Out of scope', 'Standards and docs excerpts']) {
    const b = sectionBody(namedSection(briefText, name));
    if (b) out.push(`## ${name}`, '', b.replace(/\r\n/g, '\n'), '');
  }
  return out;
}

// Komendy verify z planu wobec bieżącego briefu (D2): `- <usunięta>`, `+ <dodana>`.
export function verifyChanges(t, brief) {
  // E: w trybie direct komendy `verify` dopisuje wykonawca (plan skryptu ich nie ma), więc nie ma czego porównywać.
  if (!t.verifyPlanned || brief?.mode === 'direct') return [];
  const now = asList(brief.verify);
  return [...t.verifyPlanned.filter((c) => !now.includes(c)).map((c) => `- ${c}`), ...now.filter((c) => !t.verifyPlanned.includes(c)).map((c) => `+ ${c}`)];
}

// Punkty listy markdown z wierszami kontynuacji (wcięte), sklejone w jedną linię.
export function bullets(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*[-*]\s+(.*)$/.exec(line);
    if (m) out.push(m[1].trim());
    else if (out.length && /^\s+\S/.test(line)) out[out.length - 1] += ` ${line.trim()}`;
  }
  return out;
}

// Następny wolny A-n: brief i dotychczasowe wyniki (sprint 3 cz. 3: wykonawca rundy 2 zaczął od A-1).
export function nextAssumption(dir) {
  const files = ['brief.md', ...resultFiles(dir)].map((f) => join(dir, f));
  const text = files.filter((f) => existsSync(f)).map(read).join('\n');
  return Math.max(0, ...[...text.matchAll(/\bA-(\d+)\b/g)].map((m) => Number(m[1]))) + 1;
}

// Nagłówki wyników wykonawcy po kolei: result-N.md i naprawa repair-N.md (D2).
// Odcinki PARTIAL i BLOCKED rundy zostają jako `result-N.partial-M.md` i `result-N.blocked-M.md`: ich uwagi (`laterNotes`,
// `changedContracts`, dowody) liczą się jak wynik końcowy (recenzja v2.7: kontynuacja nadpisywała result-N.md).
export function resultFiles(dir) {
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir);
  const out = [];
  const seg = (n, kind) => names.map((f) => new RegExp(`^result-${n}\\.${kind}-(\\d+)\\.md$`).exec(f)).filter(Boolean)
    .sort((a, b) => Number(a[1]) - Number(b[1])).map((m) => m[0]);
  const rounds = [...new Set(names.map((f) => /^(?:result|repair)-(\d+)(?:\.(?:partial|blocked)-\d+)?\.md$/.exec(f)?.[1]).filter(Boolean).map(Number))].sort((a, b) => a - b);
  for (const n of rounds) out.push(...seg(n, 'partial'), ...seg(n, 'blocked'), ...[`result-${n}.md`, `repair-${n}.md`].filter((f) => names.includes(f)));
  return out;
}
export function resultHeaders(dir) {
  return resultFiles(dir).map((f) => tryHeader(join(dir, f)) || {});
}

// Przed kontynuacją PARTIAL: wynik odcinka zostaje jako `result-N.partial-M.md` (kolejny wykonawca pisze result-N.md od nowa).
export function archivePartial(dir, round) {
  const f = join(dir, `result-${round}.md`);
  if (tryHeader(f)?.status !== 'PARTIAL') return false;
  let n = 1;
  while (existsSync(join(dir, `result-${round}.partial-${n}.md`))) n++;
  renameSync(f, join(dir, `result-${round}.partial-${n}.md`));
  return true;
}

// Dowody wykonawcy dla ryzyk: `evidence: ["R-1 <plik> › <test>"]` w nagłówkach result-N.md (i repair-N.md).
export function collectEvidence(dir) {
  const ev = {};
  for (const h of resultHeaders(dir)) {
    for (const e of asList(h.evidence)) {
      const s = typeof e === 'string' ? e : JSON.stringify(e);
      const rid = /R-\d+/.exec(s)?.[0];
      if (rid) (ev[rid] ||= []).push(s);
    }
  }
  return ev;
}
