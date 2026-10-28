import './tmp-root.mjs';
// K7 supervisor lanes (D-6, D-7, D-8, D-14, D-18): sprints of one workplace (target branch) run one after another,
// different target branches implement in parallel within maxActiveSprints, a dirty workplace tree holds its next sprint,
// `supervise resume <id> --now` lifts the dependency waits of that one item, the done notification says ready to push.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { repo, gitIn, SCRIPT, DWMT_HOME } from './helpers.mjs';
import { pr } from './product-helpers.mjs';
import { renderRoadmap } from '../scripts/lib/product-store.mjs';
import { emit } from '../scripts/events.mjs';
import { tick } from '../scripts/supervise.mjs';
import { readSup } from '../scripts/lib/supervisor-loop.mjs';
import { currentAfter, runDepsNow, depMerged } from '../scripts/lib/deps.mjs';

const PLATFORM_LOG = join(mkdtempSync(join(tmpdir(), 'dwmt-plat-')), 'platform.jsonl');
const NO_TR = mkdtempSync(join(tmpdir(), 'dwmt-tr-k7s-'));
Object.assign(process.env, { DWMT_HOME, DWMT_PLATFORM_LOG: PLATFORM_LOG, DWMT_SUPERVISE_NOSPAWN: '1', DWMT_TRANSCRIPTS: NO_TR });
const ENV = { ...process.env };
const fwd = (p) => String(p).replace(/\\/g, '/');

const row = (id, state = 'ready', after = []) => ({ id, state, goal: `Goal ${id}`, after, detail: `sprints/${id}.md`, alias: null, current: false });
const wpRecord = (name, path, sprints) => ({ name, branch: name, path: fwd(path), base: { ref: 'master', commit: null, at: '2026-10-26T00:00:00.000Z' }, created: '2026-10-26T00:00:00.000Z', sprints, state: 'active', at: '2026-10-26T00:00:00.000Z' });

// ---------- currentAfter: product layer without git (pattern: deps-now.test.mjs#main) ----------

function product({ rows, workplaces = [], sup = null }) {
  const d = mkdtempSync(join(tmpdir(), 'dwmt-k7s-'));
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude', 'dwmt.json'), JSON.stringify({ product: {} }));
  mkdirSync(join(d, 'docs', 'product'), { recursive: true });
  writeFileSync(join(d, 'docs', 'product', 'roadmap.md'), renderRoadmap(rows));
  writeFileSync(join(d, 'docs', 'product', 'workplaces.jsonl'), workplaces.map((w) => `${JSON.stringify(w)}\n`).join(''));
  if (sup) {
    mkdirSync(join(d, '.dwmt', 'supervisor'), { recursive: true });
    writeFileSync(join(d, '.dwmt', 'supervisor', 'supervisor.json'), JSON.stringify(sup));
  }
  return d;
}

test('K7 currentAfter: a workplace sprint depends on the nearest earlier roadmap row of its workplace; others unchanged', () => {
  const d = product({ rows: [row('s1'), row('m0'), row('s2'), row('s3')], workplaces: [wpRecord('abc', 'C:/nowhere/abc', ['s1', 's2'])] });
  const sup = { items: [] };
  assert.deepEqual(currentAfter(d, { id: 's2', src: 'spec', after: [] }, { sup }), ['s1']);
  assert.deepEqual(currentAfter(d, { id: 's1', src: 'spec', after: [] }, { sup }), [], 'first of its workplace');
  assert.deepEqual(currentAfter(d, { id: 's3', src: 'spec', after: [] }, { sup }), [], 'no workplace');
  assert.deepEqual(currentAfter(d, { id: 'm0', src: 'spec', after: [] }, { sup }), [], 'main tree');
  // Already in the roadmap after: not added twice.
  const d2 = product({ rows: [row('s1'), row('s2', 'ready', ['s1'])], workplaces: [wpRecord('abc', 'C:/nowhere/abc', ['s1', 's2'])] });
  assert.deepEqual(currentAfter(d2, { id: 's2', src: 'spec', after: [] }, { sup }), ['s1']);
  // A removed workplace is no lane.
  const d3 = product({ rows: [row('s1'), row('s2')], workplaces: [{ ...wpRecord('abc', 'C:/nowhere/abc', ['s1', 's2']), state: 'removed' }] });
  assert.deepEqual(currentAfter(d3, { id: 's2', src: 'spec', after: [] }, { sup }), []);
});

test('K7 R-4 early start: overrides.after → currentAfter [] and the driver\'s runDepsNow(...).after []', () => {
  const items = [{ id: 's1', src: 'spec', after: [] }, { id: 's2', src: 'spec', after: ['s1'], overrides: { after: true } }];
  const d = product({ rows: [row('s0'), row('s1'), row('s2', 'ready', ['s0'])], workplaces: [wpRecord('abc', 'C:/nowhere/abc', ['s1', 's2'])], sup: { items } });
  assert.deepEqual(currentAfter(d, items[1]), []);
  assert.deepEqual(currentAfter(d, { ...items[1], overrides: {} }), ['s0', 's1'], 'without the override: roadmap after plus the lane');
  const run = { sprint: 's2', after: ['s1'], order: [], task: 1, tasks: [{ started: {} }] };
  assert.deepEqual(runDepsNow(d, run).after, []);
});

// ---------- the loop through tick with fake ops (pattern: s3.test.mjs#world) ----------

function sv(d, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, 'supervise', ...args], { cwd: d, encoding: 'utf8', env: ENV });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* text */ }
  return { code: r.status, json, out: r.stdout + r.stderr };
}

// Project with an order of roadmap items, workplaces with their own worktrees, fake driver ops.
function world({ ids, rows, workplaces = {}, presence = 'away' }) {
  const main = repo();
  mkdirSync(join(main, '.claude'), { recursive: true });
  writeFileSync(join(main, '.claude', 'dwmt.json'), JSON.stringify({ drive: { enabled: true }, git: { target: 'master' }, product: {} }));
  gitIn(main)('add', '-A');
  gitIn(main)('commit', '-q', '-m', 'cfg');
  const trees = {};
  const recs = [];
  for (const [name, sprints] of Object.entries(workplaces)) {
    const t = join(mkdtempSync(join(tmpdir(), 'dwmt-wpt-')), name);
    gitIn(main)('worktree', 'add', '-q', '-b', name, t);
    trees[name] = t;
    recs.push(wpRecord(name, t, sprints));
  }
  const alive = new Set();
  const calls = [];
  let pid = 710000 + Math.floor(Math.random() * 9000) * 10;
  const w = { main, calls, trees };
  w.ops = {
    alive: (p) => alive.has(Number(p)),
    prepare(m, it, mode) {
      calls.push(['prepare', it.id, mode]);
      const root = join(m, '.dwmt', 'runs', `r-${it.id}`);
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'run.json'), JSON.stringify({ run: `r-${it.id}`, sprint: it.id, session_ids: [] }));
      return { ok: true, run: `r-${it.id}`, worktree: fwd(m), root: fwd(root), warnings: [] };
    },
    startDriver(it) {
      const p = ++pid;
      alive.add(p);
      calls.push(['drive', it.id, existsSync(join(it.root, 'drive.hold'))]);
      writeFileSync(join(it.root, 'drive.lock'), JSON.stringify({ pid: p }));
      writeFileSync(join(it.root, 'drive.json'), JSON.stringify({ pid: p, startedAt: it.driveAt }));
      return { ok: true, pid: p };
    },
    launch(m, it) { const id = `sess-${calls.length}`; calls.push(['launch', it.id, id]); return { ok: true, id }; },
    stopSession(id) { calls.push(['stop-session', id]); return true; },
    push(m, text) { calls.push(['push', text]); return `push-${calls.length}`; },
    notify(text) { calls.push(['notify', text]); return true; },
    mergeCleared: () => false,
    probe: () => ({ ok: true }),
    quiet: () => false,
  };
  w.tick = () => tick(main, { ops: w.ops, now: Date.now() });
  w.item = (id) => readSup(main).items.find((x) => x.id === id);
  w.root = (id) => join(main, '.dwmt', 'runs', `r-${id}`);
  w.has = (kind, id) => calls.filter((c) => c[0] === kind && (id == null || c[1] === id));
  w.notifies = (re) => w.has('notify').filter((c) => re.test(c[1]));
  w.log = () => readFileSync(join(main, '.dwmt', 'supervisor', 'log.md'), 'utf8');
  w.rows = (rs) => writeFileSync(join(main, 'docs', 'product', 'roadmap.md'), renderRoadmap(rs));
  w.put = (id, fields) => {
    const f = join(main, '.dwmt', 'supervisor', 'supervisor.json');
    const sup = JSON.parse(readFileSync(f, 'utf8'));
    Object.assign(sup.items.find((x) => x.id === id), fields);
    writeFileSync(f, JSON.stringify(sup));
  };
  w.status = (id, obj) => { mkdirSync(join(main, '.dwmt', 'supervisor', 'status'), { recursive: true }); writeFileSync(join(main, '.dwmt', 'supervisor', 'status', `${id}.json`), JSON.stringify({ schema: 'dwmt/status@1', sprint: id, run: `r-${id}`, at: new Date().toISOString(), events: [], ...obj })); };
  // The driver ends with a done stop (as Driver.stop), lock removed.
  w.done = (id) => {
    w.status(id, { state: 'done', result: 'PASS', uat: 'n/a' });
    const mem = JSON.parse(readFileSync(join(w.root(id), 'drive.json'), 'utf8'));
    alive.delete(Number(mem.pid));
    rmSync(join(w.root(id), 'drive.lock'), { force: true });
    mem.stopped = { status: 'done', reason: 'done', at: new Date(Date.parse(mem.startedAt) + 1000).toISOString() };
    writeFileSync(join(w.root(id), 'drive.json'), JSON.stringify(mem));
    emit({ type: 'drive-stop', project: main, run: `r-${id}`, detail: { status: 'done' } });
  };
  const dir = mkdtempSync(join(tmpdir(), 'dwmt-k7sp-'));
  for (const id of ids) writeFileSync(join(dir, `${id}.md`), `Sprint ${id}: do ${id}.\n`);
  const o = sv(main, 'order', '--file', ...ids.map((id) => join(dir, `${id}.md`)), '--after', '--presence', presence);
  assert.equal(o.json?.ok, true, o.out);
  assert.equal(pr(main, 'init', '--goal', 'Pilot').code, 0);
  w.rows(rows);
  writeFileSync(join(main, 'docs', 'product', 'workplaces.jsonl'), recs.map((r) => `${JSON.stringify(r)}\n`).join(''));
  for (const id of ids) w.put(id, { src: 'spec' });
  return w;
}

test('K7 R-1: two sprints of one workplace never implement at once; the second starts once the first is done', () => {
  const w = world({ ids: ['w1', 'w2'], rows: [row('w1'), row('w2')], workplaces: { abc: ['w1', 'w2'] } });
  w.tick();
  assert.equal(w.has('prepare', 'w1').length, 1, w.log());
  assert.equal(w.has('prepare', 'w2').length, 0);
  assert.deepEqual(w.item('w2').after, ['w1']);
  assert.deepEqual([w.item('w2').wait?.rule, w.item('w2').wait?.text], ['after', 'czeka na scalenie: w1']);
  w.tick();
  assert.equal(w.has('prepare', 'w2').length, 0, 'still waiting while w1 runs');
  w.done('w1');
  w.tick();
  assert.equal(w.item('w1').state, 'done', w.log());
  assert.equal(w.has('prepare', 'w2').length, 1, w.log());
  assert.equal(w.has('drive', 'w2')[0]?.[2], false, 'implements: no drive.hold');
});

test('K7 R-2: sprints of different target branches implement in parallel; a third lane waits at maxActiveSprints', () => {
  const w = world({ ids: ['m1', 'w1', 'x1'], rows: [row('m1'), row('w1'), row('x1')], workplaces: { abc: ['w1'], xyz: ['x1'] } });
  w.tick();
  assert.equal(w.item('m1').state, 'running', w.log());
  assert.equal(w.item('w1').state, 'running', w.log());
  assert.deepEqual([w.item('m1').planOnly, w.item('w1').planOnly], [false, false]);
  assert.deepEqual(w.has('drive').map((c) => [c[1], c[2]]), [['m1', false], ['w1', false]], 'both implement, no drive.hold');
  assert.equal(w.item('x1').wait?.rule, 'machine');
  assert.equal(w.has('prepare', 'x1').length, 0);
});

test('K7 R-6 lane: a second main-tree sprint still waits R2 while one implements (same lane as before)', () => {
  const w = world({ ids: ['m1', 'm2'], rows: [row('m1'), row('m2')] });
  w.tick();
  assert.equal(w.item('m1').state, 'running');
  assert.equal(w.item('m2').wait?.rule, 'R2');
  assert.match(w.item('m2').wait.text, /w projekcie pracuje m1/);
});

test('K7 R-3: a dirty workplace tree holds its next sprint with one notification; a clean tree lets it start', () => {
  const w = world({ ids: ['w1'], rows: [row('w1')], workplaces: { abc: ['w1'] } });
  const f = join(w.trees.abc, 'scratch.txt');
  writeFileSync(f, 'x\n');
  w.tick();
  w.tick();
  assert.equal(w.item('w1').wait?.rule, 'workplace', w.log());
  assert.match(w.item('w1').wait.text, /uncommitted changes: scratch\.txt/);
  assert.equal(w.has('prepare', 'w1').length, 0);
  assert.equal(w.notifies(/w1: nie startuje/).length, 1, 'one notification over two ticks');
  rmSync(f);
  w.tick();
  assert.equal(w.has('prepare', 'w1').length, 1, w.log());
  assert.equal(w.item('w1').wpBlock, null);
});

test('K7 planRelease per lane: a planning-only workplace sprint is released while a main-tree sprint implements in the same areas', () => {
  const w = world({ ids: ['m1', 'w1'], rows: [row('m1'), row('w1')], workplaces: { abc: ['w1'] } });
  w.tick();
  assert.equal(w.item('w1').state, 'running', w.log());
  w.status('m1', { state: 'running', stage: 'implement', scope: ['src/a.ts'] });
  w.status('w1', { state: 'running', stage: 'planning', scope: ['src/a.ts'] });
  w.put('m1', { taskStarted: true });
  w.put('w1', { planOnly: true, planRule: 'R2' });
  writeFileSync(join(w.root('w1'), 'drive.hold'), 'R2\n');
  w.tick();
  assert.equal(w.item('w1').planOnly, false, w.log());
  assert.match(w.log(), /w1 \[R2\] start „tylko planowanie” zwolniony/);
  assert.ok(!existsSync(join(w.root('w1'), 'drive.hold')));
});

test('K7 R-4 loop: supervise resume <id> --now starts a sprint waiting on its workplace predecessor; logged', () => {
  const w = world({ ids: ['w1', 'w2'], rows: [row('w1'), row('w2')], workplaces: { abc: ['w1', 'w2'] } });
  w.tick();
  assert.equal(w.item('w2').wait?.rule, 'after');
  const r = sv(w.main, 'resume', 'w2', '--now');
  assert.equal(r.json?.ok, true, r.out);
  assert.equal(w.item('w2').overrides?.after, true);
  assert.match(w.log(), /w2 \[after\] start na polecenie \(supervise resume w2 --now\): zależności w1 pominięte/);
  w.tick();
  assert.deepEqual(w.item('w2').after, []);
  assert.equal(w.has('prepare', 'w2').length, 1, w.log());
  assert.equal(w.has('drive', 'w2')[0]?.[2], false, 'the user\'s order: no lane wait, implements');
  assert.equal(sv(w.main, 'resume', 'all', '--now').json?.ok, false, '--now needs one id');
});

test('K7 R-5: a dependency on a workplace sprint is met once a squashed run copy of it exists (target abc)', () => {
  const w = world({ ids: ['m2'], rows: [row('w1'), row('m2', 'ready', ['w1'])], workplaces: { abc: ['w1'] } });
  w.tick();
  assert.equal(w.item('m2').wait?.rule, 'after', w.log());
  assert.match(w.item('m2').wait.text, /w1 \(spoza zlecenia\)/);
  const r = join(w.main, '.dwmt', 'runs', 'r-w1-done');
  mkdirSync(r, { recursive: true });
  writeFileSync(join(r, 'run.json'), JSON.stringify({ run: 'r-w1-done', sprint: 'w1', spec: 'w1', target: 'abc', finish: { status: 'squashed', commit: 'abc1234', at: '2026-10-26T10:00:00.000Z', target: 'abc' } }));
  assert.equal(depMerged(w.main, 'w1').merged, true);
  w.tick();
  assert.equal(w.has('prepare', 'm2').length, 1, w.log());
});

test('K7 D-8: the done notification of the sprint that completes the workplace says ready to push', () => {
  const w = world({ ids: ['w1', 'w2'], rows: [row('w1'), row('w2')], workplaces: { abc: ['w1', 'w2'] } });
  w.tick();
  w.done('w1');
  w.tick();
  const first = w.notifies(/dwmt w1: sprint scalony/);
  assert.equal(first.length, 1, w.log());
  assert.doesNotMatch(first[0][1], /gotowe do wypchnięcia/, 'w2 still open');
  w.rows([row('w1', 'done'), row('w2', 'running')]);
  w.tick();
  assert.equal(w.item('w2').state, 'running', w.log());
  w.done('w2');
  w.tick();
  const last = w.notifies(/dwmt w2: sprint scalony/);
  assert.equal(last.length, 1, w.log());
  assert.match(last[0][1], /gotowe do wypchnięcia: gałąź abc, 2 sprintów: git push -u origin abc/);
});

// ---------- fix batch (T-3/F-1 … F-3) ----------

test('batch T-3/F-1: a sprint of a removed workplace waits `workplace` with one notification; never prepared as a main-tree sprint', () => {
  const w = world({ ids: ['w1'], rows: [row('w1')], workplaces: { abc: ['w1'] } });
  const f = join(w.main, 'docs', 'product', 'workplaces.jsonl');
  writeFileSync(f, readFileSync(f, 'utf8').replace('"state":"active"', '"state":"removed"'));
  w.tick();
  w.tick();
  assert.equal(w.has('prepare', 'w1').length, 0, w.log());
  assert.equal(w.item('w1').wait?.rule, 'workplace', w.log());
  assert.match(w.item('w1').wait.text, /workplace abc is removed/);
  assert.equal(w.notifies(/w1: nie startuje/).length, 1, 'one notification over two ticks');
});

test('batch T-3/F-3: a dirty workplace tree notifies only for the next sprint; the one after it waits on its predecessor', () => {
  const w = world({ ids: ['w1', 'w2'], rows: [row('w1'), row('w2')], workplaces: { abc: ['w1', 'w2'] } });
  writeFileSync(join(w.trees.abc, 'scratch.txt'), 'x\n');
  w.tick();
  w.tick();
  assert.equal(w.item('w1').wait?.rule, 'workplace', w.log());
  assert.deepEqual([w.item('w2').wait?.rule, w.item('w2').wait?.text], ['after', 'czeka na scalenie: w1']);
  assert.equal(w.notifies(/nie startuje/).length, 1, w.has('notify').map((c) => c[1]).join('\n'));
  assert.equal(w.notifies(/w2: nie startuje/).length, 0);
});

test('batch T-3/F-2: an order whose workplace predecessor is outside it and not done is refused, naming the workplace', () => {
  const main = repo();
  mkdirSync(join(main, '.claude'), { recursive: true });
  writeFileSync(join(main, '.claude', 'dwmt.json'), JSON.stringify({ drive: { enabled: true }, git: { target: 'master' }, product: {} }));
  gitIn(main)('add', '-A');
  gitIn(main)('commit', '-q', '-m', 'cfg');
  assert.equal(pr(main, 'init', '--goal', 'Pilot').code, 0);
  for (const id of ['s1', 's2']) {
    assert.equal(pr(main, 'roadmap', 'add', id, '--goal', `Goal ${id}`).code, 0);
    assert.equal(pr(main, 'spec', 'new', id).code, 0);
  }
  writeFileSync(join(main, 'docs', 'product', 'roadmap.md'), renderRoadmap([row('s1'), row('s2')]));
  writeFileSync(join(main, 'docs', 'product', 'workplaces.jsonl'), `${JSON.stringify(wpRecord('abc', 'C:/nowhere/abc', ['s1', 's2']))}\n`);
  const o = sv(main, 'order', '--spec', join(main, 'docs', 'product', 'sprints', 's2.md'), '--presence', 'away');
  assert.equal(o.json?.ok, false, o.out);
  assert.match(o.json.errors.join('\n'), /s2: zależność s1 spoza zlecenia \(poprzedni sprint miejsca pracy abc\) ma stan ready, nie done/);
  assert.match(o.json.hint, /supervise resume <id> --now/);
  assert.equal(existsSync(join(main, '.dwmt', 'supervisor', 'supervisor.json')), false, 'nothing ordered');
});
