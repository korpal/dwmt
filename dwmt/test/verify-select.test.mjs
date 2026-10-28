import './tmp-root.mjs';
// Wybór komend verify w rundach poprawek i naprawy oraz zamykające verify (kt, AC-3, AC-6, R-3, R-4): czyste funkcje.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normPath, splitCommand, redFiles, selectRuns, mergeResults, closingDecision } from '../scripts/lib/verify-select.mjs';
import { stripJsonComments } from '../scripts/lib/config.mjs';

// Wzorzec z configu repo roboczego; repo publiczne nie ma `.claude/dwmt.json`, więc ta sama wartość wprost.
const CFG_FILE = fileURLToPath(new URL('../../.claude/dwmt.json', import.meta.url));
const REGEX = existsSync(CFG_FILE)
  ? JSON.parse(stripJsonComments(readFileSync(CFG_FILE, 'utf8'))).verify.failedFileRegex
  : '(?:not ok \\d+ - |test at )(\\S+\\.test\\.mjs)';
const GLOB = 'dwmt/test/*.test.mjs';
const L = 'linux';

// Prawdziwe wyjście `node --test a.test.mjs b.test.mjs` (Node 24, Windows, b czerwony), krok 2 planu.
const NODE_RED = `✔ fine (1.9398ms)
✖ broken (3.3153ms)
ℹ tests 2
ℹ pass 1
ℹ fail 1

✖ failing tests:

test at dwmt\\test\\b.test.mjs:3:1
✖ broken (3.3153ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  1 !== 2

      at TestContext.<anonymous> (file:///C:/Users/x/AppData/Local/Temp/tmp.3BhieKry60/dwmt/test/b.test.mjs:3:29)
`;

test('normPath: absolute, ./ and file:// forms give one repo-relative form; case kept on linux', () => {
  assert.equal(normPath('C:\\Repo\\dwmt\\test\\a.test.mjs', 'C:/repo', 'win32'), 'dwmt/test/a.test.mjs');
  assert.equal(normPath('./dwmt/test/a.test.mjs', 'C:/repo', 'win32'), 'dwmt/test/a.test.mjs');
  assert.equal(normPath('file:///C:/repo/dwmt/test/a.test.mjs', 'C:/repo', 'win32'), 'dwmt/test/a.test.mjs');
  assert.equal(normPath('dwmt\\Test\\A.test.mjs', 'C:/repo', 'win32'), 'dwmt/test/a.test.mjs');
  assert.equal(normPath('/repo/dwmt/Test/A.test.mjs', '/repo', 'linux'), 'dwmt/Test/A.test.mjs');
  assert.equal(normPath('./dwmt/Test/A.test.mjs', '/repo', 'linux'), 'dwmt/Test/A.test.mjs');
});

test('splitCommand: quotes group, the value drops them, backslashes stay', () => {
  const t = splitCommand('node --test --test-name-pattern="^(a|b) x" dwmt/test/a.test.mjs');
  assert.equal(t.length, 4);
  assert.equal(t[2].value, '--test-name-pattern=^(a|b) x');
  assert.equal(t[2].raw, '--test-name-pattern="^(a|b) x"');
  assert.equal(splitCommand("x 'a b' c\\d")[1].value, 'a b');
  assert.equal(splitCommand("x 'a b' c\\d")[2].value, 'c\\d');
});

test('redFiles: the repo regex names the file in the runner summary and in real node --test red output', () => {
  assert.deepEqual(redFiles('ok 1 - dwmt/test/a.test.mjs # 1.0 s\nnot ok 2 - dwmt/test/b.test.mjs # 3.1 s\n', REGEX, 'C:/repo', 'win32'), ['dwmt/test/b.test.mjs']);
  assert.deepEqual(redFiles(NODE_RED, REGEX, 'C:/repo', 'win32'), ['dwmt/test/b.test.mjs']);
  assert.deepEqual(redFiles('not ok 1 - t/b.test.mjs\nnot ok 2 - t/b.test.mjs\n', 'not ok \\d+ - (\\S+\\.test\\.mjs)', '/r', L), ['t/b.test.mjs']);
  assert.deepEqual(redFiles('', REGEX, '/r', L), []);
  assert.deepEqual(redFiles('not ok 1 - x.test.mjs', null, '/r', L), []);
});

const A = 'dwmt/test/a.test.mjs';
const B = 'dwmt/test/b.test.mjs';
const sel = (o) => selectRuns({ testGlob: GLOB, top: '/repo', platform: L, rerunCmd: 'node --test {file}', ...o });

test('selectRuns: no prev → run; green and nothing changed → carry; green with a changed named file → narrow', () => {
  const cmd = `node --test ${A} ${B}`;
  assert.equal(sel({ cmds: [cmd] }).selection[0].mode, 'run');
  assert.deepEqual(sel({ cmds: [cmd], prev: [{ cmd, exit: 0, red: [] }] }).selection[0], { cmd, mode: 'carry', runs: [], files: [] });
  const n = sel({ cmds: [cmd], prev: [{ cmd, exit: 0, red: [] }], changed: [B] }).selection[0];
  assert.equal(n.mode, 'narrow');
  assert.deepEqual(n.runs, [`node --test ${B}`]);
  assert.deepEqual(n.files, [B]);
});

test('selectRuns: red b keeps the flags and drops the green test argument', () => {
  const cmd = `node --test --test-name-pattern="x" ${A} ${B}`;
  const s = sel({ cmds: [cmd], prev: [{ cmd, exit: 1, red: [B] }] }).selection[0];
  assert.equal(s.mode, 'narrow');
  assert.deepEqual(s.runs, [`node --test --test-name-pattern="x" ${B}`]);
  // red file given in another path form
  const w = selectRuns({ cmds: [cmd], prev: [{ cmd, exit: 1, red: ['C:\\Repo\\dwmt\\test\\b.test.mjs'] }], testGlob: GLOB, top: 'C:/repo', platform: 'win32' }).selection[0];
  assert.deepEqual(w.runs, [`node --test --test-name-pattern="x" ${B}`]);
  // red plus a changed argument keeps both, which is every test argument → run
  assert.equal(sel({ cmds: [cmd], prev: [{ cmd, exit: 1, red: [B] }], changed: [A] }).selection[0].mode, 'run');
});

test('selectRuns: an aggregate red command reruns each red file through rerunCmd', () => {
  const cmd = 'node dwmt/test/run.mjs fast';
  const s = sel({ cmds: [cmd], prev: [{ cmd, exit: 1, red: ['dwmt/test/c.test.mjs'] }] }).selection[0];
  assert.equal(s.mode, 'rerun');
  assert.deepEqual(s.runs, ['node --test "dwmt/test/c.test.mjs"']);
  assert.equal(sel({ cmds: [cmd], prev: [{ cmd, exit: 1, red: ['dwmt/test/c.test.mjs'] }], rerunCmd: null }).selection[0].mode, 'run');
});

test('selectRuns: red without red files → run; testGlob null → only carry or run; changedUnrun lists unnamed changed tests', () => {
  const cmd = `node --test ${A} ${B}`;
  assert.equal(sel({ cmds: [cmd], prev: [{ cmd, exit: 1, red: [] }] }).selection[0].mode, 'run');
  const nul = (o) => selectRuns({ testGlob: null, top: '/repo', platform: L, rerunCmd: 'node --test {file}', ...o }).selection[0].mode;
  assert.equal(nul({ cmds: [cmd], prev: [{ cmd, exit: 0, red: [] }], changed: [B] }), 'carry');
  assert.equal(nul({ cmds: [cmd], prev: [{ cmd, exit: 1, red: [B] }] }), 'run');
  assert.equal(nul({ cmds: [cmd] }), 'run');
  const u = sel({ cmds: [cmd, 'node -e 0'], prev: [{ cmd, exit: 0, red: [] }], changed: ['dwmt/test/z.test.mjs', 'src/x.mjs'] });
  assert.deepEqual(u.changedUnrun, ['dwmt/test/z.test.mjs']);
  assert.deepEqual(u.selection.map((s) => s.mode), ['carry', 'run']);
  assert.deepEqual(u.runs, ['node -e 0']);
});

test('mergeResults: carried entry exit 0 ms 0; rerun of two files with one red; whole only when every mode is run', () => {
  const cmd = 'node dwmt/test/run.mjs fast';
  const s = sel({ cmds: [cmd, 'node -e 0'], prev: [{ cmd, exit: 1, red: ['dwmt/test/c.test.mjs', 'dwmt/test/d.test.mjs'] }, { cmd: 'node -e 0', exit: 0, red: [] }] });
  const prevBy = new Map([[cmd, { exit: 1 }], ['node -e 0', { exit: 0 }]]);
  const m = mergeResults(s.selection, [{ exit: 0, ms: 5, output: '' }, { exit: 1, ms: 7, output: 'x' }], prevBy, REGEX, '/repo', L);
  assert.equal(m.whole, false);
  assert.equal(m.entries.length, 2);
  assert.equal(m.entries[0].cmd, cmd);
  assert.notEqual(m.entries[0].exit, 0);
  assert.equal(m.entries[0].ms, 12);
  assert.deepEqual(m.entries[0].narrowed, ['dwmt/test/c.test.mjs', 'dwmt/test/d.test.mjs']);
  assert.deepEqual(m.entries[0].red, ['dwmt/test/d.test.mjs']);
  assert.equal(m.entries[0].ran, 'node --test "dwmt/test/c.test.mjs" ; node --test "dwmt/test/d.test.mjs"');
  assert.deepEqual(m.entries[1], { cmd: 'node -e 0', exit: 0, ms: 0, carried: true, red: [] });
  const w = mergeResults(sel({ cmds: ['node -e 0'] }).selection, [{ cmd: 'node -e 0', exit: 1, ms: 3, output: 'not ok 1 - dwmt/test/q.test.mjs' }], new Map(), REGEX, '/repo', L);
  assert.equal(w.whole, true);
  assert.deepEqual(w.entries[0].red, ['dwmt/test/q.test.mjs']);
});

test('closingDecision: every rule row', () => {
  const rec = (o) => ({ tree: 't1', ok: false, closing: true, repair: false, ...o });
  assert.equal(closingDecision({ record: null, cur: 't1' }), 'commit');
  assert.equal(closingDecision({ record: rec({ ok: true }), cur: 't2', closingRuns: 0 }), 'verify');
  assert.equal(closingDecision({ record: rec({ ok: true }), cur: 't2', closingRuns: 3 }), 'ask');
  assert.equal(closingDecision({ record: rec({ ok: true }), cur: 't1' }), 'commit');
  assert.equal(closingDecision({ record: rec({}), cur: 't1', accepted: true }), 'commit');
  assert.equal(closingDecision({ record: rec({ closing: false }), cur: 't1' }), 'commit');
  assert.equal(closingDecision({ record: rec({ repair: true }), cur: 't1', repairPending: true }), 'repair');
  assert.equal(closingDecision({ record: rec({ repair: true }), cur: 't1', repairPending: false }), 'ask');
  assert.equal(closingDecision({ record: rec({}), cur: 't1', repairPending: true }), 'ask');
});
