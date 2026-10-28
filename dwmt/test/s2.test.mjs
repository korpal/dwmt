import './tmp-root.mjs';
// S2 (spec dwmt v2.6 §5.9–§5.11): sprint z zadaniami, przekazanie sesji, status dla supervisora, limit, launch, env.up, UAT.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, mkdtempSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseTasks, planErrors, uatScenario, uatNone, namedSection, transcriptLimit, parseYaml, splitHeader, activeRuns } from '../scripts/dwmt.mjs';
import { SCRIPT, DWMT_HOME, repo, gitIn, header, runFile, put, asV26, asRules, UAT_NONE, fromTemplate } from './helpers.mjs';

const hdr = (f) => parseYaml(splitHeader(readFileSync(f, 'utf8')).yaml);
const RUN = (d, run) => JSON.parse(readFileSync(runFile(d, run, 'run.json'), 'utf8'));
function cliAs(d, sid, env, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: d, encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: sid, DWMT_HOME, DWMT_TRANSCRIPTS: join(d, '..', 'no-transcripts'), ...env } });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* tekst */ }
  return { code: r.status, json, out: r.stdout + r.stderr };
}
const cli = (d, ...args) => cliAs(d, 'sess-1', {}, ...args);

const PLAN = (run, extra = {}, more = '') => `${header({
  schema: 'dwmt/plan@1', run, goal: 'Sprint: pliki b i c', acceptance: ['AC-1 b.txt istnieje', 'AC-2 c.txt istnieje'], tasks: ['T-1', 'T-2'],
  scope: ['*.txt'], shared: [], decisions: ['D-1'], questions: [], ...extra,
})}# Sprint

## Decisions
### D-1 Prosto
bez udziwnień

## Contracts
### C-1 Format pliku
jedna linia tekstu

## Tasks
### T-1 Plik b
- Goal: b.txt z jedną linią
- Acceptance: AC-1
- Scope: b.txt
- Contracts: C-1

### T-2 Plik c
- Goal: c.txt obok b.txt
- Acceptance: AC-2
- Scope: c.txt
- Contracts: C-1
- Depends: T-1

## UAT
### T-1 Plik b
1. Otwórz b.txt → widać jedną linię „b”.

### T-2 Plik c
1. Otwórz c.txt → widać „c”.
${more}`;

const BRIEF = (run, goal, acceptance, extra = {}, body = '') => `${header({
  schema: 'dwmt/brief@1', run, goal, mode: 'single', acceptance, scope: ['*.txt'], verify: ['node -e 0'], decisions: [], risks: ['R-1'], questions: [], ...extra,
})}# ${goal}

## Risks
### R-1 [low] Plik czytelny w edytorze
- Method: human otwórz plik w Notatniku i sprawdź kodowanie
- Area: txt
${body}`;

const REVIEW = (acceptance, extra = {}) => ({ schema: 'dwmt/review@1', round: 1, passes: ['correctness'], verdict: 'PASS', fix: [], acceptance, risks: ['R-1 human'], ...extra });

// kt (D-16): without cfg the repo is a copy of one per-process build.
function setupRepo(cfg) {
  if (cfg === undefined) { const d = fromTemplate('setupRepo', () => buildSetupRepo({}).d); return { d, g: gitIn(d) }; }
  return buildSetupRepo(cfg);
}
function buildSetupRepo(cfg) {
  const d = repo();
  const g = gitIn(d);
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude', 'dwmt.json'), JSON.stringify({ verify: { full: ['node -e 0'] }, git: { target: 'master' }, uat: { start: ['npm run dev'], notes: ['reset bazy przy błędzie Flyway'] }, run: { priceGate: false }, ...cfg }));
  assert.equal(cli(d, 'setup').code, 0);
  g('add', '-A');
  g('commit', '-q', '-m', 'dwmt setup');
  return { d, g };
}

function worktree(main, branch = 'sprint') {
  const wt = join(main, '..', `${main.split(/[\\/]/).pop()}-${branch}`);
  gitIn(main)('worktree', 'add', '-q', '-b', branch, wt);
  return wt;
}

test('plan: zadania, walidacja pokrycia AC i UAT, pytania sprawdzane osobno, scenariusz „none”', () => {
  const text = PLAN('r');
  const tasks = parseTasks(text);
  assert.deepEqual(tasks.map((t) => [t.id, t.title, t.ac, t.contracts]), [['T-1', 'Plik b', ['AC-1'], ['C-1']], ['T-2', 'Plik c', ['AC-2'], ['C-1']]]);
  const h = hdr0(text);
  assert.deepEqual(planErrors(text, h), []);
  assert.match(uatScenario(text), /^### T-1 Plik b\n1\. Otwórz b\.txt/);
  const broken = text.replace('- Acceptance: AC-2\n', '').replace('## UAT', '## Notes');
  const e = planErrors(broken, h);
  assert.ok(e.some((x) => /T-2: brak linii Acceptance/.test(x)), e.join('\n'));
  assert.ok(e.some((x) => /AC-2 nie ma zadania/.test(x)));
  assert.ok(e.some((x) => /brak sekcji ## UAT/.test(x)));
  assert.deepEqual(planErrors(text, { ...h, tasks: ['T-1', 'T-3'] }).filter((x) => /T-3/.test(x)).length, 2, 'numeracja po kolei i sekcja');
  assert.deepEqual(planErrors(broken, { ...h, questions: ['Q-1'] }), ['brak sekcji Q-1'], 'przy otwartych pytaniach tylko ich sekcje');
  assert.ok(uatNone('UAT: none.') && uatNone('- brak') && !uatNone('1. Otwórz'));
  assert.equal(namedSection('### Q-1 Czy UAT?\nx\n## UAT\ny\n## Q\n', 'UAT'), '## UAT\ny', 'dokładny tytuł, nie słowo w innym nagłówku');
});
const hdr0 = (text) => parseYaml(splitHeader(text).yaml);

// Przebieg v2.6 (bez `rules`): architekt pod kluczami planistów, prompty z dopiskiem; odpowiednik 2.7 w d3.test.mjs.
const V26 = 'v2\\.6 run: write only what this prompt names\\. ';
test('sprint v2.6 z dwoma zadaniami: architekt jako planista sprintu, pytania, brief 1, commit z raportem, handoff, architekt jako planista zadania 2, jeden finish', () => {
  const { d, g } = setupRepo();
  const run = cli(d, 'preflight', '--slug', 'sprint').json.run;
  const init = cli(d, 'init', '--run', run, '--mode', 'single').json;
  assert.equal(init.kind, 'text');
  assert.match(init.brief, /tasks\/1\/brief\.md$/);
  asV26(d, run);
  writeFileSync(runFile(d, run, 'task.md'), 'Pliki b i c\n');

  let st = cli(d, 'state', run).json;
  assert.equal(st.next, 'plan');
  assert.equal(st.key, 'planner');
  assert.equal(st.agent, 'dwmt-architect');
  assert.match(st.prompt, new RegExp(`^${V26}Plan the sprint: explore breadth-first, ask all the sprint's questions at once before planning in depth`));
  assert.match(st.output, /plan\.md$/);

  // Pytania sprintu w planie, odpowiedzi w answers.md przebiegu, potem ten sam planista.
  writeFileSync(runFile(d, run, 'plan.md'), PLAN(run, { questions: ['Q-1'] }, '\n## Questions\n### Q-1 Kodowanie\n- Rule or goal: czytelność\n'));
  st = cli(d, 'state', run).json;
  assert.equal(st.next, 'ask-plan');
  assert.match(st.file, /plan\.md$/);
  assert.match(st.answers, new RegExp(`${run}/answers\\.md$`));
  writeFileSync(runFile(d, run, 'answers.md'), '### Q-1 Kodowanie\nUTF-8\n');
  st = cli(d, 'state', run).json;
  assert.equal(st.next, 'plan');
  assert.equal(st.key, 'planner');
  assert.match(st.prompt, new RegExp(`^${V26}Answers: .*answers\\.md\\. Record each as D-n.* and finish the plan, then write the brief of task 1\\.`));

  writeFileSync(runFile(d, run, 'plan.md'), PLAN(run).replace('## UAT', '## Uwagi'));
  assert.match(cli(d, 'state', run).json.prompt, new RegExp(`^${V26}Fix the plan: brak sekcji ## UAT`));
  writeFileSync(runFile(d, run, 'plan.md'), PLAN(run));
  st = cli(d, 'state', run).json;
  assert.match(st.prompt, new RegExp(`^${V26}The plan is complete: write the brief of task 1\\.`));
  assert.match(st.output, /tasks\/1\/brief\.md$/);

  writeFileSync(runFile(d, run, 'brief.md'), BRIEF(run, 'Plik b', ['AC-3 inne']));
  assert.match(cli(d, 'state', run).json.prompt, new RegExp(`^${V26}Fix the brief of task 1: brief T-1: brak AC-1`));
  writeFileSync(runFile(d, run, 'brief.md'), BRIEF(run, 'Plik b', ['AC-1 b.txt istnieje']));
  st = cli(d, 'state', run).json;
  assert.equal(st.next, 'implement');
  assert.deepEqual([st.task, st.tasks], [1, 2]);
  assert.match(st.prompt, /tasks\/1\/brief\.md/);

  writeFileSync(join(d, 'b.txt'), 'b\n');
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'DONE', assumptions: ['A-1 LF'], changedContracts: ['C-1 bez zmian'] });
  assert.equal(cli(d, 'verify', run).json.result, 'pass');
  cli(d, 'review-input', run);
  const input = readFileSync(runFile(d, run, 'review-input.md'), 'utf8');
  assert.match(input, /## Sprint\n\nThis change is task 1 of 2 \(T-1 Plik b\)/);
  assert.match(input, /- T-2 Plik c: c\.txt obok b\.txt/);
  assert.match(input, /### C-1 Format pliku\njedna linia tekstu/);
  put(d, run, 'review-1.md', REVIEW(['AC-1 met']));
  const c1 = cli(d, 'commit', run).json;
  assert.equal(c1.next, 'handoff');
  assert.deepEqual([c1.task, c1.tasks], [1, 2]);
  assert.match(g('log', '-1', '--format=%B'), /^T-1 Plik b\n\n- AC-1 b\.txt istnieje\n\ndwmt-run: .* T-1/);
  const rep1 = hdr(runFile(d, run, 'report.md', 1));
  assert.equal(rep1.schema, 'dwmt/task-report@1');
  assert.deepEqual([rep1.task, rep1.status, rep1.acceptance], ['T-1', 'PASS', ['AC-1 met']]);
  assert.deepEqual(rep1.changedContracts, ['C-1 bez zmian']);

  // Ta sama sesja kończy; każda inna prowadzi zadanie 2 (planista zadania, świeży agent).
  st = cli(d, 'state', run).json;
  assert.equal(st.next, 'handoff');
  assert.equal(st.task, 1);
  st = cliAs(d, 'sess-2', {}, 'state', run).json;
  assert.equal(st.next, 'plan');
  assert.equal(st.key, 'planner-T2');
  assert.equal(st.agent, 'dwmt-architect');
  assert.match(st.prompt, new RegExp(`^${V26}Plan task 2 \\(T-2\\): read the plan, answers and earlier task reports, then the current code of its scope, not the docs`));
  assert.match(st.prompt, /Reports: .*tasks\/1\/report\.md\. Brief: .*tasks\/2\/brief\.md\./);
  assert.equal(RUN(d, run).handoff, null, 'inna sesja zdejmuje przekazanie');
  assert.equal(cli(d, 'state', run).json.next, 'plan', 'bez przekazania także sesja 1 prowadzi zadanie 2');

  writeFileSync(runFile(d, run, 'brief.md', 2), BRIEF(run, 'Plik c', ['AC-2 c.txt istnieje'], { questions: ['Q-2'] }, '\n## Questions\n### Q-2 Nazwa\nx\n'));
  st = cliAs(d, 'sess-2', {}, 'state', run).json;
  assert.equal(st.next, 'ask-plan');
  assert.match(st.answers, /tasks\/2\/answers\.md$/);
  writeFileSync(runFile(d, run, 'brief.md', 2), BRIEF(run, 'Plik c', ['AC-2 c.txt istnieje']));
  st = cliAs(d, 'sess-2', {}, 'state', run).json;
  assert.equal(st.next, 'implement');
  assert.deepEqual([st.task, st.tasks], [2, 2]);

  writeFileSync(join(d, 'c.txt'), 'c\n');
  writeFileSync(runFile(d, run, 'result-1.md', 2), header({ schema: 'dwmt/result@1', status: 'DONE' }));
  cliAs(d, 'sess-2', {}, 'verify', run);
  cliAs(d, 'sess-2', {}, 'review-input', run);
  const patch2 = readFileSync(runFile(d, run, 'diff.patch', 2), 'utf8');
  assert.match(patch2, /c\.txt/);
  assert.doesNotMatch(patch2, /b\.txt/, 'punkt odniesienia zadania 2 to commit zadania 1');
  assert.doesNotMatch(readFileSync(runFile(d, run, 'review-input.md', 2), 'utf8'), /Later tasks/, 'ostatnie zadanie nie ma późniejszych');
  writeFileSync(runFile(d, run, 'review-1.md', 2), header(REVIEW(['AC-2 met'])));
  const c2 = cliAs(d, 'sess-2', {}, 'commit', run).json;
  assert.equal(c2.next, undefined, 'ostatnie zadanie nie przekazuje sesji');
  assert.equal(cliAs(d, 'sess-2', {}, 'state', run).json.next, 'finish');

  const before = Number(g('rev-list', '--count', 'master'));
  const fin = cliAs(d, 'sess-2', {}, 'finish', run).json;
  assert.equal(fin.status, 'squashed', JSON.stringify(fin));
  assert.equal(Number(g('rev-list', '--count', 'master')), before + 1, 'jeden squash na sprint');
  assert.match(g('log', '-1', '--format=%B', 'master'), /^Sprint: pliki b i c\n\n- AC-1 b\.txt istnieje\n- AC-2 c\.txt istnieje/);
  const report = readFileSync(runFile(d, run, 'final-report.md'), 'utf8');
  const rh = hdr(runFile(d, run, 'final-report.md'));
  assert.equal(rh.status, 'PASS');
  assert.equal(rh.tasks.length, 2);
  assert.match(rh.tasks[0], /^T-1 PASS r1 [0-9a-f]{7} Plik b$/);
  assert.deepEqual(rh.acceptance, ['AC-1 met', 'AC-2 met']);
  assert.deepEqual(rh.coverage, ['AC-1 met (T-1)', 'AC-2 met (T-2)'], 'jedno zadanie: sam numer, bez powtórzenia statusu');
  assert.equal(rh.uat, 'pending');
  assert.deepEqual(rh.risks, ['T-1/R-1 human', 'T-2/R-1 human']);
  assert.deepEqual(rh.assumptions, ['T-1/A-1 LF']);
  assert.match(report, /## Tasks\n\n\| Task \| Status \| Rounds \| Replan \| Commit \| Report \|/);
  assert.equal(rh.gaps, undefined, 'v2.6: bez kontroli celu');
  // v2.10: po statusie zdanie „czego potrzeba od Ciebie” (zmiana zamierzona, zasada komunikatów dla człowieka).
  assert.match(report, /## UAT\n\nStatus: pending\. [^\n]*Needed from you: [^\n]*\n\n### Start the app\n\n- `npm run dev`\n- reset bazy przy błędzie Flyway/);
  assert.match(report, /### Scenario\n\n### T-1 Plik b\n1\. Otwórz b\.txt/);
  assert.match(report, /### Steps for you 🧑\n\n- T-1\/R-1 Plik czytelny w edytorze: otwórz plik w Notatniku/);
  assert.match(report, new RegExp(`/dwmt:uat ${run}`));
  const uatSec = cli(d, 'section', runFile(d, run, 'final-report.md'), 'UAT').out;
  assert.match(uatSec, /^## UAT[\s\S]*### How to report/, 'section po tytule');
});

test('raport: AC bez dowodu to luka (ACCEPTED), brief bez planu wymaga ## UAT, UAT: none daje n/a', () => {
  const { d } = setupRepo();
  const run = cli(d, 'preflight', '--slug', 'jedno').json.run;
  cli(d, 'init', '--run', run, '--mode', 'single');
  // v2.6: brief bez planu sprintu (w v2.7 tryb single z task.md wymaga plan.md, d3.test.mjs).
  asV26(d, run);
  writeFileSync(runFile(d, run, 'task.md'), 'x\n');
  writeFileSync(runFile(d, run, 'brief.md'), BRIEF(run, 'Plik b', ['AC-1 b.txt istnieje', 'AC-2 treść']));
  assert.match(cli(d, 'state', run).json.prompt, new RegExp(`^${V26}Fix the brief of task 1: brak sekcji ## UAT`));
  writeFileSync(runFile(d, run, 'brief.md'), BRIEF(run, 'Plik b', ['AC-1 b.txt istnieje', 'AC-2 treść'], {}, `\n${UAT_NONE}`));
  assert.equal(cli(d, 'state', run).json.next, 'implement');
  writeFileSync(join(d, 'b.txt'), 'b\n');
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'DONE' });
  cli(d, 'verify', run);
  cli(d, 'review-input', run);
  assert.doesNotMatch(readFileSync(runFile(d, run, 'review-input.md'), 'utf8'), /## Sprint/, 'jedno zadanie bez sekcji sprintu');
  put(d, run, 'review-1.md', REVIEW(['AC-1 met']));
  const c = cli(d, 'commit', run).json;
  assert.equal(c.next, undefined);
  const fin = cli(d, 'finish', run).json;
  assert.equal(fin.status, 'squashed');
  assert.equal(fin.result, 'ACCEPTED');
  const rh = hdr(runFile(d, run, 'final-report.md'));
  assert.equal(rh.status, 'ACCEPTED', 'AC-2 bez rozstrzygnięcia');
  assert.deepEqual(rh.acceptance, ['AC-1 met', 'AC-2 unverified']);
  assert.equal(rh.uat, 'n/a');
  assert.deepEqual(rh.tasks.map((t) => t.split(' ').slice(0, 3).join(' ')), ['T-1 PASS r1']);
});

test('supervisor v2.6: wejście --sprint, status, Affects, planned, dogonienie celu i odświeżenie briefu, dwa sprinty', () => {
  const { d: main, g } = setupRepo();
  mkdirSync(join(main, '.dwmt', 'supervisor', 'input'), { recursive: true });
  writeFileSync(join(main, '.dwmt', 'supervisor', 'input', 'S1.md'), `${header({ schema: 'dwmt/sprint-input@1', sprint: 'S1', order: ['S0', 'S1', 'S2'], after: ['S0'], uatGate: true })}Wiersz roadmapy: pliki b i c\n`);
  const wt = worktree(main);
  const run = cli(wt, 'preflight', '--slug', 's1').json.run;
  const init = cli(wt, 'init', '--run', run, '--mode', 'single', '--sprint', 'S1').json;
  assert.equal(init.kind, 'sprint', JSON.stringify(init));
  asV26(wt, run);
  assert.equal(readFileSync(runFile(wt, run, 'task.md'), 'utf8'), 'Wiersz roadmapy: pliki b i c\n');
  const statusFile = join(main, '.dwmt', 'supervisor', 'status', 'S1.json');
  const status = () => JSON.parse(readFileSync(statusFile, 'utf8'));
  assert.equal(status().state, 'planning');

  let st = cli(wt, 'state', run).json;
  assert.equal(st.sprint, 'S1');
  assert.match(st.prompt, /Sprints of the order: S0, S1, S2: give each question an `Affects` line/);
  writeFileSync(runFile(wt, run, 'plan.md'), PLAN(run, { questions: ['Q-1'], second: 'Drugi sprint: eksport plików.' }, '\n## Questions\n### Q-1 Kodowanie plików\n- Rule or goal: r\n- Affects: S2\n'));
  st = cli(wt, 'state', run).json;
  assert.equal(st.next, 'ask-plan');
  assert.equal(st.second, undefined, 'dwa sprinty zgłaszane dopiero po pytaniach');
  let s = status();
  assert.deepEqual([s.state, s.questions, s.affects, s.stage], ['waiting-user', ['Q-1 Kodowanie plików'], ['S2'], 'planning']);
  assert.deepEqual(s.scope, ['*.txt']);

  writeFileSync(runFile(wt, run, 'plan.md'), PLAN(run, { second: 'Drugi sprint: eksport plików.' }));
  st = cli(wt, 'state', run).json;
  assert.equal(st.second, 'Drugi sprint: eksport plików.');
  assert.ok(existsSync(join(main, '.dwmt', 'runs', run, 'plan.md')), 'plan w głównym drzewie');
  assert.equal(cli(wt, 'state', run).json.second, undefined, 'raz');
  s = status();
  assert.deepEqual(s.events.map((e) => [e.seq, e.type]), [[1, 'two-sprints']]);
  assert.match(s.events[0].plan, new RegExp(`/.dwmt/runs/${run}/plan\\.md$`));

  writeFileSync(runFile(wt, run, 'brief.md'), BRIEF(run, 'Plik b', ['AC-1 b.txt istnieje'], { scope: ['b.txt'] }));
  st = cli(wt, 'state', run).json;
  assert.equal(st.next, 'planned');
  assert.deepEqual(st.waitingFor, ['S0']);
  assert.equal(status().state, 'planned');
  assert.equal(status().events.length, 1, 'zdarzenia zostają po zmianie stanu');

  // S0 scalony: cel zmienił b.txt (zakres zadania 1) → gałąź bez commitów dogania cel, brief do odświeżenia.
  writeFileSync(join(main, 'b.txt'), 'z S0\n');
  g('add', 'b.txt');
  g('commit', '-q', '-m', 'S0');
  writeFileSync(join(main, '.dwmt', 'supervisor', 'status', 'S0.json'), JSON.stringify({ sprint: 'S0', state: 'done' }));
  const briefFile = runFile(wt, run, 'brief.md');
  utimesSync(briefFile, new Date(Date.now() - 60e3), new Date(Date.now() - 60e3));
  st = cli(wt, 'state', run).json;
  assert.equal(st.next, 'plan');
  assert.equal(st.key, 'planner-T1');
  assert.equal(st.agent, 'dwmt-architect');
  assert.match(st.prompt, new RegExp(`^${V26}Refresh the brief of task 1: since planning, the target branch changed files in its scope: b\\.txt\\.`));
  assert.ok(existsSync(join(wt, 'b.txt')), 'gałąź sprintu przesunięta na cel');
  assert.equal(RUN(wt, run).tasks[0].baseline, g('rev-parse', 'master'));
  writeFileSync(briefFile, readFileSync(briefFile, 'utf8'));
  st = cli(wt, 'state', run).json;
  assert.equal(st.next, 'implement');
  assert.deepEqual([status().state, status().step], ['running', 'implement']);
  assert.equal(cli(wt, 'status', run, 'stopped', '--reason', 'użytkownik').json.ok, true);
  assert.deepEqual([status().state, status().reason], ['stopped', 'użytkownik']);
});

test('limit abonamentu: wynik agenta z tekstem limitu zostawia krok do powtórzenia; transcriptLimit', () => {
  const { d } = setupRepo();
  const run = cli(d, 'preflight', '--slug', 'lim').json.run;
  cli(d, 'init', '--run', run, '--mode', 'single');
  writeFileSync(runFile(d, run, 'brief.md'), BRIEF(run, 'Plik b', ['AC-1 b'], {}, `\n${UAT_NONE}`));
  const tr = mkdtempSync(join(tmpdir(), 'dwmt-tr-'));
  const env = { DWMT_TRANSCRIPTS: tr };
  assert.equal(cliAs(d, 'sess-L', env, 'state', run).json.next, 'implement');
  const subs = join(tr, 'proj', 'sess-L', 'subagents');
  mkdirSync(subs, { recursive: true });
  const future = Math.floor(Date.now() / 1000) + 3600;
  const line = (o) => `${JSON.stringify(o)}\n`;
  writeFileSync(join(subs, 'agent-a1.jsonl'), line({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } })
    + line({ type: 'assistant', error: 'rate_limit', quotaLimits: { status: 'rejected', resetsAt: future, rateLimitType: 'five_hour' }, message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit" }] } }));
  const st = cliAs(d, 'sess-L', env, 'state', run).json;
  assert.equal(st.next, 'continue', 'krok bez zmian (wykonawca bez wyniku)');
  assert.deepEqual(st.limit, { resetsAt: new Date(future * 1000).toISOString(), type: 'five_hour' });
  assert.equal(cliAs(d, 'sess-other', env, 'state', run).json.limit, undefined, 'tylko agenci tej sesji');
  assert.equal(transcriptLimit(join(subs, 'agent-a1.jsonl'), (future + 1) * 1000), null, 'po odnowieniu limit nie obowiązuje');
});

test('launch: claude --bg bez shella, prompt przed --settings, izolacja none, tryb uprawnień; id do handoff', () => {
  const { d } = setupRepo({ launch: { permissionMode: 'acceptEdits' } });
  const run = cli(d, 'preflight', '--slug', 'l').json.run;
  cli(d, 'init', '--run', run);
  const fake = join(d, '..', `${run}-claude.mjs`);
  const argsOut = join(d, '..', `${run}-args.json`);
  writeFileSync(fake, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(argsOut)}, JSON.stringify(process.argv.slice(2)));\nwriteFileSync(${JSON.stringify(`${argsOut}.run`)}, process.env.DWMT_RUN ?? '');\nconsole.log('backgrounded · \x1b[36m7f3a9c\x1b[39m · ' + process.argv[4]);\n`);
  const rj = RUN(d, run);
  rj.handoff = { task: 1, session: 'sess-1' };
  writeFileSync(runFile(d, run, 'run.json'), JSON.stringify(rj));
  // v2.9 (launch.lean): wtyczki z ustawień użytkownika i projektu poza dwmt wyłączone, bez serwerów MCP.
  const home = mkdtempSync(join(tmpdir(), 'dwmt-ch-'));
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ enabledPlugins: { 'other@market': true, 'dwmt@local': true, 'off@market': false } }));
  const r = cliAs(d, 'sess-1', { DWMT_CLAUDE: fake, DWMT_CLAUDE_HOME: home }, 'launch', run).json;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.attach, 'claude attach 7f3a9c');
  const args = JSON.parse(readFileSync(argsOut, 'utf8'));
  // v2.10: nazwa czytelna na telefonie `dwmt <przebieg bez daty> · T-k[/N]` (zmiana zamierzona).
  assert.deepEqual(args.slice(0, 3), ['--bg', '-n', `dwmt ${run.replace(/^\d{4}-\d{2}-\d{2}-/, '')} · T-1`]);
  assert.deepEqual(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2), ['--permission-mode', 'acceptEdits']);
  assert.equal(args[args.indexOf('--settings') - 1], `/dwmt:execute ${run}`, 'prompt przed --settings');
  // T-4 (R-3): znacznik przebiegu DWMT_RUN dla strażnika w env `--settings`.
  assert.deepEqual(JSON.parse(args.at(-1)), { worktree: { bgIsolation: 'none' }, env: { CLAUDE_CODE_DISABLE_NOTIFICATION_PRESENCE_CHECK: '1', CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP: '1', DWMT_RUN: run }, enabledPlugins: { 'other@market': false } });
  assert.equal(readFileSync(`${argsOut}.run`, 'utf8'), run, 'DWMT_RUN także w środowisku procesu');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(RUN(d, run).handoff.launched.id, '7f3a9c');
  assert.deepEqual(RUN(d, run).launches.map((x) => x.id), ['7f3a9c'], 'zapis po ponownym odczycie run.json');
});

test('env.up: niegotowe środowisko uruchamiane raz, potem verify; bez up zostaje pytanie', () => {
  const probe = mkdtempSync(join(tmpdir(), 'dwmt-up-'));
  const mark = join(probe, 'up').replace(/\\/g, '/');
  const check = `node -e "process.exit(require('fs').existsSync('${mark}')?0:1)"`;
  const up = `node -e "require('fs').writeFileSync('${mark}','')"`;
  const { d } = setupRepo({ env: { checks: [{ cmd: check, hint: 'compose', up }] } });
  const run = cli(d, 'preflight', '--slug', 'up').json.run;
  cli(d, 'init', '--run', run);
  writeFileSync(runFile(d, run, 'brief.md'), BRIEF(run, 'Plik b', ['AC-1 b'], { mode: 'inline' }, `\n${UAT_NONE}`));
  const v = cli(d, 'verify', run).json;
  assert.equal(v.result, 'pass', JSON.stringify(v));
  assert.deepEqual(v.envUp, [`0 ${up}`]);
  const f = join(d, '.claude', 'dwmt.json');
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), env: { checks: [{ cmd: 'node -e "process.exit(1)"', hint: 'compose', up: 'node -e 0' }] } }));
  const v2 = cli(d, 'verify', run).json;
  assert.equal(v2.result, 'env', 'up nie pomógł: pytanie do użytkownika');
  assert.deepEqual(v2.envUp, ['0 node -e 0']);
});

// Sprint w worktree scalony do głównego drzewa (kopia przebiegu w main/.dwmt/runs).
function sprintDone(main, branch, file, extraCfg = null) {
  const wt = worktree(main, branch);
  const run = cli(wt, 'preflight', '--slug', branch).json.run;
  cli(wt, 'init', '--run', run, '--mode', 'single');
  // K5 (D-6): a 2.11 fixture; its UAT step has no (R-n)/(AC-n) reference, which rules 2.12 refuse.
  asRules(wt, run, '2.11');
  writeFileSync(runFile(wt, run, 'task.md'), `${branch}\n`);
  writeFileSync(runFile(wt, run, 'brief.md'), BRIEF(run, `Plik ${file}`, ['AC-1 plik'], { mode: 'inline' }, '\n## UAT\n1. Otwórz plik → widać treść.\n'));
  writeFileSync(join(wt, file), `${file}\n`);
  cli(wt, 'verify', run);
  cli(wt, 'review-input', run);
  put(wt, run, 'review-1.md', REVIEW(['AC-1 met']));
  cli(wt, 'commit', run);
  return { wt, run, extraCfg };
}

test('UAT: lista, wstrzymanie scaleń (merge-wait uat), zapis z klasą, zdarzenie, zwolnienie, sprint poprawek, uat-summary', () => {
  const { d: main, g } = setupRepo();
  mkdirSync(join(main, '.dwmt', 'supervisor'), { recursive: true });
  const a = sprintDone(main, 'spa', 'a1.txt');
  assert.equal(cli(a.wt, 'finish', a.run).json.status, 'squashed');
  const list = cli(main, 'uat').json;
  assert.equal(list.waiting.length, 1);
  assert.match(list.waiting[0], new RegExp(`^${a.run}: od `));

  assert.match(cli(main, 'uat', 'start', 'nieznany').json.error, /brak sprintu nieznany/);
  const s = cli(main, 'uat', 'start', a.run).json;
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.match(s.reports[0], /final-report\.md$/);

  // Drugi sprint w trakcie UAT: rebase i suita, ale bez squasha; blokada scalania zwolniona.
  const b = sprintDone(main, 'spb', 'b1.txt');
  const before = g('rev-parse', 'master');
  const w = cli(b.wt, 'finish', b.run).json;
  assert.equal(w.status, 'merge-wait', JSON.stringify(w));
  assert.equal(w.reason, 'uat');
  assert.equal(g('rev-parse', 'master'), before, 'squash nie wszedł');
  assert.match(cli(main, 'uat', 'list').json.mergeWait[0], /uat od/);
  assert.equal(hdr0(readFileSync(join(main, '.dwmt', 'runs', b.run, 'final-report.md'), 'utf8')).uat, 'pending');
  assert.deepEqual(activeRuns(main), [], 'kopia przebiegu w głównym drzewie nie jest aktywnym przebiegiem (hook SessionStart)');
  assert.deepEqual(activeRuns(b.wt).map((r) => r.next), ['finish'], 'w worktree przebieg czeka na finish');

  const res = join(main, '..', 'uat-result.json');
  writeFileSync(res, JSON.stringify({ result: 'defects', findings: [
    { text: 'Zapis a1 gubi polskie znaki', place: 'a1.txt', weight: 'major', kind: 'bug', class: 'test' },
    { text: 'Chcę też a2', place: '-', weight: 'minor', kind: 'requirement' },
  ], deferredAccepted: ['F-3'] }));
  assert.match(cli(main, 'uat', 'record', a.run, res).json.error ?? '', /^$/);
  const uatFile = join(main, '.dwmt', 'runs', a.run, 'uat.md');
  const u = hdr(uatFile);
  assert.deepEqual(u.defects.map((x) => [x.id, x.weight, x.kind, x.class, x.fix]), [['U-1', 'major', 'bug', 'test', null], ['U-2', 'minor', 'requirement', null, null]]);
  assert.equal(u.entries[0].kind, 'uat');
  assert.match(readFileSync(uatFile, 'utf8'), /### U-1 \[major\] bug, test: Zapis a1 gubi polskie znaki\n- Place: a1\.txt/);
  const ev = JSON.parse(readFileSync(join(main, '.dwmt', 'supervisor', 'status', `${a.run}.uat.json`), 'utf8'));
  assert.deepEqual([ev.events[0].seq, ev.events[0].counts, ev.events[0].byClass, ev.events[0].requirementChanges], [1, { major: 1 }, { test: 1 }, 1]);
  assert.deepEqual(ev.events[0].fixSprint.defects, ['U-1']);
  assert.equal(cli(main, 'uat').json.waiting.length, 0, 'po wyniku sprint nie czeka na UAT');

  // Wstrzymanie zwolnione: sprint w merge-wait wchodzi przy ponownym finish bez pełnej suity.
  assert.equal(cli(b.wt, 'finish', b.run).json.status, 'squashed');

  // Sprint poprawek z uat.md: task.md z defektem, przypisanie fix, source w przebiegu i raporcie.
  const c = worktree(main, 'fix');
  const run3 = cli(c, 'preflight', '--slug', 'fix').json.run;
  const i3 = cli(c, 'init', '--run', run3, '--mode', 'inline', '--input', uatFile).json;
  assert.equal(i3.kind, 'uat', JSON.stringify(i3));
  assert.deepEqual(i3.defects, ['U-1']);
  assert.match(readFileSync(runFile(c, run3, 'task.md'), 'utf8'), /### U-1 \[major\] bug, test: Zapis a1 gubi polskie znaki/);
  assert.equal(hdr(uatFile).defects[0].fix, run3);
  assert.equal(RUN(c, run3).source.run, a.run);
  assert.match(cli(c, 'init', '--run', `${run3}-2`, '--input', uatFile).json.error, /brak otwartych defektów/);
  asRules(c, run3, '2.11'); // K5 (D-6): 2.11 fixture (its UAT step names no human risk)
  writeFileSync(runFile(c, run3, 'brief.md'), BRIEF(run3, 'Poprawka a1', ['AC-1 znaki'], { mode: 'inline', risks: ['R-1'] }, '\n## UAT\n1. U-1: zapisz a1 → znaki zostają.\n').replace('### R-1 [low] Plik czytelny w edytorze\n- Method: human otwórz plik w Notatniku i sprawdź kodowanie', '### R-1 [high] U-1 zapis zachowuje polskie znaki\n- Method: test'));
  writeFileSync(join(c, 'a1.txt'), 'ąę\n');
  put(c, run3, 'result-1.md', { schema: 'dwmt/result@1', status: 'DONE', evidence: ['R-1 test/a1.test.mjs › znaki'] });
  cli(c, 'verify', run3);
  cli(c, 'review-input', run3);
  put(c, run3, 'review-1.md', REVIEW(['AC-1 met'], { risks: ['R-1 proven'] }));
  cli(c, 'commit', run3);
  assert.equal(cli(c, 'finish', run3).json.status, 'squashed');
  const r3 = hdr(runFile(c, run3, 'final-report.md'));
  assert.equal(r3.source, `${a.run} U-1`);
  assert.deepEqual(r3.ratchet, ['U-1 R-1: R-1 test/a1.test.mjs › znaki']);

  const sum = cli(main, 'uat-summary').json;
  assert.equal(sum.ok, true, JSON.stringify(sum));
  const row = sum.rows.find((x) => x.startsWith(`${a.run}:`));
  assert.match(row, /UAT defects \d{4}-\d{2}-\d{2}, missed 0\/1\/0 \(test 1\), late 0/);
  assert.match(readFileSync(sum.file, 'utf8'), /\| Sprint \| Cost \| UAT \| Missed b\/M\/m/);

  // Zgłoszenie późniejsze: bez wstrzymania, wpis late liczony osobno.
  const lateRes = join(main, '..', 'uat-late.json');
  writeFileSync(lateRes, JSON.stringify({ result: 'defects', findings: [{ text: 'Pusty a1 po restarcie', weight: 'minor', kind: 'bug', class: 'plan' }] }));
  assert.match(cli(main, 'uat', 'record', b.run, lateRes).json.error, /brak wstrzymania/);
  const late = cli(main, 'uat', 'record', b.run, lateRes, '--late').json;
  assert.equal(late.ok, true, JSON.stringify(late));
  assert.match(cli(main, 'uat-summary').json.rows.find((x) => x.startsWith(`${b.run}:`)), /missed 0\/0\/0 \(-\), late 1/);
});

test('recenzja S2: przyjęta czerwień przeżywa merge-wait; ponowny finish bez suity i bez czerwieni', () => {
  const tag = `red-${Date.now()}`;
  const mark = join(tmpdir(), tag).replace(/\\/g, '/');
  const { d: main, g } = setupRepo({ verify: { full: [`node -e "process.exit(require('fs').existsSync('${mark}')?1:0)"`] } });
  const s = sprintDone(main, 'acc', 'x1.txt');
  writeFileSync(mark, '1');
  assert.equal(cli(s.wt, 'finish', s.run).json.status, 'red');
  writeFileSync(join(main, 'a.txt'), 'brud\n');
  const w = cli(s.wt, 'finish', s.run, '--accept-red').json;
  assert.equal(w.status, 'merge-wait', JSON.stringify(w));
  g('checkout', '--', 'a.txt');
  const fin = cli(s.wt, 'finish', s.run).json;
  assert.equal(fin.status, 'squashed', JSON.stringify(fin));
  assert.equal(fin.reused, true);
  assert.deepEqual(hdr(runFile(s.wt, s.run, 'final-report.md')).tests.acceptedRed.length, 1);
});

test('recenzja S2 (v2.6): git.rebase review z dwoma zadaniami: commit roboczy staje się commitem zadania, baseline T-2 po stopce', () => {
  const { d: main, g } = setupRepo({ git: { target: 'master', rebase: 'review' } });
  const wt = worktree(main, 'rr');
  const run = cli(wt, 'preflight', '--slug', 'rr').json.run;
  cli(wt, 'init', '--run', run, '--mode', 'single');
  asV26(wt, run);
  writeFileSync(runFile(wt, run, 'task.md'), 'x\n');
  writeFileSync(runFile(wt, run, 'plan.md'), PLAN(run));
  writeFileSync(runFile(wt, run, 'brief.md'), BRIEF(run, 'Plik b', ['AC-1 b']));
  assert.equal(cli(wt, 'state', run).json.next, 'implement');
  writeFileSync(join(wt, 'b.txt'), 'b\n');
  put(wt, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'DONE' });
  assert.equal(cli(wt, 'verify', run).json.ok, true);
  cli(wt, 'review-input', run);
  put(wt, run, 'review-1.md', REVIEW(['AC-1 met']));
  const c1 = cli(wt, 'commit', run).json;
  assert.equal(c1.empty, true);
  const gw = gitIn(wt);
  assert.match(gw('log', '-1', '--format=%B'), /^T-1 Plik b[\s\S]*dwmt-run: .* T-1/, 'commit roboczy z opisem i stopką zadania');
  assert.equal(gw('rev-list', '--count', 'master..HEAD'), '1');
  // Cel idzie dalej między zadaniami; rebase przed recenzją T-2 przepisuje T-1, a baseline to nowy commit T-1.
  writeFileSync(join(main, 'm.txt'), 'm\n');
  g('add', 'm.txt');
  g('commit', '-q', '-m', 'cel');
  writeFileSync(runFile(wt, run, 'brief.md', 2), BRIEF(run, 'Plik c', ['AC-2 c']));
  assert.equal(cliAs(wt, 'sess-2', {}, 'state', run).json.next, 'implement');
  writeFileSync(join(wt, 'c.txt'), 'c\n');
  writeFileSync(runFile(wt, run, 'result-1.md', 2), header({ schema: 'dwmt/result@1', status: 'DONE' }));
  assert.equal(cliAs(wt, 'sess-2', {}, 'verify', run).json.ok, true);
  cliAs(wt, 'sess-2', {}, 'review-input', run);
  const patch = readFileSync(runFile(wt, run, 'diff.patch', 2), 'utf8');
  assert.match(patch, /c\.txt/);
  assert.doesNotMatch(patch, /b\.txt|m\.txt/, 'diff T-2 bez T-1 i bez zmian celu');
  const rj = RUN(wt, run);
  assert.equal(rj.tasks[1].baseline, rj.tasks[0].commit);
  assert.equal(gw('log', '-1', '--format=%s', rj.tasks[0].commit), 'T-1 Plik b', 'commit T-1 po rebase odnaleziony po stopce');
});

test('recenzja S2: sprint poprawek od supervisora (source) przypisuje defekty z uat.md sprintu źródłowego', () => {
  const { d: main } = setupRepo();
  mkdirSync(join(main, '.dwmt', 'supervisor', 'input'), { recursive: true });
  const a = sprintDone(main, 'src', 's1.txt');
  cli(a.wt, 'finish', a.run);
  cli(main, 'uat', 'start', a.run);
  const res = join(main, '..', `${a.run}-res.json`);
  writeFileSync(res, JSON.stringify({ result: 'defects', findings: [{ text: 'Pusty s1', weight: 'blocker', kind: 'bug', class: 'plan' }] }));
  const rec = cli(main, 'uat', 'record', a.run, res).json;
  assert.equal(rec.released, true);
  assert.equal(hdr(join(main, '.dwmt', 'runs', a.run, 'uat.md')).entries[0].shared, 1);
  writeFileSync(join(main, '.dwmt', 'supervisor', 'input', 'FIX1.md'), `${header({ schema: 'dwmt/sprint-input@1', sprint: 'FIX1', source: a.run })}Poprawki UAT sprintu ${a.run}\n`);
  const wt = worktree(main, 'fix1');
  const run = cli(wt, 'preflight', '--slug', 'fix1').json.run;
  const i = cli(wt, 'init', '--run', run, '--mode', 'inline', '--sprint', 'FIX1').json;
  assert.equal(i.ok, true, JSON.stringify(i));
  assert.deepEqual(i.defects, ['U-1']);
  assert.equal(RUN(wt, run).source.run, a.run);
  assert.match(readFileSync(runFile(wt, run, 'task.md'), 'utf8'), /^Poprawki UAT[\s\S]*### U-1 \[blocker\] bug, plan: Pusty s1/);
  assert.equal(hdr(join(main, '.dwmt', 'runs', a.run, 'uat.md')).defects[0].fix, run);
});
