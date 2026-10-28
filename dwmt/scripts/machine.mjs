// dwmt: kolejka maszyny (specyfikacja-supervisora.md §7, etap S1a). Ciężkie komendy (e2e, IT, pełna suita) wszystkich
// projektów i ręczne `dwmt heavy -- <komenda>` idą po kolei; `finish` bierze blokadę scalania na repo i gałąź docelową.
// Stan w ~/.dwmt (DWMT_HOME w testach): machine.json (config), locks/<klucz>/<bilet>.json, queue.log (JSON na linię).
// Bilet = plik z pid; kolejność FIFO po nazwie (czas, pid). Właścicielami są pierwsze `slots` żywe bilety.
// Martwy bilet: proces nie żyje albo bilet starszy niż staleAfterMin (pid bywa użyty ponownie na Windows).
// Czekanie jest synchroniczne (Atomics.wait), bo dwmt.mjs uruchamia komendy przez spawnSync.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, appendFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { clearGitMemo } from './lib/git.mjs';

export const home = () => process.env.DWMT_HOME || join(homedir(), '.dwmt');
export const MACHINE_DEFAULTS = { heavySlots: 1, maxActiveSprints: 2, maxTasksPerNight: 2, quietHours: null, staleAfterMin: 240, pollMs: 1000 };

// Pierwsze użycie zapisuje domyślny machine.json, żeby było widać, co można ustawić.
export function machineConfig() {
  const f = join(home(), 'machine.json');
  if (!existsSync(f)) {
    mkdirSync(home(), { recursive: true });
    writeFileSync(f, `${JSON.stringify(MACHINE_DEFAULTS, null, 2)}\n`);
    return { ...MACHINE_DEFAULTS };
  }
  return { ...MACHINE_DEFAULTS, ...JSON.parse(readFileSync(f, 'utf8')) };
}
// Machine settings without writing anything: a missing or broken file means the defaults.
function peekMachineConfig() {
  try { return { ...MACHINE_DEFAULTS, ...JSON.parse(readFileSync(join(home(), 'machine.json'), 'utf8')) }; } catch { return { ...MACHINE_DEFAULTS }; }
}

const lockDir = (key) => join(home(), 'locks', key);
// Windows: plik czytany właśnie przez inny proces daje przy usuwaniu EBUSY/EPERM; bez ponowień zwalniający proces padał
// i zostawiał martwy bilet (niestabilny test FIFO).
const RM = { force: true, maxRetries: 10, retryDelay: 20 };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let seq = 0;

export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function log(entry) {
  mkdirSync(home(), { recursive: true });
  appendFileSync(join(home(), 'queue.log'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

// Bilety w kolejności; martwe usuwa i zapisuje w dzienniku.
// `readOnly` (observers such as `dwmt live`): dead and stale tickets are skipped, not removed or logged, and no default
// machine.json is written.
export function tickets(key, cfg, { readOnly = false } = {}) {
  cfg ??= readOnly ? peekMachineConfig() : machineConfig();
  const dir = lockDir(key);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    let t;
    try { t = JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch (e) {
      if (e.code === 'ENOENT') continue; // zwolniony w międzyczasie
      t = { pid: Number(name.split('-')[1]), who: '?' }; // zapis w toku: bilet jest (pid z nazwy), treść za chwilę
    }
    const ageMin = (Date.now() - Date.parse(t.start || t.seen || t.queued)) / 60e3;
    const reason = !alive(t.pid) ? 'dead' : ageMin > cfg.staleAfterMin ? 'stale' : null;
    if (reason && t.pid !== process.pid) {
      if (readOnly) continue;
      rmSync(join(dir, name), RM);
      log({ event: reason, key, ticket: name, pid: t.pid, who: t.who, cmd: t.cmd, queued: t.queued });
      continue;
    }
    out.push({ ...t, ticket: name });
  }
  return out;
}

const who = (t) => `${t.who}${t.cmd ? `: ${t.cmd}` : ''}`;

// Czeka na miejsce (FIFO) i zwraca dzierżawę z release(). `meta`: who (np. "app verify r2"), cmd, project.
export function acquire(key, meta = {}, { slots = 1, onWait = null } = {}) {
  const cfg = machineConfig();
  const dir = lockDir(key);
  mkdirSync(dir, { recursive: true });
  const name = `${String(Date.now()).padStart(15, '0')}-${String(process.pid).padStart(7, '0')}-${seq++}.json`;
  const file = join(dir, name);
  const queued = new Date().toISOString();
  // `seen` odświeża czekający przy każdym sprawdzeniu, `start` zapisuje właściciel: od nich liczy się wiek biletu.
  const put = (extra) => { try { writeFileSync(file, JSON.stringify({ pid: process.pid, queued, ...meta, ...extra })); } catch { /* następne sprawdzenie */ } };
  writeFileSync(file, JSON.stringify({ pid: process.pid, queued, ...meta }), { flag: 'wx' });
  const t0 = Date.now();
  let told = '';
  let waited = false;
  for (;;) {
    const list = tickets(key, cfg);
    const pos = list.findIndex((t) => t.ticket === name);
    if (pos >= 0 && pos < slots) break;
    waited = true;
    const ahead = list.slice(0, pos < 0 ? list.length : pos).map(who).join('; ');
    if (onWait && ahead !== told) onWait(ahead);
    told = ahead;
    sleep(cfg.pollMs);
    put({ seen: new Date().toISOString() }); // także powrót biletu usuniętego z zewnątrz, na to samo miejsce
  }
  const waitMs = Date.now() - t0;
  if (waited) clearGitMemo(); // another process may have moved branches or worktrees meanwhile
  const start = new Date().toISOString();
  put({ start });
  const behind = told || null;
  let released = false;
  return {
    key, ticket: name, waitMs, behind,
    release(result = {}) {
      if (released) return;
      released = true;
      rmSync(file, RM);
      log({ event: 'done', key, ...meta, queued, start, end: new Date().toISOString(), waitMs, ms: Date.now() - Date.parse(start), ...result });
    },
  };
}

// Dzierżawa na czas funkcji; DWMT_HEAVY w środowisku dzieci mówi zagnieżdżonemu `dwmt heavy`, że kolejka jest już wzięta.
// N-5: dzierżawa jest wielokrotna w obrębie procesu: proces, który już ją trzyma (np. `finish` pod blokadą scalania woła
// `product intake`, który commituje pliki produktu pod tą samą blokadą), nie czeka na samego siebie.
const held = new Set();
// Leases this process holds now (keys).
export const heldLeases = () => [...held];
export function withLease(key, meta, fn, opts = {}) {
  if (held.has(key)) return fn({ key, reentrant: true, waitMs: 0 });
  const lease = acquire(key, meta, opts);
  held.add(key);
  const prev = process.env.DWMT_HEAVY;
  if (key === 'heavy') process.env.DWMT_HEAVY = lease.ticket;
  let out;
  try {
    out = fn(lease);
  } finally {
    if (key === 'heavy') { if (prev === undefined) delete process.env.DWMT_HEAVY; else process.env.DWMT_HEAVY = prev; }
    held.delete(key);
    const pick = out && typeof out === 'object' ? { exit: out.exit, result: out.result, status: out.status } : {};
    lease.release(Object.fromEntries(Object.entries(pick).filter(([, v]) => v !== undefined)));
  }
  return out;
}

export const heavyLease = (meta, fn) => withLease('heavy', meta, fn, {
  slots: machineConfig().heavySlots,
  onWait: (ahead) => process.stderr.write(`dwmt: kolejka maszyny, czekam za: ${ahead}\n`),
});

export function status() {
  const cfg = machineConfig();
  const base = join(home(), 'locks');
  const keys = existsSync(base) ? readdirSync(base) : [];
  const out = {};
  for (const key of keys) {
    const slots = key === 'heavy' ? cfg.heavySlots : 1;
    const list = tickets(key, cfg);
    if (list.length) out[key] = list.map((t, i) => `${i < slots ? 'run ' : 'wait'} ${t.queued} pid ${t.pid} ${who(t)}`);
  }
  const hb = join(home(), 'holds');
  for (const key of existsSync(hb) ? readdirSync(hb) : []) {
    const hs = activeHolds(key);
    if (hs.length) out[`hold ${key}`] = hs.map((h) => `UAT ${h.session}: ${(h.sprints || []).join(', ')} do ${h.until}`);
  }
  return out;
}

// Wstrzymanie scaleń na czas UAT (spec supervisora §10.2): bilet sesji `/dwmt:uat` w ~/.dwmt/holds/<klucz scalania>/.
// Bilet nie ma procesu, który by go zwolnił, więc ma czas ważności (`until`); wygasły usuwa następny odczyt.
const holdDir = (key) => join(home(), 'holds', key);
const holdFile = (key, session) => join(holdDir(key), `${String(session).replace(/[^\w.-]/g, '_')}.json`);

export function activeHolds(key, now = Date.now()) {
  const dir = holdDir(key);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    let h;
    try { h = JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch { continue; }
    if (!(Date.parse(h.until) > now)) {
      rmSync(join(dir, name), RM);
      log({ event: 'hold-expired', key, session: h.session, sprints: h.sprints, until: h.until });
      continue;
    }
    out.push(h);
  }
  return out;
}

export const readHold = (key, session) => activeHolds(key).find((h) => h.session === session) ?? null;

export function putHold(key, hold) {
  mkdirSync(holdDir(key), { recursive: true });
  writeFileSync(holdFile(key, hold.session), `${JSON.stringify(hold, null, 2)}\n`);
}

export const dropHold = (key, session) => rmSync(holdFile(key, session), RM);

// Wszystkie bilety sesji (`uat release` bez wskazania klucza).
export function dropSessionHolds(session) {
  const base = join(home(), 'holds');
  const out = [];
  for (const key of existsSync(base) ? readdirSync(base) : []) {
    if (existsSync(holdFile(key, session))) { dropHold(key, session); out.push(key); }
  }
  return out;
}

// ---------- zajęte porty (v2.10, C) ----------
// sprint 10: port 5173 zajęty przez Vite innego projektu, E2E biegło przeciw cudzej aplikacji. Komendy z `verify.ports`
// (`[{for: "<regex komendy>", ports: [5173]}]`) przed uruchomieniem sprawdzają porty; zajęty → wynik `env` z PID i linią
// polecenia właściciela (Windows: netstat + PowerShell/tasklist; Linux/Mac: lsof + ps; bez narzędzia samo „zajęty”).
// Zajętość: udane połączenie TCP na 127.0.0.1 albo ::1 (Vite słucha bywa tylko na ::1).
const PROBE = `const net=require('net');const p=+process.argv[1];let left=2,busy=false;
for(const h of ['127.0.0.1','::1']){const s=net.connect({host:h,port:p});s.setTimeout(1500);
const done=(b)=>{if(b)busy=true;s.destroy();if(--left===0)process.exit(busy?0:1)};
s.on('connect',()=>done(true));s.on('error',()=>done(false));s.on('timeout',()=>done(false));}`;

export function portBusy(port) {
  const r = spawnSync(process.execPath, ['-e', PROBE, String(port)], { encoding: 'utf8', timeout: 10e3, windowsHide: true });
  return r.status === 0;
}

const tool = (bin, args) => {
  try { const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 15e3, windowsHide: true }); return r.status === 0 ? r.stdout : null; } catch { return null; }
};

export function netstatListenPid(text, port) {
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+(\S+):0\s+\S+\s+(\d+)\s*$/i.exec(line);
    if (m && Number(m[2]) === Number(port)) return Number(m[4]);
  }
  return null;
}

// PID procesu słuchającego na porcie (pierwszy) albo null, gdy narzędzia nie ma lub nic nie znalazło.
// Windows: Get-NetTCPConnection (stan `Listen` niezależny od języka systemu); bez niego netstat, gdzie nasłuch poznaje się
// po adresie obcym `:0` (słowo LISTENING jest tłumaczone, np. NASŁUCHIWANIE).
export function portPid(port) {
  if (process.platform === 'win32') {
    const ps = tool('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`]);
    const pid = Number(String(ps ?? '').trim());
    if (Number.isInteger(pid) && pid > 0) return pid;
    return netstatListenPid(`${tool('netstat', ['-ano', '-p', 'TCP']) ?? ''}\n${tool('netstat', ['-ano', '-p', 'TCPv6']) ?? ''}`, port);
  }
  const out = tool('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  const pid = out ? Number(out.split(/\s+/).find(Boolean)) : NaN;
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function processCommand(pid) {
  if (!pid) return null;
  if (process.platform === 'win32') {
    const ps = tool('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`]);
    if (ps && ps.trim()) return ps.trim();
    const tl = tool('tasklist', ['/FI', `PID eq ${Number(pid)}`, '/FO', 'CSV', '/NH']);
    const m = tl && /^"([^"]+)"/.exec(tl.trim());
    return m ? m[1] : null;
  }
  const out = tool('ps', ['-o', 'args=', '-p', String(pid)]);
  return out && out.trim() ? out.trim() : null;
}

// Porty z `verify.ports` dla danych komend; zwraca zajęte z właścicielem (o ile da się go ustalić).
export function busyPorts(cmds, rules, { busy = portBusy, owner = (p) => { const pid = portPid(p); return { pid, cmd: processCommand(pid) }; } } = {}) {
  const ports = [];
  for (const r of Array.isArray(rules) ? rules : []) {
    if (!r || !Array.isArray(r.ports)) continue;
    let re = null;
    try { re = r.for ? new RegExp(r.for) : null; } catch { continue; }
    if (!re || cmds.some((c) => re.test(c))) for (const p of r.ports) if (!ports.includes(Number(p))) ports.push(Number(p));
  }
  return ports.filter((p) => Number.isInteger(p) && p > 0 && busy(p)).map((port) => ({ port, ...owner(port) }));
}

// Łączenie argumentów w jedną komendę powłoki: POSIX (Git Bash, sh) albo cmd.exe.
export function joinArgs(args, posix) {
  if (args.length === 1) return args[0];
  const safe = /^[\w@%+=:,./\\-]+$/;
  return args.map((a) => (safe.test(a) ? a : posix ? `'${a.replace(/'/g, `'\\''`)}'` : `"${a.replace(/"/g, '""')}"`)).join(' ');
}

// `dwmt heavy [--shell <powłoka>] [--who <opis>] -- <komenda…>`: komenda w kolejce maszyny, wyjście i kod komendy.
// Powłoka: --shell (skrót `dwmt` z Git Bash podaje bash), inaczej cmd.exe na Windows i /bin/sh gdzie indziej.
export function heavyMain(argv) {
  const sep = argv.indexOf('--');
  const opts = sep < 0 ? argv : argv.slice(0, sep);
  const args = sep < 0 ? [] : argv.slice(sep + 1);
  if (!args.length) {
    process.stderr.write('użycie: dwmt heavy [--shell <powłoka>] [--who <opis>] -- <komenda…>\n');
    return 2;
  }
  const opt = (k) => { const i = opts.indexOf(`--${k}`); return i >= 0 ? opts[i + 1] : null; };
  const shell = opt('shell');
  const cmd = joinArgs(args, Boolean(shell) || process.platform !== 'win32');
  const run = () => {
    const r = shell ? spawnSync(shell, ['-c', cmd], { stdio: 'inherit', windowsHide: true }) : spawnSync(cmd, { stdio: 'inherit', shell: true, windowsHide: true });
    return { exit: r.status ?? 1 };
  };
  if (process.env.DWMT_HEAVY) return run().exit; // wywołanie z komendy, która już ma kolejkę (np. e2e.sh z verify)
  // Projekt = korzeń repo (e2e projektu startuje w frontend/), poza repo katalog bieżący.
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true });
  const project = basename(top.status === 0 ? top.stdout.trim() : process.cwd());
  const r = heavyLease({ who: opt('who') || `${project} manual`, cmd, project }, (lease) => {
    if (lease.waitMs >= 1000) process.stderr.write(`dwmt: kolejka wolna po ${Math.round(lease.waitMs / 1000)} s, start\n`);
    // Ctrl+C w trakcie komendy: zwolnij bilet od razu (w czasie czekania pętla blokuje sygnały; martwy bilet sprząta następny).
    const stop = () => { lease.release({ exit: 130, interrupted: true }); process.exit(130); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    try { return run(); } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  });
  return r.exit;
}
