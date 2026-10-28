// dwmt v2.10: alarm przestoju według życia, nie czasu (`dwmt watch <run>`, uruchamiany w tle (`run_in_background`, bez
// limitu czasu) obok `verify` i `finish` w tle). sprint 10: `verify` w tle zabite przy braku pamięci, orkiestrator czekał 4,7 h.
// Żyje = proces komendy skryptu (PID w `active.json` przebiegu albo bilet kolejki maszyny tego przebiegu) albo przyrost
// transkryptów sesji przebiegu i plików przebiegu. Przestój = stan mówi, że praca trwa, a nikt nie żyje. Czekanie na
// użytkownika to osobny stan (bez alarmu). Limit czasu tylko na zawieszenie: proces żyje, a nic nie przyrasta przez `hangMin`.
// Import z dwmt.mjs tworzy cykl ES (jak uat.mjs); żadna funkcja stąd nie jest używana na poziomie modułu.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, renameSync, mkdirSync, rmSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { alive as pidAlive, home, tickets } from './machine.mjs';
import { emit, readEventsFrom } from './events.mjs';
import { samePath } from './lib/util.mjs';

// An event belongs to the waited project when no project is given, the event names none, or both name one tree (C-1).
export const ofProject = (e, project) => !project || !e?.project?.root || samePath(e.project.root, project);

export const WATCH_DEFAULTS = { intervalSec: 30, idleMin: 30, hangMin: 90 };
// Kroki, w których ktoś pracuje (agent, skrypt albo orkiestrator między nimi), i kroki czekania na użytkownika.
export const WORK_PHASES = ['plan', 'replan', 'implement', 'fix', 'continue', 'repair', 'batch', 'verify', 'review', 'goal-check', 'commit', 'finish'];
export const WAIT_PHASES = ['ask-plan', 'ask', 'ask-rounds', 'ask-delete', 'planned', 'handoff', 'done'];
const FINISH_WAIT = ['conflict', 'red', 'env', 'squash-failed', 'merge-wait', 'deferred-major'];

const read = (f) => readFileSync(f, 'utf8');
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const mtime = (f) => { try { return statSync(f).mtimeMs; } catch { return 0; } };

// ---------- rekord komendy skryptu (`active.json` w katalogu przebiegu) ----------
// verify i finish zapisują PID na starcie, odświeżają po każdej komendzie i dopisują `end` na końcu. Proces zabity z zewnątrz
// (brak pamięci) zostawia rekord bez `end` z martwym PID: to jest przestój.
const activeFile = (root) => join(root, 'active.json');
function writeAtomic(file, obj) {
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(obj)}\n`);
    renameSync(tmp, file);
  } catch { /* rekord pomocniczy: nigdy nie psuje komendy */ }
}
export function readActive(root) {
  try { return JSON.parse(read(activeFile(root))); } catch { return null; }
}
export function markActive(root, cmd) {
  // pidStart: start procesu (Windows używa PID-ów ponownie; żywy obcy proces z tym PID-em nie jest tą komendą).
  const rec = { cmd, pid: process.pid, pidStart: new Date(Date.now() - process.uptime() * 1000).toISOString(), start: new Date().toISOString() };
  writeAtomic(activeFile(root), rec);
  return rec;
}
export function touchActive(root, step) {
  const rec = readActive(root);
  if (rec && rec.pid === process.pid && !rec.end) writeAtomic(activeFile(root), { ...rec, step, stepAt: new Date().toISOString() });
}
export function endActive(root, result = null) {
  const rec = readActive(root);
  if (rec && rec.pid === process.pid) writeAtomic(activeFile(root), { ...rec, end: new Date().toISOString(), ...(result ? { result } : {}) });
}
// Komenda w pliku: `markActive` i `endActive` wokół `fn` (także przy wyjątku). Martwy rekord bez `end` (komenda zabita
// wcześniej) znika przed startem.
export function withActive(root, cmd, fn) {
  const prev = readActive(root);
  if (prev && !prev.end && !processAlive(prev.pid, prev.pidStart)) clearActive(root);
  markActive(root, cmd);
  let out;
  try { out = fn(); } finally { endActive(root, out && typeof out === 'object' ? (out.result ?? out.status ?? null) : null); }
  return out;
}

// ---------- życie procesu (Windows i POSIX) ----------
// process.kill(pid, 0) działa na obu systemach; tasklist tylko, gdy kill zgłasza coś innego niż ESRCH/EPERM.
// `pidStart` (z rekordu): żywy proces, który wystartował w innej chwili, to PID użyty ponownie, więc komenda nie żyje.
export function processAlive(pid, pidStart = null) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  let alive;
  try { process.kill(Number(pid), 0); alive = true; } catch (e) {
    if (e.code === 'EPERM') alive = true;
    else if (e.code === 'ESRCH') return false;
  }
  if (alive === undefined) {
    if (process.platform === 'win32') {
      const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 10e3, windowsHide: true });
      alive = r.status === 0 && new RegExp(`"${pid}"`).test(r.stdout);
    } else alive = pidAlive(Number(pid));
  }
  if (!alive || !pidStart || Number(pid) === process.pid) return alive;
  const t = processStart(pid);
  return t == null || Math.abs(t - Date.parse(pidStart)) < 10e3;
}

// Chwila startu procesu (ms) albo null, gdy narzędzia systemu nie ma.
export function processStart(pid) {
  try {
    const r = process.platform === 'win32'
      ? spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`], { encoding: 'utf8', timeout: 15e3, windowsHide: true })
      : spawnSync('ps', ['-o', 'lstart=', '-p', String(Number(pid))], { encoding: 'utf8', timeout: 10e3 });
    const t = r.status === 0 ? Date.parse(r.stdout.trim()) : NaN;
    return Number.isFinite(t) ? t : null;
  } catch { return null; }
}

// ---------- przyrost: transkrypty sesji przebiegu i pliki przebiegu ----------
// `main: false`: tylko transkrypty agentów (bez głównego transkryptu orkiestratora).
export function transcriptFiles(sessionIds, root = process.env.DWMT_TRANSCRIPTS || join(homedir(), '.claude', 'projects'), { main: withMain = true } = {}) {
  const ids = asList(sessionIds).filter(Boolean);
  if (!ids.length || !existsSync(root)) return [];
  const out = [];
  for (const proj of readdirSync(root)) {
    for (const id of ids) {
      const main = join(root, proj, `${id}.jsonl`);
      if (withMain && existsSync(main)) out.push(main);
      const subs = join(root, proj, id, 'subagents');
      if (existsSync(subs)) for (const f of readdirSync(subs).filter((x) => x.endsWith('.jsonl'))) out.push(join(subs, f));
    }
  }
  return out;
}

function runFilesMtime(root, run) {
  let latest = Math.max(mtime(join(root, 'run.json')), mtime(activeFile(root)));
  const dirs = [join(root, 'tasks', String(run.task ?? 1)), join(root, 'batch'), join(root, 'explore')];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) latest = Math.max(latest, mtime(join(d, f)));
  }
  return latest;
}

// Bilety kolejki maszyny (wszystkie klucze) z polem `run` tego przebiegu i żywym procesem (martwe usuwa `tickets`).
// `readOnly` (observers such as `dwmt live`): dead tickets are skipped without removing them.
export function queueTickets(runId, { readOnly = false } = {}) {
  const base = join(home(), 'locks');
  if (!existsSync(base)) return [];
  const out = [];
  for (const key of readdirSync(base)) {
    try { for (const t of tickets(key, undefined, { readOnly })) if (t.run === runId) out.push({ key, ...t }); } catch { /* bilet w zapisie */ }
  }
  return out;
}

// Ocena jednego odczytu. `since`: start obserwacji (komenda zakończona po nim to koniec obserwacji, nie przestój).
export function assess({ root, run, watch = {}, now = Date.now(), since = now, aliveFn = processAlive, transcripts, queue = queueTickets }) {
  const w = { ...WATCH_DEFAULTS, ...watch };
  const act = readActive(root);
  const quiet = (growth) => (now - growth) / 60e3;
  const phase = run.phase ?? null;
  if (act && !act.end) {
    if (!aliveFn(act.pid, act.pidStart)) return { phase, quietMin: Math.round(quiet(mtime(activeFile(root)))), state: 'stall', reason: 'dead', cmd: act.cmd, pid: act.pid, since: act.start };
    // Komenda biegnie: przyrost tylko z jej rekordu, jej biletu kolejki i transkryptów agentów. Główny transkrypt
    // orkiestratora rośnie także wtedy, gdy komenda wisi; bilet czekający w kolejce maszyny to praca, nie zawieszenie.
    const mine = queue(run.run).filter((t) => Number(t.pid) === Number(act.pid));
    if (mine.some((t) => !t.start)) return { phase, quietMin: 0, state: 'working', who: `pid ${act.pid} ${act.cmd} waiting in the machine queue` };
    const growth = Math.max(mtime(activeFile(root)), ...mine.map((t) => Date.parse(t.start) || 0), ...transcriptFiles(run.session_ids, transcripts, { main: false }).map(mtime), 0);
    const quietMin = quiet(growth);
    if (quietMin > w.hangMin) return { phase, quietMin: Math.round(quietMin), state: 'hang', cmd: act.cmd, pid: act.pid, step: act.step ?? null };
    return { phase, quietMin: Math.round(quietMin), state: 'working', who: `pid ${act.pid} ${act.cmd}` };
  }
  const growth = Math.max(runFilesMtime(root, run), ...transcriptFiles(run.session_ids, transcripts).map(mtime), 0);
  const quietMin = quiet(growth);
  const base = { phase, quietMin: Math.round(quietMin) };
  if (act?.end && Date.parse(act.end) >= since) return { ...base, state: 'ended', cmd: act.cmd, result: act.result ?? null };
  const f = run.finish?.status;
  if (['squashed', 'left'].includes(f)) return { ...base, state: 'done' };
  if (run.phase === 'finish' && FINISH_WAIT.includes(f)) return { ...base, state: 'waiting', reason: f };
  // K5 D-10: a run stopped by a failed agent session is stalled at once, not after `idleMin`.
  const failure = sessionStall(root, run, aliveFn, transcripts);
  if (failure) return { ...base, state: 'stall', reason: 'session', detail: failure };
  if (WAIT_PHASES.includes(run.phase)) return { ...base, state: 'waiting', reason: run.phase };
  if (!WORK_PHASES.includes(run.phase)) return { ...base, state: 'working', who: 'unknown phase' };
  // N-2: sterownik (`drive.mjs`) żyje = praca; agentów i komend pilnuje sam (wynik, śmierć dziecka, `agentTimeoutMin`).
  const drv = driverAlive(root, aliveFn);
  if (drv) return { ...base, state: 'working', who: `driver pid ${drv.pid}` };
  const q = queue(run.run);
  if (q.length) return { ...base, state: 'working', who: `queue pid ${q[0].pid}` };
  if (quietMin <= w.idleMin) return { ...base, state: 'working', who: 'transcript or run files growing' };
  return { ...base, state: 'stall', reason: 'idle' };
}

// K5 D-9, D-10: stop causes of a failed agent session (drive.json.stopped.cause, run.sessionFailure.cause).
export const SESSION_FAILURES = ['agent-error', 'child-dead', 'no-start'];

// K5 D-10: "<cause>: <reason>" when (1) no driver is alive and drive.json.stopped has a session-failure cause newer than
// the driver start, or (2) run.sessionFailure is set and no session of the run is alive (no launch, transcript growth or
// driver after it). null otherwise. Batch F-3: in both cases the run files (run.json, active.json, the task, batch and
// explore files) or the run's transcripts growing after the failure mean the run was resumed without a driver (drive-mode
// off and /dwmt:execute, or an interactive session): not stalled. The stop writes run.json itself right after `at`, hence
// the margin.
const RESUME_MARGIN_MS = 2000;
export function sessionStall(root, run, aliveFn = processAlive, transcripts = undefined) {
  if (driverAlive(root, aliveFn)) return null;
  const resumed = (at) => runFilesMtime(root, run) > at + RESUME_MARGIN_MS || transcriptFiles(run.session_ids, transcripts).some((f) => mtime(f) > at + RESUME_MARGIN_MS);
  const mem = readDriveMem(root);
  const s = mem?.stopped;
  if (s && SESSION_FAILURES.includes(s.cause) && (!mem.startedAt || String(s.at ?? '') >= String(mem.startedAt))) {
    return resumed(Date.parse(s.at) || 0) ? null : `${s.cause}: ${String(s.reason ?? '').slice(0, 200)}`;
  }
  const sf = run.sessionFailure;
  if (!sf?.at) return null;
  const at = Date.parse(sf.at) || 0;
  if (asList(run.launches).some((l) => (Date.parse(l.at) || 0) > at)) return null;
  if (mem?.startedAt && (Date.parse(mem.startedAt) || 0) > at) return null;
  if (resumed(at)) return null;
  return `${sf.cause}: ${String(sf.error ?? '').slice(0, 200)}`;
}

// Jedna linia dla człowieka: co się stało i czego potrzeba (v2.10, zasada komunikatów).
export function stallLine(a, runId, lang = 'en') {
  const pl = String(lang).toLowerCase().startsWith('pl');
  if (a.reason === 'session') {
    return pl
      ? `dwmt ${runId}: praca agenta przerwana (${a.detail}); przebieg stoi. Potrzeba: \`/dwmt:execute ${runId}\` wznawia przebieg.`
      : `dwmt ${runId}: agent work broke off (${a.detail}); the run is stalled. Needed: \`/dwmt:execute ${runId}\` resumes the run.`;
  }
  if (a.state === 'hang') {
    return pl
      ? `dwmt ${runId}: \`${a.cmd}\` (pid ${a.pid}) żyje, ale od ${a.quietMin} min nic nie przyrasta (podejrzenie zawieszenia). Potrzeba: Twoja decyzja: czekać dalej albo zatrzymać proces i ponowić krok.`
      : `dwmt ${runId}: \`${a.cmd}\` (pid ${a.pid}) is alive but nothing has grown for ${a.quietMin} min (hang suspected). Needed: your decision: keep waiting, or stop the process and repeat the step.`;
  }
  if (a.reason === 'dead') {
    return pl
      ? `dwmt ${runId}: \`${a.cmd}\` przestało działać bez wyniku (pid ${a.pid} nie żyje, np. brak pamięci). Potrzeba: \`dwmt state ${runId}\` i ponów \`${a.cmd}\`.`
      : `dwmt ${runId}: \`${a.cmd}\` stopped without a result (pid ${a.pid} is gone, e.g. out of memory). Needed: \`dwmt state ${runId}\`, then run \`${a.cmd}\` again.`;
  }
  return pl
    ? `dwmt ${runId}: krok \`${a.phase}\` stoi od ${a.quietMin} min i nikt go nie wykonuje (żaden proces ani transkrypt nie żyje). Potrzeba: \`/dwmt:execute ${runId}\` wznawia przebieg.`
    : `dwmt ${runId}: step \`${a.phase}\` has stood for ${a.quietMin} min with nobody doing it (no live process or transcript). Needed: \`/dwmt:execute ${runId}\` resumes the run.`;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Pętla `dwmt watch`: koniec bez linii, gdy obserwowana komenda skończyła się normalnie, gdy przebieg czeka na użytkownika
// albo się zakończył; przy przestoju albo zawieszeniu zdarzenie `stall`, jedna linia i koniec.
// Bez `follow` obserwacja kończy się także wtedy, gdy krok przebiegu zmienił się od startu, a żadna komenda nie biegnie
// (komenda skończyła się przed pierwszym odczytem): kolejne `watch` przy `verify` nie zostają w tle na resztę przebiegu.
export function watchLoop({ load, root, runId, project, watch = {}, lang = 'en', interval = null, maxPolls = Infinity, follow = false, write = (s) => process.stdout.write(`${s}\n`) }) {
  const w = { ...WATCH_DEFAULTS, ...watch };
  const since = Date.now();
  const ms = (interval ?? w.intervalSec) * 1000;
  let startPhase;
  let graced = false;
  for (let i = 0; i < maxPolls; i++) {
    // run.json w trakcie zapisu albo inny błąd odczytu: odczyt pominięty, komunikat tylko na stderr (stdout to linia przestoju).
    let run;
    let a;
    try {
      run = load();
      a = assess({ root, run, watch: w, since });
    } catch (e) {
      process.stderr.write(`dwmt watch: odczyt pominięty (${e.message})\n`);
      if (i + 1 < maxPolls) sleep(ms);
      continue;
    }
    if (startPhase === undefined) startPhase = run.phase;
    if (['ended', 'done', 'waiting'].includes(a.state)) return { ...a, polls: i + 1 };
    const cmd = readActive(root);
    if (!follow && a.state === 'working' && !(cmd && !cmd.end) && run.phase !== startPhase) return { ...a, state: 'ended', reason: 'phase-changed', polls: i + 1 };
    // Martwy rekord sprzed startu obserwacji: komenda uruchomiona razem z `watch` mogła go jeszcze nie nadpisać; alarm,
    // gdy przy następnym odczycie dalej jest martwy.
    if (a.reason === 'dead' && Date.parse(a.since) < since && !graced) {
      graced = true;
      if (i + 1 < maxPolls) sleep(ms);
      continue;
    }
    if (a.state === 'stall' || a.state === 'hang') {
      emit({ type: 'stall', project, run: runId, task: run.task ?? null, detail: { kind: a.state === 'hang' ? 'hang' : a.reason, phase: a.phase, cmd: a.cmd ?? null, pid: a.pid ?? null, quietMin: a.quietMin } });
      write(stallLine(a, runId, lang));
      return { ...a, polls: i + 1 };
    }
    if (i + 1 < maxPolls) sleep(ms);
  }
  return { state: 'working', polls: maxPolls };
}

export const clearActive = (root) => rmSync(activeFile(root), { force: true });

// ---------- sterownik (N-2): `drive.lock`, `drive.json` i `dwmt wait` ----------
// `drive.lock` w katalogu przebiegu: {pid, pidStart, start} (prototyp v3: sam numer PID, czytany też).
export function readDriveLock(root) {
  try {
    const t = read(join(root, 'drive.lock')).trim();
    const j = /^\d+$/.test(t) ? { pid: Number(t) } : JSON.parse(t);
    return Number.isInteger(Number(j?.pid)) ? { ...j, pid: Number(j.pid) } : null;
  } catch { return null; }
}
export function writeDriveLock(root) {
  const rec = { pid: process.pid, pidStart: new Date(Date.now() - process.uptime() * 1000).toISOString(), start: new Date().toISOString() };
  writeAtomic(join(root, 'drive.lock'), rec);
  return rec;
}
// Blokada wyłączna (recenzja N-2): plik tworzy `wx` (tylko gdy go nie ma), więc z równoczesnych startów rusza jeden.
// Zajętą przejmuje tylko po martwym właścicielu (PID nie żyje albo użyty ponownie). Martwą usuwa tylko proces, który
// założył `drive.lock.takeover` (`wx`), i tylko gdy plik ma dalej oceniony rekord: bez tego dwa procesy po tej samej
// ocenie usuwały nawzajem świeże blokady (test trzech startów). Wynik: `{ok: true, lock}` albo `{ok: false, held}`.
export const acquireDriveLock = (root, aliveFn = processAlive) => acquireLockFile(join(root, 'drive.lock'), aliveFn);
// S3: ta sama blokada dla pętli supervisora (`.dwmt/supervisor/loop.lock`): plik z rekordem {pid, pidStart, start}.
export function readLockFile(file) {
  try {
    const t = read(file).trim();
    const j = /^\d+$/.test(t) ? { pid: Number(t) } : JSON.parse(t);
    return Number.isInteger(Number(j?.pid)) ? { ...j, pid: Number(j.pid) } : null;
  } catch { return null; }
}
export function acquireLockFile(file, aliveFn = processAlive) {
  const guard = `${file}.takeover`;
  const current = () => readLockFile(file);
  const raw = () => { try { return read(file); } catch { return null; } };
  const create = (f, text) => {
    let fd;
    try { fd = openSync(f, 'wx'); } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
    try { writeSync(fd, text); } finally { closeSync(fd); }
    return true;
  };
  mkdirSync(join(file, '..'), { recursive: true });
  for (let i = 0; i < 50; i++) {
    const rec = { pid: process.pid, pidStart: new Date(Date.now() - process.uptime() * 1000).toISOString(), start: new Date().toISOString() };
    if (create(file, `${JSON.stringify(rec)}\n`)) return { ok: true, lock: rec };
    let seen = raw();
    // Plik założony, rekord jeszcze niezapisany: drugi odczyt po chwili.
    if (seen != null && !current()) { sleep(200); seen = raw(); }
    const held = current();
    if (held?.pid === process.pid) return { ok: true, lock: held };
    if (held && aliveFn(held.pid, held.pidStart ?? null)) return { ok: false, held };
    if (Date.now() - mtime(guard) > 30e3) rmSync(guard, { force: true }); // osierocony po zabitym procesie
    if (create(guard, String(process.pid))) {
      try { if (raw() === seen) rmSync(file, { force: true }); } finally { rmSync(guard, { force: true }); }
    } else sleep(100);
  }
  return { ok: false, held: current() };
}
// Zabicie procesu z potomkami (agent `claude -p` uruchamia własne procesy; Windows: `taskkill /T`). Best effort.
export function killTree(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0 || n === process.pid) return false;
  if (process.platform === 'win32') return spawnSync('taskkill', ['/PID', String(n), '/T', '/F'], { encoding: 'utf8', timeout: 30e3, windowsHide: true }).status === 0;
  try { process.kill(n, 'SIGKILL'); return true; } catch { return false; }
}
// Żywy sterownik przebiegu (rekord blokady) albo null.
export function driverAlive(root, aliveFn = processAlive) {
  const l = readDriveLock(root);
  return l && aliveFn(l.pid, l.pidStart ?? null) ? l : null;
}
export function readDriveMem(root) {
  try { return JSON.parse(read(join(root, 'drive.json'))); } catch { return null; }
}
export const writeDriveMem = (root, mem) => writeAtomic(join(root, 'drive.json'), mem);

// Jedna linia dla człowieka przy śmierci sterownika albo zawieszeniu komendy pod sterownikiem.
// W-3 (przegląd 2026-10-09): `price-alert` (koszt ponad górną cenę) to też punkt kontrolny, z `push` w linii `wait`.
const PROGRESS = ['task-start', 'task-end', 'price-alert'];
// Linia punktu kontrolnego dla człowieka (sesja pokazuje ją bez zmian).
export function progressLine(e, tasks, lang = 'en') {
  const pl = String(lang).toLowerCase().startsWith('pl');
  if (e.type === 'price-alert') {
    const d = e.detail ?? {};
    const fc = d.forecastM != null ? (pl ? `, prognoza ok. ${d.forecastM} mln (po ${d.done}/${d.tasks} zadaniach)` : `, forecast ~${d.forecastM} M (after ${d.done}/${d.tasks} tasks)`) : '';
    return pl ? `⚠ koszt sprintu ${e.costM} mln przekroczył górną cenę ${d.upperM} mln${fc}; sprint idzie dalej` : `⚠ sprint cost ${e.costM} M passed the upper price ${d.upperM} M${fc}; the sprint goes on`;
  }
  const n = Number(e.detail?.tasks) || tasks;
  const t = `T-${e.task ?? '?'}${n ? `/${n}` : ''}`;
  if (e.type === 'task-start') {
    const title = e.detail?.title ? `: ${e.detail.title}` : '';
    return `▸ ${t} ${pl ? 'start' : 'started'}${title}`;
  }
  const cost = Number.isFinite(Number(e.costM)) && e.costM !== null ? ` · ${Number(e.costM)} ${pl ? 'mln' : 'M'}` : '';
  return `▸ ${t} ${e.verdict ?? 'done'}${cost}`;
}

export function driveLine(kind, a, runId, lang = 'en') {
  const pl = String(lang).toLowerCase().startsWith('pl');
  if (kind === 'dead') {
    return pl
      ? `dwmt ${runId}: sterownik (pid ${a.pid}) przestał działać bez zdarzenia końca (np. brak pamięci albo zamknięty proces). Potrzeba: \`/dwmt:execute ${runId}\` uruchamia go od bieżącego kroku.`
      : `dwmt ${runId}: the driver (pid ${a.pid}) stopped without its end event (e.g. out of memory or the process was closed). Needed: \`/dwmt:execute ${runId}\` starts it again from the current step.`;
  }
  if (kind === 'not-running') {
    return pl ? `dwmt ${runId}: sterownik tego przebiegu nie działa. Potrzeba: \`/dwmt:execute ${runId}\`.` : `dwmt ${runId}: no driver is running for this run. Needed: \`/dwmt:execute ${runId}\`.`;
  }
  return stallLine(a, runId, lang);
}

// `dwmt wait <run>` (N-2): sesja sprintu czeka na sterownik poleceniem w tle (`run_in_background`, bez limitu czasu; nie
// Monitor, który kończy obserwację po ≤ 30 min). Wypisuje JEDNĄ linię JSON `{status, reason}` i kończy, gdy przebieg
// potrzebuje sesji: zdarzenie `drive-stop` tego przebiegu (done, waiting-user, stopped, hold), śmierć sterownika bez
// zdarzenia końca (`dead`, zdarzenie `stall` kind driver-dead), zawieszenie komendy (`hang`, jak `watch`), brak sterownika.
// Zdarzenia: tylko tego przebiegu i od startu bieżącego sterownika (`drive.json.startedAt`) albo od `--detach`
// (`detachedAt`: sterownik, który nie wystartował, nie odtwarza starego zatrzymania); bez dziennika (wyłączony) to samo
// daje `drive.json.stopped`, zapisane przed zdjęciem blokady. `finish` w linii: wynik `finish` ze zatrzymania sterownika.
// Zawieszenie liczy się od późniejszego z: ostatni przyrost, start `wait` (po „czekaj dalej” nowe `wait` nie alarmuje od razu).
export function waitDriver({ root, runId, project, load, watch = {}, lang = 'en', interval = null, maxPolls = Infinity, aliveFn = processAlive, progress = false, after = null, write = (s) => process.stdout.write(`${s}
`) }) {
  const w = { ...WATCH_DEFAULTS, ...watch };
  const ms = (interval ?? w.intervalSec) * 1000;
  const t0 = Date.now();
  let offset = 0;
  let fileId = null;
  let suspect = 0;
  // Tryb A (`--progress`): punkty kontrolne (start i koniec zadania) jako linie `progress`. Pokazane zapamiętuje
  // `progress.json` przebiegu (recenzja: bez polegania na `--after` od modelu; zdarzenia z tą samą chwilą osobno). Okno
  // zaczyna się 5 min przed startem sterownika: `task-start` z `state` sesji tuż przed `--detach` też trafia.
  const afterMs = Date.parse(after ?? '') || 0;
  const shownFile = join(root, 'progress.json');
  let tasks = null;
  const out = (o) => { write(JSON.stringify(o)); return o; };
  const line = (status, reason, d = {}, mem = null) => out({ status, reason: reason ?? '', ...(d.resetsAt ? { resetsAt: d.resetsAt } : {}), ...(mem?.finish ? { finish: mem.finish } : {}) });
  for (let i = 0; i < maxPolls; i++) {
    const mem = readDriveMem(root);
    const startedAt = Date.parse(mem?.startedAt ?? '') || 0;
    const since = Math.max(startedAt, Date.parse(mem?.detachedAt ?? '') || 0);
    const stopped = mem?.stopped && since && Date.parse(mem.stopped.at) >= since ? mem.stopped : null;
    const r = readEventsFrom(offset, { run: runId, id: fileId });
    offset = r.offset;
    fileId = r.id;
    if (progress) {
      for (const e of r.events) if (e.type === 'task-start' && Number.isFinite(Number(e.detail?.tasks))) tasks = Number(e.detail.tasks);
      let shown = [];
      try { shown = JSON.parse(readFileSync(shownFile, 'utf8')).shown ?? []; } catch { /* pierwszy punkt */ }
      const key = (e) => `${e.type}|${e.task ?? ''}|${e.ts}`;
      const p = r.events.find((e) => PROGRESS.includes(e.type) && ofProject(e, project) && Date.parse(e.ts) >= Math.max(afterMs, since - 300e3) && !shown.includes(key(e)));
      if (p) {
        writeFileSync(shownFile, `${JSON.stringify({ shown: [...shown, key(p)].slice(-200) })}\n`);
        return out({ status: 'progress', reason: progressLine(p, tasks, lang), at: p.ts, ...(p.type === 'price-alert' ? { push: true } : {}) });
      }
    }
    const stop = r.events.filter((e) => e.type === 'drive-stop' && Date.parse(e.ts) >= since).pop();
    if (stop && since) return line(stop.detail?.status ?? 'stopped', stop.detail?.reason, stop.detail ?? {}, stopped);
    const drv = driverAlive(root, aliveFn);
    if (drv) {
      suspect = 0;
      const act = readActive(root);
      if (act && !act.end) {
        try {
          const a = assess({ root, run: load(), watch: w, aliveFn });
          if (a.state === 'hang' && (Date.now() - t0) / 60e3 > w.hangMin) {
            emit({ type: 'stall', project, run: runId, detail: { kind: 'hang', phase: a.phase, cmd: a.cmd, pid: a.pid, quietMin: a.quietMin } });
            return out({ status: 'hang', reason: stallLine(a, runId, lang) });
          }
        } catch { /* run.json w zapisie: następny odczyt */ }
      }
    } else if (stopped) {
      return line(stopped.status, stopped.reason, stopped, stopped);
    } else if (++suspect >= 2) {
      // Dwa odczyty z rzędu bez żywego sterownika (start w toku nie daje fałszywego alarmu).
      if (!startedAt || startedAt < since) return out({ status: 'not-running', reason: driveLine('not-running', {}, runId, lang) });
      emit({ type: 'stall', project, run: runId, detail: { kind: 'driver-dead', pid: mem.pid ?? null } });
      return out({ status: 'dead', reason: driveLine('dead', { pid: mem.pid ?? '?' }, runId, lang) });
    }
    if (i + 1 < maxPolls) sleep(suspect ? Math.min(ms, 2000) : ms);
  }
  return { status: 'waiting', polls: maxPolls };
}

// `dwmt stop <run>` (recenzja N-2): użytkownik po linii `hang` zatrzymuje zawieszoną komendę (PID z `active.json`, z
// potomkami); sterownik dostaje komendę bez wyniku i kończy się `stopped` (`child-dead`), a `wait` to zgłasza.
export function stopCommand(root, aliveFn = processAlive) {
  const act = readActive(root);
  if (!act || act.end || !aliveFn(act.pid, act.pidStart ?? null)) return { ok: false, error: 'żadna komenda przebiegu nie działa (active.json)' };
  return { ok: killTree(act.pid), cmd: act.cmd, pid: act.pid };
}
