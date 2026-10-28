import './tmp-root.mjs';
// Target branch other than main/master: detection (origin/HEAD, the only branch, well-known names), setup question,
// `setup --target` written into the config text, runtime default independent of the checked-out branch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../scripts/dwmt.mjs';
import { detectTarget } from '../scripts/lib/config.mjs';
import { writeTarget } from '../scripts/lib/setup.mjs';
import { gitIn, cli } from './helpers.mjs';

// Repo with one commit on `first`, plus local branches `more` at the same commit.
function repoOn(first, ...more) {
  const d = mkdtempSync(join(tmpdir(), 'dwmt-t-'));
  const g = gitIn(d);
  g('init', '-q', '-b', first);
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'test');
  writeFileSync(join(d, 'a.txt'), 'one\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'start');
  for (const b of more) g('branch', b);
  return { d, g };
}
const cfgOf = (d) => JSON.parse(readFileSync(join(d, '.claude', 'dwmt.json'), 'utf8'));

test('only branch develop: setup writes it without asking, preflight targets it', () => {
  const { d } = repoOn('develop');
  const s = cli(d, 'setup').json;
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.equal(s.target, 'develop');
  assert.equal(s.targetSource, 'only-branch');
  assert.equal(s.targetQuestion, undefined);
  assert.equal(cfgOf(d).git.target, 'develop');
  const pf = cli(d, 'preflight', '--slug', 'x').json;
  assert.equal(pf.target, 'develop');
  assert.ok(!pf.blockers.some((b) => /develop/.test(b)), JSON.stringify(pf.blockers));
});

test('origin/HEAD wins over well-known names and the checked-out branch', () => {
  const { d, g } = repoOn('main', 'develop');
  g('update-ref', 'refs/remotes/origin/develop', 'HEAD');
  g('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
  const det = detectTarget(d);
  assert.deepEqual([det.target, det.source, det.certain], ['develop', 'origin/HEAD', true]);
  const s = cli(d, 'setup').json;
  assert.equal(s.target, 'develop');
  assert.equal(s.targetQuestion, undefined);
});

test('main and develop without origin/HEAD: setup asks, recommends the branch the user is on; --target pins the answer', () => {
  const { d, g } = repoOn('main', 'develop', 'feature-x');
  g('switch', '-q', 'develop');
  const s = cli(d, 'setup').json;
  assert.equal(s.ok, true);
  assert.equal(s.target, 'develop');
  assert.deepEqual(s.targetQuestion, { reason: 'uncertain', candidates: ['main', 'develop'], recommended: 'develop' });
  assert.equal(cfgOf(d).git.target, 'develop', 'config gets the recommendation until the user answers');
  const t = cli(d, 'setup', '--target', 'main').json;
  assert.equal(t.ok, true, JSON.stringify(t));
  assert.equal(t.wroteTarget, true);
  assert.equal(cfgOf(d).git.target, 'main');
  const again = cli(d, 'setup').json;
  assert.equal(again.targetSource, 'config');
  assert.equal(again.targetQuestion, undefined);
  assert.equal(cli(d, 'setup', '--target', 'nope').json.ok, false);
  assert.equal(cli(d, 'setup', '--target', 'dwmt/x').json.ok, false);
});

test('one well-known branch while the user sits on a feature branch: setup asks', () => {
  const { d, g } = repoOn('develop', 'feature-x');
  g('switch', '-q', 'feature-x');
  const det = detectTarget(d);
  assert.equal(det.certain, false);
  assert.deepEqual(det.candidates, ['develop', 'feature-x']);
  assert.equal(det.recommended, 'develop');
});

test('runtime default without git.target does not depend on the checked-out branch', () => {
  const { d, g } = repoOn('main', 'develop');
  for (const b of ['develop', 'dwmt/run-1', 'main']) {
    g('switch', '-q', ...(b.startsWith('dwmt/') ? ['-c', b] : [b]));
    const cfg = loadConfig(d);
    assert.equal(cfg.git.target, 'main', b);
    assert.equal(cfg.targetDefault, true);
  }
  const { d: m } = repoOn('master');
  assert.equal(loadConfig(m).git.target, 'master', 'old repos keep their default');
});

test('configured branch that does not exist: setup asks with the local candidates', () => {
  const { d } = repoOn('develop');
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude', 'dwmt.json'), JSON.stringify({ git: { target: 'master' } }));
  const s = cli(d, 'setup').json;
  assert.equal(s.target, 'master');
  assert.deepEqual(s.targetQuestion, { reason: 'missing', candidates: ['develop'], recommended: 'develop' });
});

test('writeTarget keeps comments and layout; refuses an edit that would not read back', () => {
  const d = mkdtempSync(join(tmpdir(), 'dwmt-t-'));
  const f = join(d, 'dwmt.json');
  writeFileSync(f, '{\n  // project config\n  "model": "opus",\n  "git": { "branchPrefix": "dwmt/", "target": "master" }\n}\n');
  assert.equal(writeTarget(f, 'develop').ok, true);
  assert.equal(readFileSync(f, 'utf8'), '{\n  // project config\n  "model": "opus",\n  "git": { "branchPrefix": "dwmt/", "target": "develop" }\n}\n');
  writeFileSync(f, '{\n  "git": { "finish": "squash" }\n}\n');
  assert.equal(writeTarget(f, 'develop').ok, true);
  assert.equal(readFileSync(f, 'utf8'), '{\n  "git": { "target": "develop", "finish": "squash" }\n}\n');
  writeFileSync(f, '{ "git": {} }');
  assert.equal(writeTarget(f, 'trunk').ok, true);
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).git.target, 'trunk');
  writeFileSync(f, '{\n  "model": "opus"\n}\n');
  assert.equal(writeTarget(f, 'develop').ok, true);
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { git: { target: 'develop' }, model: 'opus' });
  writeFileSync(f, '{}');
  assert.equal(writeTarget(f, 'develop').ok, true);
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { git: { target: 'develop' } });
  const tricky = '{ "git": { // old {branch}\n "target": "master" } }';
  writeFileSync(f, tricky);
  const r = writeTarget(f, 'develop');
  assert.equal(r.ok, false);
  assert.match(r.error, /by hand/);
  assert.equal(readFileSync(f, 'utf8'), tricky, 'file untouched');
});
