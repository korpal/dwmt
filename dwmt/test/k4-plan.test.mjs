import './tmp-root.mjs';
// K4 (rules 2.11, opcja B): plan zadania jako szkielet projektu. Limit rozmiaru, krótkie punkty zmian, `test first:` z wartością,
// bez bloków kodu, decyzje i kontrakty sprintu jako same nagłówki, kryteria po identyfikatorze, resolver `entityText`, plik testu.
// Fikstury syntetyczne z fixtures28 (rabat w trzech zadaniach), przebieg przypięty do 2.11.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseYaml, splitHeader, parseTasks, loadConfig, renderAgents } from '../scripts/dwmt.mjs';
import { is210, is211, RULES, entityText, autofixTaskPlan, validateTaskPlans, makeBase } from '../scripts/plan.mjs';
import { isTestPath } from '../scripts/lib/verify-select.mjs';
import { repo, runFile } from './helpers.mjs';
import { RUN, PLAN, FILES, T1, repo28, start, writePlans } from './fixtures28.mjs';

const HOOK = fileURLToPath(new URL('../hooks/plan-check.mjs', import.meta.url));
const hook = (file) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file } }), encoding: 'utf8', env: process.env });
const planObj = (text) => ({ text, h: parseYaml(splitHeader(text).yaml), tasks: parseTasks(text) });
const D1_BODY = '### D-1 Discount as a value\nThe 0–100 rule belongs to the value.\n';
const PART_AC = 'AC-1 (part: totals)';
const GOOD_CHANGES = [
  '[new value object] `Discount` in `src/billing/discount.ts` — `Discount(percent: number)`, called by `invoice`; pattern: `src/shared/money.ts#Money`; test first: `new Discount(150)` throws',
  '[change] `src/billing/invoice.ts#invoice` — subtracts the discount; test first: 100 with 10 → 90',
];
// Plan zadania T-1 w kształcie 2.11: kryterium z częścią, D-1 sam nagłówek, D-20 decyzja tylko zadania z treścią.
const T1_211 = (run, o = {}) => T1(run, { ac: PART_AC, changes: GOOD_CHANGES, decisions: ['D-1', 'D-20'], more: `\n### D-20 Rounding to cents\nThe task rounds half up.${o.pad ?? ''}\n`, ...o })
  .replace(D1_BODY, '### D-1 Discount as a value\n');

function sprint(rules = '2.11') {
  const { d } = repo28();
  const run = start(d, 'kp', { rules });
  return { d, run, root: join(d, '.dwmt', 'runs', run), plan: { ...planObj(PLAN(run)), file: runFile(d, run, 'plan.md') } };
}
const errorsOf = (s, fix = null, rules = null) => {
  const v = validateTaskPlans({ top: s.d, root: s.root, plan: s.plan, cfg: loadConfig(s.d), fix, run: { ...RUN(s.d, s.run), ...(rules ? { rules } : {}) } });
  return { ...v, t1: v.errors.filter((e) => e.startsWith('T-1:')) };
};

test('rules 2.11: RULES, is211 and the init of a new run', () => {
  assert.equal(RULES, '2.12', 'K5: init writes rules 2.12');
  assert.deepEqual([is211({ rules: '2.11' }), is211({ rules: '2.10' }), is211({}), is211({ rules: '2.12' }), is210({ rules: '2.11' })], [true, false, false, true, true]);
  const { d, run } = (() => { const { d } = repo28(); return { d, run: start(d, 'kr', { rules: null }) }; })();
  assert.equal(RUN(d, run).rules, '2.12', 'init writes the current rules');
});

test('isTestPath (C-3): built-in pattern and the verify.testFiles glob', () => {
  const yes = ['src/a.test.ts', 'src/a.spec.jsx', 'dwmt/test/x.test.mjs', 'src/FooTest.java', 'src/FooTests.kt', 'src/FooIT.java', 'app/test_x.py', 'app/x_test.py', 'pkg/x_test.go', 'Api/FooTests.cs', 'src\\b.test.js'];
  const no = ['src/a.ts', 'src/testing.ts', 'src/Test.md', 'app/x.py', 'pkg/x.go', 'src/Foo.java', '', null];
  for (const p of yes) assert.equal(isTestPath(p), true, p);
  for (const p of no) assert.equal(isTestPath(p), false, String(p));
  assert.equal(isTestPath('dwmt/test/a.test.mjs', 'dwmt/test/*.test.mjs'), true);
  assert.equal(isTestPath('src/a.test.ts', 'dwmt/test/*.test.mjs'), false, 'the glob decides when set');
});

test('entityText (C-1): criteria from the sprint plan with the part note, D/C from their owner, R/A from the task plan', () => {
  const planText = PLAN('r').replace('## Decisions\n', '## Contracts\n### C-1 Discount read by the summary\n`percent(): number` in 0–100.\n\n## Decisions\n');
  const briefText = T1_211('r');
  assert.deepEqual(entityText({ planText, briefText }, 'AC-1'), { id: 'AC-1', title: 'invoice applies the discount', text: 'invoice applies the discount (part: totals)', source: 'plan' });
  assert.equal(entityText({ planText, briefText: T1('r') }, 'AC-1').text, 'invoice applies the discount', 'old shape: no part note');
  assert.deepEqual(entityText({ planText }, 'D-1'), { id: 'D-1', title: 'Discount as a value', text: 'The 0–100 rule belongs to the value.', source: 'plan' });
  assert.deepEqual(entityText({ planText, briefText }, 'C-1'), { id: 'C-1', title: 'Discount read by the summary', text: '`percent(): number` in 0–100.', source: 'plan' });
  assert.deepEqual(entityText({ planText, briefText }, 'D-20'), { id: 'D-20', title: 'Rounding to cents', text: 'The task rounds half up.', source: 'brief' });
  assert.equal(entityText({ planText, briefText }, 'R-1').source, 'brief');
  assert.match(entityText({ planText, briefText }, 'R-1').text, /Method: test 150 is rejected/);
  assert.equal(entityText({ planText, briefText }, 'D-9'), null);
  assert.equal(entityText({ planText, briefText }, 'AC-9'), null);
  // Przebieg inline: bez planu sprintu kryterium z nagłówka planu zadania.
  assert.deepEqual(entityText({ briefText: T1('r') }, 'AC-1'), { id: 'AC-1', title: 'invoice applies the discount', text: 'invoice applies the discount', source: 'brief' });
});

test('autofix 2.11: sprint D-n and C-n lose their body, criterion copies become ids, a task-only D-n keeps its body (R-2)', () => {
  const planText = PLAN('r').replace('## Decisions\n', '## Contracts\n### C-1 Discount read by the summary\n`percent(): number` in 0–100.\n\n## Decisions\n')
    .replace('- Scope: src/billing/**\n- Depends: none', '- Scope: src/billing/**\n- Contracts: C-1\n- Depends: none');
  const plan = planObj(planText);
  const text = T1('r', { decisions: ['D-1', 'D-20'], more: '\n### D-20 Rounding to cents\nThe task rounds half up.\n' });
  const h = parseYaml(splitHeader(text).yaml);
  const base = makeBase(Object.keys(FILES));
  const r = autofixTaskPlan({ text, h, k: 1, plan, base, v211: true });
  assert.ok(r.fixes.includes('D-1 body removed (the executor gets the sprint plan\'s text)'), r.fixes.join('\n'));
  assert.ok(r.fixes.includes('C-1 heading added (the executor gets the sprint plan\'s text)'), r.fixes.join('\n'));
  assert.ok(r.fixes.includes('AC-1 text removed from acceptance (the executor gets the sprint plan\'s text)'), r.fixes.join('\n'));
  assert.match(r.text, /### D-1 Discount as a value\n\n### D-20/);
  assert.doesNotMatch(r.text, /The 0–100 rule/);
  assert.match(r.text, /### D-20 Rounding to cents\nThe task rounds half up\./, 'R-2: task-only decision keeps its body');
  assert.match(r.text, /^### C-1 Discount read by the summary$/m);
  assert.doesNotMatch(r.text, /percent\(\): number/);
  assert.deepEqual(parseYaml(splitHeader(r.text).yaml).acceptance, ['AC-1']);
  // Kryterium z częścią i z innym tekstem zostaje; przebieg 2.10 kopiuje jak dotąd.
  const part = text.replace('"AC-1 invoice applies the discount"', '"AC-1 (part: totals)"');
  assert.deepEqual(parseYaml(splitHeader(autofixTaskPlan({ text: part, h: parseYaml(splitHeader(part).yaml), k: 1, plan, base, v211: true }).text).yaml).acceptance, ['AC-1 (part: totals)']);
  const old = autofixTaskPlan({ text, h, k: 1, plan, base });
  assert.ok(old.fixes.includes('C-1 copied from the sprint plan'));
  assert.match(old.text, /The 0–100 rule/);
});

test('validation 2.11: a 2.11-shaped task plan passes; copies are fixed by the autofix, otherwise errors', () => {
  const s = sprint();
  writePlans(s.d, s.run, { t1: T1_211(s.run) });
  assert.deepEqual(errorsOf(s).t1, []);
  writePlans(s.d, s.run);
  const fixed = errorsOf(s, 'memory');
  assert.deepEqual(fixed.t1.filter((e) => !/test first|code fence/.test(e)), [], fixed.t1.join('\n'));
  assert.ok(fixed.fixed.find((x) => x.k === 1).fixes.includes('D-1 body removed (the executor gets the sprint plan\'s text)'));
  const raw = errorsOf(s).t1.join('\n');
  assert.match(raw, /T-1: D-1: a sprint decision keeps the heading only/);
  writePlans(s.d, s.run, { t1: T1_211(s.run, { ac: 'AC-1 the invoice shows a discount line' }) });
  assert.match(errorsOf(s, 'memory').t1.join('\n'), /T-1: acceptance: „AC-1 the invoice shows a discount line” carries text; write AC-1 or AC-1 \(part: <this task's part>\)/);
  writePlans(s.d, s.run, { t1: T1_211(s.run, { more: '\n### D-20 Rounding to cents\n' }) });
  assert.match(errorsOf(s).t1.join('\n'), /D-20: sekcja bez treści/, 'a task-only decision still needs its text');
});

test('validation 2.11: entry length, numbered steps, test first with a value, test files exempt, no code fence', () => {
  const s = sprint();
  const pre = '[change] `src/billing/invoice.ts#invoice` — subtracts the discount; test first: 100 with 10 → 90; not: ';
  const long = `${pre}${'x'.repeat(450 - pre.length)}`;
  assert.equal(long.length, 450);
  writePlans(s.d, s.run, { t1: T1_211(s.run, { changes: [GOOD_CHANGES[0], long] }) });
  let e = errorsOf(s).t1;
  assert.equal(e.length, 1, e.join('\n'));
  assert.match(e[0], /^T-1: Changes: entry of 450 characters \(at most 400/);

  writePlans(s.d, s.run, { t1: T1_211(s.run, { changes: [GOOD_CHANGES[0], '[change] `src/billing/invoice.ts#invoice` — subtracts the discount; test first: returns the total'] }) });
  e = errorsOf(s).t1;
  assert.equal(e.length, 1, e.join('\n'));
  assert.match(e[0], /T-1: Changes: test first: „returns the total” has no value/);
  writePlans(s.d, s.run, { t1: T1_211(s.run, { changes: ['[new value object] `Discount` in `src/billing/discount.ts` — holds the percent; pattern: `src/shared/money.ts#Money`', GOOD_CHANGES[1]] }) });
  assert.match(errorsOf(s).t1.join('\n'), /T-1: Changes: \[new\] src\/billing\/discount\.ts changes code without test first/);
  for (const v of ['100 with 10 → 90', '"10%"', '`-10%`', '„minus ten”']) {
    writePlans(s.d, s.run, { t1: T1_211(s.run, { changes: [GOOD_CHANGES[0], `[change] \`src/billing/invoice.ts#invoice\` — subtracts; test first: ${v}`] }) });
    assert.deepEqual(errorsOf(s).t1, [], v);
  }
  // D-17: plik testu i `[new test]` bez `test first:`; dokument też.
  writePlans(s.d, s.run, { t1: T1_211(s.run, { changes: [...GOOD_CHANGES, '[change] `src/billing/invoice.test.ts` — covers the discount', '[new test] `discountTests` in `src/billing/discount-check.ts` — the cases above'] }) });
  assert.deepEqual(errorsOf(s).t1, []);
  // D-19: kroki liczone osobno: najwyżej 4, każdy najwyżej 200 znaków.
  const steps = (n, len = 20) => Array.from({ length: n }, (_, i) => `   ${i + 1}. ${'s'.repeat(len)}`).join('\n');
  writePlans(s.d, s.run, { t1: T1_211(s.run, { changes: [`${GOOD_CHANGES[1]}\n${steps(4, 190)}`, GOOD_CHANGES[0]] }) });
  assert.deepEqual(errorsOf(s).t1, [], 'four steps of 190 do not count toward the 400');
  writePlans(s.d, s.run, { t1: T1_211(s.run, { changes: [`${GOOD_CHANGES[1]}\n${steps(5, 210)}`, GOOD_CHANGES[0]] }) });
  e = errorsOf(s).t1.join('\n');
  assert.match(e, /5 numbered steps .* \(at most 4\)/);
  assert.match(e, /step of 213 characters \(at most 200\)/);

  writePlans(s.d, s.run, { t1: T1_211(s.run, { more: '\n### D-20 Rounding to cents\nRounds:\n```ts\nMath.round(x)\n```\n' }) });
  assert.deepEqual(errorsOf(s).t1, ['T-1: code fence in the task plan: name the element and its signature instead of writing code (no fenced blocks)']);
});

test('size limit (AC-2, R-4): measured after autofix, names size, limit and the three ways out; config default 10 KB', () => {
  assert.equal(loadConfig(repo()).plan.taskPlanMaxKB, 10);
  const s = sprint();
  const base = Buffer.byteLength(T1_211(s.run));
  const at = (bytes) => T1_211(s.run, { pad: ` ${'p'.repeat(bytes - base - 1)}` });
  writePlans(s.d, s.run, { t1: at(11 * 1024 + 20) });
  const e = errorsOf(s, 'memory').t1;
  assert.deepEqual(e, ['T-1: task plan is 11.0 KB after autofix, over the limit of 10 KB (plan.taskPlanMaxKB): keep each change entry to 1–2 lines, drop code-level parameters (only product decisions and contracts stay), or split the task']);
  writePlans(s.d, s.run, { t1: at(9 * 1024) });
  assert.deepEqual(errorsOf(s, 'memory').t1, []);
  // Rozmiar po autopoprawce: kopia D-1 i kryterium z tekstem nie liczy się do limitu.
  const copy = at(10 * 1024 - 10).replace('### D-1 Discount as a value\n', `${D1_BODY}${'c'.repeat(300)}\n`);
  writePlans(s.d, s.run, { t1: copy });
  assert.ok(Buffer.byteLength(copy) > 10 * 1024);
  assert.deepEqual(errorsOf(s, 'memory').t1, []);
  // Konfiguracja projektu zmienia limit; konfiguracja częściowa bez klucza ma 10.
  writePlans(s.d, s.run, { t1: at(11 * 1024 + 20) });
  const v = validateTaskPlans({ top: s.d, root: s.root, plan: s.plan, cfg: { plan: { taskPlanMaxKB: 12 } }, run: RUN(s.d, s.run) });
  assert.deepEqual(v.errors.filter((x) => x.startsWith('T-1:')), []);
  const p = validateTaskPlans({ top: s.d, root: s.root, plan: s.plan, cfg: {}, run: RUN(s.d, s.run) });
  assert.match(p.errors.join('\n'), /T-1: task plan is 11\.0 KB/);
});

test('AC-7, R-1: the same oversized, fenced, long-entry task plan at rules 2.10 gets none of the new errors', () => {
  const s = sprint();
  const bad = T1_211(s.run, {
    changes: ['[new value object] `Discount` in `src/billing/discount.ts` — holds the percent; pattern: `src/shared/money.ts#Money`', `[change] \`src/billing/invoice.ts#invoice\` — subtracts; test first: returns it; ${'x'.repeat(450)}`],
    pad: `\n\`\`\`ts\nconst a = 1;\n\`\`\`\n${'p'.repeat(12 * 1024)}`,
  });
  writePlans(s.d, s.run, { t1: bad });
  const NEW = /KB after autofix|code fence|characters \(at most|test first|carries text|keeps the heading only|missing heading/;
  const now = errorsOf(s, 'memory').t1.join('\n');
  for (const re of [/KB after autofix/, /code fence/, /characters \(at most 400/, /test first/]) assert.match(now, re);
  for (const rules of ['2.10', '2.9']) {
    const old = [...errorsOf(s, 'memory', rules).t1, ...errorsOf(s, null, rules).t1].join('\n');
    assert.doesNotMatch(old, NEW, `${rules}: ${old}`);
  }
});

test('hook plan-check 2.11 (R-4): the size error reaches the architect with exit 2 for that task only', () => {
  const s = sprint();
  writePlans(s.d, s.run, { t1: T1_211(s.run, { pad: ` ${'p'.repeat(11 * 1024)}` }) });
  const r = hook(runFile(s.d, s.run, 'brief.md', 1));
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /dwmt plan check after this write \(tasks\/1\/brief\.md\)/);
  assert.match(r.stderr, /- T-1: task plan is 1\d\.\d KB after autofix, over the limit of 10 KB \(plan\.taskPlanMaxKB\): keep each change entry to 1–2 lines, drop code-level parameters .*, or split the task/);
  // T-2 w starym kształcie (kopia D-1, tekst kryterium równy planowi): autopoprawka w pamięci, bez komunikatu.
  const r2 = hook(runFile(s.d, s.run, 'brief.md', 2));
  assert.equal(r2.status, 0, r2.stderr);
  assert.doesNotMatch(r2.stderr, /T-1/);
  writeFileSync(runFile(s.d, s.run, 'brief.md', 1), T1_211(s.run));
  assert.equal(hook(runFile(s.d, s.run, 'brief.md', 1)).status, 0);
});

test('template 16: the rendered architect carries the new version', () => {
  const a = renderAgents(loadConfig(repo())).find((x) => x.name === 'dwmt-architect');
  assert.match(a.text, /# dwmt: config [0-9a-f]{8}, template 16$/m);
  // D-5: reguły, których skrypt nie oceni, są w prompcie architekta (budżet linii pilnuje prompts.test.mjs).
  for (const re of [/each entry 1–2 lines/, /<Name>\(<signature>\)/, /called by/, /only when it is a product decision or a contract between parts/, /criteria in `acceptance` by id/, /`plan\.taskPlanMaxKB` \(10 KB\)/, /no fenced blocks/]) assert.match(a.text, re);
});
