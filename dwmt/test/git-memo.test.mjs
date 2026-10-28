import './tmp-root.mjs';
// Pamięć odczytów gita w procesie CLI (kt, D-11, R-5): odczyt z pamięci nigdy nie przeżywa zmiany przez git.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitRaw, git, enableGitMemo, clearGitMemo, isGitLookup } from '../scripts/lib/git.mjs';
import { repo, prepared, cli, runFile, gitIn } from './helpers.mjs';

const worktrees = (d) => git(['worktree', 'list', '--porcelain'], { cwd: d }).split(/\r?\n\r?\n/).filter((b) => b.trim()).length;
const outside = (d, ...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('memo off (default): an external worktree add is seen at once', () => {
  const d = repo();
  try {
    assert.equal(worktrees(d), 1);
    outside(d, 'worktree', 'add', '-q', '-b', 'w1', `${d}-w1`);
    assert.equal(worktrees(d), 2);
  } finally { enableGitMemo(false); }
});

test('memo on: an external change is not seen until clearGitMemo, and a git.mjs status call clears it too', () => {
  const d = repo();
  try {
    enableGitMemo();
    assert.equal(worktrees(d), 1);
    outside(d, 'worktree', 'add', '-q', '-b', 'w2', `${d}-w2`);
    assert.equal(worktrees(d), 1, 'remembered answer');
    clearGitMemo();
    assert.equal(worktrees(d), 2);
    outside(d, 'worktree', 'add', '-q', '-b', 'w3', `${d}-w3`);
    assert.equal(worktrees(d), 2, 'remembered again');
    git(['status', '--porcelain'], { cwd: d });
    assert.equal(worktrees(d), 3, 'a non-lookup call cleared the memo');
  } finally { enableGitMemo(false); }
});

test('memo on: a call with env (GIT_INDEX_FILE) is never stored', () => {
  const d = repo();
  try {
    enableGitMemo();
    const idx = join(d, '.git', 'index');
    const a = gitRaw(['worktree', 'list', '--porcelain'], { cwd: d, env: { GIT_INDEX_FILE: idx } });
    outside(d, 'worktree', 'add', '-q', '-b', 'w4', `${d}-w4`);
    const b = gitRaw(['worktree', 'list', '--porcelain'], { cwd: d, env: { GIT_INDEX_FILE: idx } });
    assert.notEqual(a.stdout, b.stdout);
    assert.equal(worktrees(d), 2, 'the env calls stored nothing');
  } finally { enableGitMemo(false); }
});

test('memo on: a commit through git.mjs clears it', () => {
  const d = repo();
  try {
    enableGitMemo();
    assert.equal(git(['branch', '--show-current'], { cwd: d }), 'master');
    git(['switch', '-q', '-c', 'x'], { cwd: d });
    assert.equal(git(['branch', '--show-current'], { cwd: d }), 'x');
    // non-zero results are stored as they are: git() throws the same way twice
    assert.throws(() => git(['rev-parse', '--verify', '--quiet', 'refs/heads/nope'], { cwd: d }));
    assert.throws(() => git(['rev-parse', '--verify', '--quiet', 'refs/heads/nope'], { cwd: d }));
    assert.equal(gitRaw(['rev-parse', '--verify', '-q', 'refs/heads/x'], { cwd: d }).status, 0);
  } finally { enableGitMemo(false); }
});

test('isGitLookup: only the listed read-only lookups', () => {
  for (const a of [['rev-parse', '--show-toplevel'], ['worktree', 'list', '--porcelain'], ['branch', '--show-current'],
    ['rev-parse', '--verify', '-q', 'refs/heads/m'], ['for-each-ref', '--format=%(refname:short)', 'refs/heads/dwmt/'],
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], ['rev-parse', '--git-path', 'index']]) assert.equal(isGitLookup(a), true, a.join(' '));
  for (const a of [['status', '--porcelain'], ['rev-parse', 'HEAD'], ['branch', '-D', 'x'], ['worktree', 'add', 'p'], ['rev-parse', '--verify', 'HEAD']]) assert.equal(isGitLookup(a), false, a.join(' '));
});

test('memo in the CLI: init switches the branch and later lookups in the same process see it', () => {
  const d = repo();
  const run = prepared(d);
  const rj = JSON.parse(readFileSync(runFile(d, run, 'run.json'), 'utf8'));
  assert.equal(rj.branch, gitIn(d)('branch', '--show-current'));
  const s = cli(d, 'state', run);
  assert.equal(s.code, 0, s.out);
  assert.equal(s.json.run, run);
  assert.notEqual(s.json.next, 'error');
});
