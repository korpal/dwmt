import './tmp-root.mjs';
// K5 (rules 2.12, D-4, D-6, D-13..D-16): plain summary, one status word per criterion, ids with titles, UAT pending only
// when a human has something to do, UAT steps naming what the human checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runFile } from './helpers.mjs';
import { cliAs, hdr, PLAN, T1, repo28, start, writePlans, review, finding, execute } from './fixtures28.mjs';
import { parseYaml, splitHeader, parseTasks, loadConfig } from '../scripts/dwmt.mjs';
import { is211, is212, finishFacts, goalCheckInfo, validateTaskPlans } from '../scripts/plan.mjs';
import { uatRefErrors, stripUatRef, parseRisks } from '../scripts/lib/risks.mjs';
import { statusWord, statusReason, titleIds, uatStepCount, reportSummary, batchStatuses } from '../scripts/lib/report.mjs';

const TPL = (p) => readFileSync(fileURLToPath(new URL(`../templates/${p}`, import.meta.url)), 'utf8');
const planObj = (text) => ({ text, h: parseYaml(splitHeader(text).yaml), tasks: parseTasks(text) });
const RISKS = parseRisks(`## Risks
### R-1 [high] Total never negative
- Method: test 150 rejected (AC-1)
- Area: billing

### R-2 [medium] The discount label reads well
- Method: human read the summary
- Area: summary

### R-3 [medium] The summary matches the mockup
- Method: ui
- Area: summary
`);

test('is212 and finishFacts with modules and known red', () => {
  assert.deepEqual([is212({ rules: '2.12' }), is212({ rules: '2.11' }), is211({ rules: '2.12' })], [true, false, true]);
  const f = finishFacts({ verify: { full: ['npm test'], modules: [{ name: 'py', glob: 'py/**', full: ['pytest'] }], knownRedDays: 5 } });
  assert.match(f, /verify\.modules/);
  assert.match(f, /py \(py\/\*\*\): `pytest`/);
  assert.match(f, /known red for 5 days/);
  assert.match(finishFacts({ verify: { full: ['npm test'] } }), /runs only: `npm test`; any other test runs only if a task's verify runs it/);
});

test('uatRefErrors (D-4): a step without a reference, a test risk, a criterion without [human]; human, ui and T-k/R-n pass', () => {
  const risks = { 1: RISKS, 2: RISKS };
  const criteria = ['AC-1 invoice applies the discount', 'AC-2 [human] the label reads naturally'];
  assert.equal(uatRefErrors('1. Invoice → apply 10% → total drops.', { risks, criteria, single: 1 }).length, 1, 'a step without ref gives 1 error');
  assert.deepEqual(uatRefErrors('UAT: none.', { risks, criteria }), []);
  const ok = '### T-1 Billing\n1. Summary → read the label → reads well (R-2)\n2. Summary → compare → as the mockup (R-3).\n\n- Export → open → label ok (T-2/R-2)\n- Summary → read → natural (AC-2)';
  assert.deepEqual(uatRefErrors(ok, { risks, criteria }), []);
  const bad = uatRefErrors('### T-1 Billing\n1. Invoice → 150 → rejected (R-1)\n2. Invoice → x → y (AC-1)\n3. Invoice → x → y (R-9)', { risks, criteria });
  assert.equal(bad.length, 3, bad.join('\n'));
  assert.match(bad[0], /method test/);
  assert.match(bad[1], /not a sprint criterion marked \[human\]/);
  assert.match(bad[2], /no risk R-9/);
  assert.match(uatRefErrors('1. A → b → c (R-2)', { risks, criteria })[0], /outside a ### T-k group: write \(T-k\/R-2\)/);
  assert.equal(stripUatRef('1. Summary → read → reads well (T-1/R-2).'), '1. Summary → read → reads well.');
});

test('validateTaskPlans: a 2.11 plan without UAT refs passes (R-7); on 2.12 the same step is a plan error', () => {
  const { d } = repo28();
  const run = start(d, 'kref', { rules: '2.12' });
  writePlans(d, run, {});
  const root = join(d, '.dwmt', 'runs', run);
  const plan = { ...planObj(PLAN(run)), file: runFile(d, run, 'plan.md') };
  const uat = (rules) => validateTaskPlans({ top: d, root, plan, cfg: loadConfig(d), run: { rules, tasks: [] } }).errors.filter((e) => /UAT step/.test(e));
  assert.deepEqual(uat('2.11'), []);
  assert.equal(uat('2.12').length, 1);
  assert.match(uat('2.12')[0], /^plan\.md: UAT step "1\. Invoice/);
});

test('hook plan-check 2.12 (D-4): UAT reference errors reach the architect once the task plans are complete', () => {
  const HOOK = fileURLToPath(new URL('../hooks/plan-check.mjs', import.meta.url));
  const hook = (file) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file } }), encoding: 'utf8', env: process.env });
  const { d } = repo28();
  const run = start(d, 'khook', { rules: '2.12' });
  writePlans(d, run, {});
  const t3 = readFileSync(runFile(d, run, 'brief.md', 3), 'utf8');
  rmSync(runFile(d, run, 'brief.md', 3));
  const early = hook(runFile(d, run, 'brief.md', 2));
  assert.doesNotMatch(early.stderr, /UAT step/, 'a task plan still missing: no UAT check yet');
  writeFileSync(runFile(d, run, 'brief.md', 3), t3);
  const last = hook(runFile(d, run, 'brief.md', 3));
  assert.equal(last.status, 2, last.stderr);
  assert.match(last.stderr, /- plan\.md: UAT step "1\. Invoice → apply 10% → total drops by 10%\." ends without \(R-n\)/);
  const onPlan = hook(runFile(d, run, 'plan.md'));
  assert.equal(onPlan.status, 2, onPlan.stderr);
  assert.match(onPlan.stderr, /- plan\.md: UAT step "1\. Invoice/);
  writeFileSync(runFile(d, run, 'plan.md'), PLAN(run).replace('1. Invoice → apply 10% → total drops by 10%.', 'UAT: none.'));
  for (const f of [runFile(d, run, 'plan.md'), runFile(d, run, 'brief.md', 3)]) assert.doesNotMatch(hook(f).stderr, /UAT step/);
});

test('goalCheckInfo returns the ## Summary lines (at most 4); templates carry the section and the UAT rule', () => {
  const root = mkdtempSync(join(tmpdir(), 'dwmt-gc-'));
  writeFileSync(join(root, 'goal-check.md'), '---\nschema: dwmt/goal-check@1\nitems:\n  - {id: I-1, element: "x", status: delivered}\ngaps: 0\n---\n## Summary\n- Faktura liczy rabat.\n- Eksport bez zmian: poza zakresem.\n\n## Gaps\n');
  assert.equal(goalCheckInfo(root).summary.length, 2);
  assert.deepEqual(goalCheckInfo(root).summary, ['Faktura liczy rabat.', 'Eksport bez zmian: poza zakresem.']);
  assert.match(TPL('artifacts/goal-check.md'), /^## Summary$/m);
  assert.match(TPL('agents/dwmt-checker.md'), /## Summary/);
  assert.match(TPL('agents/dwmt-architect.md'), /`\(R-n\)` naming a `human` or `ui` risk/);
  assert.match(TPL('artifacts/final-report.md'), /^# Final report: \{\{goal\}\}\n\n\{\{summary\}\}\{\{deferredHead\}\}/m);
});

test('status words (D-14): batch-reviewed criterion reads met; reasons and titles (D-15); step count; summary (D-13)', () => {
  const data = [{ k: 1, acceptance: ['AC-6 partial: label only (F-1)'], risks: [], riskStatus: {} }];
  batchStatuses(data, { resolved: new Set(), reviews: [{ acceptance: ['AC-6 met: label checked'] }], many: false });
  assert.equal(statusWord(data[0].acceptance[0].split(' ').slice(1).join(' ')), 'met', data[0].acceptance[0]);
  assert.deepEqual(['partial: x', 'not met', 'met pending UAT (UAT: R-2)', 'unverified', 'gap: no task covers it', 'met'].map(statusWord), ['partial', 'not met', 'pending UAT', 'unverified', 'gap', 'met']);
  assert.equal(statusReason('partial: label only (F-1)'), 'label only (F-1)');
  assert.equal(statusReason('met (fix batch review)'), 'fix batch review');
  const d = { texts: [finding('F-1', 'major', 'Negative total', 'a.ts:1')], risks: RISKS };
  assert.equal(titleIds('label only (F-1); R-2 open', d), 'label only (F-1 Negative total); R-2 The discount label reads well open');
  assert.equal(titleIds('F-1 Negative total', d), 'F-1 Negative total', 'once');
  assert.equal(uatStepCount('UAT: none.'), 0);
  assert.equal(uatStepCount('### T-1 A\n1. a\n2. b\n'), 2);
  const s = reportSummary({ lang: 'pl', product: ['Faktura liczy rabat.'], deferred: [], uat: 'n/a', cost: 3.2, estimate: [2, 4], design: [3, 5], knownRed: [{ key: 'npm test :: a.test.ts', expires: '2026-10-08T00:00:00Z', item: 'B-7' }] });
  assert.ok(s.length <= 10);
  assert.match(s.join('\n'), /brak kroków dla człowieka/);
  assert.match(s.join('\n'), /a\.test\.ts \(wygasa 2026-10-08, właściciel B-7\)/);
  assert.match(s.join('\n'), /Koszt: 3\.2 M \(cena startowa 2–4 M; cena projektu 3–5 M\)/);
  assert.match(reportSummary({ lang: 'en', uat: 'pending', steps: 3, sprint: 's1' }).join('\n'), /To do: UAT, 3 steps for you: \/dwmt:uat s1/);
});

// 2.11+ task plan rules: every new code file has a test first.
const CH1 = ['[new value object] `Discount` in `src/billing/discount.ts` — holds the percent; pattern: `src/shared/money.ts#Money`; test first: `new Discount(150)` throws',
  '[change] `src/billing/invoice.ts#invoice` — subtracts the discount; test first: 100 with 10 → 90'];
const T1_212 = (run, o = {}) => T1(run, { changes: CH1, ...o });
// A two-task sprint on 2.12 (T-1 billing, T-2 summary) to the final report; `t1`: task plan text of T-1.
function sprint212({ slug, uat = '## UAT\nUAT: none.\n', t1 = null, deferT2 = false }) {
  const { d } = repo28({ language: 'pl' });
  const run = start(d, slug, { rules: '2.12' });
  const plan = PLAN(run).replace(/\n### T-3 [\s\S]*?(?=\n## UAT)/, '\n').replace('- Export has it → AC-3\n', '')
    .replace(',"AC-3 export has the discount"', '').replace(',"T-3"', '').replace(',"src/export/**"', '')
    .replace(/## UAT\n[\s\S]*$/, uat);
  writePlans(d, run, { plan, t1: (t1 ?? T1_212)(run) });
  rmSync(join(d, '.dwmt', 'runs', run, 'tasks', '3'), { recursive: true, force: true });
  const steps = [[1, 'sess-1', { 'src/billing/discount.ts': 'export class Discount {}\n' }, {}, ''],
    [2, 'sess-2', { 'src/summary/view.ts': 'export const view = (p) => `-${p}%`;\n' }, deferT2 ? { defer: ['F-1'], acceptance: ['AC-2 partial: label only (F-1)'] } : {}, deferT2 ? finding('F-1', 'minor', 'Label misaligned', 'src/summary/view.ts:1') : '']];
  for (const [k, sid, files, obj, body] of steps) {
    const st0 = cliAs(d, sid, 'state', run).json;
    assert.equal(st0.next, 'implement', JSON.stringify(st0));
    execute(d, sid, run, k, 1, files);
    writeFileSync(runFile(d, run, 'review-1.md', k), review(k, obj, body));
    let st = cliAs(d, sid, 'state', run).json;
    if (st.next === 'verify') { cliAs(d, sid, 'verify', run); st = cliAs(d, sid, 'state', run).json; }
    assert.equal(cliAs(d, sid, 'commit', run).json.ok, true);
  }
  assert.equal(cliAs(d, 'sess-2', 'state', run).json.next, 'goal-check');
  writeFileSync(runFile(d, run, 'goal-check.md'), '---\nschema: dwmt/goal-check@1\nitems:\n  - {id: I-1, element: "Discount", status: delivered, task: T-1, evidence: "T-1/report.md: AC-1 met"}\ngaps: 0\n---\n## Summary\n- Faktura i podsumowanie pokazują rabat.\n- Eksport nie był w tym sprincie.\n');
  const fin = cliAs(d, 'sess-2', 'finish', run).json;
  assert.equal(fin.status, 'squashed', JSON.stringify(fin));
  return { d, run, report: readFileSync(runFile(d, run, 'final-report.md'), 'utf8'), fh: hdr(runFile(d, run, 'final-report.md')) };
}

test('final report 2.12: UAT none and no human risk give uat n/a; summary after H1; words in header and contract; titles', () => {
  const { report, fh } = sprint212({ slug: 'k5r', deferT2: true });
  assert.equal(fh.uat, 'n/a');
  assert.deepEqual(fh.acceptance, ['AC-1 met', 'AC-2 partial']);
  assert.deepEqual(fh.coverage, ['AC-1 met', 'AC-2 partial']);
  const body = report.slice(report.indexOf('\n---\n', 4) + 5);
  const afterH1 = body.split('\n').slice(3);
  const summary = afterH1.slice(0, afterH1.indexOf(''));
  assert.ok(summary.length >= 3 && summary.length <= 10, summary.join('\n'));
  assert.equal(summary[0], '- Faktura i podsumowanie pokazują rabat.');
  assert.match(summary.join('\n'), /brak kroków dla człowieka/);
  assert.match(summary.join('\n'), /Odłożone uwagi: 1\./);
  assert.doesNotMatch(summary.join('\n'), /\b(AC|T|F|R|D)-\d+\b/, 'no identifiers in the summary');
  assert.match(report, /- AC-2 summary shows the discount → \*\*partial\*\* — label only \(F-1 Label misaligned\)/);
  assert.match(report, /## UAT\n\nStatus: n\/a\. UAT: brak kroków dla człowieka — odebrany przy zakończeniu\./);
  assert.match(report, /- T-1 sprint decisions: D-1 Discount as a value/);
  assert.match(report, /review-1: PASS \(\{\}\) fix: none/);
});

test('final report 2.12: a human risk with UAT none gives uat pending (R-8); steps render without the reference', () => {
  const human = (run) => T1_212(run, { riskText: '\n### R-2 [medium] The discount label reads well\n- Method: human read the invoice\n- Area: billing\n' });
  const a = sprint212({ slug: 'k5h', t1: human });
  assert.equal(a.fh.uat, 'pending', 'UAT: none with a human risk');
  assert.match(a.report, /\n- Do zrobienia: UAT, 1 krok dla Ciebie: \/dwmt:uat /);
  const b = sprint212({ slug: 'k5s', t1: human, uat: '## UAT\n### T-1 Discount in billing\n1. Faktura → rabat 10% → etykieta czytelna (R-2)\n' });
  assert.equal(b.fh.uat, 'pending');
  assert.match(b.report, /1\. Faktura → rabat 10% → etykieta czytelna\n/);
  assert.doesNotMatch(b.report, /czytelna \(R-2\)/);
});
