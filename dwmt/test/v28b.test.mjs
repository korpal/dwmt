import './tmp-root.mjs';
// v2.8, gałęzie rundy zbiorczej i poprawki po recenzji niezależnej (F1–F10): blocker w rundzie zbiorczej, naprawa
// czerwieni, kontynuacja po przerwie, BLOCKED (pytania, planIssue bez pytań), jednostka ui z parami obrazów przez recheck,
// inline i import bez plan.md, `[new]` późniejszych zadań w rozjeździe, przyczyna wspólna dla kilku zadań, odporność
// podziału na przerwaną komendę, parsowanie dowodu, gołe F-n, porównanie wersji reguł. Fikstury syntetyczne.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { batchItemResults, resolveIds, evidenceFile, findingInfo } from '../scripts/batch.mjs';
import { rulesAtLeast, is27, is28, driftCauses, RULES } from '../scripts/plan.mjs';
import { repo, header, runFile, prepared, asRules } from './helpers.mjs';
import { cliAs, hdr, RUN, T2, T3, repo28, start, writePlans, review, finding, execute, batchFile } from './fixtures28.mjs';

const state = (d, sid, run) => cliAs(d, sid, 'state', run).json;
// Hook SessionStart (po /clear albo przerwie): `activeRuns` liczy stan tylko do odczytu.
const HOOK = fileURLToPath(new URL('../hooks/session-start.mjs', import.meta.url));
const hook = (d) => spawnSync(process.execPath, [HOOK], { cwd: d, input: JSON.stringify({ cwd: d }), encoding: 'utf8' }).stdout;
// Zadanie od wykonawcy do commitu w swojej sesji: recenzja `rev` (domyślnie PASS).
function task(d, sid, run, k, files, rev = null) {
  if (k > 1) assert.equal(state(d, sid, run).next, 'implement');
  execute(d, sid, run, k, 1, files);
  writeFileSync(runFile(d, run, 'review-1.md', k), rev ?? review(k, {}));
  const st = state(d, sid, run);
  assert.equal(st.next, 'commit', JSON.stringify(st));
  const c = cliAs(d, sid, 'commit', run).json;
  assert.equal(c.ok, true, JSON.stringify(c));
}
const T1_FIX = review(1, { verdict: 'FIX', fix: ['F-1'] }, finding('F-1', 'major', 'Test misses 0%', 'src/billing/invoice.test.ts:2'));
const T3_FIX = review(3, { verdict: 'FIX', fix: ['F-1'] }, finding('F-1', 'major', 'Export uses the old invoice', 'src/billing/invoice.ts:3'));
// Sprint 2.8 do stanu `batch` (sesja ostatniego zadania: sess-3); `rev3`: recenzja T-3.
function toBatch({ cfg = {}, extra = {}, plans = () => ({}), rev2 = null, rev3 = null, files2 = {} } = {}) {
  const { d } = repo28(cfg, extra);
  const run = start(d, 'b');
  writePlans(d, run, plans(run));
  assert.equal(state(d, 'sess-1', run).next, 'implement');
  task(d, 'sess-1', run, 1, { 'src/billing/discount.ts': 'export class Discount {}\n' }, T1_FIX);
  task(d, 'sess-2', run, 2, { 'src/summary/view.ts': 'export const view = () => "-";\n', ...files2 }, rev2);
  task(d, 'sess-3', run, 3, { 'src/export/csv.ts': 'export const csv = () => "10";\n' }, rev3);
  const st = state(d, 'sess-3', run);
  assert.deepEqual([st.next, st.batch], ['batch', true], JSON.stringify(st));
  return { d, run, st };
}

test('batch: otwarty blocker po ostatniej rundzie → ask-rounds (także po przerwie), extend, znowu ask-rounds, commit --accept', () => {
  const { d, run } = toBatch();
  execute(d, 'sess-3', run, 'batch', 1, { 'src/billing/invoice.test.ts': '// 0%\n' });
  writeFileSync(batchFile(d, run, 'review-1.md'), review(0, { passes: ['recheck'], verdict: 'FIX', fix: ['T-1/F-1'], acceptance: [] }, '- T-1/F-1 open\n'));
  assert.deepEqual([state(d, 'sess-3', run).next, state(d, 'sess-3', run).round], ['batch', 2]);
  execute(d, 'sess-3', run, 'batch', 2, { 'src/billing/invoice.ts': 'export const invoice = (t) => -t;\n' });
  const blocker = '### F-9 [blocker] The fix makes totals negative\n- Evidence: `src/billing/invoice.ts:1`\n';
  writeFileSync(batchFile(d, run, 'review-2.md'), review(0, { round: 2, passes: ['recheck'], verdict: 'FIX', fix: ['F-9'], acceptance: [] }, `- T-1/F-1 resolved\n${blocker}`));
  let st = state(d, 'sess-3', run);
  assert.deepEqual([st.next, st.batch, st.round], ['ask-rounds', true, 2], JSON.stringify(st));
  assert.match(st.hint, /otwarty blocker \(F-9\)/);
  assert.equal(state(d, 'sess-9', run).next, 'ask-rounds', 'po przerwie (inna sesja) ten sam stan');
  assert.equal(cliAs(d, 'sess-9', 'extend', run).json.maxRounds, 3);
  assert.equal(RUN(d, run).batch.maxRounds, 3, 'extend dotyczy rundy zbiorczej, nie zadania');
  st = state(d, 'sess-9', run);
  assert.deepEqual([st.next, st.round], ['batch', 3]);
  execute(d, 'sess-9', run, 'batch', 3, {});
  writeFileSync(batchFile(d, run, 'review-3.md'), review(0, { round: 3, passes: ['recheck'], verdict: 'FIX', fix: ['F-9'], acceptance: [] }, blocker));
  assert.equal(state(d, 'sess-9', run).next, 'ask-rounds');
  assert.equal(cliAs(d, 'sess-9', 'commit', run).code, 1, 'bez --accept commit odmawia');
  // kt (D-13): rounds 2 and 3 carried their commands, so the accepted tree gets one closing whole verify first.
  const c0 = cliAs(d, 'sess-9', 'commit', run, '--accept').json;
  assert.deepEqual([c0.ok, c0.accepted, c0.next, c0.closing, c0.batch], [false, true, 'verify', true, true], JSON.stringify(c0));
  st = state(d, 'sess-9', run);
  assert.deepEqual([st.next, st.closing, st.batch], ['verify', true, true], JSON.stringify(st));
  const cv = cliAs(d, 'sess-9', 'verify', run).json;
  assert.deepEqual([cv.ok, cv.closing], [true, true], JSON.stringify(cv));
  assert.equal(state(d, 'sess-9', run).next, 'commit');
  const c = cliAs(d, 'sess-9', 'commit', run).json;
  assert.deepEqual([c.ok, c.batch, c.open], [true, true, []], JSON.stringify(c));
  assert.deepEqual(hdr(batchFile(d, run, 'report.md')).items, ['T-1/F-1 fix resolved']);
  assert.equal(state(d, 'sess-9', run).next, 'goal-check');
});

test('closing verify: a batch round changed after its whole verify runs it once before the batch commit', () => {
  const { d, run } = toBatch();
  execute(d, 'sess-3', run, 'batch', 1, { 'src/billing/invoice.test.ts': '// 0%\n' });
  assert.equal(hdr(batchFile(d, run, 'tests.md')).whole, true);
  writeFileSync(batchFile(d, run, 'review-1.md'), review(0, { passes: ['recheck'], verdict: 'FIX', fix: ['T-1/F-1'], acceptance: [] }, '- T-1/F-1 open\n'));
  const { v } = execute(d, 'sess-3', run, 'batch', 2, { 'src/billing/invoice.ts': 'export const invoice = (t) => t * 0.9;\n' });
  assert.ok(v.carried > 0, JSON.stringify(v));
  assert.equal(hdr(batchFile(d, run, 'tests.md')).whole, false);
  writeFileSync(batchFile(d, run, 'review-2.md'), review(0, { round: 2, passes: ['recheck'], verdict: 'PASS', fix: [], acceptance: [] }, '- T-1/F-1 resolved\n'));
  const st = state(d, 'sess-3', run);
  assert.deepEqual([st.next, st.closing, st.batch], ['verify', true, true], JSON.stringify(st));
  const cv = cliAs(d, 'sess-3', 'verify', run).json;
  assert.deepEqual([cv.ok, cv.closing], [true, true], JSON.stringify(cv));
  const h = hdr(batchFile(d, run, 'tests.md'));
  assert.deepEqual([h.closing, h.whole], [true, true]);
  assert.equal(state(d, 'sess-3', run).next, 'commit');
  const c = cliAs(d, 'sess-3', 'commit', run).json;
  assert.deepEqual([c.ok, c.batch], [true, true], JSON.stringify(c));
});

test('kr1 batch: scope union and left-out names in the batch review input', () => {
  // R-4 (D-9, D-14): an earlier task's file keeps its content; an unreported file outside every scope and a product file go by name.
  const { d, run } = toBatch({ cfg: { product: { dir: 'docs/product' } } });
  execute(d, 'sess-3', run, 'batch', 1, {
    'src/summary/fix.ts': 'export const fix = 1;\n',
    'tools/stray.js': 'export const stray = 1;\n',
    'docs/product/roadmap.md': '# Roadmap\n',
  });
  const patch = readFileSync(batchFile(d, run, 'diff.patch'), 'utf8');
  assert.match(patch, /^diff --git a\/src\/summary\/fix\.ts b\/src\/summary\/fix\.ts$/m, 'T-2 scope is in the batch union');
  assert.doesNotMatch(patch, /tools\/stray\.js/);
  assert.doesNotMatch(patch, /docs\/product\//);
  const input = readFileSync(batchFile(d, run, 'review-input.md'), 'utf8');
  assert.match(input, /^Changed outside the task scope and not reported by the executor \(names only, not in the diff; read the file to review it\): `tools\/stray\.js`\.$/m);
  assert.match(input, /^Product-layer files changed on the branch \(not part of the task, not in the diff\): `docs\/product\/roadmap\.md`\.$/m);
  assert.doesNotMatch(input, /^- (tools\/stray\.js|docs\/product\/roadmap\.md)$/m);
});

test('batch: czerwone verify → repair (raz, po przerwie dalej repair), zielone → review-input', () => {
  const check = "if (require('fs').existsSync('red.flag')) process.exit(1);\n";
  const { d, run } = toBatch({ extra: { 'check-red.js': check }, plans: (r) => ({ t3: T3(r, { verify: ['node -e 0', 'node check-red.js'] }) }), rev3: T3_FIX });
  writeFileSync(join(d, 'red.flag'), 'x');
  writeFileSync(batchFile(d, run, 'result-1.md'), header({ schema: 'dwmt/result@1', status: 'DONE' }));
  const v = cliAs(d, 'sess-3', 'verify', run).json;
  assert.deepEqual([v.ok, v.repair], [false, true], JSON.stringify(v));
  assert.match(v.file, /\/batch\/tests\.md$/);
  let st = state(d, 'sess-3', run);
  assert.deepEqual([st.next, st.agent, st.batch], ['repair', 'dwmt-executor-high', true]);
  assert.match(st.prompt, /^Batch round 1, repair: the targeted tests in \.dwmt\/runs\/.*\/batch\/tests\.md are red\./);
  assert.match(st.output, /\/batch\/repair-1\.md$/);
  assert.equal(state(d, 'sess-8', run).next, 'repair');
  rmSync(join(d, 'red.flag'));
  writeFileSync(batchFile(d, run, 'repair-1.md'), header({ schema: 'dwmt/result@1', status: 'DONE' }));
  assert.equal(cliAs(d, 'sess-8', 'verify', run).json.result, 'pass');
  st = state(d, 'sess-8', run);
  assert.equal(st.next, 'verify', 'po zielonym verify jeszcze review-input');
  const ri = cliAs(d, 'sess-8', 'review-input', run).json;
  assert.deepEqual([ri.ok, ri.batch, hdr(ri.file).fix], [true, true, ['T-1/F-1', 'T-3/F-1']]);
});

test('batch: przerwa po starcie fixera → continue; PARTIAL archiwizowany w katalogu rundy zbiorczej', () => {
  const { d, run, st } = toBatch();
  assert.equal(st.next, 'batch');
  assert.ok(RUN(d, run).batch.started['1'], 'start fixera zapisany');
  let s2 = state(d, 'sess-7', run);
  assert.equal(s2.next, 'continue');
  assert.match(s2.prompt, /^Batch round 1\. Continue interrupted work: start from progress\.md and diff\.patch\. Repo root: /);
  writeFileSync(batchFile(d, run, 'result-1.md'), header({ schema: 'dwmt/result@1', status: 'PARTIAL' }));
  s2 = state(d, 'sess-7', run);
  assert.match(s2.prompt, /^Batch round 1\. Continue work that ended PARTIAL/);
  assert.ok(existsSync(batchFile(d, run, 'result-1.partial-1.md')) && !existsSync(batchFile(d, run, 'result-1.md')), 'PARTIAL w batch/');
  assert.ok(existsSync(batchFile(d, run, 'diff.patch')), 'diff rundy zbiorczej przed kontynuacją');
  assert.equal(state(d, 'sess-7', run).next, 'continue');
  const e = execute(d, 'sess-7', run, 'batch', 1, {});
  assert.equal(e.ri.batch, true);
});

test('batch: BLOCKED z pytaniami → ask, D-n w batch.md, unblock → continue czyta decyzje; planIssue bez pytań zamyka pozycje (bez pustego ask)', () => {
  const { d, run } = toBatch({ rev3: T3_FIX });
  writeFileSync(batchFile(d, run, 'result-1.md'), `${header({ schema: 'dwmt/result@1', status: 'BLOCKED', questions: ['Q-1'] })}### Q-1 Round half up or down?\n`);
  let st = state(d, 'sess-3', run);
  assert.deepEqual([st.next, st.questions, st.batch], ['ask', ['Q-1'], true]);
  assert.match(st.file, /\/batch\/result-1\.md$/);
  assert.match(st.hint, /batch\.md/);
  assert.equal(state(d, 'sess-4', run).next, 'ask', 'po przerwie dalej pytanie');
  appendFileSync(batchFile(d, run, 'batch.md'), '\n## Decisions\n### D-1 Round half up\nThe user chose half up.\n');
  assert.equal(cliAs(d, 'sess-4', 'unblock', run).json.ok, true);
  st = state(d, 'sess-4', run);
  assert.equal(st.next, 'continue');
  assert.match(st.prompt, /Your BLOCKED report was answered: read the decisions under ## Decisions in batch\.md before you continue\./);
  // planIssue wymieniający pozycję (całe identyfikatory: `T-3/F-10` nie jest `T-3/F-1`): zamknięta, fixer kontynuuje resztę.
  // Najpierw hook SessionStart (odczyt bez skutków): wynik BLOCKED zostaje, zamknięcie nie ginie.
  writeFileSync(batchFile(d, run, 'result-1.md'), header({ schema: 'dwmt/result@1', status: 'BLOCKED', planIssue: 'T-1/F-1 needs a schema change; T-3/F-10 is a different finding' }));
  assert.match(hook(d), new RegExp(`${run} \\(next: continue\\)`));
  assert.ok(existsSync(batchFile(d, run, 'result-1.md')) && !existsSync(batchFile(d, run, 'result-1.blocked-2.md')), 'hook niczego nie archiwizuje');
  st = state(d, 'sess-4', run);
  assert.deepEqual([st.next, st.questions, st.pendingClose], ['continue', undefined, undefined], JSON.stringify(st));
  assert.match(st.prompt, /Closed by the script after a planIssue, leave them \(they stay open\): T-1\/F-1\./);
  assert.ok(existsSync(batchFile(d, run, 'result-1.blocked-2.md')), 'state archiwizuje wynik BLOCKED');
  hook(d);
  st = state(d, 'sess-5', run);
  assert.equal(st.next, 'continue');
  assert.match(st.prompt, /leave them \(they stay open\): T-1\/F-1\./, 'zamknięcie wynika z plików, nie z run.json');
  // planIssue bez pozycji: zamyka wszystkie niepoprawione; bez reszty wynik pisze skrypt (w state), dalej verify i recenzja.
  writeFileSync(batchFile(d, run, 'result-1.md'), header({ schema: 'dwmt/result@1', status: 'BLOCKED', planIssue: 'cannot continue without the product owner' }));
  hook(d);
  assert.equal(hdr(batchFile(d, run, 'result-1.md')).status, 'BLOCKED', 'hook nie pisze wyniku za fixera');
  st = state(d, 'sess-4', run);
  assert.equal(st.next, 'verify', JSON.stringify(st));
  assert.equal(hdr(batchFile(d, run, 'result-1.md')).status, 'DONE');
  assert.equal(cliAs(d, 'sess-4', 'verify', run).json.ok, true);
  const ri = cliAs(d, 'sess-4', 'review-input', run).json;
  assert.deepEqual(hdr(ri.file).fix, [], 'zamknięte pozycje poza listą fix');
  writeFileSync(batchFile(d, run, 'review-1.md'), review(0, { passes: ['recheck'], acceptance: [] }));
  assert.equal(state(d, 'sess-4', run).next, 'commit');
  assert.deepEqual(cliAs(d, 'sess-4', 'commit', run).json.open, ['T-1/F-1', 'T-3/F-1']);
  const rep = readFileSync(batchFile(d, run, 'report.md'), 'utf8');
  assert.match(rep, /\| T-1\/F-1 \| major \| fix \| open \| Test misses 0%; closed: planIssue in round 1: T-1\/F-1 needs a schema change; T-3\/F-10 is a different finding \|/);
  assert.match(rep, /\| T-3\/F-1 \| major \| fix \| open \| .*closed: planIssue in round 1: cannot continue/);
});

test('batch: jednostka ui z parami obrazów (zadanie i runda zbiorcza), recheck ui w rundzie 2 z T-k/F-n, odłożona nowa uwaga w raporcie', () => {
  const shot = "require('fs').mkdirSync('shots',{recursive:true});require('fs').writeFileSync('shots/summary.png','png');\n";
  const R2 = '\n### R-2 [medium] The summary matches the agreed mockup\n- Method: ui\n- Mockup: mockups/summary.png\n- Shot: summary\n- Area: summary\n';
  const { d } = repo28({ ui: { shots: 'shots' } }, { 'mockups/summary.png': 'mock', 'shot.js': shot, '.gitignore': 'shots/\n' });
  const run = start(d, 'ui');
  writePlans(d, run, { t2: T2(run, { verify: ['node -e "2"', 'node shot.js'], risks: ['R-1', 'R-2'], riskText: R2 }) });
  assert.equal(state(d, 'sess-1', run).next, 'implement');
  task(d, 'sess-1', run, 1, { 'src/billing/discount.ts': 'export class Discount {}\n' });
  assert.equal(state(d, 'sess-2', run).next, 'implement');
  const e2 = execute(d, 'sess-2', run, 2, 1, { 'src/summary/view.ts': 'export const view = () => "-";\n' });
  assert.deepEqual(e2.ri.units.map((u) => u.unit), ['all', 'ui']);
  writeFileSync(runFile(d, run, 'review-1-1.md', 2), review(2, {}));
  writeFileSync(runFile(d, run, 'review-1-2.md', 2), review(2, { passes: ['visual', 'pragmatism'], defer: ['F-1'], acceptance: [], risks: ['R-2 proven'] }, '### F-1 [minor] Summary: discount label grey, mockup black\n- Evidence: `src/summary/view.ts:1`\n'));
  let st = state(d, 'sess-2', run);
  assert.equal(st.next, 'commit');
  assert.deepEqual(hdr(runFile(d, run, 'review-1.md', 2)).batch, ['F-1 deferred-visible visible ui']);
  assert.equal(cliAs(d, 'sess-2', 'commit', run).json.next, 'handoff');
  task(d, 'sess-3', run, 3, { 'src/export/csv.ts': 'export const csv = () => "10";\n' });
  assert.equal(state(d, 'sess-3', run).next, 'batch');
  const e1 = execute(d, 'sess-3', run, 'batch', 1, { 'src/summary/view.ts': 'export const view = () => "black";\n' });
  assert.deepEqual(e1.ri.units.map((u) => [u.unit, hdr(u.file).fix]), [['recheck', []], ['ui', ['T-2/F-1']]]);
  assert.ok(existsSync(batchFile(d, run, 'ui/mockup-T-2-R-2.png')) && existsSync(batchFile(d, run, 'ui/r1/summary.png')), 'para obrazów rundy zbiorczej');
  st = state(d, 'sess-3', run);
  assert.deepEqual([st.next, st.units.map((u) => u.agent)], ['review', ['dwmt-reviewer', 'dwmt-ui-verifier']]);
  writeFileSync(batchFile(d, run, 'review-1-1.md'), review(0, { passes: ['recheck'], acceptance: [] }));
  writeFileSync(batchFile(d, run, 'review-1-2.md'), review(0, { passes: ['visual', 'pragmatism'], verdict: 'FIX', fix: ['T-2/F-1'], acceptance: [], risks: ['T-2/R-2 unproven'] }, '### T-2/F-1 open\n- mockup black / app grey\n'));
  st = state(d, 'sess-3', run);
  assert.deepEqual([st.next, st.round], ['batch', 2], JSON.stringify(st));
  assert.deepEqual(hdr(batchFile(d, run, 'review-1.md')).fix, ['T-2/F-1'], 'scalenie nie przenumerowuje pozycji');
  const e2b = execute(d, 'sess-3', run, 'batch', 2, {});
  assert.deepEqual(e2b.ri.units.map((u) => [u.unit, hdr(u.file).fix]), [['recheck', []], ['ui', ['T-2/F-1']]], 'runda 2: uwaga ui z nagłówka T-k/F-n wraca do weryfikatora');
  writeFileSync(batchFile(d, run, 'review-2-1.md'), review(0, { round: 2, passes: ['recheck'], acceptance: [] }));
  writeFileSync(batchFile(d, run, 'review-2-2.md'), review(0, { round: 2, passes: ['visual', 'pragmatism'], defer: ['F-5'], acceptance: [] }, '- T-2/F-1 resolved\n### F-5 [minor] Header spacing differs\n- Evidence: `src/summary/view.ts:1`\n'));
  assert.equal(state(d, 'sess-3', run).next, 'commit');
  assert.deepEqual(hdr(batchFile(d, run, 'review-2.md')).defer, ['F-5'], 'nowa uwaga nad numerem pozycji bez przenumerowania');
  assert.deepEqual(cliAs(d, 'sess-3', 'commit', run).json.open, []);
  writeFileSync(runFile(d, run, 'goal-check.md'), `---\nschema: dwmt/goal-check@1\nitems:\n  - {id: I-1, element: "Discount", status: delivered, task: T-1, evidence: "T-1/report.md: AC-1 met"}\ngaps: 0\n---\n`);
  assert.equal(state(d, 'sess-3', run).next, 'finish');
  assert.equal(cliAs(d, 'sess-3', 'finish', run).json.status, 'squashed');
  const fh = hdr(runFile(d, run, 'final-report.md'));
  assert.ok(fh.deferred.includes('batch/F-5'), JSON.stringify(fh.deferred));
  assert.ok(!fh.deferred.includes('T-2/F-1'));
  assert.doesNotMatch(/### For your assessment\n\n([\s\S]*?)\n\n###/.exec(readFileSync(runFile(d, run, 'final-report.md'), 'utf8'))[1], /grey/);
  assert.match(readFileSync(join(d, '.dwmt', 'deferred.md'), 'utf8'), /- batch\/F-5 \[minor\] Header spacing differs/);
});

test('2.8 bez plan.md (import planu zadania) i inline: recenzja FIX jak w 2.7 (runda poprawek, bez podziału)', () => {
  for (const mode of ['single', 'inline']) {
    const d = repo();
    const run = prepared(d, `nb${mode}`, mode);
    assert.equal(RUN(d, run).rules, RULES);
    const st = state(d, 'sess-1', run);
    assert.deepEqual([st.next, st.agent ?? null], ['implement', mode === 'single' ? 'dwmt-executor' : null]);
    writeFileSync(join(d, 'b.txt'), 'b\n');
    if (mode === 'single') writeFileSync(runFile(d, run, 'result-1.md'), header({ schema: 'dwmt/result@1', status: 'DONE' }));
    assert.equal(cliAs(d, 'sess-1', 'verify', run).json.ok, true);
    assert.equal(cliAs(d, 'sess-1', 'review-input', run).json.ok, true);
    writeFileSync(runFile(d, run, 'review-1.md'), `${header({ schema: 'dwmt/review@1', round: 1, passes: ['correctness'], verdict: 'FIX', fix: ['F-1'], defer: ['F-2'], visible: ['F-2'] })}${finding('F-1', 'major', 'x', 'b.txt:1')}${finding('F-2', 'minor', 'y', 'b.txt:1')}`);
    const s2 = state(d, 'sess-1', run);
    assert.deepEqual([s2.next, hdr(runFile(d, run, 'review-1.md')).now, RUN(d, run).batch], ['fix', undefined, undefined], mode);
  }
});

test('rozjazd 2.8: pliki [new] wcześniejszego zadania od k nie dają fałszywej znikającej kotwicy; przyczyna wspólna dla T-2 i T-3', () => {
  const { d } = repo28();
  const run = start(d, 'nw');
  asRules(d, run, '2.8');
  writePlans(d, run, {
    t2: T2(run, { changes: ['[change] `src/summary/view.ts#view` — shows the discount; test first: 10 → "-10%"', '[new presentational component] `DiscountLine` in `src/summary/line.ts` — renders the discount line'] }),
    t3: T3(run, { readFirst: ['src/billing/invoice.ts#invoice', 'src/export/csv.ts#csv', 'src/summary/line.ts#DiscountLine', 'src/billing/discount.ts#Discount'] }),
  });
  assert.equal(state(d, 'sess-1', run).next, 'implement');
  const note = '`src/billing/discount.ts#Discount`: percent is a fraction';
  execute(d, 'sess-1', run, 1, 1, { 'src/billing/discount.ts': 'export class Discount {}\n' }, { laterNotes: [note] });
  writeFileSync(runFile(d, run, 'review-1.md', 1), review(1, {}));
  assert.equal(cliAs(d, 'sess-1', 'commit', run).json.next, 'handoff');
  const st = state(d, 'sess-2', run);
  assert.deepEqual([st.next, st.causes], ['replan', [`for T-2, T-3: T-1 note for later tasks: ${note}`]], JSON.stringify(st));
  // Bez plików [new] T-2 kotwica T-3 na src/summary/line.ts wyglądałaby na znikającą.
  const root = join(d, '.dwmt', 'runs', run);
  assert.match(driftCauses({ top: d, root, run: RUN(d, run), cfg: { git: {} }, k: 3 }).map((c) => c.text).join('\n'), /src\/summary\/line\.ts \(read_first in the plan of T-3\) is not on HEAD/);
  assert.equal(driftCauses({ top: d, root, run: RUN(d, run), cfg: { git: {} }, k: 3, extra: ['src/summary/line.ts'] }).filter((c) => c.kind === 'anchor').length, 0);
  assert.equal(cliAs(d, 'sess-2', 'replan-done', run, '2', '--result', 'unchanged').json.handled, 1);
});

test('F1: podział zapisany, a komenda przerwana przed zapisem run.json → state odtwarza pozycje z nagłówka (powód, widoczność)', () => {
  const { d } = repo28();
  const run = start(d, 'crash');
  writePlans(d, run);
  assert.equal(state(d, 'sess-1', run).next, 'implement');
  execute(d, 'sess-1', run, 1, 1, { 'src/billing/discount.ts': 'export class Discount {}\n' });
  writeFileSync(runFile(d, run, 'review-1.md', 1), review(1, { verdict: 'FIX', fix: ['F-1', 'F-2'], defer: ['F-3'], visible: ['F-3'] },
    `${finding('F-1', 'blocker', 'Negative total', 'src/billing/invoice.test.ts:1')}${finding('F-2', 'major', 'Missing 0%', 'src/billing/invoice.test.ts:2')}${finding('F-3', 'minor', 'Label', 'src/billing/discount.ts:1')}`));
  const c = cliAs(d, 'sess-1', 'commit', run);
  assert.equal(c.code, 1, 'commit w stanie fix odmawia po podziale');
  assert.deepEqual(hdr(runFile(d, run, 'review-1.md', 1)).batch, ['F-2 fix', 'F-3 deferred-visible visible']);
  assert.equal(RUN(d, run).batch, undefined, 'run.json bez pozycji (przerwana komenda)');
  assert.equal(state(d, 'sess-1', run).next, 'fix');
  assert.deepEqual(RUN(d, run).batch.items.map((x) => [x.id, x.reason, x.visible, x.severity, x.title]), [
    ['T-1/F-2', 'fix', false, 'major', 'Missing 0%'], ['T-1/F-3', 'deferred-visible', true, 'minor', 'Label'],
  ]);
});

test('F3, F4, F8: dowód ze ścieżką z nawiasami, bez Evidence null, tytuł bez pogrubień; gołe F-n w recenzji rundy zbiorczej; wersje reguł', () => {
  const sec = (ev) => `### F-1 **[major]** **Route** param\n${ev}\n- Test: \`src/other.ts:3\`\n`;
  assert.equal(evidenceFile(sec('- Evidence: `app/(auth)/[id]/page.tsx:12`'), '/w/repo'), 'app/(auth)/[id]/page.tsx');
  assert.equal(evidenceFile(sec('- **Evidence:** app/(auth)/[id]/page.tsx:12:4, see above'), '/w/repo'), 'app/(auth)/[id]/page.tsx');
  assert.equal(evidenceFile(sec('- Evidence: `src/a b.ts`'), '/w/repo'), 'src/a', 'pierwszy token bez spacji');
  assert.equal(evidenceFile(sec('- Impact: wrong'), '/w/repo'), null, 'bez linii Evidence: null, nie „Test:”');
  assert.equal(evidenceFile(sec('- Evidence: `/w/repo/src/x.ts:9`'), '/w/repo'), 'src/x.ts');
  assert.deepEqual([findingInfo([sec('- Evidence: `a.ts:1`')], 'F-1', '/w').title, findingInfo([sec('')], 'F-1', '/w').severity], ['Route param', 'major']);
  // K2 R-2 (C-2): znacznik podłogi podnosi wagę do major i nie zostaje w tytule; bez znacznika floor null.
  const fl = findingInfo(['### F-3 [minor] [floor: data-loss] Wrong root deletes an unrelated tree\n- Evidence: `src/a.ts:1`\n'], 'F-3', '/w');
  assert.deepEqual([fl.severity, fl.title, fl.floor], ['major', 'Wrong root deletes an unrelated tree', 'data-loss']);
  const nf = findingInfo([sec('')], 'F-1', '/w');
  assert.deepEqual([nf.severity, nf.title, nf.floor], ['major', 'Route param', null]);
  assert.equal(findingInfo(['### F-2 [blocker] [floor: security] Leak\n'], 'F-2', '/w').severity, 'blocker', 'podłoga nie obniża');
  // F4: recenzent zgubił przedrostek; niejednoznaczne F-n otwiera wszystkie pasujące; nowe F-n nad numerem pozycji zostaje.
  const root = mkdtempSync(join(tmpdir(), 'dwmt-bare-'));
  mkdirSync(join(root, 'batch'), { recursive: true });
  const item = (k, f) => ({ id: `T-${k}/${f}`, task: k, finding: f, reason: 'fix', title: f });
  const res = (items, fix) => {
    writeFileSync(join(root, 'batch', 'review-1.md'), review(0, { verdict: 'FIX', fix, acceptance: [] }));
    return batchItemResults(root, { batch: { items } }).map((x) => `${x.id} ${x.result}${x.note ? ' *' : ''}`);
  };
  assert.deepEqual(res([item(1, 'F-6'), item(2, 'F-2')], ['F-6']), ['T-1/F-6 open', 'T-2/F-2 resolved']);
  assert.deepEqual(res([item(1, 'F-6'), item(2, 'F-6')], ['F-6']), ['T-1/F-6 open *', 'T-2/F-6 open *']);
  assert.deepEqual(resolveIds(['F-9', 'F-6'], [item(1, 'F-6')]).ids, ['F-9', 'T-1/F-6']);
  // F8: wersje jako liczby całkowite major.minor.
  assert.equal(rulesAtLeast({ rules: '2.10' }, '2.8'), true);
  assert.equal(rulesAtLeast({ rules: '2.7' }, '2.8'), false);
  assert.deepEqual([is27({}), is27({ rules: '2.6' }), is27({ rules: '2.7' }), is28({ rules: '2.10' }), is28({ rules: '3.0' })], [false, false, true, true, true]);
});
