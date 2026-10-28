// dwmt: przebieg (run.json), zadania sprintu, status dla supervisora, zdarzenia przebiegu.
import { writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { emit } from '../events.mjs';
import { fwd, read, asList, writeFileAtomic, samePath, canonPath } from './util.mjs';
import { tryHeader } from './headers.mjs';
import { git, gitRaw, worktreeFor } from './git.mjs';
import { loadConfig } from './config.mjs';

export const runDir = (top, id) => join(top, '.dwmt', 'runs', id);
export const taskDir = (root, k) => join(root, 'tasks', String(k));
export const sessionId = () => process.env.CLAUDE_CODE_SESSION_ID || null;
// Wywołanie z sterownika (`drive.mjs` ustawia identyfikator `drive-<run>-T<k>`), nie z sesji Claude Code.
export const driverCall = () => /^drive-/.test(sessionId() ?? '');

// K5 D-11: `{register: false}` reads run.json without registering the calling session (`state --peek`, watchers).
export function loadRun(top, id, { register = true } = {}) {
  if (!/^[\w.-]+$/.test(id || '')) throw new Error(`zły identyfikator przebiegu: ${id}`);
  const f = join(runDir(top, id), 'run.json');
  if (!existsSync(f)) throw new Error(`brak przebiegu ${id} (${fwd(f)})`);
  const run = JSON.parse(read(f));
  const sid = register ? sessionId() : null;
  let changed = false;
  const t = isLegacy(run) ? null : run.tasks.find((x) => x.k === run.task);
  // Przegląd 2026-10-05 (sprint 5): sesja PO, która przeszła do worktree przebiegu (`Set-Location`), zostaje sesją wywołującą;
  // wcześniej trafiała też do `session_ids`, więc raport liczył ją dwa razy (12,62 zamiast ok. 11,0).
  if (sid && (foreignTree(top) || asList(run.callers).some((x) => x.id === sid))) {
    // Tryb A (recenzja): sesja PO z głównego drzewa nie jest sesją przebiegu; jej koszt liczy się tylko w oknie od pierwszej
    // do ostatniej komendy przebiegu (`run.callers`), a nie cała rozmowa przed sprintem i po nim.
    const now = new Date().toISOString();
    const c = asList(run.callers).find((x) => x.id === sid);
    if (!c) { run.callers = [...asList(run.callers), { id: sid, from: now, to: now }]; changed = true; }
    else if (Date.parse(now) - Date.parse(c.to) > 30e3) { c.to = now; changed = true; }
  } else {
    if (sid && !run.session_ids.includes(sid)) { run.session_ids.push(sid); changed = true; }
    if (sid && t && !t.sessions.includes(sid)) { t.sessions.push(sid); changed = true; }
  }
  if (changed) saveRun(top, run);
  return run;
}
// v2.10: zapis przez plik tymczasowy i rename (`dwmt watch` czyta run.json w trakcie pracy komend); Windows: ponowienia,
// gdy plik docelowy jest właśnie otwarty, na końcu zwykły zapis.
export function saveRun(top, run) {
  run.updated = new Date().toISOString();
  const f = join(runDir(top, run.run), 'run.json');
  return writeFileAtomic(f, `${JSON.stringify(run, null, 2)}\n`);
}

// ---------- sprint z zadaniami (v2.6, §5.9): stan zadania w run.tasks[], artefakty w tasks/<k>/ ----------

// Przebieg sprzed v2.6 (płaski katalog, stan zadania w run.json) jest tylko archiwum, ale musi dać się czytać.
export const isLegacy = (run) => !Array.isArray(run.tasks);

export function newTask(k, baseline, cfg) {
  return {
    k, title: null, baseline, started: {}, trees: {}, verified: 0, reviewInput: 0, units: {}, repairs: {},
    verifyPlanned: null, commit: null, accepted: false, maxRounds: cfg?.review?.maxRounds ?? 2, sessions: sessionId() ? [sessionId()] : [],
  };
}

// Kontekst bieżącego zadania: katalog artefaktów, stan (legacy: sam run), numer i liczba zadań.
export function taskCtx(root, run, k = run.task) {
  if (isLegacy(run)) return { root, dir: root, t: run, k: 1, n: 1, legacy: true };
  const t = run.tasks.find((x) => x.k === k);
  if (!t) throw new Error(`brak stanu zadania T-${k} w run.json`);
  return { root, dir: taskDir(root, k), t, k, n: run.count ?? sprintCount(root, run), legacy: false };
}

// Liczba zadań: z nagłówka planu (tasks), bez planu jedno zadanie.
export function sprintCount(root, run) {
  if (isLegacy(run)) return 1;
  const h = tryHeader(join(root, 'plan.md'));
  return h && !h.errors && asList(h.tasks).length ? asList(h.tasks).length : 1;
}

// Wszystkie zadania sprintu (do raportu i finish): legacy to jedno zadanie w katalogu przebiegu.
export const allTasks = (root, run) => (isLegacy(run) ? [taskCtx(root, run)] : run.tasks.map((t) => taskCtx(root, run, t.k)));

// Pierwsze drzewo z `git worktree list`: tylko ostatnia rezerwa `runHome` (przebiegi bez `homeTree` i `mainTree`).
// Pozostały kod pyta `runHome` albo `contextHome` (D-3, D-4).
export function mainTreeOf(top) {
  const first = /^worktree (.+)$/m.exec(git(['worktree', 'list', '--porcelain'], { cwd: top }))?.[1];
  return fwd(first ?? top);
}

// Drzewo domowe przebiegu (C-2): pole `homeTree` z init; przebiegi sprzed niego: `mainTree`, potem pierwsze drzewo.
export const runHome = (run, top) => canonPath(run?.homeTree ?? run?.mainTree ?? mainTreeOf(top));

// Drzewo domowe komendy bez przebiegu (D-3): przebieg gałęzi drzewa `top` (`<branchPrefix><id>` z run.json), inaczej
// worktree z gałęzią docelową, inaczej samo `top`. run.json czytany wprost: `loadRun` zapisałby sesję wołającego.
export function contextHome(top) {
  let cfg = null;
  try { cfg = loadConfig(top); } catch { /* bez configu: tylko `top` */ }
  if (cfg) {
    const branch = gitRaw(['branch', '--show-current'], { cwd: top }).stdout?.trim() ?? '';
    const prefix = cfg.git?.branchPrefix;
    const id = prefix && branch.startsWith(prefix) ? branch.slice(prefix.length) : '';
    const f = /^[\w.-]+$/.test(id) ? join(runDir(top, id), 'run.json') : null;
    if (f && existsSync(f)) {
      try { return runHome(JSON.parse(read(f)), top); } catch { /* zły run.json: dalej jak bez przebiegu */ }
    }
    let held = null;
    try { held = cfg.git?.target ? worktreeFor(top, cfg.git.target) : null; } catch { /* nie repo */ }
    if (held) return canonPath(held);
  }
  return canonPath(top);
}

// Status dla supervisora (§5.10): tylko przebiegi z --sprint; zapis przez tmp+rename, zdarzenia zostają w pliku.
export function writeStatus(top, run, state, fields = {}, event = null) {
  if (!run.sprint) return null;
  const dir = join(runHome(run, top), '.dwmt', 'supervisor', 'status');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${run.sprint}.json`);
  let old = {};
  try { old = JSON.parse(read(file)); } catch { /* pierwszy zapis */ }
  const events = asList(old.events);
  if (event) events.push({ seq: Math.max(0, ...events.map((e) => e.seq || 0)) + 1, at: new Date().toISOString(), ...event });
  const data = {
    schema: 'dwmt/status@1', sprint: run.sprint, run: run.run, state, at: new Date().toISOString(), session: sessionId(),
    task: isLegacy(run) ? 1 : run.task, tasks: run.count ?? null, ...fields, events,
  };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, file);
  return fwd(file);
}

// v2.10: zdarzenie przebiegu w dzienniku maszyny `~/.dwmt/events.jsonl` (projekt = główne drzewo). Nigdy nie rzuca.
export function runEvent(top, run, type, extra = {}) {
  try {
    return emit({ type, project: runHome(run, top), run: run.run, task: isLegacy(run) ? null : run.task, ...extra });
  } catch { return null; }
}

// v2.10: katalog przebiegu po sprawdzeniu identyfikatora i run.json (przed zapisem `active.json`: literówka albo `../x`
// nie tworzy katalogów).
// Drzewo procesu wołającego (raz na proces) różne od drzewa przebiegu: komenda z głównego drzewa dla przebiegu w worktree.
let callerTopCache;
export function foreignTree(top) {
  if (callerTopCache === undefined) {
    try { callerTopCache = git(['rev-parse', '--show-toplevel'], { cwd: process.cwd() }); } catch { callerTopCache = null; }
  }
  return !!callerTopCache && !samePath(callerTopCache, top);
}

// Tryb A (2026-10-04): sesja PO w głównym drzewie prowadzi sprint z `init --worktree`. Komendy przebiegu biegną wtedy
// w jego worktree: istniejący worktree gałęzi przebiegu z `run.json` ma pierwszeństwo przed kopią w głównym drzewie.
export function runTop(top, id) {
  if (!/^[\w.-]+$/.test(id || '') || /^\.+$/.test(id)) return top;
  let wt = null;
  try { wt = worktreeFor(top, `${loadConfig(top).git.branchPrefix}${id}`); } catch { return top; }
  return wt && existsSync(join(runDir(wt, id), 'run.json')) ? wt : top;
}

export function checkedRunDir(top, id) {
  if (!/^[\w.-]+$/.test(id || '') || /^\.+$/.test(id)) throw new Error(`zły identyfikator przebiegu: ${id}`);
  const root = runDir(top, id);
  if (!existsSync(join(root, 'run.json'))) throw new Error(`brak przebiegu ${id} (${fwd(join(root, 'run.json'))})`);
  return root;
}
