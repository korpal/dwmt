import './tmp-root.mjs';
// X7: weryfikacja UI (ryzyko `ui`, zrzuty z e2e, makiety, jednostka weryfikatora UI, strona porównań).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseRisks, briefErrors, matchShot, parseYaml, splitHeader } from '../scripts/dwmt.mjs';
import { repo, gitIn, cli, header, runFile, put, UAT_NONE } from './helpers.mjs';

const UI_RISK = (id, shot, mockup = 'mock.png') => `### ${id} [medium] Panel zgodny z makietą 001 B\n- Method: ui\n- Mockup: \`${mockup}\`\n- Mockup-state: pickVariant('b', document.querySelectorAll('.variant-tab')[1])\n- Shot: ${shot}\n- Area: web\n`;
const SHOT = (name) => `node -e "require('fs').mkdirSync('shots',{recursive:true});require('fs').writeFileSync('shots/${name}-1440x900.png','png')"`;
const WIPE = 'node -e "require(\'fs\').rmSync(\'shots\',{recursive:true,force:true})"';
const brief = (run, risks, body, verify) => `${header({ schema: 'dwmt/brief@1', run, goal: 'Panel podsumowania', mode: 'single', acceptance: ['AC-1 panel jak na makiecie'], scope: ['**'], verify, risks, decisions: ['D-1'] })}# g\n\n## Decisions\n### D-1 Prosto\nbez udziwnień\n\n${UAT_NONE}\n## Risks\n${body}`;

function uiRepo(ui = { shots: 'shots' }) {
  const d = repo();
  const g = gitIn(d);
  cli(d, 'setup');
  const cfgFile = join(d, '.claude', 'dwmt.json');
  writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(readFileSync(cfgFile, 'utf8')), ui }));
  writeFileSync(join(d, 'mock.png'), 'mockup');
  writeFileSync(join(d, 'm.html'), '<p>makieta</p>');
  assert.equal(cli(d, 'setup').code, 0);
  g('add', '-A');
  g('commit', '-q', '-m', 'dwmt setup z ui');
  const run = cli(d, 'preflight', '--slug', 'ui').json.run;
  cli(d, 'init', '--run', run, '--mode', 'single');
  return { d, g, run };
}

test('parseRisks i briefErrors: metoda ui z makietą, stanem i zrzutem; wymaga configu ui', () => {
  const text = `## Risks\n${UI_RISK('R-1', 'pm3-sheet', '.planning/sketches/031/index.html')}\n### R-2 [low] Bez linii\n- Method: ui\n`;
  const [r1, r2] = parseRisks(text);
  assert.equal(r1.method, 'ui');
  assert.equal(r1.mockup, '.planning/sketches/031/index.html');
  assert.equal(r1.state, "pickVariant('b', document.querySelectorAll('.variant-tab')[1])");
  assert.equal(r1.shot, 'pm3-sheet');
  assert.equal(r2.mockup, null);
  const h = { risks: ['R-1', 'R-2'] };
  assert.deepEqual(briefErrors(text, h, { ui: { shots: 's' } }), ['R-2: Method ui wymaga linii Mockup i Shot']);
  assert.match(briefErrors(text, h, { ui: null })[0], /R-1: Method ui wymaga klucza ui/);
  assert.equal(matchShot(['a-1440x900.png', 'pm3-sheet-1440x900.png', 'pm3-sheet-extra-1024x700.png'], 'pm3-sheet'), 'pm3-sheet-1440x900.png');
  assert.equal(matchShot(['pm3-sheet.png', 'pm3-sheet-1440x900.png'], 'pm3-sheet'), 'pm3-sheet.png');
  assert.equal(matchShot(['pm3-sheetx.png'], 'pm3-sheet'), null);
});

test('setup: weryfikator UI tylko z kluczem ui; architekt dostaje „UI check: on”', () => {
  const plain = repo();
  cli(plain, 'setup');
  assert.equal(existsSync(join(plain, '.claude', 'agents', 'dwmt-ui-verifier.md')), false);
  const { d, run } = uiRepo();
  const agent = readFileSync(join(d, '.claude', 'agents', 'dwmt-ui-verifier.md'), 'utf8');
  assert.match(agent, /effort: xhigh/);
  assert.match(agent, /template 16/);
  writeFileSync(runFile(d, run, 'task.md'), 'Panel\n');
  assert.match(cli(d, 'state', run).json.prompt, /UI check: on\./);
});

test('ui: zrzut zebrany mimo czyszczenia katalogu, jednostka weryfikatora, recheck ze zrzutami rundy, raport i strona porównań', () => {
  const { d, run } = uiRepo();
  const body = `${UI_RISK('R-1', 'panel')}\n### R-2 [high] Kwota do zapłaty z faktury\n- Method: test\n- Area: web\n`;
  writeFileSync(runFile(d, run, 'brief.md'), brief(run, ['R-1', 'R-2'], body, [SHOT('panel'), WIPE]));
  assert.equal(cli(d, 'state', run).json.next, 'implement');
  writeFileSync(join(d, 'web.txt'), 'panel\n');
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'DONE', evidence: ['R-1 e2e/panel.spec.mjs › captures panel', 'R-2 test/x.test.mjs › total'] });
  const v = cli(d, 'verify', run).json;
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.deepEqual(v.ui, { pairs: 1, missing: [], renderErrors: [] });
  assert.ok(existsSync(runFile(d, run, 'ui/r1/panel-1440x900.png')), 'kopia sprzed czyszczenia');
  assert.equal(readFileSync(runFile(d, run, 'ui/mockup-R-1.png'), 'utf8'), 'mockup');
  assert.ok(existsSync(runFile(d, run, 'ui/compare.html')));

  const ri = cli(d, 'review-input', run).json;
  assert.deepEqual(ri.units.map((u) => [u.unit, u.passes]), [['all', ['risks', 'correctness', 'pragmatism']], ['ui', ['visual', 'pragmatism']]]);
  const code = readFileSync(runFile(d, run, 'review-input-1.md'), 'utf8');
  assert.match(code, /### R-2/);
  assert.doesNotMatch(code, /### R-1/);
  assert.match(code, /UI risks \(R-1\) are compared on screenshots by the ui unit: do not compare the code with the mockups/);
  const ui = readFileSync(runFile(d, run, 'review-input-2.md'), 'utf8');
  assert.match(ui, /## Screens[\s\S]*\| R-1 Panel zgodny z makietą 001 B \| `[^`]*ui\/r1\/panel-1440x900\.png` \| `[^`]*ui\/mockup-R-1\.png` \(source `mock\.png`, state `pickVariant/);
  assert.match(ui, /Evidence \(executor\): R-1 e2e\/panel\.spec\.mjs › captures panel/);
  assert.match(ui, /## Pass 1: visual[\s\S]*## Pass 2: pragmatism/);
  assert.match(parseYaml(splitHeader(ui).yaml).diff, /diff\.patch$/);

  let st = cli(d, 'state', run).json;
  assert.deepEqual(st.units.map((u) => u.agent), ['dwmt-reviewer', 'dwmt-ui-verifier']);
  put(d, run, 'review-1-1.md', { schema: 'dwmt/review@1', round: 1, passes: ['risks'], verdict: 'PASS', fix: [], acceptance: ['AC-1 met'], risks: ['R-2 proven'] });
  // Weryfikator w sandboksie zapisał `risks` jako mapę: mechanika zamienia ją na listę.
  put(d, run, 'review-1-2.md', { schema: 'dwmt/review@1', round: 1, passes: ['visual', 'pragmatism'], verdict: 'FIX', fix: ['F-1'], counts: { major: 1 }, acceptance: ['AC-1 partial'], risks: { 'R-1': 'unproven: brak znacznika' } }, '## visual\n### F-1 [major] Panel: brak znacznika „Darmowa dostawa”\n');
  st = cli(d, 'state', run).json;
  assert.equal(st.next, 'fix');
  assert.deepEqual(parseYaml(splitHeader(readFileSync(runFile(d, run, 'review-1.md'), 'utf8')).yaml).risks, ['R-2 proven', 'R-1 unproven: brak znacznika']);
  assert.equal(st.agent, 'dwmt-executor-high');

  put(d, run, 'result-2.md', { schema: 'dwmt/result@1', status: 'DONE', fixed: ['F-1'] });
  assert.equal(cli(d, 'verify', run).json.ui.pairs, 1);
  assert.ok(existsSync(runFile(d, run, 'ui/r2/panel-1440x900.png')));
  // D2: uwaga z jednostki ui i niedowiedzione ryzyko ui wracają do weryfikatora UI, reszta do recenzenta.
  assert.deepEqual(cli(d, 'review-input', run).json.units.map((u) => [u.unit, u.passes]), [['recheck', ['recheck']], ['ui', ['visual', 'pragmatism']]]);
  const re = readFileSync(runFile(d, run, 'review-input-1.md'), 'utf8');
  assert.deepEqual(parseYaml(splitHeader(re).yaml).fix, []);
  assert.match(re, /UI risks \(R-1\) and the UI findings \(F-1\) are re-checked on the new screenshots by the ui unit/);
  assert.match(re, /Number new findings from F-2\./);
  const reUi = readFileSync(runFile(d, run, 'review-input-2.md'), 'utf8');
  assert.deepEqual(parseYaml(splitHeader(reUi).yaml).fix, ['F-1']);
  assert.match(reUi, /### F-1 \[major\] Panel: brak znacznika/);
  assert.match(reUi, /## Screens \(this round\)[\s\S]*ui\/r2\/panel-1440x900\.png/);
  assert.deepEqual(cli(d, 'state', run).json.units.map((u) => u.agent), ['dwmt-reviewer', 'dwmt-ui-verifier']);
  put(d, run, 'review-2-1.md', { schema: 'dwmt/review@1', round: 2, passes: ['recheck'], verdict: 'PASS', fix: [], acceptance: ['AC-1 met'] });
  put(d, run, 'review-2-2.md', { schema: 'dwmt/review@1', round: 2, passes: ['visual', 'pragmatism'], verdict: 'PASS', fix: [], acceptance: ['AC-1 met'], risks: ['R-1 proven'] }, '## visual\n- F-1 resolved\n');
  assert.equal(cli(d, 'state', run).json.next, 'commit');
  assert.match(readFileSync(runFile(d, run, 'review-2.md'), 'utf8'), /- F-1 resolved/, 'stary identyfikator bez przenumerowania');
  assert.equal(cli(d, 'commit', run).json.ok, true);
  const fin = cli(d, 'finish', run).json;
  assert.equal(fin.status, 'squashed', JSON.stringify(fin));
  const report = readFileSync(runFile(d, run, 'final-report.md'), 'utf8');
  assert.deepEqual(parseYaml(splitHeader(report).yaml).ui, ['tasks/1/ui/compare.html'], 'ścieżki względne, ważne w kopii w głównym drzewie');
  assert.match(report, /## Screens\n- `tasks\/1\/ui\/compare\.html`/);
  assert.match(report, /\| R-1 Panel zgodny z makietą 001 B \| medium \| ui \| web \| proven \|/);
  const page = readFileSync(runFile(d, run, 'ui/compare.html'), 'utf8');
  assert.match(page, /R-1 proven/);
  assert.match(page, /src="r2\/panel-1440x900\.png"/);
  assert.match(page, /src="mockup-R-1\.png"/);
});

test('ui: brak zrzutu czerwieni rundę; błąd renderu makiety nie; para bez zrzutu poza weryfikatorem; podział par po maxPairs', () => {
  const { d, run } = uiRepo({ shots: 'shots', maxPairs: 1 });
  const body = `${UI_RISK('R-1', 'panel')}\n${UI_RISK('R-2', 'brak', 'm.html')}\n${UI_RISK('R-3', 'panel')}`;
  writeFileSync(runFile(d, run, 'brief.md'), brief(run, ['R-1', 'R-2', 'R-3'], body, [SHOT('panel')]));
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'DONE' });
  const v = cli(d, 'verify', run).json;
  assert.equal(v.ok, false);
  assert.equal(v.repair, true, 'D2: brak zrzutu wraca najpierw do wykonawcy');
  assert.deepEqual(v.ui.missing, ['R-2 brak']);
  assert.match(v.ui.renderErrors[0], /^R-2: no @playwright\/test or playwright resolvable/);
  assert.ok(v.commands.includes('1 dwmt ui: screenshots'));
  assert.match(readFileSync(runFile(d, run, 'tests.md'), 'utf8'), /R-2: no screenshot `brak` under `shots`/);
  const ri = cli(d, 'review-input', run).json;
  // D2: R-2 bez zrzutu i makiety nie idzie do weryfikatora (PM-3: weryfikator bez obrazów dał PASS).
  assert.deepEqual(ri.units.map((u) => u.unit), ['all', 'ui-1', 'ui-2']);
  assert.match(readFileSync(runFile(d, run, 'review-input-3.md'), 'utf8'), /\| R-3 [^|]*\| `[^`]*ui\/r1\/panel-1440x900\.png`/);
  assert.doesNotMatch(readFileSync(runFile(d, run, 'review-input-2.md'), 'utf8') + readFileSync(runFile(d, run, 'review-input-3.md'), 'utf8'), /### R-2/);
  assert.match(readFileSync(runFile(d, run, 'review-input-1.md'), 'utf8'), /UI risks \(R-1, R-2, R-3\) are compared on screenshots by the ui unit/);
  assert.deepEqual(readdirSync(runFile(d, run, 'ui')).filter((f) => f.startsWith('mockup-')), ['mockup-R-1.png', 'mockup-R-3.png']);
});
