// dwmt: raporty zadań i przebiegu, odłożone uwagi.
import { writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { is27, is28, is212, replansOf, goalCheckInfo, planFindingIds } from '../plan.mjs';
import { batchItemResults, batchedOf, batchStats, batchDeferred, findingInfo, triageOf, deferredIdsOf } from '../batch.mjs';
import { ROOT, fwd, read, asList, str } from './util.mjs';
import { splitHeader, parseYaml, withHeader, tryHeader, section } from './headers.mjs';
import { parseRisks, namedSection, sectionBody, idOf, uatScenario, uatNone, unitFindings, rank, PENDING_UAT, stripUatRef } from './risks.mjs';
import { gitRaw, git } from './git.mjs';
import { runDir, isLegacy, allTasks, runHome } from './run.mjs';
import { reviewPassed } from './state.mjs';
import { planInfo } from './plan-state.mjs';
import { sessionsCost, callerCost } from './sessions.mjs';
import { finishRepairReport } from './finish-repair.mjs';
import { latestPairs, writeCompare } from './ui.mjs';
import { verifyChanges, bullets, resultHeaders, collectEvidence, oneSource } from './review.mjs';
import { commitWith } from './commit.mjs';
import { priceReport, estOverheadOf } from './price-gate.mjs';
import { productConfig } from './product-config.mjs';
import { paths as productPaths } from './product-store.mjs';
import { overhead } from './product-ops.mjs';

// K2 (C-1, C-3): jedna odłożona uwaga z recenzji: waga efektywna i klasa podłogi (findingInfo), tytuł bez znaczników,
// powód z linii pragmatism (triageOf, obie formy) i miejsce („Likely”) z najnowszej recenzji z sekcją uwagi.
// `item`: otwarta pozycja rundy zbiorczej; gdy recenzje nie mają sekcji z wagą (znana czerwień `KR-n`), waga i tytuł z niej.
function deferredFinding(texts, id, item = null) {
  const text = [...texts].reverse().find((t) => section(t, id)) || '';
  const sec = section(text, id);
  const info = findingInfo(texts, id, '');
  const why = ([...texts].reverse().map((t) => triageOf(t, id)).find(Boolean)?.reason || '').trim() || null;
  const where = (sec && /^- Likely: (.+)$/m.exec(sec)?.[1]) || null;
  const own = Boolean(info.section && info.severity);
  const severity = (own ? info.severity : item?.severity ?? info.severity) ?? 'minor';
  const title = own || !item?.title ? (info.section ? info.title : '') : item.title;
  return { finding: id, severity, floor: info.floor, title, why, where };
}
// Tekst wpisu: `<id> [<sev>][ [floor: <class>]] <title>[ — <why>][ (<where>)]`.
const deferredText = (x, id = x.finding) => `${id} [${x.severity}]${x.floor ? ` [floor: ${x.floor}]` : ''}${x.title ? ` ${x.title}` : ''}${x.why ? ` — ${x.why}` : ''}${x.where ? ` (${x.where})` : ''}`;

// Odłożone uwagi (defer) do zbiorczego pliku: identyfikator, waga efektywna (z podłogą), tytuł, powód z pragmatism i miejsce.
export function deferredEntries(reviewTexts, ids) {
  return ids.map((id) => `- ${deferredText(deferredFinding(reviewTexts, id))}`);
}

// K2 (C-3): wciąż odłożone uwagi przebiegu w kolejności C-1 (zadania po kolei, potem runda zbiorcza), z pełnymi
// identyfikatorami `T-k/F-n` i `batch/F-n`. Zbiór jak dotąd w writeDeferred: `defer` recenzji zadań (z odrzuconymi bez
// kontrdowodu uwagami z podłogą), otwarte pozycje rundy zbiorczej, bez poprawionych i nieodtworzonych, plus `defer`
// recenzji rundy zbiorczej. Jedno źródło dla pliku odłożonych uwag, nagłówka i treści raportu sprintu (i bramki finish).
// Runda zbiorcza T-2/F-2: uwagi poprawione przez użytkownika po zatrzymaniu (`finish --fixed-deferred`, run.deferredFixed)
// nie są już odłożone; `fixedDeferredFindings` daje je osobno do raportu.
export function deferredFindings(top, run, cfg) {
  const fixed = new Set(asList(run.deferredFixed?.ids));
  return allDeferredFindings(top, run, cfg).filter((x) => !fixed.has(x.id));
}
export function fixedDeferredFindings(top, run, cfg) {
  const fixed = new Set(asList(run.deferredFixed?.ids));
  return fixed.size ? allDeferredFindings(top, run, cfg).filter((x) => fixed.has(x.id)) : [];
}
function allDeferredFindings(top, run, cfg) {
  const root = runDir(top, run.run);
  const ctxs = allTasks(root, run);
  // v2.8: pozycje rundy zbiorczej poprawione (albo nieodtworzone) znikają z listy; otwarte po niej są odłożone.
  const items = is28(run) && !isLegacy(run) ? batchItemResults(root, run) : [];
  const closed = new Set(items.filter((x) => x.result !== 'open').map((x) => x.id));
  const out = ctxs.flatMap((c) => {
    const texts = reviewTexts(c.dir);
    const ids = [...new Set([
      ...texts.flatMap((x, i) => deferredIdsOf(parseYaml(splitHeader(x)?.yaml ?? ''), texts.slice(0, i + 1))),
      ...items.filter((x) => x.task === c.k && x.result === 'open').map((x) => x.finding),
    ])].filter((f) => !closed.has(`T-${c.k}/${f}`));
    return ids.map((f) => ({ id: `T-${c.k}/${f}`, task: c.k, ...deferredFinding(texts, f, items.find((x) => x.id === `T-${c.k}/${f}`)) }));
  });
  // v2.8: nowe uwagi rundy zbiorczej odłożone przez jej recenzję (`batch/F-n`).
  if (items.length) {
    const texts = reviewTexts(join(root, 'batch'));
    out.push(...batchDeferred(root, run).ids.map((f) => ({ id: `batch/${f}`, task: null, ...deferredFinding(texts, f) })));
  }
  return out;
}

// Odłożone uwagi wszystkich zadań do zbiorczego pliku; przy wielu zadaniach z przedrostkiem T-k/, runda zbiorcza batch/.
// K2 (D-9): bramka finish — odłożone uwagi `major` i `blocker` jeszcze nieprzyjęte przez użytkownika (`run.deferredAccepted`),
// z tekstem wpisu C-1 dla listy `majors`.
export const MAJOR_SEVERITIES = ['major', 'blocker'];
export function openDeferredMajors(top, run, cfg) {
  const accepted = new Set(asList(run.deferredAccepted?.ids));
  return deferredFindings(top, run, cfg).filter((x) => MAJOR_SEVERITIES.includes(x.severity) && !accepted.has(x.id))
    .map((x) => ({ id: x.id, text: deferredText(x, x.id) }));
}

export function writeDeferred(top, run, cfg) {
  const rel = cfg.review.deferredFile;
  const root = runDir(top, run.run);
  const ctxs = allTasks(root, run);
  const entries = deferredFindings(top, run, cfg).map((x) => `- ${deferredText(x, x.task == null || ctxs.length > 1 ? x.id : x.finding)}`);
  if (!rel || !entries.length) return null;
  // Plik ignorowany przez git (domyślnie .dwmt/) żyje w drzewie domowym przebiegu (D-4); śledzony idzie w squashu.
  const tracked = gitRaw(['check-ignore', '-q', rel], { cwd: top }).status !== 0;
  const home = tracked ? top : runHome(run, top);
  const file = join(home, rel);
  const old = existsSync(file) ? read(file) : '# Deferred review findings (dwmt)\n\nFindings the review deferred. Remove an entry when it is done or planned elsewhere.\n';
  if (old.includes(`## ${run.run}`)) return { file: fwd(file), committed: false };
  const goal = planInfo(root)?.h.goal ?? tryHeader(join(ctxs[0].dir, 'brief.md'))?.goal ?? '';
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${old.trimEnd()}\n\n## ${run.run}\n\n${goal}\n\n${entries.join('\n')}\n`);
  if (tracked) {
    git(['add', '--', rel], { cwd: top });
    commitWith(top, `dwmt: odłożone uwagi ${run.run}\n`);
  }
  return { file: fwd(file), committed: tracked };
}

export function reviewTexts(dir) {
  const out = [];
  for (let n = 1; existsSync(join(dir, `review-${n}.md`)); n++) out.push(read(join(dir, `review-${n}.md`)));
  return out;
}

// Dane zadania do raportu zadania i raportu sprintu: kontrakt, statusy AC i ryzyk, testy, uwagi, ekrany.
function taskData(ctx) {
  const { dir, t, k } = ctx;
  const briefFile = join(dir, 'brief.md');
  const briefText = existsSync(briefFile) ? read(briefFile) : '';
  const brief = tryHeader(briefFile) || {};
  const texts = reviewTexts(dir);
  const reviews = texts.map((_, i) => tryHeader(join(dir, `review-${i + 1}.md`)) || {});
  const results = resultHeaders(dir);
  const last = reviews[reviews.length - 1] || {};
  // Recheck podaje tylko kryteria, których dotyczyła poprawka (sprint 3 cz. 3: raport miał resztę jako „unverified”).
  const accStatus = new Map();
  reviews.forEach((r, i) => { for (const s of asList(r.acceptance)) accStatus.set(idOf(s), withFindings(String(s), texts[i])); });
  const briefAc = asList(brief.acceptance).map(idOf);
  const riskStatus = {};
  for (const r of reviews) for (const s of asList(r.risks)) riskStatus[idOf(s)] = String(s);
  const risks = parseRisks(briefText);
  const acNorm = (s) => pendingUat(qualifiedMet(s), risks);
  const pairs = latestPairs(dir);
  const compare = pairs.length ? writeCompare(dir, pairs, Object.fromEntries(pairs.map((x) => [x.id, riskStatus[x.id] ?? `${x.id} unverified`]))) : null;
  const targeted = tryHeader(join(dir, 'tests.md'));
  // Do oceny w UAT: uwagi jednostek weryfikatora UI, które recenzja odłożyła (§5.11).
  const uiDeferred = [];
  const uiDeferredIds = [];
  texts.forEach((text, i) => {
    const units = asList(t.units?.[i + 1]).filter((u) => u.agent === 'dwmt-ui-verifier');
    if (!units.length) return;
    const byUnit = unitFindings(text);
    const ui = new Set(units.flatMap((u) => byUnit[u.name] || []));
    const ids = deferredIdsOf(reviews[i], texts.slice(0, i + 1)).filter((f) => ui.has(f));
    uiDeferred.push(...deferredEntries(texts.slice(0, i + 1), ids));
    uiDeferredIds.push(...ids);
  });
  return {
    k, t, dir, brief, briefText, reviews, texts, results, risks, riskStatus, compare, pairs, targeted, uiDeferred, uiDeferredIds,
    // v2.8: puste `now` (reszta w rundzie zbiorczej) kończy zadanie jak PASS.
    // v2.10 (B): plik z `delete` bez zgody (`kept`) to kryterium niespełnione, więc zadanie jest ACCEPTED.
    status: reviewPassed(last) && !(t.accepted && last.verdict !== 'PASS') && !asList(t.kept).length ? 'PASS' : 'ACCEPTED',
    acceptance: [
      ...briefAc.map((id) => acNorm(accStatus.get(id) ?? `${id} unverified`)), ...[...accStatus].filter(([id]) => !briefAc.includes(id)).map(([, v]) => acNorm(v)),
      // v2.10 (B): pliki z `delete` bez zgody użytkownika zostają, a usunięcie jest kryterium niespełnionym.
      ...(asList(t.kept).length ? [`delete not met: kept without the user's consent: ${asList(t.kept).join(', ')}`] : []),
    ],
    kept: asList(t.kept), deleted: asList(t.deleted),
    decisions: [...(section(briefText, 'Decisions') || '').matchAll(/^#{2,6}\s+(D-\d+\b.*)$/gm)].map((m) => m[1].trim()),
    assumptions: bullets(section(briefText, 'Assumptions') || '').filter((a) => /^A-\d+\b/.test(a)),
    resultAssumptions: results.flatMap((r) => asList(r.assumptions)),
    // Kontynuacje (PARTIAL, BLOCKED) powtarzają odchylenia poprzednich odcinków: w raporcie każde raz.
    deviations: [...new Map(results.flatMap((r) => asList(r.outOfScopeChanges)).map((x) => [str(x), x])).values()],
    changedContracts: [...new Set(results.flatMap((r) => asList(r.changedContracts)))],
    // K2 (C-2): z odrzuconymi bez kontrdowodu uwagami z podłogą.
    deferred: [...new Set(reviews.flatMap((r, i) => deferredIdsOf(r, texts.slice(0, i + 1))))], missed: [...new Set(reviews.flatMap((r) => asList(r.missed)))],
    flaky: asList(targeted?.flaky), verifyChanged: verifyChanges(t, brief), evidence: collectEvidence(dir),
    // v2.7: uwagi dla kolejnych zadań ze wszystkich rund (także fixera i naprawy); kontrola rozjazdu czyta je z report.md.
    laterNotes: [...new Set(results.flatMap((r) => asList(r.laterNotes)).map(str))],
    // kt (D-17): committed measurement files named by the results; the final report shows their content.
    measurements: [...new Set(results.flatMap((r) => asList(r.measurements)).map(str))],
    planFindings: planFindingIds(texts), replans: replansOf(t),
  };
}

// kt (D-17): `## Measurements` with each file's first 150 lines (paths from the repo root); '' without paths.
export function measurementsSection(top, paths, max = 150) {
  const list = asList(paths).map(str).filter(Boolean);
  if (!list.length) return '';
  const parts = list.map((p) => {
    const f = join(top, p);
    if (!existsSync(f)) return `- \`${p}\`: not found in the tree.`;
    const lines = read(f).replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    const more = lines.length - max;
    return [`### \`${p}\``, '', ...lines.slice(0, max), ...(more > 0 ? ['', `(truncated: ${more} more lines in the file)`] : [])].join('\n');
  });
  return `\n## Measurements\n\n${parts.join('\n\n')}\n`;
}

// Przegląd 2026-10-09 (W-6): status kryterium bez powodu („AC-4 partial”, phase-5 T-1), choć tabela recenzji podaje uwagi
// (F-9, F-10): identyfikatory F-n z wiersza tabeli albo punktu listy tego kryterium w treści tej samej recenzji.
const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function withFindings(s, text) {
  const str = String(s);
  const id = idOf(str);
  if (str.slice(id.length).trim().split(/\s+/).length > 2 || rank(str) === 2 || /\bF-\d+\b/.test(str)) return str;
  const row = new RegExp(`^\\s*(?:\\|\\s*|[-*]\\s+)\\**${reEsc(id)}\\b`);
  const lines = String(text ?? '').split(/\r?\n/).filter((l) => row.test(l));
  const fs = [...new Set(lines.flatMap((l) => [...l.matchAll(/(?<![\w/])F-\d+\b/g)].map((m) => m[0])))];
  return fs.length ? `${str} (${fs.join(', ')})` : str;
}

// W-6: spełnione z zastrzeżeniem po średniku poza nawiasami („AC-7 (totals) met; Discount row below the fold, not
// decided by the screens”) to kryterium częściowe z tą notatką. Recenzja poprawek: tylko gdy reszta ogranicza
// (not, never, only, except, without, below the fold…) i między `met` a średnikiem nie ma dwukropka: po `met:` są dowody,
// a średniki dzielą ich listę („AC-6 met: …; no second toolbar”).
const LIMITING = /\b(not|never|only|except|without|lacks?|missing|untested|unchecked|uncovered|undecided|below the fold|outside)\b/i;
export function qualifiedMet(s) {
  const str = String(s);
  if (rank(str) !== 2 || !/\bmet\b/i.test(str)) return str;
  let top = str;
  for (let prev = null; prev !== top;) { prev = top; top = top.replace(/\([^()]*\)/g, ''); }
  const m = /\bmet\b([^;]*);\s*(\S.*)$/i.exec(top);
  if (!m || m[1].includes(':') || !LIMITING.test(m[2]) || /\b(met|proven|resolved)\b/i.test(m[2]) || PENDING_UAT.test(m[2])) return str;
  const id = idOf(str);
  return `${id} partial: ${str.slice(id.length).trim()}`;
}

// W-6: kryterium, którego jedynym dowodem jest ryzyko `Method: human` (kryterium o wyglądzie ekranu, które ocenia człowiek w UAT),
// to `met pending UAT`: ryzyko human nazywa kryterium, a żadne inne ryzyko planu zadania go nie nazywa. Recenzent też
// może tak napisać (perspektywa correctness).
export function pendingUat(s, risks) {
  const str = String(s);
  if (rank(str) !== 2 || PENDING_UAT.test(str)) return str;
  const re = new RegExp(`\\b${reEsc(idOf(str))}\\b`);
  const naming = asList(risks).filter((r) => re.test(r.text ?? ''));
  const human = naming.filter((r) => r.method === 'human');
  if (!human.length || human.length !== naming.length) return str;
  return `${str.replace(/\bmet\b/i, 'met pending UAT')} (UAT: ${human.map((r) => r.id).join(', ')})`;
}

// Raport zadania przy jego commicie (§5.9): czytają go kontrola rozjazdu, architekt przy `replan` i raport sprintu.
export function writeTaskReport(run, ctx) {
  const d = taskData(ctx);
  const title = ctx.t.title || d.brief.goal || '';
  const header = {
    schema: 'dwmt/task-report@1', run: run.run, task: `T-${ctx.k}`, title, status: d.status, commit: ctx.t.commit?.slice(0, 10) ?? null, rounds: d.reviews.length,
    acceptance: d.acceptance, decisions: d.decisions.map(idOf), assumptions: [...new Set([...d.assumptions.map(idOf), ...d.resultAssumptions.map(str)])],
    changedContracts: d.changedContracts.map(str), deviations: d.deviations.map(str), deferred: d.deferred,
    risks: d.risks.map((r) => d.riskStatus[r.id] ?? `${r.id} ${r.method === 'human' ? 'human' : 'unverified'}`),
    laterNotes: d.laterNotes,
    ...(d.deleted.length ? { deleted: d.deleted } : {}), ...(d.kept.length ? { kept: d.kept } : {}),
  };
  // v2.8: uwagi przeniesione do rundy zbiorczej (`F-n powód`).
  const batched = batchedOf(run, ctx.k);
  if (batched.length) header.batched = batched;
  const list = (title2, items) => (items.length ? [`## ${title2}`, '', ...items.map((x) => `- ${str(x)}`), ''] : []);
  const texts = d.texts;
  const body = [
    `# T-${ctx.k} ${title}`, '', `Goal: ${d.brief.goal ?? ''}`, '',
    ...list('Criteria', d.acceptance), ...list('Decisions', d.decisions), ...list('Assumptions', [...d.assumptions, ...d.resultAssumptions]),
    ...list('Changed contracts', d.changedContracts), ...list('Changes outside the scope', d.deviations),
    ...list('Deferred findings', deferredEntries(texts, d.deferred).map((e) => e.replace(/^- /, ''))),
    ...list('Notes for later tasks', d.laterNotes),
    ...list('Moved to the fix batch', batched),
  ];
  const file = join(ctx.dir, 'report.md');
  writeFileSync(file, withHeader(header, `\n${body.join('\n')}\n`));
  return fwd(file);
}

// Status kryterium sprintu z zadań: najgorszy; brak rozstrzygnięcia jest gorszy niż `met` (luka w pokryciu), a `met pending
// UAT` gorsze niż samo `met` (zostaje widoczne, gdy inne zadanie tego kryterium podaje `met`).
const coverLevel = (s) => { const r = rank(s); return r === 3 ? 1.5 : r === 2 && PENDING_UAT.test(s) ? 1.9 : r; };
const worstStatus = (list) => list.reduce((a, b) => (coverLevel(b) < coverLevel(a) ? b : a));
export const isMet = (s) => rank(s) === 2 && /\bmet\b/i.test(s);

// Przegląd sprintu 16 (UI): kryteria i ryzyka zadań po rundzie zbiorczej. Raport brał je tylko z recenzji zadań, więc zostały
// „AC-8 partial … (F-1)” i „T-2/R-8 unproven … (F-8 open)”, choć partia poprawiła F-1 i F-8, a jej recenzja potwierdziła
// R-8. Status spoza `met`/`proven` zastępuje (1) status z recenzji partii (`T-k/AC-n`, `T-k/R-n` albo bez przedrostka),
// a bez niego (2) „met/proven after the fix batch”, gdy wszystkie uwagi F-n, które ten status wymienia, partia rozwiązała.
const STATUS_HEAD = /^(\S+(?:\s+\([^)]*\))?)\s/;
function applyBatch(root, run, data, many) {
  const items = batchItemResults(root, run);
  if (!items.length) return;
  const resolved = new Set(items.filter((x) => ['resolved', 'notReproduced'].includes(x.result)).map((x) => x.id));
  const dir = join(root, 'batch');
  const reviews = reviewTexts(dir).map((_, i) => tryHeader(join(dir, `review-${i + 1}.md`)) || {});
  batchStatuses(data, { resolved, reviews, many });
}

// Czysta część: `data` zadań (acceptance, risks, riskStatus), rozwiązane pozycje `T-k/F-n`, nagłówki recenzji partii.
// Kryteria AC-n są wspólne dla sprintu (bez przedrostka pasują); ryzyka R-n są per zadanie (bez przedrostka tylko przy jednym).
export function batchStatuses(data, { resolved, reviews, many }) {
  const acc = new Map();
  const risk = new Map();
  // Przegląd 2026-10-05 (sprint 5): recenzja partii pisze też `T-3 AC-8 met` (spacja zamiast `/`); klucz to wtedy `T-3/AC-8`.
  const entry = (x) => {
    const m = /^(T-\d+)\s+((?:AC|R)-\d+)\b\s*(.*)$/.exec(String(x));
    return m ? [`${m[1]}/${m[2]}`, m[3]] : [idOf(x), String(x).split(/\s/).slice(1).join(' ')];
  };
  for (const h of reviews) {
    for (const x of asList(h.acceptance)) acc.set(...entry(x));
    for (const x of asList(h.risks)) risk.set(...entry(x));
  }
  const update = (k, id, cur, map, word, bare) => {
    if (rank(cur) === 2) return pruneResolved(cur, k, resolved);
    const head = STATUS_HEAD.exec(String(cur))?.[1] ?? id;
    const b = map.get(`T-${k}/${id}`) ?? (bare ? map.get(id) : null);
    if (b != null) return `${head} ${b} (fix batch review)`;
    const fs = [...new Set([...String(cur).matchAll(/\b(F-\d+)\b/g)].map((m) => m[1]))];
    return fs.length && fs.every((f) => resolved.has(`T-${k}/${f}`)) ? `${head} ${word} after the fix batch (${fs.join(', ')} resolved)` : pruneResolved(cur, k, resolved);
  };
  for (const d of data) {
    d.acceptance = d.acceptance.map((x) => update(d.k, idOf(x), x, acc, 'met', true));
    for (const r of d.risks) if (d.riskStatus[r.id]) d.riskStatus[r.id] = update(d.k, r.id, d.riskStatus[r.id], risk, 'proven', !many);
  }
  return data;
}

// Przegląd a6 (2026-10-06): spełnione kryterium z dopiskiem o uwadze, którą partia rozwiązała („AC-1 met (…; the
// totals-to-ledger wiring is untested, F-3)”), mylił przy UAT. Z końcowego nawiasu wypadają człony (`;`), których wszystkie
// F-n partia rozwiązała; zamiast nich jeden człon „F-n resolved by the fix batch”. Reszta notatki zostaje.
export function pruneResolved(s, k, resolved) {
  const str0 = String(s);
  if (!str0.endsWith(')')) return str0;
  let depth = 0;
  let open = -1;
  for (let i = str0.length - 1; i >= 0; i--) {
    if (str0[i] === ')') depth++;
    else if (str0[i] === '(' && --depth === 0) { open = i; break; }
  }
  if (open <= 0) return str0;
  const keep = [];
  const gone = [];
  for (const part of str0.slice(open + 1, -1).split(/;\s*/)) {
    const fs = [...part.matchAll(/\b(F-\d+)\b/g)].map((m) => m[1]);
    if (fs.length && fs.every((f) => resolved.has(`T-${k}/${f}`))) gone.push(...fs);
    else keep.push(part);
  }
  if (!gone.length) return str0;
  return `${str0.slice(0, open).trimEnd()} (${[...keep, `${[...new Set(gone)].join(', ')} resolved by the fix batch`].join('; ')})`;
}

// Pokrycie kryteriów sprintu po rundzie zbiorczej (raport końcowy i, przegląd 2026-10-09 W-6, kontrola celu: phase-5 miała
// 30 fałszywych luk, bo kontrola czytała raport T-1 sprzed partii poprawek, a raport końcowy podawał AC-4 i AC-5 jako met).
export function sprintCoverage(root, run) {
  const ctxs = allTasks(root, run);
  const many = ctxs.length > 1;
  const data = ctxs.map(taskData);
  if (is28(run) && !isLegacy(run)) applyBatch(root, run, data, many);
  const plan = isLegacy(run) ? null : planInfo(root);
  const head = plan?.h ?? data[0].brief;
  const statusIn = (d, id) => d?.acceptance.find((s) => idOf(s) === id)?.split(/\s/).slice(1).join(' ') || 'unverified';
  const coverage = asList(head.acceptance).map((a) => {
    const id = idOf(a);
    const ks = plan ? plan.tasks.filter((x) => x.ac.includes(id)).map((x) => x.k) : [data[0].k];
    const sts = ks.map((k) => ({ k, s: statusIn(data.find((d) => d.k === k), id) }));
    return { id, text: String(a), tasks: ks, sts, status: sts.length ? worstStatus(sts.map((x) => x.s)) : 'gap: no task covers it' };
  });
  // K5 D-14 (2.12): one status word per criterion and its reason (the fix-batch review text, else the first task reason),
  // a finding or risk inside the reason with its title.
  if (is212(run) && !isLegacy(run)) {
    for (const c of coverage) {
      c.word = statusWord(c.status);
      const batch = c.sts.find((x) => /\(fix batch review\)/.test(x.s));
      const x = (batch ? [batch] : c.sts).map((y) => ({ k: y.k, r: statusReason(y.s) })).find((y) => y.r) ?? null;
      c.reason = x ? titleIds(x.r, data.find((d) => d.k === x.k)) : c.sts.length ? '' : statusReason(c.status);
    }
    const ids = new Set(coverage.map((c) => c.id));
    const acceptance = [...coverage.map((c) => `${c.id} ${c.word}`), ...(plan ? [] : data[0].acceptance.filter((s) => !ids.has(idOf(s))))];
    const acPrompt = coverage.map((c) => `${c.id} ${c.word}${c.reason ? `: ${c.reason}` : ''}`);
    return { data, many, plan, head, coverage, acceptance, acPrompt, v212: true };
  }
  const acceptance = plan ? coverage.map((c) => `${c.id} ${c.status}`) : data[0].acceptance;
  return { data, many, plan, head, coverage, acceptance };
}

// K5 D-14: the status word of a criterion status (met, partial, not met, pending UAT, unverified, gap) and the reason after it.
export function statusWord(s) {
  const t = String(s ?? '').trim();
  if (/^gap\b/i.test(t)) return 'gap';
  if (PENDING_UAT.test(t)) return 'pending UAT';
  return ['not met', 'partial', 'met', 'unverified'][rank(t)];
}
const STATUS_LEAD = /^(?:not met|met pending UAT|pending UAT|met|partial|unverified|unmet|unproven|proven|resolved|gap)\b[\s:;,.—–-]*/i;
export function statusReason(s) {
  const t = String(s ?? '').trim().replace(STATUS_LEAD, '').trim();
  return /^\([^()]*\)$/.test(t) ? t.slice(1, -1).trim() : t;
}
// K5 D-15: `F-n` and `R-n` of a task (`d` from taskData) read `F-n <title>` and `R-n <title>`, once.
const cut = (s, n = 60) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
export function titleIds(text, d) {
  if (!d) return String(text ?? '');
  return String(text ?? '').replace(/(?<![\w/])([FR])-(\d+)\b/g, (m, kind, n, off, all) => {
    const id = `${kind}-${n}`;
    let title = '';
    if (kind === 'F') { const i = findingInfo(asList(d.texts), id, ''); title = i.section ? i.title : ''; } else title = asList(d.risks).find((r) => r.id === id)?.title ?? '';
    title = cut(title);
    return title && !all.slice(off + m.length).trimStart().startsWith(title.replace(/…$/, '')) ? `${id} ${title}` : m;
  });
}
// K5 D-16: steps of a UAT scenario (numbered or bulleted lines; free text counts as one).
export function uatStepCount(body) {
  if (body == null || uatNone(body)) return 0;
  const lines = String(body).split(/\r?\n/).filter((l) => l.trim() && !/^\s*#/.test(l) && !/^\s*<!--/.test(l));
  return lines.filter((l) => /^\s*(?:\d+[.)]|[-*])\s+\S/.test(l)).length || (lines.length ? 1 : 0);
}

// K5 D-13: the plain summary right after H1 (2.12): at most 10 lines in the user's language (pl, else en), no identifiers.
const SUMMARY = {
  pl: {
    goal: 'Cel', deferred: (n) => `Odłożone uwagi: ${n}`, majors: 'w tym ważne', noDeferred: 'Odłożone uwagi: brak.',
    steps: (n, s) => `Do zrobienia: UAT, ${n} ${n === 1 ? 'krok' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'kroki' : 'kroków'} dla Ciebie: /dwmt:uat ${s}.`,
    none: 'UAT: brak kroków dla człowieka — odebrany przy zakończeniu', late: 'późniejsze usterki przez /dwmt:uat --late',
    red: 'Przyjęte czerwone testy', until: 'wygasa', owner: 'właściciel', cost: 'Koszt', start: 'cena startowa', design: 'cena projektu',
  },
  en: {
    goal: 'Goal', deferred: (n) => `Deferred findings: ${n}`, majors: 'major', noDeferred: 'Deferred findings: none.',
    steps: (n, s) => `To do: UAT, ${n} step${n === 1 ? '' : 's'} for you: /dwmt:uat ${s}.`,
    none: 'UAT: no human steps — accepted at finish', late: 'later defects through /dwmt:uat --late',
    red: 'Accepted red tests', until: 'expires', owner: 'owner', cost: 'Cost', start: 'start price', design: 'design price',
  },
};
export const summaryText = (lang) => SUMMARY[/^pl/i.test(String(lang ?? '')) ? 'pl' : 'en'];
const range = (r) => (Array.isArray(r) ? r.join('–') : r);
export function reportSummary({ lang, product = [], goal = '', deferred = [], majors = [], uat, steps = 0, sprint, knownRed = [], accepted = [], cost = null, estimate = null, design = null }) {
  const L = summaryText(lang);
  const lines = asList(product).length ? asList(product).slice(0, 4) : [`${L.goal}: ${goal}`];
  lines.push(deferred.length ? `${L.deferred(deferred.length)}${majors.length ? `, ${L.majors}: ${majors.map((x) => cut(x, 70)).join('; ')}` : ''}.` : L.noDeferred);
  lines.push(uat === 'pending' ? L.steps(Math.max(1, steps), sprint) : `${L.none}; ${L.late}.`);
  const red = [...asList(knownRed).map((x) => `${cut(String(x.key).split(' :: ').pop(), 50)} (${L.until} ${String(x.expires ?? '').slice(0, 10)}${x.item ? `, ${L.owner} ${x.item}` : ''})`),
    ...asList(accepted).filter((c) => !asList(knownRed).some((x) => String(x.key).split(' :: ')[0] === c)).map((c) => cut(c, 50))];
  if (red.length) lines.push(`${L.red}: ${red.join('; ')}.`);
  if (cost != null) lines.push(`${L.cost}: ${cost} M${estimate || design ? ` (${[estimate ? `${L.start} ${range(estimate)} M` : null, design ? `${L.design} ${range(design)} M` : null].filter(Boolean).join('; ')})` : ''}.`);
  return lines.slice(0, 10).map((l) => `- ${l}`);
}

// Identyfikatory przebiegów projektu (katalogi przebiegów głównego drzewa i tego drzewa, gałęzie przebiegów): wzmianki
// w turach sesji wywołującej (`callerCost`).
export function knownRuns(top, run, cfg) {
  const ids = new Set([run.run]);
  for (const t of new Set([top, runHome(run, top)])) {
    const d = join(t, '.dwmt', 'runs');
    try { for (const n of readdirSync(d)) if (/^[\w.-]+$/.test(n) && existsSync(join(d, n, 'run.json'))) ids.add(n); } catch { /* brak katalogu */ }
  }
  const prefix = cfg?.git?.branchPrefix ?? 'dwmt/';
  try { for (const b of git(['for-each-ref', '--format=%(refname:short)', `refs/heads/${prefix}`], { cwd: top }).split(/\r?\n/)) if (b.startsWith(prefix)) ids.add(b.slice(prefix.length)); } catch { /* bez gita */ }
  return [...ids];
}

// Koszt przebiegu (raport, W-3 alarm ceny): sesje przebiegu bez wywołujących (`spent`) plus sesje wywołujące według tur
// (`caller`, przegląd 2026-10-09 W-6). Sesja wywołująca zapisana też w `session_ids` liczy się tylko jako wywołująca.
export function runCostParts(top, run, cfg) {
  const callerIds = [...new Set(asList(run.callers).map((c) => c.id))];
  const spent = sessionsCost(asList(run.session_ids).filter((s) => !callerIds.includes(s)));
  let cost = spent ? { ...spent, byRole: { ...spent.byRole } } : null;
  const end = ['squashed', 'left'].includes(run.finish?.status) ? run.finish.at : null;
  const w = callerIds.length ? callerCost(callerIds, run.run, knownRuns(top, run, cfg), { from: run.created ?? null, to: end ?? null }) : null;
  if (w) {
    cost ??= { total: 0, byRole: {}, sessions: 0 };
    cost.total = Math.round((cost.total + w) * 100) / 100;
    cost.byRole.caller = Math.round(((cost.byRole.caller ?? 0) + w) * 100) / 100;
  }
  return { cost, spent };
}
export const runCost = (top, run, cfg) => runCostParts(top, run, cfg).cost;

// Raport sprintu (§5.7, §5.9, §5.11): kontrakt, zadania, pokrycie AC sprintu, ryzyka, lista UAT.
export function finalReport(top, run, cfg) {
  const root = runDir(top, run.run);
  const sc = sprintCoverage(root, run);
  const { data, many, plan, head, coverage, acceptance } = sc;
  const v212 = !!sc.v212;
  const px = (k, id) => (many ? `T-${k}/${id}` : id);
  const rel = (f) => fwd(relative(root, f));
  // Źródło statusu AC: przy jednym zadaniu status zadania jest statusem AC, więc sam numer (bez powtórzenia notatki).
  const bySource = (c) => (c.sts.length === 1 && c.sts[0].s === c.status ? `T-${c.sts[0].k}` : c.sts.map((x) => `T-${x.k} ${x.s}`).join('; ') || 'no task');
  // v2.8: runda zbiorcza (pozycje z wynikiem, miary) i decyzje `[visible]` z planów zadań na liście UAT.
  const v28 = is28(run) && !isLegacy(run);
  const bs = v28 ? batchStats(root, run, cfg) : null;
  const batchRes = new Map((bs?.items ?? []).map((x) => [x.id, x]));
  const openItems = (bs?.items ?? []).filter((x) => x.result === 'open');
  const stillDeferred = deferredFindings(top, run, cfg);
  const majors = stillDeferred.filter((x) => MAJOR_SEVERITIES.includes(x.severity));
  // K2 (C-1, D-9): uwagi przyjęte przez użytkownika (`finish --accept-deferred`) oznaczone datą przyjęcia.
  const acceptedIds = asList(run.deferredAccepted?.ids);
  const acceptedOn = String(run.deferredAccepted?.at ?? '').slice(0, 10);
  // K2 (C-1, D-10): pierwsze linie po H1 i sekcja `## Deferred findings` (pominięta przy zerze).
  const deferredHead = [`- Deferred findings: ${stillDeferred.length}, of which ${majors.length} major.`,
    ...majors.map((x) => `  - ${x.id} [${x.severity}]${x.title ? ` ${x.title}` : ''}${acceptedIds.includes(x.id) ? ` (accepted by the user ${acceptedOn})` : ''}`)].join('\n');
  // Runda zbiorcza T-2/F-2: uwagi poprawione ręcznie po zatrzymaniu, osobną linią po pierwszych liniach C-1.
  const fixedByUser = fixedDeferredFindings(top, run, cfg);
  const fixedOn = String(run.deferredFixed?.at ?? '').slice(0, 10);
  const fixedLine = fixedByUser.length ? `- Fixed by you after the reviews (not re-reviewed): ${fixedByUser.map((x) => `${x.id} [${x.severity}]${x.title ? ` ${x.title}` : ''}`).join('; ')} (${fixedOn}).\n` : '';
  const deferredList = stillDeferred.length ? `\n## Deferred findings\n${stillDeferred.map((x) => `- ${deferredText(x, x.id)}`).join('\n')}\n` : '';
  const status = data.every((d) => d.status === 'PASS') && coverage.every((c) => isMet(c.status)) && !openItems.length ? 'PASS' : 'ACCEPTED';
  const scenario = uatScenario(plan ? plan.text : data[0].briefText);
  // v2.7 (§5.7 pkt 0): luki kontroli celu idą do raportu, na listę UAT i dają `uat: pending` (także przy „UAT: none”).
  const v27 = is27(run) && !isLegacy(run);
  const gc = v27 && plan ? goalCheckInfo(root) : null;
  const gaps = gc?.ok ? gc.gaps : null;
  // Kontrola celu brakująca albo niepoprawna po limicie prób: luki nieznane, więc UAT czeka na użytkownika.
  // W-6: kryterium `met pending UAT` (dowód tylko u człowieka) też daje `uat: pending` i pozycję na liście UAT.
  const pendingAc = coverage.filter((c) => PENDING_UAT.test(c.status));
  let uat = run.uatGate || gaps > 0 || (gc && !gc.ok) || pendingAc.length ? 'pending' : scenario === null || uatNone(scenario) ? 'n/a' : 'pending';
  // W-2: naprawa przy finish to odstępstwo do przejrzenia (z kosztem sesji agenta).
  const repair = finishRepairReport(run, (ids) => sessionsCost(ids));
  const replans = data.flatMap((d) => d.replans.map((r) => `T-${d.k} ${r.result} ${r.cause} (${r.n})`));
  const planFindings = data.flatMap((d) => d.planFindings.map((f) => px(d.k, f)));
  const flaky = [...new Set([...data.flatMap((d) => d.flaky), ...asList(run.fullVerify?.flaky)])];
  const repairs = data.flatMap((d) => Object.keys(d.t.repairs || {}).map((r) => (many ? `T-${d.k} r${r}` : Number(r))));
  const targetedAll = data.map((d) => d.targeted?.result).filter(Boolean);
  const verifyChanged = data.flatMap((d) => d.verifyChanged.map((c) => (many ? `T-${d.k} ${c}` : c)));
  const measurements = [...new Set(data.flatMap((d) => asList(d.measurements)))];
  const planDecisions = plan ? [...(section(plan.text, 'Decisions') || '').matchAll(/^#{2,6}\s+(D-\d+\b.*)$/gm)].map((m) => m[1].trim()) : [];
  // K4 (D-22): przebieg 2.11 z planem sprintu: decyzja sprintu raz (w Contract), część zadania podaje ją po identyfikatorze.
  const one = !!plan && oneSource(run, root);
  const planIds = new Set(planDecisions.map(idOf));
  const ownDecisions = (d) => (one ? d.decisions.filter((x) => !planIds.has(idOf(x))) : d.decisions);
  const sprintNamed = (d) => (one ? d.decisions.map(idOf).filter((x) => planIds.has(x)) : []);
  const planAssumptions = plan ? bullets(section(plan.text, 'Assumptions') || '').filter((a) => /^A-\d+\b/.test(a)) : [];
  const riskRows = data.flatMap((d) => d.risks.map((r) => ({ d, r, id: px(d.k, r.id), st: d.riskStatus[r.id] })));
  const ratchet = run.source ? riskRows.filter(({ r }) => /\bU-\d+\b/.test(r.title))
    .map(({ d, r, id }) => `${/\bU-\d+\b/.exec(r.title)[0]} ${id}: ${(d.evidence[r.id] || []).join('; ') || 'no test listed'}`) : null;
  const humans = riskRows.filter(({ r }) => r.method === 'human');
  const gapItems = gc?.ok ? gc.items.filter((x) => x.status === 'gap') : [];
  const gapLine = (x) => `- ${x.id ?? 'I-?'} ${x.element ?? ''}: ${x.reason ?? 'no reason given'}`;
  // v2.8: odłożona uwaga UI poprawiona w rundzie zbiorczej nie wraca na listę; otwarta po niej (i każda widoczna) tak.
  const fixedInBatch = (d, f) => ['resolved', 'notReproduced'].includes(batchRes.get(`T-${d.k}/${f}`)?.result);
  const visibleDecisions = v28 ? data.flatMap((d) => d.decisions.filter((x) => /\[visible\]/i.test(x))
    .map((x) => `- Decision to confirm ${px(d.k, idOf(x))}: ${x.replace(/^D-\d+\s*/, '').replace(/\[visible\]\s*/i, '').trim()}`)) : [];
  const assess = [
    ...gapItems.map((x) => gapLine(x).replace(/^- /, '- Goal check ')),
    ...pendingAc.map((c) => `- Criterion only you can confirm: ${c.text} (${c.status})`),
    ...visibleDecisions,
    ...data.flatMap((d) => d.uiDeferred.filter((_, i) => !fixedInBatch(d, d.uiDeferredIds[i]))
      .map((e) => `${e.replace(/^- /, `- ${many ? `T-${d.k}/` : ''}`)}${d.compare ? `; screens: \`${rel(d.compare)}\`` : ''}`)),
    ...openItems.filter((x) => x.visible && !data.find((d) => d.k === x.task)?.uiDeferredIds.includes(x.finding))
      .map((x) => `- Open after the fix batch ${x.id} [${x.severity ?? 'minor'}] ${x.title}`),
  ];
  // K5 D-16 (2.12): UAT waits only when a human has something to do (gate, goal-check gaps or invalid check, a criterion
  // pending UAT, a scenario step, a human or ui risk, a [visible] decision, a deferred UI finding, an open visible item).
  const steps = uatStepCount(scenario) + humans.length + assess.length;
  if (v212) uat = run.uatGate || gaps > 0 || (gc && !gc.ok) || pendingAc.length || steps || riskRows.some(({ r }) => r.method === 'ui') ? 'pending' : 'n/a';
  const header = {
    schema: 'dwmt/final-report@1', run: run.run, status, goal: head.goal, mode: data[0].brief.mode ?? run.mode,
    ...(run.sprint ? { sprint: run.sprint } : {}), ...(run.source ? { source: `${run.source.sprint} ${asList(run.source.defects).join(' ')}`.trim() } : {}),
    ...(isLegacy(run) ? {} : { tasks: data.map((d) => `T-${d.k} ${d.status} r${d.reviews.length} ${d.t.commit?.slice(0, 7) ?? '-'} ${d.t.title ?? d.brief.goal ?? ''}`.trim()) }),
    acceptance, ...(plan ? { coverage: coverage.map((c) => (v212 ? `${c.id} ${c.word}${c.tasks.length > 1 ? ` (${c.tasks.map((k) => `T-${k}`).join(', ')})` : ''}` : `${c.id} ${c.status}${many ? ` (${bySource(c)})` : ''}`)) } : {}),
    ...(isLegacy(run) ? {} : { uat, scope: asList(head.scope) }), ...(gc?.ok ? { gaps } : {}), ...(gc && !gc.ok ? { goalCheck: gc.missing ? 'missing' : 'invalid' } : {}),
    ...(replans.length ? { replans } : {}), ...(planFindings.length ? { planFindings } : {}),
    rounds: data.reduce((a, d) => a + d.reviews.length, 0) + (bs?.rounds ?? 0),
    ...(bs ? { batch: { items: bs.items.map((x) => `${x.id} ${x.reason} ${x.result}`), byReason: bs.byReason, byResult: bs.byResult, rounds: bs.rounds, roundsAvoided: bs.roundsAvoided, commit: bs.commit, cost: bs.cost } } : {}),
    tests: {
      targeted: targetedAll.includes('fail') ? 'fail' : targetedAll[0] ?? null, full: run.fullVerify?.result ?? null,
      ...(run.fullVerify?.accepted ? { acceptedRed: run.fullVerify.accepted } : {}), ...(run.fullVerify?.rerun ? { rerun: run.fullVerify.rerun } : {}),
      ...(flaky.length ? { flaky } : {}), ...(repairs.length ? { repairs } : {}),
      // K5 (D-17, D-5): accepted red still covered by the registry, and the modules of the full suite.
      ...(asList(run.fullVerify?.knownRed).length ? { knownRed: run.fullVerify.knownRed.map((x) => `${x.key} until ${String(x.expires ?? '').slice(0, 10)}${x.item ? ` owner ${x.item}` : ''}`) } : {}),
      ...(run.fullVerify?.modules ? { modules: run.fullVerify.modules } : {}),
    },
    ...(verifyChanged.length ? { verifyChanged } : {}),
    ...(measurements.length ? { measurements } : {}),
    decisions: [...planDecisions.map(idOf), ...data.flatMap((d) => ownDecisions(d).map((x) => px(d.k, idOf(x))))],
    risks: riskRows.map(({ r, id, st }) => (st ? `${id} ${st.split(/\s/).slice(1).join(' ')}` : `${id} ${r.method === 'human' ? 'human' : 'unverified'}`)),
    deviations: [...data.flatMap((d) => d.deviations.map((x) => (many ? `T-${d.k}: ${str(x)}` : x))), ...(repair ? [repair.line] : [])],
    ...(repair ? { finishRepair: repair.header } : {}),
    assumptions: [...new Set([...planAssumptions.map(idOf), ...data.flatMap((d) => [...d.assumptions.map(idOf), ...d.resultAssumptions.map(str)].map((a) => px(d.k, a)))])],
    // K2 (C-3): ta sama lista co plik odłożonych uwag i sekcja raportu; przy jednym zadaniu identyfikatory bez T-k/.
    deferred: stillDeferred.map((x) => (x.task == null ? x.id : px(x.task, x.finding))),
    ...(acceptedIds.length ? { acceptedDeferred: acceptedIds } : {}),
    ...(fixedByUser.length ? { fixedDeferred: fixedByUser.map((x) => x.id) } : {}),
    missed: data.flatMap((d) => d.missed.map((f) => px(d.k, f))),
    ...(data.some((d) => d.compare) ? { ui: isLegacy(run) ? data[0].compare : data.filter((d) => d.compare).map((d) => rel(d.compare)) } : {}),
    ...(ratchet ? { ratchet } : {}),
    ...(data.some((d) => d.kept.length) ? { kept: data.flatMap((d) => d.kept.map((f) => px(d.k, f))) } : {}),
    branch: run.branch, sessions: run.session_ids,
  };
  // Koszt w chwili raportu (końcówka sesji orkiestratora po finish nie wchodzi); sesje wywołujące według tur (runCost).
  const { cost, spent } = runCostParts(top, run, cfg);
  if (cost) header.cost = cost;
  // D4 (spec warstwy produktowej §6.1, §6.4 pkt 8, §9): pola warstwy produktowej i bramki ceny; bez nich raport jak w v3-driver.
  if (run.spec) header.spec = run.spec;
  if (asList(run.items).length) header.items = run.items;
  if (run.modeLabel) header.modeLabel = run.modeLabel;
  // W-4: przejście intermediate → single (architekt podzielił sprint ponad progiem plików trybu pośredniego).
  if (run.modeSwitch) header.modeSwitch = `${run.modeSwitch.from} → ${run.modeSwitch.to}: ${run.modeSwitch.reason}`;
  const price = priceReport(run);
  if (price) header.price = price;
  // W-3: koszt przebiegu przekroczył górną cenę (powiadomienie w trakcie).
  if (run.priceAlert) header.priceAlert = { costM: run.priceAlert.costM, upperM: run.priceAlert.upperM, at: run.priceAlert.at };
  const oh = estOverheadOf(top, run, cfg, spent?.total, () => overhead(productPaths(top, productConfig(top, cfg)), top, run.run));
  if (oh != null) header.estOverhead = oh;
  if (asList(run.warnings).length) header.warnings = run.warnings;
  const cell = (s) => String(s ?? '').replace(/\|/g, '\\|');
  const tail = (s) => String(s).split(/\s/).slice(1).join(' ');
  const contract = [
    `- Goal: ${head.goal}`,
    ...coverage.map((c) => (v212 ? `- ${c.text} → **${c.word}**${c.reason ? ` — ${c.reason}` : ''}` : `- ${c.text} → **${c.status}**${many ? ` (${bySource(c)})` : ''}`)),
    ...data.filter((d) => d.kept.length).map((d) => `- Files to delete${many ? ` (T-${d.k})` : ''} → **not met**: kept without your consent: ${d.kept.join(', ')}`),
    ...(plan ? [...planDecisions, ...planAssumptions] : [...data[0].decisions, ...data[0].assumptions]).map((x) => `- ${x}`),
  ].join('\n');
  const replanCell = (d) => (d.replans.length ? d.replans.map((r) => `${r.result} ${r.cause}`).join('; ') : '-');
  const tasks = many ? [
    '', '## Tasks', '', '| Task | Status | Rounds | Replan | Commit | Report |', '|---|---|---|---|---|---|',
    ...data.map((d) => `| ${cell(`T-${d.k} ${d.t.title ?? d.brief.goal ?? ''}`)} | ${d.status} | ${d.reviews.length} | ${cell(replanCell(d))} | ${d.t.commit?.slice(0, 7) ?? '-'} | \`tasks/${d.k}/report.md\` |`),
    ...(bs ? [`| Fix batch (${bs.items.length} items) | ${openItems.length ? 'ACCEPTED' : 'PASS'} | ${bs.rounds} | - | ${bs.commit?.slice(0, 7) ?? '-'} | \`batch/report.md\` |`] : []),
    ...data.flatMap((d) => (d.decisions.length || d.assumptions.length ? ['', `### T-${d.k} decisions and assumptions`, ...ownDecisions(d).map((x) => `- T-${d.k}/${x}`),
      ...(sprintNamed(d).length ? [`- T-${d.k} sprint decisions: ${sprintNamed(d).map((x) => (v212 ? cut(planDecisions.find((p) => idOf(p) === x) ?? x, 80) : x)).join(', ')}`] : []), ...d.assumptions.map((x) => `- T-${d.k}/${x}`)] : [])),
    '',
  ].join('\n') : '';
  const coverageTable = riskRows.length ? [
    '| Risk | Weight | Method | Area | Result |', '|---|---|---|---|---|',
    ...riskRows.map(({ d, r, id, st }) => `| ${cell(`${id} ${r.title}`)} | ${r.weight} | ${cell([r.method, r.detail].filter(Boolean).join(' '))} | ${cell(r.area ?? '')} | ${cell(st ? (v212 ? titleIds(tail(st), d) : tail(st)) : r.method === 'human' ? 'for you to check (UAT)' : 'unverified')} |`),
  ].join('\n') : 'The brief declares no risks.';
  const shots = data.filter((d) => d.compare);
  const screens = shots.length ? `\n## Screens\n${shots.map((d) => `- \`${rel(d.compare)}\`: mockup next to the app screenshot for each UI risk${many ? ` of T-${d.k}${v212 && (d.t.title ?? d.brief.goal) ? ` ${d.t.title ?? d.brief.goal}` : ''}` : ''} (${d.pairs.length}), with its review status.`).join('\n')} Your check on the screenshots.\n` : '';
  const fixBatch = bs ? [
    '', '## Fix batch', '',
    `- Items: ${bs.items.length} (${Object.entries(bs.byReason).map(([k, v]) => `${k} ${v}`).join(', ')}); result: ${Object.entries(bs.byResult).map(([k, v]) => `${k} ${v}`).join(', ')}.`,
    `- Commit: ${bs.commit ?? '-'}, rounds: ${bs.rounds}, task fix rounds avoided: ${bs.roundsAvoided}${bs.cost != null ? `, cost: ${bs.cost} M tokens` : ''} (\`batch/report.md\`).`, '',
    '| Item | Reason | Result | Title |', '|---|---|---|---|',
    ...bs.items.map((x) => `| ${x.id} [${x.severity ?? '-'}] | ${x.reason} | ${x.result} | ${cell(x.title)} |`), '',
  ].join('\n') : '';
  const designBody = plan ? sectionBody(namedSection(plan.text, 'Design')) : null;
  const design = v27 && designBody ? `\n## Design\n${designBody}\n` : '';
  const goalCheck = !gc ? '' : gc.ok
    ? `\n## Goal check\n- Delivered: ${gc.delivered}, out of scope: ${gc.out}, gaps: ${gc.gaps} (\`goal-check.md\`).\n${gapItems.map((x) => `${gapLine(x)}\n`).join('')}`
    : `\n## Goal check\n- Not available, gaps unknown: ${gc.missing ? 'no \`goal-check.md\`' : `\`goal-check.md\` is invalid (${gc.errors.join('; ')})`}.\n`;
  const uatText = isLegacy(run) ? '' : [
    // v2.10: co się stało i czego potrzeba od użytkownika, wprost („nie rozumiem, czego ode mnie oczekujesz”).
    '', '## UAT', '', `Status: ${uat}${run.uatGate ? ' (UAT gate from the order)' : ''}. ${v212 && uat !== 'pending' ? `${summaryText(cfg.language).none}. Needed from you: nothing.` : uat === 'pending'
      ? `This sprint waits for your acceptance test. Needed from you: start the app, go through the scenario and the items below, then report with \`/dwmt:uat ${run.sprint ?? run.run}\`.`
      : 'Nothing in this sprint needs a manual test. Needed from you: nothing.'}`, '',
    '### Start the app', '', ...(asList(cfg.uat?.start).length ? asList(cfg.uat.start).map((c) => `- \`${c}\``) : ['- As usual (no `uat.start` in `.claude/dwmt.json`).']), ...asList(cfg.uat?.notes).map((n) => `- ${n}`), '',
    '### Scenario', '', (v212 && scenario != null ? scenario.split(/\r?\n/).map(stripUatRef).join('\n') : scenario) ?? 'UAT: none.', '',
    '### For your assessment', '', ...(assess.length ? assess : ['- Nothing deferred by the UI review.']), '',
    '### Steps for you 🧑', '', ...(humans.length ? humans.map(({ r, id }) => `- ${id} ${r.title}${r.detail ? `: ${r.detail}` : ''}`) : ['- None.']), '',
    '### How to report', '',
    '- One line per finding: action → what happened (and what should); place; weight `blocker`, `major` or `minor`; kind: bug, requirement change or environment.',
    '- "Positive, no findings" is a result too.',
    `- In the main tree: \`/dwmt:uat ${run.sprint ?? run.run}\`.`, '',
  ].join('\n');
  // K5 D-13 (2.12): the plain summary block right after H1; D-5: one body line for the modules of the full suite.
  const summary = v212 ? `${reportSummary({
    lang: cfg.language, product: gc?.ok ? gc.summary : [], goal: head.goal, deferred: stillDeferred, majors: majors.map((x) => x.title || x.severity),
    uat, steps, sprint: run.sprint ?? run.run, knownRed: asList(run.fullVerify?.knownRed), accepted: asList(run.fullVerify?.accepted),
    cost: cost?.total ?? null, estimate: run.estimate?.tokensM ?? run.price?.estimate ?? null, design: run.price?.design ?? null,
  }).join('\n')}\n\n` : '';
  const modulesLine = run.fullVerify?.modules ? `\n- Full suite modules: ran ${asList(run.fullVerify.modules.ran).join('; ') || 'none'}; skipped ${asList(run.fullVerify.modules.skipped).join('; ') || 'none'}.` : '';
  const body = read(join(ROOT, 'templates', 'artifacts', 'final-report.md')).replace(/\r\n/g, '\n').replace(/\{\{(\w+)\}\}/g, (m, k) => ({
    summary, goal: head.goal, run: run.run, target: run.target, finish: cfg.git.finish, deferredHead, fixedDeferred: fixedLine, deferredList, contract, design, goalCheck, tasks, batch: fixBatch, coverage: coverageTable, screens, uat: uatText,
    measurements: measurementsSection(top, measurements),
    sprint: run.sprint ? `, sprint \`${run.sprint}\`` : '', source: `${run.source ? `\n- Fix sprint for \`${run.source.sprint}\`: ${asList(run.source.defects).join(', ')} (\`${run.source.uat}\`).` : ''}${modulesLine}`,
    cost: spent ? `\n## Cost\n- ${spent.total} M tokens (input equivalent) at report time: ${Object.entries(spent.byRole).map(([a, v]) => `${a} ${v}`).join(', ')}.\n` : '',
    reviews: data.flatMap((d) => d.reviews.map((r, i) => `- ${many ? `T-${d.k} ` : ''}review-${i + 1}: ${r.verdict} (${JSON.stringify(r.counts || {})}) ${v212 ? `fix: ${asList(r.fix).map((f) => titleIds(String(f), d)).join('; ') || 'none'}` : `fix ${JSON.stringify(r.fix || [])}`}`)).join('\n') || '- brak',
  })[k] ?? m);
  writeFileSync(join(root, 'final-report.md'), withHeader(header, `\n${body}`));
  return header;
}
