import './tmp-root.mjs';
// K7 T-2: a workplace sprint runs in its own run worktree started from the workplace branch, squashes into the
// workplace tree and never into develop (= git.target) or the main tree's branch; three sprints on `abc` (AC-7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { repo, gitIn, cli, header, put, runFile } from './helpers.mjs';
import { pr } from './product-helpers.mjs';
import { canonPath } from '../scripts/lib/util.mjs';
import { mergeKey } from '../scripts/lib/finish.mjs';
import { findWorkplace, workplaceSprints } from '../scripts/lib/workplace.mjs';
import { loadConfig } from '../scripts/lib/config.mjs';
import { productConfig } from '../scripts/lib/product-config.mjs';
import { paths } from '../scripts/lib/product-store.mjs';
import { viewModel } from '../scripts/lib/product-view.mjs';

const fwd = (p) => String(p).replace(/\\/g, '/');
const same = (a, b) => fwd(canonPath(a)).toLowerCase() === fwd(canonPath(b)).toLowerCase();

// Main tree on `develop` (= git.target) with the product dir and a fast verify.full; setup and product on master first.
function layout() {
  const d = repo();
  const g = gitIn(d);
  assert.equal(cli(d, 'setup').code, 0);
  const f = join(d, '.claude', 'dwmt.json');
  const cfg = JSON.parse(readFileSync(f, 'utf8'));
  writeFileSync(f, `${JSON.stringify({ ...cfg, git: { ...cfg.git, target: 'develop' }, verify: { full: ['node -e 0'] }, run: { ...cfg.run, priceGate: false }, product: { view: { publish: null } } }, null, 2)}\n`);
  const p = pr(d, 'init', '--goal', 'Workplace pilot');
  assert.equal(p.code, 0, p.out);
  g('add', '-A');
  assert.equal(cli(d, 'setup').code, 0, 'agents of the product layer');
  g('add', '-A');
  g('commit', '-q', '-m', 'setup and product');
  g('switch', '-q', '-c', 'develop');
  return { d, g };
}
const commitProduct = (g, msg) => { g('add', '-A', '--', 'docs/product'); if (g('status', '--porcelain', '--', 'docs/product')) g('commit', '-q', '-m', msg); };
function sprintLine(d, id) {
  for (const a of [['roadmap', 'add', id, '--goal', `Goal ${id}`], ['spec', 'new', id]]) {
    const r = pr(d, ...a);
    assert.equal(r.code, 0, `${a.join(' ')}: ${r.out} ${r.err}`);
  }
}
const BRIEF = (run, goal) => `${header({ schema: 'dwmt/brief@1', run, goal, mode: 'inline', acceptance: ['AC-1 [human] file'], scope: ['*.txt'], verify: ['node -e 0'], decisions: [], risks: [], questions: [] })}# ${goal}\n\n## UAT\n1. Open the file → its text shows (AC-1).\n`;
// As home-tree.test.mjs#taskDone; returns the review input diff of task 1.
function taskDone(wt, run, file) {
  writeFileSync(runFile(wt, run, 'brief.md'), BRIEF(run, `File ${file}`));
  writeFileSync(join(wt, file), `${file}\n`);
  for (const a of [['verify', run], ['review-input', run]]) { const r = cli(wt, ...a); assert.equal(r.code, 0, `${a[0]}: ${r.out}`); }
  const diff = readFileSync(join(wt, '.dwmt', 'runs', run, 'tasks', '1', 'diff.patch'), 'utf8');
  put(wt, run, 'review-1.md', { schema: 'dwmt/review@1', round: 1, passes: ['correctness'], verdict: 'PASS', fix: [], acceptance: ['AC-1 met'], risks: [] });
  const c = cli(wt, 'commit', run);
  assert.equal(c.code, 0, c.out);
  return diff;
}
// `init` from the main tree without --worktree (D-16).
function start(d, id) {
  const pf = cli(d, 'preflight', '--slug', id);
  assert.equal(pf.json?.ok, true, pf.out);
  const run = pf.json.run;
  return { run, i: cli(d, 'init', '--run', run, '--mode', 'single', '--input', join(d, 'docs', 'product', 'sprints', `${id}.md`), '--force') };
}
const taskText = (wt, run) => readFileSync(join(wt, '.dwmt', 'runs', run, 'task.md'), 'utf8');

test('workplace flow: three sprints on abc squash into the workplace tree, develop and the main tree untouched, push ready after the last (AC-2..AC-5, AC-7, AC-9, R-1..R-3, R-5..R-7)', () => {
  const t0 = Date.now();
  const { d, g } = layout();
  for (const id of ['s1', 's2', 's3', 's4', 's5']) sprintLine(d, id);
  commitProduct(g, 'product sprints');
  const add = pr(d, 'workplace', 'add', 'abc', '--branch', 'abc', '--sprints', 's1,s2,s3');
  assert.equal(add.code, 0, add.out);
  const tree = add.json.tree;
  // A user branch (created: false) whose base moves on: it is never moved (R-5).
  g('branch', 'u1');
  const u1 = pr(d, 'workplace', 'add', 'u1', '--branch', 'u1', '--sprints', 's5');
  assert.equal(u1.code, 0, u1.out);
  assert.equal(u1.json.created, false);
  commitProduct(g, 'product workplaces');
  const dev0 = g('rev-parse', 'develop');
  const devFiles = () => g('diff', '--name-only', dev0, 'develop').split(/\r?\n/).filter(Boolean);
  const runs = [];
  const diffs = [];
  for (const [n, id] of ['s1', 's2', 's3'].entries()) {
    if (id === 's2') {
      // R-6: an untracked file in the workplace tree refuses the start and leaves nothing behind.
      writeFileSync(join(tree, 'mine.txt'), 'user work\n');
      const { run, i } = start(d, id);
      assert.equal(i.code, 1, i.out);
      assert.match(String(i.json?.error), /^workplace abc:/);
      assert.match(i.json.error, /mine\.txt/);
      assert.ok(!existsSync(join(d, '.claude', 'worktrees', run)), 'no run worktree');
      assert.equal(g('branch', '--list', `dwmt/${run}`), '', 'no run branch');
      rmSync(join(tree, 'mine.txt'));
    }
    if (id === 's2') {
      // R-5: w2 stacked on abc without own commits; it catches up with abc at its sprint start (after s2, s3 below).
      const w2 = pr(d, 'workplace', 'add', 'w2', '--branch', 'w2', '--base', 'abc', '--sprints', 's4');
      assert.equal(w2.code, 0, w2.out);
      commitProduct(g, 'product w2');
    }
    const { run, i } = start(d, id);
    assert.equal(i.json?.ok, true, i.out);
    assert.deepEqual([i.json.workplace?.name, i.json.workplace?.branch], ['abc', 'abc']);
    assert.ok(same(i.json.workplace.tree, tree), i.json.workplace.tree);
    const wt = i.json.worktree;
    assert.ok(wt && same(wt, join(d, '.claude', 'worktrees', run)), String(wt));
    assert.equal(g('branch', '--show-current'), 'develop', 'main tree stays on develop');
    const rj = JSON.parse(readFileSync(join(wt, '.dwmt', 'runs', run, 'run.json'), 'utf8'));
    assert.deepEqual([rj.target, rj.workplace], ['abc', 'abc']);
    // F-2: the sprint text comes from the main tree's product, not from abc's copy (s2 refined on develop after s1).
    if (id === 's2') assert.match(taskText(wt, run), /Refined on develop after s1\./);
    assert.ok(same(rj.homeTree, d));
    // AC-3: the run branch starts at abc's tip (the previous sprint's result); the first after catching up with develop.
    assert.equal(g('rev-parse', `dwmt/${run}`), g('rev-parse', 'abc'));
    if (n === 0) assert.equal(g('rev-parse', 'abc'), g('rev-parse', 'develop'), 'fresh abc caught up with its base (D-14)');
    diffs.push(taskDone(wt, run, `${id}.txt`));
    const before = g('rev-parse', 'abc');
    const fin = cli(wt, 'finish', run).json;
    assert.equal(fin?.status, 'squashed', JSON.stringify(fin));
    assert.ok(same(fin.targetDir, tree), fin.targetDir);
    assert.equal(g('rev-parse', 'abc~1'), before, 'one squash on the previous result');
    assert.ok(existsSync(join(tree, `${id}.txt`)), 'squash checked out in the workplace tree');
    if (n < 2) assert.equal(fin.push, undefined, `no push after ${id}`);
    else assert.deepEqual(fin.push, { branch: 'abc', n: 3, cmd: 'git push -u origin abc' });
    runs.push(run);
    if (id === 's1') {
      // F-2: s2 refined on develop after abc got its own commit; abc's docs/product keeps the old text.
      const sf = join(d, 'docs', 'product', 'sprints', 's2.md');
      writeFileSync(sf, readFileSync(sf, 'utf8').replace(/\n---(\r?\n)/, '\n---$1\nRefined on develop after s1.\n'));
      commitProduct(g, 'product s2 refined');
      assert.doesNotMatch(g('show', 'abc:docs/product/sprints/s2.md'), /Refined/, 'abc keeps the old text');
    }
  }
  // R-1: nothing of a workplace sprint on develop (only product commits there) or in the main tree.
  assert.equal(g('branch', '--show-current'), 'develop');
  assert.deepEqual(devFiles().filter((f) => !f.startsWith('docs/product/')), [], devFiles().join(', '));
  for (const id of ['s1', 's2', 's3']) assert.ok(!existsSync(join(d, `${id}.txt`)), `${id}.txt not in the main tree`);
  assert.equal(g('rev-list', '--count', 'develop..abc'), '3');
  // R-2: each review saw only its own sprint's change.
  diffs.forEach((p, k) => ['s1', 's2', 's3'].forEach((id, j) => assert.equal(p.includes(`${id}.txt`), j === k, `review ${k + 1} and ${id}.txt`)));
  // R-3: only code on abc; the roadmap marks the three done after sync in the main tree.
  assert.deepEqual(g('diff', '--name-only', 'develop...abc').split(/\r?\n/).filter(Boolean).sort(), ['s1.txt', 's2.txt', 's3.txt']);
  assert.equal(pr(d, 'sync').code, 0);
  const wp = findWorkplace(d, 'abc');
  assert.deepEqual(workplaceSprints(d, wp).map((s) => [s.id, ['done', 'uat'].includes(s.state)]), [['s1', true], ['s2', true], ['s3', true]]);
  // AC-7 (page part, T-4 R-7): the generated page data shows abc with its three sprints at positions 1–3 of 3.
  const cfg = loadConfig(d);
  const pc = productConfig(d, cfg);
  const V = viewModel({ top: d, cfg, pc, P: paths(d, pc) });
  const vabc = V.workplaces?.find((w) => w.name === 'abc');
  assert.ok(vabc, JSON.stringify(V.workplaces?.map((w) => w.name)));
  assert.deepEqual(vabc.sprints.map((s) => [s.id, s.k, s.n]), [['s1', 1, 3], ['s2', 2, 3], ['s3', 3, 3]]);
  assert.equal(vabc.ready, true);
  assert.equal(vabc.facts.ahead, 3);
  assert.deepEqual(['s1', 's2', 's3'].map((id) => V.sprints.find((x) => x.id === id)?.wp && [V.sprints.find((x) => x.id === id).wp.name, V.sprints.find((x) => x.id === id).wp.k]), [['abc', 1], ['abc', 2], ['abc', 3]]);
  // R-7: UAT of a workplace sprint starts, names the workplace tree and holds abc's squashes only.
  const st = cli(d, 'uat', 'start', runs[2]).json;
  let released;
  try {
    assert.equal(st?.ok, true, JSON.stringify(st));
    assert.ok(st.tree && same(st.tree, tree) && fwd(st.tree).endsWith('.claude/worktrees/abc'), String(st.tree));
  } finally { released = cli(d, 'uat', 'release').json; }
  assert.deepEqual(released?.released, [mergeKey(d, 'abc').key]);
  // R-5: w2 (dwmt-made, no own commits) catches up with abc's new tip; u1 (the user's) keeps its sha.
  commitProduct(g, 'product after sync');
  const w2run = start(d, 's4');
  assert.equal(w2run.i.json?.ok, true, w2run.i.out);
  assert.equal(g('rev-parse', 'w2'), g('rev-parse', 'abc'));
  assert.equal(g('rev-parse', `dwmt/${w2run.run}`), g('rev-parse', 'abc'));
  const u1sha = g('rev-parse', 'u1');
  assert.notEqual(u1sha, g('rev-parse', 'develop'), 'develop moved on (product commits)');
  // F-2: s6 is added on develop after u1 was cut (u1 has no s6 in its docs/product); it still starts on u1.
  sprintLine(d, 's6');
  commitProduct(g, 'product s6');
  const as6 = pr(d, 'workplace', 'assign', 'u1', 's6');
  assert.equal(as6.code, 0, as6.out);
  commitProduct(g, 'product s6 on u1');
  assert.ok(!g('ls-tree', '--name-only', 'u1', 'docs/product/sprints/').includes('s6.md'), 'u1 has no s6');
  const u1run = start(d, 's6');
  assert.equal(u1run.i.json?.ok, true, u1run.i.out);
  assert.match(taskText(u1run.i.json.worktree, u1run.run), /Goal s6/);
  assert.equal(g('rev-parse', 'u1'), u1sha);
  assert.equal(g('rev-parse', `dwmt/${u1run.run}`), u1sha);
  console.log(`# workplace flow: ${Date.now() - t0} ms`);
});

test('workplace flow: a sprint without a workplace still runs in place on the main tree (AC-1, R-4)', () => {
  const { d, g } = layout();
  sprintLine(d, 'p1');
  commitProduct(g, 'product p1');
  const { run, i } = start(d, 'p1');
  assert.equal(i.json?.ok, true, i.out);
  assert.equal(i.json.worktree, undefined);
  assert.equal(i.json.workplace, undefined);
  assert.equal(g('branch', '--show-current'), `dwmt/${run}`);
  const rj = JSON.parse(readFileSync(join(d, '.dwmt', 'runs', run, 'run.json'), 'utf8'));
  assert.equal(rj.target, 'develop');
  assert.ok(!('workplace' in rj));
  // Batch T-2/F-1 (R-4 past init): the task and finish run as today, squashed into develop in the main tree, no push.
  const dev0 = g('rev-parse', 'develop');
  taskDone(d, run, 'p1.txt');
  const fin = cli(d, 'finish', run).json;
  assert.equal(fin?.status, 'squashed', JSON.stringify(fin));
  assert.ok(same(fin.targetDir, d), String(fin.targetDir));
  assert.equal(fin.push, undefined);
  const sq = g('log', '--format=%H', `${dev0}..develop`, '--', 'p1.txt').split(/\r?\n/).filter(Boolean);
  assert.equal(sq.length, 1, 'one squash on develop');
  assert.equal(g('rev-parse', `${sq[0]}~1`), dev0, 'the squash sits on develop as it was');
  const after = JSON.parse(readFileSync(join(d, '.dwmt', 'runs', run, 'run.json'), 'utf8'));
  assert.deepEqual([after.target, 'workplace' in after], ['develop', false]);
});

test('workplace flow: a sprint of a removed workplace or of a workplace without its tree is refused at init, nothing created (D-7)', () => {
  const { d, g } = layout();
  for (const id of ['r1', 'r2']) sprintLine(d, id);
  commitProduct(g, 'product sprints');
  assert.equal(pr(d, 'workplace', 'add', 'abc', '--branch', 'abc', '--sprints', 'r1').code, 0);
  const xyz = pr(d, 'workplace', 'add', 'xyz', '--branch', 'xyz', '--sprints', 'r2');
  assert.equal(xyz.code, 0, xyz.out);
  const rm = pr(d, 'workplace', 'remove', 'abc');
  assert.equal(rm.code, 0, rm.out);
  assert.deepEqual(rm.json.held, ['r1']);
  g('worktree', 'remove', xyz.json.tree);
  commitProduct(g, 'product workplaces');
  const dev0 = g('rev-parse', 'develop');
  for (const [id, re] of [['r1', /^workplace abc: is removed: assign the sprint to another workplace or unassign it/], ['r2', /^workplace xyz: no worktree has branch xyz checked out/]]) {
    const { run, i } = start(d, id);
    assert.equal(i.code, 1, i.out);
    assert.match(String(i.json?.error), re);
    assert.ok(!existsSync(join(d, '.claude', 'worktrees', run)), `${id}: no run worktree`);
    assert.equal(g('branch', '--list', `dwmt/${run}`), '', `${id}: no run branch`);
    assert.equal(g('branch', '--show-current'), 'develop');
  }
  assert.equal(g('rev-parse', 'develop'), dev0);
});
