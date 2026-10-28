import './tmp-root.mjs';
// S1a: kolejka maszyny (specyfikacja-supervisora.md §7): FIFO między procesami, martwe bilety, sloty, `dwmt heavy`,
// komendy ciężkie w verify, blokada scalania w finish.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseYaml, splitHeader, mergeKey, topOf } from '../scripts/dwmt.mjs';
import { acquire, joinArgs, tickets } from '../scripts/machine.mjs';
import { repo, cli, put, prepared, runFile, DWMT_HOME } from './helpers.mjs';

process.env.DWMT_HOME = DWMT_HOME;
// Home of tickets and queue log; a test may switch to its own (A-3: no tickets left by other tests in its queue).
let homeDir = DWMT_HOME;
const ownHome = async (fn) => {
  const prev = homeDir;
  homeDir = process.env.DWMT_HOME = mkdtempSync(join(tmpdir(), 'dwmt-home-q-'));
  try { return await fn(); } finally { homeDir = process.env.DWMT_HOME = prev; }
};
const MACHINE = pathToFileURL(fileURLToPath(new URL('../scripts/machine.mjs', import.meta.url))).href;
const machine = (cfg) => { mkdirSync(homeDir, { recursive: true }); writeFileSync(join(homeDir, 'machine.json'), JSON.stringify({ pollMs: 40, ...cfg })); };
const logLines = () => (existsSync(join(homeDir, 'queue.log')) ? readFileSync(join(homeDir, 'queue.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const done = (who) => logLines().filter((e) => e.event === 'done' && e.who === who);
const hdr = (f) => parseYaml(splitHeader(readFileSync(f, 'utf8')).yaml);

// Osobny proces z biletem: `got`, gdy go dostał; zwalnia po `hold` ms albo na `release()` (bez zależności od czasu startu
// procesów pod obciążeniem pełnej suity).
function holder(who, { key = 'heavy', slots = 1, hold = 20000 } = {}) {
  const code = `import { acquire } from ${JSON.stringify(MACHINE)};
const l = acquire(${JSON.stringify(key)}, { who: ${JSON.stringify(who)}, cmd: 'x' }, { slots: ${slots} });
console.log('got');
const end = () => { l.release({ exit: 0 }); process.exit(0); };
process.stdin.on('data', end);
setTimeout(end, ${hold});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, DWMT_HOME: homeDir }, stdio: ['pipe', 'pipe', 'inherit'] });
  const got = new Promise((res) => child.stdout.on('data', (b) => { if (String(b).includes('got')) res(Date.now()); }));
  let alive = true;
  const exited = new Promise((res) => child.on('exit', () => { alive = false; res(); }));
  return { got, exited, release: () => child.stdin.write('go\n'), alive: () => alive };
}
// CLI asynchronicznie: czekający proces, podczas gdy test zwalnia holdera.
function cliAsync(d, ...args) {
  const c = spawn(process.execPath, [fileURLToPath(new URL('../scripts/dwmt.mjs', import.meta.url)), ...args], { cwd: d, env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'sess-1', DWMT_HOME: homeDir } });
  let out = '';
  c.stdout.on('data', (b) => { out += b; });
  return new Promise((res) => c.on('exit', (code) => { let json = null; try { json = JSON.parse(out); } catch { /* */ } res({ code, json, out }); }));
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
// Czekający stoi w kolejce (n biletów), potem jeszcze `ms`, i dopiero wtedy holder zwalnia.
const queuedThenRelease = async (h, n, key = 'heavy', ms = 300, wait = 5000) => { await until(() => tickets(key).length === n, wait); await pause(ms); h.release(); };
const until = async (f, ms = 5000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); } };

test('kolejka: FIFO między procesami, czas czekania i dziennik', () => ownHome(async () => {
  machine({});
  const a = holder('A');
  await a.got;
  const b = holder('B', { hold: 50 });
  await until(() => tickets('heavy').length === 2, 20000);
  const c = holder('C', { hold: 50 });
  await queuedThenRelease(a, 3, 'heavy', 300, 20000);
  await Promise.all([a.exited, b.exited, c.exited]);
  const [ea] = done('A'); const [eb] = done('B'); const [ec] = done('C');
  assert.ok(eb.waitMs >= 300, `B czekał ${eb.waitMs} ms`);
  assert.ok(Date.parse(eb.start) >= Date.parse(ea.end), 'B po A');
  assert.ok(Date.parse(ec.start) >= Date.parse(eb.end), 'C po B (FIFO)');
  assert.ok(ea.queued && ea.start && ea.end && typeof ea.ms === 'number', 'kto, co, od kiedy do kiedy');
  assert.deepEqual(tickets('heavy'), []);
}));

test('kolejka: martwy bilet (proces nie żyje) i przeterminowany (pid żyje, ale bilet za stary) są usuwane', () => {
  machine({ staleAfterMin: 60 });
  const dir = join(DWMT_HOME, 'locks', 'heavy');
  mkdirSync(dir, { recursive: true });
  const deadPid = 2147483646; // PID poza zakresem Windows i Linuksa (PID zakończonego procesu bywa od razu użyty ponownie)
  writeFileSync(join(dir, `000000000000001-${deadPid}-0.json`), JSON.stringify({ pid: deadPid, queued: new Date().toISOString(), who: 'martwy' }));
  const old = new Date(Date.now() - 2 * 3600e3).toISOString();
  writeFileSync(join(dir, `000000000000002-${process.ppid}-0.json`), JSON.stringify({ pid: process.ppid, queued: old, start: old, who: 'stary' }));
  writeFileSync(join(dir, `000000000000003-${deadPid}-0.json`), '{"pid":'); // przerwany zapis martwego procesu
  const l = acquire('heavy', { who: 'T' });
  assert.ok(l.waitMs < 500, `czekał ${l.waitMs} ms`);
  l.release();
  // Tylko bilety tego testu: pod obciążeniem całej suity dziennik bywa zawiera martwy bilet holdera z poprzedniego testu
  // (sprząta go następny czekający, zgodnie z projektem kolejki; przyczyna pozostawienia biletu do ustalenia).
  const ev = logLines().filter((e) => ['dead', 'stale'].includes(e.event) && String(e.ticket).startsWith('00000000000000'));
  assert.deepEqual(ev.map((e) => `${e.event} ${e.who ?? '?'}`).sort(), ['dead martwy', 'dead ?', 'stale stary'].sort());
});

test('kolejka: heavySlots 2 wpuszcza dwie komendy naraz; `dwmt queue` pokazuje stan', async () => {
  machine({ heavySlots: 2 });
  const a = holder('A2', { slots: 2 });
  await a.got;
  const q = cli(tmpdir(), 'queue').json;
  assert.equal(q.heavySlots, 2);
  assert.match(q.heavy[0], /^run .* A2: x$/);
  const r = cli(tmpdir(), 'heavy', '--who', 'H2', '--', 'node', '-e', '0');
  assert.equal(r.code, 0);
  assert.ok(a.alive(), 'drugi slot wolny: komenda skończyła się, zanim A zwolnił swój');
  a.release();
  await a.exited;
});

test('dwmt heavy: kod wyjścia komendy, argumenty ze spacją, zagnieżdżenie bez kolejki', async () => {
  machine({});
  const d = mkdtempSync(join(tmpdir(), 'dwmt-h-'));
  assert.equal(cli(d, 'heavy', '--', 'node', '-e', 'process.exit(3)').code, 3);
  assert.equal(cli(d, 'heavy', '--', 'node', '-e', "require('fs').writeFileSync('o.txt', process.argv[1])", 'a b').code, 0);
  assert.equal(readFileSync(join(d, 'o.txt'), 'utf8'), 'a b');
  assert.equal(cli(d, 'heavy').code, 2, 'bez komendy: użycie');
  const [e] = done(`${d.split(/[\\/]/).pop()} manual`);
  assert.equal(e.exit, 3);

  const a = holder('A3');
  await a.got;
  const nested = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/dwmt.mjs', import.meta.url)), 'heavy', '--', 'node', '-e', '0'], { cwd: d, env: { ...process.env, DWMT_HOME, DWMT_HEAVY: 'x' } });
  assert.equal(nested.status, 0);
  assert.ok(a.alive(), 'komenda z DWMT_HEAVY nie czeka na kolejkę, którą już ma rodzic');
  a.release();
  await a.exited;
});

test('joinArgs: POSIX i cmd.exe', () => {
  assert.equal(joinArgs(['mvn verify'], true), 'mvn verify');
  assert.equal(joinArgs(['bash', 'scripts/e2e.sh', "it's a b"], true), `bash scripts/e2e.sh 'it'\\''s a b'`);
  assert.equal(joinArgs(['npm', 'run', 'x', 'C:\\a b\\c'], false), 'npm run x "C:\\a b\\c"');
});

test('verify: komenda z verify.heavy czeka w kolejce (czas w tests.md), zwykła komenda nie czeka', async () => {
  machine({});
  const d = repo();
  cli(d, 'setup');
  const f = join(d, '.claude', 'dwmt.json');
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), verify: { targeted: ['node -e "0" && echo e2e'], heavy: 'e2e', full: ['node -e 0'] } }));
  const run = prepared(d, 'h');
  const a = holder('A4');
  await a.got;
  const pending = cliAsync(d, 'verify', run);
  await queuedThenRelease(a, 2, 'heavy', 300, 20000);
  const v = (await pending).json;
  assert.equal(v.result, 'pass');
  assert.match(v.queue, /s w kolejce maszyny/);
  const h = hdr(runFile(d, run, 'tests.md'));
  assert.deepEqual(h.commands.map((c) => Boolean(c.heavy)), [false, true]);
  assert.ok(h.queueMs >= 300, `queueMs ${h.queueMs}`);
  assert.match(readFileSync(runFile(d, run, 'tests.md'), 'utf8'), /Kolejka maszyny: \d+ s za A4: x/);
  await a.exited;

  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), verify: { targeted: [], heavy: 'e2e', full: ['node -e 0'] } }));
  const b = holder('A5');
  await b.got;
  assert.equal(cli(d, 'verify', run).json.queue, undefined);
  assert.ok(b.alive(), 'bez komendy ciężkiej verify nie czeka');
  assert.equal(hdr(runFile(d, run, 'tests.md')).queueMs, undefined);
  b.release();
  await b.exited;
});

test('finish: blokada scalania na repo i gałąź docelową; pełna suita w kolejce maszyny', async () => {
  machine({});
  const d = repo();
  const run = prepared(d, 'm');
  writeFileSync(join(d, 'b.txt'), 'b\n');
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'DONE' });
  cli(d, 'verify', run);
  cli(d, 'review-input', run);
  put(d, run, 'review-1.md', { schema: 'dwmt/review@1', round: 1, passes: ['correctness'], verdict: 'PASS', fix: [], acceptance: ['AC-1 met'] });
  assert.equal(cli(d, 'commit', run).json.ok, true);
  const { key } = mergeKey(topOf(d), 'master');
  const m = holder('inny finish', { key });
  await m.got;
  const pending = cliAsync(d, 'finish', run);
  await queuedThenRelease(m, 2, key);
  const fin = (await pending).json;
  assert.equal(fin.status, 'squashed');
  assert.ok(fin.mergeWaitMs >= 300, `mergeWaitMs ${fin.mergeWaitMs}`);
  await m.exited;
  const who = `${d.split(/[\\/]/).pop()} ${run} finish`;
  assert.deepEqual(done(who).map((e) => e.key).sort(), ['heavy', key].sort(), 'suita w kolejce ciężkiej, scalanie w blokadzie repo');
  assert.equal(done(who).find((e) => e.key === key).status, 'squashed');
  assert.equal(hdr(runFile(d, run, 'tests-full.md')).queueMs >= 0, true);
});
