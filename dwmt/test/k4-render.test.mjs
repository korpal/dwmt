import './tmp-root.mjs';
// K4 T-2 (rules 2.11, C-1, D-20–D-22): jedno źródło w prompcie wykonawcy, wejściu recenzji i raporcie końcowym.
// Sprint z fixtures28 (rabat) z planami zadań w kształcie 2.11; te same scenariusze w regułach 2.10 bez zmian (R-2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { gitIn, runFile, header } from './helpers.mjs';
import { cliAs, hdr, PLAN, T1, T2, T3, repo28, start, writePlans, review, finding, execute } from './fixtures28.mjs';
import { validateHeader } from '../scripts/dwmt.mjs';

const D1_BODY_LINE = 'The 0–100 rule belongs to the value.';
const D1_BODY = `### D-1 Discount as a value\n${D1_BODY_LINE}\n`;
const C1_TITLE = 'C-1 Discount read by the summary';
const C1_BODY = '`percent(): number` in 0–100.';
const OUT = 'The export column: T-3.';
const EXCERPT = '[S-1] `docs/discount.md` — "the discount never exceeds the total"';
const count = (s, sub) => s.split(sub).length - 1;

// Plan sprintu z kontraktem C-1 (T-1 i T-2); `two`: sprint z dwoma zadaniami (bez eksportu).
const PLAN211 = (run, { two = false } = {}) => {
  let p = PLAN(run).replace('## Decisions\n', `## Contracts\n### ${C1_TITLE}\n${C1_BODY}\n\n## Decisions\n`)
    .replace('- Scope: src/billing/**\n- Depends: none', '- Scope: src/billing/**\n- Contracts: C-1\n- Depends: none')
    .replace('- Scope: src/summary/**\n- Depends: T-1', '- Scope: src/summary/**\n- Contracts: C-1\n- Depends: T-1');
  if (two) {
    p = p.replace(/\n### T-3 [\s\S]*?(?=\n## UAT)/, '\n').replace('- Export has it → AC-3\n', '')
      .replace(',"AC-3 export has the discount"', '').replace(',"T-3"', '').replace(',"src/export/**"', '');
  }
  return p;
};
const strip = (t) => t.replace(D1_BODY, '### D-1 Discount as a value\n');
const C1_HEAD = `\n## Contracts\n### ${C1_TITLE}\n`;
// Plany zadań 2.11: kryterium po identyfikatorze (T-2 z częścią), D-1 i C-1 same nagłówki, D-20 i D-2 tylko zadania z treścią.
const T1_211 = (run) => strip(T1(run, {
  ac: 'AC-1', decisions: ['D-1', 'D-20'],
  changes: ['[new value object] `Discount` in `src/billing/discount.ts` — `Discount(percent: number)`, called by `invoice`; pattern: `src/shared/money.ts#Money`; test first: `new Discount(150)` throws',
    '[change] `src/billing/invoice.ts#invoice` — subtracts the discount; test first: 100 with 10 → 90'],
  more: `\n### D-20 Rounding to cents\nThe task rounds half up.\n${C1_HEAD}\n## Out of scope\n- ${OUT}\n\n## Standards and docs excerpts\n- ${EXCERPT}\n`,
}));
const T2_211 = (run) => strip(T2(run, { ac: 'AC-2 (part: the label)', more: C1_HEAD }));
const T3_211 = (run) => strip(T3(run, { ac: 'AC-3' }));

function sprint211({ two = false, rules = '2.11', slug = 'kr' } = {}) {
  const { d } = repo28();
  const run = start(d, slug, { rules });
  if (rules === '2.11') writePlans(d, run, { plan: PLAN211(run, { two }), t1: T1_211(run), t2: T2_211(run), t3: T3_211(run) });
  else writePlans(d, run, { plan: PLAN211(run, { two }) });
  if (two) rmSync(join(d, '.dwmt', 'runs', run, 'tasks', '3'), { recursive: true, force: true });
  return { d, run };
}
const state = (d, run, sid = 'sess-1') => cliAs(d, sid, 'state', run).json;

test('executor prompt 2.11 (R-3, D-20): implement and fix prompts end with the sprint D-1 and C-1 text, once; task-only D-20 not copied', () => {
  const { d, run } = sprint211();
  let st = state(d, run);
  assert.deepEqual([st.next, st.agent], ['implement', 'dwmt-executor'], JSON.stringify(st));
  const block = `\n\nSprint decisions and contracts your task plan names (text from the sprint plan):\n\n### D-1 Discount as a value\n${D1_BODY_LINE}\n\n### ${C1_TITLE}\n${C1_BODY}`;
  assert.ok(st.prompt.endsWith(block), st.prompt);
  assert.equal(count(st.prompt, D1_BODY_LINE), 1);
  assert.equal(count(st.prompt, C1_BODY), 1);
  assert.doesNotMatch(st.prompt, /rounds half up/, 'task-only decision stays in the task plan');
  execute(d, 'sess-1', run, 1, 1, { 'src/billing/discount.ts': 'export class Discount {}\n' });
  writeFileSync(runFile(d, run, 'review-1.md', 1), review(1, { verdict: 'FIX', counts: { blocker: 1 }, fix: ['F-1'] }, finding('F-1', 'blocker', 'Negative total', 'src/billing/invoice.ts:1')));
  st = state(d, run);
  assert.deepEqual([st.next, st.round], ['fix', 2], JSON.stringify(st));
  assert.ok(st.prompt.endsWith(block), st.prompt);
  assert.match(st.prompt, /Fix mode: fix the items/);
  assert.equal(count(st.prompt, D1_BODY_LINE), 1);
});

test('executor prompt 2.11 (R-3): the repair prompt carries the block too; 2.10 prompt has none (R-2)', () => {
  const { d } = repo28({ verify: { full: ['node -e 0'], targeted: ['node -e "process.exit(require(\'fs\').existsSync(\'red.flag\')?1:0)"'] } });
  const run = start(d, 'krr', { rules: '2.11' });
  writePlans(d, run, { plan: PLAN211(run), t1: T1_211(run), t2: T2_211(run), t3: T3_211(run) });
  assert.equal(state(d, run).next, 'implement');
  writeFileSync(join(d, 'red.flag'), '1');
  writeFileSync(join(d, 'src', 'billing', 'discount.ts'), 'export class Discount {}\n');
  writeFileSync(runFile(d, run, 'result-1.md', 1), header({ schema: 'dwmt/result@1', status: 'DONE' }));
  assert.equal(cliAs(d, 'sess-1', 'verify', run).json.repair, true);
  const st = state(d, run);
  assert.equal(st.next, 'repair', JSON.stringify(st));
  assert.match(st.prompt, /^Round 1, repair: /);
  assert.equal(count(st.prompt, `### D-1 Discount as a value\n${D1_BODY_LINE}`), 1);
  assert.equal(count(st.prompt, `### ${C1_TITLE}\n${C1_BODY}`), 1);

  const old = sprint211({ rules: '2.10', slug: 'kr10' });
  const p = state(old.d, old.run).prompt;
  assert.doesNotMatch(p, /Sprint decisions and contracts/);
  assert.doesNotMatch(p, /\n/, '2.10 prompt stays one line');
});

test('review input 2.11 (R-1, D-21): self-contained in round 1 and the recheck; no brief header or brief.md path; commit message keeps the sentence', () => {
  const { d, run } = sprint211();
  assert.equal(state(d, run).next, 'implement');
  const check = (file, round) => {
    const text = readFileSync(file, 'utf8');
    const h = hdr(file);
    assert.equal(h.brief, undefined, `round ${round}: no brief header`);
    assert.deepEqual(validateHeader(h), [], 'the schema no longer requires brief');
    assert.doesNotMatch(text, /brief\.md/, `round ${round}: no task plan path`);
    assert.match(text, /## Criteria\n\n- AC-1 invoice applies the discount\n/);
    assert.match(text, new RegExp(`## Decisions\\n\\n### D-1 Discount as a value\\n${D1_BODY_LINE}\\n\\n### D-20 Rounding to cents\\nThe task rounds half up\\.\\n`));
    assert.match(text, /## Contracts\n\n### C-1 Discount read by the summary\n`percent\(\): number` in 0–100\.\n/);
    assert.equal(count(text, C1_BODY), 1, 'contract once (not again under ## Sprint)');
    assert.match(text, /## Scope\n\n- `src\/billing\/\*\*`\n/);
    assert.match(text, /## Out of scope\n\n- The export column: T-3\.\n/);
    assert.ok(text.includes(`## Standards and docs excerpts\n\n- ${EXCERPT}\n`));
    assert.ok(text.indexOf('## Standards and docs excerpts') < text.indexOf('## Sprint'), 'owner blocks before ## Sprint');
    if (round === 1) assert.match(text, /### R-1 \[high\] The discount never exceeds the total/, 'risks stay in the lens pass');
  };
  const r1 = execute(d, 'sess-1', run, 1, 1, { 'src/billing/discount.ts': 'export class Discount {}\n' }).ri;
  check(r1.file, 1);
  writeFileSync(runFile(d, run, 'review-1.md', 1), review(1, { verdict: 'FIX', counts: { blocker: 1 }, fix: ['F-1'] }, finding('F-1', 'blocker', 'Negative total', 'src/billing/invoice.ts:1')));
  assert.equal(state(d, run).next, 'fix');
  const r2 = execute(d, 'sess-1', run, 1, 2, { 'src/billing/invoice.ts': 'export const invoice = (t) => Math.max(0, t);\n' }).ri;
  assert.deepEqual(hdr(r2.file).passes, ['recheck']);
  check(r2.file, 2);
  writeFileSync(runFile(d, run, 'review-2.md', 1), review(1, { round: 2, passes: ['recheck'] }, '- F-1 resolved\n'));
  let st = state(d, run);
  if (st.next === 'verify') { cliAs(d, 'sess-1', 'verify', run); st = state(d, run); }
  assert.equal(st.next, 'commit', JSON.stringify(st));
  assert.equal(cliAs(d, 'sess-1', 'commit', run).json.next, 'handoff');
  assert.match(gitIn(d)('log', '-1', '--format=%B'), /^T-1 .*\n\n- AC-1 invoice applies the discount\n\ndwmt-run: /);
});

test('review input 2.10 (R-2): brief header, brief Decisions block and the sprint contracts section stay', () => {
  const { d, run } = sprint211({ rules: '2.10', slug: 'kr10r' });
  assert.equal(state(d, run).next, 'implement');
  const { ri } = execute(d, 'sess-1', run, 1, 1, { 'src/billing/discount.ts': 'export class Discount {}\n' });
  const text = readFileSync(ri.file, 'utf8');
  assert.match(hdr(ri.file).brief, /tasks\/1\/brief\.md$/);
  assert.match(text, /## Criteria\n\n- AC-1 invoice applies the discount\n\n## Decisions\n### D-1 Discount as a value\nThe 0–100 rule/);
  assert.match(text, /Contracts between tasks that this task touches \(from the sprint plan\):/);
  assert.doesNotMatch(text, /## Scope\n/);
});

test('final report 2.11 (R-4, D-22) and batch review input (R-5): sprint D-1 once, task parts by id, task-only [visible] D-2 kept; no task plan path for the batch reviewer', () => {
  const { d, run } = sprint211();
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
  // T-3: uwaga do rundy zbiorczej (ostatnie zadanie, major w pliku z kotwic innego zadania).
  pass(3, 'sess-3', { 'src/export/csv.ts': 'export const csv = (p) => `${p}`;\n' }, { verdict: 'FIX', fix: ['F-1'] }, finding('F-1', 'major', 'Export uses the old invoice', 'src/billing/invoice.ts:3'));
  let st = state(d, run, 'sess-3');
  assert.deepEqual([st.next, st.batch], ['batch', true], JSON.stringify(st));
  const batchMd = readFileSync(join(d, '.dwmt', 'runs', run, 'batch', 'batch.md'), 'utf8');
  assert.match(batchMd, /- Task plan: /, 'the batch executor keeps the task plan lines');
  const e1 = execute(d, 'sess-3', run, 'batch', 1, { 'src/billing/invoice.ts': 'export const invoice = (t, p = 0) => t - t * p / 100;\n' }, { fixed: ['T-3/F-1'] });
  const input = readFileSync(e1.ri.file, 'utf8');
  assert.equal(hdr(e1.ri.file).brief, undefined);
  assert.doesNotMatch(input, /- Task plan:|brief\.md|batch\.md`/);
  assert.match(input, /### T-3\/F-1 \[major\] Export uses the old invoice/);
  writeFileSync(join(d, '.dwmt', 'runs', run, 'batch', 'review-1.md'), review(0, { passes: ['recheck'], acceptance: [] }, '- T-3/F-1 resolved\n'));
  st = state(d, run, 'sess-3');
  if (st.next === 'verify') { cliAs(d, 'sess-3', 'verify', run); st = state(d, run, 'sess-3'); }
  assert.equal(cliAs(d, 'sess-3', 'commit', run).json.ok, true);
  assert.equal(state(d, run, 'sess-3').next, 'goal-check');
  writeFileSync(runFile(d, run, 'goal-check.md'), `---\nschema: dwmt/goal-check@1\nitems:\n  - {id: I-1, element: "Discount", status: delivered, task: T-1, evidence: "T-1/report.md: AC-1 met"}\ngaps: 0\n---\n`);
  const fin = cliAs(d, 'sess-3', 'finish', run).json;
  assert.equal(fin.status, 'squashed', JSON.stringify(fin));
  const report = readFileSync(runFile(d, run, 'final-report.md'), 'utf8');
  const fh = hdr(runFile(d, run, 'final-report.md'));
  assert.equal(count(report, 'D-1 Discount as a value'), 1, report);
  // Kryterium raz w treści poza listą UAT (nagłówek podaje tylko `AC-n status`).
  const beforeUat = report.slice(report.indexOf('\n---\n', 4) + 5).split('### For your assessment')[0];
  for (const s of ['invoice applies the discount', 'summary shows the discount', 'export has the discount']) assert.equal(count(beforeUat, s), 1, s);
  assert.ok(fh.acceptance.every((a) => /^AC-\d+ \S+/.test(a) && !/discount/.test(a)), JSON.stringify(fh.acceptance));
  assert.match(report, /- T-1 sprint decisions: D-1\n/);
  assert.match(report, /- T-1\/D-20 Rounding to cents\n/);
  assert.match(report, /- T-3\/D-2 \[visible\] Rabat w eksporcie jako „-10%”\n- T-3 sprint decisions: D-1\n/);
  assert.match(report, /- Decision to confirm T-3\/D-2: Rabat w eksporcie jako „-10%”/);
  assert.deepEqual(fh.decisions, ['D-1', 'T-1/D-20', 'T-3/D-2'], 'each id once');
});

test('final report 2.10 (R-2): the task block still lists the sprint decision title', () => {
  const { d, run } = sprint211({ rules: '2.10', slug: 'kr10f', two: true });
  for (const [k, sid, files] of [[1, 'sess-1', { 'src/billing/discount.ts': 'export class Discount {}\n' }], [2, 'sess-2', { 'src/summary/view.ts': 'export const view = (p) => `-${p}%`;\n' }]]) {
    assert.equal(state(d, run, sid).next, 'implement', JSON.stringify(state(d, run, sid)));
    execute(d, sid, run, k, 1, files);
    writeFileSync(runFile(d, run, 'review-1.md', k), review(k, {}));
    let st = state(d, run, sid);
    if (st.next === 'verify') { cliAs(d, sid, 'verify', run); st = state(d, run, sid); }
    assert.equal(cliAs(d, sid, 'commit', run).json.ok, true);
  }
  assert.equal(state(d, run, 'sess-2').next, 'goal-check');
  writeFileSync(runFile(d, run, 'goal-check.md'), `---\nschema: dwmt/goal-check@1\nitems: []\ngaps: 0\n---\n`);
  assert.equal(cliAs(d, 'sess-2', 'finish', run).json.status, 'squashed');
  const report = readFileSync(runFile(d, run, 'final-report.md'), 'utf8');
  assert.match(report, /- T-1\/D-1 Discount as a value\n/);
  assert.doesNotMatch(report, /sprint decisions:/);
  assert.deepEqual(hdr(runFile(d, run, 'final-report.md')).decisions, ['D-1', 'T-1/D-1', 'T-2/D-1']);
});


// Przegląd T-2 runda 1 (F-1): szablon recenzenta służy każdemu przebiegowi; wejście 2.10, wejście bez planu sprintu i
// import mają nagłówek `brief` i nie niosą zakresu, wyłączeń ani wyciągów, więc szablon musi kierować do tego pliku.
test('reviewer template (F-1): an input whose header names `brief` sends the reviewer to its scope, out of scope and excerpts', () => {
  const tpl = readFileSync(new URL('../templates/agents/dwmt-reviewer.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const input = tpl.split('\nInput\n')[1].split('\nPasses\n')[0];
  assert.doesNotMatch(input, /no other planning file is needed/);
  assert.match(input, /header names `brief`[^\n]*scope, out of scope and standards excerpts/);
  assert.match(tpl, /judge conformance with the input's criteria, decisions, contracts, scope and excerpts \(or the `brief` file's/);
});
