import './tmp-root.mjs';
// D1: planista i pytania, ryzyka w briefie, jednostki recenzji, raport jako kontrakt, git.rebase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseRisks, briefErrors, planUnits, mergeReviews, worstById, parseYaml, splitHeader, section } from '../scripts/dwmt.mjs';
import { repo, gitIn, cli, header, runFile, put, prepared, asV26, UAT_NONE } from './helpers.mjs';

const RISKS = [
  '## Risks',
  '### R-1 [critical] Faktura nie jest wystawiona drugi raz po restarcie',
  '- Method: `test`',
  '- Area: billing',
  '',
  '### R-2 [high] Moduły rozmawiają przez kontrakty',
  '- **Method:** guard mvn test -Dtest=ArchGuardTest',
  '- Area: core',
  '',
  '## Entry map',
  '- `a.txt`',
].join('\n');

test('parseRisks: waga, metoda z detalem, obszar; koniec na następnej sekcji', () => {
  const r = parseRisks(`# g\n\n${RISKS}\n`);
  assert.deepEqual(r.map(({ id, weight, method, area }) => ({ id, weight, method, area })), [
    { id: 'R-1', weight: 'critical', method: 'test', area: 'billing' },
    { id: 'R-2', weight: 'high', method: 'guard', area: 'core' },
  ]);
  assert.equal(r[1].detail, 'mvn test -Dtest=ArchGuardTest');
  assert.equal(r[0].title, 'Faktura nie jest wystawiona drugi raz po restarcie');
  assert.doesNotMatch(r[1].text, /Entry map/);
  assert.deepEqual(parseRisks('# brak sekcji\n'), []);
});

test('briefErrors: brak sekcji ryzyka i pytania, zła waga i metoda, areas jako lista', () => {
  const text = RISKS.replace('## Entry map', '### R-3 [huge] x\n- Method: hope\n\n## Entry map');
  const e = briefErrors(text, { risks: ['R-1', 'R-3', 'R-4'], questions: ['Q-1'], areas: ['x/**'] });
  assert.ok(e.some((x) => /R-3: waga \[huge\]/.test(x)), e.join('\n'));
  assert.ok(e.some((x) => /R-3: Method hope/.test(x)));
  assert.ok(e.some((x) => /brak sekcji R-4/.test(x)));
  assert.ok(e.some((x) => /brak sekcji Q-1/.test(x)));
  assert.ok(e.some((x) => /areas musi być mapą/.test(x)));
  assert.deepEqual(briefErrors(RISKS, { risks: ['R-1', 'R-2'], areas: { billing: ['billing/**'] } }), []);
});

test('planUnits: jedna jednostka w budżecie; podział zachłanny po obszarach, reszta, drugie spojrzenie', () => {
  const risks = [{ id: 'R-1', weight: 'critical', area: 'billing' }, { id: 'R-2', weight: 'low', area: null }, { id: 'R-3', weight: 'high', area: 'ui' }];
  const files = ['billing/a.java', 'ui/b.tsx', 'api/c.java', 'README.md'];
  const areas = { billing: ['billing/**'], ui: ['ui/**'], api: ['api/**'] };
  const small = planUnits({ files, sizes: { 'billing/a.java': 4000 }, areas, risks, secondLook: false });
  assert.equal(small.length, 1);
  assert.deepEqual(small[0].risks, ['R-1', 'R-2', 'R-3']);

  const sizes = { 'billing/a.java': 400e3, 'ui/b.tsx': 200e3, 'api/c.java': 400e3, 'README.md': 4e3 };
  const u = planUnits({ files, sizes, areas, risks, budgetK: 150 });
  assert.deepEqual(u.map((x) => x.name), ['billing+ui', 'api+rest', 'billing (second look)']);
  assert.deepEqual(u.map((x) => x.id), [1, 2, 3]);
  assert.deepEqual(u[0].files, ['billing/a.java', 'ui/b.tsx']);
  assert.deepEqual(u[0].risks, ['R-1', 'R-3']);
  assert.deepEqual(u[1].risks, ['R-2'], 'ryzyko bez obszaru trafia do reszty');
  assert.deepEqual(u[2], { id: 3, name: 'billing (second look)', areas: ['billing'], files: ['billing/a.java'], risks: ['R-1'], secondLook: true });
  assert.equal(planUnits({ files, sizes, areas, risks, budgetK: 150, secondLook: false }).length, 2);
  assert.equal(planUnits({ files, sizes, areas: {}, risks }).length, 2, 'bez obszarów: jedna jednostka + drugie spojrzenie');
});

test('mergeReviews: F-n numerowane dalej, liczniki, najgorszy status, sekcje po nowych identyfikatorach', () => {
  const a = `${header({ schema: 'dwmt/review@1', round: 1, passes: ['risks', 'correctness', 'pragmatism'], verdict: 'FIX', counts: { blocker: 0, major: 1, minor: 1 }, fix: ['F-1'], defer: ['F-2'], drop: [], acceptance: ['AC-1 met', 'AC-2 met'], risks: ['R-1 proven'] })}## risks\n### F-1 [major] a1\nwidzi F-2\n### F-2 [minor] a2\n`;
  const b = `${header({ schema: 'dwmt/review@1', round: 1, passes: ['risks', 'pragmatism'], verdict: 'FIX', counts: { major: 1 }, fix: ['F-1'], defer: [], drop: [], acceptance: ['AC-1 partial'], risks: ['R-1 unproven: mock'], missed: [] })}## risks\n### F-1 [major] b1\n`;
  const text = mergeReviews([{ name: 'billing+ui', text: a }, { name: 'billing (second look)', text: b }]);
  const h = parseYaml(splitHeader(text).yaml);
  assert.equal(h.verdict, 'FIX');
  assert.deepEqual(h.fix, ['F-1', 'F-3']);
  assert.deepEqual(h.defer, ['F-2']);
  assert.deepEqual(h.counts, { blocker: 0, major: 2, minor: 1 });
  assert.deepEqual(h.acceptance, ['AC-1 partial', 'AC-2 met']);
  assert.deepEqual(h.risks, ['R-1 unproven: mock']);
  assert.deepEqual(h.units, ['billing+ui', 'billing (second look)']);
  assert.match(section(text, 'F-3'), /b1/);
  assert.match(section(text, 'F-1'), /widzi F-2/);
  assert.equal(parseYaml(splitHeader(mergeReviews([{ name: 'x', text: a.replace('fix: ["F-1"]', 'fix: []') }])).yaml).verdict, 'PASS');
  assert.deepEqual(worstById([['AC-1 met'], ['AC-1 not met']]), ['AC-1 not met']);
  assert.deepEqual(worstById([['AC-1 not checked in this unit'], ['AC-1 met'], ['R-2 human']]), ['AC-1 met', 'R-2 human']);
});

function started(d, mode) {
  const g = gitIn(d);
  cli(d, 'setup');
  g('add', '-A');
  g('commit', '-q', '-m', 'dwmt setup');
  const run = cli(d, 'preflight', '--slug', 'p').json.run;
  assert.equal(cli(d, 'init', '--run', run, '--mode', mode).json.ok, true);
  return run;
}
const brief = (run, extra = {}, body = '') => `${header({ schema: 'dwmt/brief@1', run, goal: 'Dodaj b.txt', mode: 'single', acceptance: ['AC-1 b.txt istnieje'], scope: ['**'], verify: ['node -e 0'], decisions: ['D-1'], ...extra })}# g\n\n## Decisions\n### D-1 Prosto\nbez udziwnień\n\n## Assumptions\n- A-1 plik tekstowy\n\n${UAT_NONE}${body}`;

// Przebieg v2.6 (bez `rules`): dawne prompty planisty idą do architekta z dopiskiem; przepływ 2.7 w d3.test.mjs.
test('planowanie v2.6: task.md → architekt (klucz planner) → pytania → odpowiedzi → ten sam prompt → implement', () => {
  const d = repo();
  const run = started(d, 'single');
  asV26(d, run);
  assert.equal(cli(d, 'state', run).json.agent, null, 'bez task.md nie ma kogo uruchomić');
  writeFileSync(runFile(d, run, 'task.md'), 'Dodaj b.txt\n');
  let st = cli(d, 'state', run).json;
  assert.equal(st.next, 'plan');
  assert.equal(st.agent, 'dwmt-architect');
  assert.match(st.prompt, /^v2\.6 run: write only what this prompt names\. Plan the sprint.*Task:.*task\.md\. Plan: .*plan\.md\. Brief of task 1: .*tasks\/1\/brief\.md\. Templates: .*artifacts\/plan\.md, .*artifacts\/brief\.md\. Mode: single\. Language: en\./);
  assert.equal(st.key, 'planner');

  writeFileSync(runFile(d, run, 'brief.md'), brief(run, { risks: ['R-1'] }, '\n## Risks\n### R-1 [high] x\n'));
  st = cli(d, 'state', run).json;
  assert.equal(st.next, 'plan');
  assert.match(st.prompt, /^v2\.6 run: write only what this prompt names\. Fix the brief of task 1: R-1: Method \(brak\)/);

  const q = '\n## Questions\n### Q-1 Zakres\n- Rule or goal: r\n### Q-2 Dane\n- Rule or goal: r\n';
  writeFileSync(runFile(d, run, 'brief.md'), brief(run, { questions: ['Q-1', 'Q-2'] }, q));
  st = cli(d, 'state', run).json;
  assert.equal(st.next, 'ask-plan');
  assert.deepEqual(st.questions, ['Q-1', 'Q-2']);
  assert.match(st.answers, /answers\.md$/);
  writeFileSync(runFile(d, run, 'answers.md'), '### Q-1 Zakres\nTylko b.txt\n');
  assert.deepEqual(cli(d, 'state', run).json.questions, ['Q-2']);
  writeFileSync(runFile(d, run, 'answers.md'), '### Q-1 Zakres\nTylko b.txt\n\n### Q-2 Dane\nBez migracji\n');
  st = cli(d, 'state', run).json;
  assert.equal(st.next, 'plan');
  assert.equal(st.agent, 'dwmt-architect');
  assert.match(st.prompt, /^v2\.6 run: write only what this prompt names\. Answers: .*answers\.md\. Record each as D-n/);

  writeFileSync(runFile(d, run, 'brief.md'), brief(run, { questions: [] }));
  st = cli(d, 'state', run).json;
  assert.equal(st.next, 'implement');
  assert.equal(st.agent, 'dwmt-executor');
});

test('planowanie inline: bez planisty; orkiestrator pisze brief sam', () => {
  const d = repo();
  const run = started(d, 'inline');
  writeFileSync(runFile(d, run, 'task.md'), 'Dodaj b.txt\n');
  const st = cli(d, 'state', run).json;
  assert.equal(st.next, 'plan');
  assert.equal(st.agent, null);
  assert.match(st.hint, /inline: zaplanuj sam/);
  writeFileSync(runFile(d, run, 'brief.md'), brief(run, { mode: 'inline' }));
  assert.equal(cli(d, 'state', run).json.next, 'implement');
});

test('recenzja od ryzyk: jednostki po obszarach, dowody wykonawcy, scalenie, raport z kontraktem i pokryciem', () => {
  const d = repo();
  const g = gitIn(d);
  cli(d, 'setup');
  const cfgFile = join(d, '.claude', 'dwmt.json');
  const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
  cfg.review = { splitAboveK: 0.001, secondLookCritical: true };
  writeFileSync(cfgFile, JSON.stringify(cfg));
  g('add', '-A');
  g('commit', '-q', '-m', 'dwmt setup');
  const run = cli(d, 'preflight', '--slug', 'r').json.run;
  cli(d, 'init', '--run', run, '--mode', 'single');
  const risks = '\n## Risks\n### R-1 [critical] Faktura raz\n- Method: test\n- Area: billing\n\n### R-2 [medium] Widok czytelny\n- Method: human\n- Area: web\n';
  writeFileSync(runFile(d, run, 'brief.md'), brief(run, { risks: ['R-1', 'R-2'], areas: { billing: ['billing/**'], web: ['web/**'] } }, risks));
  assert.equal(cli(d, 'state', run).json.next, 'implement');
  for (const [dir, f] of [['billing', 'x.txt'], ['web', 'y.txt']]) { mkdirSync(join(d, dir), { recursive: true }); writeFileSync(join(d, dir, f), `${dir}\n`); }
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'DONE', evidence: ['R-1 billing/x.test.mjs › bills once'] });
  assert.equal(cli(d, 'verify', run).json.ok, true);
  const ri = cli(d, 'review-input', run).json;
  assert.deepEqual(ri.units.map((u) => u.unit), ['billing', 'web', 'billing (second look)']);
  assert.deepEqual(ri.units[0].passes, ['risks', 'correctness', 'pragmatism']);
  assert.deepEqual(ri.units[1].passes, ['risks', 'correctness', 'pragmatism']);
  assert.deepEqual(ri.units[2].passes, ['risks', 'pragmatism']);
  const in1 = readFileSync(runFile(d, run, 'review-input-1.md'), 'utf8');
  assert.match(in1, /### R-1 \[critical\] Faktura raz[\s\S]*Evidence \(executor\): R-1 billing\/x\.test\.mjs › bills once/);
  assert.doesNotMatch(in1, /### R-2/);
  assert.match(in1, /Other review units cover the remaining 1 changed files/);
  assert.match(readFileSync(runFile(d, run, 'review-input-2.md'), 'utf8'), /R-2[\s\S]*Evidence \(executor\): none listed/);
  assert.match(readFileSync(runFile(d, run, 'review-input-3.md'), 'utf8'), /## Second look/);
  const p1 = readFileSync(runFile(d, run, 'diff-1.patch'), 'utf8');
  assert.match(p1, /billing\/x\.txt/);
  assert.doesNotMatch(p1, /web\/y\.txt/);

  let st = cli(d, 'state', run).json;
  assert.equal(st.next, 'review');
  assert.equal(st.units.length, 3);
  assert.match(st.units[1].prompt, /Input: .*review-input-2\.md\. Output: .*review-1-2\.md\./);
  const ok = (extra) => ({ schema: 'dwmt/review@1', round: 1, passes: ['risks'], verdict: 'PASS', fix: [], acceptance: ['AC-1 met'], ...extra });
  put(d, run, 'review-1-1.md', ok({ risks: ['R-1 proven'] }));
  put(d, run, 'review-1-2.md', ok({ risks: ['R-2 human'], defer: ['F-1'], counts: { minor: 1 } }), '## risks\n### F-1 [minor] etykieta\n');
  assert.equal(cli(d, 'state', run).json.units.length, 1, 'czeka na brakującą jednostkę');
  put(d, run, 'review-1-3.md', ok({ risks: ['R-1 proven'] }));
  st = cli(d, 'state', run).json;
  assert.equal(st.next, 'commit');
  const merged = parseYaml(splitHeader(readFileSync(runFile(d, run, 'review-1.md'), 'utf8')).yaml);
  assert.deepEqual(merged.defer, ['F-1']);
  assert.deepEqual(merged.risks, ['R-1 proven', 'R-2 human']);

  assert.equal(cli(d, 'commit', run).json.ok, true);
  const fin = cli(d, 'finish', run).json;
  assert.equal(fin.status, 'squashed', JSON.stringify(fin));
  const report = readFileSync(runFile(d, run, 'final-report.md'), 'utf8');
  const rh = parseYaml(splitHeader(report).yaml);
  assert.deepEqual(rh.decisions, ['D-1']);
  assert.deepEqual(rh.risks, ['R-1 proven', 'R-2 human']);
  assert.deepEqual(rh.assumptions, ['A-1']);
  assert.match(report, /## Contract\n- Goal: Dodaj b\.txt\n- AC-1 b\.txt istnieje → \*\*met\*\*\n- D-1 Prosto\n- A-1 plik tekstowy/);
  assert.match(report, /\| R-1 Faktura raz \| critical \| test \| billing \| proven \|/);
  assert.match(report, /\| R-2 Widok czytelny \| medium \| human \| web \| human \|/);
});

test('git.rebase review: commit roboczy, rebase na przesunięty cel, nowy punkt odniesienia diffu', () => {
  const d = repo();
  const g = gitIn(d);
  cli(d, 'setup');
  const cfgFile = join(d, '.claude', 'dwmt.json');
  const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
  cfg.git.rebase = 'review';
  writeFileSync(cfgFile, JSON.stringify(cfg));
  const run = prepared(d);
  const branch = `dwmt/${run}`;
  g('switch', '-q', 'master');
  writeFileSync(join(d, 'c.txt'), 'z celu\n');
  g('add', 'c.txt');
  g('commit', '-q', '-m', 'cel poszedł dalej');
  g('switch', '-q', branch);
  writeFileSync(join(d, 'b.txt'), 'b\n');
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'DONE' });
  const v = cli(d, 'verify', run).json;
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.ok(existsSync(join(d, 'c.txt')), 'gałąź przebiegu ma zmianę z celu');
  assert.equal(g('log', '-1', '--format=%s'), `dwmt wip: ${run} T-1 (round 1, before review)`);
  const rj = JSON.parse(readFileSync(runFile(d, run, 'run.json'), 'utf8'));
  assert.equal(rj.tasks[0].baseline, g('rev-parse', 'master'));
  cli(d, 'review-input', run);
  const patch = readFileSync(runFile(d, run, 'diff.patch'), 'utf8');
  assert.match(patch, /b\.txt/);
  assert.doesNotMatch(patch, /c\.txt/, 'diff pokazuje tylko zmianę przebiegu');
  put(d, run, 'review-1.md', { schema: 'dwmt/review@1', round: 1, passes: [], verdict: 'PASS', fix: [] });
  assert.equal(cli(d, 'commit', run).json.empty, true, 'po commicie roboczym nie ma nic nowego');
  assert.equal(cli(d, 'finish', run).json.status, 'squashed');
  assert.equal(g('log', '-1', '--format=%s', 'master'), 'Dodaj b.txt');
});

test('git.rebase review: konflikt przed recenzją jest przerywany i raportowany', () => {
  const d = repo();
  const g = gitIn(d);
  cli(d, 'setup');
  const cfgFile = join(d, '.claude', 'dwmt.json');
  const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
  cfg.git.rebase = 'review';
  writeFileSync(cfgFile, JSON.stringify(cfg));
  const run = prepared(d);
  g('switch', '-q', 'master');
  writeFileSync(join(d, 'a.txt'), 'cel\n');
  g('commit', '-q', '-am', 'cel zmienia a');
  g('switch', '-q', `dwmt/${run}`);
  writeFileSync(join(d, 'a.txt'), 'przebieg\n');
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'DONE' });
  const v = cli(d, 'verify', run).json;
  assert.equal(v.status, 'conflict');
  assert.deepEqual(v.files, ['a.txt']);
  assert.ok(!existsSync(join(d, '.git', 'rebase-merge')), 'rebase przerwany');
  assert.equal(cli(d, 'state', run).json.next, 'verify', 'runda nie jest zweryfikowana');
});

test('git.rebase none: finish bez rebase, squash scala z przesuniętym celem', () => {
  const d = repo();
  const g = gitIn(d);
  cli(d, 'setup');
  const cfgFile = join(d, '.claude', 'dwmt.json');
  const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
  cfg.git.rebase = 'none';
  writeFileSync(cfgFile, JSON.stringify(cfg));
  const run = prepared(d);
  const branch = `dwmt/${run}`;
  writeFileSync(join(d, 'b.txt'), 'b\n');
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'DONE' });
  cli(d, 'verify', run);
  cli(d, 'review-input', run);
  put(d, run, 'review-1.md', { schema: 'dwmt/review@1', round: 1, passes: [], verdict: 'PASS', fix: [] });
  cli(d, 'commit', run);
  g('switch', '-q', 'master');
  writeFileSync(join(d, 'c.txt'), 'z celu\n');
  g('add', 'c.txt');
  g('commit', '-q', '-m', 'cel poszedł dalej');
  g('switch', '-q', branch);
  const fin = cli(d, 'finish', run).json;
  assert.equal(fin.status, 'squashed', JSON.stringify(fin));
  assert.doesNotMatch(g('log', '--format=%s', branch), /cel poszedł dalej/, 'gałąź nie była rebase’owana');
  assert.ok(g('ls-tree', '--name-only', 'master').split('\n').includes('b.txt'));
});

test('setup: za stary Node to ok: false z podpowiedzią instalacji, minimum z README', async () => {
  const { nodeProblem, MIN_NODE } = await import('../scripts/lib/setup.mjs');
  assert.equal(MIN_NODE, 22);
  // README pluginu w repo roboczym; w repo publicznym (bez dwmt/README.md) README główne.
  const readme = [new URL('../README.md', import.meta.url), new URL('../../README.md', import.meta.url)].find((u) => existsSync(u));
  assert.match(readFileSync(readme, 'utf8'), new RegExp(`Node(?:\\.js)? (?:≥ )?${MIN_NODE}`));
  assert.equal(nodeProblem('24.19.0'), null);
  assert.equal(nodeProblem('22.0.0'), null);
  assert.match(nodeProblem('20.11.1'), /Node 20\.11\.1: dwmt wymaga Node >= 22/);
  assert.equal(nodeProblem(), null, 'Node, na którym biegną testy');
});
