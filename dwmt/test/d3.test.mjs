import './tmp-root.mjs';
// D3 (spec dwmt v2.7 §4, §5.2, §5.7–§5.10, §12): architekt zamiast planistów, walidacja planu i planów zadań,
// rozjazd i `replan`, kontrola celu, przejście z v2.6, explore/, sizes.txt, setup z nowymi rolami.
// Fikstury syntetyczne i neutralne wobec projektu (dwmt jest generyczny): moduł rozliczeń z rabatem na fakturze.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseYaml, splitHeader, parseTasks } from '../scripts/dwmt.mjs';
import {
  taskPlanErrors, sprintPlanErrors, overlapErrors, validateTaskPlans, makeBase, taskDepends, noteAnchor, anchorMatches, shortcutHits,
  lineNumberHits, explorerRounds, RULES,
} from '../scripts/plan.mjs';
import { SCRIPT, DWMT_HOME, repo, gitIn, header, runFile, asV26, asV27, asRules, UAT_NONE, fromTemplate } from './helpers.mjs';

const NO_TRANSCRIPTS = mkdtempSync(join(tmpdir(), 'dwmt-tr0-'));
function cliAs(d, sid, env, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: d, encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: sid, DWMT_HOME, DWMT_TRANSCRIPTS: NO_TRANSCRIPTS, ...env } });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* tekst */ }
  return { code: r.status, json, out: r.stdout + r.stderr };
}
const cli = (d, ...args) => cliAs(d, 'sess-1', {}, ...args);
const hdr = (f) => parseYaml(splitHeader(readFileSync(f, 'utf8')).yaml);
const RUN = (d, run) => JSON.parse(readFileSync(runFile(d, run, 'run.json'), 'utf8'));

// ---------- fikstury ----------

const FILES = {
  'src/billing/invoice.ts': 'export const invoice = (total) => total;\n',
  'src/billing/invoice.test.ts': '// test\n',
  'src/shared/money.ts': 'export class Money {}\n',
  'src/legacy/old.ts': 'export const old = 1;\n',
  'docs/adr/0001-modules.md': '# ADR\nModules talk through contracts.\n',
};
const HEAD_FILES = ['package.json', 'a.txt', ...Object.keys(FILES)];

const C1 = '`src/billing/discount.ts#Discount`: `{ percent: number }`, 0–100';
const PLAN = (run, extra = {}) => `${header({
  schema: 'dwmt/plan@1', run, goal: 'Rabat na fakturze i w podsumowaniu', acceptance: ['AC-1 faktura liczy rabat', 'AC-2 podsumowanie pokazuje rabat'],
  tasks: ['T-1', 'T-2'], scope: ['src/billing/**', 'src/summary/**'], shared: [], decisions: ['D-1'], questions: [], ...extra,
})}# Rabat

## Context
Faktura liczy sumę bez rabatu.

## Design
Rozliczenia są właścicielem rabatu; podsumowanie czyta go przez kontrakt C-1, bez własnych obliczeń.

## Input coverage
- Rabat procentowy na fakturze → AC-1
- Podsumowanie pokazuje rabat → AC-2
- Eksport do PDF → out: osobny sprint w roadmapie

## Decisions
### D-1 Rabat jako wartość
Reguła zakresu 0–100 należy do wartości, nie do faktury.

## Contracts
### C-1 Rabat
${C1}

## Tasks
### T-1 Rabat w rozliczeniach
- Goal: faktura liczy rabat
- Acceptance: AC-1
- Scope: src/billing/**
- Contracts: C-1
- Depends: none

### T-2 Rabat w podsumowaniu
- Goal: podsumowanie pokazuje rabat
- Acceptance: AC-2
- Scope: src/summary/**
- Contracts: C-1
- Depends: T-1

## UAT
UAT: none.
`;

const TASK = ({ run, k, goal, acceptance, scope, readFirst, changes, verify = ['node -e 0'], risk = '### R-1 [high] Rabat nie przekracza sumy\n- Method: test rabat 150 jest odrzucony (AC-1)\n- Area: billing', extra = {}, more = '' }) => `${header({
  schema: 'dwmt/brief@1', run, task: `T-${k}`, goal, mode: 'single', acceptance, scope, read_first: readFirst, verify, risks: ['R-1'], decisions: ['D-1'], questions: [], ...extra,
})}# ${goal}

## Context
Rozliczenia w \`src/billing/invoice.ts#invoice\`.

## Contracts
### C-1 Rabat (z planu sprintu)
${C1}

## Changes
${changes.map((c) => `- ${c}`).join('\n')}

## Decisions
### D-1 Rabat jako wartość
Reguła zakresu 0–100 należy do wartości, nie do faktury.

## Risks
${risk}

## Out of scope
- Podsumowanie: T-2.
${more}
## Standards and docs excerpts
- [S-1] \`docs/adr/0001-modules.md:2\` — "Modules talk through contracts."
`;

const T1 = (run, o = {}) => TASK({
  run, k: 1, goal: 'Faktura liczy rabat', acceptance: ['AC-1 faktura liczy rabat'], scope: ['src/billing/**'],
  readFirst: ['src/billing/invoice.ts#invoice', 'src/shared/money.ts#Money'],
  changes: [
    '[new value object] `Discount` in `src/billing/discount.ts` — trzyma procent; pattern: `src/shared/money.ts#Money`; not: liczba w fakturze, bo reguła należy do wartości',
    '[change] `src/billing/invoice.ts#invoice` — odejmuje rabat; test first: 100 z rabatem 10 → 90',
  ],
  ...o,
});
const T2 = (run, o = {}) => TASK({
  run, k: 2, goal: 'Podsumowanie pokazuje rabat', acceptance: ['AC-2 podsumowanie pokazuje rabat'], scope: ['src/summary/**', 'src/billing/discount.ts'],
  readFirst: ['src/billing/discount.ts#Discount'],
  changes: [
    '[new presentational component] `DiscountLine` in `src/summary/discount-line.ts` — pokazuje rabat; pattern: `src/billing/invoice.ts#invoice`',
    '[change] `src/billing/discount.ts#Discount` — dodaje etykietę; test first: 10 → „-10%”',
  ],
  risk: '### R-1 [medium] Etykieta rabatu zgodna z kwotą\n- Method: test 10 → „-10%” (AC-2)\n- Area: summary',
  ...o,
});

// kt (D-16): without cfg the repo is a copy of one per-process build.
function repo27(cfg) {
  if (cfg === undefined) { const d = fromTemplate('repo27', () => buildRepo27({}).d); return { d, g: gitIn(d) }; }
  return buildRepo27(cfg);
}
function buildRepo27(cfg) {
  const d = repo();
  const g = gitIn(d);
  for (const [f, text] of Object.entries(FILES)) { mkdirSync(join(d, f, '..'), { recursive: true }); writeFileSync(join(d, f), text); }
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude', 'dwmt.json'), JSON.stringify({ verify: { full: ['node -e 0'] }, git: { target: 'master' }, run: { priceGate: false }, ...cfg }));
  assert.equal(cli(d, 'setup').code, 0);
  g('add', '-A');
  g('commit', '-q', '-m', 'start');
  return { d, g };
}
function start(d, slug = 's', R = '2.7') {
  const run = cli(d, 'preflight', '--slug', slug).json.run;
  const i = cli(d, 'init', '--run', run, '--mode', 'single').json;
  assert.equal(i.ok, true, JSON.stringify(i));
  // v2.8: init zapisuje rules 2.8; scenariusze biegną w obu regułach (`both`), przebieg 2.7 kończy się regułami 2.7.
  assert.equal(RUN(d, run).rules, RULES);
  // K4 (D-14): scenariusze tego pliku biegną w regułach 2.7/2.8 (kształt planów zadań sprzed 2.11).
  if (R !== RULES) asRules(d, run, R);
  if (!existsSync(runFile(d, run, 'task.md'))) writeFileSync(runFile(d, run, 'task.md'), 'Rabat procentowy na fakturze; podsumowanie go pokazuje.\n');
  return run;
}
const writePlans = (d, run, { plan = PLAN(run), t1 = T1(run), t2 = T2(run) } = {}) => {
  writeFileSync(runFile(d, run, 'plan.md'), plan);
  mkdirSync(join(runFile(d, run, 'plan.md'), '..', 'tasks', '2'), { recursive: true });
  if (t1) writeFileSync(runFile(d, run, 'brief.md', 1), t1);
  if (t2) writeFileSync(runFile(d, run, 'brief.md', 2), t2);
};
// Zadanie od wykonawcy do commitu: pliki, wynik, verify, review-input, recenzja PASS, commit.
function doTask(d, run, k, sid, { files = {}, remove = [], result = {}, review = {}, reviewBody = '' } = {}) {
  for (const [f, text] of Object.entries(files)) { mkdirSync(join(d, f, '..'), { recursive: true }); writeFileSync(join(d, f), text); }
  for (const f of remove) rmSync(join(d, f));
  writeFileSync(runFile(d, run, 'result-1.md', k), header({ schema: 'dwmt/result@1', status: 'DONE', ...result }));
  const v = cliAs(d, sid, {}, 'verify', run).json;
  assert.equal(v.ok, true, JSON.stringify(v));
  cliAs(d, sid, {}, 'review-input', run);
  writeFileSync(runFile(d, run, 'review-1.md', k), `${header({ schema: 'dwmt/review@1', round: 1, passes: ['correctness'], verdict: 'PASS', fix: [], acceptance: [k === 1 ? 'AC-1 met' : 'AC-2 met'], risks: ['R-1 proven'], ...review })}${reviewBody}`);
  const c = cliAs(d, sid, {}, 'commit', run).json;
  assert.equal(c.ok, true, JSON.stringify(c));
  return c;
}
// Sprint zaplanowany przez architekta, T-1 zacommitowane w sesji 1 (T-2 czeka na sesję 2).
function sprintAtT2(t1Task = {}, opts = {}) {
  const { d, g } = repo27(opts.cfg);
  const run = start(d, opts.slug ?? 'rabat', opts.R ?? '2.7');
  writePlans(d, run, opts.plans?.(run) ?? {});
  const st = cli(d, 'state', run).json;
  assert.equal(st.next, 'implement', JSON.stringify(st));
  const c = doTask(d, run, 1, 'sess-1', { files: { 'src/billing/discount.ts': 'export class Discount {}\n', ...(t1Task.files || {}) }, ...t1Task });
  assert.equal(c.next, 'handoff');
  return { d, g, run };
}

// Recenzja v2.8 F9: scenariusze przebiegu biegną w regułach 2.7 i 2.8. Różnice 2.8 w asercjach: przyczyny rozjazdu
// z przedrostkiem „for T-j: ” (replan od k do końca) i prompt kontroli celu (katalog główny, język artefaktów).
const RULESETS = ['2.7', '2.8'];
const both = (name, fn) => { for (const R of RULESETS) test(`${name} [${R}]`, () => fn(R)); };
const pre = (R, ks = 'T-2') => (R === '2.8' ? `for ${ks}: ` : '');
const preRe = (R) => (R === '2.8' ? '(?:for T-[\\d, T-]+: )' : '');

// ---------- walidacja: plan sprintu ----------

const planObj = (text) => ({ text, h: parseYaml(splitHeader(text).yaml), tasks: parseTasks(text) });

test('plan sprintu 2.7: Depends, Design, UAT i Input coverage; poprawny plan przechodzi', () => {
  const text = PLAN('r');
  const h = planObj(text).h;
  assert.deepEqual(sprintPlanErrors(text, h), []);
  const e = (t) => sprintPlanErrors(t, h).join('\n');
  assert.match(e(text.replace('- Depends: none\n', '')), /T-1: brak linii Depends/);
  assert.match(e(text.replace('- Depends: T-1', '- Depends: T-2')), /T-2: Depends T-2 \(tylko wcześniejsze/);
  assert.match(e(text.replace(/## Design\n.*\n/, '## Design\n\n')), /brak treści ## Design/);
  assert.match(e(text.replace('UAT: none.\n', '')), /## UAT jest pusta/);
  // Element wejścia bez AC-n i bez out: (i jego poprawny odpowiednik z out: <powód>).
  assert.match(e(text.replace('- Eksport do PDF → out: osobny sprint w roadmapie', '- Eksport do PDF')), /Input coverage: „Eksport do PDF” nie ma AC-n ani out: <powód>/);
  assert.match(e(text.replace('- Eksport do PDF → out: osobny sprint w roadmapie', '- Eksport do PDF → out:')), /nie ma AC-n ani out/);
  assert.match(e(text.replace('→ AC-2', '→ AC-7')), /wskazuje AC-7, których nie ma w acceptance/);
  assert.match(e(text.replace(/## Input coverage[\s\S]*?\n\n/, '')), /brak sekcji ## Input coverage/);
  assert.deepEqual(sprintPlanErrors(text.replace('## Design', '## Notes'), { ...h, questions: ['Q-1'] }), ['brak sekcji Q-1'], 'przy otwartych pytaniach tylko ich sekcje');
  assert.deepEqual(taskDepends('- Depends: T-1…T-3, T-5').ids, [1, 2, 3, 5]);
  assert.deepEqual(taskDepends('- Depends: none').ids, []);
  assert.equal(taskDepends('- Depends: soon').bad, true);
});

// ---------- walidacja: plan zadania ----------

const planP = planObj(PLAN('r'));
const errs = (text, k = 1, files = HEAD_FILES) => {
  const h = parseYaml(splitHeader(text).yaml);
  return taskPlanErrors({ text, h, k, plan: planP, base: makeBase(files) }).errors.join('\n');
};

test('plan zadania: poprawne plany przechodzą; [new] pliku w T-1 i [change] tego pliku w T-2 (baza zadania)', () => {
  assert.equal(errs(T1('r')), '');
  const base = makeBase(HEAD_FILES);
  const t1 = T1('r');
  const r1 = taskPlanErrors({ text: t1, h: parseYaml(splitHeader(t1).yaml), k: 1, plan: planP, base });
  assert.deepEqual(r1, { errors: [], news: ['src/billing/discount.ts'], changed: ['src/billing/discount.ts', 'src/billing/invoice.ts'] });
  const t2 = T2('r');
  assert.deepEqual(taskPlanErrors({ text: t2, h: parseYaml(splitHeader(t2).yaml), k: 2, plan: planP, base }).errors, [], 'baza T-2 ma plik z [new] T-1');
  assert.match(errs(T2('r'), 2), /read_first src\/billing\/discount\.ts nie istnieje w bazie zadania/, 'bez [new] z T-1 pliku nie ma');
});

test('plan zadania: skrót ścieżki (definicja, linia „Skrót:”, ...) i numer linii; verify z plik.ts:42 i wyciągi przechodzą', () => {
  const t = T1('r');
  assert.match(errs(t.replace('## Context\n', '## Context\n`BL/` = `src/billing/`\n')), /skrót ścieżki: definicja skrótu BL\//);
  assert.match(errs(t.replace('## Context\n', '## Context\nSkrót: BL to katalog rozliczeń\n')), /skrót ścieżki: linia „Skrót:”/);
  assert.match(errs(t.replace('`src/billing/invoice.ts#invoice` — odejmuje', '`src/.../invoice.ts#invoice` — odejmuje')), /skrót ścieżki: „src\/\.\.\.\/invoice\.ts#invoice/);
  assert.match(errs(t.replace('odejmuje rabat;', 'odejmuje rabat (invoice.ts:12);')), /numer linii „invoice\.ts:12”/);
  assert.match(errs(t.replace('odejmuje rabat;', 'odejmuje rabat w invoice.ts line 12;')), /numer linii „invoice\.ts line 12”/);
  assert.match(errs(t.replace('odejmuje rabat;', 'odejmuje rabat (`src/billing/invoice.ts#invoice`, linia 12);')), /numer linii „src\/billing\/invoice\.ts#invoice`, linia 12”/);
  // Recenzja v2.7: „linia 2” jako pojęcie domeny i komenda strażnika z plikiem testu nie są numerami linii w planie.
  assert.equal(errs(t.replace('odejmuje rabat;', 'odejmuje rabat na linii 2 faktury;')), '');
  assert.equal(errs(T1('r', { risk: '### R-1 [high] Rabat\n- Method: guard node --test src/billing/invoice.test.ts:7\n- Area: billing' })), '');
  assert.match(errs(T1('r', { readFirst: ['src/billing/invoice.ts:3'] })), /numer linii „src\/billing\/invoice\.ts:3”/);
  assert.equal(errs(T1('r', { verify: ['node --test src/billing/invoice.test.ts:42'] })), '', 'verify z numerem linii i wyciągi ze źródłem:linia przechodzą');
  assert.deepEqual(shortcutHits('Depends: T-1…T-3; zakres 0–100'), [], 'wielokropek bez ścieżki to nie skrót');
  assert.deepEqual(shortcutHits('adres `/invoices?id=…&from=…` i alias `@/shared/…`'), [], 'trasa i alias importu to nie ścieżki repo');
  assert.deepEqual(lineNumberHits('`src/a.ts#load`, 10:30'), []);
});

test('plan zadania: kotwice [change]/[remove]/read_first/pattern spoza bazy, [new] bez pełnej ścieżki i poza scope', () => {
  const t = T1('r');
  assert.match(errs(t.replace('`src/billing/invoice.ts#invoice` — odejmuje', '`src/billing/tax.ts#rate` — odejmuje')), /Changes: \[change\] src\/billing\/tax\.ts nie istnieje w bazie zadania/);
  assert.match(errs(t.replace('pattern: `src/shared/money.ts#Money`', 'pattern: `src/shared/price.ts#Price`')), /Changes: pattern src\/shared\/price\.ts nie istnieje/);
  assert.match(errs(t.replace('- [change]', '- [remove] `src/legacy/gone.ts#old` — zbędne\n- [change]')), /Changes: \[remove\] src\/legacy\/gone\.ts nie istnieje/);
  assert.match(errs(T1('r', { readFirst: ['src/billing/missing.ts#x'] })), /read_first src\/billing\/missing\.ts nie istnieje/);
  assert.match(errs(T1('r', { readFirst: [] })), /read_first jest pusty/);
  assert.match(errs(t.replace('in `src/billing/discount.ts`', 'in `discount.ts`')), /\[new value object\] bez pełnej ścieżki pliku/);
  assert.match(errs(t.replace('in `src/billing/discount.ts`', 'in `src/tax/discount.ts`')), /\[new\] src\/tax\/discount\.ts nie istnieje w bazie zadania ani nie pasuje do scope/);
  assert.match(errs(t.replace('- [change] `src/billing/invoice.ts#invoice`', '- [change] invoice — bez ścieżki\n- [change] `src/billing/invoice.ts#invoice`')), /\[change\] bez kotwicy ścieżka#Symbol/);
  assert.match(errs(t.replace('- [change] `src/billing', '- zmień `src/billing')), /punkt bez typu/);
  assert.match(errs(t.replace(/## Changes\n[\s\S]*?\n\n/, '## Changes\n\n')), /## Changes bez punktów/);
  assert.equal(errs(t.replace('- [change]', '- **[change]**')), '', 'gwiazdki wokół typu pomijane');
  assert.equal(errs(t.replace('— odejmuje rabat;', '— odejmuje rabat\n  (wiersz kontynuacji);')), '', 'wiersz kontynuacji należy do punktu');
});

test('plan zadania: D-n bez treści, C-n inny niż w planie, AC z planu, task, ryzyko odesłane do innego zadania, ui bez Mockup/Shot', () => {
  const t = T1('r');
  assert.match(errs(t.replace('### D-1 Rabat jako wartość\nReguła zakresu 0–100 należy do wartości, nie do faktury.\n', '### D-1 Rabat jako wartość\n')), /D-1: sekcja bez treści/);
  assert.match(errs(t.replace('### D-1 Rabat jako wartość\nReguła zakresu 0–100 należy do wartości, nie do faktury.\n', '')), /brak sekcji ### D-1/);
  assert.match(errs(t.replace(`### C-1 Rabat (z planu sprintu)\n${C1}`, '### C-1 Rabat\n`src/billing/discount.ts#Discount`: `{ value: number }`')), /C-1: treść inna niż w planie sprintu/);
  assert.equal(errs(t.replace(`### C-1 Rabat (z planu sprintu)\n${C1}`, `### C-1 Rabat\n\n${C1.replace(', ', ',\n  ')}\n`)), '', 'C-n po normalizacji białych znaków');
  assert.match(errs(t.replace(`### C-1 Rabat (z planu sprintu)\n${C1}\n`, '')), /brak sekcji ### C-1/);
  assert.match(errs(T1('r', { acceptance: ['AC-2 inne'] })), /brak AC-1, które plan przypisuje/);
  assert.match(errs(T1('r', { extra: { task: 'T-2' } })), /task: T-2, oczekiwano T-1/);
  assert.match(errs(T1('r', { risk: '### R-1 [medium] Znaczniki widoczne\n- Method: ui — przegląd zrzutu w T-2\n- Area: billing' })), /R-1: Method odsyła do T-2; dowód ryzyka powstaje w tym samym zadaniu/);
  assert.equal(errs(T1('r', { risk: '### R-1 [high] Rabat\n- Method: test zgodny z T-1 (AC-1)\n- Area: billing' })), '', 'własne zadanie w metodzie jest w porządku');
});

test('walidacja planów zadań: ui bez Mockup/Shot, nakładanie zakresów bez Depends (glob szerszy, plik [new]), replan tylko od k', () => {
  const { d } = repo27();
  const run = start(d, 'walid');
  const root = join(d, '.dwmt', 'runs', run);
  const plan = planObj(PLAN(run));
  writePlans(d, run, { t1: T1(run, { risk: '### R-1 [medium] Panel rabatu zgodny z makietą\n- Method: ui\n- Area: billing' }) });
  const cfg = { ui: { shots: 'x' } };
  let v = validateTaskPlans({ top: d, root, plan, cfg });
  assert.match(v.errors.join('\n'), /T-1: R-1: Method ui wymaga linii Mockup i Shot/);
  writePlans(d, run);
  v = validateTaskPlans({ top: d, root, plan, cfg });
  assert.deepEqual([v.errors, v.missing, v.questions], [[], [], []], 'poprawna para planów');
  // Zakresy nakładają się tylko między zadaniami połączonymi Depends (T-2 → T-1 na src/billing/discount.ts).
  const noDeps = planObj(PLAN(run).replace('- Depends: T-1', '- Depends: none'));
  assert.match(validateTaskPlans({ top: d, root, plan: noDeps, cfg }).errors.join('\n'), /T-1 i T-2: zakresy obejmują te same pliki \(src\/billing\/discount\.ts\)/);
  const head = HEAD_FILES;
  assert.match(overlapErrors({ head, plan: noDeps, news: { 1: [], 2: ['src/summary/line.ts'] }, scopes: { 1: ['src/**'], 2: ['src/summary/**'] } }).join('\n'), /T-1 i T-2: .*src\/summary\/line\.ts/, 'glob szerszy obejmuje plik [new]');
  assert.deepEqual(overlapErrors({ head, plan: noDeps, news: { 1: [], 2: [] }, scopes: { 1: ['src/billing/**'], 2: ['src/summary/**'] } }), [], 'rozłączne zakresy');
  assert.deepEqual(overlapErrors({ head, plan: planObj(PLAN(run)), news: { 1: [], 2: [] }, scopes: { 1: ['src/**'], 2: ['src/billing/**'] } }), [], 'T-2 zależy od T-1');
  // Przy replan od k=2 plan zadania 1 (zacommitowany) nie jest walidowany.
  writePlans(d, run, { t1: T1(run).replace('odejmuje rabat;', 'odejmuje rabat (invoice.ts:9);') });
  assert.match(validateTaskPlans({ top: d, root, plan, cfg }).errors.join('\n'), /T-1: numer linii/);
  writeFileSync(join(d, 'src', 'billing', 'discount.ts'), 'export class Discount {}\n');
  gitIn(d)('add', '-A');
  gitIn(d)('commit', '-q', '-m', 'T-1');
  assert.deepEqual(validateTaskPlans({ top: d, root, plan, from: 2, cfg }).errors, []);
  // Brakujący plan: błędy tylko zadań przed pierwszym brakującym.
  rmSync(runFile(d, run, 'brief.md', 1));
  v = validateTaskPlans({ top: d, root, plan, cfg });
  assert.deepEqual([v.missing, v.errors], [[1], []]);
});

test('uwagi i kotwice: dopasowanie ścieżki i symbolu, C-n; nazwa obszaru i rundy eksploratora', () => {
  const t2 = T2('r');
  const h = parseYaml(splitHeader(t2).yaml);
  const anchors = { paths: [{ path: 'src/billing/discount.ts', symbol: 'Discount' }, { path: 'src/billing/invoice.ts', symbol: 'invoice' }], contracts: new Set(['C-1']) };
  assert.equal(anchorMatches(noteAnchor('`src/billing/discount.ts#Discount`: procent jako ułamek'), anchors), true);
  assert.equal(anchorMatches(noteAnchor('src/billing/invoice.ts: zaokrągla w dół'), anchors), true, 'uwaga bez symbolu');
  assert.equal(anchorMatches(noteAnchor('`src/billing/invoice.ts#total`: inna funkcja'), anchors), false, 'inny symbol');
  assert.equal(anchorMatches(noteAnchor('C-1: percent jako ułamek'), anchors), true);
  assert.equal(anchorMatches(noteAnchor('C-2: inny kontrakt'), anchors), false);
  assert.ok(h.read_first.length);
  const r = explorerRounds([
    { type: 'user', timestamp: 't0', message: { content: 'Area: billing, invoices. Paths: src/billing/**' } },
    { type: 'assistant', timestamp: 't1', message: { content: [{ type: 'text', text: 'working' }] } },
  ]);
  assert.deepEqual(r, { area: 'billing', rounds: [{ start: 't0', at: 't1', answer: 'working' }] }, 'zapas: ostatni tekst asystenta');
});

// ---------- stany 2.7 ----------

both('sprint 2.7: architekt (plan, pytania, plany wszystkich zadań), bez planisty T-2, rozjazd z uwagi, replan-done bez pętli, kontrola celu, raport', (R) => {
  const { d, g } = repo27();
  const run = start(d, 'pelny', R);
  assert.equal(RUN(d, run).rules, R);
  let st = cli(d, 'state', run).json;
  assert.deepEqual([st.next, st.agent, st.key, st.fresh], ['plan', 'dwmt-architect', 'architect', true]);
  assert.match(st.output, /\/plan\.md$/);
  assert.match(st.prompt, /^Plan the sprint: explore, ask all the sprint's questions at once in the sprint plan and stop/);
  for (const re of [/Sprint answers: .*answers\.md/, /Vocabulary: .*templates\/reference\/vocabulary\.md/, /Design questions: .*templates\/reference\/design-questions\.md/,
    /Sizes: .*sizes\.txt/, /Explorer answers: .*\/explore\//, /Explorer type: dwmt-explorer/, /Self-read limit: 30k tokens per area/, /Rounds per explorer: at most 3/, /Templates: .*artifacts\/plan\.md, .*artifacts\/brief\.md/]) {
    assert.match(st.prompt, re);
  }
  assert.equal(cli(d, 'state', run).json.fresh, false, 'ta sama sesja: SendMessage do tego samego architekta');
  assert.equal(cliAs(d, 'sess-9', {}, 'state', run).json.fresh, true, 'inna sesja: świeży architekt');

  writeFileSync(runFile(d, run, 'plan.md'), `${PLAN(run, { questions: ['Q-1'] })}\n## Questions\n### Q-1 Limit rabatu\n- Why I ask: x\n`);
  st = cli(d, 'state', run).json;
  assert.deepEqual([st.next, st.questions], ['ask-plan', ['Q-1']]);
  writeFileSync(runFile(d, run, 'answers.md'), '### Q-1 Limit rabatu\nDo 100%.\n');
  st = cli(d, 'state', run).json;
  assert.match(st.prompt, /^Answers: .*answers\.md\. Record each as D-n, remove the answered ids from `questions`, then continue\./);
  writeFileSync(runFile(d, run, 'plan.md'), PLAN(run).replace(/## Input coverage[\s\S]*?\n\n/, ''));
  assert.match(cli(d, 'state', run).json.prompt, /^Fix the plan: brak sekcji ## Input coverage/);
  writeFileSync(runFile(d, run, 'plan.md'), PLAN(run));
  assert.match(cli(d, 'state', run).json.prompt, /^Write the missing task plans: T-1, T-2 \(keep the existing plans that pass validation\)\./);
  writePlans(d, run, { t2: null });
  assert.match(cli(d, 'state', run).json.prompt, /^Write the missing task plans: T-2 /);
  writePlans(d, run, { t1: T1(run).replace('## Context\n', '## Context\n`BL/` = `src/billing/`\n') });
  st = cli(d, 'state', run).json;
  assert.match(st.prompt, /^Fix the task plans: T-1: skrót ścieżki: definicja skrótu BL\//);
  assert.equal(RUN(d, run).plansReady, undefined);
  writePlans(d, run);
  st = cli(d, 'state', run).json;
  assert.deepEqual([st.next, st.agent, st.task, st.tasks], ['implement', 'dwmt-executor', 1, 2]);
  const rj = RUN(d, run);
  assert.ok(rj.plansReady);
  assert.equal(rj.planBase, g('merge-base', 'master', 'HEAD'));

  // T-1: uwaga dla kolejnych zadań z kotwicą, która występuje w planie T-2.
  const note = '`src/billing/discount.ts#Discount`: percent is stored as a fraction (the plan assumed whole numbers)';
  doTask(d, run, 1, 'sess-1', { files: { 'src/billing/discount.ts': 'export class Discount {}\n' }, result: { laterNotes: [note], changedContracts: ['C-1 as planned'] } });
  const rep = hdr(runFile(d, run, 'report.md', 1));
  assert.deepEqual(rep.laterNotes, [note]);
  assert.match(readFileSync(runFile(d, run, 'report.md', 1), 'utf8'), /## Notes for later tasks\n\n- `src\/billing\/discount\.ts#Discount`: percent/);
  assert.equal(cli(d, 'state', run).json.next, 'handoff');

  st = cliAs(d, 'sess-2', {}, 'state', run).json;
  assert.deepEqual([st.next, st.agent, st.key, st.fresh, st.from, st.task], ['replan', 'dwmt-architect', 'architect', true, 2, 2], JSON.stringify(st));
  assert.equal(st.causes.length, 1);
  assert.match(st.causes[0], new RegExp(`^${preRe(R)}T-1 note for later tasks: \`src/billing/discount\\.ts#Discount\``));
  assert.match(st.output, /tasks\/2\/brief\.md$/);
  assert.match(st.prompt, new RegExp(`^Replan from T-2\\. Drift causes: \\(1\\) ${preRe(R)}T-1 note for later tasks`));
  assert.match(st.prompt, /Task plans from T-2: .*tasks\/2\/brief\.md\. Reports of earlier tasks: .*tasks\/1\/report\.md/);
  assert.match(st.prompt, /End your reply with `REPLAN: changed\|unchanged <T-ids>; cause: plan\|discovery\|target`\.$/);
  assert.equal(RUN(d, run).tasks[1].replan.from, 2);
  assert.equal(cliAs(d, 'sess-2', {}, 'state', run).json.fresh, false, 'kolejny stan w tej sesji: ten sam architekt');

  // Błąd w poprawionym planie: replan-done bez zapisu, state odsyła błędy temu samemu architektowi.
  writeFileSync(runFile(d, run, 'brief.md', 2), T2(run).replace('dodaje etykietę;', 'dodaje etykietę (discount.ts line 4);'));
  const bad = cliAs(d, 'sess-2', {}, 'replan-done', run, '2', '--result', 'changed').json;
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /T-2: numer linii „discount\.ts line 4”/);
  st = cliAs(d, 'sess-2', {}, 'state', run).json;
  assert.equal(st.next, 'replan');
  assert.match(st.prompt, /Fix the task plans: T-2: numer linii/);
  writeFileSync(runFile(d, run, 'brief.md', 2), T2(run));
  const ok = cliAs(d, 'sess-2', {}, 'replan-done', run, '2', '--result', 'unchanged').json;
  assert.deepEqual([ok.ok, ok.handled, ok.cause, ok.result], [true, 1, 'discovery', 'unchanged'], JSON.stringify(ok));
  assert.deepEqual(RUN(d, run).tasks[1].drift.map((x) => [x.kind, x.result, x.cause]), [['note', 'unchanged', 'discovery']]);
  st = cliAs(d, 'sess-2', {}, 'state', run).json;
  assert.deepEqual([st.next, st.agent], ['implement', 'dwmt-executor'], 'bez pętli: przyczyna obsłużona');
  assert.equal(RUN(d, run).tasks[1].replan, undefined);

  doTask(d, run, 2, 'sess-2', {
    files: { 'src/summary/discount-line.ts': 'export const line = 1;\n' },
    review: { defer: ['F-1'], counts: { minor: 1 } },
    reviewBody: '## correctness\n### F-1 [minor] Etykieta bez zaokrąglenia\n- Cause: plan\n',
  });
  st = cliAs(d, 'sess-2', {}, 'state', run).json;
  assert.deepEqual([st.next, st.agent], ['goal-check', 'dwmt-checker']);
  assert.match(st.output, /\/goal-check\.md$/);
  assert.match(st.prompt, R === '2.7'
    ? /^Check the sprint goal before the merge\. Task: .*task\.md\. Answers: .*answers\.md\. Plan: .*plan\.md \(read only ## Input coverage and ## Tasks\)\. Task reports: .*tasks\/1\/report\.md, .*tasks\/2\/report\.md\. Template: .*artifacts\/goal-check\.md\. Output: .*goal-check\.md\. Language: en\. The full suite \(node -e 0\) runs after you, at finish, and a red result blocks the merge: an element whose only missing evidence is a run of these commands is delivered with evidence "full suite at finish", not a gap\. Final state of the sprint criteria after the fix batch \(it supersedes the statuses in the task reports\): AC-1 met; AC-2 met\.$/
    : /^Check the sprint goal before the merge\. Repo root: [^ ]+\. Task: \.dwmt\/runs\/.*task\.md\. Answers: \.dwmt\/.*answers\.md\. Plan: \.dwmt\/.*plan\.md \(read only ## Input coverage and ## Tasks\)\. Task reports: .*tasks\/1\/report\.md, .*tasks\/2\/report\.md\. Template: .*artifacts\/goal-check\.md\. Output: \.dwmt\/.*goal-check\.md\. Artifacts: English; gap reasons in the user's language: en\. The full suite \(node -e 0\) runs after you, at finish, and a red result blocks the merge: an element whose only missing evidence is a run of these commands is delivered with evidence "full suite at finish", not a gap\. Final state of the sprint criteria after the fix batch \(it supersedes the statuses in the task reports\): AC-1 met; AC-2 met\.$/);
  writeFileSync(runFile(d, run, 'goal-check.md'), header({ schema: 'dwmt/goal-check@1', items: [{ id: 'I-1', element: 'x', status: 'done' }] }));
  assert.match(cliAs(d, 'sess-2', {}, 'state', run).json.prompt, /The existing output is invalid \(I-1: status done/);
  writeFileSync(runFile(d, run, 'goal-check.md'), `---
schema: dwmt/goal-check@1
items:
  - {id: I-1, element: "Rabat procentowy na fakturze", status: delivered, task: T-1, evidence: "T-1/report.md: AC-1 met"}
  - {id: I-2, element: "Eksport do PDF", status: out, evidence: "plan: out: osobny sprint"}
  - {id: I-3, element: "Podsumowanie pokazuje rabat", status: gap, reason: "AC-2 nie mówi o zaokrągleniu, a zadanie o nie prosi"}
gaps: 1
---
## Gaps
- I-3 Podsumowanie pokazuje rabat: AC-2 nie mówi o zaokrągleniu
`);
  assert.equal(cliAs(d, 'sess-2', {}, 'state', run).json.next, 'finish');
  const fin = cliAs(d, 'sess-2', {}, 'finish', run).json;
  assert.deepEqual([fin.status, fin.gaps, fin.uat], ['squashed', 1, 'pending'], JSON.stringify(fin));
  const rh = hdr(runFile(d, run, 'final-report.md'));
  assert.equal(rh.gaps, 1);
  assert.equal(rh.uat, 'pending', 'luka kontroli celu daje uat: pending mimo „UAT: none”');
  assert.deepEqual(rh.replans, ['T-2 unchanged discovery (1)']);
  assert.deepEqual(rh.planFindings, ['T-2/F-1']);
  const report = readFileSync(runFile(d, run, 'final-report.md'), 'utf8');
  assert.match(report, /## Design\nRozliczenia są właścicielem rabatu/);
  assert.match(report, /## Goal check\n- Delivered: 1, out of scope: 1, gaps: 1 \(`goal-check\.md`\)\.\n- I-3 Podsumowanie pokazuje rabat: AC-2 nie mówi o zaokrągleniu/);
  assert.match(report, /\| Task \| Status \| Rounds \| Replan \| Commit \| Report \|\n\|---\|---\|---\|---\|---\|---\|\n\| T-1 [^\n]*\| - \|[^\n]*\n\| T-2 [^\n]*\| unchanged discovery \|/);
  assert.match(report, /### For your assessment\n\n- Goal check I-3 Podsumowanie pokazuje rabat: AC-2/);
});

both('rozjazd: uwaga z innym symbolem i „C-n as planned” nie wywołują replan; zmiana poza planem z kotwicą wywołuje', (R) => {
  const quiet = sprintAtT2({ result: { laterNotes: ['`src/billing/invoice.ts#total`: rounds down'], changedContracts: ['C-1 as planned'] } }, { R });
  assert.deepEqual([cliAs(quiet.d, 'sess-2', {}, 'state', quiet.run).json.next], ['implement']);
  const loud = sprintAtT2({ result: { changedContracts: ['C-1 as planned', 'src/billing/discount.ts#Discount: percent is a fraction now'] } }, { R });
  const st = cliAs(loud.d, 'sess-2', {}, 'state', loud.run).json;
  assert.equal(st.next, 'replan');
  assert.deepEqual(st.causes, [`${pre(R)}T-1 changed outside the plan: src/billing/discount.ts#Discount: percent is a fraction now`]);
});

both('rozjazd: zależność ACCEPTED z niespełnionym AC i znikające kotwice ([remove], read_first, pattern)', (R) => {
  const dep = sprintAtT2({}, { R });
  const repFile = runFile(dep.d, dep.run, 'report.md', 1);
  writeFileSync(repFile, readFileSync(repFile, 'utf8').replace('status: "PASS"', 'status: "ACCEPTED"').replace('acceptance: ["AC-1 met"]', 'acceptance: ["AC-1 partial"]'));
  let st = cliAs(dep.d, 'sess-2', {}, 'state', dep.run).json;
  assert.equal(st.next, 'replan');
  assert.deepEqual(st.causes, [`${pre(R)}T-1 (a dependency) ended ACCEPTED with AC-1 partial`]);

  // T-2 planuje [remove] pliku, czyta plik z [new] T-1 i bierze wzór z pliku, którego po T-1 nie ma.
  const plans = (run) => ({
    t2: T2(run, {
      readFirst: ['src/billing/discount.ts#Discount', 'src/legacy/old.ts'],
      changes: [
        '[new presentational component] `DiscountLine` in `src/summary/discount-line.ts` — pokazuje rabat; pattern: `src/shared/money.ts#Money`',
        '[remove] `src/legacy/old.ts#old` — martwy kod',
      ],
      scope: ['src/summary/**', 'src/legacy/**'],
    }),
  });
  const gone = sprintAtT2({ files: { 'src/billing/discount.ts': 'export class Discount {}\n' }, remove: ['src/legacy/old.ts', 'src/shared/money.ts'] }, { plans, R });
  st = cliAs(gone.d, 'sess-2', {}, 'state', gone.run).json;
  assert.equal(st.next, 'replan');
  assert.deepEqual(st.causes.sort(), [
    `${pre(R)}src/legacy/old.ts (read_first in the plan of T-2) is not on HEAD: removed, renamed or never created`,
    `${pre(R)}src/shared/money.ts (pattern in the plan of T-2) is not on HEAD: removed, renamed or never created`,
  ]);
  const done = cliAs(gone.d, 'sess-2', {}, 'replan-done', gone.run, '2', '--result', 'changed');
  assert.equal(done.json.ok, false, 'plan dalej wskazuje nieistniejące pliki');
  writeFileSync(runFile(gone.d, gone.run, 'brief.md', 2), T2(gone.run).replace('pattern: `src/billing/invoice.ts#invoice`', 'pattern: `src/billing/discount.ts#Discount`'));
  const ok = cliAs(gone.d, 'sess-2', {}, 'replan-done', gone.run, '2', '--result', 'changed').json;
  assert.deepEqual([ok.ok, ok.handled, ok.cause], [true, 2, 'discovery'], 'zapisane przyczyny, które wywołały replan');
  assert.equal(cliAs(gone.d, 'sess-2', {}, 'state', gone.run).json.next, 'implement');
});

both('planIssue: BLOCKED z planIssue → replan (nie ask), replan-done zdejmuje blokadę, świeży wykonawca kontynuuje', (R) => {
  const { d, run } = sprintAtT2({}, { R });
  let st = cliAs(d, 'sess-2', {}, 'state', run).json;
  assert.equal(st.next, 'implement');
  writeFileSync(runFile(d, run, 'result-1.md', 2), header({ schema: 'dwmt/result@1', status: 'BLOCKED', planIssue: 'Discount has no label field; C-1 needs it', questions: ['Q-1'] }) + '### Q-1 Etykieta?\n');
  st = cliAs(d, 'sess-2', {}, 'state', run).json;
  assert.deepEqual([st.next, st.from, st.fresh], ['replan', 2, true], JSON.stringify(st));
  assert.deepEqual(st.causes, ['T-2 BLOCKED with planIssue: Discount has no label field; C-1 needs it']);
  const ok = cliAs(d, 'sess-2', {}, 'replan-done', run, '2', '--result', 'changed').json;
  assert.deepEqual([ok.ok, ok.cause, ok.unblocked], [true, 'plan', true], JSON.stringify(ok));
  assert.ok(readdirSync(join(d, '.dwmt', 'runs', run, 'tasks', '2')).includes('result-1.blocked-1.md'), 'wynik BLOCKED odłożony');
  assert.equal(RUN(d, run).tasks[1].drift[0].id, 'T-2/result-1.md#planIssue');
  st = cliAs(d, 'sess-2', {}, 'state', run).json;
  assert.deepEqual([st.next, st.agent], ['continue', 'dwmt-executor']);
  assert.match(st.prompt, /The task plan was corrected after your BLOCKED report \(planIssue\): read it again before you continue\./);
  // Drugi BLOCKED tej rundy to nowa przyczyna, nie obsłużona.
  writeFileSync(runFile(d, run, 'result-1.md', 2), header({ schema: 'dwmt/result@1', status: 'BLOCKED', planIssue: 'still wrong' }));
  st = cliAs(d, 'sess-2', {}, 'state', run).json;
  assert.equal(st.next, 'replan');
  assert.equal(RUN(d, run).tasks[1].replan.causes[0].id, 'T-2/result-1.md#planIssue-2');
});

both('rozjazd: zmiana celu po rebase rundy 1 przy git.rebase review; replan-done przesuwa planBase', (R) => {
  const { d: main, g } = repo27({ git: { target: 'master', rebase: 'review' } });
  const wt = join(main, '..', `${main.split(/[\\/]/).pop()}-rr`);
  g('worktree', 'add', '-q', '-b', 'sprint', wt);
  const run = start(wt, 'rr', R);
  writePlans(wt, run);
  assert.equal(cli(wt, 'state', run).json.next, 'implement');
  // Cel zmienia plik z zakresu T-2 (pattern: invoice.ts) w trakcie T-1; rebase rundy 1 wnosi zmianę do gałęzi sprintu.
  writeFileSync(join(main, 'src', 'billing', 'invoice.ts'), 'export const invoice = (total, d) => total - d;\n');
  g('commit', '-q', '-am', 'cel: invoice');
  const planBase = RUN(wt, run).planBase;
  doTask(wt, run, 1, 'sess-1', { files: { 'src/billing/discount.ts': 'export class Discount {}\n' } });
  const st = cliAs(wt, 'sess-2', {}, 'state', run).json;
  assert.equal(st.next, 'replan', JSON.stringify(st));
  assert.match(st.causes[0], new RegExp(`^${preRe(R)}the target changed src/billing/invoice\\.ts since planning \\(${planBase.slice(0, 7)}\\.\\.[0-9a-f]{7}\\)`));
  const ok = cliAs(wt, 'sess-2', {}, 'replan-done', run, '2', '--result', 'unchanged').json;
  assert.equal(ok.cause, 'target');
  assert.equal(RUN(wt, run).planBase, gitIn(wt)('merge-base', 'master', 'HEAD'));
  assert.equal(ok.planBase, RUN(wt, run).planBase.slice(0, 7));
  assert.equal(cliAs(wt, 'sess-2', {}, 'state', run).json.next, 'implement');
});

// Supervisor: wejście z `after`, worktree sprintu, status w głównym drzewie.
function afterSprint({ plansBefore, R = '2.7', cfg = {} }) {
  const { d: main, g } = repo27(cfg);
  mkdirSync(join(main, '.dwmt', 'supervisor', 'input'), { recursive: true });
  writeFileSync(join(main, '.dwmt', 'supervisor', 'input', 'S1.md'), `${header({ schema: 'dwmt/sprint-input@1', sprint: 'S1', order: ['S0', 'S1'], after: ['S0'] })}Rabat na fakturze\n`);
  const wt = join(main, '..', `${main.split(/[\\/]/).pop()}-s1`);
  g('worktree', 'add', '-q', '-b', 'sprint', wt);
  const tr = mkdtempSync(join(tmpdir(), 'dwmt-tr-'));
  const env = { DWMT_TRANSCRIPTS: tr };
  const run = cliAs(wt, 'sess-1', env, 'preflight', '--slug', 's1').json.run;
  assert.equal(cliAs(wt, 'sess-1', env, 'init', '--run', run, '--mode', 'single', '--sprint', 'S1').json.ok, true);
  if (R === '2.7') asV27(wt, run);
  else asRules(wt, run, '2.10');
  const status = () => JSON.parse(readFileSync(join(main, '.dwmt', 'supervisor', 'status', 'S1.json'), 'utf8'));
  // Eksplorator z sesji planowania: odpowiedź wymienia plik, który potem zmieni cel.
  const subs = join(tr, 'proj', 'sess-1', 'subagents');
  mkdirSync(subs, { recursive: true });
  const line = (o) => `${JSON.stringify(o)}\n`;
  writeFileSync(join(subs, 'agent-e1e1e1e1.meta.json'), JSON.stringify({ agentType: 'dwmt-explorer' }));
  // Znaczniki czasu z przeszłości: runda sprzed wyjścia z `planned` bez zależności od zegara testu.
  writeFileSync(join(subs, 'agent-e1e1e1e1.jsonl'), line({ type: 'user', timestamp: '2020-01-01T08:00:00.000Z', message: { content: 'Area: billing. Paths: src/billing/**' } })
    + line({ type: 'assistant', timestamp: '2020-01-01T08:01:00.000Z', message: { content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message: '`src/billing/invoice.ts#invoice` returns the total' } }] } }));
  let st = cliAs(wt, 'sess-1', env, 'state', run).json;
  assert.equal(st.next, 'plan');
  assert.deepEqual([status().state, status().stage], ['planning', 'plan']);
  // Recenzja v2.7 pkt 3: przy `after` architekt kończy na planie sprintu (plany zadań po scaleniu zależności).
  assert.match(st.prompt, /^Plan the sprint: .*write the sprint plan only\. This sprint waits for other sprints to merge: do not write task plans now/);
  writeFileSync(runFile(wt, run, 'plan.md'), `${PLAN(run, { questions: ['Q-1'] })}\n## Questions\n### Q-1 Limit\n- Why I ask: x\n`);
  writeFileSync(runFile(wt, run, 'answers.md'), '### Q-1 Limit\n100%\n');
  assert.match(cliAs(wt, 'sess-1', env, 'state', run).json.prompt, /^Answers: .*, then finish the sprint plan only \(the task plans come after the dependencies merge\)\./);
  writePlans(wt, run, plansBefore ? {} : { t1: null, t2: null });
  st = cliAs(wt, 'sess-1', env, 'state', run).json;
  assert.deepEqual([st.next, st.waitingFor], ['planned', ['S0']], JSON.stringify(st));
  assert.equal(status().state, 'planned');
  assert.equal(RUN(wt, run).plansReady, undefined);
  // S0 scalony: cel zmienia plik z kotwic T-1.
  writeFileSync(join(main, 'src', 'billing', 'invoice.ts'), 'export const invoice = (total) => Math.round(total);\n');
  g('commit', '-q', '-am', 'S0');
  writeFileSync(join(main, '.dwmt', 'supervisor', 'status', 'S0.json'), JSON.stringify({ sprint: 'S0', state: 'done' }));
  return { main, wt, g, run, env, status };
}

both('after: plany zadań pisze świeży architekt po wyjściu z planned; druga paczka pytań w statusie; explore/ nieaktualne', (R) => {
  const { wt, run, env, status } = afterSprint({ plansBefore: false, R });
  let st = cliAs(wt, 'sess-1', env, 'state', run).json;
  assert.deepEqual([st.next, st.agent, st.key, st.fresh], ['plan', 'dwmt-architect', 'architect', true], JSON.stringify(st));
  assert.match(st.prompt, /^The sprints this one waited for are merged \(files changed on the target since planning: src\/billing\/invoice\.ts\)\. Check the sprint plan against the current code: record changes as new D-n and business questions as a second batch in the sprint plan with `questionsRound: 2`/);
  assert.ok(existsSync(join(wt, 'src', 'billing', 'invoice.ts')) && /Math\.round/.test(readFileSync(join(wt, 'src', 'billing', 'invoice.ts'), 'utf8')), 'gałąź sprintu dogoniła cel');
  const ex = hdr(runFile(wt, run, 'explore/billing-r1.md'));
  assert.deepEqual([ex.schema, ex.area, ex.round, ex.stale], ['dwmt/explore@1', 'billing', 1, ['src/billing/invoice.ts']]);
  writeFileSync(runFile(wt, run, 'plan.md'), `${PLAN(run, { questions: ['Q-2'], questionsRound: 2 })}\n## Questions\n### Q-2 Zaokrąglenie\n- Why I ask: cel zaokrągla sumę\n`);
  st = cliAs(wt, 'sess-1', env, 'state', run).json;
  assert.equal(st.next, 'ask-plan');
  assert.deepEqual([status().state, status().questionsRound], ['waiting-user', 2]);
  writePlans(wt, run);
  st = cliAs(wt, 'sess-1', env, 'state', run).json;
  assert.equal(st.next, 'implement', JSON.stringify(st));
  assert.equal(RUN(wt, run).planBase, gitIn(wt)('rev-parse', 'master'), 'plany na kodzie po scaleniu');
});

both('after: gotowe plany przy wyjściu z planned → replan od T-1 z przyczyną target; status planning replan T-1', (R) => {
  const { wt, run, env, status, g } = afterSprint({ plansBefore: true, R });
  const planBase = RUN(wt, run).planBase;
  const st = cliAs(wt, 'sess-1', env, 'state', run).json;
  assert.deepEqual([st.next, st.from, st.fresh], ['replan', 1, true], JSON.stringify(st));
  assert.match(st.causes[0], new RegExp(`^${preRe(R)}the target changed src/billing/invoice\\.ts since planning \\(${planBase.slice(0, 7)}\\.\\.`));
  assert.deepEqual([status().state, status().stage], ['planning', 'replan T-1']);
  assert.equal(RUN(wt, run).planBase, planBase, 'planBase czeka na replan-done');
  const ok = cliAs(wt, 'sess-1', env, 'replan-done', run, '1', '--result', 'unchanged').json;
  assert.deepEqual([ok.ok, ok.cause], [true, 'target']);
  assert.equal(RUN(wt, run).planBase, g('rev-parse', 'master'));
  assert.equal(cliAs(wt, 'sess-1', env, 'state', run).json.next, 'implement');
});

// kf2 (D-6, D-9, D-14): przebieg pod zleceniem supervisora przed pierwszym zadaniem czeka na bieżące zależności swojej
// pozycji zlecenia (`<main>/.dwmt/supervisor/supervisor.json`), nie na kopię z pliku wejścia (B-16: zakleszczenie kt).
const putOrder = (main, items) => {
  mkdirSync(join(main, '.dwmt', 'supervisor'), { recursive: true });
  writeFileSync(join(main, '.dwmt', 'supervisor', 'supervisor.json'), JSON.stringify({ items }));
};
const ORDER = { S0: { id: 'S0', src: 'file', state: 'done', after: [] }, S2: { id: 'S2', src: 'file', state: 'queued', after: ['S1'] }, S1: { id: 'S1', src: 'file', state: 'planning', after: ['S0'] } };
const orderItems = (o = {}) => ['S0', 'S2', 'S1'].map((id) => ({ ...ORDER[id], ...(o[id] ?? {}) }));
// Przebieg S1 pod zleceniem: kopia zależności z pliku wejścia (`inputAfter`) i pozycje zlecenia (`items`) niezależnie.
function orderRun({ R, inputAfter = ['S0', 'S2'], items = orderItems() }) {
  const { d: main, g } = repo27();
  mkdirSync(join(main, '.dwmt', 'supervisor', 'input'), { recursive: true });
  writeFileSync(join(main, '.dwmt', 'supervisor', 'input', 'S1.md'), `${header({ schema: 'dwmt/sprint-input@1', sprint: 'S1', order: ['S0', 'S1', 'S2'], after: inputAfter })}Rabat na fakturze\n`);
  putOrder(main, items);
  const wt = join(main, '..', `${main.split(/[\\/]/).pop()}-s1`);
  g('worktree', 'add', '-q', '-b', 'sprint', wt);
  const env = { DWMT_TRANSCRIPTS: mkdtempSync(join(tmpdir(), 'dwmt-tr-')) };
  const run = cliAs(wt, 'sess-1', env, 'preflight', '--slug', 's1').json.run;
  assert.equal(cliAs(wt, 'sess-1', env, 'init', '--run', run, '--mode', 'single', '--sprint', 'S1').json.ok, true);
  if (R === '2.7') asV27(wt, run);
  else asRules(wt, run, '2.10');
  assert.deepEqual(RUN(wt, run).after, inputAfter, 'kopia wejścia w run.json');
  return { main, g, wt, run, env, state: () => cliAs(wt, 'sess-1', env, 'state', run).json };
}
function orderSprint({ plansBefore, R }) {
  const { main, g, wt, run, env } = orderRun({ R });
  const st = cliAs(wt, 'sess-1', env, 'state', run).json;
  assert.equal(st.next, 'plan', JSON.stringify(st));
  assert.match(st.prompt, /^Plan the sprint: .*write the sprint plan only\. This sprint waits for other sprints to merge/);
  assert.match(st.prompt, /Sprints of the order: S0, S2, S1: /);
  writePlans(wt, run, plansBefore ? {} : { t1: null, t2: null });
  // Cel zmienia plik z kotwic T-1: gotowe plany idą po wyjściu z planned do replan (zadanie 1 jeszcze nie ruszyło).
  writeFileSync(join(main, 'src', 'billing', 'invoice.ts'), 'export const invoice = (total) => Math.round(total);\n');
  g('commit', '-q', '-am', 'S0');
  const state = () => cliAs(wt, 'sess-1', env, 'state', run).json;
  return { main, wt, run, env, state };
}

both('after: zależności z bieżącego zlecenia, nie z kopii przebiegu', (R) => {
  const { wt, run, state } = orderSprint({ plansBefore: false, R });
  const st = state();
  assert.notEqual(st.next, 'planned', JSON.stringify(st));
  assert.ok(RUN(wt, run).afterDone, 'przebieg wyszedł z kroku zależności');
  assert.match(st.prompt, /^The sprints this one waited for are merged/);
});

// Recenzja T-2 F-1: start architekta „tylko plan sprintu” wynika z bieżących zależności zlecenia, nie z kopii przebiegu.
both('after: start tylko planu sprintu z bieżącego zlecenia, gdy kopia przebiegu jest pusta', (R) => {
  const { wt, run, state } = orderRun({ R, inputAfter: [], items: orderItems({ S0: { state: 'queued' }, S2: { after: [] } }) });
  let st = state();
  assert.equal(st.next, 'plan', JSON.stringify(st));
  assert.match(st.prompt, /^Plan the sprint: .*write the sprint plan only\. This sprint waits for other sprints to merge/);
  writePlans(wt, run, { t1: null, t2: null });
  st = state();
  assert.deepEqual([st.next, st.waitingFor], ['planned', ['S0']], JSON.stringify(st));
});

both('after: pełny start planowania, gdy zlecenie nie daje zależności, choć kopia przebiegu je ma', (R) => {
  const { wt, run, state } = orderRun({ R, items: orderItems({ S1: { after: [] } }) });
  let st = state();
  assert.equal(st.next, 'plan', JSON.stringify(st));
  assert.match(st.prompt, /^Plan the sprint: .*write the sprint plan and the plans of all its tasks\./);
  writePlans(wt, run, { t1: null, t2: null });
  st = state();
  assert.notEqual(st.next, 'planned', JSON.stringify(st));
  assert.match(st.prompt ?? '', /Write the missing task plans: T-1, T-2/, JSON.stringify(st));
});

both('after: pierwsze zadanie ruszyło, zmiana zależności nie zatrzymuje', (R) => {
  const { main, wt, run, state } = orderSprint({ plansBefore: true, R });
  let st = state();
  assert.equal(st.next, 'replan', JSON.stringify(st));
  assert.ok(RUN(wt, run).afterDone);
  const r = RUN(wt, run);
  r.tasks[0].startEvent = new Date().toISOString();
  writeFileSync(runFile(wt, run, 'run.json'), JSON.stringify(r, null, 2));
  putOrder(main, orderItems({ S1: { after: ['S2'] } }));
  st = state();
  assert.notEqual(st.next, 'planned', JSON.stringify(st));
  assert.equal(st.waitingFor, undefined);
  assert.ok(RUN(wt, run).afterDone);
});

both('after: nowa zależność po wyjściu z planned, przed pierwszym zadaniem', (R) => {
  const { main, wt, run, state } = orderSprint({ plansBefore: true, R });
  assert.equal(state().next, 'replan');
  const first = RUN(wt, run).afterDone;
  assert.ok(first);
  putOrder(main, orderItems({ S1: { after: ['S2'] } }));
  let st = state();
  assert.deepEqual([st.next, st.waitingFor, st.again], ['planned', ['S2'], undefined], JSON.stringify(st));
  assert.equal(RUN(wt, run).afterDone, undefined);
  assert.equal(JSON.parse(readFileSync(join(main, '.dwmt', 'supervisor', 'status', 'S1.json'), 'utf8')).state, 'planned');
  // Jeszcze raz: bez zmiany zależności dalej czeka (bez pętli wyjść).
  assert.equal(state().next, 'planned');
  putOrder(main, orderItems({ S1: { after: ['S2'] }, S2: { state: 'done' } }));
  st = state();
  assert.notEqual(st.next, 'planned', JSON.stringify(st));
  const r = RUN(wt, run);
  assert.ok(r.afterDone && r.afterDone !== first, 'ponowne wyjście z planned');
  assert.equal(r.targetCheck?.at, r.afterDone, 'kontrola rozjazdu leavePlanned27 przy gotowych planach zadań');
  assert.equal(st.next, 'replan', JSON.stringify(st));
  assert.equal(state().next, st.next, 'stan stabilny po wyjściu');
});

// Recenzja N-2 (11): `drive: true` ginęło, gdy `state` wychodził z `planned` (drugie obliczenie stanu).
test('recenzja N-2: state wychodzący z planned zwraca drive: true', () => {
  const { wt, run, env } = afterSprint({ plansBefore: false, cfg: { drive: { enabled: true } } });
  const st = cliAs(wt, 'sess-1', env, 'state', run).json;
  assert.deepEqual([st.next, st.agent, st.fresh, st.drive], ['plan', 'dwmt-architect', true, true], JSON.stringify(st));
});

test('przebieg bez rules kończy się regułami v2.6: architekt pod kluczami planistów, prompt z dopiskiem, planista zadania k', () => {
  const { d } = repo27();
  const run = start(d, 'v26');
  asV26(d, run);
  let st = cli(d, 'state', run).json;
  assert.deepEqual([st.next, st.agent, st.key, st.fresh], ['plan', 'dwmt-architect', 'planner', undefined]);
  assert.match(st.prompt, /^v2\.6 run: write only what this prompt names\. Plan the sprint: explore breadth-first/);
  // Plan v2.6: bez Design, Input coverage i Depends przy T-1 przechodzi; brief zadania 1 bez read_first.
  writeFileSync(runFile(d, run, 'plan.md'), PLAN(run).replace(/## Design[\s\S]*?## Decisions/, '## Decisions').replace('- Depends: none\n', ''));
  st = cli(d, 'state', run).json;
  assert.match(st.prompt, /^v2\.6 run: write only what this prompt names\. The plan is complete: write the brief of task 1\./);
  writeFileSync(runFile(d, run, 'brief.md'), `${header({ schema: 'dwmt/brief@1', run, goal: 'Rabat', mode: 'single', acceptance: ['AC-1 faktura liczy rabat'], scope: ['src/billing/**'], verify: ['node -e 0'] })}# Rabat\n`);
  assert.equal(cli(d, 'state', run).json.next, 'implement');
  doTask(d, run, 1, 'sess-1', { files: { 'src/billing/discount.ts': 'x\n' }, result: { laterNotes: ['`src/billing/discount.ts#Discount`: note'] } });
  st = cliAs(d, 'sess-2', {}, 'state', run).json;
  assert.deepEqual([st.next, st.agent, st.key], ['plan', 'dwmt-architect', 'planner-T2'], 'v2.6: brief zadania k pisze architekt w miejsce planisty zadania, bez rozjazdu');
  assert.match(st.prompt, /^v2\.6 run: write only what this prompt names\. Plan task 2 \(T-2\)/);
  assert.equal(RUN(d, run).rules, undefined);
  assert.equal(cliAs(d, 'sess-2', {}, 'replan-done', run, '2', '--result', 'unchanged').code, 1, 'replan-done tylko w v2.7');
});

test('import: brief v2.6 bez read_first (reguły v2.6) i plan zadania v2.7 (kotwice wobec HEAD i scope)', () => {
  const { d } = repo27();
  const v26 = join(d, '..', 'brief-v26.md');
  writeFileSync(v26, `${header({ schema: 'dwmt/brief@1', run: 'x', goal: 'Rabat', mode: 'single', acceptance: ['AC-1 rabat'], scope: ['src/billing/**'], verify: ['node -e 0'] })}# Rabat\n\n${UAT_NONE}`);
  const run1 = cli(d, 'preflight', '--slug', 'imp26').json.run;
  writeFileSync(v26, readFileSync(v26, 'utf8').replace('run: "x"', `run: "${run1}"`));
  const i1 = cli(d, 'init', '--run', run1, '--mode', 'single', '--input', v26).json;
  assert.deepEqual([i1.ok, i1.kind], [true, 'brief'], JSON.stringify(i1));
  assert.equal(RUN(d, run1).rules, RULES);
  assert.equal(cli(d, 'state', run1).json.next, 'implement');
  gitIn(d)('switch', '-q', 'master');

  const run2 = cli(d, 'preflight', '--slug', 'imp27').json.run;
  const t = join(d, '..', 'plan-v27.md');
  writeFileSync(t, `${T1(run2).replace('- Podsumowanie: T-2.\n', '- Podsumowanie: osobny sprint.\n')}\n${UAT_NONE}`);
  const i2 = cli(d, 'init', '--run', run2, '--mode', 'single', '--input', t).json;
  assert.equal(i2.ok, true, JSON.stringify(i2));
  assert.equal(cli(d, 'state', run2).json.next, 'implement');
  writeFileSync(t, readFileSync(t, 'utf8').replace('`src/billing/invoice.ts#invoice` — odejmuje', '`src/billing/tax.ts#rate` — odejmuje'));
  const bad = cli(d, 'import-plan', t, '--run', run2).json;
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join('\n'), /Changes: \[change\] src\/billing\/tax\.ts nie istnieje w bazie zadania/);
  assert.match(cli(d, 'state', run2).json.hint, /^plan zadania 1 niepoprawny: .*tax\.ts/);
});

test('explore/: odpowiedzi eksploratorów z transkryptów sesji (rundy, powtórka, obszar, świeży eksplorator), idempotentnie', () => {
  const { d } = repo27();
  const run = start(d, 'ex');
  const tr = mkdtempSync(join(tmpdir(), 'dwmt-tr-'));
  const env = { DWMT_TRANSCRIPTS: tr };
  const subs = join(tr, 'D--proj', 'sess-1', 'subagents');
  mkdirSync(subs, { recursive: true });
  const line = (o) => `${JSON.stringify(o)}\n`;
  const hb = (ts, message) => line({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message } }] } });
  const agent = (id, type, text) => { writeFileSync(join(subs, `agent-${id}.meta.json`), JSON.stringify({ agentType: type, parentAgentId: 'arch' })); writeFileSync(join(subs, `agent-${id}.jsonl`), text); };
  agent('aaa111bbb', 'dwmt-explorer', line({ type: 'user', timestamp: '2026-09-30T10:00:00.000Z', message: { content: 'Area: Billing core, invoices. Paths you may read: src/billing/**' } })
    + line({ type: 'user', timestamp: '2026-09-30T10:00:00.100Z', isMeta: true, message: { content: '<system-reminder>handback</system-reminder>' } })
    + hb('2026-09-30T10:02:00.000Z', 'R1: `src/billing/invoice.ts#invoice` returns the total')
    + line({ type: 'user', timestamp: '2026-09-30T10:05:00.000Z', origin: { kind: 'peer', from: 'arch' }, message: { content: 'Round 2. Q-3' } })
    + hb('2026-09-30T10:05:01.000Z', 'R1: `src/billing/invoice.ts#invoice` returns the total')
    + hb('2026-09-30T10:07:00.000Z', 'R2: no discount rule exists')
    + line({ type: 'user', timestamp: '2026-09-30T10:09:00.000Z', origin: { kind: 'peer', from: 'arch' }, message: { content: 'Round 3' } }));
  agent('ccc222ddd', 'dwmt-explorer', line({ type: 'user', timestamp: '2026-09-30T10:01:00.000Z', message: { content: 'Paths you may read: src/shared/**' } }) + hb('2026-09-30T10:03:00.000Z', 'shared: Money is a value object'));
  agent('eee333fff', 'dwmt-reviewer', line({ type: 'user', timestamp: '2026-09-30T10:01:00.000Z', message: { content: 'Area: review' } }) + hb('2026-09-30T10:03:00.000Z', 'not an explorer'));
  cliAs(d, 'sess-1', env, 'state', run);
  const dir = join(d, '.dwmt', 'runs', run, 'explore');
  assert.deepEqual(readdirSync(dir).sort(), ['billing-core-r1.md', 'billing-core-r2.md', 'explorer-ccc222-r1.md']);
  const r2 = readFileSync(join(dir, 'billing-core-r2.md'), 'utf8');
  assert.deepEqual(hdr(join(dir, 'billing-core-r2.md')), { schema: 'dwmt/explore@1', area: 'billing-core', round: 2, agent: 'aaa111bbb', session: 'sess-1', at: '2026-09-30T10:07:00.000Z', stale: [] });
  assert.match(r2, /---\n\nR2: no discount rule exists\n$/, 'powtórzona odpowiedź rundy 1 odpada');
  assert.ok(RUN(d, run).exploreSeen['sess-1/aaa111bbb']);
  // Świeży eksplorator obszaru po przerwie: kolejny numer rundy w obszarze.
  agent('ggg444hhh', 'dwmt-explorer', line({ type: 'user', timestamp: '2026-09-30T12:00:00.000Z', message: { content: 'Area: billing core. Paths: src/billing/discount/**' } }) + hb('2026-09-30T12:03:00.000Z', 'R3: places for the plan'));
  cliAs(d, 'sess-1', env, 'state', run);
  assert.match(readFileSync(join(dir, 'billing-core-r3.md'), 'utf8'), /R3: places for the plan/);
  assert.equal(readFileSync(join(dir, 'billing-core-r2.md'), 'utf8'), r2, 'numeracja stabilna');
  assert.equal(readdirSync(dir).length, 4);
});

test('sizes.txt: tokeny na katalog z git ls-files minus review.ignoreGlobs, suma rekurencyjna, wiersz ./', () => {
  const { d, g } = repo27({ review: { ignoreGlobs: ['src/generated/**'] } });
  mkdirSync(join(d, 'src', 'generated'), { recursive: true });
  writeFileSync(join(d, 'src', 'generated', 'client.ts'), 'x'.repeat(40000));
  writeFileSync(join(d, 'src', 'billing', 'big.ts'), 'y'.repeat(4000));
  writeFileSync(join(d, 'untracked.ts'), 'z'.repeat(4000));
  // Recenzja v2.7 pkt 11: głębiej niż 2 poziomy tylko katalogi od 5k tokenów.
  mkdirSync(join(d, 'src', 'legacy', 'deep', 'x'), { recursive: true });
  writeFileSync(join(d, 'src', 'legacy', 'deep', 'x', 'tiny.ts'), 't\n');
  mkdirSync(join(d, 'src', 'big', 'a', 'b'), { recursive: true });
  writeFileSync(join(d, 'src', 'big', 'a', 'b', 'huge.ts'), 'h'.repeat(24000));
  g('add', 'src');
  g('commit', '-q', '-m', 'more');
  const run = start(d, 'sizes');
  const text = readFileSync(join(d, '.dwmt', 'runs', run, 'sizes.txt'), 'utf8');
  assert.match(text, /^# dwmt sizes: estimated tokens \(bytes \/ 4\)/);
  const rows = text.split('\n').filter((l) => l && !l.startsWith('#'));
  assert.match(rows[0], /^\s+\d+\.\dk {2}\.\/ {2}\(\d+ files\)$/);
  const row = (dir) => rows.find((r) => r.includes(`  ${dir}  `));
  const billing = Object.keys(FILES).filter((f) => f.startsWith('src/billing/')).map((f) => FILES[f].length).reduce((a, b) => a + b, 4000);
  assert.equal(row('src/billing/').trim(), `${(billing / 4000).toFixed(1)}k  src/billing/  (3 files)`);
  assert.equal(row('src/generated/'), undefined, 'pliki generowane poza szacunkiem');
  assert.ok(!text.includes('untracked'), 'tylko pliki śledzone');
  assert.match(row('src/'), /\(7 files\)$/);
  assert.match(text, /^# Listed: every directory up to depth 2; deeper ones only from 5k tokens/m);
  assert.ok(row('src/legacy/'), 'głębokość 2 zawsze');
  assert.equal(row('src/legacy/deep/'), undefined, 'głęboki i mały katalog pominięty');
  assert.equal(row('src/big/a/b/').trim(), '6.0k  src/big/a/b/  (1 files)');
});

test('setup v2.7: architekt, eksplorator (model roli), kontrola celu; alias planner z ostrzeżeniem; usunięcie dwmt-planner', () => {
  const d = repo();
  mkdirSync(join(d, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(d, '.claude', 'agents', 'dwmt-planner.md'), '---\nname: dwmt-planner\n---\nold\n');
  writeFileSync(join(d, '.claude', 'dwmt.json'), JSON.stringify({ model: 'sonnet', roles: { planner: { effort: 'high', maxTurns: 120 } }, git: { target: 'master' } }));
  const s = cli(d, 'setup').json;
  assert.deepEqual(s.written.sort(), ['dwmt-architect', 'dwmt-checker', 'dwmt-executor', 'dwmt-executor-high', 'dwmt-explorer', 'dwmt-reviewer', 'dwmt-reviewer-high']);
  assert.deepEqual(s.removed, ['dwmt-planner']);
  assert.match(s.warnings[0], /roles\.planner .* roles\.architect/);
  assert.ok(!existsSync(join(d, '.claude', 'agents', 'dwmt-planner.md')));
  const agent = (n) => readFileSync(join(d, '.claude', 'agents', `${n}.md`), 'utf8');
  assert.match(agent('dwmt-architect'), /^model: sonnet\neffort: high\nmaxTurns: 120\ntools: Read, Grep, Glob, Write, Edit, Agent, SendMessage, ToolSearch\n# dwmt: config [0-9a-f]{8}, template 16$/m);
  assert.match(agent('dwmt-explorer'), /^model: opus\neffort: medium\nmaxTurns: 100\ntools: Read, Grep, Glob$/m, 'model roli nad globalnym');
  assert.match(agent('dwmt-checker'), /^model: sonnet\neffort: medium\nmaxTurns: 40\n/m);
  assert.equal(cli(d, 'setup', '--check').json.ok, true);
  writeFileSync(join(d, '.claude', 'agents', 'dwmt-planner.md'), 'old\n');
  const chk = cli(d, 'setup', '--check').json;
  assert.deepEqual([chk.ok, chk.obsolete], [false, ['dwmt-planner']]);
  gitIn(d)('add', '-A');
  gitIn(d)('commit', '-q', '-m', 'cfg');
  const pf = cli(d, 'preflight', '--slug', 'x').json;
  assert.ok(pf.blockers.some((b) => /setup/.test(b)), 'przestarzały agent: setup');
  assert.ok(pf.warnings.some((w) => /roles\.planner/.test(w)));
  // Domyślny config: architekt xhigh 200, eksplorator Opus medium, kontrola celu medium 40.
  const e = repo();
  cli(e, 'setup');
  assert.match(readFileSync(join(e, '.claude', 'agents', 'dwmt-architect.md'), 'utf8'), /^effort: xhigh\nmaxTurns: 200$/m);
  assert.match(readFileSync(join(e, '.claude', 'agents', 'dwmt-explorer.md'), 'utf8'), /^model: opus\neffort: medium$/m);
});

// ---------- recenzja niezależna v2.7: regresje ----------

both('recenzja 1: zepsuty nagłówek planu zadania po zamrożeniu → replan z przyczyną header (nie inline, verify bez komend blokowane)', (R) => {
  const { d } = repo27();
  const run = start(d, 'hdr', R);
  writePlans(d, run);
  assert.equal(cli(d, 'state', run).json.next, 'implement');
  const f = runFile(d, run, 'brief.md', 1);
  const good = readFileSync(f, 'utf8');
  writeFileSync(f, good.replace('mode: "single"', 'mode: ["single"'));
  const st = cli(d, 'state', run).json;
  assert.deepEqual([st.next, st.agent, st.from], ['replan', 'dwmt-architect', 1], JSON.stringify(st));
  assert.match(st.causes[0], /^the header of the plan of T-1 is broken: nieczytelna/);
  assert.match(st.prompt, /Fix the header of the plan of T-1: nieczytelna/);
  const v = cli(d, 'verify', run).json;
  assert.deepEqual([v.ok, v.result], [false, 'plan'], 'verify nie biegnie zero komend na zielono');
  assert.equal(cli(d, 'replan-done', run, '1', '--result', 'changed').json.ok, false, 'nagłówek dalej zepsuty');
  writeFileSync(f, good);
  const ok = cli(d, 'replan-done', run, '1', '--result', 'changed').json;
  assert.deepEqual([ok.ok, ok.handled], [true, 1]);
  assert.equal(RUN(d, run).tasks[0].drift[0].id, 'T-1/brief.md#header');
  const next = cli(d, 'state', run).json;
  assert.deepEqual([next.next, next.agent], ['continue', 'dwmt-executor']);
});

both('recenzja 2: laterNotes z odcinka PARTIAL i z BLOCKED trafiają do raportu zadania i do kontroli rozjazdu', (R) => {
  const { d } = repo27();
  const run = start(d, 'part', R);
  writePlans(d, run);
  assert.equal(cli(d, 'state', run).json.next, 'implement');
  const noteA = '`src/billing/discount.ts#Discount`: percent is a fraction';
  const noteC = 'C-1: the label is not part of the contract yet';
  writeFileSync(runFile(d, run, 'result-1.md'), header({ schema: 'dwmt/result@1', status: 'PARTIAL', laterNotes: [noteA], evidence: ['R-1 a.test.ts › part'] }));
  assert.equal(cli(d, 'state', run).json.next, 'continue');
  const dir = join(d, '.dwmt', 'runs', run, 'tasks', '1');
  assert.ok(existsSync(join(dir, 'result-1.partial-1.md')) && !existsSync(join(dir, 'result-1.md')), 'wynik PARTIAL zarchiwizowany przed kontynuacją');
  assert.equal(cli(d, 'state', run).json.next, 'continue');
  writeFileSync(runFile(d, run, 'result-1.md'), header({ schema: 'dwmt/result@1', status: 'BLOCKED', planIssue: 'Money has no percent type', laterNotes: [noteC] }));
  assert.equal(cli(d, 'state', run).json.next, 'replan');
  assert.equal(cli(d, 'replan-done', run, '1', '--result', 'unchanged').json.unblocked, true);
  doTask(d, run, 1, 'sess-1', { files: { 'src/billing/discount.ts': 'export class Discount {}\n' }, result: { laterNotes: ['`src/shared/money.ts#Money`: rounding'] } });
  const rep = hdr(runFile(d, run, 'report.md', 1));
  assert.deepEqual(rep.laterNotes, [noteA, noteC, '`src/shared/money.ts#Money`: rounding']);
  const st = cliAs(d, 'sess-2', {}, 'state', run).json;
  assert.equal(st.next, 'replan');
  assert.deepEqual(st.causes.sort(), [`${pre(R)}T-1 note for later tasks: ${noteC}`, `${pre(R)}T-1 note for later tasks: ${noteA}`].sort(), 'uwaga z PARTIAL (ścieżka) i z BLOCKED (C-1) pasują do planu T-2');
});

test('recenzja 4, 6, 10: [new] w katalogu odrzucone; adnotacja po spacji, pliki bez rozszerzenia w HEAD, nowe pliki w katalogu głównym; [remove] usuwa plik z bazy', () => {
  const t = T1('r');
  const newIn = (loc) => t.replace('in `src/billing/discount.ts`', `in \`${loc}\``);
  assert.match(errs(newIn('src/billing/')), /\[new value object\]: podaj pełną ścieżkę pliku, nie katalog \(src\/billing\/\)/);
  assert.match(errs(newIn('src/billing')), /podaj pełną ścieżkę pliku, nie katalog \(src\/billing\)/, 'istniejący katalog bez ukośnika');
  assert.match(errs(newIn('src/billing/rules')), /nie katalog \(src\/billing\/rules\)/, 'nowa ścieżka bez rozszerzenia');
  assert.equal(errs(T1('r', { readFirst: ['docs/adr/0001-modules.md (modules)', 'src/billing/invoice.ts#invoice'] })), '', 'adnotacja po spacji odpada');
  const withMake = [...HEAD_FILES, 'Makefile'];
  assert.equal(errs(T1('r', { readFirst: ['Makefile#test'] }), 1, withMake), '', 'plik bez rozszerzenia w katalogu głównym');
  assert.match(errs(T1('r', { readFirst: ['Makefile#test'] })), /read_first: „Makefile#test” nie jest ścieżką/, 'bez pliku w HEAD to nie ścieżka');
  const root = T1('r', { scope: ['src/billing/**', 'tsconfig.billing.json', 'Dockerfile'] }).replace('- [change]', '- [new configuration] `tsconfig.billing.json` — kompilacja modułu\n- [new configuration] `Dockerfile` — obraz\n- [change]');
  assert.equal(errs(root), '', 'nowe pliki w katalogu głównym objęte scope');
  // [remove] całego pliku w T-1: T-2 nie może go już zmienić; to samo w obrębie zadania.
  const base = makeBase(HEAD_FILES);
  const t1 = T1('r').replace('- [change]', '- [remove] `src/legacy/old.ts` — martwy kod\n- [change]').replace('scope: ["src/billing/**"]', 'scope: ["src/billing/**","src/legacy/**"]');
  assert.deepEqual(taskPlanErrors({ text: t1, h: parseYaml(splitHeader(t1).yaml), k: 1, plan: planP, base }).errors, []);
  const t2 = T2('r').replace('- [change]', '- [change] `src/legacy/old.ts#old` — już usunięty\n- [change]');
  assert.match(taskPlanErrors({ text: t2, h: parseYaml(splitHeader(t2).yaml), k: 2, plan: planP, base }).errors.join('\n'), /\[change\] src\/legacy\/old\.ts nie istnieje w bazie zadania/);
  assert.match(errs(t1.replace('- [change] `src/billing/invoice.ts#invoice`', '- [change] `src/legacy/old.ts#old` — po usunięciu\n- [change] `src/billing/invoice.ts#invoice`')), /\[change\] src\/legacy\/old\.ts nie istnieje/);
});

test('recenzja 8: D-n tylko z nagłówka zaczynającego się identyfikatorem (albo wspólnego nagłówka decyzji)', () => {
  const t = T1('r').replace('### D-1 Rabat jako wartość\nReguła zakresu 0–100 należy do wartości, nie do faktury.\n', '');
  assert.match(errs(t.replace('### R-1 [high] Rabat nie przekracza sumy', '### R-1 [high] Rabat zgodny z D-1')), /brak sekcji ### D-1/, 'wzmianka w nagłówku ryzyka to nie treść decyzji');
  const shared = T1('r', { extra: { decisions: ['D-1', 'D-2'] } }).replace('### D-1 Rabat jako wartość', '### D-1 i D-2 Rabat jako wartość, bez stanu');
  assert.equal(errs(shared), '');
});

both('recenzja 7: tryb single z task.md bez importu wymaga plan.md (sam plan zadania nie przechodzi)', (R) => {
  const { d } = repo27();
  const run = start(d, 'noplan', R);
  writeFileSync(runFile(d, run, 'brief.md'), `${T1(run)}\n${UAT_NONE}`);
  const st = cli(d, 'state', run).json;
  assert.deepEqual([st.next, st.agent], ['plan', 'dwmt-architect']);
  assert.match(st.prompt, /^Write the sprint plan: .*plan\.md is missing/);
  writePlans(d, run);
  assert.equal(cli(d, 'state', run).json.next, 'implement');
});

both('recenzja 9, 12: replan-done bez fazy replan, --cause bez wartości, zepsuty plan.md; pytania w planie zadania przy replan', (R) => {
  const { d, run } = sprintAtT2({ result: { laterNotes: ['`src/billing/discount.ts#Discount`: fraction'] } }, { R });
  const done = cliAs(d, 'sess-2', {}, 'replan-done', run, '2', '--result', 'changed');
  assert.deepEqual([done.json.ok, RUN(d, run).tasks[1].drift], [false, undefined], 'przed state nie ma fazy replan: nic nie zapisano');
  assert.equal(cliAs(d, 'sess-2', {}, 'state', run).json.next, 'replan');
  const noVal = cliAs(d, 'sess-2', {}, 'replan-done', run, '2', '--result', 'changed', '--cause');
  assert.equal(noVal.code, 1);
  assert.match(noVal.json.error, /--cause wymaga wartości/);
  const planFile = runFile(d, run, 'plan.md');
  const plan = readFileSync(planFile, 'utf8');
  writeFileSync(planFile, plan.replace('tasks: ["T-1","T-2"]', 'tasks: ["T-1","T-2"').replace('tasks: ["T-1", "T-2"]', 'tasks: ["T-1", "T-2"'));
  const broken = cliAs(d, 'sess-2', {}, 'replan-done', run, '2', '--result', 'changed').json;
  assert.equal(broken.ok, false);
  assert.match(broken.errors[0], /^plan\.md: /);
  writeFileSync(planFile, plan);
  // Architekt zadaje pytanie biznesowe w planie T-2; replan-done zapisuje przyczyny, pytanie idzie do użytkownika.
  const f2 = runFile(d, run, 'brief.md', 2);
  writeFileSync(f2, `${T2(run, { extra: { questions: ['Q-1'] } })}\n## Questions\n### Q-1 Format etykiety\n- Why I ask: widoczne dla klienta\n`);
  const ok = cliAs(d, 'sess-2', {}, 'replan-done', run, '2', '--result', 'changed').json;
  assert.deepEqual([ok.ok, ok.handled, ok.questions], [true, 1, ['T-2']], JSON.stringify(ok));
  let st = cliAs(d, 'sess-2', {}, 'state', run).json;
  assert.deepEqual([st.next, st.questions], ['ask-plan', ['Q-1']]);
  assert.match(st.file, /tasks\/2\/brief\.md$/);
  assert.match(st.answers, /tasks\/2\/answers\.md$/);
  writeFileSync(join(d, '.dwmt', 'runs', run, 'tasks', '2', 'answers.md'), '### Q-1 Format etykiety\n„-10%”\n');
  st = cliAs(d, 'sess-2', {}, 'state', run).json;
  assert.equal(st.next, 'replan');
  assert.match(st.prompt, /Answers: .*tasks\/2\/answers\.md\. Record each as D-n, remove the answered ids from `questions` in the plan of T-2, then finish the replan\./);
  writeFileSync(f2, T2(run));
  assert.deepEqual(cliAs(d, 'sess-2', {}, 'replan-done', run, '2', '--result', 'changed').json.handled, 0);
  assert.equal(cliAs(d, 'sess-2', {}, 'state', run).json.next, 'implement');
});

both('rozjazd: znikająca kotwica z samego [remove] (bez read_first na ten plik)', (R) => {
  const plans = (run) => ({
    t2: T2(run, {
      changes: [
        '[new presentational component] `DiscountLine` in `src/summary/discount-line.ts` — pokazuje rabat; pattern: `src/billing/invoice.ts#invoice`',
        '[remove] `src/legacy/old.ts#old` — martwy kod',
      ],
      scope: ['src/summary/**', 'src/legacy/**'],
    }),
  });
  const { d, run } = sprintAtT2({ remove: ['src/legacy/old.ts'] }, { plans, R });
  const st = cliAs(d, 'sess-2', {}, 'state', run).json;
  assert.equal(st.next, 'replan');
  assert.deepEqual(st.causes, [`${pre(R)}src/legacy/old.ts (remove in the plan of T-2) is not on HEAD: removed, renamed or never created`]);
});

both('recenzja 12: po 3 niepoprawnych kontrolach celu finish; raport: kontrola niepoprawna, luki nieznane, uat: pending', (R) => {
  const { d, run } = sprintAtT2({}, { R });
  assert.equal(cliAs(d, 'sess-2', {}, 'state', run).json.next, 'implement');
  doTask(d, run, 2, 'sess-2', { files: { 'src/summary/discount-line.ts': 'x\n' } });
  const gcFile = runFile(d, run, 'goal-check.md');
  assert.equal(cliAs(d, 'sess-2', {}, 'state', run).json.next, 'goal-check');
  for (let i = 1; i <= 3; i++) {
    writeFileSync(gcFile, header({ schema: 'dwmt/goal-check@1', items: [{ id: `I-${i}`, element: 'x', status: 'unknown' }] }));
    const st = cliAs(d, 'sess-2', {}, 'state', run).json;
    assert.equal(st.next, i < 3 ? 'goal-check' : 'finish', `próba ${i}`);
  }
  const fin = cliAs(d, 'sess-2', {}, 'finish', run).json;
  assert.deepEqual([fin.status, fin.uat, fin.gaps], ['squashed', 'pending', undefined], JSON.stringify(fin));
  const rh = hdr(runFile(d, run, 'final-report.md'));
  assert.deepEqual([rh.goalCheck, rh.uat, rh.gaps], ['invalid', 'pending', undefined]);
  assert.match(readFileSync(runFile(d, run, 'final-report.md'), 'utf8'), /## Goal check\n- Not available, gaps unknown: `goal-check\.md` is invalid \(I-3: status unknown/);
});
