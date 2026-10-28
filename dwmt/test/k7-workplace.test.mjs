import './tmp-root.mjs';
// K7 workplaces (the user's branches): the record, the PO commands, the sprint header `workTree`, git facts, readiness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { repo, gitIn } from './helpers.mjs';
import { pr, write, fakeRun, productRepo } from './product-helpers.mjs';
import { paths, renderSpec } from '../scripts/lib/product-store.mjs';
import { productConfig } from '../scripts/lib/product-config.mjs';
import { loadWorkplaces, workplaceOf, startWorkplaceOf, workplaceTree, workplaceSprints, workplaceFacts, workplaceReady, startBlock } from '../scripts/lib/workplace.mjs';

const P = (d, f) => join(d, 'docs', 'product', f);
const R = (d, f) => readFileSync(P(d, f), 'utf8');
const snap = (d, ...files) => files.map((f) => (existsSync(P(d, f)) ? R(d, f) : null));
const records = (d) => (existsSync(P(d, 'workplaces.jsonl')) ? R(d, 'workplaces.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const fwd = (p) => p.replace(/\\/g, '/');
const sprint = (d, id) => { assert.equal(pr(d, 'roadmap', 'add', id, '--goal', `Goal ${id}`).code, 0); assert.equal(pr(d, 'spec', 'new', id).code, 0); };
const header = (d, id) => R(d, `sprints/${id}.md`).split('---')[1];

test('paths, header order and config: workplaces.jsonl, workTree right after mode, farBehind 20', () => {
  const pc = productConfig('/x', { product: {} });
  assert.match(fwd(paths('/x', pc).workplaces), /docs\/product\/workplaces\.jsonl$/);
  assert.equal(pc.workplace.farBehind, 20);
  const t = renderSpec({ schema: 'dwmt/sprint-spec@1', id: 's1', est: null, workTree: 'abc', mode: 'auto' }, '## Goal\nG\n');
  assert.match(t, /mode: "auto"\nworkTree: "abc"\nest: null/);
});

test('add abc --branch abc (missing branch): created at the home branch HEAD, tree .claude/worktrees/abc, home tree stays clean', () => {
  const d = productRepo(repo);
  const g = gitIn(d);
  const r = pr(d, 'workplace', 'add', 'abc', '--branch', 'abc');
  assert.equal(r.code, 0, r.out);
  assert.equal(r.json.created, true);
  assert.equal(g('rev-parse', 'abc'), g('rev-parse', 'master'));
  assert.equal(fwd(r.json.tree), fwd(join(d, '.claude', 'worktrees', 'abc')));
  const [w] = records(d);
  assert.deepEqual([w.name, w.branch, w.path, w.base.ref, w.base.commit, w.created, w.state], ['abc', 'abc', '.claude/worktrees/abc', 'master', g('rev-parse', 'master'), true, 'active']);
  assert.equal(fwd(workplaceTree(d, w)).toLowerCase(), fwd(join(d, '.claude', 'worktrees', 'abc')).toLowerCase());
  assert.doesNotMatch(g('status', '--porcelain'), /worktrees/);
  assert.match(pr(d, 'workplace', 'list').out, /^abc · abc · sprints 0\/0$/);
  // A-1: the name defaults to the last segment of the branch; a used name or branch is refused.
  const r2 = pr(d, 'workplace', 'add', '--branch', 'feature/platnosci');
  assert.equal(r2.code, 0, r2.out);
  assert.equal(r2.json.workplace.name, 'platnosci');
  assert.equal(pr(d, 'workplace', 'add', 'other', '--branch', 'abc').code, 1);
  assert.equal(pr(d, 'workplace', 'add', 'abc', '--branch', 'zzz').code, 1);
  assert.equal(records(d).length, 2);
});

test('R-1 an existing branch keeps its sha on add and stays after remove', () => {
  const d = productRepo(repo);
  const g = gitIn(d);
  g('switch', '-q', '-c', 'abc');
  write(d, 'own.txt', 'mine\n');
  g('add', 'own.txt');
  g('commit', '-q', '-m', 'own work');
  const sha = g('rev-parse', 'abc');
  g('switch', '-q', 'master');
  const r = pr(d, 'workplace', 'add', 'abc', '--branch', 'abc');
  assert.equal(r.code, 0, r.out);
  assert.equal(r.json.created, false);
  assert.equal(g('rev-parse', 'abc'), sha);
  assert.equal(records(d)[0].base.commit, g('rev-parse', 'master'), 'base commit = merge-base with the home branch');
  assert.equal(workplaceFacts(d, records(d)[0]).ahead, 1);
  const rm = pr(d, 'workplace', 'remove', 'abc');
  assert.equal(rm.code, 0, rm.out);
  assert.equal(g('rev-parse', 'abc'), sha);
});

test('an existing branch checked out in another worktree: that tree is the workplace tree', () => {
  const d = productRepo(repo);
  const g = gitIn(d);
  const other = join(mkdtempSync(join(tmpdir(), 'dwmt-wt-')), 'mine');
  g('worktree', 'add', '-q', '-b', 'feat', other);
  const r = pr(d, 'workplace', 'add', 'feat', '--branch', 'feat');
  assert.equal(r.code, 0, r.out);
  assert.equal(fwd(r.json.tree).toLowerCase(), fwd(other).toLowerCase());
  assert.equal(existsSync(join(d, '.claude', 'worktrees', 'feat')), false);
  assert.ok(!records(d)[0].path.startsWith('.'), 'outside the home tree: absolute path');
});

test('R-2 the home branch, git.target and a run branch are refused: no record line, no worktree', () => {
  const d = productRepo(repo);
  const g = gitIn(d);
  g('branch', 'dwmt/x');
  g('switch', '-q', '-c', 'develop');
  for (const [name, branch] of [['m', 'master'], ['r', 'dwmt/x'], ['h', 'develop']]) {
    const r = pr(d, 'workplace', 'add', name, '--branch', branch);
    assert.equal(r.code, 1, `${branch}: ${r.out}`);
    assert.equal(r.json.ok, false);
    assert.equal(existsSync(join(d, '.claude', 'worktrees', name)), false);
  }
  assert.equal(existsSync(P(d, 'workplaces.jsonl')), false);
  assert.equal(g('worktree', 'list').split('\n').length, 1);
});

test('R-3 assign and unassign write the record and both headers; a refused assign changes neither', () => {
  const d = productRepo(repo);
  for (const id of ['s1', 's2', 's3']) sprint(d, id);
  assert.equal(pr(d, 'workplace', 'add', 'abc', '--branch', 'abc').code, 0);
  const a = pr(d, 'workplace', 'assign', 'abc', 's1', 's2');
  assert.equal(a.code, 0, a.out);
  assert.deepEqual(records(d)[0].sprints, ['s1', 's2']);
  assert.match(header(d, 's1'), /workTree: "abc"/);
  assert.match(header(d, 's2'), /workTree: "abc"/);
  assert.equal(workplaceOf(d, 's2').name, 'abc');
  const u = pr(d, 'workplace', 'unassign', 's1');
  assert.equal(u.code, 0, u.out);
  assert.deepEqual(records(d)[0].sprints, ['s2']);
  assert.doesNotMatch(header(d, 's1'), /workTree/);
  assert.equal(workplaceOf(d, 's1'), null);
  // A running sprint is refused; a sprint of another workplace too.
  assert.equal(pr(d, 'roadmap', 'set', 's3', 'state', 'running').code, 0);
  const before = snap(d, 'workplaces.jsonl', 'sprints/s1.md', 'sprints/s3.md');
  const r = pr(d, 'workplace', 'assign', 'abc', 's1', 's3');
  assert.equal(r.code, 1, r.out);
  assert.match(r.json.error, /s3: sprint is running/);
  assert.deepEqual(snap(d, 'workplaces.jsonl', 'sprints/s1.md', 'sprints/s3.md'), before);
  assert.equal(pr(d, 'workplace', 'add', 'xyz', '--branch', 'xyz').code, 0);
  const before2 = snap(d, 'workplaces.jsonl', 'sprints/s2.md');
  const f = pr(d, 'workplace', 'assign', 'xyz', 's2');
  assert.equal(f.code, 1, f.out);
  assert.match(f.json.error, /already in workplace abc/);
  assert.deepEqual(snap(d, 'workplaces.jsonl', 'sprints/s2.md'), before2);
  // `ordered` is allowed: nothing has started.
  sprint(d, 's4');
  write(d, 'docs/product/roadmap.md', R(d, 'roadmap.md').replace(/\| s4 \| notes \|/, '| s4 | ordered |'));
  assert.match(R(d, 'roadmap.md'), /\| s4 \| ordered \|/);
  assert.equal(pr(d, 'workplace', 'assign', 'xyz', 's4').code, 0);
});

test('spec set workTree is refused with a hint and the sprint file stays byte-equal', () => {
  const d = productRepo(repo);
  sprint(d, 's1');
  const before = snap(d, 'sprints/s1.md');
  const r = pr(d, 'spec', 'set', 's1', 'workTree', 'abc');
  assert.equal(r.code, 1, r.out);
  assert.match(r.json.error, /workplace assign/);
  assert.deepEqual(snap(d, 'sprints/s1.md'), before);
});

test('add --sprints assigns under the same lock; --base may be another workplace branch (stacked, AC-9)', () => {
  const d = productRepo(repo);
  const g = gitIn(d);
  for (const id of ['s1', 's2']) sprint(d, id);
  assert.equal(pr(d, 'roadmap', 'set', 's2', 'after', 's1').code, 0);
  const a = pr(d, 'workplace', 'add', 'abc', '--branch', 'abc', '--sprints', 's1');
  assert.equal(a.code, 0, a.out);
  const tree = a.json.tree;
  write(tree, 'x.txt', 'x\n');
  gitIn(tree)('add', 'x.txt');
  gitIn(tree)('commit', '-q', '-m', 'on abc');
  // s2 depends on s1, which runs on another branch: allowed (D-14).
  const b = pr(d, 'workplace', 'add', 'def', '--branch', 'feature/def', '--base', 'abc', '--sprints', 's2');
  assert.equal(b.code, 0, b.out);
  assert.equal(g('rev-parse', 'feature/def'), g('rev-parse', 'abc'));
  assert.equal(b.json.workplace.base.ref, 'abc');
  assert.match(header(d, 's2'), /workTree: "def"/);
  assert.equal(pr(d, 'workplace', 'add', 'bad', '--branch', 'bad', '--base', 'no-such').code, 1);
});

test('R-4 git facts, positions and readiness', () => {
  const d = productRepo(repo);
  const g = gitIn(d);
  for (const id of ['s1', 's2']) sprint(d, id);
  const a = pr(d, 'workplace', 'add', 'abc', '--branch', 'abc', '--sprints', 's1,s2');
  assert.equal(a.code, 0, a.out);
  const t = gitIn(a.json.tree);
  for (const n of [1, 2]) { write(a.json.tree, `w${n}.txt`, `${n}\n`); t('add', `w${n}.txt`); t('commit', '-q', '-m', `w${n}`); }
  write(a.json.tree, 'loose.txt', 'u\n');
  write(d, 'm.txt', 'm\n');
  g('add', 'm.txt');
  g('commit', '-q', '-m', 'master moves');
  const wp = () => loadWorkplaces(d)[0];
  let f = workplaceFacts(d, wp());
  assert.deepEqual([f.ahead, f.behind, f.dirty, f.dirtyFiles, f.baseRef, f.pushed, f.remote, f.pushCmd], [2, 1, 1, ['loose.txt'], 'master', false, 'origin', 'git push -u origin abc']);
  assert.deepEqual(startBlock(d, wp()).reason, 'dirty');
  assert.deepEqual(workplaceSprints(d, wp()).map((s) => [s.id, s.k, s.n, s.state]), [['s1', 1, 2, 'queued'], ['s2', 2, 2, 'queued']]);
  assert.equal(workplaceReady(d, wp()).ready, false);
  // s2 finishes first: it takes position 1 of 2.
  fakeRun(d, 'r-s2', { files: ['src/s2.ts'], spec: 's2' });
  assert.equal(pr(d, 'sync').code, 0);
  const sp = workplaceSprints(d, wp());
  assert.deepEqual(sp.map((s) => [s.id, s.k, s.n, s.state]), [['s2', 1, 2, 'done'], ['s1', 2, 2, 'queued']]);
  assert.ok(sp[0].commit);
  assert.equal(workplaceReady(d, wp()).ready, false);
  fakeRun(d, 'r-s1', { files: ['src/s1.ts'], spec: 's1' });
  assert.equal(pr(d, 'sync').code, 0);
  assert.deepEqual(workplaceReady(d, wp()), { ready: true, branch: 'abc', n: 2, pushCmd: 'git push -u origin abc' });
  // Pushed to a bare remote: `pushed` true.
  const bare = mkdtempSync(join(tmpdir(), 'dwmt-bare-'));
  gitIn(bare)('init', '-q', '--bare');
  g('remote', 'add', 'origin', bare);
  g('push', '-q', '-u', 'origin', 'abc');
  f = workplaceFacts(d, wp());
  assert.equal(f.pushed, true);
  t('commit', '-q', '--allow-empty', '-m', 'one more');
  assert.equal(workplaceFacts(d, wp()).pushed, false);
  const show = pr(d, 'workplace', 'show', 'abc', '--json');
  assert.equal(show.code, 0, show.out);
  assert.equal(show.json.ready.ready, true);
  assert.equal(show.json.sprints.length, 2);
});

test('brief: ready to push line when every assigned sprint is done', () => {
  const d = productRepo(repo);
  for (const id of ['s1', 's2']) sprint(d, id);
  assert.equal(pr(d, 'workplace', 'add', 'abc', '--branch', 'abc', '--sprints', 's1,s2').code, 0);
  assert.doesNotMatch(pr(d, 'brief').out, /ready to push/);
  fakeRun(d, 'r-s1', { files: ['src/s1.ts'], spec: 's1' });
  fakeRun(d, 'r-s2', { files: ['src/s2.ts'], spec: 's2' });
  assert.equal(pr(d, 'sync').code, 0);
  const b = pr(d, 'brief');
  assert.match(b.out, /ready to push: abc \(2 sprints\): git push -u origin abc/);
  assert.ok(b.out.split('\n').length <= 25);
  assert.match(pr(d, 'workplace', 'list').out, /abc · abc · sprints 2\/2 · ready to push: git push -u origin abc/);
});

test('R-5 remove: a modified file keeps the tree; clean → tree gone, record removed, branch kept', () => {
  const d = productRepo(repo);
  const g = gitIn(d);
  const a = pr(d, 'workplace', 'add', 'abc', '--branch', 'abc');
  assert.equal(a.code, 0, a.out);
  writeFileSync(join(a.json.tree, 'a.txt'), 'changed\n');
  const before = snap(d, 'workplaces.jsonl');
  const r = pr(d, 'workplace', 'remove', 'abc');
  assert.equal(r.code, 1, r.out);
  assert.ok(existsSync(join(a.json.tree, 'a.txt')));
  assert.deepEqual(snap(d, 'workplaces.jsonl'), before);
  gitIn(a.json.tree)('checkout', '--', 'a.txt');
  const ok = pr(d, 'workplace', 'remove', 'abc');
  assert.equal(ok.code, 0, ok.out);
  assert.equal(existsSync(a.json.tree), false);
  assert.equal(records(d)[0].state, 'removed');
  assert.ok(g('rev-parse', '--verify', 'abc'));
  assert.equal(startBlock(d, records(d)[0]).reason, 'removed');
  assert.equal(workplaceOf(d, 'any'), null);
  // The name is free again.
  assert.equal(pr(d, 'workplace', 'add', 'abc', '--branch', 'abc').code, 0);
});

test('R-5 remove refuses while a sprint of the workplace is running', () => {
  const d = productRepo(repo);
  sprint(d, 's1');
  const a = pr(d, 'workplace', 'add', 'abc', '--branch', 'abc', '--sprints', 's1');
  assert.equal(a.code, 0, a.out);
  assert.equal(pr(d, 'roadmap', 'set', 's1', 'state', 'running').code, 0);
  const r = pr(d, 'workplace', 'remove', 'abc');
  assert.equal(r.code, 1, r.out);
  assert.match(r.json.error, /s1 is running/);
  assert.ok(existsSync(a.json.tree));
});

test('without a product layer the read API answers empty', () => {
  const d = repo();
  assert.deepEqual(loadWorkplaces(d), []);
  assert.equal(workplaceOf(d, 's1'), null);
  assert.equal(startBlock(d, null), null);
});

test('F-1 a bad line in workplaces.jsonl fails every writer and list/show; the file stays byte-equal', () => {
  const d = productRepo(repo);
  sprint(d, 's1');
  assert.equal(pr(d, 'workplace', 'add', 'abc', '--branch', 'abc').code, 0);
  writeFileSync(P(d, 'workplaces.jsonl'), `${R(d, 'workplaces.jsonl')}<<<<<<< HEAD\n`);
  const before = R(d, 'workplaces.jsonl');
  for (const args of [['add', 'def', '--branch', 'def'], ['assign', 'abc', 's1'], ['unassign', 's1'], ['remove', 'abc'], ['list'], ['show', 'abc']]) {
    const r = pr(d, 'workplace', ...args);
    assert.equal(r.code, 1, `${args.join(' ')}: ${r.out}`);
    assert.match(r.out, /workplaces\.jsonl:2/, args.join(' '));
    assert.equal(R(d, 'workplaces.jsonl'), before, args.join(' '));
  }
  assert.deepEqual(loadWorkplaces(d), [], 'the read API still answers empty');
});

// ---------- fix batch (T-1/F-2 … F-5) ----------

test('batch T-1/F-2 remove keeps a tree dwmt did not create (adopted user tree with ignored files); its own tree goes', () => {
  const d = productRepo(repo);
  const g = gitIn(d);
  const mine = join(mkdtempSync(join(tmpdir(), 'dwmt-wt-')), 'mine');
  g('worktree', 'add', '-q', '-b', 'feat', mine);
  const exclude = join(g('rev-parse', '--path-format=absolute', '--git-common-dir'), 'info', 'exclude');
  writeFileSync(exclude, `${existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''}\n.env\n`);
  writeFileSync(join(mine, '.env'), 'SECRET=1\n');
  assert.equal(pr(d, 'workplace', 'add', 'feat', '--branch', 'feat').code, 0);
  const r = pr(d, 'workplace', 'remove', 'feat');
  assert.equal(r.code, 0, r.out);
  assert.equal(r.json.treeKept, true);
  assert.match(r.json.hint, /kept: dwmt did not create it/);
  assert.ok(existsSync(join(mine, '.env')), 'the user tree and its ignored file stay');
  assert.match(g('worktree', 'list'), /mine/);
  assert.equal(records(d)[0].state, 'removed');
  // The user checks the branch out in a tree of their own after the dwmt tree is gone: it stays too.
  const a = pr(d, 'workplace', 'add', 'abc', '--branch', 'abc');
  assert.equal(a.code, 0, a.out);
  g('worktree', 'remove', a.json.tree);
  const other = join(mkdtempSync(join(tmpdir(), 'dwmt-wt-')), 'other');
  g('worktree', 'add', '-q', other, 'abc');
  const r2 = pr(d, 'workplace', 'remove', 'abc');
  assert.equal(r2.code, 0, r2.out);
  assert.equal(r2.json.treeKept, true);
  assert.ok(existsSync(other));
});

test('batch T-1/F-3 remove keeps open sprints linked and blocked; unassign and assign take them over; re-add refuses while held', () => {
  const d = productRepo(repo);
  for (const id of ['s1', 's2', 's3']) sprint(d, id);
  assert.equal(pr(d, 'workplace', 'add', 'abc', '--branch', 'abc', '--sprints', 's1,s2,s3').code, 0);
  fakeRun(d, 'r-s3', { files: ['src/s3.ts'], spec: 's3' });
  assert.equal(pr(d, 'sync').code, 0);
  const rm = pr(d, 'workplace', 'remove', 'abc');
  assert.equal(rm.code, 0, rm.out);
  assert.deepEqual(rm.json.held, ['s1', 's2']);
  assert.match(rm.json.hint, /s1, s2 stay assigned to the removed workplace and will not start/);
  assert.match(header(d, 's1'), /workTree: "abc"/);
  const wp1 = startWorkplaceOf(d, 's1');
  assert.equal(wp1?.state, 'removed');
  assert.equal(startBlock(d, wp1).reason, 'removed');
  assert.equal(workplaceOf(d, 's1'), null, 'workplaceOf stays active-only');
  assert.equal(startWorkplaceOf(d, 's3'), null, 'a finished sprint of the removed workplace never starts again');
  // Re-adding the name while it still holds open sprints is refused, nothing written.
  const before = snap(d, 'workplaces.jsonl', 'sprints/s1.md', 'sprints/s2.md');
  const re = pr(d, 'workplace', 'add', 'abc', '--branch', 'abc');
  assert.equal(re.code, 1, re.out);
  assert.match(re.json.error, /removed with open sprints s1, s2.*--sprints s1,s2.*unassign s1 s2/);
  assert.deepEqual(snap(d, 'workplaces.jsonl', 'sprints/s1.md', 'sprints/s2.md'), before);
  // unassign accepts a sprint of the removed workplace.
  const u = pr(d, 'workplace', 'unassign', 's1');
  assert.equal(u.code, 0, u.out);
  assert.doesNotMatch(header(d, 's1'), /workTree/);
  assert.deepEqual(records(d)[0].sprints, ['s2', 's3']);
  assert.equal(startWorkplaceOf(d, 's1'), null);
  // assign to another workplace takes it out of the removed record: record and header agree.
  assert.equal(pr(d, 'workplace', 'add', 'xyz', '--branch', 'xyz').code, 0);
  assert.equal(pr(d, 'workplace', 'assign', 'xyz', 's2').code, 0);
  assert.deepEqual(records(d)[0].sprints, ['s3']);
  assert.equal(startWorkplaceOf(d, 's2').name, 'xyz');
  assert.match(header(d, 's2'), /workTree: "xyz"/);
  // Nothing held any more: the name is free.
  assert.equal(pr(d, 'workplace', 'add', 'abc', '--branch', 'abc').code, 0);
});

test('batch T-1/F-3 re-add with --sprints takes the held sprints along', () => {
  const d = productRepo(repo);
  sprint(d, 's1');
  assert.equal(pr(d, 'workplace', 'add', 'abc', '--branch', 'abc', '--sprints', 's1').code, 0);
  assert.equal(pr(d, 'workplace', 'remove', 'abc').code, 0);
  const re = pr(d, 'workplace', 'add', 'abc', '--branch', 'abc', '--sprints', 's1');
  assert.equal(re.code, 0, re.out);
  assert.deepEqual(records(d).map((w) => [w.state, w.sprints]), [['removed', []], ['active', ['s1']]]);
  assert.equal(startWorkplaceOf(d, 's1').state, 'active');
});

test('batch T-1/F-4 a branch only on the remote is checked out tracking it, not created anew from the home branch', () => {
  const d = productRepo(repo);
  const g = gitIn(d);
  const bare = mkdtempSync(join(tmpdir(), 'dwmt-bare-'));
  gitIn(bare)('init', '-q', '--bare');
  g('remote', 'add', 'origin', bare);
  g('switch', '-q', '-c', 'feature/x');
  for (const n of [1, 2, 3]) { write(d, `x${n}.txt`, `${n}\n`); g('add', `x${n}.txt`); g('commit', '-q', '-m', `x${n}`); }
  g('push', '-q', 'origin', 'feature/x');
  const sha = g('rev-parse', 'feature/x');
  g('switch', '-q', 'master');
  g('branch', '-q', '-D', 'feature/x');
  const r = pr(d, 'workplace', 'add', 'x', '--branch', 'feature/x', '--base', 'master');
  assert.equal(r.code, 0, r.out);
  assert.equal(r.json.created, false);
  assert.equal(g('rev-parse', 'feature/x'), sha, 'the remote commits, not master');
  assert.equal(g('rev-parse', '--abbrev-ref', 'feature/x@{upstream}'), 'origin/feature/x');
  assert.deepEqual([r.json.workplace.base.ref, r.json.workplace.base.commit], ['origin/feature/x', sha]);
  assert.match((r.json.warnings ?? []).join('\n'), /--base master ignored/);
  const f = workplaceFacts(d, records(d)[0]);
  assert.deepEqual([f.ahead, f.behind, f.pushed], [0, 0, true]);
});

test('batch T-1/F-5 the ready-to-push line leaves the brief once the branch is pushed; list says pushed', () => {
  const d = productRepo(repo);
  const g = gitIn(d);
  for (const id of ['s1', 's2']) sprint(d, id);
  assert.equal(pr(d, 'workplace', 'add', 'abc', '--branch', 'abc', '--sprints', 's1,s2').code, 0);
  fakeRun(d, 'r-s1', { files: ['src/s1.ts'], spec: 's1' });
  fakeRun(d, 'r-s2', { files: ['src/s2.ts'], spec: 's2' });
  assert.equal(pr(d, 'sync').code, 0);
  assert.match(pr(d, 'brief').out, /ready to push: abc/);
  const bare = mkdtempSync(join(tmpdir(), 'dwmt-bare-'));
  gitIn(bare)('init', '-q', '--bare');
  g('remote', 'add', 'origin', bare);
  g('push', '-q', '-u', 'origin', 'abc');
  assert.doesNotMatch(pr(d, 'brief').out, /ready to push/);
  assert.match(pr(d, 'workplace', 'list').out, /abc · abc · sprints 2\/2 · pushed$/m);
  assert.equal(workplaceReady(d, records(d)[0]).ready, true, 'readiness itself (C-1) is unchanged');
});
