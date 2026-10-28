import './tmp-root.mjs';
// Live sprint view writer (docs/podglad-sprintu.md, part A): snapshot of runs in each status, feed from agent transcripts
// (tool calls only), incremental parsing and cost as sessionsCost, live.js written atomically, one writer per project
// (lock), idle exit, spawn on demand (`ensureLive`, `dwmt state`), worktree discovery, task title translation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync, appendFileSync, rmSync, readdirSync, openSync, writeSync, closeSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { repo, gitIn, cli, header, SCRIPT, DWMT_HOME } from './helpers.mjs';
import { LiveWriter, Transcripts, ensureLive, liveDir, liveLoop, maskSecrets } from '../scripts/lib/live.mjs';
import { sessionsCost } from '../scripts/lib/sessions.mjs';
import { fwd, canonPath } from '../scripts/lib/util.mjs';

process.env.DWMT_HOME = DWMT_HOME;
const STUB = fileURLToPath(new URL('./fixtures-view-claude.mjs', import.meta.url));
const DEAD = 2147483646; // a pid outside the Windows and Linux range
const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const waitFor = (fn, ms = 15e3) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; sleep(50); } return false; };
const put = (f, text) => { mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, text); };
const jsonl = (lines) => `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
const asst = (rid, at, content = [], usage = { input_tokens: 1000, output_tokens: 100 }, extra = {}) => ({ type: 'assistant', requestId: rid, timestamp: at, message: { id: `m-${rid}`, usage, content }, ...extra });
const use = (name, input) => ({ type: 'tool_use', id: `tu-${name}`, name, input });
const liveJs = (file) => { const ctx = { window: {} }; new Script(readFileSync(file, 'utf8')).runInNewContext(ctx); return JSON.parse(JSON.stringify(ctx.window.__dwmtLive)); };
const env = (extra = {}) => ({ ...process.env, CLAUDE_CODE_SESSION_ID: '', DWMT_HOME, DWMT_LIVE: '1', ...extra });
const live = (d, args, extra = {}) => {
  const r = spawnSync(process.execPath, [SCRIPT, 'live', ...args], { cwd: d, encoding: 'utf8', env: env(extra), timeout: 60e3 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* no JSON */ }
  return { code: r.status, json, out: r.stdout + r.stderr };
};

function project({ product = true, cfg = {} } = {}) {
  const d = repo();
  put(join(d, '.claude', 'dwmt.json'), JSON.stringify({ git: { target: 'master' }, ...cfg }));
  if (product) mkdirSync(join(d, 'docs', 'product'), { recursive: true });
  return d;
}
const plan = (id, extra = {}) => `${header({ schema: 'dwmt/plan@1', run: id, goal: 'Orders import from CSV', acceptance: ['AC-1 import works'], tasks: ['T-1', 'T-2'], ...extra })}# Orders import\n\n## Tasks\n### T-1 Read the CSV file\n- Goal: parse\n### T-2 Save orders\n- Goal: save\n`;
const task = (k, o = {}) => ({ k, title: null, baseline: 'b0', started: {}, trees: {}, verified: 0, reviewInput: 0, units: {}, repairs: {}, commit: null, accepted: false, maxRounds: 2, sessions: [], ...o });
// A run of the sprint `s-1` written by hand (the files the writer reads), in `tree`, belonging to the main tree `main`.
function fixture(tree, id, { main = tree, run = {}, files = {} } = {}) {
  const root = join(tree, '.dwmt', 'runs', id);
  mkdirSync(join(root, 'tasks', '1'), { recursive: true });
  const r = {
    schema: 'dwmt/run@1', run: id, rules: '2.9', mode: 'single', phase: 'implement', branch: `dwmt/${id}`, target: 'master', mainTree: fwd(main), sprint: 's-1',
    created: ago(60), plansReady: ago(45), task: 1, count: 2, tasks: [task(1, { title: 'Read the CSV file', startEvent: ago(40), started: { 1: ago(40) } })], session_ids: [], finish: null, updated: ago(0.1), ...run,
  };
  put(join(root, 'run.json'), JSON.stringify(r, null, 2));
  put(join(root, 'plan.md'), plan(id));
  for (const [f, text] of Object.entries(files)) put(join(root, f), text);
  return root;
}
const tests = (cmds) => header({ schema: 'dwmt/tests@1', run: 'x', round: 1, kind: 'targeted', result: cmds.some((c) => c.exit) ? 'fail' : 'pass', commands: cmds });
const review = (verdict, fix = []) => header({ schema: 'dwmt/review@1', round: 1, passes: ['p'], verdict, fix });
const result = (status, extra = {}) => header({ schema: 'dwmt/result@1', status, ...extra });
const build = (d, tr) => new LiveWriter(d, { transcripts: tr }).build();

test('work under the driver: steps of the current task, feed of the agent tool calls (nothing else leaks), cost as sessionsCost', () => {
  const d = project();
  const tr = mkdtempSync(join(tmpdir(), 'dwmt-tr-'));
  const root = fixture(d, 's-1-a', {
    run: {
      phase: 'review', task: 2, session_ids: ['sess-rev'],
      tasks: [
        task(1, { title: 'Read the CSV file', startEvent: ago(50), started: { 1: ago(50) }, verified: 1, commit: 'abc1234def0' }),
        task(2, { title: 'Save orders', startEvent: ago(20), started: { 1: ago(20) }, verified: 1, sessions: ['sess-rev'] }),
      ],
    },
    files: {
      'tasks/1/tests.md': tests([{ cmd: 'npm test', exit: 0, ms: 1000 }]), 'tasks/1/review-1.md': review('PASS'), 'tasks/1/report.md': '# T-1\n',
      'tasks/2/result-1.md': result('DONE'), 'tasks/2/tests.md': tests([{ cmd: 'a', exit: 0, ms: 60e3 }, { cmd: 'b', exit: 0, ms: 60e3 }, { cmd: 'c', exit: 0, ms: 0 }]), 'tasks/2/review-input.md': '# input\n',
      'drive.lock': JSON.stringify({ pid: process.pid }), 'drive.json': JSON.stringify({ pid: process.pid, startedAt: ago(30), children: { 4242: { kind: 'agent', agent: 'dwmt-reviewer', start: ago(2), session: 'sess-rev' } } }),
    },
  });
  put(join(tr, 'proj-a', 'sess-rev.jsonl'), jsonl([
    { type: 'agent-setting', agentSetting: 'dwmt-reviewer', sessionId: 'sess-rev' },
    { type: 'user', timestamp: ago(2), message: { content: 'SECRET-PROMPT review this' } },
    asst('r1', ago(1.9), [{ type: 'thinking', thinking: 'SECRET-THINK' }, use('Read', { file_path: join(d, 'src', 'orders', 'import.ts') })]),
    { type: 'user', timestamp: ago(1.8), message: { content: [{ type: 'tool_result', tool_use_id: 'tu-Read', content: 'SECRET-FILE-CONTENT' }] } },
    asst('r2', ago(1.5), [{ type: 'text', text: 'SECRET-MODEL-TEXT' }, use('Grep', { pattern: 'parseRow', path: join(d, 'src') })]),
    asst('r2', ago(1.5), [use('Agent', { prompt: 'SECRET-SUBAGENT-PROMPT' })]),
    asst('r3', ago(1), [use('Bash', { command: 'npm test -- orders\necho SECRET-SECOND-LINE' })]),
    asst('r4', ago(0.5), [use('Edit', { file_path: join(tmpdir(), 'elsewhere', 'deep', 'x', 'y.ts'), old_string: 'SECRET-OLD', new_string: 'SECRET-NEW' })]),
  ]));
  const S = build(d, tr);
  assert.deepEqual([S.v, S.writer, S.intervalSec, S.language, S.runs.length], [1, 'alive', 5, 'en', 1]);
  const R = S.runs[0];
  assert.deepEqual([R.run, R.sprint, R.goal, R.mode, R.status, R.branch, R.tree, R.reason], ['s-1-a', 's-1', 'Orders import from CSV', 'single', 'work', 'dwmt/s-1-a', fwd(d), null]);
  assert.deepEqual(R.step, { key: 'review', task: 2 });
  assert.deepEqual(R.tasks.map((t) => [t.k, t.title, t.state, t.commit, t.note?.key ?? null]), [[1, 'Read the CSV file', 'done', 'abc1234', 'review-clean'], [2, 'Save orders', 'run', null, null]]);
  assert.deepEqual(R.tasks[1].steps.map((s) => [s.key, s.state]), [['implement', 'done'], ['verify', 'done'], ['review', 'run'], ['commit', 'todo']]);
  assert.deepEqual(R.tasks[1].steps[1].note, { key: 'tests-green', passed: 3, red: 0, total: 3 });
  assert.equal(R.tasks[1].steps[1].min, 2);
  assert.deepEqual(R.pre.map((p) => [p.key, p.state, p.note?.key]), [['plan', 'done', 'plan-ready']]);
  assert.deepEqual(R.post.map((p) => [p.key, p.state]), [['goal-check', 'todo'], ['finish', 'todo']]);
  const tools = R.feed.filter((x) => x.kind !== 'event');
  assert.deepEqual(tools.map((x) => [x.who, x.kind, x.text, x.important]), [
    ['reviewer', 'edit', 'x/y.ts', false], ['reviewer', 'run', 'npm test -- orders', false], ['reviewer', 'search', 'parseRow', false], ['reviewer', 'read', 'src/orders/import.ts', false],
  ]);
  assert.ok(R.feed.some((x) => x.kind === 'event' && x.key === 'tests-green' && x.params.task === 2 && x.important));
  assert.ok(R.feed.some((x) => x.key === 'review-start' && x.who === 'reviewer'));
  assert.ok(R.feed.every((x, i, a) => !i || a[i - 1].at >= x.at), 'newest first');
  assert.doesNotMatch(JSON.stringify(S), /SECRET/);
  const ref = sessionsCost(['sess-rev'], tr);
  assert.equal(R.cost.spentM, ref.total);
  assert.deepEqual(R.cost.byRole, { plan: 0, exec: 0, review: ref.total, orch: 0 });
  assert.equal(R.eta !== null, true, 'one of two tasks committed: a forecast');
  assert.ok(Date.parse(R.eta) > Date.now());
  assert.ok(existsSync(join(root, 'drive.json')));
});

test('waiting for the user: question titles without ids from the plan, since = the question event, plan step waits', () => {
  const d = project();
  const g = gitIn(d);
  assert.equal(cli(d, 'setup').code, 0);
  g('add', '-A');
  g('commit', '-q', '-m', 'setup');
  const run = cli(d, 'preflight', '--slug', 'q').json.run;
  assert.equal(cli(d, 'init', '--run', run).json.ok, true);
  const brief = join(d, '..', `${run}-brief.md`);
  writeFileSync(brief, `${header({ schema: 'dwmt/brief@1', run, goal: 'Add b.txt', mode: 'single', acceptance: ['AC-1 b.txt exists'], scope: ['*.txt'], verify: ['node -e 0'], risk: [], questions: ['Q-1', 'Q-2'] })}# Plan\n\n## Questions\n### Q-1 Should a bad row stop the whole import?\n- Affects: none\n### Q-2: Keep the old number?\n- Affects: none\n\n## Decisions\n### D-1 simple\nplain\n\n## UAT\nUAT: none.\n`);
  const imp = cli(d, 'import-plan', brief, '--run', run);
  assert.equal(imp.json.ok, true, imp.out);
  const st = cli(d, 'state', run);
  assert.equal(st.json.next, 'ask-plan', st.out);
  const R = build(d, mkdtempSync(join(tmpdir(), 'dwmt-tr-'))).runs.find((x) => x.run === run);
  assert.deepEqual([R.status, R.reason, R.step.key, R.step.task], ['waiting-user', 'questions in the plan', 'ask-plan', null]);
  assert.deepEqual(R.questions, ['Should a bad row stop the whole import?', 'Keep the old number?']);
  assert.ok(R.feed.some((x) => x.key === 'question-waiting' && x.params.n === 2 && x.important));
  assert.equal(R.since, R.feed.find((x) => x.key === 'question-waiting').at);
  assert.deepEqual(R.pre.map((p) => [p.key, p.state, p.note?.key]), [['plan', 'wait', 'waiting-user']]);
  assert.deepEqual(R.tasks.map((t) => t.state), ['todo']);
});

test('red tests: verify bad with counts, fix runs (attempt 1), red in the feed from tests.md without machine events', () => {
  const d = project();
  fixture(d, 's-1-red', {
    run: { phase: 'repair', tasks: [task(1, { title: 'Read the CSV file', startEvent: ago(30), started: { 1: ago(30) }, repairs: { 1: ago(3) } })] },
    files: { 'tasks/1/result-1.md': result('DONE'), 'tasks/1/tests.md': tests([{ cmd: 'a', exit: 0 }, { cmd: 'b', exit: 1 }, { cmd: 'c', exit: 1 }, { cmd: 'd', exit: 0 }, { cmd: 'e', exit: 0 }]) },
  });
  const R = build(d, mkdtempSync(join(tmpdir(), 'dwmt-tr-'))).runs[0];
  assert.deepEqual([R.status, R.step.key, R.step.task, R.tasks[0].state], ['work', 'repair', 1, 'run']);
  assert.deepEqual(R.tasks[0].steps.map((s) => [s.key, s.state, s.note]), [
    ['implement', 'done', null], ['verify', 'bad', { key: 'tests-red', passed: 3, red: 2, total: 5 }], ['fix', 'run', { key: 'attempt', n: 1 }], ['review', 'todo', null], ['commit', 'todo', null],
  ]);
  assert.ok(R.feed.some((x) => x.key === 'tests-red' && x.params.task === 1 && x.params.red === 2));
  assert.equal(R.eta, null, 'no committed task: no forecast');
  assert.deepEqual(R.feed.filter((x) => x.kind !== 'event'), [], 'no driver: no tool calls');
});

test('stall: a driver that died without a stop record (dead pid in drive.lock); done: finished run with its report cost', () => {
  const d = project();
  fixture(d, 's-1-dead', { files: { 'drive.lock': JSON.stringify({ pid: DEAD, pidStart: ago(10), start: ago(10) }), 'drive.json': JSON.stringify({ pid: DEAD, startedAt: ago(10), children: {} }) } });
  fixture(d, 's-1-done', {
    run: { phase: 'done', created: ago(90), task: 2, tasks: [task(1, { commit: 'aaaaaaa1' }), task(2, { commit: 'bbbbbbb2' })], finish: { status: 'squashed', at: ago(3), cost: 3.4, commit: 'ccc' } },
  });
  const S = build(d, mkdtempSync(join(tmpdir(), 'dwmt-tr-')));
  const dead = S.runs.find((x) => x.run === 's-1-dead');
  assert.equal(dead.status, 'stall');
  assert.match(dead.reason, /driver died \(pid 2147483646\)/);
  assert.equal(dead.tasks[0].steps.find((s) => s.state === 'run').note.key, 'no-progress');
  assert.ok(dead.feed.some((x) => x.key === 'stall'));
  const done = S.runs.find((x) => x.run === 's-1-done');
  assert.deepEqual([done.status, done.cost.spentM, done.eta, done.post.at(-1).state, done.tasks.map((t) => t.state).join()], ['done', 3.4, null, 'done', 'done,done']);
  assert.ok(done.feed.some((x) => x.key === 'merged'));
});

test('finish stopped on deferred majors (session mode, no driver): waiting for the user, finish step waits with its note, not work or stall', () => {
  const d = project();
  fixture(d, 's-1-defer', {
    run: { phase: 'finish', task: 2, updated: ago(45), tasks: [task(1, { commit: 'aaaaaaa1' }), task(2, { commit: 'bbbbbbb2' })], finish: { status: 'deferred-major', at: ago(45), majors: ['T-1/F-1 [major] Cleanup removes the parent dir'], hint: '1 deferred major findings; accept: dwmt finish s-1-defer --accept-deferred' } },
  });
  const R = build(d, mkdtempSync(join(tmpdir(), 'dwmt-tr-'))).runs.find((x) => x.run === 's-1-defer');
  assert.deepEqual([R.status, R.reason], ['waiting-user', 'finish: deferred-major']);
  const fin = R.post.find((p) => p.key === 'finish');
  assert.deepEqual([fin.state, fin.note?.key], ['wait', 'finish-deferred-major']);
});

test('transcripts: parsed incrementally (only appended bytes, partial last line waits), cost equal to sessionsCost (roles, chain, dedup, subagents)', () => {
  const tr = mkdtempSync(join(tmpdir(), 'dwmt-tr-'));
  const f = join(tr, 'p1', 'main-1.jsonl');
  put(f, jsonl([
    { type: 'agent-setting', agentSetting: 'dwmt-architect', sessionId: 'main-1' },
    asst('a1', '2026-10-15T10:00:00.000Z', [use('Read', { file_path: 'a.ts' })], { input_tokens: 2e5, cache_read_input_tokens: 1e6, output_tokens: 1e4, cache_creation: { ephemeral_5m_input_tokens: 3e4, ephemeral_1h_input_tokens: 1e4 } }),
    asst('a1', '2026-10-15T10:00:01.000Z', [use('Read', { file_path: 'b.ts' })]),
    asst('a2', '2026-10-15T10:00:02.000Z', [], { input_tokens: 5e5 }, { isSidechain: true }),
    { type: 'system', continuedInSessionId: 'main-2' },
  ]));
  put(join(tr, 'p1', 'main-2.jsonl'), jsonl([asst('a1', '2026-10-15T10:01:00.000Z'), asst('a3', '2026-10-15T10:01:01.000Z', [], { input_tokens: 4e5 })]));
  put(join(tr, 'p1', 'main-1', 'subagents', 'agent-x1.jsonl'), jsonl([asst('s1', '2026-10-15T10:00:30.000Z', [use('Grep', { pattern: 'x' })], { input_tokens: 3e5 }, { isSidechain: true })]));
  put(join(tr, 'p1', 'main-1', 'subagents', 'agent-x1.meta.json'), JSON.stringify({ agentType: 'dwmt-explorer' }));
  put(join(tr, 'p2', 'orch-1.jsonl'), jsonl([asst('o1', '2026-10-15T09:00:00.000Z', [], { input_tokens: 1e5, output_tokens: 2e3 })]));
  const T = new Transcripts(tr);
  assert.deepEqual(T.cost(['main-1', 'orch-1', 'drive-x-T1', 'missing']), sessionsCost(['main-1', 'orch-1', 'drive-x-T1', 'missing'], tr));
  assert.equal(T.cost(['main-1']).byRole['dwmt-architect'] > 0 && T.cost(['main-1']).byRole['dwmt-explorer'] > 0, true);
  const win = { from: '2026-10-15T10:00:10.000Z', to: '2026-10-15T10:02:00.000Z' };
  assert.deepEqual(T.cost(['main-1'], win), sessionsCost(['main-1'], tr, win));
  let s = T.scan(f);
  const size1 = readFileSync(f).length;
  assert.deepEqual([s.offset, s.tools.map((x) => x.raw)], [size1, ['a.ts', 'b.ts']]);
  // The first line is changed in place (same length) and a line appended: only the appended bytes are read.
  const text = readFileSync(f, 'utf8');
  writeFileSync(f, text.replace('dwmt-architect', 'dwmt-architekt'));
  appendFileSync(f, JSON.stringify(asst('a4', '2026-10-15T10:03:00.000Z', [use('Write', { file_path: 'c.ts' })])));
  s = T.scan(f);
  assert.deepEqual([s.role, s.tools.map((x) => x.raw)], ['dwmt-architect', ['a.ts', 'b.ts', 'c.ts']], 'a complete last line without a newline counts');
  const fd = openSync(f, 'a');
  writeSync(fd, `\n${JSON.stringify(asst('a5', '2026-10-15T10:04:00.000Z', [use('Glob', { pattern: '**/*.ts' })])).slice(0, 40)}`);
  closeSync(fd);
  s = T.scan(f);
  assert.equal(s.tools.length, 3, 'a partial line waits');
  appendFileSync(f, `${JSON.stringify(asst('a5', '2026-10-15T10:04:00.000Z', [use('Glob', { pattern: '**/*.ts' })])).slice(40)}\n`);
  s = T.scan(f);
  assert.deepEqual(s.tools.map((x) => [x.kind, x.raw]).at(-1), ['search', '**/*.ts']);
  assert.equal(s.offset, readFileSync(f).length);
});

test('dwmt live --once --out: one snapshot printed as JSON, live.js is a classic script setting window.__dwmtLive, no temp files left', () => {
  const d = project({ cfg: { language: 'en', product: { view: { liveIntervalSec: 2 } } } });
  fixture(d, 's-1-once');
  const out = mkdtempSync(join(tmpdir(), 'dwmt-live-out-'));
  const r = live(d, ['--once', '--out', out]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual([r.json.ok, r.json.v, r.json.intervalSec, r.json.runs.length, r.json.runs[0].run, r.json.file], [true, 1, 2, 1, 's-1-once', fwd(join(out, 'live.js'))]);
  const L = liveJs(join(out, 'live.js'));
  assert.deepEqual([L.v, L.writer, L.runs[0].status], [1, 'alive', 'work']);
  assert.deepEqual(readdirSync(out), ['live.js']);
  assert.match(readFileSync(join(out, 'live.js'), 'utf8'), /^window\.__dwmtLive = \{.*\};\n$/s);
  assert.equal(existsSync(liveDir(d)), false, '--out writes nothing into the view directory');
});

test('one writer per project: a second writer exits at once; idle exit (2 polls) with writer "ended" and the lock removed; a stale lock is taken over', async () => {
  const d = project({ cfg: { product: { view: { liveIntervalSec: 0.2 } } } });
  const root = fixture(d, 's-1-lock', { files: { 'drive.lock': JSON.stringify({ pid: process.pid }) } });
  const lock = join(liveDir(d), 'live.lock');
  const a = spawn(process.execPath, [SCRIPT, 'live'], { cwd: d, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  let outA = '';
  a.stdout.on('data', (b) => { outA += b; });
  const exitA = new Promise((res) => a.on('close', res));
  const held = () => { try { return JSON.parse(readFileSync(lock, 'utf8')).pid === a.pid && existsSync(join(liveDir(d), 'live.js')); } catch { return false; } };
  const until = async (fn, ms = 20e3) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((res) => setTimeout(res, 50)); } return false; };
  assert.ok(await until(held), 'writer A holds the lock and writes live.js');
  const t0 = Date.now();
  const b = live(d, []);
  assert.deepEqual([b.code, b.json.exited, b.json.pid], [0, 'lock held', a.pid], b.out);
  assert.ok(Date.now() - t0 < 15e3);
  assert.equal(liveJs(join(liveDir(d), 'live.js')).writer, 'alive');
  // The driver goes and the run waits for the user: two idle polls, final snapshot, lock removed, exit.
  rmSync(join(root, 'drive.lock'));
  const rj = JSON.parse(readFileSync(join(root, 'run.json'), 'utf8'));
  writeFileSync(join(root, 'run.json'), JSON.stringify({ ...rj, phase: 'ask' }));
  const code = await Promise.race([exitA, new Promise((res) => setTimeout(() => res('timeout'), 20e3))]);
  assert.equal(code, 0, outA);
  assert.equal(JSON.parse(outA).exited, 'idle');
  const L = liveJs(join(liveDir(d), 'live.js'));
  assert.deepEqual([L.writer, L.runs[0].status], ['ended', 'waiting-user']);
  assert.equal(existsSync(lock), false);
  // Stale lock (dead holder): taken over, then the same idle exit.
  writeFileSync(lock, JSON.stringify({ pid: DEAD, pidStart: ago(5), start: ago(5) }));
  const c = live(d, []);
  assert.deepEqual([c.code, c.json.exited, c.json.polls], [0, 'idle', 2], c.out);
  assert.equal(existsSync(lock), false);
  assert.equal(liveJs(join(liveDir(d), 'live.js')).writer, 'ended');
});

test('ensureLive: nothing without the product layer, with live false or DWMT_LIVE=0, never throws; spawns `dwmt live` detached otherwise, not while a writer is alive', () => {
  const saved = { live: process.env.DWMT_LIVE, log: process.env.DWMT_PLATFORM_LOG };
  const log = join(mkdtempSync(join(tmpdir(), 'dwmt-plog-')), 'platform.jsonl');
  const spawns = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.fn === 'spawn') : []);
  try {
    process.env.DWMT_LIVE = '1';
    process.env.DWMT_PLATFORM_LOG = log;
    assert.equal(ensureLive(project({ product: false })), null);
    assert.equal(ensureLive(project({ cfg: { product: { view: { live: false } } } })), null);
    assert.equal(ensureLive(project({ cfg: { product: { view: { enabled: false } } } })), null);
    assert.equal(ensureLive(join(tmpdir(), 'no-such-dir', 'x')), null);
    assert.equal(ensureLive('\0bad'), null);
    assert.deepEqual(spawns(), []);
    const d = project();
    const t0 = Date.now();
    assert.deepEqual(ensureLive(d), { pid: null });
    assert.ok(Date.now() - t0 < 2000);
    const sp = spawns();
    assert.equal(sp.length, 1);
    assert.deepEqual([sp[0].cmd, sp[0].args.slice(1), fwd(sp[0].cwd)], [process.execPath, ['live'], canonPath(d)]);
    assert.match(fwd(sp[0].args[0]), /\/scripts\/dwmt\.mjs$/);
    // A live writer (lock with a live pid, fresh live.js): nothing new.
    put(join(liveDir(d), 'live.lock'), JSON.stringify({ pid: process.pid, start: new Date().toISOString() }));
    assert.deepEqual(ensureLive(d, { home: d }), { running: process.pid });
    put(join(liveDir(d), 'live.lock'), JSON.stringify({ pid: DEAD, start: new Date().toISOString() }));
    assert.deepEqual(ensureLive(d, { home: d }), { pid: null });
    process.env.DWMT_LIVE = '0';
    assert.equal(ensureLive(d), null);
    assert.equal(spawns().length, 2);
  } finally {
    for (const [k, v] of [['DWMT_LIVE', saved.live], ['DWMT_PLATFORM_LOG', saved.log]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('dwmt state starts the writer detached and returns at once (no inherited pipe); the writer ends when the run goes idle', () => {
  const d = project({ cfg: { product: { view: { liveIntervalSec: 0.2 } } } });
  const g = gitIn(d);
  assert.equal(cli(d, 'setup').code, 0);
  g('add', '-A');
  g('commit', '-q', '-m', 'setup');
  const run = cli(d, 'preflight', '--slug', 'w').json.run;
  assert.equal(cli(d, 'init', '--run', run).json.ok, true);
  const brief = join(d, '..', `${run}-brief.md`);
  writeFileSync(brief, `${header({ schema: 'dwmt/brief@1', run, goal: 'Add b.txt', mode: 'single', acceptance: ['AC-1 b.txt exists'], scope: ['*.txt'], verify: ['node -e 0'], risk: [], questions: ['Q-1'] })}# Plan\n\n### Q-1 Empty file?\n- Affects: none\n\n## Decisions\n### D-1 simple\nplain\n\n## UAT\nUAT: none.\n`);
  assert.equal(cli(d, 'import-plan', brief, '--run', run).json.ok, true);
  // A live driver (this test process) keeps the writer busy while `state` returns.
  const root = join(d, '.dwmt', 'runs', run);
  writeFileSync(join(root, 'drive.lock'), JSON.stringify({ pid: process.pid }));
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [SCRIPT, 'state', run], { cwd: d, encoding: 'utf8', env: env({ CLAUDE_CODE_SESSION_ID: 'sess-1' }), timeout: 60e3 });
  const took = Date.now() - t0;
  assert.equal(JSON.parse(r.stdout).next, 'ask-plan', r.stdout + r.stderr);
  const lock = join(liveDir(d), 'live.lock');
  assert.ok(waitFor(() => existsSync(lock) && existsSync(join(liveDir(d), 'live.js'))), 'the writer runs');
  const pid = JSON.parse(readFileSync(lock, 'utf8')).pid;
  assert.ok(took < 20e3, `state took ${took} ms`);
  assert.ok(waitFor(() => { try { process.kill(pid, 0); return true; } catch { return false; } }, 1000), 'the writer is still alive after state returned');
  rmSync(join(root, 'drive.lock'));
  assert.ok(waitFor(() => !existsSync(lock), 20e3), 'the writer ends after two idle polls');
  const L = liveJs(join(liveDir(d), 'live.js'));
  assert.deepEqual([L.writer, L.runs[0].status, L.runs[0].questions], ['ended', 'waiting-user', ['Empty file?']]);
});

test('worktrees: runs of the main tree in two trees in one snapshot; runs of other projects, archived copies and old finished runs are left out', () => {
  const d = project();
  const wt = join(mkdtempSync(join(tmpdir(), 'dwmt-wt-')), 'wt');
  gitIn(d)('worktree', 'add', '-q', '-b', 'dwmt/s-2-b', wt);
  fixture(d, 's-1-a');
  fixture(wt, 's-2-b', { main: d, run: { sprint: 's-2' } });
  fixture(wt, 's-3-other', { main: join(tmpdir(), 'other-project') });
  fixture(d, 's-2-b', { run: { archiveOf: fwd(wt), updated: ago(1) } }); // copy of the run in the main tree
  fixture(d, 's-0-old', { run: { phase: 'done', finish: { status: 'squashed', at: ago(120), cost: 1 } } });
  const S = build(d, mkdtempSync(join(tmpdir(), 'dwmt-tr-')));
  assert.deepEqual(S.runs.map((x) => [x.run, x.sprint, x.tree]).sort(), [['s-1-a', 's-1', fwd(d)], ['s-2-b', 's-2', fwd(wt)]]);
});

// T-3 (K3, D-12): the product dir only in a worktree other than the first (the one holding git.target).
function twoTrees() {
  const first = repo();
  const second = join(mkdtempSync(join(tmpdir(), 'dwmt-2t-')), 'second');
  gitIn(first)('worktree', 'add', '-q', '-b', 'feature/x', second);
  put(join(second, '.claude', 'dwmt.json'), JSON.stringify({ git: { target: 'feature/x' } }));
  mkdirSync(join(second, 'docs', 'product'), { recursive: true });
  const run = join(second, '.claude', 'worktrees', 'r');
  gitIn(first)('worktree', 'add', '-q', '-b', 'dwmt/r', run);
  return { first, second, run };
}

test('ensureLive: the writer starts in the run home given by the caller, also from a run worktree, when only that tree has the product dir (D-12, R-2)', () => {
  const saved = { live: process.env.DWMT_LIVE, log: process.env.DWMT_PLATFORM_LOG };
  const log = join(mkdtempSync(join(tmpdir(), 'dwmt-plog-')), 'platform.jsonl');
  const spawns = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.fn === 'spawn') : []);
  try {
    process.env.DWMT_LIVE = '1';
    process.env.DWMT_PLATFORM_LOG = log;
    const { first, second, run } = twoTrees();
    assert.equal(ensureLive(run, { home: first }), null, 'no product dir in the first tree');
    assert.deepEqual(ensureLive(run, { home: second }), { pid: null });
    const sp = spawns();
    assert.equal(sp.length, 1);
    assert.equal(fwd(sp[0].cwd), canonPath(second));
  } finally {
    for (const [k, v] of [['DWMT_LIVE', saved.live], ['DWMT_PLATFORM_LOG', saved.log]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('worktrees: a writer keyed by the second tree lists a run whose homeTree is the second and leaves out one whose homeTree is the first (D-19, R-2)', () => {
  const { first, second, run } = twoTrees();
  fixture(run, 's-1-home', { run: { mainTree: undefined, homeTree: canonPath(second) } });
  fixture(run, 's-2-other', { run: { mainTree: undefined, homeTree: canonPath(first), sprint: 's-2' } });
  const S = build(second, mkdtempSync(join(tmpdir(), 'dwmt-tr-')));
  assert.deepEqual(S.runs.map((x) => [x.run, x.tree]), [['s-1-home', fwd(run)]]);
});

// T-3/F-1 (AC-2, R-2): the `dwmt live` process itself (what ensureLive detaches) writes into the home tree, started
// from the home or from a run worktree whose run.json names that home; nothing lands in the first tree.
test('dwmt live --once from the second tree and from a run worktree writes live.js into the second tree, not the first (D-12, R-2)', () => {
  const { first, second, run } = twoTrees();
  fixture(run, 'r', { run: { mainTree: undefined, homeTree: canonPath(second) } });
  const file = join(liveDir(second), 'live.js');
  for (const from of [second, run]) {
    rmSync(file, { force: true });
    const r = live(from, ['--once']);
    assert.equal(r.code, 0, r.out);
    assert.equal(canonPath(r.json.file), canonPath(file), `from ${from}`);
    assert.deepEqual(liveJs(file).runs.map((x) => x.run), ['r'], `from ${from}`);
    assert.equal(existsSync(liveDir(first)), false, `nothing in the first tree (from ${from})`);
  }
});

test('task titles: translation from the view memory; missing titles go once per run to the cheap model in the background, one retry after a failure', () => {
  const saved = { c: process.env.DWMT_CLAUDE, l: process.env.STUB_LOG, m: process.env.STUB_MODE };
  const log = join(mkdtempSync(join(tmpdir(), 'dwmt-stub-')), 'stub.jsonl');
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length : 0);
  try {
    process.env.DWMT_CLAUDE = STUB;
    process.env.STUB_LOG = log;
    const d = project({ cfg: { language: 'pl' } });
    fixture(d, 's-1-tr', { run: { tasks: [task(1, { title: 'Read the CSV file', startEvent: ago(5), started: { 1: ago(5) } }), task(2, { title: 'Save orders' })] } });
    const tr = mkdtempSync(join(tmpdir(), 'dwmt-tr-'));
    const w = new LiveWriter(d, { transcripts: tr });
    let R = w.build().runs[0];
    assert.deepEqual(R.tasks.map((t) => t.titleTr), [null, null]);
    const req = join(liveDir(d), 'live-translate-s-1-tr.json');
    const mem = join(liveDir(d), 'i18n-pl.json');
    assert.ok(waitFor(() => existsSync(mem) && !existsSync(req), 30e3), 'the background child wrote the memory');
    R = w.build().runs[0];
    assert.deepEqual(R.tasks.map((t) => [t.title, t.titleTr]), [['Read the CSV file', 'PL Read the CSV file'], ['Save orders', 'PL Save orders']]);
    assert.equal(calls(), 1);
    // A failing model: one retry for the run, then no more calls.
    process.env.STUB_MODE = 'bad';
    fixture(d, 's-1-tr2', { run: { tasks: [task(1, { title: 'Export the report', startEvent: ago(5), started: { 1: ago(5) } })] } });
    const req2 = join(liveDir(d), 'live-translate-s-1-tr2.json');
    for (let i = 0; i < 4; i++) {
      w.build();
      assert.ok(waitFor(() => !existsSync(req2), 30e3));
    }
    assert.equal(calls(), 3);
    assert.equal(w.build().runs.find((x) => x.run === 's-1-tr2').tasks[0].titleTr, null);
    assert.deepEqual(JSON.parse(readFileSync(join(liveDir(d), 'live-translate.json'), 'utf8'))['s-1-tr2'].tries, 2);
    const en = project({ cfg: { language: 'en' } });
    fixture(en, 's-1-en');
    assert.equal(new LiveWriter(en, { transcripts: tr }).build().runs[0].tasks[0].titleTr, null);
    assert.equal(calls(), 3, 'language en: no calls');
  } finally {
    for (const [k, v] of [['DWMT_CLAUDE', saved.c], ['STUB_LOG', saved.l], ['STUB_MODE', saved.m]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

// Every file under `dir` (recursive) with its bytes and mtime.
const filesOf = (dir) => {
  const out = {};
  const walk = (d) => { for (const n of readdirSync(d, { withFileTypes: true })) { const f = join(d, n.name); if (n.isDirectory()) walk(f); else out[fwd(f)] = [statSync(f).mtimeMs, readFileSync(f, 'base64')]; } };
  if (existsSync(dir)) walk(dir);
  return out;
};
// Files and dirs under `dir` (and `dir` itself) dated `min` minutes back.
const age = (dir, min) => {
  const t = new Date(Date.now() - min * 60e3);
  const walk = (d) => { for (const n of readdirSync(d, { withFileTypes: true })) { const f = join(d, n.name); if (n.isDirectory()) walk(f); utimesSync(f, t, t); } };
  walk(dir);
  utimesSync(dir, t, t);
};

test('handoff: work while the run shows life, a stall with nothing alive for watch.idleMin (the writer then exits); planned: waits for the merge of other sprints', () => {
  const d = project();
  fixture(d, 's-1-hand', { run: { phase: 'handoff', task: 2, tasks: [task(1, { commit: 'abc1234', startEvent: ago(30), started: { 1: ago(30) } }), task(2)] } });
  const root = fixture(d, 's-1-quiet', { run: { phase: 'handoff', task: 2, updated: ago(45), tasks: [task(1, { commit: 'abc1234', startEvent: ago(90), started: { 1: ago(90) } }), task(2)] } });
  age(root, 45);
  fixture(d, 's-3-plan', { run: { phase: 'planned', sprint: 's-3', after: ['s-1', 's-2'], tasks: [task(1)] } });
  put(join(d, '.dwmt', 'supervisor', 'status', 's-1.json'), JSON.stringify({ state: 'done' }));
  const w = new LiveWriter(d, { transcripts: mkdtempSync(join(tmpdir(), 'dwmt-tr-')) });
  const now = Date.now();
  const S = w.build(now);
  const by = Object.fromEntries(S.runs.map((x) => [x.run, x]));
  assert.deepEqual([by['s-1-hand'].status, by['s-1-hand'].step.key], ['work', 'handoff']);
  assert.deepEqual([by['s-1-quiet'].status, by['s-1-quiet'].step.key], ['stall', 'handoff']);
  assert.match(by['s-1-quiet'].reason, /no progress for 4\d min/);
  assert.deepEqual([by['s-3-plan'].status, by['s-3-plan'].waitingFor, by['s-3-plan'].reason], ['planned', ['s-2'], 'planned: waiting for s-2']);
  assert.deepEqual(by['s-1-hand'].waitingFor, []);
  // Without the live handoff: the stalled one counts as work for 10 min only, the planned one never.
  rmSync(join(d, '.dwmt', 'runs', 's-1-hand'), { recursive: true });
  assert.equal(w.busy, true);
  w.build(now + 60e3);
  assert.equal(w.busy, true, 'a fresh stall keeps the writer');
  w.build(now + 11 * 60e3);
  assert.equal(w.busy, false, 'stalled for 10 min: the writer may exit');
});

test('old runs leave the page: no live driver and no activity for a week, stopped for 30 min; a waiting run from days ago stays', () => {
  const d = project();
  const old = fixture(d, 's-1-old', { run: { phase: 'ask', updated: ago(8 * 1440) } });
  age(old, 8 * 1440);
  const wait = fixture(d, 's-2-wait', { run: { phase: 'ask', sprint: 's-2', updated: ago(3 * 1440) } });
  age(wait, 3 * 1440);
  const drv = fixture(d, 's-3-drv', { run: { phase: 'ask', sprint: 's-3', updated: ago(8 * 1440) }, files: { 'drive.lock': JSON.stringify({ pid: process.pid }) } });
  age(drv, 8 * 1440);
  fixture(d, 's-4-stop', { run: { phase: 'stopped', sprint: 's-4', stopped: { at: ago(40), reason: 'price' } } });
  fixture(d, 's-5-stop', { run: { phase: 'stopped', sprint: 's-5', stopped: { at: ago(5), reason: 'price' } } });
  const S = build(d, mkdtempSync(join(tmpdir(), 'dwmt-tr-')));
  assert.deepEqual(S.runs.map((x) => [x.run, x.status]).sort(), [['s-2-wait', 'waiting-user'], ['s-3-drv', 'waiting-user'], ['s-5-stop', 'stopped']]);
});

test('the writer only observes: polls over runs asking, implementing, direct without a plan and in the batch round leave run dirs and DWMT_HOME untouched', () => {
  const saved = process.env.DWMT_HOME;
  const home = mkdtempSync(join(tmpdir(), 'dwmt-home-ro-'));
  try {
    process.env.DWMT_HOME = home;
    const d = project();
    const ask = (q) => `${result('BLOCKED', { questions: [q] })}\n## Questions\n### ${q} Keep the old totals?\n- Affects: none\n`;
    fixture(d, 's-1-ask', { run: { phase: 'ask' }, files: { 'tasks/1/result-1.md': ask('Q-1') } });
    fixture(d, 's-2-impl', { run: { phase: 'implement', sprint: 's-2' } });
    fixture(d, 's-3-direct', { run: { phase: 'ask', sprint: 's-3', mode: 'direct', rules: '2.10' }, files: { 'task.md': '# Fix totals\n\nThe totals row is wrong.\n', 'tasks/1/result-1.md': ask('Q-1') } });
    rmSync(join(d, '.dwmt', 'runs', 's-3-direct', 'plan.md'));
    fixture(d, 's-4-batch', {
      run: { phase: 'ask', sprint: 's-4', count: 1, tasks: [task(1, { commit: 'abc1234', startEvent: ago(30), started: { 1: ago(30) } })], batch: { baseline: 'b1', items: [{ id: 'F-1', task: 1 }], commit: null } },
      files: { 'batch/result-1.md': ask('Q-2') },
    });
    put(join(home, 'events.jsonl'), `${JSON.stringify({ ts: ago(1), type: 'task-start', project: { name: 'x', root: fwd(d) }, run: 's-2-impl', task: 1 })}\n`);
    put(join(home, 'locks', 'heavy', `0001-${DEAD}.json`), JSON.stringify({ pid: DEAD, run: 's-2-impl', who: 'verify', queued: ago(5), start: ago(5) }));
    const before = { runs: filesOf(join(d, '.dwmt', 'runs')), home: filesOf(home) };
    const w = new LiveWriter(d, { transcripts: mkdtempSync(join(tmpdir(), 'dwmt-tr-')), out: mkdtempSync(join(tmpdir(), 'dwmt-out-')) });
    let S;
    for (let i = 0; i < 3; i++) { S = w.build(); w.write(S); sleep(30); }
    const by = Object.fromEntries(S.runs.map((x) => [x.run, x]));
    assert.deepEqual(['s-1-ask', 's-2-impl', 's-3-direct', 's-4-batch'].map((id) => by[id]?.status), ['waiting-user', 'work', 'waiting-user', 'waiting-user']);
    assert.deepEqual([by['s-1-ask'].questions, by['s-3-direct'].questions, by['s-4-batch'].questions], [['Keep the old totals?'], ['Keep the old totals?'], ['Keep the old totals?']]);
    assert.deepEqual(filesOf(join(d, '.dwmt', 'runs')), before.runs, 'run dirs byte-identical, mtimes unchanged');
    assert.deepEqual(filesOf(home), before.home, 'DWMT_HOME untouched (no machine.json, dead ticket kept, no queue log)');
  } finally { process.env.DWMT_HOME = saved; }
});

test('exit race: work saved after the last idle poll brings the writer back (lock again); a writer that took the lock meanwhile wins', async () => {
  const d = project();
  const root = fixture(d, 's-1-race', { run: { phase: 'ask' } });
  const lock = join(liveDir(d), 'live.lock');
  const phase = (p) => { const rj = JSON.parse(readFileSync(join(root, 'run.json'), 'utf8')); writeFileSync(join(root, 'run.json'), JSON.stringify({ ...rj, phase: p, updated: new Date().toISOString() })); };
  let calls = 0;
  const a = await liveLoop(d, { interval: 0.05, maxPolls: 6, transcripts: mkdtempSync(join(tmpdir(), 'dwmt-tr-')), afterRelease: () => { calls++; assert.equal(existsSync(lock), false); phase('implement'); } });
  assert.deepEqual([a.exited, a.resumed, a.polls, calls], ['polls', 1, 6, 1]);
  assert.equal(existsSync(lock), false);
  assert.equal(liveJs(join(liveDir(d), 'live.js')).writer, 'ended');
  // Back to waiting; a new writer takes the lock in the window: this one exits and leaves that lock alone.
  phase('ask');
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  try {
    const b = await liveLoop(d, { interval: 0.05, transcripts: mkdtempSync(join(tmpdir(), 'dwmt-tr-')), afterRelease: () => { phase('implement'); writeFileSync(lock, JSON.stringify({ pid: other.pid, start: new Date().toISOString() })); } });
    assert.deepEqual([b.exited, b.resumed], ['idle', 0]);
    assert.equal(JSON.parse(readFileSync(lock, 'utf8')).pid, other.pid);
  } finally { other.kill(); rmSync(lock, { force: true }); }
});

test('secrets in commands are masked before they reach the feed', () => {
  const cases = [
    ['API_KEY=abc123 npm test', 'API_KEY=*** npm test'],
    ['export GITHUB_TOKEN="ghp x" && git push', 'export GITHUB_TOKEN=*** && git push'],
    ['$env:DB_PASSWORD = "hunter2"; npm run e2e', '$env:DB_PASSWORD = ***; npm run e2e'],
    ['curl -H "Authorization: Bearer eyJabc.def" https://x.io/api', 'curl -H "Authorization: Bearer ***" https://x.io/api'],
    ["curl -H 'Authorization: token abc' x", "curl -H 'Authorization: token ***' x"],
    ['http GET x Bearer abc.def', 'http GET x Bearer ***'],
    ['mysql -u root -psecret db', 'mysql -u root -p*** db'],
    ['git clone https://user:pa55@example.com/o/r.git', 'git clone https://***@example.com/o/r.git'],
    ['npm test -- --password hunter2 --token=abc --secret "s s" --api-key k1', 'npm test -- --password *** --token=*** --secret *** --api-key ***'],
    ['NODE_ENV=test npm test -- orders', 'NODE_ENV=test npm test -- orders'],
    ['find . -path x -prune -print', 'find . -path x -prune -print'],
    ['docker login -u me --password-stdin', 'docker login -u me --password-stdin'],
  ];
  for (const [a, b] of cases) assert.equal(maskSecrets(a), b, a);
  const d = project();
  const tr = mkdtempSync(join(tmpdir(), 'dwmt-tr-'));
  fixture(d, 's-1-sec', { run: { session_ids: ['sess-x'] }, files: { 'drive.lock': JSON.stringify({ pid: process.pid }), 'drive.json': JSON.stringify({ pid: process.pid, startedAt: ago(5), children: { 1: { kind: 'agent', agent: 'dwmt-executor', start: ago(2), session: 'sess-x' } } }) } });
  put(join(tr, 'p', 'sess-x.jsonl'), jsonl([asst('r1', ago(1), [use('Bash', { command: 'SERVICE_TOKEN=tk-SECRET1 curl -u x https://me:SECRET2@example.com -H "Authorization: Bearer SECRET3"' })])]));
  const R = build(d, tr).runs[0];
  assert.equal(R.feed.find((x) => x.kind === 'run').text, 'SERVICE_TOKEN=*** curl -u x https://***@example.com -H "Authorization: Bearer ***"');
  assert.doesNotMatch(JSON.stringify(R), /SECRET/);
});

// kf2 (D-6, D-9): a run under the supervisor before its first task waits for its item's current dependencies, not its copy.
test('planned under an order: waitingFor comes from the order item of run.sprint, not from the run copy of after', () => {
  const d = project();
  fixture(d, 's-3-plan', { run: { phase: 'planned', sprint: 's-3', after: ['s-1'], tasks: [task(1)] } });
  put(join(d, '.dwmt', 'supervisor', 'status', 's-1.json'), JSON.stringify({ state: 'done' }));
  put(join(d, '.dwmt', 'supervisor', 'supervisor.json'), JSON.stringify({ items: [{ id: 's-2', src: 'file', state: 'running', after: [] }, { id: 's-3', src: 'file', state: 'planned', after: ['s-2'] }] }));
  const S = build(d, mkdtempSync(join(tmpdir(), 'dwmt-tr-')));
  const r = S.runs.find((x) => x.run === 's-3-plan');
  assert.deepEqual([r.status, r.waitingFor, r.reason], ['planned', ['s-2'], 'planned: waiting for s-2']);
});
