import './tmp-root.mjs';
// dwmt v2.9 (po PM-6+7): autopoprawki planów zadań, [sweep], hook sprawdzający plan po zapisie, jeden komunikat z błędami
// planu i planów zadań, uwagi-fakty do wykonawcy (replan tylko `[plan]`), `(C-n)` jako zmiana z planu, czerwień zapowiedziana
// bez naprawy, zatrzymywanie sesji wcześniejszych zadań. Fikstury syntetyczne z fixtures28 (rabat w trzech zadaniach).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseYaml, splitHeader, parseTasks, redClaimCmd } from '../scripts/dwmt.mjs';
import { autofixTaskPlan, expandShortPath, makeBase, parseChange, anchorOf, sweepItems, isPlanNote, validateTaskPlans } from '../scripts/plan.mjs';
import { header, runFile, SCRIPT, DWMT_HOME } from './helpers.mjs';
import { cliAs, NO_TRANSCRIPTS, RUN, PLAN, T1, T2, T3, repo28, start, writePlans, execute, review } from './fixtures28.mjs';

const HOOK = fileURLToPath(new URL('../hooks/plan-check.mjs', import.meta.url));
const planObj = (text) => ({ text, h: parseYaml(splitHeader(text).yaml), tasks: parseTasks(text) });
const hdrOf = (text) => parseYaml(splitHeader(text).yaml);
const state = (d, sid, run) => cliAs(d, sid, 'state', run).json;

// Plan sprintu z kontraktem C-1 między T-1 a T-2.
const PLAN_C = (run) => PLAN(run)
  .replace('## Decisions\n', '## Contracts\n### C-1 Discount read by the summary\n`src/billing/discount.ts#Discount` exposes `percent(): number` in 0–100.\n\n## Decisions\n')
  .replace('- Scope: src/billing/**\n- Depends: none', '- Scope: src/billing/**\n- Contracts: C-1\n- Depends: none')
  .replace('- Scope: src/summary/**\n- Depends: T-1', '- Scope: src/summary/**\n- Contracts: C-1\n- Depends: T-1');

// ---------- autopoprawki ----------

test('autopoprawki: C-n z planu (brak i inna treść), D-n bez treści, jednoznaczny skrót ścieżki; niejednoznaczny zostaje', () => {
  const plan = planObj(PLAN_C('r'));
  const base = makeBase(['src/billing/invoice.ts', 'src/shared/money.ts', 'src/summary/view.ts', 'a/core/api/X.java', 'b/core/api/X.java']);
  // T-2 bez sekcji C-1, z D-1 bez treści i skrótem ścieżki.
  const t2 = T2('r', { readFirst: ['.../summary/view.ts#view', 'src/summary/view.ts'] })
    .replace('### D-1 Discount as a value\nThe 0–100 rule belongs to the value.\n', '### D-1 Discount as a value\n');
  const r = autofixTaskPlan({ text: t2, h: hdrOf(t2), k: 2, plan, base });
  assert.match(r.text, /## Contracts\n### C-1 Discount read by the summary\n`src\/billing\/discount\.ts#Discount` exposes/);
  assert.match(r.text, /### D-1 Discount as a value\nThe 0–100 rule belongs to the value\./);
  assert.match(r.text, /read_first: \["src\/summary\/view\.ts#view"/);
  assert.equal(r.fixes.length, 3, r.fixes.join('\n'));
  // Inna treść C-1 zastąpiona tekstem planu; drugi przebieg bez zmian (idempotentnie).
  const t1 = T1('r').replace('## Changes', '## Contracts\n### C-1 Discount read by the summary\nsomething else\n\n## Changes');
  const r1 = autofixTaskPlan({ text: t1, h: hdrOf(t1), k: 1, plan, base });
  assert.deepEqual(r1.fixes, ['C-1 replaced by the sprint plan\'s text']);
  assert.deepEqual(autofixTaskPlan({ text: r1.text, h: hdrOf(r1.text), k: 1, plan, base }).fixes, []);
  assert.equal(expandShortPath('.../core/api/X.java#y', base), null, 'dwa kandydaci: zostaje błąd');
  assert.equal(expandShortPath('a/.../X.java', base), 'a/core/api/X.java');
});

test('[sweep]: glob i check wymagane, glob z bazy; metody HTTP to nie ścieżka; isPlanNote; redClaimCmd', () => {
  const c = parseChange('[sweep] `src/**/*.ts` — replace every `as Dto` by the helper; check: `as [A-Z]\\w*Dto`');
  assert.deepEqual([c.kind, c.check], ['sweep', 'as [A-Z]\\w*Dto']);
  assert.deepEqual(sweepItems('## Changes\n- [sweep] `src/**/*.ts` — rule; check: `x`\n'), [{ globs: ['src/**/*.ts'], check: 'x' }]);
  assert.equal(anchorOf('GET/PUT/DELETE'), null);
  assert.ok(anchorOf('src/a.ts'));
  assert.equal(isPlanNote('[plan] `a.ts#x`: C-1 cannot hold'), true);
  assert.equal(isPlanNote('`a.ts#x`: [plan] later'), true, 'znacznik po kotwicy');
  assert.equal(redClaimCmd('`npm test -- a`: red on the base'), 'npm test -- a');
  assert.equal(redClaimCmd('node -e "x": stale client until T-9'), 'node -e "x"');
});

test('walidacja: [sweep] bez check i z globem spoza bazy to błędy; poprawny przechodzi; autopoprawki w pamięci gaszą błędy C-n', () => {
  const { d } = repo28();
  const run = start(d, 'sw');
  const sweep = (s) => T2(run, { changes: ['[change] `src/summary/view.ts#view` — shows it; test first: 10 → "-10%"', s] });
  writePlans(d, run, { plan: PLAN_C(run), t2: sweep('[sweep] `src/nothing/**/*.ts` — drop it') });
  const root = join(d, '.dwmt', 'runs', run);
  const plan = { ...planObj(readFileSync(runFile(d, run, 'plan.md'), 'utf8')), file: runFile(d, run, 'plan.md') };
  const cfg = { review: { ignoreGlobs: [] }, ui: null };
  let v = validateTaskPlans({ top: d, root, plan, cfg });
  const e2 = v.errors.filter((e) => e.startsWith('T-2:')).join('\n');
  assert.match(e2, /\[sweep\] bez check/);
  assert.match(e2, /\[sweep\] src\/nothing\/\*\*\/\*\.ts nie istnieje w bazie/);
  assert.match(e2, /brak sekcji ### C-1/, 'bez autopoprawek błąd kontraktu');
  writeFileSync(runFile(d, run, 'brief.md', 2), sweep('[sweep] `src/summary/**/*.ts` — the supplier column goes; check: `supplier`'));
  v = validateTaskPlans({ top: d, root, plan, cfg, fix: 'memory' });
  assert.deepEqual(v.errors.filter((e) => /T-[12]:/.test(e)), [], v.errors.join('\n'));
  assert.ok(v.fixed.some((f) => f.k === 2 && f.fixes.includes('C-1 copied from the sprint plan')));
  assert.doesNotMatch(readFileSync(runFile(d, run, 'brief.md', 2), 'utf8'), /### C-1/, 'memory: plik bez zmian');
});

test('state: autopoprawki zapisane przed walidacją (bez powrotu do architekta); błędy planu i planów zadań w jednym prompcie', () => {
  const { d } = repo28();
  const run = start(d, 'af');
  writePlans(d, run, { plan: PLAN_C(run) });
  let st = state(d, 'sess-1', run);
  assert.equal(st.next, 'implement', JSON.stringify(st));
  assert.ok(st.autofixed.some((x) => /^T-1: C-1 copied/.test(x)) && st.autofixed.some((x) => /^T-2: C-1 copied/.test(x)), JSON.stringify(st.autofixed));
  assert.match(readFileSync(runFile(d, run, 'brief.md', 2), 'utf8'), /### C-1 Discount read by the summary/);

  const { d: d2 } = repo28();
  const run2 = start(d2, 'one');
  writePlans(d2, run2, {
    plan: PLAN(run2).replace('- Export has it → AC-3\n', '- Export has it\n'),
    t2: T2(run2, { changes: ['[change] summary tests — update'] }),
  });
  st = state(d2, 'sess-1', run2);
  assert.equal(st.next, 'plan');
  assert.match(st.prompt, /^Fix the plan: Input coverage: „Export has it” nie ma AC-n ani out: <powód>\. Fix the task plans: T-2: Changes: \[change\] bez kotwicy/);
});

// ---------- hook po zapisie planu ----------

const hook = (file, env = {}) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file } }), encoding: 'utf8', env: { ...process.env, ...env } });

test('hook plan-check: błąd planu zadania wraca od razu (exit 2, tylko jego zadanie), poprawny plik i inne pliki bez komunikatu', () => {
  const { d } = repo28();
  const run = start(d, 'hk');
  writePlans(d, run, { plan: PLAN_C(run), t2: T2(run, { readFirst: ['src/summary/view.ts#view', 'src/nope/x.ts'] }) });
  let r = hook(runFile(d, run, 'brief.md', 2));
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /dwmt plan check after this write \(tasks\/2\/brief\.md\)/);
  assert.match(r.stderr, /- T-2: read_first src\/nope\/x\.ts nie istnieje/);
  assert.doesNotMatch(r.stderr, /C-1/, 'kontrakt dopisze state: hook go nie zgłasza');
  assert.equal(hook(runFile(d, run, 'brief.md', 1)).status, 0, 'T-1 poprawny');
  assert.equal(hook(join(d, 'src', 'billing', 'invoice.ts')).status, 0);
  writeFileSync(runFile(d, run, 'plan.md'), PLAN_C(run).replace('- Depends: T-1\n\n### T-3', '\n### T-3'));
  r = hook(runFile(d, run, 'plan.md'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /plan\.md: T-2: brak linii Depends/);
  // Przebieg 2.8: hook milczy (reguły przebiegu do końca).
  const rj = RUN(d, run); rj.rules = '2.8'; writeFileSync(runFile(d, run, 'run.json'), JSON.stringify(rj));
  assert.equal(hook(runFile(d, run, 'plan.md')).status, 0);
});

// ---------- rozjazd 2.9 ----------

function t1Done(notes, contracts = []) {
  const { d } = repo28();
  const run = start(d, 'nt');
  writePlans(d, run, { plan: PLAN_C(run) });
  assert.equal(state(d, 'sess-1', run).next, 'implement');
  execute(d, 'sess-1', run, 1, 1, { 'src/billing/discount.ts': 'export class Discount {}\n' }, { laterNotes: notes, changedContracts: contracts });
  writeFileSync(runFile(d, run, 'review-1.md', 1), review(1, {}));
  assert.equal(cliAs(d, 'sess-1', 'commit', run).json.next, 'handoff');
  return { d, run };
}

test('rozjazd 2.9: uwaga-fakt i zmiana z (C-n) nie wywołują replanu; fakt trafia do promptu wykonawcy T-2 (nie T-3)', () => {
  const note = '`src/summary/view.ts#view`: already formats percents; reuse it';
  const { d, run } = t1Done([note], ['src/billing/discount.ts#Discount: percent() added (C-1)']);
  const st = state(d, 'sess-2', run);
  assert.deepEqual([st.next, st.agent], ['implement', 'dwmt-executor'], JSON.stringify(st));
  assert.match(st.prompt, /Notes from earlier tasks on code in your plan \(facts found after planning; the code is the truth, the plan still holds unless you report planIssue\): \(1\) T-1: `src\/summary\/view\.ts#view`: already formats percents; reuse it/);
});

test('rozjazd 2.9: uwaga [plan] wywołuje replan (bez znacznika w przyczynie); zmiana kontraktu spoza planu też', () => {
  const note = '[plan] `src/summary/view.ts#view`: C-1 cannot hold, percent is a fraction';
  let { d, run } = t1Done([note]);
  let st = state(d, 'sess-2', run);
  assert.deepEqual([st.next, st.from], ['replan', 2], JSON.stringify(st));
  assert.deepEqual(st.causes, ['for T-2: T-1 note for later tasks: `src/summary/view.ts#view`: C-1 cannot hold, percent is a fraction']);
  ({ d, run } = t1Done([], ['src/summary/view.ts#view: signature changed']));
  st = state(d, 'sess-2', run);
  assert.equal(st.next, 'replan', JSON.stringify(st));
});

// ---------- czerwień zapowiedziana ----------

test('verify 2.9: czerwień z expectedRed planu albo unrelatedRed wyniku bez naprawy, recenzja dostaje twierdzenia; inna czerwień → repair', () => {
  const red = 'node -e "process.exit(1)"';
  const { d } = repo28({ verify: { full: ['node -e 0'], targeted: null } });
  const run = start(d, 'red');
  const t1 = T1(run, { verify: ['node -e 0', red] }).replace('verify: ', `expectedRed: [${JSON.stringify(`${red}: the generated client is stale until T-2`)}]\nverify: `);
  writePlans(d, run, { t1 });
  assert.equal(state(d, 'sess-1', run).next, 'implement');
  writeFileSync(join(d, 'src', 'billing', 'discount.ts'), 'export class Discount {}\n');
  writeFileSync(runFile(d, run, 'result-1.md', 1), header({ schema: 'dwmt/result@1', status: 'DONE' }));
  const v = cliAs(d, 'sess-1', 'verify', run).json;
  assert.deepEqual([v.result, v.repair, v.expectedRed], ['fail', undefined, [red]], JSON.stringify(v));
  assert.equal(state(d, 'sess-1', run).next, 'verify', 'bez naprawy: dalej review-input');
  assert.equal(cliAs(d, 'sess-1', 'review-input', run).json.ok, true);
  const ri = readFileSync(runFile(d, run, 'review-input.md', 1), 'utf8');
  assert.match(ri, /## Red tests the plan expects\n\n- node -e "process\.exit\(1\)": the generated client is stale until T-2/);

  // Bez zapowiedzi: naprawa jak dotąd; wpis wykonawcy w wyniku rundy zamyka ją bez agenta naprawy.
  const { d: d2 } = repo28({ verify: { full: ['node -e 0'], targeted: null } });
  const run2 = start(d2, 'red2');
  writePlans(d2, run2, { t1: T1(run2, { verify: ['node -e 0', red] }) });
  assert.equal(state(d2, 'sess-1', run2).next, 'implement');
  writeFileSync(runFile(d2, run2, 'result-1.md', 1), header({ schema: 'dwmt/result@1', status: 'DONE' }));
  assert.equal(cliAs(d2, 'sess-1', 'verify', run2).json.repair, true);
  const { d: d3 } = repo28({ verify: { full: ['node -e 0'], targeted: null } });
  const run3 = start(d3, 'red3');
  writePlans(d3, run3, { t1: T1(run3, { verify: ['node -e 0', red] }) });
  assert.equal(state(d3, 'sess-1', run3).next, 'implement');
  writeFileSync(runFile(d3, run3, 'result-1.md', 1), header({ schema: 'dwmt/result@1', status: 'DONE', unrelatedRed: [`\`${red}\`: red on the base commit already`] }));
  const v3 = cliAs(d3, 'sess-1', 'verify', run3).json;
  assert.deepEqual([v3.repair, v3.expectedRed], [undefined, [red]], JSON.stringify(v3));
  cliAs(d3, 'sess-1', 'review-input', run3);
  assert.match(readFileSync(runFile(d3, run3, 'review-input.md', 1), 'utf8'), /## Red tests the executor attributes to other causes\n\n- `node -e "process\.exit\(1\)"`: red on the base commit already/);
});

test('review-input 2.9: sprawdzenia [sweep] uruchamia skrypt (trafienia z drzewa roboczego, także nowe pliki)', () => {
  const { d } = repo28();
  const run = start(d, 'swr');
  writePlans(d, run, { t1: T1(run, { changes: ['[new value object] `Discount` in `src/billing/discount.ts` — holds the percent; pattern: `src/shared/money.ts#Money`', '[change] `src/billing/invoice.ts#invoice` — subtracts it; test first: 100 with 10 → 90', '[sweep] `src/**/*.ts` — the supplier goes everywhere; check: `supplier`'] }) });
  const s0 = state(d, 'sess-1', run);
  assert.equal(s0.next, 'implement', JSON.stringify(s0));
  execute(d, 'sess-1', run, 1, 1, { 'src/billing/discount.ts': 'export const supplier = 1;\n' });
  const ri = readFileSync(runFile(d, run, 'review-input.md', 1), 'utf8');
  assert.match(ri, /## Sweep checks \(run by the script on the working tree\)\n\n- `supplier` in `src\/\*\*\/\*\.ts`: 1 hit\(s\); judge whether each is allowed by the plan:\n  - `src\/billing\/discount\.ts:1:export const supplier = 1;`/);
});

// ---------- sesje wcześniejszych zadań ----------

test('state 2.9: sesja uruchomiona przez launch zatrzymuje sesje wcześniejszych zadań (tylko z launches, raz)', () => {
  const { d } = repo28();
  const run = start(d, 'stp');
  writePlans(d, run);
  const fake = join(d, '..', `${run}-claude.mjs`);
  const log = join(mkdtempSync(join(tmpdir(), 'dwmt-stop-')), 'stops.txt');
  writeFileSync(fake, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');\n`);
  const rj = RUN(d, run);
  rj.launches = [{ id: 'aaaa1111', task: 2 }, { id: 'bbbb2222', task: 3 }];
  writeFileSync(runFile(d, run, 'run.json'), JSON.stringify(rj));
  const as = (sid) => JSON.parse(spawnSync(process.execPath, [SCRIPT, 'state', run], { cwd: d, encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: sid, DWMT_CLAUDE: fake, DWMT_HOME, DWMT_TRANSCRIPTS: NO_TRANSCRIPTS } }).stdout);
  assert.equal(as('sess-1').stoppedSessions, undefined, 'sesja spoza launches nic nie zatrzymuje');
  const st = as('bbbb2222-full-id');
  assert.deepEqual(st.stoppedSessions, ['aaaa1111'], JSON.stringify(st));
  assert.equal(readFileSync(log, 'utf8'), 'stop aaaa1111\n');
  assert.deepEqual(RUN(d, run).stoppedSessions, ['aaaa1111']);
  assert.equal(as('bbbb2222-full-id').stoppedSessions, undefined, 'drugi raz nic');
});

// ---------- poprawki po recenzji v2.9 ----------

test('recenzja v2.9: autopoprawka nie nadpisuje ryzyka z C-n w nagłówku, C-10 przed C-1, blok kodu w kontrakcie, dłuższy skrót', async () => {
  const { redClaimMatches, sweepChecks } = await import('../scripts/dwmt.mjs');
  const fence = '```';
  const plan = planObj(PLAN_C('r').replace('`src/billing/discount.ts#Discount` exposes `percent(): number` in 0–100.', `Shape:\n${fence}yaml\n# exported by Discount\npercent: 10\n${fence}\nend of C-1.`));
  const base = makeBase(['src/billing/invoice.ts', 'src/shared/money.ts', 'src/summary/view.ts', 'x/core/api/Foo.java', 'x/other/Foo.java']);
  const t2 = T2('r', { riskText: '' }).replace('### R-1 [high] The discount never exceeds the total', '### R-1 [high] C-1 percent stays within 0–100')
    .replace('## Changes', '## Contracts\n### C-10 Other\none\n\n### C-1\n\n## Changes') + '\nSee `x/.../api/Foo.java` and `.../core/api/Foo.java`.\n';
  const r = autofixTaskPlan({ text: t2, h: hdrOf(t2), k: 2, plan, base });
  assert.match(r.text, /### R-1 \[high\] C-1 percent stays within 0–100\n- Method: test/, 'ryzyko nietknięte');
  assert.match(r.text, /### C-10 Other\none\n/);
  assert.match(r.text, /### C-1 Discount read by the summary\nShape:\n```yaml\n# exported by Discount\npercent: 10\n```\nend of C-1\./);
  assert.match(r.text, /See `x\/core\/api\/Foo\.java` and `x\/core\/api\/Foo\.java`\./);
  assert.equal(isPlanNote('`src/a.ts#x`: [plan] C-2 cannot hold'), true);
  assert.equal(redClaimMatches('npx vitest run src/a.test.ts: client in T-6', 'npx vitest run'), false);
  assert.equal(redClaimMatches('npx vitest run: stale', 'npx vitest run'), true);
  assert.equal(redClaimMatches('`npx playwright test --grep "Invoices: list"`: base red', 'npx playwright test --grep "Invoices: list"'), true);
  assert.equal(redClaimMatches('npx playwright test --grep "Invoices: list": base red', 'npx playwright test --grep "Invoices export"'), false);
  const { d } = repo28({}, { 'src/billing/a.tsx': 'const x = 42;\n' });
  const hits = sweepChecks(d, '## Changes\n- [sweep] `src/**/*.{ts,tsx}` — numbers go; check: `= \\d+`\n');
  assert.match(hits.join('\n'), /1 hit\(s\)[\s\S]*src\/billing\/a\.tsx:1:const x = 42;/);
});
