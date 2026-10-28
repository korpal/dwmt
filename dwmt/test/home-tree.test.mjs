import './tmp-root.mjs';
// T-2 (K3): the run's home tree (C-2) in a repo whose target branch sits in a worktree other than the first
// (bugs 12, 13). T-3 adds the full init → finish → uat flow and the `mainTreeOf(` guard to this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { repo, gitIn, cli, header, put, runFile } from './helpers.mjs';
import { pr, fakeRun } from './product-helpers.mjs';
import { canonPath } from '../scripts/lib/util.mjs';
import { runHome, contextHome, mainTreeOf, writeStatus, runEvent } from '../scripts/lib/run.mjs';
import { mergeWaitReason, mergeKey } from '../scripts/lib/finish.mjs';
import { eventsFile } from '../scripts/events.mjs';
import { realOps } from '../scripts/supervise.mjs';

const TARGET = 'feature/x';

// First tree on `develop`, second from `git worktree add -b feature/x` (= git.target); config committed on master.
// `setup`: dwmt setup committed first (init and preflight need agents).
function layout({ setup = false } = {}) {
  const first = repo();
  const g = gitIn(first);
  if (setup) { const s = cli(first, 'setup'); assert.equal(s.code, 0, s.out); }
  const f = join(first, '.claude', 'dwmt.json');
  const cfg = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
  mkdirSync(join(first, '.claude'), { recursive: true });
  writeFileSync(f, `${JSON.stringify({ ...cfg, git: { ...cfg.git, target: TARGET } }, null, 2)}\n`);
  g('add', '-A');
  g('commit', '-q', '-m', 'config');
  const second = join(mkdtempSync(join(tmpdir(), 'dwmt-ht-')), 'second');
  g('worktree', 'add', '-q', '-b', TARGET, second);
  g('switch', '-q', '-c', 'develop');
  return { first, second, g, g2: gitIn(second) };
}

const L = layout();

// A squashed run copy that lives only in the second tree's `.dwmt/runs` (the squash commit on feature/x).
function squashedCopy(tree, id, sprint) {
  const g2 = gitIn(tree);
  writeFileSync(join(tree, `${id}.txt`), `${id}\n`);
  g2('add', '-A', '--', `${id}.txt`);
  g2('commit', '-q', '-m', `squash ${id}`);
  const commit = g2('rev-parse', '--short=10', 'HEAD');
  const dir = join(tree, '.dwmt', 'runs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ schema: 'dwmt/run@1', run: id, sprint, target: TARGET, homeTree: canonPath(tree), mode: 'single', created: new Date().toISOString(), session_ids: [], tasks: [], finish: { status: 'squashed', commit, uat: 'pending', at: new Date().toISOString() } }));
  writeFileSync(join(dir, 'final-report.md'), `${header({ schema: 'dwmt/final-report@1', run: id, uat: 'pending' })}# R\n\n## UAT\n1. x\n`);
  return commit;
}

test('home tree: runHome reads homeTree, then mainTree, then the first tree (C-2, R-2)', () => {
  assert.equal(runHome({ homeTree: L.second }, L.first), canonPath(L.second));
  assert.equal(runHome({ mainTree: L.first }, L.second), canonPath(L.first));
  assert.equal(runHome({ homeTree: L.second, mainTree: L.first }, L.first), canonPath(L.second));
  assert.equal(runHome({}, L.second), canonPath(mainTreeOf(L.second)));
  assert.equal(runHome({}, L.second), canonPath(L.first));
});

test('home tree: contextHome is the tree holding the target, from either tree (D-3)', () => {
  assert.equal(contextHome(L.first), canonPath(L.second));
  assert.equal(contextHome(L.second), canonPath(L.second));
});

test('home tree: contextHome of a run tree follows its run.json (homeTree, else mainTree) (D-3, R-2)', () => {
  const { first, second, g2 } = layout();
  // In-place run in the second tree: the target leaves it, run.json says home is the second.
  g2('switch', '-q', '-c', 'dwmt/r');
  mkdirSync(join(second, '.dwmt', 'runs', 'r'), { recursive: true });
  writeFileSync(join(second, '.dwmt', 'runs', 'r', 'run.json'), JSON.stringify({ run: 'r', homeTree: canonPath(second) }));
  assert.equal(contextHome(second), canonPath(second));
  // An older run worktree: only `mainTree`.
  const third = join(mkdtempSync(join(tmpdir(), 'dwmt-ht-')), 'third');
  gitIn(first)('worktree', 'add', '-q', '-b', 'dwmt/old', third);
  mkdirSync(join(third, '.dwmt', 'runs', 'old'), { recursive: true });
  writeFileSync(join(third, '.dwmt', 'runs', 'old', 'run.json'), JSON.stringify({ run: 'old', mainTree: first }));
  assert.equal(contextHome(third), canonPath(first));
  // A tree on `topic` with the target checked out nowhere: the tree itself.
  gitIn(first)('switch', '-q', '-c', 'topic');
  assert.equal(contextHome(first), canonPath(first));
});

test('home tree: mergeWaitReason without a target tree squashes only in the home tree (D-5, bug 12, R-1)', () => {
  const base = { run: 'r', target: TARGET, branch: 'develop' };
  assert.equal(mergeWaitReason(L.first, { ...base, homeTree: L.first }, null), null);
  // Bug 12 itself: an in-place run in a tree other than the first squashes there (the old first-tree rule said no).
  assert.equal(mergeWaitReason(L.second, { ...base, homeTree: L.second }, null), null);
  const w = mergeWaitReason(L.first, { ...base, homeTree: L.second }, null);
  assert.equal(w?.reason, 'target-dirty');
  assert.ok(w.detail.includes(canonPath(L.second)), w.detail);
  assert.ok(w.detail.includes(TARGET), w.detail);
  assert.doesNotMatch(w.detail, /główne drzewo/);
});

// T-2/F-2: the supervisor status and the run event follow homeTree, not the first tree (AC-1, AC-9).
test('home tree: writeStatus and runEvent of a run whose home is the second tree write under the second (AC-1, AC-9, R-1)', () => {
  const run = { run: 'r-ws', sprint: 's-ws', homeTree: canonPath(L.second), task: 1, count: 1, tasks: [] };
  const file = writeStatus(L.first, run, 'running');
  assert.equal(canonPath(file), canonPath(join(L.second, '.dwmt', 'supervisor', 'status', 's-ws.json')));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).state, 'running');
  assert.ok(!existsSync(join(L.first, '.dwmt', 'supervisor', 'status', 's-ws.json')), 'nothing under the first tree');
  const saved = process.env.DWMT_HOME;
  process.env.DWMT_HOME = mkdtempSync(join(tmpdir(), 'dwmt-home-'));
  try {
    runEvent(L.first, run, 'task-start');
    const evs = readFileSync(eventsFile(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(evs.at(-1)?.type, 'task-start');
    assert.equal(evs.at(-1).project?.root, canonPath(L.second));
  } finally {
    if (saved === undefined) delete process.env.DWMT_HOME; else process.env.DWMT_HOME = saved;
  }
});

// T-2/F-4: the supervisor's merge-wait check is finish's check: with the target checked out nowhere it applies the
// home-tree rule, so a run worktree under the home never counts as cleared; a target checked out in a clean tree does.
test('home tree: supervisor mergeCleared applies finish\'s rule for a target checked out nowhere (T-2/F-4)', () => {
  const d = repo();
  const g = gitIn(d);
  g('branch', 'feature/none');
  const wt = join(mkdtempSync(join(tmpdir(), 'dwmt-ht-')), 'run');
  g('worktree', 'add', '-q', '-b', 'dwmt/r-mc', wt);
  const item = (id, target) => {
    const root = join(wt, '.dwmt', 'runs', id);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'run.json'), JSON.stringify({ run: id, target, branch: 'dwmt/r-mc', homeTree: canonPath(d) }));
    return { root, worktree: wt };
  };
  assert.equal(realOps.mergeCleared(d, item('r-none', 'feature/none')), false, 'finish in the run worktree would wait again');
  assert.equal(realOps.mergeCleared(d, item('r-held', 'master')), true, 'target in a clean tree: cleared');
});

// T-2/F-3: a run copy whose recorded home no longer exists (repo moved; pre-K3 `mainTree`) is recorded in the calling
// tree, as the removed targetTree fallback did.
test('home tree: uat record of a run whose recorded home tree is gone falls back to the calling tree (T-2/F-3)', () => {
  const d = repo();
  const g = gitIn(d);
  const gone = join(mkdtempSync(join(tmpdir(), 'dwmt-ht-')), 'moved-away', 'repo');
  for (const id of ['r-gone', 'r-gone2']) {
    const dir = join(d, '.dwmt', 'runs', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ schema: 'dwmt/run@1', run: id, target: 'master', mainTree: gone, mode: 'single', created: new Date().toISOString(), session_ids: [], tasks: [], finish: { status: 'squashed', commit: g('rev-parse', 'HEAD'), uat: 'pending' } }));
    writeFileSync(join(dir, 'final-report.md'), `${header({ schema: 'dwmt/final-report@1', run: id, uat: 'pending' })}# R\n\n## UAT\n1. x\n`);
  }
  const res = join(mkdtempSync(join(tmpdir(), 'dwmt-ht-')), 'res.json');
  writeFileSync(res, JSON.stringify({ result: 'positive', findings: [] }));
  const late = cli(d, 'uat', 'record', 'r-gone', res, '--late');
  assert.equal(late.json?.ok, true, late.out);
  const st = cli(d, 'uat', 'start', 'r-gone2');
  assert.equal(st.json?.ok, true, st.out);
  try {
    const rec = cli(d, 'uat', 'record', 'r-gone2', res);
    assert.equal(rec.json?.ok, true, rec.out);
  } finally { cli(d, 'uat', 'release'); }
  assert.ok(!existsSync(gone), 'nothing created at the old home');
});

test('home tree: uat list from the first tree lists a copy that lives only in the second (D-4, R-1)', () => {
  squashedCopy(L.second, 'r-list', 's-list');
  const r = cli(L.first, 'uat', 'list').json;
  assert.equal(r?.ok, true, JSON.stringify(r));
  assert.ok(r.waiting.some((x) => x.startsWith('s-list:')), JSON.stringify(r.waiting));
});

test('home tree: uat start from the first tree checks the squash on refs/heads/<target> and puts the hold (D-18, bug 13, R-1)', () => {
  const commit = squashedCopy(L.second, 'r-start', 's-start');
  let released = null;
  try {
    const r = cli(L.first, 'uat', 'start', 's-start').json;
    assert.equal(r?.ok, true, JSON.stringify(r));
    assert.equal(r.head, L.g2('rev-parse', '--short=10', 'HEAD'));
    assert.equal(commit, r.head);
  } finally { released = cli(L.first, 'uat', 'release').json; }
  // The hold was put under the target's merge key (the same key from either tree), then released.
  assert.deepEqual(released?.released, [mergeKey(L.second, TARGET).key], JSON.stringify(released));
});

test('home tree: in-place init in the second tree records homeTree and no mainTree/targetTree (D-2, AC-1)', () => {
  const { second } = layout({ setup: true });
  const pf = cli(second, 'preflight', '--slug', 'ht');
  assert.equal(pf.json?.ok, true, pf.out);
  const i = cli(second, 'init', '--run', pf.json.run);
  assert.equal(i.json?.ok, true, i.out);
  const rj = JSON.parse(readFileSync(join(second, '.dwmt', 'runs', pf.json.run, 'run.json'), 'utf8'));
  assert.equal(rj.homeTree, canonPath(second));
  assert.ok(!('mainTree' in rj));
  assert.ok(!('targetTree' in rj));
  assert.equal(gitIn(second)('branch', '--show-current'), `dwmt/${pf.json.run}`);
  // The run's home is still the second tree once the target left it.
  assert.equal(contextHome(second), canonPath(second));
});

test('home tree: init --worktree from the first tree puts the run under the home tree, local files first from the caller (D-5, AC-1)', () => {
  const { first, second } = layout({ setup: true });
  writeFileSync(join(first, '.claude', 'settings.local.json'), '{"from":"first"}\n');
  writeFileSync(join(second, '.claude', 'settings.local.json'), '{"from":"second"}\n');
  const pf = cli(first, 'preflight', '--slug', 'wt');
  assert.equal(pf.json?.ok, true, pf.out);
  const i = cli(first, 'init', '--run', pf.json.run, '--worktree');
  assert.equal(i.json?.ok, true, i.out);
  const wt = i.json.worktree;
  assert.equal(canonPath(wt), canonPath(join(second, '.claude', 'worktrees', pf.json.run)));
  const rj = JSON.parse(readFileSync(join(wt, '.dwmt', 'runs', pf.json.run, 'run.json'), 'utf8'));
  assert.equal(rj.homeTree, canonPath(second));
  assert.ok(!('mainTree' in rj) && !('targetTree' in rj));
  assert.equal(readFileSync(join(wt, '.claude', 'settings.local.json'), 'utf8'), '{"from":"first"}\n');
  assert.equal(gitIn(second)('status', '--porcelain', '--', '.claude/worktrees'), '', 'run worktree ignored in the home tree');
  // Present only in the home tree: copied from there.
  rmSync(join(first, '.claude', 'settings.local.json'));
  const pf2 = cli(first, 'preflight', '--slug', 'wt2');
  const i2 = cli(first, 'init', '--run', pf2.json.run, '--worktree');
  assert.equal(i2.json?.ok, true, i2.out);
  assert.equal(readFileSync(join(i2.json.worktree, '.claude', 'settings.local.json'), 'utf8'), '{"from":"second"}\n');
});

// ---------- T-3 (K3): the product layer, the page and the full sprint flow with the home outside the first tree ----------

// dwmt setup and product init committed on master; second tree from `worktree add -b feature/x` (= git.target, holds the
// product dir); the first switched to `develop`, where the product dir is removed and committed (D-13).
function productLayout() {
  const first = repo();
  const g = gitIn(first);
  const s = cli(first, 'setup');
  assert.equal(s.code, 0, s.out);
  const f = join(first, '.claude', 'dwmt.json');
  const cfg = JSON.parse(readFileSync(f, 'utf8'));
  writeFileSync(f, `${JSON.stringify({ ...cfg, git: { ...cfg.git, target: TARGET }, verify: { full: ['node -e 0'] }, run: { ...cfg.run, priceGate: false }, product: { view: { publish: null } } }, null, 2)}\n`);
  const p = pr(first, 'init', '--goal', 'Home tree pilot');
  assert.equal(p.code, 0, p.out);
  g('add', '-A');
  assert.equal(cli(first, 'setup').code, 0, 'agents of the product layer');
  g('add', '-A');
  g('commit', '-q', '-m', 'setup and product');
  const second = join(mkdtempSync(join(tmpdir(), 'dwmt-ht-')), 'second');
  g('worktree', 'add', '-q', '-b', TARGET, second);
  g('switch', '-q', '-c', 'develop');
  g('rm', '-r', '-q', 'docs/product');
  g('commit', '-q', '-m', 'no product on develop');
  // product init ran here while this was still the home (.dwmt/product/changes.jsonl): the flows start from a clean .dwmt.
  rmSync(join(first, '.dwmt'), { recursive: true, force: true });
  rmSync(join(first, 'docs', 'product'), { recursive: true, force: true }); // git rm leaves the empty sprints/ dir
  assert.ok(!existsSync(join(first, 'docs', 'product')), 'no product dir in the first tree');
  return { first, second, g, g2: gitIn(second) };
}
// A roadmap line with its spec (state notes; init takes it with --force), committed in the second tree.
function sprintLine(second, id) {
  for (const a of [['roadmap', 'add', id, '--goal', `Goal ${id}`], ['spec', 'new', id]]) {
    const r = pr(second, ...a);
    assert.equal(r.code, 0, `${a.join(' ')}: ${r.out} ${r.err}`);
  }
  const g2 = gitIn(second);
  g2('add', '-A', '--', 'docs/product');
  g2('commit', '-q', '-m', `product ${id}`);
}
const roadmap = (tree) => readFileSync(join(tree, 'docs', 'product', 'roadmap.md'), 'utf8');
const BRIEF = (run, goal) => `${header({ schema: 'dwmt/brief@1', run, goal, mode: 'inline', acceptance: ['AC-1 file'], scope: ['*.txt'], verify: ['node -e 0'], decisions: [], risks: [], questions: [] })}# ${goal}\n\n## UAT\n1. Open the file → its text shows.\n`;
// The task of a run done as in s2.test.mjs#sprintDone, in `wt`.
function taskDone(wt, run, file) {
  writeFileSync(runFile(wt, run, 'brief.md'), BRIEF(run, `File ${file}`));
  writeFileSync(join(wt, file), `${file}\n`);
  for (const a of [['verify', run], ['review-input', run]]) { const r = cli(wt, ...a); assert.equal(r.code, 0, `${a[0]}: ${r.out}`); }
  put(wt, run, 'review-1.md', { schema: 'dwmt/review@1', round: 1, passes: ['correctness'], verdict: 'PASS', fix: [], acceptance: ['AC-1 met'], risks: [] });
  const c = cli(wt, 'commit', run);
  assert.equal(c.code, 0, c.out);
}
const nothingInFirst = (first) => { for (const d of ['runs', 'product', 'supervisor']) assert.ok(!existsSync(join(first, '.dwmt', d)), `nothing in .dwmt/${d} of the first tree`); };

test('home tree: product sync in the second tree closes a sprint whose run copy lives only there (runCopies, D-4, R-1)', () => {
  const { second } = productLayout();
  sprintLine(second, 's-copy');
  fakeRun(second, 'r-copy', { files: ['src/c.ts'], spec: 's-copy', uat: 'pending' });
  const s = pr(second, 'sync');
  assert.equal(s.code, 0, s.out);
  assert.match(roadmap(second), /\| s-copy \| done \|/);
});

test('home tree: in-place sprint in the second tree while the first is on develop: init, finish squashes, uat closes and archives, the page from the first lands in the second (D-13, AC-8, R-1)', () => {
  const t0 = Date.now();
  const { first, second, g2 } = productLayout();
  sprintLine(second, 's-ht');
  const pf = cli(second, 'preflight', '--slug', 'ht');
  assert.equal(pf.json?.ok, true, pf.out);
  const run = pf.json.run;
  const i = cli(second, 'init', '--run', run, '--mode', 'single', '--input', join(second, 'docs', 'product', 'sprints', 's-ht.md'), '--force');
  assert.equal(i.json?.ok, true, i.out);
  taskDone(second, run, 'ht.txt');
  const before = g2('rev-parse', TARGET);
  const fin = cli(second, 'finish', run).json;
  assert.equal(fin?.status, 'squashed', JSON.stringify(fin));
  assert.notEqual(g2('rev-parse', TARGET), before, 'squash on the target in the second tree');
  assert.ok(existsSync(join(second, '.dwmt', 'runs', run, 'run.json')), 'run copy in the second tree');
  const st = cli(second, 'uat', 'start', run).json;
  assert.equal(st?.ok, true, JSON.stringify(st));
  const res = join(mkdtempSync(join(tmpdir(), 'dwmt-ht-')), 'uat.json');
  writeFileSync(res, JSON.stringify({ result: 'positive', findings: [] }));
  const rec = cli(second, 'uat', 'record', run, res).json;
  assert.equal(rec?.ok, true, JSON.stringify(rec));
  assert.doesNotMatch(roadmap(second), /\| s-ht \|/, 'roadmap line closed');
  assert.ok(existsSync(join(second, 'docs', 'product', 'archive', 's-ht.md')), 'spec archived');
  // The page: `product view` from the first tree (no product dir there) writes it in the second, with its sprints.
  const v = pr(first, 'view');
  assert.equal(v.code, 0, `${v.out} ${v.err}`);
  const page = join(second, '.dwmt', 'product', 'view', 'index.html');
  assert.ok(existsSync(page));
  assert.match(readFileSync(page, 'utf8'), /s-ht/);
  // T-3/F-3: the header names the project (the repo's main folder), not the worktree that holds the target.
  const D = JSON.parse(/<script type="application\/json" id="dwmt-data">([\s\S]*?)<\/script>/.exec(readFileSync(page, 'utf8'))[1]);
  assert.equal(D.project, basename(first));
  nothingInFirst(first);
  console.log(`# home-tree flow (1): ${Date.now() - t0} ms`);
});

test('home tree: init --worktree from the second tree: homeTree = second, run worktree under it, finish squashes into the second (D-13, AC-8)', () => {
  const { first, second, g2 } = productLayout();
  const pf = cli(second, 'preflight', '--slug', 'wt2');
  assert.equal(pf.json?.ok, true, pf.out);
  const run = pf.json.run;
  const task = join(mkdtempSync(join(tmpdir(), 'dwmt-ht-')), 'task.md');
  writeFileSync(task, 'Add wt2.txt\n');
  const i = cli(second, 'init', '--run', run, '--mode', 'single', '--input', task, '--worktree');
  assert.equal(i.json?.ok, true, i.out);
  const wt = i.json.worktree;
  assert.equal(canonPath(wt), canonPath(join(second, '.claude', 'worktrees', run)));
  assert.equal(JSON.parse(readFileSync(join(wt, '.dwmt', 'runs', run, 'run.json'), 'utf8')).homeTree, canonPath(second));
  taskDone(wt, run, 'wt2.txt');
  const before = g2('rev-parse', TARGET);
  const fin = cli(wt, 'finish', run).json;
  assert.equal(fin?.status, 'squashed', JSON.stringify(fin));
  assert.notEqual(g2('rev-parse', TARGET), before);
  assert.ok(existsSync(join(second, 'wt2.txt')), 'squash checked out in the second tree');
  assert.ok(existsSync(join(second, '.dwmt', 'runs', run, 'run.json')), 'run copy in the second tree');
  nothingInFirst(first);
});

// Guard (AC-1, S-1, R-3): no script guesses the first worktree; `mainTreeOf(` is called only by run.mjs#runHome.
test('home tree: mainTreeOf( in dwmt/scripts only inside run.mjs#runHome (AC-1, R-3)', () => {
  const root = fileURLToPath(new URL('../scripts/', import.meta.url));
  const files = readdirSync(root, { recursive: true }).map((f) => String(f).replace(/\\/g, '/')).filter((f) => f.endsWith('.mjs'));
  const hits = [];
  for (const f of files) {
    readFileSync(join(root, f), 'utf8').split(/\r?\n/).forEach((l, n) => { if (/(?<!function )mainTreeOf\(/.test(l)) hits.push(`${f}:${n + 1}: ${l.trim()}`); });
  }
  assert.equal(hits.length, 1, hits.join('\n'));
  assert.match(hits[0], /^lib\/run\.mjs:\d+: export const runHome = /);
});
