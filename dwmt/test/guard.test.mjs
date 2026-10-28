import './tmp-root.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verdict } from '../hooks/guard-destructive.mjs';

const DENY = [
  ['Bash', 'git push'],
  ['Bash', 'git push origin master --force'],
  ['Bash', 'cd x && git -C "D:/a b" push'],
  ['PowerShell', 'git push; echo ok'],
  ['Bash', 'git reset --hard HEAD~1'],
  ['Bash', 'git reset -q --hard'],
  ['Bash', 'git checkout -- .'],
  ['Bash', 'git checkout .'],
  ['Bash', 'git restore .'],
  ['Bash', 'git restore -- .'],
  ['Bash', 'git restore --staged --worktree .'],
  ['Bash', 'git clean -fd'],
  ['Bash', 'git clean -xdf'],
  ['Bash', 'git clean --force'],
  ['Bash', 'git stash'],
  ['Bash', 'git stash push -m x'],
  ['PowerShell', 'git stash pop'],
  ['Bash', 'git branch -D feature'],
  ['Bash', 'git branch --delete --force feature'],
  ['Bash', 'git branch -d -f feature'],
  ['Bash', 'git branch -df feature'],
  ['Bash', 'git branch -Df feature'],
  ['Bash', 'git checkout HEAD -- .'],
  ['Bash', 'git checkout -f'],
  ['Bash', 'git push # dwmt.mjs finish'],
  ['Bash', 'rm -rf node_modules'],
  ['Bash', 'rm -fr build'],
  ['Bash', 'rm -r -f build'],
  ['Bash', 'rm --recursive --force build'],
  ['Bash', 'echo a | rm -Rf /tmp/x'],
  ['PowerShell', 'Remove-Item -Recurse -Force build'],
  ['PowerShell', 'Remove-Item build -Recurse'],
  ['PowerShell', 'remove-item -r build'],
  ['PowerShell', 'rm -Rec build'],
  ['PowerShell', 'ri build -Recurse:$true'],
  ['PowerShell', 'Remove-Item -Path "a b" -Recurse'],
  ['PowerShell', 'cmd /c rd /s /q build'],
  ['PowerShell', 'rm -rf build'],
];

const ALLOW = [
  ['Bash', 'git status'],
  ['Bash', 'git commit -m "opis"'],
  ['Bash', 'git reset HEAD file.txt'],
  ['Bash', 'git checkout -b nowa'],
  ['Bash', 'git checkout .gitignore'],
  ['Bash', 'git restore src/a.js'],
  ['Bash', 'git restore --staged .'],
  ['Bash', 'git clean -n'],
  ['Bash', 'git stash list'],
  ['Bash', 'git branch -d merged'],
  ['Bash', 'git checkout -- src/a.js'],
  ['Bash', 'git branch --list -a'],
  ['Bash', 'git pull'],
  ['Bash', 'rm file.txt'],
  ['Bash', 'rm -r build'],
  ['Bash', 'rm -f file.txt'],
  ['PowerShell', 'Remove-Item file.txt'],
  ['PowerShell', 'Remove-Item -Force file.txt'],
  ['PowerShell', 'Get-ChildItem -Recurse'],
  ['Bash', 'node "D:/x/dwmt.mjs" finish 2026-10-01-a --cleanup'],
  ['Bash', 'npm run test -- --grep push'],
  ['Bash', 'grep -rf patterns.txt src'],
];

test('guard: odmowy', () => {
  for (const [tool, cmd] of DENY) assert.ok(verdict(cmd, tool), `${tool}: ${cmd}`);
});

test('guard: dozwolone', () => {
  for (const [tool, cmd] of ALLOW) assert.equal(verdict(cmd, tool), null, `${tool}: ${cmd}`);
});

const SCRIPT = fileURLToPath(new URL('../hooks/guard-destructive.mjs', import.meta.url));
// The executor's own session may carry DWMT_RUN or DWMT_GUARD_SCOPE: every spawned hook gets an explicit env.
const hookEnv = (extra = {}) => {
  const env = { ...process.env };
  delete env.DWMT_RUN;
  delete env.DWMT_GUARD_SCOPE;
  return { ...env, ...extra };
};
const spawnHook = (ev, extra) => spawnSync(process.execPath, [SCRIPT], { input: typeof ev === 'string' ? ev : JSON.stringify(ev), encoding: 'utf8', env: hookEnv(extra) });
const reason = (r) => JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;

test('guard: wejście hooka (stdin JSON) daje permissionDecision deny', () => {
  const deny = spawnHook({ tool_name: 'PowerShell', tool_input: { command: 'git stash' } }, { DWMT_RUN: 'r-1' });
  assert.equal(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(spawnHook({ tool_name: 'Bash', tool_input: { command: 'git status' } }, { DWMT_RUN: 'r-1' }).stdout, '');
});

const gitInit = (d) => assert.equal(spawnSync('git', ['init', '-q', d], { encoding: 'utf8' }).status, 0);
const tempRepo = () => { const d = mkdtempSync(join(tmpdir(), 'dwmt-guard-')); gitInit(d); return d; };
const writeRun = (tree, id, run) => {
  mkdirSync(join(tree, '.dwmt', 'runs', id), { recursive: true });
  writeFileSync(join(tree, '.dwmt', 'runs', id, 'run.json'), JSON.stringify({ id, session_ids: [], tasks: [], callers: [], finish: null, ...run }));
};
const push = (cwd, sid) => ({ tool_name: 'Bash', tool_input: { command: 'git push' }, session_id: sid, cwd });

test('guard: sesje przebiegu i zakres', async () => {
  const { hookMain } = await import('../hooks/guard-destructive.mjs');
  // AC-5 (a), R-2: no marker, no runs → passes; a cwd that does not exist → passes.
  const empty = tempRepo();
  assert.equal(hookMain(push(empty, 's-2'), {}), null);
  assert.equal(spawnHook(push(empty, 's-2')).stdout, '');
  assert.equal(spawnHook(push(join(empty, 'nie', 'ma'), 's-2')).stdout, '');
  // AC-5 (b), R-1: the marker from the driver or launch → today's message.
  assert.match(reason(spawnHook(push(empty, 's-2'), { DWMT_RUN: 'r-1' })), /commit robi skrypt dwmt/);
  // AC-5 (c), R-1: session id listed in an unfinished run.
  const d = tempRepo();
  writeRun(d, 'r1', { session_ids: ['s-1'] });
  assert.match(reason(spawnHook(push(d, 's-1'))), /commit robi skrypt dwmt/);
  assert.equal(spawnHook(push(d, 's-2')).stdout, '');
  writeRun(d, 'r1', { session_ids: ['s-1'], finish: { status: 'squashed' } });
  assert.equal(spawnHook(push(d, 's-1')).stdout, '', 'squashed run is closed');
  writeRun(d, 'r1', { session_ids: ['s-1'], finish: { status: 'merge-wait' } });
  assert.match(reason(spawnHook(push(d, 's-1'))), /commit robi skrypt dwmt/, 'D-16: merge-wait is open');
  // T-4/F-3: finish stops that wait for the run's own session to repair the tree are open; only squashed and left close.
  for (const status of ['conflict', 'red', 'env', 'deferred-major']) {
    writeRun(d, 'r1', { session_ids: ['s-1'], finish: { status } });
    assert.match(reason(spawnHook(push(d, 's-1'))), /commit robi skrypt dwmt/, `finish ${status} is open`);
  }
  writeRun(d, 'r1', { session_ids: ['s-1'], finish: { status: 'left' } });
  assert.equal(spawnHook(push(d, 's-1')).stdout, '', 'left run is closed');
  writeRun(d, 'r1', { session_ids: ['s-1'], stopped: { status: 'stopped' } });
  assert.equal(spawnHook(push(d, 's-1')).stdout, '', 'D-16: stopped run is closed');
  // AC-5 (d): only in tasks[].sessions, only in callers[].id.
  writeRun(d, 'r1', { tasks: [{ id: 1, sessions: ['s-1'] }] });
  assert.match(reason(spawnHook(push(d, 's-1'))), /commit robi skrypt dwmt/);
  writeRun(d, 'r1', { callers: [{ id: 's-1', from: 'x', to: 'x' }] });
  assert.match(reason(spawnHook(push(d, 's-1'))), /commit robi skrypt dwmt/);
  // Unparsable run file is skipped silently.
  mkdirSync(join(d, '.dwmt', 'runs', 'zly'), { recursive: true });
  writeFileSync(join(d, '.dwmt', 'runs', 'zly', 'run.json'), '{nie json');
  assert.match(reason(spawnHook(push(d, 's-1'))), /commit robi skrypt dwmt/);
  // AC-5 (e), R-1: the run lives in an extra worktree; cwd is a subdirectory of the first tree.
  const m = tempRepo();
  const g = (...a) => assert.equal(spawnSync('git', ['-C', m, ...a], { encoding: 'utf8' }).status, 0, a.join(' '));
  g('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init');
  const wt = join(mkdtempSync(join(tmpdir(), 'dwmt-guard-wt-')), 'wt');
  g('worktree', 'add', '-q', '-b', 'dwmt/r2', wt);
  writeRun(wt, 'r2', { session_ids: ['s-1'] });
  mkdirSync(join(m, 'sub'));
  assert.match(reason(spawnHook(push(join(m, 'sub'), 's-1'))), /commit robi skrypt dwmt/);
  assert.match(reason(spawnHook(push(wt, 's-1'))), /commit robi skrypt dwmt/, 'from the extra worktree too');
  assert.equal(spawnHook(push(m, 's-2')).stdout, '');
  // AC-5 (f): scope repo from env: another session in a repo with an unfinished run → deny naming guard.scope.
  const fr = reason(spawnHook(push(m, 's-2'), { DWMT_GUARD_SCOPE: 'repo' }));
  assert.match(fr, /guard\.scope/);
  assert.match(fr, /guard\.scope: repo/);
  assert.equal(spawnHook(push(empty, 's-2'), { DWMT_GUARD_SCOPE: 'repo' }).stdout, '');
  assert.equal(spawnHook(push(empty, 's-2'), { DWMT_GUARD_SCOPE: 'cokolwiek' }).stdout, '', 'unknown scope counts as run');
  // AC-5 (g): scope always from .claude/dwmt.json with comments, no runs.
  const a = tempRepo();
  mkdirSync(join(a, '.claude'));
  writeFileSync(join(a, '.claude', 'dwmt.json'), '// c\n{"guard":{"scope":"always"}}');
  const ar = reason(spawnHook(push(a, 's-2')));
  assert.match(ar, /always/);
  assert.match(ar, /DWMT_GUARD_SCOPE/);
  assert.equal(spawnHook(push(a, 's-2'), { DWMT_GUARD_SCOPE: 'run' }).stdout, '', 'env wins over the config');
  assert.equal(spawnHook({ tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: a }).stdout, '');
  // AC-5 (h): stdin that is not JSON → exit 0, no output.
  const bad = spawnHook('not json');
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, '');
});

test('guard: decide bez I/O', async () => {
  const { decide } = await import('../hooks/guard-destructive.mjs');
  assert.match(decide('git push', { scope: 'run', inRun: true, repoOpen: false }), /commit robi skrypt dwmt/);
  assert.equal(decide('git push', { scope: 'run', inRun: false, repoOpen: true }), null);
  assert.equal(decide('git push', { scope: 'repo', inRun: false, repoOpen: false }), null);
  assert.match(decide('git push', { scope: 'repo', inRun: false, repoOpen: true }), /guard\.scope: repo/);
  assert.match(decide('git push', { scope: 'always', inRun: false, repoOpen: false }), /zrób to sam/);
  assert.equal(decide(null, { scope: 'always', inRun: true, repoOpen: true }), null);
});

test('guard: AC-11 tylko moduły node:, bez procesów potomnych', () => {
  // R-2: the hook runs on every shell call; a child process or a heavy import would slow every one.
  const src = readFileSync(SCRIPT, 'utf8');
  const specs = [...src.matchAll(/\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g), ...src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]/g)].map((x) => x[1]);
  assert.ok(specs.length > 0);
  for (const s of specs) assert.ok(s.startsWith('node:'), s);
  assert.ok(!src.includes('child_process'));
});
