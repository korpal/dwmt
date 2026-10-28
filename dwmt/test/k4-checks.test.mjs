import './tmp-root.mjs';
// K4 T-3 (rules 2.11, D-7, D-8, D-23–D-25, D-32): kontrole skryptu po każdym kroku wykonawcy. Polityka (czysta), zapis S-n
// w recenzji i sprint 2.11 z fixtures28 przez verify, review-input i state; reguły 2.10, import i `scriptChecks.enabled: false` bez kontroli (R-4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runFile, header, asRules } from './helpers.mjs';
import { cliAs, hdr, RUN, PLAN, T1, T2, T3, repo28, start, writePlans, review, finding, execute, batchFile } from './fixtures28.mjs';
import { validateHeader } from '../scripts/dwmt.mjs';
import { checkChange, plannedTests, recordScriptFindings, CHECK_CMD } from '../scripts/lib/script-checks.mjs';

// ---------- polityka (D-7, D-25) ----------

const patch = (file, lines) => ({ file, text: [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, '@@ -1,3 +1,3 @@', ...lines, ''].join('\n') });

test('checkChange (D-25): removed assertion, added skip marker and an unreported file outside scope each give one hit', () => {
  const r = checkChange({
    chunks: [patch('src/a.test.ts', ['-  assert.equal(total, 90)', ' const x = 1;', '+test.skip(\'x\', () => {})']), patch('other/x.js', ['+x'])],
    scope: ['src/**'],
  });
  assert.deepEqual(r.hits.map((h) => [h.kind, h.file, h.detail.split(':')[0]]), [
    ['scope', 'other/x.js', 'changed outside the task scope and not named in `outOfScopeChanges`'],
    ['assert', 'src/a.test.ts', '1 assertion removed'],
    ['skip', 'src/a.test.ts', '1 skip/only/disabled marker added'],
  ]);
  assert.deepEqual(r.planned, []);
});

test('checkChange (D-25): reported, in-scope, .dwmt and product files are no scope hit; moved assertions and string literals are no hit', () => {
  const r = checkChange({
    chunks: [
      patch('other/x.js', ['+x']), patch('src/b.ts', ['+y']), patch('.dwmt/runs/r/run.json', ['+{}']), patch('docs/product/backlog.jsonl', ['+{}']),
      patch('src/m.test.ts', ['-  assert.equal(a, 1)', '+  assert.equal(a, 2)', '+  const s = "it.skip( and expect( in a string";']),
      patch('src/k.spec.ts', ['-  it.only(\'x\', f)', '+  it.only(\'y\', f)']),
    ],
    scope: ['src/**'], reported: ['other/x.js'], productDir: 'docs/product',
  });
  assert.deepEqual(r.hits, []);
});

test('checkChange (D-25): a strict matcher replaced by a weak one; a test file anchored by a [change] entry is planned, its skip marker still a hit', () => {
  const weak = checkChange({ chunks: [patch('src/w.test.ts', ['-  expect(total).toBe(90)', '+  expect(total).toBeTruthy()'])] });
  assert.deepEqual(weak.hits.map((h) => [h.kind, h.detail]), [['assert', 'a strict matcher replaced by a weak one']]);
  const java = checkChange({ chunks: [patch('src/main/BillTest.java', ['+  @Disabled', '-  assertEquals(90, total);'])] });
  assert.deepEqual(java.hits.map((h) => h.kind), ['assert', 'skip']);
  const entry = '[change] `src/w.test.ts` — the old identity case goes';
  const p = checkChange({ chunks: [patch('src/w.test.ts', ['-  assert.equal(invoice(100), 100)', '+  it.skip(\'later\', f)'])], planned: new Map([['src/w.test.ts', entry]]) });
  assert.deepEqual(p.planned, [{ file: 'src/w.test.ts', detail: '1 assertion removed', entry }]);
  assert.deepEqual(p.hits.map((h) => h.kind), ['skip'], 'skip markers have no exception');
  const glob = checkChange({ chunks: [patch('spec/w.rb', ['-  assert_equal 1, a', '-  assert(a)'])], testGlob: 'spec/**' });
  assert.deepEqual(glob.hits.map((h) => h.file), ['spec/w.rb'], 'verify.testFiles decides what a test file is');
});

test('checkChange (D-25, batch T-3/F-1): method calls such as model.fit( or obj.xit( are no skip marker; bare fit( and xit( are', () => {
  const calls = checkChange({ chunks: [patch('tests/test_model.py', ['+    model.fit(X, y)', '+    pipe.fit (X)', '+    self.xit(1)', '+    $fit(2)', '+    refit(3)'])] });
  assert.deepEqual(calls.hits, []);
  const bare = checkChange({ chunks: [patch('src/a.spec.ts', ['+fit(\'only this\', f)', '+  xit(\'later\', g)'])] });
  assert.deepEqual(bare.hits.map((h) => [h.kind, h.detail.split(':')[0]]), [['skip', '2 skip/only/disabled markers added']]);
});

test('plannedTests: [change] and [remove] entries anchoring test files, not [new] or non-test files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwmt-k4c-'));
  writeFileSync(join(dir, 'brief.md'), `${header({ schema: 'dwmt/brief@1', scope: ['src/**'] })}# x\n\n## Changes\n- [change] \`src/a.test.ts#total\` — drops the identity case\n- [remove] \`src/b.test.ts\` — the old suite\n- [new test] \`cases\` in \`src/c.test.ts\` — new\n- [change] \`src/a.ts#total\` — subtracts\n`);
  const m = plannedTests({ dir, batch: false });
  assert.deepEqual([...m.keys()], ['src/a.test.ts', 'src/b.test.ts']);
  assert.match(m.get('src/a.test.ts'), /^\[change\] `src\/a\.test\.ts#total` — drops the identity case$/);
});

// ---------- zapis w recenzji (D-24) ----------

test('recordScriptFindings (D-24): no line → fix and verdict FIX; drop without file:line → defer; drop with file:line → drop; once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwmt-k4r-'));
  const t = { scriptFindings: { 1: [
    { id: 'S-1', kind: 'scope', file: 'other/x.js', detail: 'changed outside the task scope' },
    { id: 'S-2', kind: 'assert', file: 'src/a.test.ts', detail: '1 assertion removed' },
    { id: 'S-3', kind: 'skip', file: 'src/b.test.ts', detail: '1 skip marker added' },
  ] } };
  writeFileSync(join(dir, 'review-1.md'), review(1, { counts: { blocker: 0, major: 1, minor: 0 }, drop: ['S-2'] }, '## Pass 2: pragmatism\n- S-2: drop — not a problem\n- S-3: drop — the case moved to src/c.test.ts:12\n'));
  assert.equal(recordScriptFindings(dir, t), 1);
  const text = readFileSync(join(dir, 'review-1.md'), 'utf8');
  const h = hdr(join(dir, 'review-1.md'));
  assert.deepEqual(validateHeader(h), []);
  assert.deepEqual([h.verdict, h.fix, h.defer, h.drop, h.scriptFindings, h.counts.major], ['FIX', ['S-1'], ['S-2'], ['S-3'], ['S-1', 'S-2', 'S-3'], 4]);
  assert.match(text, /### S-1 \[major\] scope: other\/x\.js\n- Evidence: `other\/x\.js`\n- changed outside the task scope\n/);
  assert.equal(recordScriptFindings(dir, t), 0, 'the marker makes it run once');
  assert.equal(readFileSync(join(dir, 'review-1.md'), 'utf8'), text);
});

// ---------- sprint 2.11 ----------

const D1_BODY = '### D-1 Discount as a value\nThe 0–100 rule belongs to the value.\n';
const strip = (t) => t.replace(D1_BODY, '### D-1 Discount as a value\n');
const PLAN211 = (run) => PLAN(run);
const TEST_ENTRY = '[change] `src/billing/invoice.test.ts` — the identity case goes with the discount; pattern: `src/billing/invoice.ts#invoice`';
const T1_211 = (run) => strip(T1(run, {
  ac: 'AC-1',
  changes: ['[new value object] `Discount` in `src/billing/discount.ts` — `Discount(percent: number)`, called by `invoice`; pattern: `src/shared/money.ts#Money`; test first: `new Discount(150)` throws',
    '[change] `src/billing/invoice.ts#invoice` — subtracts the discount; test first: 100 with 10 → 90', TEST_ENTRY],
}));
const T2_211 = (run) => strip(T2(run, { ac: 'AC-2' }));
const T3_211 = (run) => strip(T3(run, { ac: 'AC-3' }));
const OLD_TEST = 'import assert from "node:assert";\nassert.equal(invoice(100), 100);\n';

function sprint({ rules = '2.11', slug = 'kc', cfg } = {}) {
  const { d } = repo28(cfg, { 'src/billing/invoice.test.ts': OLD_TEST });
  const run = start(d, slug, { rules });
  writePlans(d, run, rules === '2.11' ? { plan: PLAN211(run), t1: T1_211(run), t2: T2_211(run), t3: T3_211(run) } : {});
  return { d, run };
}
const state = (d, run, sid = 'sess-1') => cliAs(d, sid, 'state', run).json;
const write = (d, files) => { for (const [f, text] of Object.entries(files)) { mkdirSync(join(d, f, '..'), { recursive: true }); writeFileSync(join(d, f), text); } };
const result = (file, obj = {}) => writeFileSync(file, header({ schema: 'dwmt/result@1', status: 'DONE', ...obj }));

test('sprint 2.11 (R-1, R-2, R-3, R-6): a hit books one repair despite an unrelatedRed claim, returns once, reaches the review as S-1 after ## Scope; drop without file:line → deferred-major; closing verify ignores the checks', () => {
  const { d, run } = sprint();
  assert.equal(state(d, run).next, 'implement');
  write(d, { 'src/billing/discount.ts': 'export class Discount {}\n', 'other/x.js': 'x\n', 'src/billing/invoice.test.ts': 'import assert from "node:assert";\n' });
  result(runFile(d, run, 'result-1.md'), { unrelatedRed: [`${CHECK_CMD}: not mine`] });
  let v = cliAs(d, 'sess-1', 'verify', run).json;
  assert.equal(v.repair, true, JSON.stringify(v));
  assert.ok(v.commands.includes(`1 ${CHECK_CMD}`), JSON.stringify(v.commands));
  assert.equal(v.expectedRed, undefined, 'the pseudo-command matches no claim');
  const tests = readFileSync(runFile(d, run, 'tests.md'), 'utf8');
  assert.match(tests, /## Script checks\n/);
  assert.match(tests, /- scope: `other\/x\.js`/);
  assert.match(tests, /Planned changes to tests[^\n]*\n- `src\/billing\/invoice\.test\.ts` — 1 assertion removed; entry: \[change\] `src\/billing\/invoice\.test\.ts`/);
  assert.doesNotMatch(tests, /- assert: `src\/billing\/invoice\.test\.ts`/, 'the planned test change is no hit');
  let st = state(d, run);
  assert.equal(st.next, 'repair', JSON.stringify(st));
  assert.match(st.prompt, /Script checks: read `## Script checks` in tests\.md/);
  assert.match(st.prompt, /\. Brief: \S+brief\.md\./, 'the repair prompt keeps the space after Brief:');
  // The repair leaves the file: no second repair, the round is verified.
  result(runFile(d, run, 'repair-1.md'));
  v = cliAs(d, 'sess-1', 'verify', run).json;
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.repair, undefined);
  assert.deepEqual(v.scriptChecks, ['scope: other/x.js']);
  assert.equal(RUN(d, run).tasks[0].verified, 1);
  const ri = cliAs(d, 'sess-1', 'review-input', run).json;
  assert.equal(ri.ok, true, JSON.stringify(ri));
  const input = readFileSync(ri.file, 'utf8');
  assert.equal(hdr(ri.file).brief, undefined);
  assert.doesNotMatch(input, /brief\.md/);
  assert.match(input, /### S-1 \[major\] scope: other\/x\.js\n- changed outside the task scope and not named in `outOfScopeChanges`\n/);
  assert.ok(input.indexOf('## Scope') < input.indexOf('### S-1') && input.indexOf('## Changes the executor reports outside the plan') < input.indexOf('## Script checks'));
  assert.match(input, /Planned changes to tests[^\n]*\n\n- `src\/billing\/invoice\.test\.ts` — 1 assertion removed; entry: \[change\] `src\/billing\/invoice\.test\.ts` — the identity case goes/);
  assert.match(input, /`- S-n: fix\|defer\|drop — <reason>`/);
  assert.deepEqual(RUN(d, run).tasks[0].scriptFindings['1'].map((x) => x.id), ['S-1']);
  // Reviewer drops S-1 without counter-evidence: defer → batch item T-1/S-1 deferred-major (PD-1).
  writeFileSync(runFile(d, run, 'review-1.md'), review(1, {}, '- S-1: drop — not a problem\n'));
  st = state(d, run);
  const rh = hdr(runFile(d, run, 'review-1.md'));
  assert.deepEqual([rh.defer, rh.fix, rh.scriptFindings], [['S-1'], [], ['S-1']], JSON.stringify(rh));
  const item = RUN(d, run).batch.items.find((x) => x.id === 'T-1/S-1');
  assert.deepEqual([item?.reason, item?.severity], ['deferred-major', 'major'], JSON.stringify(RUN(d, run).batch));
  // R-1: a change after the review makes the closing verify run; it ignores the checks (no section, no repair).
  write(d, { 'other/z.js': 'z\n' });
  st = state(d, run);
  assert.equal(st.next, 'verify', JSON.stringify(st));
  v = cliAs(d, 'sess-1', 'verify', run).json;
  assert.deepEqual([v.ok, v.closing, v.repair, v.scriptChecks], [true, true, undefined, undefined], JSON.stringify(v));
  assert.doesNotMatch(readFileSync(runFile(d, run, 'tests.md'), 'utf8'), /Script checks/);
});

test('sprint 2.11, review.batch false (R-3, R-1): S-1 without a line goes on fix, the round-2 fix prompt names it, and the returned hit books no repair in round 2', () => {
  const { d, run } = sprint({ slug: 'kcb', cfg: { review: { batch: false } } });
  assert.equal(state(d, run).next, 'implement');
  write(d, { 'src/billing/discount.ts': 'export class Discount {}\n', 'src/billing/discount.test.ts': 'test.skip("x", () => {});\n' });
  result(runFile(d, run, 'result-1.md'));
  assert.equal(cliAs(d, 'sess-1', 'verify', run).json.repair, true);
  const rp = state(d, run);
  assert.equal(rp.next, 'repair');
  result(runFile(d, run, 'repair-1.md'));
  assert.equal(cliAs(d, 'sess-1', 'verify', run).json.ok, true);
  const ri = cliAs(d, 'sess-1', 'review-input', run).json;
  assert.match(readFileSync(ri.file, 'utf8'), /### S-1 \[major\] skip: src\/billing\/discount\.test\.ts\n- 1 skip\/only\/disabled marker added/);
  writeFileSync(runFile(d, run, 'review-1.md'), review(1, {}));
  const st = state(d, run);
  assert.deepEqual([st.next, st.round], ['fix', 2], JSON.stringify(st));
  assert.match(st.prompt, /Script check findings on that list: S-1/);
  const rh = hdr(runFile(d, run, 'review-1.md'));
  assert.deepEqual([rh.verdict, rh.fix, rh.counts?.major], ['FIX', ['S-1'], 1]);
  assert.match(readFileSync(runFile(d, run, 'review-1.md'), 'utf8'), /### S-1 \[major\] skip: src\/billing\/discount\.test\.ts\n- Evidence: `src\/billing\/discount\.test\.ts`/);
  // Round 2: the fixer leaves the marker; the key was returned in round 1, so no repair and the round is verified.
  write(d, { 'src/billing/invoice.ts': 'export const invoice = (t, p = 0) => t - t * p / 100;\n' });
  result(runFile(d, run, 'result-2.md'));
  const v = cliAs(d, 'sess-1', 'verify', run).json;
  assert.deepEqual([v.ok, v.round, v.repair], [true, 2, undefined], JSON.stringify(v));
  assert.doesNotMatch(v.commands.join('\n'), /dwmt checks/);
  assert.equal(RUN(d, run).tasks[0].verified, 2);
  const r2 = readFileSync(cliAs(d, 'sess-1', 'review-input', run).json.file, 'utf8');
  assert.match(r2, /## Script checks\n[\s\S]*### S-1 \[major\] skip:/, 'the recheck unit lists the remaining hit with the same id');
});

test('sprint 2.11, review.batch false (batch T-3/F-4): an S-n dropped in round 1 is not listed again in the recheck and no line there does not put it on fix', () => {
  const { d, run } = sprint({ slug: 'kcd', cfg: { review: { batch: false } } });
  assert.equal(state(d, run).next, 'implement');
  write(d, { 'src/billing/discount.ts': 'export class Discount {}\n', 'src/billing/discount.test.ts': 'test.skip("x", () => {});\n' });
  result(runFile(d, run, 'result-1.md'));
  assert.equal(cliAs(d, 'sess-1', 'verify', run).json.repair, true);
  assert.equal(state(d, run).next, 'repair');
  result(runFile(d, run, 'repair-1.md'));
  assert.equal(cliAs(d, 'sess-1', 'verify', run).json.ok, true);
  cliAs(d, 'sess-1', 'review-input', run);
  writeFileSync(runFile(d, run, 'review-1.md'), review(1, { verdict: 'FIX', fix: ['F-1'] }, `${finding('F-1', 'major', 'Wrong total', 'src/billing/invoice.ts:1')}- S-1: drop — the skip is the plan's placeholder, src/billing/discount.test.ts:1\n`));
  let st = state(d, run);
  assert.deepEqual([st.next, st.round], ['fix', 2], JSON.stringify(st));
  assert.deepEqual(hdr(runFile(d, run, 'review-1.md')).drop, ['S-1']);
  write(d, { 'src/billing/invoice.ts': 'export const invoice = (t, p = 0) => t - t * p / 100;\n' });
  result(runFile(d, run, 'result-2.md'));
  assert.equal(cliAs(d, 'sess-1', 'verify', run).json.ok, true);
  const r2 = readFileSync(cliAs(d, 'sess-1', 'review-input', run).json.file, 'utf8');
  assert.doesNotMatch(r2, /### S-1 \[major\]/, 'the dropped hit is not a finding of the recheck again');
  assert.match(r2, /triaged in an earlier round[^\n]*S-1 drop/);
  writeFileSync(runFile(d, run, 'review-2.md'), review(1, { round: 2, passes: ['recheck'] }, '- F-1 resolved\n'));
  st = state(d, run);
  const rh = hdr(runFile(d, run, 'review-2.md'));
  assert.deepEqual([rh.verdict, asListOf(rh.fix)], ['PASS', []], JSON.stringify(rh));
  assert.notEqual(st.next, 'fix', JSON.stringify(st));
});
const asListOf = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

test('no checks (R-4): rules 2.10, an imported task plan without plan.md, and scriptChecks.enabled false', () => {
  const outside = { 'src/billing/discount.ts': 'export class Discount {}\n', 'other/x.js': 'x\n' };
  const noChecks = (d, run, label) => {
    write(d, outside);
    result(runFile(d, run, 'result-1.md'));
    const v = cliAs(d, 'sess-1', 'verify', run).json;
    assert.deepEqual([v.ok, v.repair, v.scriptChecks], [true, undefined, undefined], `${label}: ${JSON.stringify(v)}`);
    assert.doesNotMatch(readFileSync(runFile(d, run, 'tests.md'), 'utf8'), /Script checks/, label);
  };
  const old = sprint({ rules: '2.10', slug: 'kc10' });
  assert.equal(state(old.d, old.run).next, 'implement');
  noChecks(old.d, old.run, '2.10');
  const off = sprint({ slug: 'kcoff', cfg: { scriptChecks: { enabled: false } } });
  assert.equal(state(off.d, off.run).next, 'implement');
  noChecks(off.d, off.run, 'enabled false');
  // Import: a task plan file as the input, so the run has no sprint plan.
  const { d } = repo28();
  const run = cliAs(d, 'sess-1', 'preflight', '--slug', 'kci').json.run;
  const f = join(d, '..', `${run}-brief.md`);
  writeFileSync(f, `${T1(run)}\n## UAT\nUAT: none.\n`);
  const i = cliAs(d, 'sess-1', 'init', '--run', run, '--mode', 'single', '--input', f).json;
  assert.equal(i.ok, true, JSON.stringify(i));
  asRules(d, run, '2.11');
  assert.equal(existsSync(runFile(d, run, 'plan.md')), false);
  assert.ok(existsSync(runFile(d, run, 'brief.md')), 'imported task plan');
  noChecks(d, run, 'import');
});

test('batch 2.11 (R-6, D-32): a batch hit lists the union of the task scopes; S-1 without a line lands on fix of the batch review', () => {
  const { d, run } = sprint({ slug: 'kcx' });
  const pass = (k, sid, files, obj = {}, body = '') => {
    assert.equal(state(d, run, sid).next, 'implement');
    execute(d, sid, run, k, 1, files);
    writeFileSync(runFile(d, run, 'review-1.md', k), review(k, obj, body));
    let st = state(d, run, sid);
    if (st.next === 'verify') { cliAs(d, sid, 'verify', run); st = state(d, run, sid); }
    assert.equal(st.next, 'commit', JSON.stringify(st));
    assert.equal(cliAs(d, sid, 'commit', run).json.ok, true);
  };
  pass(1, 'sess-1', { 'src/billing/discount.ts': 'export class Discount {}\n' });
  pass(2, 'sess-2', { 'src/summary/view.ts': 'export const view = (p) => `-${p}%`;\n' });
  pass(3, 'sess-3', { 'src/export/csv.ts': 'export const csv = (p) => `${p}`;\n' }, { verdict: 'FIX', fix: ['F-1', 'F-2'] }, `${finding('F-1', 'major', 'Export uses the old invoice', 'src/billing/invoice.ts:3')}${finding('F-2', 'major', 'The export config lives outside every task', 'other/z.js:1')}`);
  let st = state(d, run, 'sess-3');
  assert.deepEqual([st.next, st.batch], ['batch', true], JSON.stringify(st));
  // Batch T-3/F-2: the file a batch item's evidence names (here outside every task scope) is the item's fix, not a scope hit.
  write(d, { 'src/billing/invoice.ts': 'export const invoice = (t, p = 0) => t - t * p / 100;\n', 'other/y.js': 'y\n', 'other/z.js': 'z\n' });
  writeFileSync(batchFile(d, run, 'result-1.md'), header({ schema: 'dwmt/result@1', status: 'DONE', fixed: ['T-3/F-1', 'T-3/F-2'] }));
  let v = cliAs(d, 'sess-3', 'verify', run).json;
  assert.equal(v.repair, true, JSON.stringify(v));
  st = state(d, run, 'sess-3');
  assert.equal(st.next, 'repair', JSON.stringify(st));
  assert.match(st.prompt, /Script checks: read `## Script checks`/);
  assert.match(st.prompt, /\. Batch: \S+batch\.md\./, 'the batch repair prompt keeps the space after Batch:');
  writeFileSync(batchFile(d, run, 'repair-1.md'), header({ schema: 'dwmt/result@1', status: 'DONE' }));
  v = cliAs(d, 'sess-3', 'verify', run).json;
  assert.equal(v.ok, true, JSON.stringify(v));
  const ri = cliAs(d, 'sess-3', 'review-input', run).json;
  const input = readFileSync(ri.file, 'utf8');
  assert.equal(hdr(ri.file).brief, undefined);
  assert.doesNotMatch(input, /brief\.md/);
  assert.match(input, /### S-1 \[major\] scope: other\/y\.js\n/);
  assert.doesNotMatch(input, /scope: other\/z\.js/, 'a batch item\'s evidence file counts as reported in the batch round');
  assert.match(input, /union of the task plans' scope globs\): `src\/billing\/\*\*`, `src\/summary\/\*\*`, `src\/export\/\*\*`\./);
  assert.equal((input.match(/union of the task plans' scope globs/g) || []).length, 1);
  writeFileSync(batchFile(d, run, 'review-1.md'), review(0, { passes: ['recheck'], acceptance: [] }, '- T-3/F-1 resolved\n'));
  st = state(d, run, 'sess-3');
  const bh = hdr(batchFile(d, run, 'review-1.md'));
  assert.deepEqual([bh.verdict, bh.fix, bh.scriptFindings], ['FIX', ['S-1'], ['S-1']], JSON.stringify(bh));
  assert.equal(st.round, 2, JSON.stringify(st));
});
