import './tmp-root.mjs';
// K5 (D-5, D-7..D-12, D-17): session verdict, launch watcher, stalled runs, read-only state, program not found, verify
// modules and the project registry of accepted red tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DWMT_HOME, SCRIPT, repo, gitIn, cli, put, runFile, prepared, header } from './helpers.mjs';
import { pr, productRepo, write } from './product-helpers.mjs';
import { sessionVerdict } from '../scripts/lib/bg-agent.mjs';
import { watchLaunch } from '../scripts/lib/launch-watch.mjs';
import { assess, stallLine } from '../scripts/watch.mjs';
import { statusData, childEnv as supervisorChildEnv } from '../scripts/supervise.mjs';
import { supFile } from '../scripts/lib/supervisor-loop.mjs';
import { programNotFound, moduleSuite } from '../scripts/lib/verify.mjs';
import { acceptKnownRed, knownRedVerdict, loadKnownRed, redUnits, dropGreenKnownRed } from '../scripts/lib/known-red.mjs';
import { loadConfig } from '../scripts/lib/config.mjs';
import { productConfig } from '../scripts/lib/product-config.mjs';
import { paths, loadItems } from '../scripts/lib/product-store.mjs';

const FAKE = fileURLToPath(new URL('./fixtures-k4bg-claude.mjs', import.meta.url));
const HOOK = fileURLToPath(new URL('../hooks/session-start.mjs', import.meta.url));
const PLATFORM_LOG = join(mkdtempSync(join(tmpdir(), 'dwmt-pl-')), 'platform.jsonl');
process.env.DWMT_PLATFORM_LOG = PLATFORM_LOG;
const platformCalls = () => (existsSync(PLATFORM_LOG) ? readFileSync(PLATFORM_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const events = (run) => (existsSync(join(DWMT_HOME, 'events.jsonl')) ? readFileSync(join(DWMT_HOME, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.run === run) : []);
const rj = (d, run) => JSON.parse(readFileSync(runFile(d, run, 'run.json'), 'utf8'));
const setRun = (d, run, f) => { const j = rj(d, run); f(j); writeFileSync(runFile(d, run, 'run.json'), JSON.stringify(j, null, 2)); };
const mergeCfg = (d, extra) => {
  const f = join(d, '.claude', 'dwmt.json');
  const cur = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(f, JSON.stringify({ ...cur, ...extra, verify: { ...cur.verify, ...extra.verify } }, null, 2));
};

// ---------- D-7: one verdict for the driver and the watcher ----------

test('sessionVerdict: no-start, busy thinking, error, dead, working (R-1)', () => {
  assert.equal(sessionVerdict({ turn: null, row: { status: 'idle' }, elapsedMin: 0.03, firstStepMin: 0.02 }), 'no-start');
  assert.equal(sessionVerdict({ turn: { calls: 0 }, row: { status: 'idle' }, elapsedMin: 6 }), 'no-start');
  // R-1: a busy session without a line yet is still thinking.
  assert.equal(sessionVerdict({ turn: null, row: { status: 'busy' }, elapsedMin: 60, firstStepMin: 5 }), 'working');
  assert.equal(sessionVerdict({ turn: null, row: { status: 'waiting' }, elapsedMin: 60 }), 'working');
  assert.equal(sessionVerdict({ turn: null, row: { status: 'idle' }, elapsedMin: 1, firstStepMin: 5 }), 'working');
  assert.equal(sessionVerdict({ turn: { calls: 1, apiError: 'unknown' }, row: { status: 'idle' } }), 'error');
  assert.equal(sessionVerdict({ turn: { calls: 1, apiError: 'unknown' }, row: { status: 'busy' } }), 'working');
  assert.equal(sessionVerdict({ turn: { calls: 1, apiError: 'rate_limit', limit: true }, row: { status: 'idle' } }), 'working', 'the subscription limit is no session error');
  assert.equal(sessionVerdict({ turn: { calls: 2 }, row: null, gone: true }), 'dead');
  assert.equal(sessionVerdict({ turn: { calls: 2, ended: true }, row: null, gone: true }), 'working');
});

test('config: drive.firstStepMin 5, relaunchDelaySec 30, verify.modules [], knownRedDays 7 by default', () => {
  const d = mkdtempSync(join(tmpdir(), 'dwmt-cfg-'));
  const c = loadConfig(d);
  assert.equal(c.drive.firstStepMin, 5);
  assert.equal(c.drive.relaunchDelaySec, 30);
  assert.deepEqual(c.verify.modules, []);
  assert.equal(c.verify.knownRedDays, 7);
});

// ---------- D-8: launch watcher ----------

function watcherRun(slug) {
  const d = repo();
  const run = prepared(d, slug, 'inline');
  const dir = mkdtempSync(join(tmpdir(), 'dwmt-lw-'));
  // A launched session listed idle, without any transcript line, launched an hour ago.
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ n: 1, rows: { 'bg-1': { id: 'bg-1', sessionId: 'bg-1-0000-sess', name: 'x', kind: 'background', status: 'idle', polls: 0 } } }));
  setRun(d, run, (j) => { j.sprint = `sp-${slug}`; j.launches = [{ id: 'bg-1', at: new Date(Date.now() - 3600e3).toISOString(), task: 1 }]; });
  const env = { ...process.env, DWMT_CLAUDE: FAKE, FAKE_LOG: join(dir, 'calls.jsonl'), FAKE_STATE: join(dir, 'state.json'), DWMT_TRANSCRIPTS: join(dir, 'tr') };
  delete env.CLAUDE_CODE_SESSION_ID;
  return { d, run, env, dir };
}

test('watchLaunch: attempt 1 relaunches once, attempt 2 records sessionFailure no-start, stops and notifies', async () => {
  const a = watcherRun('lw1');
  const launched = [];
  const r1 = await watchLaunch(a.d, a.run, 'bg-1', { attempt: 1, env: a.env, pollMs: 10, launch: (top, id, o) => { launched.push(o.attempt); return { ok: true, id: 'bg-2' }; } });
  assert.equal(r1.result, 'relaunched', JSON.stringify(r1));
  assert.deepEqual(launched, [2]);
  assert.equal(rj(a.d, a.run).sessionFailure, undefined);

  const b = watcherRun('lw2');
  const before = platformCalls().filter((c) => c.fn === 'notify').length;
  const r2 = await watchLaunch(b.d, b.run, 'bg-1', { attempt: 2, env: b.env, pollMs: 10, launch: () => assert.fail('no third start') });
  assert.equal(r2.result, 'failed');
  const sf = rj(b.d, b.run).sessionFailure;
  assert.equal(sf.cause, 'no-start');
  assert.equal(sf.attempts, 2);
  assert.equal(platformCalls().filter((c) => c.fn === 'notify').length, before + 1);
  assert.match(platformCalls().filter((c) => c.fn === 'notify').pop().text, new RegExp(`no-start — /dwmt:execute ${b.run}`));
  const calls = readFileSync(join(b.dir, 'calls.jsonl'), 'utf8');
  assert.match(calls, /"cmd":"stop","id":"bg-1"/, 'the silent session is stopped');
  const status = JSON.parse(readFileSync(join(b.d, '.dwmt', 'supervisor', 'status', `sp-lw2.json`), 'utf8'));
  assert.equal(status.state, 'stopped');
  assert.match(status.reason, /^no-start: /);
  // D-10: no session alive after the failure: the run reads stalled.
  const a2 = assess({ root: join(b.d, '.dwmt', 'runs', b.run), run: { ...rj(b.d, b.run), session_ids: [] }, aliveFn: () => false });
  assert.equal(a2.state, 'stall');
  assert.equal(a2.reason, 'session');
  assert.match(a2.detail, /^no-start: /);
});

test('watchLaunch (F-4): a supervised run leaves the desktop notification to the supervisor (quiet hours, infra resume)', async () => {
  const b = watcherRun('lw3');
  const before = platformCalls().filter((c) => c.fn === 'notify').length;
  const r = await watchLaunch(b.d, b.run, 'bg-1', { attempt: 2, env: { ...b.env, DWMT_SUPERVISED: '1' }, pollMs: 10, launch: () => assert.fail('no third start') });
  assert.deepEqual([r.result, r.notified], ['failed', false]);
  assert.equal(platformCalls().filter((c) => c.fn === 'notify').length, before, 'no direct toast');
  assert.equal(rj(b.d, b.run).sessionFailure.notified, false);
  const status = JSON.parse(readFileSync(join(b.d, '.dwmt', 'supervisor', 'status', 'sp-lw3.json'), 'utf8'));
  assert.equal(status.notified, false, 'the supervisor toasts the stop itself through its quiet-hours queue');
  assert.equal(supervisorChildEnv().DWMT_SUPERVISED, '1', 'the supervisor marks its drivers and launches');
});

test('launch: spawns one detached launch-watch for the new session', () => {
  const d = repo();
  const run = prepared(d, 'ln', 'inline');
  const dir = mkdtempSync(join(tmpdir(), 'dwmt-ln-'));
  const before = platformCalls().filter((c) => c.fn === 'spawn').length;
  const r = spawnSync(process.execPath, [SCRIPT, 'launch', run], {
    cwd: d, encoding: 'utf8',
    env: { ...process.env, DWMT_HOME, CLAUDE_CODE_SESSION_ID: 'sess-1', DWMT_LAUNCH_WATCH: '', DWMT_CLAUDE: FAKE, FAKE_LOG: join(dir, 'calls.jsonl'), FAKE_STATE: join(dir, 'state.json'), DWMT_TRANSCRIPTS: join(dir, 'tr') },
  });
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true, r.stdout + r.stderr);
  const spawns = platformCalls().filter((c) => c.fn === 'spawn').slice(before);
  assert.equal(spawns.length, 1);
  assert.ok(spawns[0].args.includes('launch-watch'));
  assert.ok(spawns[0].args.includes(out.id));
  assert.deepEqual(spawns[0].args.slice(-2), ['--attempt', '1']);
});

// ---------- D-10: stalled from one assess ----------

test('assess (F-3): a run resumed without a driver after a session failure is no longer stalled', () => {
  const t = Date.now() - 120e3;
  const at = new Date(t).toISOString();
  const run = { run: 'r3', phase: 'implementation', task: 1, session_ids: [] };
  const check = (root, r) => {
    // The stop's own write of run.json (right after the failure) is no sign of work.
    writeFileSync(join(root, 'run.json'), '{}');
    utimesSync(join(root, 'run.json'), new Date(t + 500), new Date(t + 500));
    assert.deepEqual([assess({ root, run: r, aliveFn: () => false }).state, assess({ root, run: r, aliveFn: () => false }).reason], ['stall', 'session']);
    // The user resumes by hand (drive-mode off, /dwmt:execute): the task's run files grow after the failure.
    mkdirSync(join(root, 'tasks', '1'), { recursive: true });
    writeFileSync(join(root, 'tasks', '1', 'progress.md'), '## step 1\n');
    const a = assess({ root, run: r, aliveFn: () => false });
    assert.notEqual(a.reason, 'session', JSON.stringify(a));
    assert.equal(a.state, 'working');
  };
  // Case 1: drive.json.stopped of a dead driver.
  const r1 = mkdtempSync(join(tmpdir(), 'dwmt-as3-'));
  writeFileSync(join(r1, 'drive.json'), JSON.stringify({ startedAt: new Date(t - 60e3).toISOString(), stopped: { status: 'stopped', cause: 'agent-error', reason: 'T-1: agent zwrócił błąd', at } }));
  writeFileSync(join(r1, 'drive.lock'), JSON.stringify({ pid: 999999 }));
  check(r1, run);
  // Case 2: run.sessionFailure written by the launch watcher.
  const r2 = mkdtempSync(join(tmpdir(), 'dwmt-as3-'));
  check(r2, { ...run, sessionFailure: { at, cause: 'no-start', error: 'x', attempts: 2 } });
});

test('assess: dead driver stopped by a session failure is stalled at once; watch line and supervisor status say so', () => {
  const root = mkdtempSync(join(tmpdir(), 'dwmt-as-'));
  const at = new Date().toISOString();
  writeFileSync(join(root, 'drive.json'), JSON.stringify({ startedAt: new Date(Date.now() - 60e3).toISOString(), stopped: { status: 'stopped', cause: 'agent-error', reason: 'T-1: agent zwrócił błąd', at } }));
  writeFileSync(join(root, 'drive.lock'), JSON.stringify({ pid: 999999 }));
  const run = { run: 'r1', phase: 'implementation', session_ids: [], updated: Date.now() };
  const a = assess({ root, run, aliveFn: () => false });
  assert.deepEqual([a.state, a.reason], ['stall', 'session']);
  assert.match(a.detail, /^agent-error: /);
  assert.match(stallLine(a, 'r1', 'pl'), /praca agenta przerwana .*\/dwmt:execute r1/);
  assert.match(stallLine(a, 'r1', 'en'), /agent work broke off .*\/dwmt:execute r1/);
  // A limit stop is no session failure.
  writeFileSync(join(root, 'drive.json'), JSON.stringify({ startedAt: at, stopped: { status: 'stopped', cause: 'limit', reason: 'x', at } }));
  assert.notEqual(assess({ root, run, aliveFn: () => false }).reason, 'session');

  const main = mkdtempSync(join(tmpdir(), 'dwmt-sup-'));
  mkdirSync(join(main, '.dwmt', 'supervisor'), { recursive: true });
  writeFileSync(supFile(main), JSON.stringify({ presence: 'here', night: { count: 0 }, pending: [], items: [{ id: 's1', state: 'stopped', reason: 'no-start: x' }, { id: 's2', state: 'stopped', reason: 'stopped: manual' }] }));
  const s = statusData(main, {});
  assert.equal(s.items[0].state, 'stalled');
  assert.equal(s.items[0].reason, 'no-start: x');
  assert.equal(s.items[1].state, 'stopped');
});

test('product brief: a running sprint stopped by a session failure reads (stalled: …)', () => {
  const d = productRepo(repo);
  assert.equal(pr(d, 'roadmap', 'add', 's1', '--goal', 'First').code, 0);
  assert.equal(pr(d, 'spec', 'new', 's1').code, 0);
  assert.equal(pr(d, 'roadmap', 'set', 's1', 'state', 'running').code, 0);
  const dir = join(d, '.dwmt', 'runs', 'r-s1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ schema: 'dwmt/run@1', run: 'r-s1', sprint: 's1', spec: 's1', phase: 'implementation', session_ids: [], tasks: [], created: new Date().toISOString() }));
  writeFileSync(join(dir, 'drive.json'), JSON.stringify({ startedAt: new Date(Date.now() - 60e3).toISOString(), stopped: { status: 'stopped', cause: 'no-start', reason: 'T-1: agent nie zaczął pracy', at: new Date().toISOString() } }));
  const b = pr(d, 'brief');
  assert.match(b.out, /s1 \(stalled: no-start: /, b.out);
});

// ---------- D-11: read-only state ----------

test('state --peek: no registration, no write, no event (R-3); session-start suggests --peek', () => {
  const d = repo();
  const run = prepared(d, 'pk', 'inline');
  setRun(d, run, (j) => { j.sprint = 'sp-pk'; });
  cli(d, 'state', run);
  const runBefore = readFileSync(runFile(d, run, 'run.json'));
  const statusF = join(d, '.dwmt', 'supervisor', 'status', 'sp-pk.json');
  const statusBefore = existsSync(statusF) ? readFileSync(statusF) : null;
  const evBefore = events(run).length;
  const r = spawnSync(process.execPath, [SCRIPT, 'state', run, '--peek'], { cwd: d, encoding: 'utf8', env: { ...process.env, DWMT_HOME, CLAUDE_CODE_SESSION_ID: 'peek-1' } });
  const j = JSON.parse(r.stdout);
  assert.equal(j.peek, true, r.stdout + r.stderr);
  assert.ok(j.next, 'computeState result');
  assert.ok(readFileSync(runFile(d, run, 'run.json')).equals(runBefore), 'run.json bytes equal');
  assert.ok(!rj(d, run).session_ids.includes('peek-1'));
  if (statusBefore) assert.ok(readFileSync(statusF).equals(statusBefore), 'status file bytes equal');
  else assert.ok(!existsSync(statusF));
  assert.equal(events(run).length, evBefore, 'no event');
  const hook = spawnSync(process.execPath, [HOOK], { cwd: d, input: JSON.stringify({ cwd: d }), encoding: 'utf8' }).stdout;
  assert.match(JSON.parse(hook).hookSpecificOutput.additionalContext, /state <run> --peek/);
});

// ---------- D-12: program not found ----------

test('programNotFound: 9009, 127, ENOENT, cmd path text; exit 1 is a test failure', () => {
  assert.equal(programNotFound({ exit: 9009 }), true);
  assert.equal(programNotFound({ exit: 127, output: 'sh: foo: command not found' }), true);
  assert.equal(programNotFound({ exit: -1, output: 'spawn C:/bash.exe ENOENT' }), true);
  assert.equal(programNotFound({ exit: 3, output: 'System nie może odnaleźć określonej ścieżki.' }), true);
  assert.equal(programNotFound({ exit: 3, output: 'The system cannot find the path specified.' }), true);
  assert.equal(programNotFound({ exit: 3, output: '3 tests failed' }), false);
  assert.equal(programNotFound({ exit: 1, output: 'not found' }), false);
  // cmd /c <missing> exits 1 with its own first line (measured: not 9009).
  assert.equal(programNotFound({ exit: 1, output: "'foo' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n" }), true);
  assert.equal(programNotFound({ exit: 1, output: "'foo' nie jest rozpoznawane jako polecenie wewnętrzne lub zewnętrzne,\r\n" }), true);
  assert.equal(programNotFound({ exit: 1, output: "FAIL a.test.ts\nexpected 'x' is not recognized as an internal or external command" }), false, 'only the first line');
  assert.equal(programNotFound({ exit: 0 }), false);
});

function briefVerify(d, run, cmd) {
  const f = runFile(d, run, 'brief.md');
  writeFileSync(f, readFileSync(f, 'utf8').replace(/^verify: .*$/m, `verify: ${JSON.stringify([cmd])}`));
}

test('verify: a missing program gives env with a worktreeSetup hint, no rerun, no repair; exit 1 stays fail with a repair (R-9)', () => {
  const d = repo();
  const run = prepared(d, 'nf', 'inline');
  writeFileSync(join(d, 'b.txt'), 'b\n');
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'DONE' });
  const tests = runFile(d, run, 'tests.md');
  const before = existsSync(tests) ? readFileSync(tests, 'utf8') : null;
  briefVerify(d, run, 'dwmt-no-such-program-k5');
  const v = cli(d, 'verify', run).json;
  assert.equal(v.result, 'env', JSON.stringify(v));
  assert.equal(v.env.length, 1);
  assert.match(v.env[0], /^program not found: dwmt-no-such-program-k5: /);
  assert.match(v.hint, /supervisor\.worktreeSetup/);
  assert.equal(existsSync(tests) ? readFileSync(tests, 'utf8') : null, before, 'tests file untouched');
  const t = rj(d, run).tasks.find((x) => x.k === 1);
  assert.deepEqual(Object.keys(t?.repairs ?? {}), [], 'no repair');

  briefVerify(d, run, 'node -e "process.exit(1)"');
  const v2 = cli(d, 'verify', run).json;
  assert.equal(v2.result, 'fail', JSON.stringify(v2));
  assert.equal(Object.keys(rj(d, run).tasks.find((x) => x.k === 1).repairs ?? {}).length, 1, 'a red test books a repair');
});

// ---------- D-5: modules ----------

test('moduleSuite: changed module only; a code file outside every module runs all (R-5); rerun takes every module', () => {
  const mods = [{ name: 'py', glob: 'py/**', full: ['pytest'] }, { glob: ['java/**'], full: ['mvn test'] }];
  const isCode = (f) => /\.(py|java|ts|mjs)$/.test(f);
  assert.deepEqual(moduleSuite(mods, ['py/a.py'], isCode), { cmds: ['pytest'], ran: ['py'], skipped: ['java/**'], all: false });
  const out = moduleSuite(mods, ['src/x.ts'], isCode);
  assert.deepEqual([out.cmds, out.skipped, out.all], [['pytest', 'mvn test'], [], true]);
  assert.deepEqual(moduleSuite(mods, ['README.md'], isCode).cmds, [], 'a non-code file outside modules adds nothing');
  assert.deepEqual(moduleSuite(mods, null).ran, ['py', 'java/**']);
});

test('verify --full with modules: verify.full plus the changed module, modules in tests-full.md and run.json', () => {
  const d = repo();
  const tag = basename(d);
  mergeCfg(d, { verify: { full: [`node -e "require('fs').appendFileSync('../${tag}-c','c')"`], modules: [
    { name: 'py', glob: 'py/**', full: [`node -e "require('fs').appendFileSync('../${tag}-py','p')"`] },
    { glob: 'java/**', full: [`node -e "require('fs').appendFileSync('../${tag}-java','j')"`] },
  ] }, git: { target: 'master' } });
  const run = prepared(d, 'md', 'inline');
  mkdirSync(join(d, 'py'), { recursive: true });
  writeFileSync(join(d, 'py', 'a.py'), 'x = 1\n');
  gitIn(d)('add', '-A');
  gitIn(d)('commit', '-q', '-m', 'py change');
  const v = cli(d, 'verify', run, '--full').json;
  assert.equal(v.result, 'pass', JSON.stringify(v));
  assert.ok(existsSync(join(d, '..', `${tag}-c`)), 'contract (verify.full) ran');
  assert.ok(existsSync(join(d, '..', `${tag}-py`)), 'py ran');
  assert.ok(!existsSync(join(d, '..', `${tag}-java`)), 'java skipped');
  assert.deepEqual(rj(d, run).fullVerify.modules, { ran: ['py'], skipped: ['java/**'] });
  const tf = readFileSync(runFile(d, run, 'tests-full.md'), 'utf8');
  assert.match(tf, /Modules: ran py; skipped java\/\*\*\./);
});

// ---------- D-17: known red registry ----------

test('known red registry: covered within the expiry, expired after, uncovered unit, green unit dropped (R-4)', () => {
  const home = mkdtempSync(join(tmpdir(), 'dwmt-kr-'));
  const units = redUnits({ failed: ['npm test', 'mvn'], red: { 'npm test': ['a.test.ts'] } });
  assert.deepEqual(units.map((u) => u.key), ['npm test :: a.test.ts', 'mvn']);
  const acc = acceptKnownRed(home, units, { reason: 'env', run: 'r1', days: 7, now: Date.parse('2026-10-01T00:00:00Z'), item: (e) => (e.file ? 'B-7' : null) });
  assert.equal(acc[0].item, 'B-7');
  assert.equal(acc[0].expires, '2026-10-08T00:00:00.000Z');
  const entries = loadKnownRed(home);
  assert.equal(entries.length, 2);
  const at7 = knownRedVerdict(entries, units, Date.parse('2026-10-07T00:00:00Z'));
  assert.deepEqual([at7.covered.length, at7.uncovered, at7.expired.length], [2, [], 0]);
  const at9 = knownRedVerdict(entries, units, Date.parse('2026-10-09T00:00:00Z'));
  assert.equal(at9.expired.length, 2);
  const fresh = knownRedVerdict(entries, [...units, { key: 'npm test :: b.test.ts', cmd: 'npm test', file: 'b.test.ts' }], Date.parse('2026-10-07T00:00:00Z'));
  assert.deepEqual(fresh.uncovered, ['npm test :: b.test.ts'], 'a new red file is never hidden');
  // mvn passes again: its entry goes; npm test still red with a.test.ts keeps its entry.
  const dropped = dropGreenKnownRed(home, ['npm test', 'mvn'], [units[0]]);
  assert.deepEqual(dropped.map((e) => e.key), ['mvn']);
  assert.deepEqual(loadKnownRed(home).map((e) => e.key), ['npm test :: a.test.ts']);
});

// A further sprint in the same repo (setup is committed already).
function next(d, slug) {
  const pf = cli(d, 'preflight', '--slug', slug);
  assert.equal(pf.json.ok, true, pf.out);
  const run = pf.json.run;
  assert.equal(cli(d, 'init', '--run', run).json.ok, true);
  const f = join(d, '..', `${run}-plan.md`);
  writeFileSync(f, `${header({ schema: 'dwmt/brief@1', run, goal: 'Dodaj plik', mode: 'inline', acceptance: ['AC-1 plik istnieje'], scope: ['*.txt'], verify: ['node -e 0'], risk: [] })}# Plan\n\n## Decisions\n### D-1 prosto\nbez udziwnień\n\n## UAT\nUAT: none.\n\nContinue: /dwmt:execute ${run}\n`);
  assert.equal(cli(d, 'import-plan', f, '--run', run).json.ok, true);
  return run;
}

function toCommit(d, run, file) {
  writeFileSync(join(d, file), 'x\n');
  cli(d, 'verify', run);
  cli(d, 'review-input', run);
  put(d, run, 'review-1.md', { schema: 'dwmt/review@1', round: 1, passes: [], verdict: 'PASS', fix: [], acceptance: ['AC-1 met'] });
  assert.equal(cli(d, 'commit', run).json.ok, true);
}

test('finish --accept-red: registry entry with an owner backlog item; later finishes: covered continues, uncovered and expired give red (R-4)', () => {
  const d = productRepo(repo);
  const tag = basename(d);
  const A = `node -e "process.exit(require('fs').existsSync('../${tag}-redA')?1:0)"`;
  const B = `node -e "process.exit(require('fs').existsSync('../${tag}-redB')?1:0)"`;
  mergeCfg(d, { verify: { targeted: ['node -e 0'], full: [A, B] }, git: { target: 'master' } });
  gitIn(d)('add', '-A');
  gitIn(d)('commit', '-q', '-m', 'cfg');
  const redA = join(d, '..', `${tag}-redA`);
  const redB = join(d, '..', `${tag}-redB`);
  writeFileSync(redA, '1');

  const r1 = prepared(d, 'kr1', 'inline');
  toCommit(d, r1, 'k1.txt');
  assert.equal(cli(d, 'finish', r1).json.status, 'red');
  const f1 = cli(d, 'finish', r1, '--accept-red', '--reason', 'env').json;
  assert.equal(f1.status, 'squashed', JSON.stringify(f1));
  const reg = loadKnownRed(d);
  assert.equal(reg.length, 1);
  assert.equal(reg[0].key, A);
  assert.equal(reg[0].reason, 'env');
  assert.match(reg[0].item ?? '', /^B-\d+$/);
  const items = loadItems(paths(d, productConfig(d, loadConfig(d))));
  const owner = [...items.open, ...items.archived].find((x) => x.src === `known-red:${A}`);
  assert.ok(owner, 'owner backlog item');
  assert.equal(owner.id, reg[0].item);

  // Sprint 2: A (accepted) and B (new) red → red with B uncovered; B green again → covered, continues.
  writeFileSync(redB, '1');
  const r2 = next(d, 'kr2');
  toCommit(d, r2, 'k2.txt');
  const f2 = cli(d, 'finish', r2).json;
  assert.equal(f2.status, 'red', JSON.stringify(f2));
  assert.deepEqual(f2.uncovered, [B]);
  rmSync(redB);
  const f2b = cli(d, 'finish', r2).json;
  assert.equal(f2b.status, 'squashed', JSON.stringify(f2b));
  assert.deepEqual(rj(d, r2).fullVerify.knownRed.map((e) => e.key), [A]);

  // Sprint 3 after the expiry: red, the hint names the expired entry and its owner.
  const r3 = next(d, 'kr3');
  toCommit(d, r3, 'k3.txt');
  process.env.DWMT_NOW = new Date(Date.now() + 8 * 864e5).toISOString();
  try {
    const f3 = cli(d, 'finish', r3).json;
    assert.equal(f3.status, 'red', JSON.stringify(f3));
    assert.match(f3.expired[0], new RegExp(`owner ${reg[0].item}`));
    assert.match(f3.hint, /przyjęta czerwień wygasła/);
  } finally { delete process.env.DWMT_NOW; }
});
