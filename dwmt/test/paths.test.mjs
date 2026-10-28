import './tmp-root.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { canonPath, samePath, pathKey, fwd } from '../scripts/lib/util.mjs';
import { taskName, autostart, legacyTasks } from '../scripts/lib/platform.mjs';
import { projectOf, eventsFile } from '../scripts/events.mjs';
import { LiveWriter } from '../scripts/lib/live.mjs';
import { ofProject } from '../scripts/watch.mjs';
import { shortAlias } from './short-path.mjs';
import { mergeKey } from '../scripts/lib/finish.mjs';
import { repo, gitIn, cli, SCRIPT, DWMT_HOME } from './helpers.mjs';

const long = mkdtempSync(join(tmpdir(), 'dwmt-long-directory-name-'));
const alias = shortAlias(long);
const NO_ALIAS = process.platform === 'win32' ? 'the volume gives no 8.3 short name for the test directory' : 'no 8.3 short names off win32';
const win = process.platform === 'win32';

test('paths (1): short alias and long form are one canonical path (C-1, R-1)', (t) => {
  if (!alias) return t.skip(NO_ALIAS);
  assert.notEqual(fwd(alias).toLowerCase(), fwd(long).toLowerCase());
  assert.equal(canonPath(alias), canonPath(long));
  assert.equal(canonPath(long), fwd(realpathSync.native(long)));
  assert.ok(samePath(alias, long));
  assert.equal(pathKey(alias), pathKey(long));
});

test('paths (2): a missing path below the alias resolves without throwing (R-4)', () => {
  const base = alias ?? long;
  const c = canonPath(join(base, 'missing'));
  assert.ok(c.endsWith('/missing'), c);
  assert.ok(!c.includes('\\'));
  assert.equal(samePath(join(base, 'missing'), join(base, 'other')), false);
});

test('paths (3): no trailing slash except a root', () => {
  assert.equal(canonPath(`${long}/`), canonPath(long));
  assert.equal(canonPath(`${long}\\`), canonPath(long));
  if (win) assert.match(canonPath('C:\\'), /^[A-Za-z]:\/$/);
  else assert.equal(canonPath('/'), '/');
});

test('paths: samePath rules for missing stored paths (C-1, R-4)', () => {
  if (win) {
    assert.equal(samePath('C:/Nope/A', 'c:\\nope\\a'), true);
    assert.equal(pathKey('C:/Nope/A'), pathKey('c:\\nope\\a'));
  } else {
    assert.equal(samePath('/tmp/nope/A', '/tmp/nope/a'), false);
    assert.equal(samePath('/tmp/nope/A', '/tmp/nope//A/'), true);
  }
  assert.equal(samePath(long, join(long, '..', 'x')), false);
});

test('paths (4): taskName keeps the old name and joins both spellings (D-15, R-3)', (t) => {
  const old = `dwmt-supervisor-${createHash('sha256').update(fwd(realpathSync.native(long)).toLowerCase()).digest('hex').slice(0, 8)}`;
  assert.equal(taskName(long), old);
  assert.equal(taskName(fwd(long)), old);
  if (!alias) return t.skip(NO_ALIAS);
  assert.equal(taskName(alias), taskName(long));
});

// T-1/F-1: a task an earlier version named after another spelling of the project (subst or mapped drive, short 8.3
// name) is unregistered with its start files on disable and on enable; another project's task stays.
test('paths (4): autostart removes the project task of an earlier name, keeps other projects (T-1/F-1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwmt-sup-'));
  const log = join(dir, 'platform.log');
  const old = 'dwmt-supervisor-deadbeef';
  const other = 'dwmt-supervisor-cafebabe';
  const spelling = alias ?? `${long.replace(/\//g, '\\')}\\`;
  const shim = (name, root) => { writeFileSync(join(dir, `${name}.mjs`), `// dwmt: plik startowy\n// Projekt: ${root}\n`); writeFileSync(join(dir, `${name}.vbs`), 'x'); };
  const saved = process.env.DWMT_PLATFORM_LOG;
  process.env.DWMT_PLATFORM_LOG = log;
  try {
    shim(old, spelling);
    shim(other, join(long, 'elsewhere'));
    assert.deepEqual(legacyTasks(canonPath(long), dir), [old]);
    autostart(false, { root: canonPath(long), script: '/x/scripts/supervise.mjs', dir });
    assert.equal(existsSync(join(dir, `${old}.mjs`)) || existsSync(join(dir, `${old}.vbs`)), false, 'old start files removed');
    assert.equal(existsSync(join(dir, `${other}.mjs`)), true, 'another project keeps its task');
    const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(calls.filter((c) => c.fn === 'autostart-legacy').map((c) => c.name), [old]);
    shim(old, spelling);
    autostart(true, { root: canonPath(long), script: '/x/scripts/supervise.mjs', dir });
    assert.equal(existsSync(join(dir, `${old}.mjs`)), false, 'enable leaves one task per project');
    assert.equal(existsSync(join(dir, `${taskName(long)}.mjs`)), true);
    assert.deepEqual(legacyTasks(canonPath(long), dir), [], 'the current name is not a legacy task');
  } finally {
    if (saved === undefined) delete process.env.DWMT_PLATFORM_LOG; else process.env.DWMT_PLATFORM_LOG = saved;
  }
});

test('paths (4): projectOf and ofProject on both spellings (AC-9, R-1)', (t) => {
  assert.equal(projectOf(long).root, canonPath(long));
  assert.equal(ofProject({ project: { root: 'C:/other' } }, long), false);
  assert.equal(ofProject({}, long), true);
  assert.equal(ofProject({ project: { root: long } }, ''), true);
  assert.equal(ofProject({ project: { root: fwd(long) } }, long), true);
  if (!alias) return t.skip(NO_ALIAS);
  assert.equal(projectOf(alias).root, canonPath(long));
  assert.equal(projectOf(alias).name, canonPath(long).split('/').pop());
  assert.equal(ofProject({ project: { root: alias } }, long), true);
  assert.equal(ofProject({ project: { root: long } }, alias), true);
});

test('paths (5): a child process with a short TEMP sees the canonical long path (AC-3, R-1)', (t) => {
  if (!alias) return t.skip(NO_ALIAS);
  const util = pathToFileURL(join(import.meta.dirname, '..', 'scripts', 'lib', 'util.mjs')).href;
  const code = `import { canonPath } from ${JSON.stringify(util)}; import { tmpdir } from 'node:os'; console.log(JSON.stringify({ raw: tmpdir(), canon: canonPath(tmpdir()) }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: alias, encoding: 'utf8', env: { ...process.env, TEMP: alias, TMP: alias, TMPDIR: alias } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(fwd(out.raw).toLowerCase(), fwd(alias).toLowerCase());
  assert.equal(out.canon, canonPath(long));
});

// T-2 (AC-9, R-4): init reached through the short spelling of the repo stores the canonical home tree; the merge key
// is one for both spellings and keeps the old (lower-cased git-form) hash (D-15).
test('paths (6): init through a short alias writes homeTree as the canonical long path (AC-9, R-4)', (t) => {
  const d = repo();
  const s = shortAlias(d);
  if (!s) return t.skip(NO_ALIAS);
  const g = gitIn(d);
  assert.equal(cli(d, 'setup').code, 0);
  g('add', '-A');
  g('commit', '-q', '-m', 'dwmt setup');
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: 'sess-1', DWMT_HOME, TEMP: s, TMP: s };
  const run = (...a) => { const r = spawnSync(process.execPath, [SCRIPT, ...a], { cwd: s, encoding: 'utf8', env }); try { return JSON.parse(r.stdout); } catch { return { raw: r.stdout + r.stderr }; } };
  const pf = run('preflight', '--slug', 'alias');
  assert.equal(pf.ok, true, JSON.stringify(pf));
  const i = run('init', '--run', pf.run);
  assert.equal(i.ok, true, JSON.stringify(i));
  const rj = JSON.parse(readFileSync(join(d, '.dwmt', 'runs', pf.run, 'run.json'), 'utf8'));
  assert.equal(rj.homeTree, canonPath(d));
  assert.equal(rj.homeTree, fwd(realpathSync.native(d)));
});

test('paths (7): mergeKey is one key for the alias and the long path, equal to the old hash (D-15, R-4)', (t) => {
  const d = repo();
  const long = realpathSync.native(d);
  const old = `merge-${createHash('sha256').update(`${fwd(resolve(long, '.git')).toLowerCase()}\nmaster`).digest('hex').slice(0, 12)}`;
  assert.equal(mergeKey(d, 'master').key, old);
  const s = shortAlias(d);
  if (!s) return t.skip(NO_ALIAS);
  assert.equal(mergeKey(s, 'master').key, mergeKey(d, 'master').key);
  assert.equal(mergeKey(s, 'master').repo, canonPath(join(d, '.git')));
});

test('paths (8): a live writer built from the short alias lists a run whose homeTree is the long path and keeps its events (D-12, R-2)', (t) => {
  const d = repo();
  const s = shortAlias(d);
  if (!s) return t.skip(NO_ALIAS);
  const home = canonPath(d);
  const saved = process.env.DWMT_HOME;
  process.env.DWMT_HOME = mkdtempSync(join(tmpdir(), 'dwmt-home-'));
  try {
    const root = join(d, '.dwmt', 'runs', 'r-alias');
    mkdirSync(join(root, 'tasks', '1'), { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(join(root, 'run.json'), JSON.stringify({ schema: 'dwmt/run@1', run: 'r-alias', rules: '2.9', mode: 'single', phase: 'implement', branch: 'dwmt/r-alias', target: 'master', homeTree: home, created: now, task: 1, count: 1, tasks: [{ k: 1, started: {}, trees: {}, units: {}, repairs: {}, sessions: [] }], session_ids: [], finish: null, updated: now }));
    mkdirSync(process.env.DWMT_HOME, { recursive: true });
    appendFileSync(eventsFile(), `${JSON.stringify({ ts: now, type: 'task-start', project: { root: home }, run: 'r-alias' })}\n`);
    const w = new LiveWriter(s, { transcripts: mkdtempSync(join(tmpdir(), 'dwmt-tr-')) });
    assert.deepEqual(w.build().runs.map((x) => x.run), ['r-alias']);
    w.events();
    assert.equal(w.lastEvent('r-alias', 'task-start')?.project?.root, home);
  } finally { if (saved === undefined) delete process.env.DWMT_HOME; else process.env.DWMT_HOME = saved; }
});
