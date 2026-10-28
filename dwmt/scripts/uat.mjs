// dwmt: UAT sprintów (specyfikacja-dwmt.md §5.11, spec supervisora §10). Działa na kopii przebiegów w drzewie domowym:
// lista sprintów czekających na UAT, bilet wstrzymania scaleń (machine.mjs), zapis `uat.md`, zdarzenia dla pętli
// supervisora, strona wejścia sprintu poprawek i tabela `uat-summary`.
// Import z dwmt.mjs tworzy cykl ES; żadna funkcja stąd nie jest używana na poziomie modułu, więc cykl jest bezpieczny.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { ensureLoop } from './lib/supervisor-loop.mjs';
import { git, loadConfig, runHome, contextHome, mergeKey, splitHeader, parseYaml, withHeader, section, sessionsCost } from './dwmt.mjs';
import { activeHolds, readHold, putHold, dropHold, dropSessionHolds } from './machine.mjs';
import { emit } from './events.mjs';
import { productConfig } from './lib/product-config.mjs';
import { productRun, productViewRefresh } from './product.mjs';
import { samePath, pathKey } from './lib/util.mjs';
import { worktreeFor } from './lib/git.mjs';

const fwd = (p) => String(p).replace(/\\/g, '/');
const read = (f) => readFileSync(f, 'utf8');
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const session = () => process.env.CLAUDE_CODE_SESSION_ID || 'manual';
const WEIGHTS = ['blocker', 'major', 'minor'];
const KINDS = ['bug', 'requirement', 'environment'];
// Klasa: gdzie defekt powinien zostać złapany (spec supervisora §10.5), pierwsza pasująca w tej kolejności.
export const CLASSES = ['deferred', 'human', 'plan', 'ui-look', 'ui-flow', 'test', 'review'];

function writeAtomic(file, text) {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function header(file) {
  try { const s = splitHeader(read(file)); return s ? parseYaml(s.yaml) : null; } catch { return null; }
}

// Przebiegi projektu w głównym drzewie (kopie z finish i przebiegi prowadzone w nim samym).
export function runsOf(main) {
  const base = join(main, '.dwmt', 'runs');
  if (!existsSync(base)) return [];
  return readdirSync(base).flatMap((id) => {
    try {
      const run = JSON.parse(read(join(base, id, 'run.json')));
      return [{ id, dir: join(base, id), run, sprint: run.sprint ?? run.spec ?? run.run, report: header(join(base, id, 'final-report.md')) }];
    } catch { return []; }
  });
}

function findRun(main, id) {
  // D4: sprint z pliku sprintu znajduje się też po identyfikatorze specyfikacji (`run.spec`, np. `uat start sp-16`).
  const hit = runsOf(main).filter((r) => r.sprint === id || r.run.run === id || r.run.spec === id)
    .sort((a, b) => String(b.run.created).localeCompare(String(a.run.created)));
  if (!hit.length) throw new Error(`brak sprintu ${id} w ${fwd(join(main, '.dwmt', 'runs'))}`);
  return hit.find((r) => r.run.finish?.status === 'squashed') ?? hit[0];
}

// D-18 (bug 13): squash sprawdzany na gałęzi docelowej, widocznej z każdego drzewa repo; żadnego drzewa nie trzeba wybierać.
const targetRef = (r) => `refs/heads/${r.run.target}`;

function readUatFile(file, init = null) {
  if (!existsSync(file)) {
    if (!init) throw new Error(`brak pliku ${fwd(file)}`);
    return { file, h: init, body: `\n# UAT: ${init.sprint}\n` };
  }
  const s = splitHeader(read(file));
  if (!s) throw new Error(`${fwd(file)}: brak nagłówka`);
  const h = parseYaml(s.yaml);
  if (h.schema !== 'dwmt/uat@1') throw new Error(`${fwd(file)}: schemat ${h.schema}, oczekiwano dwmt/uat@1`);
  for (const k of ['entries', 'defects', 'deferredAccepted']) h[k] = asList(h[k]);
  return { file, h, body: s.body };
}
const writeUat = (u) => writeAtomic(u.file, withHeader(u.h, u.body));
const uatOf = (r) => readUatFile(join(r.dir, 'uat.md'), {
  schema: 'dwmt/uat@1', sprint: r.sprint, run: r.run.run, report: fwd(join(r.dir, 'final-report.md')), entries: [], defects: [], deferredAccepted: [],
});

// Zdarzenie dla pętli (spec supervisora §4.6): tylko gdy projekt ma zlecenie (`.dwmt/supervisor/`).
function uatEvent(main, sprint, ev) {
  const dir = join(main, '.dwmt', 'supervisor');
  if (!existsSync(dir)) return null;
  const file = join(dir, 'status', `${sprint}.uat.json`);
  let old = { sprint, events: [] };
  try { old = JSON.parse(read(file)); } catch { /* pierwszy wpis */ }
  const events = asList(old.events);
  events.push({ seq: Math.max(0, ...events.map((e) => e.seq || 0)) + 1, at: new Date().toISOString(), ...ev });
  writeAtomic(file, `${JSON.stringify({ sprint, events }, null, 2)}\n`);
  // S3 (§10.4): zlecenie istnieje, a pętla nie działa → start pętli (skrypt, bez linii skilla).
  try { ensureLoop(main); } catch { /* best effort */ }
  return fwd(file);
}

function list(main, all) {
  const waiting = [];
  const mergeWait = [];
  const merged = [];
  for (const r of runsOf(main)) {
    const f = r.run.finish;
    if (f?.status === 'merge-wait') mergeWait.push(`${r.sprint} (${r.run.run}): ${f.reason} od ${f.since}`);
    if (f?.status !== 'squashed') continue;
    const done = existsSync(join(r.dir, 'uat.md')) && uatOf(r).h.entries.some((e) => e.kind === 'uat');
    if (r.report?.uat === 'pending' && !done) waiting.push(`${r.sprint}: od ${f.at}${r.run.uatGate ? ' (bramka UAT)' : ''}`);
    if (all) merged.push(`${r.sprint} ${String(f.at).slice(0, 10)} ${f.commit ?? '-'} scope: ${asList(r.report?.scope).join(', ') || '-'}`);
  }
  return {
    ok: true, waiting, mergeWait, ...(all ? { merged } : {}),
    hint: waiting.length ? 'uat start <sprint…>, potem lista UAT z raportu (section <raport> UAT)' : 'brak sprintów czekających na UAT',
  };
}

function start(main, ids, cfg) {
  if (!ids.length) throw new Error('podaj sprinty: uat start <id…>');
  const items = ids.map((id) => findRun(main, id));
  for (const r of items) {
    const f = r.run.finish;
    if (f?.status !== 'squashed') throw new Error(`${r.sprint}: squash nie wszedł (${f?.status ?? 'brak finish'}); UAT tylko po scaleniu`);
    if (f.commit) {
      try { git(['merge-base', '--is-ancestor', f.commit, targetRef(r)], { cwd: main }); } catch { throw new Error(`${r.sprint}: commit ${f.commit} nie jest na gałęzi ${r.run.target}`); }
    }
  }
  const head = git(['rev-parse', targetRef(items[0])], { cwd: main });
  const targets = [...new Set(items.map((r) => r.run.target))];
  if (targets.length > 1) throw new Error(`sprinty mają różne gałęzie docelowe (${targets.join(', ')}): UAT osobno`);
  const { key } = mergeKey(main, targets[0]);
  const old = readHold(key, session());
  const now = Date.now();
  const hold = {
    session: session(), key, target: targets[0], sprints: [...new Set([...asList(old?.sprints), ...items.map((r) => r.sprint)])],
    recorded: asList(old?.recorded), head, started: old?.started ?? new Date(now).toISOString(), last: old?.last ?? null,
    until: new Date(now + (cfg.uat?.holdMaxMin ?? 240) * 60e3).toISOString(),
  };
  putHold(key, hold);
  // K7 D-13: the squash of a workplace sprint is only on the workplace branch: name the tree to test in.
  let tree = null;
  try { tree = worktreeFor(main, targets[0]); } catch { /* no tree: nothing to name */ }
  if (tree && samePath(tree, main)) tree = null;
  return {
    ok: true, head: head.slice(0, 10), until: hold.until, reports: items.map((r) => fwd(join(r.dir, 'final-report.md'))), ...(tree ? { tree: fwd(tree) } : {}),
    hint: `${tree ? `testuj w drzewie ${fwd(tree)} (gałąź ${targets[0]}); ` : ''}dwmt section <raport> UAT dla każdego sprintu; wynik: uat record <id…> <plik.json>`,
  };
}

function validateResult(res) {
  const errors = [];
  if (!['positive', 'defects'].includes(res?.result)) errors.push('result: positive|defects');
  asList(res?.findings).forEach((f, i) => {
    if (!f?.text) errors.push(`findings[${i}]: brak text`);
    if (!WEIGHTS.includes(f?.weight)) errors.push(`findings[${i}]: weight ${f?.weight}, dozwolone ${WEIGHTS.join('|')}`);
    if (!KINDS.includes(f?.kind)) errors.push(`findings[${i}]: kind ${f?.kind}, dozwolone ${KINDS.join('|')}`);
    if (f?.kind === 'bug' && !CLASSES.includes(f?.class)) errors.push(`findings[${i}]: class ${f?.class}, dozwolone ${CLASSES.join('|')}`);
  });
  if (res?.result === 'positive' && asList(res.findings).some((f) => f.kind === 'bug')) errors.push('result positive, a findings mają defekt (bug)');
  if (errors.length) throw new Error(`wynik UAT: ${errors.join('; ')}`);
}

const count = (xs, key) => xs.reduce((a, x) => ({ ...a, [x[key]]: (a[x[key]] || 0) + 1 }), {});

function record(main, args, opts, cfg) {
  if (args.length < 2) throw new Error('uat record <id…> <plik wyniku .json> [--late]');
  const file = args[args.length - 1];
  const res = JSON.parse(read(file));
  validateResult(res);
  const late = !!opts.late;
  const now = new Date().toISOString();
  const out = { recorded: [], defects: [], fix: [], requirements: [], events: [] };
  const holds = new Map();
  const intakeFor = [];
  for (const id of args.slice(0, -1)) {
    const r = findRun(main, id);
    if (r.run.finish?.status !== 'squashed') throw new Error(`${r.sprint}: squash nie wszedł; zapis UAT tylko po scaleniu`);
    // D-4: produkt przebiegu w jego drzewie domowym (kopia przebiegu i `uat.md` są w `main`, drzewie domowym komendy).
    // A recorded home that no longer exists (repo moved; a pre-K3 `mainTree`): the calling tree, as `targetTree` did.
    const home = runHome(r.run, main);
    const tree = existsSync(home) ? home : main;
    const product = samePath(tree, main) ? productActive(main, cfg) : productActive(tree, loadConfig(tree));
    const { key } = mergeKey(main, r.run.target);
    const u = uatOf(r);
    // v2.10 (D): dopisanie samych zaakceptowanych odłożonych uwag zaraz po wyniku tej sesji poprawia ostatni wpis zamiast
    // dodawać nowy (3 wpisy UAT dla jednego testu); bilet mógł już zniknąć po pierwszym zapisie.
    const last = u.h.entries[u.h.entries.length - 1];
    if (!late && last?.kind === 'uat' && last.session === session() && last.result === res.result && res.result === 'positive'
      && !asList(res.findings).length && asList(res.deferredAccepted).length) {
      const added = asList(res.deferredAccepted).filter((x) => !u.h.deferredAccepted.includes(x));
      u.h.deferredAccepted = [...u.h.deferredAccepted, ...added];
      last.end = now;
      if (added.length) u.body = `${u.body.trimEnd()}
- Deferred findings accepted without a fix (added): ${added.join(', ')}
`;
      writeUat(u);
      emit({ type: 'uat-recorded', project: main, run: r.run.run, verdict: res.result, detail: { sprint: r.sprint, entry: last.n, merged: true, deferredAccepted: added } });
      out.recorded.push(`${r.sprint}: wpis ${last.n} uzupełniony (${added.length} odłożonych uwag zaakceptowanych)`);
      continue;
    }
    const hold = late ? null : holds.get(key) ?? readHold(key, session());
    if (!late && !hold?.sprints.includes(r.sprint)) throw new Error(`${r.sprint}: brak wstrzymania w tej sesji; najpierw uat start ${r.sprint} (albo --late)`);
    if (hold) holds.set(key, hold);
    const n = u.h.entries.length + 1;
    const head = late ? git(['rev-parse', targetRef(r)], { cwd: main }) : hold.head;
    // Okno kosztu wpisu: od poprzedniego zapisu tej sesji albo startu biletu do zapisu (§5.11).
    // `shared`: sprinty jednego zapisu dzielą okno sesji, więc koszt sesji dzielimy między nie (uat-summary).
    u.h.entries.push({ n, kind: late ? 'late' : 'uat', start: late ? now : hold.last ?? hold.started, end: now, session: session(), head, result: res.result, findings: asList(res.findings).length, shared: args.length - 1 });
    const base = Math.max(0, ...u.h.defects.map((d) => Number(String(d.id).slice(2)) || 0));
    const found = asList(res.findings).map((f, i) => ({ f, d: { id: `U-${base + i + 1}`, weight: f.weight, kind: f.kind, class: f.kind === 'bug' ? f.class : null, entry: n, ref: f.ref ?? null, fix: null } }));
    u.h.defects.push(...found.map((x) => x.d));
    // D4 (spec warstwy produktowej §4.6): z warstwą produktową sprint poprawek tworzą tylko defekty blocker i major;
    // minor dołącza do niego, a bez niego idzie do triażu PO (`fix: triage`, pozycja z `intake --uat`).
    if (product && !u.h.defects.some((d) => d.kind === 'bug' && !d.fix && ['blocker', 'major'].includes(d.weight))) {
      for (const d of u.h.defects) if (d.kind === 'bug' && !d.fix && d.weight === 'minor') d.fix = 'triage';
    }
    u.h.deferredAccepted = [...new Set([...u.h.deferredAccepted, ...asList(res.deferredAccepted)])];
    u.body = [
      u.body.trimEnd(), '', `## Entry ${n}: ${late ? 'late' : 'uat'}, ${now.slice(0, 16).replace('T', ' ')} (${res.result})`, '',
      `- Session: ${session()}, HEAD ${String(head).slice(0, 10)}`,
      ...(asList(res.deferredAccepted).length ? [`- Deferred findings accepted without a fix: ${asList(res.deferredAccepted).join(', ')}`] : []), '',
      ...found.flatMap(({ f, d }) => [`### ${d.id} [${d.weight}] ${d.kind}${d.class ? `, ${d.class}` : ''}: ${f.text}`, `- Place: ${f.place ?? '-'}`, ...(f.ref ? [`- Ref: ${f.ref}`] : []), '']),
    ].join('\n');
    writeUat(u);
    const bugs = found.filter((x) => x.d.kind === 'bug').map((x) => x.d);
    const open = u.h.defects.filter((d) => d.kind === 'bug' && !d.fix);
    const fixSprint = open.length ? { uat: fwd(u.file), report: u.h.report, defects: open.map((d) => d.id) } : null;
    // `run`: wynik dotyczy tego przebiegu, nie każdego przebiegu sprintu (zgłoszenie z 2026-10-16, pkt 11).
    const ev = uatEvent(main, r.sprint, {
      type: late ? 'late' : 'uat', run: r.run.run, result: res.result, counts: count(bugs, 'weight'), byClass: count(bugs, 'class'),
      requirementChanges: found.filter((x) => x.d.kind === 'requirement').length, environment: found.filter((x) => x.d.kind === 'environment').length, fixSprint,
    });
    if (ev) out.events.push(ev);
    emit({ type: 'uat-recorded', project: main, run: r.run.run, verdict: res.result, detail: { sprint: r.sprint, entry: n, findings: found.length, bugs: bugs.length, late } });
    out.recorded.push(`${r.sprint}: wpis ${n} (${res.result})`);
    out.defects.push(...found.map(({ d }) => `${r.sprint} ${d.id} [${d.weight}] ${d.kind}${d.class ? ` ${d.class}` : ''}`));
    if (fixSprint) out.fix.push(`/dwmt:run "${fixSprint.uat}"`);
    // v2.8 (F): zmiany wymagań zostają w uat.md (kind requirement, fix: null) jako wejście triażu PO; bez linii do roadmapy.
    out.requirements.push(...found.filter((x) => x.d.kind === 'requirement').map(({ d }) => `${r.sprint} ${d.id}`));
    if (hold && !hold.recorded.includes(r.sprint)) hold.recorded.push(r.sprint);
    if (product) intakeFor.push({ id: r.run.spec ?? r.sprint, tree });
  }
  // D4 (§4.5, P-11): `product intake --uat <sprint> --sync` po zapisie, w drzewie domowym przebiegu: defekty i zamknięcie
  // sprintu w roadmapie w jednym commicie produktu (D-11, D-14); błąd tylko ostrzega.
  const intake = [];
  for (const { id, tree } of intakeFor) {
    try {
      const res = productRun(tree, ['intake', '--uat', id, '--sync']);
      if (!res?.skipped) intake.push(`${id}: ${asList(res?.items).length} items`);
    } catch (e) { out.warnings = [...asList(out.warnings), `product intake --uat ${id}: ${e.message}`]; }
  }
  if (intake.length) out.intake = intake;
  // Each intake above wrote the published page in its own product commit, under its own merge lease; this is one refresh
  // per product tree after them, not committed (with `publish: null` the only write, of the `.dwmt/` page).
  // 0 tokens; a failure is only a warning.
  const trees = new Map(intakeFor.map((x) => [pathKey(x.tree), x.tree]));
  for (const tree of trees.values()) {
    const v = productViewRefresh(tree);
    if (v.viewWarning) out.warnings = [...asList(out.warnings), v.viewWarning];
  }
  // Wstrzymanie: każdy zapis wydłuża bilet; po ostatnim sprincie wywołania bilet znika (§5.11).
  let released = false;
  for (const [key, hold] of holds) {
    if (hold.sprints.every((s) => hold.recorded.includes(s))) { dropHold(key, hold.session); released = true; }
    else putHold(key, { ...hold, last: now, until: new Date(Date.now() + (cfg.uat?.holdMaxMin ?? 240) * 60e3).toISOString() });
  }
  const free = [...holds.keys()].every((k) => !activeHolds(k).length);
  const mergeWait = released && free ? runsOf(main).filter((r) => r.run.finish?.status === 'merge-wait' && r.run.finish.reason === 'uat').map((r) => `${r.sprint}: /dwmt:execute ${r.run.run}`) : [];
  return {
    ok: true, ...out, released, ...(mergeWait.length ? { mergeWait } : {}),
    hint: out.fix.length ? 'defekty: sprint poprawek (polecenie w fix, we własnym worktree)' : 'zapisano',
  };
}

// Warstwa produktowa obecna i włączona (P-11: bez niej UAT działa jak v2.10).
function productActive(main, cfg) {
  try { const pc = productConfig(main, cfg); return pc.present && pc.enabled; } catch { return false; }
}

// Brak argumentu `uat` = lista; reszta to podkomendy.
export function uatMain(top, pos, opts) {
  const [sub = 'list', ...args] = pos;
  const main = contextHome(top);
  const cfg = loadConfig(main);
  switch (sub) {
    case 'list': return list(main, !!opts.all);
    case 'start': return start(main, args, cfg);
    case 'record': return record(main, args, opts, cfg);
    case 'release': return { ok: true, released: dropSessionHolds(session()) };
    default: throw new Error('uat list [--all] | start <id…> | record <id…> <plik.json> [--late] | release');
  }
}

// ---------- strona orkiestratora: sprint poprawek z `uat.md` (§5.11) ----------

// uat.md sprintu źródłowego (wejście supervisora z `source`): kopia jego przebiegu w głównym drzewie. `run`
// (`sourceRun` wejścia): przebieg, którego UAT wyzwolił poprawki; bez niego najnowszy przebieg sprintu.
export function sourceUat(main, sprint, run = null) {
  const file = join(findRun(main, run || sprint).dir, 'uat.md');
  if (!existsSync(file)) throw new Error(`sprint ${sprint} nie ma zapisu UAT (${fwd(file)})`);
  return file;
}

const openBugs = (h) => asList(h.defects).filter((d) => d.kind === 'bug' && !d.fix);

export function fixSprintPreview(file) {
  const u = readUatFile(file);
  const open = openBugs(u.h);
  if (!open.length) throw new Error(`${fwd(file)}: brak otwartych defektów (bug bez przypisanego sprintu poprawek)`);
  return open.map((d) => d.id);
}

// Przypisuje otwarte defekty do przebiegu (`fix: <run>`) i składa task.md z ich opisami.
export function claimFixSprint(file, runId) {
  const u = readUatFile(file);
  const open = openBugs(u.h);
  if (!open.length) throw new Error(`${fwd(file)}: brak otwartych defektów`);
  for (const d of open) d.fix = runId;
  writeUat(u);
  const task = [
    `# Fix sprint: ${u.h.sprint} (UAT)`, '',
    'Defects found in UAT. Each needs a test that reproduces it and is red before the fix; the UAT scenario re-checks each one.', '',
    ...open.flatMap((d) => [section(u.body, d.id) ?? `### ${d.id} [${d.weight}]`, '']),
    `UAT record: ${fwd(file)}`, `Sprint report: ${u.h.report}`, '',
  ].join('\n');
  return { task, source: { sprint: u.h.sprint, run: u.h.run, uat: fwd(file), report: u.h.report, defects: open.map((d) => d.id) } };
}

// ---------- uat-summary: przepuszczone defekty i koszt łączny (spec supervisora §10.5) ----------

export function uatSummary(top) {
  const main = contextHome(top);
  const runs = runsOf(main);
  const rows = [];
  const round2 = (x) => Math.round(x * 100) / 100;
  for (const r of runs.filter((x) => !x.run.source && x.run.finish?.status === 'squashed')) {
    const u = existsSync(join(r.dir, 'uat.md')) ? uatOf(r) : null;
    const entries = asList(u?.h.entries);
    const lateN = entries.filter((e) => e.kind === 'late').map((e) => e.n);
    const bugs = asList(u?.h.defects).filter((d) => d.kind === 'bug');
    const missed = bugs.filter((d) => !lateN.includes(d.entry));
    const last = entries.filter((e) => e.kind === 'uat').at(-1);
    const fixes = runs.filter((x) => x.run.source && (x.run.source.run ? x.run.source.run === r.run.run : x.run.source.sprint === r.sprint));
    const fixCost = fixes.reduce((a, x) => a + (Number(x.report?.cost?.total) || 0), 0);
    const uatCost = entries.reduce((a, e) => a + (sessionsCost([e.session], undefined, { from: e.start, to: e.end })?.total || 0) / (e.shared || 1), 0);
    const cost = Number(r.report?.cost?.total) || 0;
    const byClass = Object.entries(count(missed, 'class')).map(([k, v]) => `${k} ${v}`).join(', ');
    rows.push({
      sprint: r.sprint, cost: round2(cost), uat: last ? `${last.result} ${String(last.end).slice(0, 10)}` : r.report?.uat === 'n/a' ? 'n/a' : 'pending',
      missed: WEIGHTS.map((w) => missed.filter((d) => d.weight === w).length).join('/'), byClass: byClass || '-', late: bugs.length - missed.length,
      deferredAccepted: asList(u?.h.deferredAccepted).length, deferredRejected: missed.filter((d) => d.class === 'deferred').length,
      fixes: fixes.length, fixCost: round2(fixCost), uatCost: round2(uatCost), total: round2(cost + fixCost + uatCost),
    });
  }
  const file = join(main, '.dwmt', 'uat-summary.md');
  writeAtomic(file, [
    '# UAT summary (dwmt)', '', `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}. Missed = blocker/major/minor bugs found in UAT; late ones are separate. Cost in M tokens (input equivalent).`, '',
    '| Sprint | Cost | UAT | Missed b/M/m | Class | Late | Deferred accepted | Deferred rejected | Fix sprints | Fix cost | UAT sessions | Total |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map((x) => `| ${x.sprint} | ${x.cost} | ${x.uat} | ${x.missed} | ${x.byClass} | ${x.late} | ${x.deferredAccepted} | ${x.deferredRejected} | ${x.fixes} | ${x.fixCost} | ${x.uatCost} | ${x.total} |`),
    '',
  ].join('\n'));
  return { ok: true, file: fwd(file), rows: rows.slice(-15).map((x) => `${x.sprint}: ${x.cost} mln, UAT ${x.uat}, missed ${x.missed} (${x.byClass}), late ${x.late}, fix ${x.fixCost}, uat ${x.uatCost}, total ${x.total}`) };
}
