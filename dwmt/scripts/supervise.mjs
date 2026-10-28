#!/usr/bin/env node
// dwmt S3 (specyfikacja-supervisora.md v1.0 §3–§4, §8): supervisor jako pętla w skrypcie, bez modelu w pętli (S6, 0 tokenów).
// Działa tylko na zlecenie (S9): bez `supervise order` nie ma pętli, autostartu ani plików w `.dwmt/supervisor/`; projekt
// działa jak d4-1. `supervisor.enabled: false` blokuje `order`. Stan w `.dwmt/supervisor/supervisor.json` głównego drzewa.
// Pętla co `supervisor.intervalSec` (i od razu po nowej linii dziennika zdarzeń): czyta zdarzenia od przesunięcia
// (`eventsOffset`), pliki statusu i UAT, życie sterowników (`drive.lock`, `drive.json`), stosuje reguły R1–R5 (§4.4) i
// wykonuje decyzje: start sterownika (`drive.mjs --detach`) albo sesji orkiestratora (`dwmt launch`), sesja zatrzymania przy
// `waiting-user`, `drive.hold` (limit nocy, start „tylko planowanie” R2/R3, wstrzymanie), wznowienie po limicie abonamentu
// (`resetsAt`), jedno wznowienie po przestoju według życia, bez ponawiania martwej pracy (decyzja A: `stopped` z powodem
// zostaje zatrzymane ze zdarzeniem). Każda decyzja: wpis w `log.md` i zdarzenie `supervisor` w `~/.dwmt/events.jsonl`.
// Komendy dla PO (§4.9): `dwmt.mjs supervise order|status|set|hold|resume|answer|report|close|run`.
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, appendFileSync, statSync, readdirSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT, fwd, read, asList, samePath, canonPath, printJson, writeFileAtomic } from './lib/util.mjs';
import { withHeader, splitHeader, parseYaml } from './lib/headers.mjs';
import { loadConfig } from './lib/config.mjs';
import { git, gitRaw, topOf, worktreeFor } from './lib/git.mjs';
import { leanPlugins } from './lib/sessions.mjs';
import { contextHome } from './lib/run.mjs';
import { checkAgents } from './lib/setup.mjs';
import { mergeKey, mergeWaitReason } from './lib/finish.mjs';
import { machineConfig, home, activeHolds } from './machine.mjs';
import { emit, readEventsFrom, eventsFile, eventsFileId, eventsEnabled } from './events.mjs';
import { processAlive, readLockFile, acquireLockFile, readDriveMem, transcriptFiles, assess, SESSION_FAILURES } from './watch.mjs';
import { notify as platformNotify, keepAwake, autostart, platformWarnings, taskName } from './lib/platform.mjs';
import { supDir, supFile, loopLockFile, readSup, loopAlive, ensureLoop, needsLoop, SUPERVISE } from './lib/supervisor-loop.mjs';
import { productRun } from './product.mjs';
import { productConfig } from './lib/product-config.mjs';
import { paths as productPaths, stripForYou } from './lib/product-store.mjs';
import { estimateOf } from './lib/product-ops.mjs';
import { depMerged, roadmapState, roadmapLines, currentAfter, orderByRoadmap } from './lib/deps.mjs';
import { workplaceOf, startWorkplaceOf, workplaceSprints, workplaceReady, startBlock } from './lib/workplace.mjs';

const DWMT = join(ROOT, 'scripts', 'dwmt.mjs');
const DRIVE = () => process.env.DWMT_DRIVE || join(ROOT, 'scripts', 'drive.mjs');
export const SUP_DEFAULTS = {
  enabled: true, intervalSec: 30, stallGraceMin: 5, hangMaxMin: 240, stallRestarts: 1, limitMarginMin: 2, limitRetryMin: 60,
  // Recenzja S3: autostart domyślnie wyłączony do S4 (decyzja lidera); czuwanie tylko, gdy pętla naprawdę potrzebuje maszyny.
  phonePush: true, pushModel: 'haiku', keepAwake: true, autostart: false, typicalCostM: 15, judgement: false, infraRetryMin: 5,
};
// Awaria środowiska, nie sprintu (zgłoszenie z 2026-10-15): moduł dwmt się nie ładuje (aktualizacja albo edycja pluginu
// w trakcie, zepsuta instalacja) albo brak miejsca na dysku. Wstrzymuje całe zlecenie zamiast zatrzymywać pozycje po kolei.
export const INFRA = /SyntaxError|ERR_MODULE_NOT_FOUND|does not provide an export named|Cannot find module|ENOSPC|no space left on device/i;
const BUSY = ['starting', 'running', 'waiting-user', 'hold', 'limit', 'merge-wait', 'planned'];
const mtime = (f) => { try { return statSync(f).mtimeMs; } catch { return 0; } };
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const iso = (t) => new Date(t).toISOString();
const r2 = (x) => Math.round(x * 100) / 100;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
export const supConfig = (cfg) => ({ ...SUP_DEFAULTS, ...(cfg.supervisor ?? {}) });

// ---------- stan (plik + blokada) ----------

const P = (main) => {
  const d = supDir(main);
  return { dir: d, state: supFile(main), log: join(d, 'log.md'), order: join(d, 'order.md'), work: join(d, 'work.md'), report: join(d, 'report.md'), pending: join(d, 'pending.md'), input: join(d, 'input'), status: join(d, 'status'), lock: join(d, 'state.lock') };
};

export function newSup() {
  return {
    schema: 'dwmt/supervisor@1', created: new Date().toISOString(), closed: false, held: false, finished: false, presence: 'here', budgetM: null, budgetAck: false,
    nightLimit: null, night: { count: 0, since: new Date().toISOString() }, eventsOffset: null, seqs: { status: {}, uat: {} }, items: [], pending: [], nextP: 1,
    notified: [], notifyQueue: [], pushSessions: [],
  };
}

// Blokada stanu (komendy i pętla to różne procesy): `state.lock` wyłączny (`wx`, przejęcie po martwym właścicielu).
let depth = 0;
export function withState(main, fn, { create = false, timeoutMs = 300e3 } = {}) {
  const p = P(main);
  if (!create && !existsSync(p.state)) return fn(null);
  mkdirSync(p.dir, { recursive: true });
  if (!depth) {
    const t0 = Date.now();
    for (;;) {
      if (acquireLockFile(p.lock).ok) break;
      if (Date.now() - t0 > timeoutMs) throw new Error(`stan supervisora zajęty (${fwd(p.lock)})`);
      sleepSync(200);
    }
  }
  depth++;
  try {
    const sup = readSup(main) ?? newSup();
    const out = fn(sup);
    saveSup(main, sup);
    return out;
  } finally {
    depth--;
    if (!depth && readLockFile(p.lock)?.pid === process.pid) rmSync(p.lock, { force: true });
  }
}

function saveSup(main, sup) {
  const p = P(main);
  sup.updated = new Date().toISOString();
  writeFileAtomic(p.state, `${JSON.stringify(sup, null, 2)}\n`);
  writeFileAtomic(p.work, renderWork(sup));
  writeFileAtomic(p.pending, renderPending(sup));
}

// Decyzja z regułą i powodem: `log.md` i zdarzenie `supervisor` (§4.2 pkt 4).
function decide(main, it, rule, text, extra = {}) {
  const line = `- ${new Date().toISOString()} ${it?.id ?? '-'} [${rule}] ${text}`;
  try { appendFileSync(P(main).log, `${line}\n`); } catch { /* katalog w tworzeniu */ }
  emit({ type: 'supervisor', project: main, run: it?.run ?? null, detail: { item: it?.id ?? null, rule, text, ...extra } });
  return line;
}

// ---------- pomocniki pozycji ----------

const itemOf = (sup, id) => sup.items.find((x) => x.id === id);
const statusOf = (main, id) => { try { return JSON.parse(read(join(P(main).status, `${id}.json`))); } catch { return null; } };
const uatOf = (main, id) => { try { return JSON.parse(read(join(P(main).status, `${id}.uat.json`))); } catch { return null; } };
const busy = (it) => BUSY.includes(it.state);
const inFinish = (it) => it.status?.step === 'finish' || it.state === 'merge-wait';
// Etap planowania (R2): bez kodu, czyli bez `task-start` tego przebiegu w dzienniku. Niezwolniony start „tylko planowanie”
// też (zgłoszenie z 2026-10-16, pkt 8): po planie stoi na `drive.hold` ze statusem `running`/`implement`.
const planningStage = (it) => !it.taskStarted && (it.planOnly || it.state === 'planned' || it.status?.state === 'planning' || it.status?.state === 'planned' || it.status?.stage === 'planning');
// K7 (D-6): tor pozycji = miejsce pracy (gałąź docelowa) albo główne drzewo (''); raz na tick na pozycję.
const workplaceIn = (ctx, it) => {
  ctx.wps ??= new Map();
  if (!ctx.wps.has(it.id)) { let wp = null; try { wp = workplaceOf(ctx.main, it.id); } catch { /* bez warstwy produktowej */ } ctx.wps.set(it.id, wp); }
  return ctx.wps.get(it.id);
};
// Miejsce pracy decydujące o starcie (D-7): aktywne albo usunięte, które wciąż trzyma otwarty sprint; tor bez zmian.
const startWpIn = (ctx, it) => {
  ctx.swps ??= new Map();
  if (!ctx.swps.has(it.id)) { let wp = null; try { wp = startWorkplaceOf(ctx.main, it.id); } catch { /* bez warstwy produktowej */ } ctx.swps.set(it.id, wp); }
  return ctx.swps.get(it.id);
};
const laneOf = (ctx, it) => workplaceIn(ctx, it)?.name ?? '';
const sameLane = (ctx, a, b) => laneOf(ctx, a) === laneOf(ctx, b);
const uniqueId = (sup, base) => { let id = base; for (let n = 2; itemOf(sup, id); n++) id = `${base}-${n}`; return id; };

// Zależność scalona: ta sama funkcja co w sterowniku (`lib/deps.mjs`; zgłoszenie z 2026-10-16, pkt 12). Zależność spoza
// zlecenia `order` przyjmuje tylko scaloną (recenzja S3 (8): `outsideDeps`).
const depDone = (main, sup, id) => depMerged(main, id, { sup }).merged;
// Ślad stanu zależności: start „zależności scalone” i kolejne `planned` porównują go, zanim pętla ruszy sterownik znowu.
const depSig = (ctx, ids) => JSON.stringify(asList(ids).map((d) => { const r = depMerged(ctx.main, d, { sup: ctx.sup }); return [d, r.via, r.state, mtime(join(P(ctx.main).status, `${d}.json`))]; }));

// Obszary sprintu do R2: zakres i pliki wspólne z pliku statusu (dane architekta). Brak danych = wątpliwość = przecięcie.
const norm = (g) => fwd(g).replace(/^\.\//, '').replace(/(\/\*\*|\/\*|\*\*|\*)+$/, '').replace(/\/+$/, '');
export function areasIntersect(a, b, hot = []) {
  const A = [...asList(a.scope), ...asList(a.shared)].map(norm);
  const B = [...asList(b.scope), ...asList(b.shared)].map(norm);
  if (!A.length || !B.length) return true;
  const hit = (x, y) => x === y || !x || !y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
  if (A.some((x) => B.some((y) => hit(x, y)))) return true;
  const H = asList(hot).map(norm);
  return H.some((h) => asList(a.shared).map(norm).some((x) => hit(x, h))) && H.some((h) => asList(b.shared).map(norm).some((x) => hit(x, h)));
}

// Godziny ciszy z `machine.json` (`"22:00-07:00"`, `["22:00","07:00"]` albo `{from, to}`).
export function inQuiet(q, now = Date.now()) {
  if (!q) return false;
  const [from, to] = typeof q === 'string' ? q.split('-') : Array.isArray(q) ? q : [q.from, q.to];
  const m = (s) => { const [h, mi] = String(s ?? '').split(':').map(Number); return Number.isFinite(h) ? h * 60 + (mi || 0) : null; };
  const a = m(from);
  const b = m(to);
  if (a == null || b == null) return false;
  const d = new Date(now);
  const t = d.getHours() * 60 + d.getMinutes();
  return a <= b ? t >= a && t < b : t >= a || t < b;
}

// ---------- operacje z efektami (podmieniane w testach) ----------

// Batch F-4: `DWMT_SUPERVISED` tells its drivers and launch watchers to leave session-failure toasts to the supervisor.
export const childEnv = () => { const e = { ...process.env, CLAUDE_CODE_DISABLE_NOTIFICATION_PRESENCE_CHECK: '1', DWMT_SUPERVISED: '1' }; delete e.CLAUDE_CODE_SESSION_ID; return e; };
const lastJson = (s) => { try { return JSON.parse(String(s).trim().split(/\r?\n/).pop()); } catch { return null; } };
function dwmtCall(cwd, args) {
  const r = spawnSync(process.execPath, [DWMT, ...args], { cwd, encoding: 'utf8', env: childEnv(), windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { j = lastJson(r.stdout); }
  return j ?? { ok: false, error: (r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 300) };
}
const claudeBin = (args) => (process.env.DWMT_CLAUDE ? [process.execPath, [process.env.DWMT_CLAUDE, ...args]] : ['claude', args]);

export const realOps = {
  alive: (pid, start) => processAlive(pid, start),
  // Przygotowanie bez modelu (§4.5 pkt 1): preflight i `init --sprint --worktree` (worktree na sprint, główne drzewo bez zmian).
  // Recenzja S3 (4): identyfikator przebiegu z preflight zapisuje `reserve` przed `init`; powtórzenie po śmierci pętli idzie
  // na tym samym przebiegu (`init --worktree` na istniejącym worktree przebiegu go używa), bez drugiego worktree.
  prepare(main, it, mode, reserve = () => {}) {
    let run = it.run;
    let warnings = [];
    if (!run) {
      const pf = dwmtCall(main, ['preflight', '--slug', it.id, '--worktree']);
      if (!pf?.run) return { ok: false, error: `preflight: ${pf?.error ?? 'bez wyniku'}` };
      if (pf.ok === false) return { ok: false, error: `preflight: ${asList(pf.blockers).join('; ')}` };
      run = pf.run;
      warnings = asList(pf.warnings);
      reserve(run);
    }
    const r = dwmtCall(main, ['init', '--run', run, '--sprint', it.id, '--mode', mode, ...(it.estimate ? ['--estimate', it.estimate.join(',')] : []), '--worktree']);
    if (!r?.ok) return { ok: false, error: `init: ${r?.error ?? asList(r?.errors).join('; ') ?? 'bez wyniku'}` };
    return { ok: true, run, worktree: fwd(r.worktree ?? main), root: fwd(r.dir), warnings: [...warnings, ...asList(r.warnings)], ...(r.notice ? { notice: r.notice } : {}) };
  },
  startDriver(it) {
    const r = spawnSync(process.execPath, [DRIVE(), it.run, '--detach'], { cwd: it.worktree, encoding: 'utf8', env: childEnv(), windowsHide: true });
    return lastJson(r.stdout) ?? { ok: false, error: (r.stderr || `exit ${r.status}`).trim().slice(0, 300) };
  },
  // Sesja `claude --bg` z `/dwmt:execute <run>` (sesja zatrzymania pod sterownikiem albo orkiestrator bez sterownika).
  launch(main, it) { return dwmtCall(main, ['launch', it.run]); },
  stopSession(id) {
    const [bin, argv] = claudeBin(['stop', id]);
    return spawnSync(bin, argv, { encoding: 'utf8', timeout: 30e3, windowsHide: true }).status === 0;
  },
  // Push na telefon (§4.8, `supervisor.phonePush`): krótka sesja Haiku z jednym PushNotification (ok. 0,01–0,02 mln).
  // Recenzja S3 (14): sesja chuda jak `launch.lean`: tylko ustawienia użytkownika (Remote Control, push), bez ustawień
  // projektu (hooki, uprawnienia), bez MCP i z wyłączonymi wtyczkami (`leanPlugins`).
  push(main, text, sc) {
    const prompt = `Load the PushNotification tool (ToolSearch select:PushNotification), send it once with exactly this message, then stop: ${text}`;
    const off = leanPlugins(main);
    const settings = { worktree: { bgIsolation: 'none' }, env: { CLAUDE_CODE_DISABLE_NOTIFICATION_PRESENCE_CHECK: '1' }, ...(Object.keys(off).length ? { enabledPlugins: off } : {}) };
    const args = ['--bg', '-n', 'dwmt push', '--model', sc.pushModel, '--effort', 'low', '--strict-mcp-config', '--setting-sources', 'user', prompt, '--settings', JSON.stringify(settings)];
    const [bin, argv] = claudeBin(args);
    const r = spawnSync(bin, argv, { cwd: main, encoding: 'utf8', timeout: 120e3, windowsHide: true });
    const out = [r.stdout, r.stderr].filter(Boolean).join('\n').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    return /backgrounded\s*·\s*(\S+)\s*·/.exec(out)?.[1] ?? null;
  },
  notify: (text) => platformNotify(text),
  // Czy dwmt się ładuje (awaria środowiska): import modułów wejściowych w osobnym procesie, bez uruchamiania komend.
  probe() {
    const files = [DWMT, DRIVE(), join(ROOT, 'scripts', 'supervise.mjs')].map((f) => pathToFileURL(f).href);
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `for (const f of ${JSON.stringify(files)}) await import(f);`], { encoding: 'utf8', env: childEnv(), windowsHide: true, timeout: 60e3 });
    return r.status === 0 ? { ok: true } : { ok: false, error: (r.stderr || `exit ${r.status}`).trim().slice(0, 300) };
  },
  // Czy przyczyna `merge-wait` ustąpiła (§10.2): to samo sprawdzenie co w `finish`, z tym samym drzewem docelowym
  // (worktree z gałęzią docelową, bez niego reguła drzewa domowego; T-2/F-4).
  mergeCleared(main, it) {
    try {
      const run = JSON.parse(read(join(it.root, 'run.json')));
      return !mergeWaitReason(it.worktree, run, worktreeFor(it.worktree, run.target));
    } catch { return false; }
  },
  quiet: (now) => inQuiet(machineConfig().quietHours, now),
};

// ---------- pętla: decyzje pod blokadą stanu, efekty poza nią (tick) ----------

// Recenzja S3 (4, 12): tick ma fazy. Pod blokadą `state.lock` odczyt i decyzje; decyzja z efektem zapisuje zamiar w pozycji
// (`it.act`, stan `starting`) i trafia na listę efektów. Efekty (przygotowanie worktree, start sterownika, sesja,
// powiadomienie, push, `claude stop`) idą bez blokady, więc komendy PO nie czekają na `init --worktree` ani na sesję push.
// Wyniki zapisuje krótka faza pod blokadą na świeżym stanie (komenda z czasu efektu nie ginie); może dodać następny efekt
// (po przygotowaniu start sterownika). Zamiar zapisany przed efektem czyni tick odpornym na śmierć pętli w środku: następny
// tick powtarza efekt tej samej pozycji (ten sam przebieg; `drive.mjs --detach` przy żywym sterowniku zwraca `running`),
// zamiast przygotować pozycję drugi raz. `ops` (testy): podmiana efektów; `now`: czas odczytu.
// Wynik: {exit, reason, working, active, decisions, unregister}.
const ACT_ROUNDS = 4;
export function tick(main, { ops = realOps, now = Date.now(), cfg = loadConfig(main) } = {}) {
  const decisions = [];
  const sc = supConfig(cfg);
  const mk = (sup) => ({ main, sup, cfg, sc, ops, now, decisions, mcfg: machineConfig(), acts: [] });
  let acts = withState(main, (sup) => {
    if (!sup) return null;
    const ctx = mk(sup);
    readNewEvents(ctx);
    redoActs(ctx);
    infraCheck(ctx);
    refreshDeps(ctx);
    for (const it of sup.items.filter((x) => x.run && !x.act && !['done', 'queued'].includes(x.state))) observe(ctx, it);
    for (const it of sup.items.filter((x) => x.state === 'done')) observeUat(ctx, it);
    manage(ctx);
    startQueued(ctx);
    expirePending(ctx);
    housekeeping(ctx);
    scopeCheck(ctx);
    return ctx.acts;
  });
  if (!acts) return { exit: true, reason: 'no order', working: false, decisions: [] };
  for (let round = 0; round < ACT_ROUNDS && acts.length; round++) {
    const results = acts.map((a) => ({ ...a, out: perform(main, a, ops, sc) }));
    acts = withState(main, (sup) => { const ctx = mk(sup); for (const r of results) record(ctx, r); return ctx.acts; });
  }
  return withState(main, (sup) => {
    const ctx = mk(sup);
    // Efekty ponad limit rund: powiadomienia do kolejki (następny tick), zamiary pozycji zostają w `it.act` (redoActs).
    for (const a of acts.filter((x) => x.kind === 'notify')) sup.notifyQueue.push({ text: a.text, push: a.push, ...(a.toast === false ? { toast: false } : {}) });
    writeReport(ctx);
    return outcome(ctx);
  });
}

// Koniec zakresu (§4.2): każda pozycja `done` (albo `dropped`), bez czekającego UAT i otwartego sprintu poprawek.
function scopeCheck(ctx) {
  const { sup, main } = ctx;
  const allDone = sup.items.length && sup.items.every((x) => x.state === 'done' || x.state === 'dropped');
  // Zgłoszenie UAT po końcu zakresu (np. `late` ze sprintem poprawek) otwiera zlecenie na nowo.
  if (!allDone && sup.finished) sup.finished = false;
  if (allDone && !sup.items.some((x) => uatPending(x) || x.fixOpen) && !sup.finished) {
    sup.finished = true;
    ctx.decisions.push(decide(main, null, 'scope', 'zakres zlecenia wykonany: koniec pętli'));
    say(ctx, 'scope-done', 'dwmt: zakres zlecenia wykonany (supervise report).', { both: true });
  }
}

// Wynik ticku na stanie po efektach. Recenzja S3 (3): `working` (czuwanie maszyny) także przy czekaniu na odnowienie limitu
// (wznowienie o `resetsAt`), wznowieniu w kolejce i efekcie w toku. (6): pętla nie kończy się z niedostarczonym
// powiadomieniem (kolejka godzin ciszy) ani z żywą sesją push (zamyka ją `housekeeping` po 3 min).
function outcome(ctx) {
  const { sup } = ctx;
  const working = sup.items.some((x) => x.act || ['starting', 'running', 'resume', 'limit'].includes(x.state));
  const active = sup.items.filter((x) => busy(x) && x.state !== 'planned').length;
  const alive = sup.items.some((x) => x.act || ['starting', 'running'].includes(x.state));
  let exit = false;
  let reason = null;
  if ((sup.closed || sup.held) && !alive) { exit = true; reason = sup.closed ? 'order closed' : 'order held'; }
  if (sup.finished) { exit = true; reason = 'scope done'; }
  const unregister = exit && (sup.closed || sup.finished);
  if (exit && (sup.notifyQueue.length || sup.pushSessions.length)) { exit = false; reason = `notifications pending (${reason})`; }
  return { exit, reason, working, active, decisions: ctx.decisions, unregister: exit && unregister };
}

// Zamiar efektu pozycji: zapisany w `it.act` (numer `n`) przed wykonaniem; wynik pasuje tylko do tego samego numeru.
const snap = (it) => JSON.parse(JSON.stringify(it));
function queueAct(ctx, it, kind, extra = {}) {
  ctx.sup.nextAct = (ctx.sup.nextAct ?? 0) + 1;
  it.act = { kind, n: ctx.sup.nextAct, at: iso(ctx.now), ...extra };
  ctx.acts.push({ kind, id: it.id, n: it.act.n, item: snap(it), ...extra });
}
// Zamiar bez wyniku z poprzedniego ticku (pętla zginęła w trakcie efektu): ten sam efekt jeszcze raz, z wpisem w log.md.
function redoActs(ctx) {
  for (const it of ctx.sup.items.filter((x) => x.act)) {
    const { kind, n, at, ...extra } = it.act;
    ctx.decisions.push(decide(ctx.main, it, 'act', `efekt ${kind} z ${at} bez wyniku (pętla przerwana): powtórzenie${kind === 'launch' ? ' (sesja mogła już wystartować: claude agents)' : ''}`));
    ctx.acts.push({ kind, id: it.id, n, item: snap(it), ...extra });
  }
}

// Efekt bez blokady stanu; wyjątek = wynik nieudany (pozycja zatrzymana z powodem przy zapisie), pętla żyje dalej.
function perform(main, a, ops, sc) {
  try {
    switch (a.kind) {
      case 'prepare': return ops.prepare(main, a.item, a.mode, (run) => withState(main, (sup) => { const x = sup && itemOf(sup, a.id); if (x?.act?.n === a.n && !x.run) x.run = run; }));
      case 'driver': return ops.startDriver(a.item);
      case 'launch': return ops.launch(main, a.item);
      case 'notify': if (a.toast !== false) ops.notify(a.text); return { push: a.push ? ops.push(main, a.text, sc) : null };
      case 'stop-session': return { ok: ops.stopSession(a.sid) };
      case 'probe': return ops.probe(main);
      default: return { ok: false, error: `nieznany efekt ${a.kind}` };
    }
  } catch (e) { return { ok: false, error: `${a.kind}: ${e.message}` }; }
}

// Zapis wyniku efektu na świeżym stanie.
function record(ctx, r) {
  const { sup, main } = ctx;
  if (r.kind === 'notify') { if (r.out?.push) sup.pushSessions.push({ id: r.out.push, at: iso(ctx.now) }); return undefined; }
  if (r.kind === 'stop-session') { if (!r.out?.ok) ctx.decisions.push(decide(main, r.id ? itemOf(sup, r.id) ?? null : null, 'cleanup', `claude stop ${r.sid}: bez potwierdzenia`)); return undefined; }
  if (r.kind === 'probe') return infraProbed(ctx, r.out);
  const it = itemOf(sup, r.id);
  if (!it || it.act?.n !== r.n) { ctx.decisions.push(decide(main, it ?? { id: r.id }, 'act', `wynik ${r.kind} bez zamiaru w pozycji (pominięty): ${JSON.stringify(r.out ?? {}).slice(0, 160)}`)); return undefined; }
  const act = it.act;
  delete it.act;
  if (r.kind === 'prepare') return prepared(ctx, it, r.out);
  if (r.kind === 'driver') return driverStarted(ctx, it, r.out, act.why);
  return launched(ctx, it, r.out, act);
}

const uatPending = (it) => it.state === 'done' && (it.uat === 'pending' || it.uatGate) && !it.uatDone;

// ---------- awaria środowiska (INFRA) ----------

// Błąd środowiska w wyniku efektu albo zatrzymaniu sterownika: pozycja wraca do stanu sprzed efektu (`back`: `queued` przed
// przygotowaniem, `resume` po nim), zlecenie czeka (`sup.infra`) z jednym powiadomieniem na rodzaj błędu, a pętla co
// `infraRetryMin` sprawdza ładowanie dwmt i sama wznawia. false = zwykły błąd pozycji.
const firstLine = (t) => String(t ?? '').split(/\r?\n/).map((l) => l.trim()).find((l) => INFRA.test(l)) ?? String(t ?? '').split(/\r?\n/)[0];
function infraFail(ctx, it, text, back) {
  if (!INFRA.test(String(text ?? ''))) return false;
  const { sup } = ctx;
  const line = firstLine(text).slice(0, 160);
  // Plik z błędem (`file:///…/x.mjs:17` w pierwszej linii stderr) pomaga znaleźć przyczynę.
  const where = /file:\/\/\/\S+?:\d+/.exec(String(text))?.[0]?.replace(/^file:\/\/\//, '') ?? null;
  it.state = back;
  it.reason = null;
  ctx.decisions.push(decide(ctx.main, it, 'infra', `błąd środowiska, pozycja wraca do ${back}: ${line}`));
  if (!sup.infra) {
    sup.infra = { at: iso(ctx.now), text: line, where, next: iso(ctx.now + ctx.sc.infraRetryMin * 60e3), probes: 0 };
    ctx.decisions.push(decide(ctx.main, null, 'infra', `zlecenie czeka na środowisko: ${line}${where ? ` (${where})` : ''}`));
    say(ctx, `infra:${line}`, `dwmt: narzędzie albo środowisko nie działa (${line}${where ? `, ${where}` : ''}); zlecenie czeka, sprawdzam co ${ctx.sc.infraRetryMin} min i wznowię samo. Potrzeba: nic, chyba że trwa to długo (supervise status).`, { both: true, push: sup.presence === 'away' });
  }
  return true;
}
function infraCheck(ctx) {
  const { sup } = ctx;
  if (!sup.infra || ctx.now < Date.parse(sup.infra.next)) return;
  // Sprawdzenie bez wyniku (pętla zginęła w trakcie): po 10 min następne.
  if (sup.infra.probing && ctx.now - Date.parse(sup.infra.probing) < 10 * 60e3) return;
  sup.infra.probing = iso(ctx.now);
  ctx.acts.push({ kind: 'probe' });
}
function infraProbed(ctx, out) {
  const { sup } = ctx;
  if (!sup.infra) return undefined;
  sup.infra.probing = null;
  sup.infra.probes++;
  if (!out?.ok) {
    sup.infra.next = iso(ctx.now + ctx.sc.infraRetryMin * 60e3);
    // Inny błąd ładowania niż na starcie (np. edycja przesunęła się do innego pliku): tylko wpis, bez powiadomienia.
    if (out?.error && INFRA.test(out.error)) sup.infra.text = firstLine(out.error).slice(0, 160);
    ctx.decisions.push(decide(ctx.main, null, 'infra', `sprawdzenie ${sup.infra.probes}: nadal błąd (${String(out?.error ?? '-').split(/\r?\n/)[0].slice(0, 160)}); następne o ${sup.infra.next}`));
    return undefined;
  }
  const was = sup.infra;
  delete sup.infra;
  ctx.decisions.push(decide(ctx.main, null, 'infra', `środowisko działa (po ${was.probes} sprawdzeniach): zlecenie idzie dalej`));
  say(ctx, `infra-ok:${was.text}`, 'dwmt: narzędzie znowu działa; zlecenie idzie dalej. Potrzeba: nic.', { both: true });
  return undefined;
}

// Pytanie zarządcze R1/R5/stall, którego przyczyna ustąpiła (np. odpowiedź na pytanie sprintu, zatrzymanie czekającej
// pozycji, wznowienie): zamknięte jako `obsolete` z wpisem, znika z `pending.md` (zgłoszenie z 2026-10-15: P-5…P-7).
function expirePending(ctx) {
  const { sup } = ctx;
  for (const p of sup.pending.filter((x) => !x.answer)) {
    const it = itemOf(sup, p.item);
    let live = true;
    if (['R1', 'R5'].includes(p.kind)) {
      const b = it && ['queued', 'planned'].includes(it.state) ? blockers(ctx, it) : null;
      live = !!b && b.rule === p.kind && b.ask === p.about;
    } else if (p.kind === 'stall') live = it?.state === 'stopped';
    if (live) continue;
    p.answer = 'obsolete';
    p.answeredAt = iso(ctx.now);
    ctx.decisions.push(decide(ctx.main, it ?? null, p.kind, `pytanie ${p.id} nieaktualne: przyczyna ustąpiła`));
  }
}

// Zdarzenia od przesunięcia (§4.2 pkt 1): koszty, `task-start` (licznik nocy, etap R2), zatrzymania do raportu.
function readNewEvents(ctx) {
  const { sup, main } = ctx;
  // Pierwszy odczyt zlecenia: od bieżącego końca dziennika (zdarzenia sprzed zlecenia nie dotyczą jego pozycji).
  if (sup.eventsOffset == null) { sup.eventsOffset = (() => { try { return statSync(eventsFile()).size; } catch { return 0; } })(); sup.eventsId = eventsFileId(); }
  // Recenzja S3 (10): przesunięcie z tożsamością pliku; po rotacji reszta starego pliku z `.1`, potem nowy od początku.
  const r = readEventsFrom(sup.eventsOffset, { id: sup.eventsId ?? null });
  sup.eventsOffset = r.offset;
  sup.eventsId = r.id;
  for (const e of r.events) {
    if (!e.project?.root || !samePath(e.project.root, main)) continue;
    const it = sup.items.find((x) => x.run && x.run === e.run);
    if (!it) continue;
    if (e.type === 'task-start') {
      it.taskStarted = true;
      if (sup.presence === 'away') sup.night.count++;
    } else if (e.type === 'task-end' && Number.isFinite(Number(e.costM))) it.taskCostM = r2((it.taskCostM ?? 0) + Number(e.costM));
    else if (e.type === 'sprint-end' && Number.isFinite(Number(e.costM))) it.costM = Number(e.costM);
    else if (e.type === 'drive-stop') it.stops = [...asList(it.stops), { at: e.ts, status: e.detail?.status, cause: e.detail?.cause ?? null, reason: String(e.detail?.reason ?? '').slice(0, 160) }].slice(-5);
    // W-3 (przegląd 2026-10-09): koszt ponad górną cenę: jedno powiadomienie (też na telefon), sprint idzie dalej.
    else if (e.type === 'price-alert') {
      const d = e.detail ?? {};
      say(ctx, `price:${it.id}`, `dwmt ${it.id}: koszt ${e.costM} mln przekroczył górną cenę ${d.upperM} mln${d.forecastM != null ? `, prognoza ok. ${d.forecastM} mln` : ''}. Potrzeba: nic, sprint idzie dalej (supervise hold ${it.id}, żeby go wstrzymać).`, { both: true, push: true });
    }
  }
}

const statusFields = (st) => st && { state: st.state, at: st.at, stage: st.stage ?? null, step: st.step ?? null, task: st.task ?? null, tasks: st.tasks ?? null, scope: st.scope ?? [], shared: st.shared ?? [], affects: st.affects ?? null, questions: asList(st.questions).slice(0, 3), result: st.result ?? null, cost: st.cost ?? null, uat: st.uat ?? null, reason: st.reason ?? null, limit: st.limit ?? null, waitingFor: st.waitingFor ?? null };

// Stan pozycji z pliku statusu, życia sterownika (albo sesji) i zdarzeń w pliku statusu (`two-sprints`).
function observe(ctx, it) {
  const st = statusOf(ctx.main, it.id);
  // Obszary zostają z wcześniejszego statusu, gdy nowy ich nie ma (R2).
  if (st) it.status = { ...statusFields(st), scope: st.scope ?? it.status?.scope ?? [], shared: st.shared ?? it.status?.shared ?? [] };
  twoSprints(ctx, it, st);
  if (it.path === 'session') return observeSession(ctx, it, st);
  if (!it.root || it.state === 'dropped') return;
  const lock = readLockFile(join(it.root, 'drive.lock'));
  const alive = lock && ctx.ops.alive(lock.pid, lock.pidStart ?? null);
  const mem = readDriveMem(it.root) ?? {};
  const started = Date.parse(mem.startedAt ?? '') || 0;
  if (alive) {
    // Nowy sterownik żyje: powód dawnego zatrzymania znika (zgłoszenie z 2026-10-16, pkt 9).
    if (it.state !== 'running') { it.state = 'running'; it.wait = null; it.reason = null; }
    it.driverPid = lock.pid;
    return hangCheck(ctx, it);
  }
  const stop = mem.stopped && started && Date.parse(mem.stopped.at) >= started ? mem.stopped : null;
  if (stop) { if (it.handledStop !== stop.at) handleStop(ctx, it, stop, st); return; }
  if (!['starting', 'running'].includes(it.state)) return;
  // Sterownik, który po naszym starcie jeszcze nie założył blokady: start w toku (do 60 s), potem `start-failed`.
  if (!started || started < Date.parse(it.driveAt ?? 0)) {
    if (ctx.now - Date.parse(it.driveAt ?? 0) > 60e3) stopItem(ctx, it, 'start-failed', 'sterownik nie wystartował');
    return;
  }
  // Śmierć sterownika bez `drive-stop` (§4.7): przestój, gdy przez `stallGraceMin` nic nie przyrasta.
  let ids = [];
  try { ids = JSON.parse(read(join(it.root, 'run.json'))).session_ids ?? []; } catch { /* run.json w zapisie */ }
  const growth = Math.max(mtime(join(it.root, 'drive.log')), mtime(join(it.root, 'drive.json')), ...transcriptFiles(ids).map(mtime));
  if ((ctx.now - growth) / 60e3 < ctx.sc.stallGraceMin) return;
  stall(ctx, it, 'driver-dead', `sterownik (pid ${mem.pid ?? '?'}) przestał działać bez zdarzenia końca`);
}

// Zawieszenie (§4.7): proces żyje, ale nic nie przyrasta przez `hangMaxMin`; jedno powiadomienie, bez zabijania.
function hangCheck(ctx, it) {
  let ids = [];
  try { ids = JSON.parse(read(join(it.root, 'run.json'))).session_ids ?? []; } catch { /* zapis */ }
  const growth = Math.max(mtime(join(it.root, 'drive.log')), mtime(join(it.root, 'drive.json')), mtime(join(it.root, 'active.json')), ...transcriptFiles(ids).map(mtime));
  if (growth && (ctx.now - growth) / 60e3 > ctx.sc.hangMaxMin) {
    say(ctx, `hang:${it.id}:${Math.floor(growth)}`, `dwmt ${it.id}: sterownik żyje, ale od ${Math.round((ctx.now - growth) / 60e3)} min nic nie przyrasta (podejrzenie zawieszenia). Potrzeba: Twoja decyzja (dwmt stop ${it.run} albo czekać).`, { both: true });
  }
}

function observeSession(ctx, it, st) {
  if (!st || ['stopped', 'dropped', 'limit'].includes(it.state)) return;
  const at = st.at;
  // Status sprzed naszego ostatniego startu sesji: nowa sesja jeszcze nie zgłosiła stanu (bez ponownej decyzji).
  const fresh = Date.parse(at) >= Date.parse(it.sessionAt ?? 0);
  if (fresh && st.limit?.resetsAt) return setLimit(ctx, it, st.limit.resetsAt);
  switch (fresh ? st.state : 'running') {
    case 'done': return itemDone(ctx, it, st);
    case 'merge-wait': if (it.state !== 'merge-wait') { it.state = 'merge-wait'; say(ctx, `mw:${it.id}:${at}`, `dwmt ${it.id}: suita zielona, ale squash czeka (${st.reason}). Potrzeba: ${st.reason === 'uat' ? 'koniec Twojego UAT' : 'czyste główne drzewo na gałęzi docelowej'}.`, { both: true }); } return undefined;
    case 'planned': it.state = 'planned'; return undefined;
    case 'stopped': {
      // K5 D-8: the launch watcher's stop (`<cause>: <error>`) keeps its session-failure cause and its own notification.
      const c = SESSION_FAILURES.find((x) => String(st.reason ?? '').startsWith(`${x}: `));
      return c ? stopItem(ctx, it, c, String(st.reason).slice(c.length + 2), { notified: !!st.notified }) : stopItem(ctx, it, 'stopped', st.reason ?? 'zatrzymany');
    }
    case 'waiting-user':
      if (it.state !== 'waiting-user' || it.waitAt !== at) { it.state = 'waiting-user'; it.waitAt = at; waitingNotice(ctx, it, st); }
      return undefined;
    case 'handoff':
      if (it.handoffAt === at) return undefined;
      if (ctx.sup.closed || ctx.sup.held || it.held || nightReached(ctx)) { it.state = 'hold'; return undefined; }
      it.handoffAt = at;
      return launchSession(ctx, it, 'handoff', 'nowa sesja po zadaniu (§6.4)');
    default: {
      // planning / running: życie według plików i transkryptów (v2.10 `assess`).
      if (!['starting', 'running'].includes(it.state)) it.state = 'running';
      let run;
      try { run = JSON.parse(read(join(it.root, 'run.json'))); } catch { return undefined; }
      const a = assess({ root: it.root, run, watch: ctx.cfg.watch, now: ctx.now, aliveFn: ctx.ops.alive });
      if (a.state === 'stall' && ctx.now - Date.parse(it.sessionAt ?? 0) > ctx.sc.stallGraceMin * 60e3) stall(ctx, it, 'session', `krok ${a.phase} stoi ${a.quietMin} min bez żywego procesu ani transkryptu`);
      return undefined;
    }
  }
}

// Zdarzenia `two-sprints` z pliku statusu, każde raz (§6.5; D4: `size` → drugi sprint za pierwszym, `decision` → PO).
function twoSprints(ctx, it, st) {
  const seen = ctx.sup.seqs.status[it.id] ?? 0;
  for (const ev of asList(st?.events).filter((e) => (e.seq ?? 0) > seen)) {
    ctx.sup.seqs.status[it.id] = Math.max(ctx.sup.seqs.status[it.id] ?? 0, ev.seq ?? 0);
    if (ev.type !== 'two-sprints') continue;
    const text = String(ev.text ?? '');
    if (/^\s*decision\b/i.test(text)) { ctx.decisions.push(decide(ctx.main, it, '§6.5', `to dwa sprinty (decision): do wejścia PO, nie na listę prac: ${text.slice(0, 120)}`)); continue; }
    const id = uniqueId(ctx.sup, `${it.id}-2`);
    const second = { id, src: 'second', after: [it.id], uatGate: false, mode: it.mode, estimate: null, first: ev.plan ?? null, state: 'queued' };
    ctx.sup.items.splice(ctx.sup.items.indexOf(it) + 1, 0, second);
    writeInput(ctx.main, ctx.sup, second, `${text.replace(/^\s*size\s*:?\s*/i, '')}\n\nThis is the second of two sprints; the first: ${it.id}. First plan: ${ev.plan ?? '-'}.`);
    ctx.decisions.push(decide(ctx.main, it, '§6.5', `to dwa sprinty (size): ${id} na liście prac zaraz za ${it.id}`));
    say(ctx, `second:${id}`, `dwmt ${it.id}: architekt podzielił sprint na dwa; ${id} idzie za nim.`, { here: true });
  }
}

// Wynik UAT (`status/<id>.uat.json`, każde zdarzenie raz według `seq`): bramka R5, sprint poprawek (§10.6).
function observeUat(ctx, it) {
  const u = uatOf(ctx.main, it.id);
  const seen = ctx.sup.seqs.uat[it.id] ?? 0;
  if (it.fixItem) it.fixOpen = itemOf(ctx.sup, it.fixItem)?.state !== 'done';
  for (const ev of asList(u?.events).filter((e) => (e.seq ?? 0) > seen)) {
    ctx.sup.seqs.uat[it.id] = Math.max(ctx.sup.seqs.uat[it.id] ?? 0, ev.seq ?? 0);
    // Zgłoszenie z 2026-10-16 (pkt 11): plik UAT jest na sprint, a zdarzenie dotyczy przebiegu. UAT poprzedniego
    // przebiegu (pozycja wznowiona, nowy przebieg bez UAT) nie wyzwala poprawek nowego. Przebieg zdarzenia: `run`,
    // w starszych zapisach katalog `uat.md`; bez obu zdarzenie sprzed startu pozycji jest cudze.
    const evRun = ev.run ?? /\/runs\/([^/]+)\/uat\.md$/.exec(fwd(ev.fixSprint?.uat ?? ''))?.[1] ?? null;
    if (it.run && (evRun ? evRun !== it.run : Date.parse(ev.at) < Date.parse(it.startedAt ?? 0))) {
      ctx.decisions.push(decide(ctx.main, it, 'UAT', `wynik UAT innego przebiegu (${evRun ?? ev.at}) pominięty`));
      continue;
    }
    if (ev.type === 'uat') it.uatDone = { seq: ev.seq, at: ev.at, result: ev.result, counts: ev.counts ?? {}, requirementChanges: Number(ev.requirementChanges) || 0 };
    const blocking = (Number(ev.counts?.blocker) || 0) + (Number(ev.counts?.major) || 0);
    ctx.decisions.push(decide(ctx.main, it, 'UAT', `wynik UAT ${ev.type} (${ev.result ?? '-'}), blocker+major ${blocking}, zmiany wymagań ${ev.requirementChanges ?? 0}`));
    const openFix = it.fixItem && itemOf(ctx.sup, it.fixItem)?.state !== 'done';
    if (ev.fixSprint && !openFix && !ctx.sup.closed) {
      const id = uniqueId(ctx.sup, `${it.id}-fix`);
      const fix = { id, src: 'fix', source: it.id, sourceRun: evRun ?? it.run ?? null, after: [], uatGate: false, mode: 'auto', estimate: null, state: 'queued' };
      const firstQueued = ctx.sup.items.findIndex((x) => x.state === 'queued');
      ctx.sup.items.splice(firstQueued < 0 ? ctx.sup.items.length : firstQueued, 0, fix);
      writeInput(ctx.main, ctx.sup, fix, `Fix sprint for ${it.id}: fix the defects recorded in its UAT (${asList(ev.fixSprint.defects).join(', ')}); each fix starts with a test that reproduces the defect.`);
      Object.assign(it, { fixItem: id, fixBlocking: blocking > 0, fixOpen: true });
      ctx.decisions.push(decide(ctx.main, it, '§10.6', `sprint poprawek ${id} przed kolejnymi pozycjami`));
    }
    if (ev.type === 'uat' && it.uatGate && it.uatDone.requirementChanges > 0) {
      for (const d of ctx.sup.items.filter((x) => asList(x.after).includes(it.id) && ['queued', 'planned', 'hold'].includes(x.state))) {
        ask(ctx, d, 'R5', it.id, `UAT ${it.id} przyniósł zmiany wymagań (${it.uatDone.requirementChanges}); startować ${d.id} mimo to?`, 'start|wait');
      }
    }
  }
}

// ---------- kf2: bieżąca roadmapa ----------

// Linie roadmapy głównego drzewa raz na tick (pierwsza blokada): zależności, priorytet startu, zwolnienie planowania.
const linesOf = (ctx) => {
  if (!Object.hasOwn(ctx, 'lines')) ctx.lines = (ctx.ops.roadmapLines ?? roadmapLines)(ctx.main);
  return ctx.lines;
};
const BELOW_READY = ['topic', 'notes', 'todo'];
const followsRoadmap = (it) => !['file', 'fix'].includes(it.src);
const idsOrNone = (xs) => xs.join(', ') || 'brak';
// Stan linii pozycji bez przebiegu cofniętej w planie poniżej `ready` (D-8); null, gdy nie jest cofnięta.
const withdrawnState = (ctx, it) => {
  if (!it || it.root || it.state !== 'queued' || !followsRoadmap(it)) return null;
  const rs = (ctx.ops.roadmapState ?? roadmapState)(ctx.main, it.id);
  return BELOW_READY.includes(rs) ? rs : null;
};
// Powód czekania na zależności: zależność spoza zlecenia (D-5) i pozycja cofnięta w planie nazwane wprost, w kolejce
// i w `planned` (recenzja T-1 F-3, F-6).
const afterWaitText = (ctx, ids) => `czeka na scalenie: ${ids.map((d) => {
  const o = itemOf(ctx.sup, d);
  if (!o) return `${d} (spoza zlecenia)`;
  return withdrawnState(ctx, o) ? `${d} (cofnięty w planie)` : d;
}).join(', ')}`;

// Zależności pozycji z bieżącej roadmapy (D-1 … D-3, D-7): zmiana zapisana na pozycji z wpisem w log.md, plik wejścia
// przepisany, póki przebiegu nie ma; sprint piszący kod pracuje dalej z jednym powiadomieniem (D-9), zależność spoza
// zlecenia oznacza czekanie z jednym powiadomieniem (D-5). Pozycja z przebiegiem cofnięta w planie: tylko wskazówka (D-8).
function refreshDeps(ctx) {
  const { sup, main } = ctx;
  const lines = linesOf(ctx);
  for (const it of sup.items.filter((x) => x.state !== 'done')) {
    const old = asList(it.after);
    const now = currentAfter(main, it, { sup, lines });
    if (JSON.stringify(now) !== JSON.stringify(old)) {
      ctx.decisions.push(decide(main, it, 'roadmap', `zależności: ${idsOrNone(old)} → ${idsOrNone(now)} (źródło: roadmap)`));
      it.after = now;
      if (!it.root && !it.act) rewriteInput(main, sup, it);
      const unmet = now.filter((d) => !depDone(main, sup, d));
      if (it.state === 'planned' && unmet.length) setWait(ctx, it, 'after', afterWaitText(ctx, unmet));
      if (it.taskStarted) say(ctx, `deps:${it.id}:${now.join(',')}`, `${it.id}: plan zmienił zależności na ${idsOrNone(now)}; sprint już pisze kod, więc pracuje dalej, a scalenie może przyjść w innej kolejności niż w planie`, { both: true });
      // Sprint piszący kod nie czeka (D-9): jego jedno powiadomienie już poszło, bez drugiego o czekaniu (recenzja F-1).
      for (const d of it.taskStarted ? [] : now.filter((x) => !old.includes(x) && !itemOf(sup, x) && !depMerged(main, x, { sup }).merged)) {
        say(ctx, `outside:${it.id}:${d}`, `${it.id}: plan dodał zależność ${d} spoza zlecenia; ${it.id} czeka na jej scalenie`, { both: true });
      }
    }
    if (it.root && followsRoadmap(it)) {
      const rs = (ctx.ops.roadmapState ?? roadmapState)(main, it.id);
      if (BELOW_READY.includes(rs)) say(ctx, `withdrawn-run:${it.id}`, `${it.id} cofnięty w planie, ale już działa: zatrzymasz go przez supervise hold ${it.id}`, { both: true });
    }
  }
}

// Plik wejścia pozycji z bieżącym nagłówkiem (`after`), treść bez zmian; brak pliku albo nagłówka: bez zmian.
function rewriteInput(main, sup, it) {
  let text;
  try { text = read(join(P(main).input, `${it.id}.md`)); } catch { return; }
  const s = splitHeader(text);
  if (!s) return;
  writeInput(main, sup, it, s.body);
}

// ---------- zatrzymania sterownika ----------

function handleStop(ctx, it, stop, st) {
  it.handledStop = stop.at;
  it.driverPid = null;
  switch (stop.status) {
    case 'done': return itemDone(ctx, it, st);
    case 'planned': {
      const waiting = asList(stop.waitingFor ?? st?.waitingFor);
      it.state = 'planned';
      ctx.decisions.push(decide(ctx.main, it, 'R3', `plan gotowy, czeka na scalenie: ${waiting.join(', ') || '-'}`));
      // Start był „zależności scalone”, a sterownik dalej czeka (pkt 12): bez ponownego startu przy tym samym stanie.
      if (it.depStart && waiting.length) it.depStuck = { sig: it.depStart, waitingFor: waiting };
      it.depStart = null;
      return undefined;
    }
    case 'hold': it.state = 'hold'; ctx.decisions.push(decide(ctx.main, it, 'R4', `sterownik wstrzymany przed zadaniem (${holdReason(ctx, it) ?? 'drive.hold'})`)); return undefined;
    case 'waiting-user':
      if (st?.state === 'merge-wait') {
        it.state = 'merge-wait';
        ctx.decisions.push(decide(ctx.main, it, '§10.2', `squash czeka (${st.reason}); wznowienie po ustąpieniu przyczyny`));
        return say(ctx, `mw:${it.id}:${stop.at}`, `dwmt ${it.id}: suita zielona, ale squash czeka (${st.reason}). Potrzeba: ${st.reason === 'uat' ? 'koniec Twojego UAT' : 'czyste główne drzewo na gałęzi docelowej'}.`, { both: true });
      }
      // Sesję zatrzymania uruchamia `manage` (także po zdjęciu wstrzymania).
      it.state = 'waiting-user';
      it.waitAt = stop.at;
      it.stopReason = String(stop.reason ?? '').slice(0, 120);
      return undefined;
    default:
      if (stop.cause === 'limit') return setLimit(ctx, it, stop.resetsAt ?? null);
      if (['child-dead', 'driver-error'].includes(stop.cause) && infraFail(ctx, it, stop.reason, 'resume')) return undefined;
      return stopItem(ctx, it, stop.cause ?? 'stopped', stop.reason, { notified: !!stop.notified });
  }
}

function itemDone(ctx, it, st) {
  if (it.state === 'done') return;
  it.state = 'done';
  it.reason = null;
  it.result = st?.result ?? it.result ?? null;
  it.uat = st?.uat ?? null;
  if (st?.cost != null && it.costM == null) it.costM = Number(st.cost) || null;
  it.doneAt = new Date(ctx.now).toISOString();
  ctx.decisions.push(decide(ctx.main, it, 'done', `sprint zakończony (${it.result ?? '-'}, ${it.costM ?? '?'} mln${it.uat === 'pending' || it.uatGate ? ', UAT czeka' : ''})`));
  say(ctx, `done:${it.id}`, `dwmt ${it.id}: sprint scalony (${it.result ?? '-'}). Potrzeba: ${it.uat === 'pending' || it.uatGate ? `UAT, kiedy możesz: /dwmt:uat ${it.id}` : 'nic'}.${readyTail(ctx, it)}`, { both: true, push: true });
}
// K7 (D-8): sprint, który kończy miejsce pracy, dopisuje „gotowe do wypchnięcia”. Ten sprint liczy się jako skończony,
// także gdy jego linia roadmapy jeszcze nie jest `done` (A-1); dwmt nigdy nie wypycha sam.
function readyTail(ctx, it) {
  try {
    const wp = workplaceIn(ctx, it);
    if (!wp) return '';
    const r = workplaceReady(ctx.main, wp);
    const sp = workplaceSprints(ctx.main, wp);
    const ready = r.ready || (sp.length > 0 && sp.every((s) => ['done', 'uat'].includes(s.state) || s.id === it.id));
    return ready && r.pushCmd ? ` Miejsce pracy ${wp.name}: gotowe do wypchnięcia: gałąź ${r.branch}, ${sp.length} sprintów: ${r.pushCmd}` : '';
  } catch { return ''; }
}

// Pozycja zatrzymana z powodem (decyzja A: bez ponawiania martwej pracy); zależne czekają.
// K5 D-9: a stop the driver already notified (`stopped.notified`) gets no second desktop toast; the phone push at
// presence away stays.
function stopItem(ctx, it, cause, reason, { notified = false } = {}) {
  it.state = 'stopped';
  it.reason = `${cause}: ${String(reason ?? '').slice(0, 200)}`;
  ctx.decisions.push(decide(ctx.main, it, 'stop', `pozycja zatrzymana bez ponawiania (${it.reason})`, { cause }));
  // Recenzja S3 (7, decyzja lidera): zatrzymana pozycja potrzebuje użytkownika, więc przy `away` także push.
  if (notified && ctx.sup.presence !== 'away') return;
  say(ctx, `stopped:${it.id}:${it.handledStop ?? ctx.now}`, `dwmt ${it.id}: zatrzymany (${String(reason ?? cause).slice(0, 140)}). Potrzeba: sprawdź przebieg (/dwmt:execute ${it.run}) albo supervise resume ${it.id}.`, { both: true, push: ctx.sup.presence === 'away', toast: !notified });
}

// Przestój według życia (§4.7): zdarzenie `stall`, jedno wznowienie (`supervisor.stallRestarts`), potem pozycja zatrzymana.
// Recenzja S3 (7, decyzja z handoffu): śmierć sterownika (albo sesji) przy `away` daje push już przy pierwszym razie, razem
// z informacją o jednym wznowieniu; drugi przestój zatrzymuje pozycję jak dotąd.
function stall(ctx, it, kind, text) {
  emit({ type: 'stall', project: ctx.main, run: it.run, detail: { kind, item: it.id, restarts: it.stallRestarts ?? 0 } });
  if ((it.stallRestarts ?? 0) < ctx.sc.stallRestarts && !ctx.sup.closed && !ctx.sup.held && !it.held) {
    if (closedInRoadmap(ctx, it)) return undefined;
    it.stallRestarts = (it.stallRestarts ?? 0) + 1;
    ctx.decisions.push(decide(ctx.main, it, '§4.7', `${text}: wznowienie ${it.stallRestarts}/${ctx.sc.stallRestarts}`, { kind }));
    if (ctx.sup.presence === 'away') say(ctx, `stall-restart:${it.id}:${it.stallRestarts}`, `dwmt ${it.id}: ${text}; wznowienie ${it.stallRestarts}/${ctx.sc.stallRestarts}. Potrzeba: nic, chyba że padnie znowu.`, { both: true, push: true });
    return it.path === 'session' ? launchSession(ctx, it, 'stall', 'wznowienie po przestoju') : startDriver(ctx, it, 'wznowienie po przestoju');
  }
  // Bez wznowienia: limit wznowień wyczerpany albo zlecenie zamknięte/wstrzymane (wtedy to może być pierwszy przestój).
  const again = (it.stallRestarts ?? 0) >= ctx.sc.stallRestarts;
  const why = again ? 'ponowny przestój' : ctx.sup.closed ? 'przestój przy zamkniętym zleceniu' : 'przestój przy wstrzymaniu';
  it.state = 'stopped';
  it.reason = `stall: ${text}`;
  ctx.decisions.push(decide(ctx.main, it, '§4.7', `${text}: ${why}, pozycja zatrzymana`, { kind }));
  if (ctx.sup.presence === 'here') ask(ctx, it, 'stall', it.id, `${it.id}: ${why} (${text}); wznowić${again ? ' jeszcze raz' : ''}?`, 'resume|stop');
  return say(ctx, `stall:${it.id}:${it.stallRestarts}`, `dwmt ${it.id}: ${text}${again ? ', drugi raz' : ''}; pozycja zatrzymana. Potrzeba: /dwmt:execute ${it.run} albo supervise resume ${it.id}.`, { both: true, push: ctx.sup.presence === 'away' });
}

// Limit abonamentu (§4.7): czekanie do `resetsAt` z marginesem; bez `resetsAt` 60 min i jedna próba, potem zatrzymanie.
function setLimit(ctx, it, resetsAt) {
  const t = Date.parse(resetsAt ?? '');
  if (Number.isFinite(t)) it.limit = { until: iso(t + ctx.sc.limitMarginMin * 60e3), resetsAt };
  else if (it.limit?.noReset) return stopItem(ctx, it, 'limit', 'limit abonamentu bez czasu odnowienia, druga próba');
  else it.limit = { until: iso(ctx.now + ctx.sc.limitRetryMin * 60e3), noReset: true };
  it.state = 'limit';
  writeLimitStatus(ctx.main, it);
  ctx.decisions.push(decide(ctx.main, it, '§4.7', `limit abonamentu; wznowienie po ${it.limit.until}`));
  return undefined;
}
function writeLimitStatus(main, it) {
  const f = join(P(main).status, `${it.id}.json`);
  let old = {};
  try { old = JSON.parse(read(f)); } catch { /* bez pliku */ }
  mkdirSync(P(main).status, { recursive: true });
  writeFileAtomic(f, `${JSON.stringify({ ...old, schema: 'dwmt/status@1', sprint: it.id, run: it.run, state: 'limit', at: new Date().toISOString(), resetsAt: it.limit.resetsAt ?? null, until: it.limit.until, events: asList(old.events) }, null, 2)}\n`);
}

// Sprint czeka na użytkownika (§3): przy `here` powiadomienie o każdym, przy `away` tylko, gdy nic innego nie idzie.
function waitingNotice(ctx, it, st) {
  const q = asList(st?.questions)[0] ?? 'decyzja';
  const others = ctx.sup.items.some((x) => x !== it && (x.state === 'running' || x.state === 'queued'));
  if (ctx.sup.presence === 'here' || !others) say(ctx, `wait:${it.id}:${it.waitAt}`, `dwmt ${it.id} czeka na Ciebie: ${String(q).slice(0, 120)}${it.stopSession?.id ? `; claude attach ${it.stopSession.id}` : ''}.`, { here: ctx.sup.presence === 'here', both: ctx.sup.presence !== 'here' });
}

// ---------- decyzje o pracy: wznowienia i starty ----------

const nightLimit = (ctx) => ctx.sup.nightLimit ?? ctx.mcfg.maxTasksPerNight ?? 2;
const nightReached = (ctx) => ctx.sup.presence === 'away' && ctx.sup.night.count >= nightLimit(ctx);

// Czy przy pozycji ma leżeć `drive.hold` (R4, wstrzymanie, start „tylko planowanie” R2/R3) i dlaczego.
// Recenzja S3 (1): start „tylko planowanie” zwalnia się raz na zawsze (`planOnly` zdjęte przy zwolnieniu). Bez tego
// zwolniony sprint w implementacji dostawał `drive.hold` znowu, gdy ruszył następny sprint, i dwa sprinty czekały na siebie.
function holdReason(ctx, it) {
  if (ctx.sup.held || it.held) return 'hold';
  if (nightReached(ctx)) return 'R4 night limit';
  if (it.planOnly && !planRelease(ctx, it)) return it.planRule ?? 'R2';
  if (it.planOnly) {
    it.planOnly = false;
    it.planReleased = iso(ctx.now);
    ctx.decisions.push(decide(ctx.main, it, it.planRule ?? 'R2', 'start „tylko planowanie” zwolniony: implementacja dozwolona'));
  }
  return null;
}
// Start „tylko planowanie” zwalnia się, gdy każdy inny pracujący sprint jest skończony albo planuje w rozłącznych obszarach.
// Niezwolniony start „tylko planowanie” dalej w kolejności zlecenia nie blokuje: kodu nie pisze, a sam czeka na `it`.
// Zgłoszenie z 2026-10-16 (pkt 8): bez tego dwa gotowe plany czekały na siebie bez końca.
function planRelease(ctx, it) {
  const { items } = ctx.sup;
  // kf2 (D-4): pozycja w priorytecie startu (roadmapa), nie w liście zlecenia. Sortowane tylko starty „tylko planowanie”
  // porównywane tu ze sobą: pozycje skończone albo piszące kod nie zajmują miejsc, więc sprint poprawek zostaje przed
  // pozycjami zapisanymi za nim (recenzja F-2).
  const prio = orderByRoadmap(items.filter((o) => o === it || (o.planOnly && !o.taskStarted)), linesOf(ctx));
  const later = (o) => o.planOnly && !o.taskStarted && prio.indexOf(o) > prio.indexOf(it);
  // K7 (D-6): tylko pozycje tego samego toru (gałęzi docelowej); squash innego toru nie koliduje.
  const others = items.filter((o) => o !== it && busy(o) && !later(o) && sameLane(ctx, o, it));
  if (!others.length) return true;
  if (!it.status?.scope?.length && !it.status?.shared?.length) return false;
  return others.every((o) => planningStage(o) && !areasIntersect(it.status, o.status ?? {}, ctx.cfg.supervisor?.hotFiles));
}
function syncHold(ctx, it) {
  if (!it.root || it.path === 'session') return null;
  const f = join(it.root, 'drive.hold');
  const why = holdReason(ctx, it);
  if (why && !existsSync(f)) writeFileSync(f, `${why}\n`);
  if (!why && existsSync(f)) rmSync(f, { force: true });
  return why;
}

// R1 i R5 dla pozycji (start albo wyjście z `planned`): powód czekania albo null.
function blockers(ctx, it) {
  const { sup, main } = ctx;
  for (const g of asList(it.after).map((id) => itemOf(sup, id)).filter((g) => g?.uatGate)) {
    if (it.overrides?.R5) break;
    if (g.state !== 'done' || !g.uatDone) return { rule: 'R5', text: `czeka na wynik UAT ${g.id}` };
    if (g.fixItem && g.fixBlocking && itemOf(sup, g.fixItem)?.state !== 'done') return { rule: 'R5', text: `czeka na scalenie sprintu poprawek ${g.fixItem}` };
    if (g.uatDone.requirementChanges > 0) return { rule: 'R5', text: `UAT ${g.id} zmienił wymagania: decyzja w rozmowie z PO`, ask: g.id };
  }
  if (!it.overrides?.R1) {
    for (const o of sup.items.filter((x) => x !== it && x.state === 'waiting-user')) {
      const a = o.status?.affects;
      if (a === 'uncertain' || asList(a).includes(it.id)) return { rule: 'R1', text: `otwarte pytanie ${o.id} ${a === 'uncertain' ? '(architekt niepewny)' : 'może dotyczyć tej pozycji'}`, ask: o.id, q: asList(o.status?.questions)[0] };
    }
  }
  void main;
  return null;
}

function setWait(ctx, it, rule, text) {
  if (it.wait?.rule === rule && it.wait?.text === text) return;
  if (it.wait) it.waits = { ...(it.waits ?? {}), [it.wait.rule]: (it.waits?.[it.wait.rule] ?? 0) + (ctx.now - Date.parse(it.wait.since)) };
  it.wait = { rule, text, since: new Date(ctx.now).toISOString() };
  ctx.decisions.push(decide(ctx.main, it, rule, `czeka: ${text}`));
}
function clearWait(ctx, it) {
  if (!it.wait) return;
  it.waits = { ...(it.waits ?? {}), [it.wait.rule]: (it.waits?.[it.wait.rule] ?? 0) + (ctx.now - Date.parse(it.wait.since)) };
  it.wait = null;
}

function manage(ctx) {
  const { sup } = ctx;
  if (sup.infra) return;
  // Pozycja z efektem w toku (`it.act`) czeka na jego wynik: bez drugiej decyzji o tej samej pozycji.
  for (const it of sup.items.filter((x) => x.run && !x.act && x.path !== 'session' && (busy(x) || x.state === 'resume'))) {
    const why = syncHold(ctx, it);
    if (sup.closed || sup.held || it.held) continue;
    // Jedna sesja zatrzymania na zatrzymanie sterownika (`waiting-user`); powiadomienie z `attach` po jej starcie.
    if (it.state === 'waiting-user' && it.stopSession?.forStop !== it.handledStop) { launchSession(ctx, it, 'stop', `sesja zatrzymania: ${it.stopReason ?? ''}`); continue; }
    if (it.state === 'resume') { startDriver(ctx, it, 'wznowienie na polecenie (supervise resume)'); continue; }
    if (it.state === 'hold' && !why) { startDriver(ctx, it, 'zwolnienie drive.hold'); continue; }
    if (it.state === 'limit' && ctx.now >= Date.parse(it.limit?.until ?? 0)) { startDriver(ctx, it, `po odnowieniu limitu (${it.limit.until})`); continue; }
    if (it.state === 'merge-wait' && ctx.ops.mergeCleared(ctx.main, it)) { startDriver(ctx, it, 'przyczyna merge-wait ustąpiła: finish'); continue; }
    if (it.state === 'planned' && asList(it.after).every((d) => depDone(ctx.main, sup, d))) {
      const b = blockers(ctx, it);
      if (b) { setWait(ctx, it, b.rule, b.text); continue; }
      if (nightReached(ctx)) { setWait(ctx, it, 'R4', 'limit nocy'); continue; }
      const sig = depSig(ctx, it.after);
      if (it.depStuck?.sig === sig) { depStuckWait(ctx, it); continue; }
      it.depStuck = null;
      clearWait(ctx, it);
      it.depStart = sig;
      startDriver(ctx, it, 'zależności scalone: wyjście z planned');
    }
  }
  for (const it of sup.items.filter((x) => x.run && !x.act && x.path === 'session')) {
    if (sup.closed || sup.held || it.held) continue;
    if (it.state === 'resume') { launchSession(ctx, it, 'resume', 'wznowienie na polecenie (supervise resume)'); continue; }
    if (it.state === 'hold' && !nightReached(ctx)) { launchSession(ctx, it, 'handoff', 'nowa sesja po zadaniu (koniec wstrzymania)'); continue; }
    if (it.state === 'limit' && ctx.now >= Date.parse(it.limit?.until ?? 0)) { launchSession(ctx, it, 'limit', 'po odnowieniu limitu'); continue; }
    if (it.state === 'merge-wait' && ctx.ops.mergeCleared(ctx.main, it)) { launchSession(ctx, it, 'merge', 'przyczyna merge-wait ustąpiła: finish'); continue; }
    if (it.state === 'planned' && asList(it.after).every((d) => depDone(ctx.main, sup, d)) && !blockers(ctx, it) && !nightReached(ctx)) launchSession(ctx, it, 'planned', 'zależności scalone: wyjście z planned');
  }
}

// Pętla i sterownik różnie widzą zależność (zgłoszenie z 2026-10-16, pkt 12: ok. 450 startów co 4 s): pozycja czeka
// na zmianę stanu zależności albo `supervise resume`, z jednym powiadomieniem.
function depStuckWait(ctx, it) {
  const w = it.depStuck.waitingFor.join(', ');
  setWait(ctx, it, 'after', `sterownik czeka na scalenie ${w}, a zlecenie widzi je scalone: bez ponownego startu do zmiany ich stanu (supervise resume ${it.id})`);
  say(ctx, `depstuck:${it.id}:${it.depStuck.sig}`, `dwmt ${it.id}: sterownik czeka na scalenie ${w}, choć zlecenie widzi je scalone; nie uruchamiam go ponownie, dopóki stan zależności się nie zmieni. Potrzeba: sprawdź zależność albo supervise resume ${it.id}.`, { both: true });
}

// Sprint zamknięty w roadmapie (zgłoszenie z 2026-10-16, pkt 10: sprint 8 `closed`, wskrzeszony i zaimplementowany):
// bez startu i bez wznowienia; pozycja zatrzymana z powodem, jedno powiadomienie. Otwarcie sprintu w roadmapie
// i `supervise resume` puszczają ją dalej.
function closedInRoadmap(ctx, it) {
  const rs = (ctx.ops.roadmapState ?? roadmapState)(ctx.main, it.id);
  if (!['closed', 'dropped'].includes(rs)) return false;
  clearWait(ctx, it);
  it.state = 'stopped';
  it.reason = `roadmap: sprint ${rs} w roadmapie`;
  ctx.decisions.push(decide(ctx.main, it, 'roadmap', `sprint ${rs} w roadmapie: bez startu ani wznowienia`));
  say(ctx, `roadmap:${it.id}`, `dwmt ${it.id}: sprint zamknięty w roadmapie (${rs}); nie uruchamiam go. Potrzeba: nic, chyba że ma iść dalej (otwórz go w roadmapie, potem supervise resume ${it.id}).`, { both: true });
  return true;
}

// Start sterownika: `drive.hold` według reguł, zamiar zapisany przed efektem (`starting`, `driveAt`); wynik w `driverStarted`.
function startDriver(ctx, it, why) {
  if (closedInRoadmap(ctx, it)) return;
  syncHold(ctx, it);
  it.driveAt = iso(ctx.now);
  it.state = 'starting';
  queueAct(ctx, it, 'driver', { why });
}
function driverStarted(ctx, it, r, why) {
  if (r?.ok === false && !r.running) return infraFail(ctx, it, r.error, 'resume') ? undefined : stopItem(ctx, it, 'start-failed', r.error ?? 'sterownik nie wystartował');
  it.driverPid = r?.pid ?? null;
  it.state = 'running';
  it.reason = null;
  ctx.decisions.push(decide(ctx.main, it, 'start', `${why}: sterownik pid ${r?.pid ?? '?'}${r?.running ? ' (już działał)' : ''}`));
  return undefined;
}

// Sesja `claude --bg` (zatrzymania albo orkiestratora). Recenzja S3 (9): nowa sesja zatrzymania najpierw zamyka poprzednią
// (sterownik mógł stanąć znowu, zanim pętla zobaczyła go żywego), więc na przebieg jest jedna naraz.
function launchSession(ctx, it, kind, why) {
  if (kind !== 'stop' && closedInRoadmap(ctx, it)) return;
  if (kind === 'stop' && it.stopSession?.id && !it.stopSession.stopped) {
    ctx.acts.push({ kind: 'stop-session', id: it.id, sid: it.stopSession.id });
    it.stopSession.stopped = iso(ctx.now);
    ctx.decisions.push(decide(ctx.main, it, 'waiting-user', `poprzednia sesja zatrzymania ${it.stopSession.id} zamknięta przed nową`));
  }
  if (kind !== 'stop') it.state = 'starting';
  queueAct(ctx, it, 'launch', { sessKind: kind, why, forStop: it.handledStop ?? null });
}
function launched(ctx, it, r, act) {
  if (!r?.ok) {
    if (act.sessKind !== 'stop' && infraFail(ctx, it, r?.error, 'resume')) return undefined;
    return stopItem(ctx, it, 'launch-failed', r?.error ?? 'claude --bg bez identyfikatora sesji');
  }
  const at = iso(ctx.now);
  if (act.sessKind === 'stop') it.stopSession = { id: r.id, at, forStop: act.forStop };
  else { it.session = { id: r.id, at }; it.sessionAt = at; it.state = 'running'; it.reason = null; }
  ctx.decisions.push(decide(ctx.main, it, act.sessKind === 'stop' ? 'waiting-user' : 'start', `${act.why}: sesja ${r.id}${r.attach ? ` (${r.attach})` : ''}`));
  if (act.sessKind === 'stop' && it.state === 'waiting-user') waitingNotice(ctx, it, it.status);
  return undefined;
}

const typicalCost = (ctx) => median(ctx.sup.items.filter((x) => x.state === 'done' && Number(x.costM) > 0).map((x) => Number(x.costM))) ?? ctx.sc.typicalCostM;
export const spentOf = (sup) => r2(sup.items.reduce((a, x) => a + (Number(x.costM ?? x.taskCostM) || 0), 0));

// Aktywne sprinty na maszynie (§7 `maxActiveSprints`): rejestr pętli w `~/.dwmt/supervisors/` (pid ze startem procesu:
// pid użyty ponownie po restarcie nie liczy się) i sterowniki tego projektu spoza zlecenia (np. sprint PO w worktree:
// żywy `drive.lock` przebiegu, którego zlecenie nie zna). Sesji orkiestratora bez sterownika i innych projektów bez pętli
// nie widać (koszt: `claude agents` na każdy odczyt); recenzja S3 (13). Liczone raz na tick.
const registryDir = () => join(home(), 'supervisors');
const pidStartOf = () => new Date(Date.now() - process.uptime() * 1000).toISOString();
function machineActive(ctx) {
  if (ctx.machineActive != null) return ctx.machineActive;
  const { main, sup } = ctx;
  let n = 0;
  try {
    for (const f of readdirSync(registryDir()).filter((x) => x.endsWith('.json'))) {
      try { const r = JSON.parse(read(join(registryDir(), f))); if (!samePath(r.root, main) && processAlive(r.pid, r.pidStart ?? null)) n += Number(r.active) || 0; } catch { /* zapis */ }
    }
  } catch { /* brak rejestru */ }
  const mine = new Set(sup.items.map((x) => x.run).filter(Boolean));
  let trees = [main];
  try { trees = git(['worktree', 'list', '--porcelain'], { cwd: main }).split(/\r?\n/).filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)); } catch { /* bez gita */ }
  for (const t of trees) {
    let runs = [];
    try { runs = readdirSync(join(t, '.dwmt', 'runs')); } catch { continue; }
    for (const r of runs.filter((x) => !mine.has(x))) {
      const l = readLockFile(join(t, '.dwmt', 'runs', r, 'drive.lock'));
      if (l && processAlive(l.pid, l.pidStart ?? null)) n++;
    }
  }
  ctx.machineActive = n;
  return n;
}
function register(main, active) {
  try { mkdirSync(registryDir(), { recursive: true }); writeFileAtomic(join(registryDir(), `${taskName(main)}.json`), JSON.stringify({ root: canonPath(main), pid: process.pid, pidStart: pidStartOf(), active, at: new Date().toISOString() })); } catch { /* best effort */ }
}

function startQueued(ctx) {
  const { sup, main } = ctx;
  // kf2 (D-4, D-12): kolejność startu z roadmapy; zapisana lista zostaje w kolejności dopisania. Sortowane tylko pozycje
  // w kolejce: pozycja skończona (linia `done` czeka na UAT) albo działająca nie zajmuje miejsca, więc sprint poprawek
  // wstawiony przed kolejnymi pozycjami startuje przed nimi (§10.6, recenzja F-2).
  const queued = orderByRoadmap(sup.items.filter((x) => x.state === 'queued'), linesOf(ctx));
  if (!queued.length || sup.closed || sup.held || sup.infra) return;
  for (const X of queued) {
    if (X.held) { setWait(ctx, X, 'hold', 'pozycja wstrzymana'); continue; }
    if (closedInRoadmap(ctx, X)) continue;
    // kf2 (D-8): sprint cofnięty w planie poniżej `ready` nie startuje; rusza sam po ponownym zleceniu w roadmapie.
    const rs = withdrawnState(ctx, X);
    if (rs) {
      setWait(ctx, X, 'roadmap', `cofnięty w planie (stan ${rs}): czeka na ponowne zlecenie`);
      // Recenzja T-1 F-3: pozycje czekające na cofniętą (np. następna z `--sequential`) czekają dalej; powiadomienie je nazywa.
      const waiting = sup.items.filter((o) => o !== X && o.state !== 'done' && asList(o.after).includes(X.id)).map((o) => o.id);
      const tail = waiting.length ? `; czekają na niego: ${waiting.join(', ')} (ruszą bez niego po przesunięciu wyżej w roadmapie albo zmianie after)` : '';
      say(ctx, `withdrawn:${X.id}:${X.wait.since}`, `${X.id} cofnięty w planie (stan ${rs}): nie startuje, ruszy sam po ponownym zleceniu${tail}`, { both: true });
      continue;
    }
    const b = blockers(ctx, X);
    if (b) {
      setWait(ctx, X, b.rule, b.text);
      if (b.ask && (b.rule === 'R5' || sup.presence === 'here')) ask(ctx, X, b.rule, b.ask, b.rule === 'R1' ? `${X.id}: otwarte pytanie ${b.ask} (${String(b.q ?? '').slice(0, 80)}) może jej dotyczyć; startować mimo to?` : `${X.id}: ${b.text}; startować mimo to?`, 'start|wait');
      continue;
    }
    if (nightReached(ctx)) { setWait(ctx, X, 'R4', `limit nocy ${sup.night.count}/${nightLimit(ctx)}`); continue; }
    if (sup.budgetM != null && !sup.budgetAck && spentOf(sup) + typicalCost(ctx) > sup.budgetM) {
      setWait(ctx, X, 'R4', `budżet: wydane ${spentOf(sup)} + typowy ${typicalCost(ctx)} > ${sup.budgetM} mln`);
      if (sup.presence === 'here') ask(ctx, X, 'budget', 'budget', `budżet zlecenia ${sup.budgetM} mln: wydane ${spentOf(sup)}, następny sprint ok. ${typicalCost(ctx)}; kontynuować?`, 'continue|stop');
      continue;
    }
    // K7 (D-7): niezatwierdzone zmiany w drzewie miejsca pracy (albo brak drzewa, miejsce usunięte) trzymają jego następny
    // sprint przed każdym startem; jedno powiadomienie na epizod, sprawdzane co tick. Miejsce usunięte, które wciąż trzyma
    // sprint, też (poprawka T-3/F-1: wcześniej taki sprint startował jak sprint głównego drzewa). Tylko sprint bez
    // niespełnionych zależności (poprawka T-3/F-3): następny po nim czeka na poprzednika, bez własnego powiadomienia.
    const unmet = asList(X.after).filter((d) => !depDone(main, sup, d));
    const swp = startWpIn(ctx, X);
    const wb = swp && !unmet.length ? startBlock(main, swp) : null;
    if (wb) {
      if (!X.wpBlock) X.wpBlock = { reason: wb.reason, since: iso(ctx.now) };
      setWait(ctx, X, 'workplace', wb.text);
      say(ctx, `workplace:${X.id}:${X.wpBlock.since}`, `dwmt ${X.id}: nie startuje: ${wb.text}. Ruszy sam, gdy przyczyna ustąpi.`, { both: true });
      continue;
    }
    if (X.wpBlock) X.wpBlock = null;
    const active = sup.items.filter((o) => o !== X && busy(o));
    const counted = active.filter((o) => o.state !== 'planned').length;
    if (counted + machineActive(ctx) >= (ctx.mcfg.maxActiveSprints ?? 2)) { setWait(ctx, X, 'machine', `maxActiveSprints ${ctx.mcfg.maxActiveSprints ?? 2}`); continue; }
    // Start „tylko planowanie” bez niespełnionych zależności (R2, R3 przy sprincie niezależnym) wymaga `drive.hold`, więc
    // tylko na ścieżce sterownika. R3 z zależnościami w `finish` działa na obu ścieżkach: implementację zatrzymuje sam
    // przebieg na `planned` (`after` w pliku wejścia); recenzja S3 (13): wcześniej ścieżka sesji nie dostawała R3 wcale.
    // K7 (D-6): łańcuch R2/R3 porównuje tylko pozycje tego samego toru; limit `maxActiveSprints` liczy wszystkie.
    // Start na polecenie (`resume <id> --now`, D-14): bez czekania na tor, jak bez czekania na zależności.
    const lane = X.overrides?.after ? [] : active.filter((o) => sameLane(ctx, o, X));
    const viaDriver = !!ctx.cfg.drive?.enabled && X.mode !== 'inline';
    const blocked = lane.some((o) => o.planOnly && !planRelease(ctx, o));
    if (unmet.length) {
      // R3: wieczorny start planowania, gdy zależności są w `finish` (przy `here`); implementacja po scaleniu (`planned`).
      const fin = unmet.every((d) => { const o = itemOf(sup, d); return o && inFinish(o); });
      // `seq` (zlecenie `--sequential`): bez planowania z wyprzedzeniem; architekt rusza dopiero po scaleniu poprzedniej.
      // Drzewo miejsca pracy z przeszkodą (D-7) nie startuje i planowania: czeka na zależności, przeszkoda po ich scaleniu.
      if (sup.presence === 'here' && fin && !blocked && !X.seq && !(swp && startBlock(main, swp))) { start(ctx, X, { planOnly: viaDriver, rule: 'R3' }); continue; }
      setWait(ctx, X, 'after', afterWaitText(ctx, unmet));
      continue;
    }
    if (!lane.length) { start(ctx, X, {}); continue; }
    if (viaDriver && !blocked && lane.every((o) => o.state === 'waiting-user' && planningStage(o))) { start(ctx, X, { planOnly: true, rule: 'R2' }); continue; }
    if (viaDriver && !blocked && sup.presence === 'here') { start(ctx, X, { planOnly: true, rule: 'R3' }); continue; }
    setWait(ctx, X, 'R2', `${laneOf(ctx, X) ? `na gałęzi miejsca pracy ${laneOf(ctx, X)}` : 'w projekcie'} pracuje ${lane.map((o) => o.id).join(', ')}`);
  }
}

// Start pozycji: zamiar `prepare` (worktree, `init`) zapisany przed efektem; po wyniku (`prepared`) start sterownika albo sesji.
function start(ctx, X, { planOnly = false, rule = null }) {
  if (closedInRoadmap(ctx, X)) return;
  const driver = !!ctx.cfg.drive?.enabled && X.mode !== 'inline';
  // `auto` pod sterownikiem = `single` (wybór `inline` wymaga modelu, §4.5); bez sterownika model wybiera sam.
  const mode = driver ? (['direct', 'intermediate', 'single'].includes(X.mode) ? X.mode : 'single') : X.mode || 'auto';
  clearWait(ctx, X);
  Object.assign(X, { state: 'starting', path: driver ? 'driver' : 'session', planOnly, planRule: rule, startedAt: iso(ctx.now), stallRestarts: 0 });
  // Zależności scalone przy starcie (bez R3): `planned` z nimi to rozjazd ze sterownikiem (pkt 12).
  X.depStart = asList(X.after).length && rule !== 'R3' ? depSig(ctx, X.after) : null;
  X.depStuck = null;
  queueAct(ctx, X, 'prepare', { mode });
}
function prepared(ctx, X, r) {
  const { main } = ctx;
  if (!r?.ok) {
    if (infraFail(ctx, X, r?.error, 'queued')) return undefined;
    X.state = 'stopped';
    X.reason = r?.error ?? 'przygotowanie bez wyniku';
    ctx.decisions.push(decide(main, X, 'start', `przygotowanie nieudane, pozycja zatrzymana: ${X.reason}`));
    return say(ctx, `prep:${X.id}:${X.startedAt}`, `dwmt ${X.id}: nie wystartował (${String(X.reason).slice(0, 140)}). Potrzeba: popraw i supervise resume ${X.id}.`, { both: true, push: ctx.sup.presence === 'away' });
  }
  Object.assign(X, { run: r.run, worktree: r.worktree, root: r.root });
  // Ostrzeżenie preflight raz na zlecenie (liczby w treści, np. commity przed origin, nie robią z niego nowego).
  const key = (w) => String(w).replace(/\d+/g, 'n');
  const fresh = asList(r.warnings).filter((w) => !asList(ctx.sup.warned).includes(key(w)));
  ctx.sup.warned = [...asList(ctx.sup.warned), ...fresh.map(key)].slice(-50);
  if (fresh.length) ctx.decisions.push(decide(main, X, 'preflight', `ostrzeżenia: ${fresh.slice(0, 3).join('; ')}`));
  // K4 (D-27): jednorazowy komunikat `init` o sterowniku domyślnie włączonym (init daje go raz na projekt).
  if (r.notice) ctx.decisions.push(decide(main, X, 'start', r.notice));
  // Wstrzymanie albo zamknięcie zlecenia w czasie przygotowania (zgłoszenie: `hold all` 10:43:50, sterowniki 10:44:27):
  // pozycja gotowa, ale bez startu; rusza po `supervise resume` jak wznowienie.
  if (ctx.sup.held || ctx.sup.closed || X.held) {
    X.state = 'resume';
    ctx.decisions.push(decide(main, X, 'hold', `przygotowana, start wstrzymany (${ctx.sup.closed ? 'zlecenie zamknięte' : 'hold'})`));
    return undefined;
  }
  if (X.path === 'driver') return startDriver(ctx, X, `start${X.planOnly ? ` (${X.planRule}: tylko planowanie do zwolnienia)` : ''}`);
  return launchSession(ctx, X, 'start', `start sesji orkiestratora${X.planRule ? ` (${X.planRule})` : ''}`);
}

// Pytanie zarządcze do użytkownika (P-n w `pending.md`; odpowiedź: `supervise answer`), raz na (rodzaj, pozycja, przyczyna).
function ask(ctx, it, kind, about, text, options) {
  const { sup } = ctx;
  if (sup.pending.some((p) => p.kind === kind && p.item === it.id && p.about === about && p.answer !== 'obsolete')) return;
  const p = { id: `P-${sup.nextP++}`, kind, item: it.id, about, text, options, at: new Date(ctx.now).toISOString(), answer: null };
  sup.pending.push(p);
  ctx.decisions.push(decide(ctx.main, it, kind, `pytanie ${p.id}: ${text}`));
  say(ctx, `ask:${p.id}`, `dwmt: ${text} (supervise answer ${p.id} ${options})`, { here: true });
}

// Powiadomienie (§4.8): pulpit przez adapter, raz na klucz; w godzinach ciszy kolejka do końca ciszy. `here`: tylko przy
// obecności; `both`: niezależnie; `push`: także telefon (sesja Haiku, `supervisor.phonePush`). Wysyłka to efekt poza
// blokadą stanu (`perform`), identyfikator sesji push zapisuje `record`.
function say(ctx, key, text, { here = false, both = false, push = false, toast = true } = {}) {
  const { sup } = ctx;
  if (sup.notified.includes(key)) return;
  if (!both && here && sup.presence !== 'here') return;
  sup.notified = [...sup.notified, key].slice(-300);
  if (ctx.ops.quiet(ctx.now)) { sup.notifyQueue.push({ text, push, ...(toast ? {} : { toast: false }) }); return; }
  deliver(ctx, text, push, toast);
}
function deliver(ctx, text, push, toast = true) {
  ctx.acts.push({ kind: 'notify', text, push: !!push && ctx.sc.phonePush !== false, ...(toast ? {} : { toast: false }) });
}

// Sprzątanie (§4.8): sesje push po 3 min, sesje zatrzymania po ponownym starcie sterownika (`claude stop`); kolejka ciszy.
function housekeeping(ctx) {
  const { sup } = ctx;
  if (!ctx.ops.quiet(ctx.now) && sup.notifyQueue.length) { for (const n of sup.notifyQueue.splice(0)) deliver(ctx, n.text, n.push, n.toast !== false); }
  sup.pushSessions = sup.pushSessions.filter((s) => { if (ctx.now - Date.parse(s.at) < 3 * 60e3) return true; ctx.acts.push({ kind: 'stop-session', sid: s.id }); return false; });
  for (const it of sup.items.filter((x) => x.stopSession?.id && !x.stopSession.stopped && x.state !== 'waiting-user')) {
    ctx.acts.push({ kind: 'stop-session', id: it.id, sid: it.stopSession.id });
    it.stopSession.stopped = iso(ctx.now);
  }
}

// ---------- pliki dla człowieka ----------

function renderWork(sup) {
  const rows = sup.items.map((x) => `| ${x.id} | ${x.src} | ${asList(x.after).join(', ') || '-'} | ${x.uatGate ? 'yes' : '-'} | ${x.state}${x.held ? ' (held)' : ''} | ${x.wait ? `${x.wait.rule}: ${x.wait.text}` : reasonOf(x) ?? '-'} | ${x.run ?? '-'} | ${x.status?.task ? `T-${x.status.task}/${x.status.tasks ?? '?'}` : '-'} | ${x.costM ?? x.taskCostM ?? '-'} | ${x.uatDone ? `UAT ${x.uatDone.result}` : uatPending(x) ? 'UAT pending' : '-'} |`);
  return withHeader({ schema: 'dwmt/supervisor-work@1', updated: sup.updated, presence: sup.presence, closed: sup.closed, held: sup.held }, `\n# Work list\n\n| id | src | after | uat gate | state | wait / reason | run | tasks | cost M | UAT |\n|---|---|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n`);
}
function renderPending(sup) {
  const open = sup.pending.filter((p) => !p.answer);
  return withHeader({ schema: 'dwmt/supervisor-pending@1', open: open.length }, `\n# Pending management questions\n\n${open.map((p) => `- ${p.id} (${p.kind}, ${p.item}): ${p.text} → supervise answer ${p.id} ${p.options}`).join('\n') || 'none'}\n`);
}
function writeReport(ctx) {
  const { sup, main } = ctx;
  const lines = [
    `# Order report`, '', `Presence: ${sup.presence}; budget: ${sup.budgetM ?? 'none'} M, spent ${spentOf(sup)} M; night limit ${sup.night.count}/${nightLimit(ctx)}${sup.closed ? '; closed' : ''}${sup.held ? '; held' : ''}.`, '', '## Sprints', '',
    ...sup.items.map((x) => `- ${x.id}: ${x.state}${x.result ? ` ${x.result}` : ''}${x.costM != null ? `, ${x.costM} M` : ''}${x.status?.tasks ? `, ${x.status.tasks} tasks` : ''}${x.run ? `, report ${fwd(join(main, '.dwmt', 'runs', x.run, 'final-report.md'))}` : ''}${reasonOf(x) ? `; ${reasonOf(x)}` : ''}`),
    '', '## Waiting by rule (minutes)', '',
    ...sup.items.filter((x) => x.waits || x.wait).map((x) => `- ${x.id}: ${Object.entries({ ...(x.waits ?? {}), ...(x.wait ? { [x.wait.rule]: (x.waits?.[x.wait.rule] ?? 0) + (ctx.now - Date.parse(x.wait.since)) } : {}) }).map(([k, v]) => `${k} ${Math.round(v / 60e3)}`).join(', ')}`),
    '', '## Driver stops', '', ...sup.items.flatMap((x) => asList(x.stops).map((s) => `- ${x.id} ${s.at}: ${s.status}${s.cause ? ` (${s.cause})` : ''} ${s.reason}`)),
    '', '## UAT', '', ...sup.items.filter((x) => uatPending(x) || x.uatDone).map((x) => `- ${x.id}: ${x.uatDone ? `${x.uatDone.result}, blocker ${x.uatDone.counts?.blocker ?? 0}, major ${x.uatDone.counts?.major ?? 0}, minor ${x.uatDone.counts?.minor ?? 0}` : `pending since ${x.doneAt}`}${x.fixItem ? `; fix sprint ${x.fixItem}` : ''}`),
    '', '## Cleanup (commands for you)', '', ...sup.items.filter((x) => x.state === 'done' && x.worktree && !samePath(x.worktree, main)).map((x) => `- ${x.id}: cd "${fwd(main)}" && node "${fwd(join(ROOT, 'scripts', 'dwmt.mjs'))}" finish ${x.run} --cleanup`),
    '', '## Decisions', '', ...tailLines(P(main).log, 15),
  ];
  writeFileAtomic(P(main).report, withHeader({ schema: 'dwmt/supervisor-report@1', updated: new Date(ctx.now).toISOString() }, `\n${lines.join('\n')}\n`));
}
const tailLines = (f, n) => { try { return read(f).trim().split(/\r?\n/).slice(-n); } catch { return []; } };

function writeInput(main, sup, it, body) {
  mkdirSync(P(main).input, { recursive: true });
  // `after` dla przebiegu: tylko pozycje tego zlecenia (zależność spoza zlecenia jest już scalona; `state` czekałby na
  // plik statusu, którego sprint bez supervisora nie ma).
  const h = { schema: 'dwmt/sprint-input@1', sprint: it.id, order: sup.items.map((x) => x.id), after: asList(it.after).filter((id) => itemOf(sup, id)), ...(it.first ? { first: it.first } : {}), ...(it.source ? { source: it.source } : {}), ...(it.sourceRun ? { sourceRun: it.sourceRun } : {}), ...(it.src === 'spec' ? { spec: it.id } : {}), uatGate: !!it.uatGate };
  writeFileAtomic(join(P(main).input, `${it.id}.md`), withHeader(h, `\n${String(body).trim()}\n`));
}

// ---------- komendy (§4.9) ----------

// Argumenty: opcje wielowartościowe (`--spec a b`, `--after x y`) biorą wartości do następnej opcji.
function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const k = a.slice(2);
    const vals = [];
    while (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) vals.push(argv[++i]);
    opts[k] = vals.length ? [...asList(opts[k] === true ? [] : opts[k]), ...vals.flatMap((v) => (['spec', 'file', 'after', 'uat-gate'].includes(k) ? v.split(',') : [v]))] : true;
  }
  return { pos, opts };
}
const one = (v) => (Array.isArray(v) ? v[0] : v);

function estimateFor(main, cfg, est) {
  if (!est) return null;
  const m = /^start:\s*\[?\s*([\d.]+)\s*,\s*([\d.]+)/.exec(String(est));
  if (m) return [Number(m[1]), Number(m[2])];
  try { const e = estimateOf(productPaths(main, productConfig(main, cfg)), est); return e?.tokensM && !e.stale ? e.tokensM : null; } catch { return null; }
}

function preflightWarnings(main, cfg) {
  const w = [];
  const target = cfg.git.target;
  const branch = git(['branch', '--show-current'], { cwd: main });
  if (branch !== target) w.push(`główne drzewo stoi na ${branch || 'detached HEAD'}, nie na ${target}: squash nie wejdzie (merge-wait)`);
  const dirty = git(['status', '--porcelain', '--untracked-files=no'], { cwd: main }).split(/\r?\n/).filter(Boolean);
  if (dirty.length) w.push(`niezacommitowane zmiany w głównym drzewie (${dirty.length}): squash na nie poczeka`);
  if (!checkAgents(main, cfg).ok) w.push('agenci dwmt nieaktualni: /dwmt:setup (start pozycji zatrzyma się na preflight)');
  const wt = String(cfg.supervisor?.worktreeDir || '.claude/worktrees').replace(/\\/g, '/').replace(/\/+$/, '');
  if (gitRaw(['check-ignore', '-q', `${wt}/x`], { cwd: main }).status !== 0) w.push(`katalog worktree ${wt} nie jest ignorowany: init dopisze go do .git/info/exclude`);
  for (const f of ['C:/Program Files/ClaudeCode/managed-settings.json', '/Library/Application Support/ClaudeCode/managed-settings.json', '/etc/claude-code/managed-settings.json']) {
    try { if (/"bgIsolation"\s*:\s*"worktree"/.test(read(f))) w.push(`managed settings wymuszają worktree.bgIsolation: worktree (${f})`); } catch { /* brak pliku */ }
  }
  const mc = machineConfig();
  if (!(mc.maxActiveSprints >= 1)) w.push('machine.json: maxActiveSprints < 1');
  if (!cfg.drive?.enabled) w.push('drive.enabled: false: pozycje idą sesjami orkiestratora (§4.5), nie sterownikiem');
  // Recenzja S3 (10): bez dziennika zdarzeń pętla nie liczy `task-start` (R4: limit nocy), kosztów (budżet) ani `drive-stop`.
  if (!eventsEnabled()) w.push('dziennik zdarzeń wyłączony (machine.json events: false albo DWMT_EVENTS=0): bez limitu nocy (R4), budżetu i kosztów w raporcie');
  w.push(...platformWarnings());
  return w;
}

// Ostrzeżenie przed nocą (§10.2): squash do głównego drzewa nie wejdzie (UAT, zmiany, inna gałąź).
function nightWarnings(main, cfg) {
  const w = [];
  const holds = activeHolds(mergeKey(main, cfg.git.target).key);
  if (holds.length) w.push(`trwa UAT (wstrzymanie scaleń do ${holds[0].until}): w nocy żaden squash nie wejdzie`);
  const branch = git(['branch', '--show-current'], { cwd: main });
  if (branch !== cfg.git.target) w.push(`główne drzewo na ${branch}, nie na ${cfg.git.target}: w nocy żaden squash nie wejdzie`);
  let pdir = null;
  try { const pc = productConfig(main, cfg); if (pc.present) pdir = fwd(pc.dir).replace(/^\.\//, '').replace(/\/$/, ''); } catch { /* bez warstwy */ }
  const dirty = git(['status', '--porcelain', '--untracked-files=no'], { cwd: main }).split(/\r?\n/).filter(Boolean).map((l) => l.slice(3)).filter((f) => !pdir || !(f === pdir || f.startsWith(`${pdir}/`)));
  if (dirty.length) w.push(`zmiany w głównym drzewie (${dirty.slice(0, 3).join(', ')}): w nocy squash nie wejdzie, zależne sprinty nie ruszą`);
  return w;
}

function cmdOrder(main, cfg, opts, argv) {
  if (supConfig(cfg).enabled === false) return { ok: false, error: 'supervisor.enabled: false w .claude/dwmt.json: zlecenie wyłączone' };
  const specs = asList(opts.spec === true ? [] : opts.spec);
  const files = asList(opts.file === true ? [] : opts.file);
  if (!specs.length && !files.length) throw new Error('supervise order (--spec <plik…> | --file <plik…> [--after <id…>]) [--sequential] [--presence here|away] [--budget M] [--uat-gate <id…>]');
  const add = [];
  const errors = [];
  for (const f of specs) {
    const id = basename(f).replace(/\.md$/i, '');
    try {
      const j = productRun(main, ['sprint', id, '--json']);
      if (!['ready', 'ordered'].includes(j.state)) { errors.push(`${id}: ${j.state}, nie ready/ordered`); continue; }
      add.push({ id, src: 'spec', file: fwd(resolve(f)), after: asList(j.after), uatGate: !!j.header?.uatGate, mode: j.header?.mode ?? 'auto', estimate: estimateFor(main, cfg, j.header?.est), body: j.body });
    } catch (e) { errors.push(`${id}: ${e.message}`); }
  }
  for (const f of files) {
    if (!existsSync(f)) { errors.push(`brak pliku ${f}`); continue; }
    const id = basename(f).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^\w.-]+/g, '-');
    const text = read(f);
    const s = splitHeader(text);
    let h = {};
    try { h = s ? parseYaml(s.yaml) : {}; } catch { /* tekst */ }
    // A sprint file given as `--file`: its `## For you` (the decision-maker's section) never reaches the agents.
    add.push({ id, src: 'file', file: fwd(resolve(f)), after: opts.after === true ? [] : opts.after ? asList(opts.after) : null, uatGate: false, mode: ['direct', 'inline', 'intermediate', 'single', 'auto'].includes(h.mode) ? h.mode : 'auto', estimate: null, body: h.schema === 'dwmt/sprint-spec@1' ? stripForYou(text) : text });
  }
  if (errors.length) return { ok: false, errors, hint: 'supervisor bierze tylko sprinty gotowe (ready/ordered): PO kończy refinement albo `product ready`' };
  const depErrors = outsideDeps(main, readSup(main), add);
  if (depErrors.length) return { ok: false, errors: depErrors, hint: `zależność spoza zlecenia musi być scalona (done): dodaj ją do zlecenia albo zmień after${depErrors.some((e) => e.includes('poprzedni sprint miejsca pracy')) ? '; poprzedni sprint miejsca pracy: zleć go razem z tym (start przed nim na polecenie: potem supervise resume <id> --now)' : ''}` };
  const gates = asList(opts['uat-gate'] === true ? [] : opts['uat-gate']);
  const seq = !!opts.sequential;
  const nightW = [];
  const out = withState(main, (sup) => {
    const skipped = [];
    const added = [];
    sup.closed = false;
    sup.finished = false;
    for (const x of add) {
      if (itemOf(sup, x.id)) { skipped.push(x.id); continue; }
      const prev = sup.items.at(-1);
      // Przegląd 2026-10-09 (W-7): „jeden po drugim” (`--sequential`) to prawdziwa zależność od poprzedniej pozycji listy,
      // także dla plików sprintu (ich `after` z roadmapy było puste, więc architekt drugiego ruszył od razu: R3).
      const after = seq ? [...new Set([...asList(x.after), ...(prev ? [prev.id] : [])])] : x.after ?? (prev ? [prev.id] : []);
      const it = { id: x.id, src: x.src, file: x.file, after, ...(seq ? { seq: true } : {}), uatGate: x.uatGate || gates.includes(x.id), mode: x.mode, estimate: x.estimate, state: 'queued' };
      sup.items.push(it);
      added.push(it);
      bodies.set(it.id, x.body);
    }
    for (const g of gates) { const it = itemOf(sup, g); if (it) it.uatGate = true; }
    // kf2 (D-11): sprint z roadmapy dostaje od razu bieżącą listę reguły (pierwszy tick nie loguje zmiany).
    for (const it of added) {
      if (it.src === 'spec') it.after = currentAfter(main, it, { sup });
      writeInput(main, sup, it, bodies.get(it.id));
    }
    if (opts.presence && opts.presence !== true) nightW.push(...setPresence(main, cfg, sup, one(opts.presence)));
    if (opts.budget && opts.budget !== true) { sup.budgetM = Number(one(opts.budget)); sup.budgetAck = false; }
    appendFileSync(P(main).order, `${existsSync(P(main).order) ? '' : '# Order\n\n'}- ${new Date().toISOString()} order ${argv.join(' ')}\n`);
    decide(main, null, 'order', `zlecenie: ${added.map((x) => x.id).join(', ') || 'bez nowych pozycji'}${skipped.length ? `; już na liście: ${skipped.join(', ')}` : ''}`);
    return { added: added.map((x) => x.id), skipped };
  }, { create: true });
  const warnings = [...preflightWarnings(main, cfg), ...nightW];
  const sc = supConfig(cfg);
  if (sc.autostart) autostart(true, autostartArgs(main));
  const loop = ensureLoop(main);
  return { ok: true, ...out, warnings, loop: loop.running ? `running${loop.pid ? ` (pid ${loop.pid})` : ''}` : loop.reason, hint: 'supervise status' };
}
const bodies = new Map();

// Recenzja S3 (8): zależność spoza zlecenia musi być scalona już przy zleceniu: status `done` albo sprint `done`/`closed`
// w roadmapie (`product sprint`). Nieznana albo niezakończona → odmowa (wcześniej liczona jako scalona: pozycja startowała
// przed nią).
function outsideDeps(main, sup, add) {
  const inOrder = new Set([...(sup?.items ?? []).map((x) => x.id), ...add.map((x) => x.id)]);
  const errors = [];
  const verdict = new Map();
  for (const x of add) {
    // Poprawka T-3/F-2: sprint z roadmapy liczy też niejawnego poprzednika z tego samego miejsca pracy (D-6, `currentAfter`);
    // wcześniej sprawdzane było tylko `after` z roadmapy, a zlecenie stało bez powiadomienia.
    const own = asList(x.after);
    const deps = x.src === 'spec' ? [...new Set([...own, ...currentAfter(main, { id: x.id, src: 'spec', after: own }, { sup: sup ?? { items: [] } })])] : own;
    for (const d of deps.filter((id) => !inOrder.has(id))) {
      if (!verdict.has(d)) {
        let state = statusOf(main, d)?.state ?? null;
        if (state !== 'done') { try { state = productRun(main, ['sprint', d, '--json']).state ?? state; } catch { /* bez warstwy albo bez sprintu */ } }
        verdict.set(d, ['done', 'closed'].includes(state) ? null : state ?? 'unknown');
      }
      let lane = '';
      if (!own.includes(d)) { try { lane = ` (poprzedni sprint miejsca pracy ${workplaceOf(main, x.id)?.name ?? '?'})`; } catch { /* bez warstwy */ } }
      if (verdict.get(d)) errors.push(`${x.id}: zależność ${d} spoza zlecenia${lane} ${verdict.get(d) === 'unknown' ? 'nieznana (brak statusu i sprintu w roadmapie)' : `ma stan ${verdict.get(d)}, nie done`}`);
    }
  }
  return errors;
}

// Autostart (§4.7): stały plik startowy w `~/.dwmt/supervisors/` szuka bieżącego katalogu wtyczki (platform.mjs).
const autostartArgs = (main) => ({ root: canonPath(main), script: fwd(SUPERVISE), dir: registryDir() });

function setPresence(main, cfg, sup, v) {
  if (!['here', 'away'].includes(v)) throw new Error('presence here|away');
  if (v === 'here' && sup.presence !== 'here') sup.night = { count: 0, since: new Date().toISOString() };
  if (v === 'away' && sup.presence !== 'away') sup.night = { count: 0, since: new Date().toISOString() };
  sup.presence = v;
  return v === 'away' ? nightWarnings(main, cfg) : [];
}

function cmdSet(main, cfg, pos) {
  const [what, a, b] = pos;
  const warnings = [];
  const r = withState(main, (sup) => {
    if (!sup) return { ok: false, error: 'brak zlecenia (supervise order)' };
    if (what === 'presence') warnings.push(...setPresence(main, cfg, sup, a));
    else if (what === 'budget') { sup.budgetM = a === 'none' ? null : Number(a); sup.budgetAck = false; if (sup.budgetM != null && !(sup.budgetM > 0)) throw new Error('budget <mln>|none'); }
    else if (what === 'gate') { const it = itemOf(sup, a); if (!it) throw new Error(`brak pozycji ${a}`); it.uatGate = b !== 'off'; }
    else if (what === 'night-limit') { const n = Number(a); if (!(n >= 0)) throw new Error('night-limit <n>'); sup.nightLimit = n; }
    else throw new Error('supervise set presence here|away | budget <mln>|none | gate <id> on|off | night-limit <n>');
    appendFileSync(P(main).order, `- ${new Date().toISOString()} set ${pos.join(' ')}\n`);
    decide(main, null, 'set', `${pos.join(' ')}`);
    return { ok: true, set: pos.join(' ') };
  });
  if (r?.ok) ensureLoop(main);
  return { ...r, ...(warnings.length ? { warnings } : {}) };
}

function cmdHold(main, id, on, { now = false } = {}) {
  if (now && (on || id === 'all')) return { ok: false, error: '--now tylko przy supervise resume <id>' };
  const r = withState(main, (sup) => {
    if (!sup) return { ok: false, error: 'brak zlecenia (supervise order)' };
    // K7 (D-14, D-18): start na polecenie użytkownika mimo niescalonych zależności (także toru miejsca pracy): pętla
    // i sterownik widzą przez `currentAfter` brak zależności tej jednej pozycji, aż się skończy.
    if (now) {
      const it = itemOf(sup, id);
      if (!it) throw new Error(`brak pozycji ${id}`);
      const was = asList(it.after);
      it.overrides = { ...(it.overrides ?? {}), after: true };
      decide(main, it, 'after', `start na polecenie (supervise resume ${id} --now): zależności ${idsOrNone(was)} pominięte; ich kodu może nie być jeszcze na gałęzi`);
    }
    const items = id === 'all' ? sup.items : [itemOf(sup, id)].filter(Boolean);
    if (id !== 'all' && !items.length) throw new Error(`brak pozycji ${id}`);
    if (id === 'all') sup.held = on;
    for (const it of items) {
      if (id !== 'all') it.held = on;
      // `resume <id>` zatrzymanej pozycji: decyzja użytkownika, więc jedno ponowne uruchomienie (nie `resume all`).
      // Pozycja zatrzymana przed końcem przygotowania (bez katalogu przebiegu) wraca do kolejki od nowego preflight.
      if (!on && id !== 'all' && it.state === 'stopped' && it.run && it.root) { it.state = 'resume'; it.stallRestarts = 0; it.reason = null; it.limit = null; }
      if (!on && id !== 'all' && it.state === 'stopped' && !it.root) { it.state = 'queued'; it.reason = null; it.run = null; }
      // `resume <id>` pozycji `planned` po rozjeździe zależności (pkt 12): jeszcze jedna próba sterownika.
      if (!on && id !== 'all' && it.depStuck) it.depStuck = null;
      // `hold` przy działającym sterowniku: `drive.hold` od razu (bieżący agent kończy pracę); zdejmuje go pętla.
      if (on && it.root && busy(it) && it.path !== 'session') writeFileSync(join(it.root, 'drive.hold'), 'hold\n');
    }
    decide(main, null, on ? 'hold' : 'resume', `${on ? 'wstrzymanie' : 'wznowienie'}: ${id}`);
    return { ok: true, [on ? 'held' : 'resumed']: id === 'all' ? 'all' : id, ...(now ? { now: true } : {}) };
  });
  if (r?.ok && !on) r.loop = ensureLoop(main).running ? 'running' : 'not running';
  return r;
}

function cmdAnswer(main, pid, decision) {
  const r = withState(main, (sup) => {
    if (!sup) return { ok: false, error: 'brak zlecenia' };
    const p = sup.pending.find((x) => x.id === pid);
    if (!p) throw new Error(`brak pytania ${pid}`);
    if (p.answer) return { ok: false, error: `${pid} już ma odpowiedź: ${p.answer}` };
    const d = String(decision ?? '').toLowerCase();
    if (!p.options.split('|').includes(d)) throw new Error(`${pid}: odpowiedź ${p.options}`);
    p.answer = d;
    p.answeredAt = new Date().toISOString();
    const it = itemOf(sup, p.item);
    if (['R1', 'R5'].includes(p.kind) && d === 'start' && it) it.overrides = { ...(it.overrides ?? {}), [p.kind]: true };
    if (p.kind === 'budget') { if (d === 'continue') sup.budgetAck = true; else sup.closed = true; }
    if (p.kind === 'stall' && d === 'resume' && it?.state === 'stopped') { it.state = 'resume'; it.stallRestarts = 0; }
    decide(main, it, p.kind, `odpowiedź ${pid}: ${d}`);
    return { ok: true, answered: pid, decision: d };
  });
  if (r?.ok) ensureLoop(main);
  return r;
}

function cmdClose(main, cfg) {
  const r = withState(main, (sup) => {
    if (!sup) return { ok: false, error: 'brak zlecenia' };
    sup.closed = true;
    decide(main, null, 'close', 'zlecenie zamknięte: bez nowych pozycji; sprinty w toku do najbliższego zatrzymania');
    return { ok: true, closed: true, running: sup.items.filter((x) => x.state === 'running').map((x) => x.id) };
  });
  // Recenzja S3 (5): wyrejestrowanie zawsze (także gdy `supervisor.autostart` zmieniono po rejestracji).
  void cfg;
  if (r?.ok) autostart(false, autostartArgs(main));
  return r;
}

// Powód tylko przy pozycji zatrzymanej albo porzuconej; przy innej to ślad dawnego zatrzymania (pkt 9).
const reasonOf = (x) => (['stopped', 'dropped'].includes(x.state) ? x.reason ?? null : null);

export function statusData(main, cfg) {
  const sup = readSup(main);
  if (!sup) return { ok: true, order: null, hint: 'brak zlecenia: supervise order' };
  const loop = loopAlive(main);
  const nl = sup.nightLimit ?? machineConfig().maxTasksPerNight ?? 2;
  const items = sup.items.map((x) => ({
    // K5 D-10: an item stopped by a failed agent session reads `stalled` (its reason starts with the cause).
    id: x.id, state: x.state === 'stopped' && SESSION_FAILURES.some((c) => String(x.reason ?? '').startsWith(`${c}:`)) ? 'stalled' : x.state, ...(x.held ? { held: true } : {}), ...(x.wait ? { wait: `${x.wait.rule}: ${x.wait.text}` } : {}), ...(reasonOf(x) ? { reason: reasonOf(x) } : {}),
    ...(x.run ? { run: x.run } : {}), ...(x.state === 'running' && x.driverPid ? { driver: x.driverPid } : {}), ...(x.status?.step ? { step: `${x.status.task ? `T-${x.status.task}/${x.status.tasks ?? '?'} ` : ''}${x.status.step}` } : {}),
    ...(x.state === 'waiting-user' && x.stopSession?.id ? { attach: `claude attach ${x.stopSession.id}` } : {}), ...(x.state === 'waiting-user' ? { questions: asList(x.status?.questions) } : {}),
    ...(x.costM != null || x.taskCostM != null ? { costM: x.costM ?? x.taskCostM } : {}), ...(uatPending(x) ? { uat: 'pending' } : x.uatDone ? { uat: x.uatDone.result } : {}),
  }));
  return {
    ok: true, order: sup.finished ? 'finished' : sup.closed ? 'closed' : sup.held ? 'held' : 'open', presence: sup.presence, budgetM: sup.budgetM, spentM: spentOf(sup),
    night: `${sup.night.count}/${nl}`, loop: loop ? `running (pid ${loop.pid})` : 'not running', items,
    ...(sup.infra ? { infra: `${sup.infra.text}${sup.infra.where ? ` (${sup.infra.where})` : ''}; next check ${sup.infra.next}` } : {}),
    pending: sup.pending.filter((p) => !p.answer).map((p) => `${p.id} (${p.kind}, ${p.item}): ${p.text} → supervise answer ${p.id} ${p.options}`), report: fwd(P(main).report),
  };
}

// Pozycja bez potrzeby uwagi: zakończona bez czekającego UAT albo porzucona (w statusie jedną linią).
const closedItem = (x) => (x.state === 'done' && x.uat !== 'pending') || x.state === 'dropped';
function statusText(s) {
  if (!s.order) return 'supervisor: no order (supervise order)';
  return [
    `order ${s.order} · presence ${s.presence} · budget ${s.budgetM ?? 'none'} M (spent ${s.spentM}) · night ${s.night} · loop ${s.loop}`,
    ...(s.infra ? [`! waiting for the environment: ${s.infra}`] : []),
    // Zgłoszenie z 2026-10-15: lista ucięta po 15 pozycjach gubiła 16. (`panel`). Wszystkie niezakończone, zakończone w linii.
    ...s.items.filter((x) => !closedItem(x)).map((x) => `- ${x.id} ${x.state}${x.held ? ' (held)' : ''}${x.step ? ` ${x.step}` : ''}${x.wait ? ` — ${x.wait}` : ''}${x.reason ? ` — ${x.reason}` : ''}${x.attach ? ` — ${x.attach}` : ''}${x.costM != null ? ` · ${x.costM} M` : ''}${x.uat ? ` · UAT ${x.uat}` : ''}`),
    ...['done', 'dropped'].map((k) => [k, s.items.filter((x) => closedItem(x) && x.state === k).map((x) => x.id)]).filter(([, ids]) => ids.length).map(([k, ids]) => `- ${k}: ${ids.join(', ')}`),
    ...s.pending.map((p) => `? ${p}`),
  ].join('\n');
}

function cmdReport(main, opts) {
  const f = P(main).report;
  if (!existsSync(f)) return { ok: false, error: 'brak raportu (zlecenie bez odczytu pętli)' };
  const lines = (splitHeader(read(f))?.body ?? read(f)).trim().split(/\r?\n/).filter((l) => l.trim()).slice(0, 30);
  return opts.json ? { ok: true, file: fwd(f), lines } : `${lines.join('\n')}\nfile: ${fwd(f)}`;
}

// Pętla w tle (§4.2): jedna na projekt (`loop.lock`, `wx` i przejęcie po martwym właścicielu); odczyt co `intervalSec` i od
// razu po nowej linii dziennika zdarzeń albo zmianie stanu przez komendę. Czuwanie maszyny, dopóki ktoś pracuje.
export async function runLoop(main, { once = false, interval = null, ops = realOps, maxTicks = Infinity } = {}) {
  if (!readSup(main)) return { ok: true, exit: true, reason: 'no order' };
  const lk = acquireLockFile(loopLockFile(main));
  if (!lk.ok) return { ok: true, running: true, pid: lk.held?.pid ?? null, note: 'pętla już działa' };
  const cfg0 = loadConfig(main);
  const sc = supConfig(cfg0);
  let awake = null;
  let last = null;
  let failures = 0;
  try {
    for (let n = 0; n < maxTicks; n++) {
      // Recenzja S3 (4): błąd ticku (zły config, błąd w kodzie, zajęty plik) nie zabija pętli: wpis w log.md i zdarzenie
      // `supervisor` (reguła `error`), następny odczyt po zwykłej przerwie; po 10 kolejnych błędach koniec pętli z wpisem
      // (wznawia ją `product brief`, `/dwmt:uat` albo komenda supervise).
      try {
        last = tick(main, { ops, cfg: loadConfig(main) });
        failures = 0;
      } catch (e) {
        failures++;
        decide(main, null, 'error', `odczyt pętli nieudany (${failures}/10): ${String(e?.message ?? e).split(/\r?\n/)[0].slice(0, 200)}`);
        last = { exit: failures >= 10, reason: failures >= 10 ? 'tick errors' : 'tick error', working: last?.working ?? false, active: last?.active ?? 0, decisions: [] };
      }
      register(main, last.active ?? 0);
      if (sc.keepAwake && last.working && !awake) awake = keepAwake(process.pid);
      if (awake && !last.working) { awake.stop(); awake = null; }
      if (last.exit) {
        // Recenzja S3 (5): wyrejestrowanie autostartu zawsze przy końcu zlecenia (także po zmianie configu).
        if (last.unregister) autostart(false, autostartArgs(main));
        break;
      }
      if (once) break;
      const ms = (interval ?? sc.intervalSec) * 1000;
      const ev = join(home(), 'events.jsonl');
      const size0 = mtime(ev);
      const st0 = mtime(supFile(main));
      for (let waited = 0; waited < ms; waited += Math.min(1000, ms)) {
        await new Promise((r) => { setTimeout(r, Math.min(1000, ms)); });
        if (mtime(ev) !== size0 || mtime(supFile(main)) !== st0) break;
      }
    }
  } finally {
    if (awake) awake.stop();
    try { rmSync(join(registryDir(), `${taskName(main)}.json`), { force: true }); } catch { /* brak */ }
    if (readLockFile(loopLockFile(main))?.pid === process.pid) rmSync(loopLockFile(main), { force: true });
  }
  return { ok: true, exit: last?.exit ?? false, reason: last?.reason ?? null, decisions: last?.decisions?.length ?? 0 };
}

export async function superviseMain(top, argv) {
  const [cmd, ...rest] = argv;
  const { pos, opts } = parseArgs(rest);
  const main = contextHome(top);
  const cfg = loadConfig(main);
  switch (cmd) {
    case 'order': return cmdOrder(main, cfg, opts, rest);
    case 'status': { const s = statusData(main, cfg); return opts.json ? s : statusText(s); }
    case 'set': return cmdSet(main, cfg, pos);
    case 'hold': return cmdHold(main, pos[0] ?? 'all', true);
    case 'resume': return cmdHold(main, pos[0] ?? 'all', false, { now: !!opts.now });
    case 'answer': return cmdAnswer(main, pos[0], pos[1]);
    case 'report': return cmdReport(main, opts);
    case 'close': return cmdClose(main, cfg);
    case 'run': return runLoop(main, { once: !!opts.once, interval: opts.interval && opts.interval !== true ? Number(one(opts.interval)) : null });
    default: throw new Error('supervise order (--spec <plik…> | --file <plik…> [--after <id…>]) [--sequential] [--presence here|away] [--budget M] [--uat-gate <id…>] | status [--json] | set presence here|away | budget <M>|none | gate <id> on|off | night-limit <n> | hold <id>|all | resume <id> [--now]|all | answer <P-n> <decyzja> | report [--json] | close | run [--once]');
  }
}

export { needsLoop, ensureLoop };

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  superviseMain(topOf(), process.argv.slice(2))
    .then((r) => { if (typeof r === 'string') console.log(r); else printJson(r); if (r && r.ok === false) process.exitCode = 1; })
    .catch((e) => { printJson({ ok: false, error: e.message }); process.exitCode = 1; });
}
