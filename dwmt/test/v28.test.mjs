import './tmp-root.mjs';
// v2.8 (docs/v28-working-note.md, spec dwmt v2.8): runda zbiorcza (podział fix na now/batch, stan batch, verify, recheck,
// commit, raporty), replan od k do końca, decyzje [visible] na liście UAT, artefakty po angielsku, ścieżki względne,
// uat record bez linii do roadmapy; przebiegi 2.7 i `review.batch: false` bez zmian.
// Fikstury syntetyczne i neutralne wobec projektu (dwmt jest generyczny): rabat w rozliczeniach, podsumowaniu i eksporcie.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseYaml, splitHeader, mergeReviews, maxFinding } from '../scripts/dwmt.mjs';
import { splitFix, findingSection, evidenceFile, deferredIdsOf, triageOf, REASONS } from '../scripts/batch.mjs';
import { SCRIPT, DWMT_HOME, repo, gitIn, header, runFile, asV27, asRules } from './helpers.mjs';

import { cliAs, hdr, RUN, fwd, esc, FILES, PLAN, TASK, T1, T2, T3, repo28, start, writePlans, review, finding, execute } from './fixtures28.mjs';

// ---------- jednostkowo: podział, sekcje uwag, numeracja ----------

test('v2.8 podział: ostatnia runda — otwarty blocker zostaje teraz (pytanie), reszta do rundy zbiorczej (open-after-last-round); sekcje T-k/F-n', () => {
  const r1 = review(1, { fix: ['F-3'] }, finding('F-3', 'blocker', 'Total goes negative', 'src/a.ts:4'));
  const r2 = review(1, { round: 2, verdict: 'FIX', fix: ['F-3', 'F-6'] }, `### F-3 open\nstill negative\n\n${finding('F-6', 'major', 'Label off by one', '/repo/src/b.ts:9')}`);
  const out = splitFix({
    top: '/repo', root: join(tmpdir(), 'dwmt-none'), run: { count: 3, tasks: [] }, cfg: { review: { maxRounds: 2 } },
    ctx: { k: 1, t: { maxRounds: 2, units: {} } }, round: 2, h: parseYaml(splitHeader(r2).yaml), texts: [r1, r2],
  });
  assert.deepEqual(out.now, ['F-3'], 'otwarty blocker: dalej pytanie do użytkownika (ask-rounds)');
  assert.deepEqual(out.items.map((x) => [x.id, x.reason, x.severity, x.file, x.review, x.title]), [['T-1/F-6', 'open-after-last-round', 'major', 'src/b.ts', 'tasks/1/review-2.md', 'Label off by one']]);
  // Sekcja `F-3` nie trafia w `T-2/F-3`; numeracja rechecku pomija pozycje T-k/F-n.
  const text = '### T-2/F-3 [major] item\nx\n\n### F-3 [minor] new\ny\n';
  assert.match(findingSection(text, 'F-3'), /^### F-3 \[minor\] new/);
  assert.match(findingSection(text, 'T-2/F-3'), /^### T-2\/F-3 \[major\] item\nx$/);
  assert.equal(maxFinding('fix: [T-2/F-9, F-2]'), 2);
  const merged = mergeReviews([
    { name: 'recheck', text: review(1, { verdict: 'FIX', fix: ['T-2/F-3', 'F-1'], visible: ['F-1'] }, '### T-2/F-3 open\n### F-1 [minor] a\n') },
    { name: 'ui', text: review(1, { verdict: 'FIX', fix: ['F-1'] }, '### F-1 [major] b\n') },
  ]);
  const mh = parseYaml(splitHeader(merged).yaml);
  assert.deepEqual([mh.fix, mh.visible], [['T-2/F-3', 'F-1', 'F-2'], ['F-1']]);
  assert.equal(evidenceFile('### F-1 [major] x\n- Evidence: `C:/w/repo/src/x.ts:12`', 'C:/w/repo'), 'src/x.ts');
});

test('K2 R-1: deferredIdsOf — drop uwagi z podłogą bez kontrdowodu plik:linia jest odłożony; bez podłogi nigdy', () => {
  const body = (reason) => `### F-1 [minor] Copy tweak\n- Evidence: \`src/a.ts:1\`\n\n### F-2 [minor] [floor: security] Token logged\n- Evidence: \`src/log.ts:3\`\n\n### F-3 [minor] Naming\n\n## pragmatism\n- F-1: defer — later\n- F-2: drop — ${reason}\n- F-3: drop — taste\n`;
  const h = { defer: ['F-1'], drop: ['F-2', 'F-3'] };
  assert.deepEqual(deferredIdsOf(h, [body('speculative')]), ['F-1', 'F-2']);
  assert.deepEqual(deferredIdsOf(h, [body('redacted before write in dwmt/scripts/batch.mjs:62')]), ['F-1']);
  assert.deepEqual(deferredIdsOf({ defer: [], drop: ['F-3'] }, body('x')), [], 'drop bez podłogi nie liczy się');
  // Obie formy linii pragmatism (D-12).
  assert.deepEqual(triageOf('- F-2 `drop` — guarded at src/x.ts:4\n', 'F-2'), { triage: 'drop', reason: 'guarded at src/x.ts:4' });
  assert.deepEqual(triageOf('- F-2: defer — later\n- F-21: fix — no\n', 'F-2'), { triage: 'defer', reason: 'later' });
  assert.equal(triageOf('- F-21: fix — no\n', 'F-2'), null);
});

test('K2 R-1: splitFix — odłożona uwaga z podłogą (major) idzie do rundy zbiorczej jako deferred-major, minor zostaje, widoczna deferred-visible', () => {
  const body = `${finding('F-4', 'minor] [floor: wrong-results', 'Totals rounded twice', 'src/t.ts:7')}${finding('F-5', 'minor', 'Spacing', 'src/s.ts:2')}## pragmatism\n- F-4: defer — outside the brief\n- F-5: defer — cosmetic\n`;
  const split = (obj) => {
    const r = review(1, { defer: ['F-4', 'F-5'], ...obj }, body);
    return splitFix({
      top: '/repo', root: join(tmpdir(), 'dwmt-none'), run: { count: 1, tasks: [] }, cfg: { review: { maxRounds: 2 } },
      ctx: { k: 1, t: { maxRounds: 2, units: {} } }, round: 1, h: parseYaml(splitHeader(r).yaml), texts: [r],
    });
  };
  assert.deepEqual(split({}).items.map((x) => ({ id: x.id, reason: x.reason, severity: x.severity })), [{ id: 'T-1/F-4', reason: 'deferred-major', severity: 'major' }]);
  assert.equal(split({}).items[0].title, 'Totals rounded twice');
  assert.deepEqual(split({ visible: ['F-4'] }).items.map((x) => [x.id, x.reason]), [['T-1/F-4', 'deferred-visible']]);
  // Drop uwagi z podłogą bez kontrdowodu: odłożona, więc też do rundy zbiorczej.
  assert.deepEqual(split({ defer: ['F-5'], drop: ['F-4'] }).items.map((x) => [x.id, x.reason]), [['T-1/F-4', 'deferred-major']]);
  assert.ok(REASONS.includes('deferred-major'));
});

// ---------- sprint 2.8: podział, runda zbiorcza, raporty ----------

test('v2.8 sprint: fix → now/batch (later task, blocker, deferred-visible, last round, last task), batch → verify → recheck → commit → goal-check, raporty i UAT', () => {
  const { d: main, g } = repo28();
  mkdirSync(join(main, '.dwmt', 'supervisor', 'input'), { recursive: true });
  writeFileSync(join(main, '.dwmt', 'supervisor', 'input', 'S1.md'), `${header({ schema: 'dwmt/sprint-input@1', sprint: 'S1' })}Discount on the invoice; the summary and the export show it.\n`);
  const d = join(main, '..', `${main.split(/[\\/]/).pop()}-s1`);
  g('worktree', 'add', '-q', '-b', 'sprint', d);
  const run = start(d, 'batch', '--sprint', 'S1');
  const status = () => JSON.parse(readFileSync(join(main, '.dwmt', 'supervisor', 'status', 'S1.json'), 'utf8'));
  const top = fwd(d);
  assert.equal(RUN(d, run).rules, '2.10');

  // Architekt: prompt po angielsku (D), ścieżki względne z katalogiem głównym raz (E).
  let st = cliAs(d, 'sess-1', 'state', run).json;
  assert.equal(st.next, 'plan');
  assert.match(st.prompt, new RegExp(`Repo root: ${esc(top)}\\. Task: \\.dwmt/runs/${esc(run)}/task\\.md\\. Sprint answers: \\.dwmt/runs/${esc(run)}/answers\\.md\\.`));
  assert.match(st.prompt, /Artifacts and explorer answers: English; the user's language \(questions Q-n, ## UAT steps, \[visible\] decision titles\): en\./);
  assert.equal(st.prompt.split(top).length - 1, 1, 'katalog główny repo raz');
  assert.match(st.prompt, /Templates: [A-Za-z]:?\/.*\/templates\/artifacts\/plan\.md|Templates: \/.*\/templates\/artifacts\/plan\.md/, 'szablony pluginu pełną ścieżką');
  assert.match(st.output, new RegExp(`^${esc(top)}/\\.dwmt/runs/.*plan\\.md$`), 'output dla orkiestratora pełną ścieżką');
  writePlans(d, run);

  // T-1, runda 1: wykonawca z promptem względnym.
  st = cliAs(d, 'sess-1', 'state', run).json;
  assert.deepEqual([st.next, st.agent], ['implement', 'dwmt-executor'], JSON.stringify(st));
  assert.match(st.prompt, new RegExp(`^Round 1\\. Repo root: ${esc(top)}\\. Artifacts: English\\. Brief: \\.dwmt/runs/${esc(run)}/tasks/1/brief\\.md\\. Progress \\(append only\\): \\.dwmt/runs/${esc(run)}/tasks/1/progress\\.md\\. Result: \\.dwmt/runs/${esc(run)}/tasks/1/result-1\\.md\\.`));
  assert.equal(st.prompt.split(top).length - 1, 1);
  execute(d, 'sess-1', run, 1, 1, { 'src/billing/discount.ts': 'export class Discount {}\n' });
  st = cliAs(d, 'sess-1', 'state', run).json;
  assert.equal(st.prompt, `Repo root: ${top}. Artifacts: English. Input: .dwmt/runs/${run}/tasks/1/review-input.md. Output: .dwmt/runs/${run}/tasks/1/review-1.md.`);
  writeFileSync(runFile(d, run, 'review-1.md', 1), review(1, { verdict: 'FIX', counts: { blocker: 1, major: 2, minor: 2 }, fix: ['F-1', 'F-2', 'F-3'], defer: ['F-4', 'F-5'], visible: ['F-4'] },
    `## correctness\n${finding('F-1', 'major', 'Rounding in invoice', 'src/billing/invoice.ts:3')}${finding('F-2', 'major', 'Test misses 0%', 'src/billing/invoice.test.ts:2')}${finding('F-3', 'blocker', 'Negative total', 'src/billing/invoice.test.ts:4')}${finding('F-4', 'minor', 'Label shows 10.0%', 'src/billing/discount.ts:1')}${finding('F-5', 'minor', 'Naming', 'src/billing/discount.ts:1')}`));
  st = cliAs(d, 'sess-1', 'state', run).json;
  let rh = hdr(runFile(d, run, 'review-1.md', 1));
  assert.deepEqual([rh.now, rh.batch], [['F-1', 'F-3'], ['F-2 fix', 'F-4 deferred-visible visible']], 'F-1 w kotwicy T-3, F-3 blocker: teraz; F-2 i odłożona widoczna F-4: runda zbiorcza');
  assert.deepEqual([rh.fix, rh.visible], [['F-1', 'F-2', 'F-3'], ['F-4']], 'listy recenzenta zostają');
  assert.deepEqual([st.next, st.agent, st.round], ['fix', 'dwmt-executor-high', 2]);
  assert.match(st.prompt, /Fix mode: fix the items on the now list in the header of \.dwmt\/runs\/.*\/tasks\/1\/review-1\.md/);
  assert.deepEqual(RUN(d, run).batch.items.map((x) => [x.id, x.reason, x.severity, x.file, x.review, x.visible]), [
    ['T-1/F-2', 'fix', 'major', 'src/billing/invoice.test.ts', 'tasks/1/review-1.md', false],
    ['T-1/F-4', 'deferred-visible', 'minor', 'src/billing/discount.ts', 'tasks/1/review-1.md', true],
  ]);
  // Runda 2 (ostatnia): recheck tylko listy `now`; nowa uwaga fix (widoczna, w kotwicy T-3) idzie do rundy zbiorczej.
  const { ri } = execute(d, 'sess-1', run, 1, 2, { 'src/billing/invoice.ts': 'export const invoice = (t, p = 0) => t - t * p / 100;\n' });
  assert.deepEqual(hdr(ri.file).fix, ['F-1', 'F-3']);
  writeFileSync(runFile(d, run, 'review-2.md', 1), review(1, { round: 2, passes: ['recheck'], verdict: 'FIX', fix: ['F-6'], visible: ['F-6'] },
    `## recheck\n- F-1 resolved\n- F-3 resolved\n${finding('F-6', 'major', 'Label rounds 9.95 up', 'src/billing/invoice.ts:9')}`));
  st = cliAs(d, 'sess-1', 'state', run).json;
  rh = hdr(runFile(d, run, 'review-2.md', 1));
  assert.deepEqual([rh.now, rh.batch], [[], ['F-6 open-after-last-round visible']], 'ostatnia runda: tylko blocker teraz');
  // kt (D-13): round 2 carried its commands, so the changed tree gets one closing whole verify before the commit.
  assert.deepEqual([st.next, st.closing], ['verify', true], JSON.stringify(st));
  const vc1 = cliAs(d, 'sess-1', 'verify', run).json;
  assert.deepEqual([vc1.ok, vc1.closing], [true, true], JSON.stringify(vc1));
  assert.equal(hdr(runFile(d, run, 'tests.md', 1)).closing, true);
  st = cliAs(d, 'sess-1', 'state', run).json;
  assert.equal(st.next, 'commit');
  const c1 = cliAs(d, 'sess-1', 'commit', run).json;
  assert.equal(c1.next, 'handoff', JSON.stringify(c1));
  const rep1 = hdr(runFile(d, run, 'report.md', 1));
  assert.deepEqual([rep1.status, rep1.batched], ['PASS', ['F-2 fix', 'F-4 deferred-visible', 'F-6 open-after-last-round']]);

  // T-2: puste `now` → commit bez rundy poprawek; odłożona uwaga jednostki ui jest widoczna z definicji.
  st = cliAs(d, 'sess-2', 'state', run).json;
  assert.equal(st.next, 'implement', JSON.stringify(st));
  execute(d, 'sess-2', run, 2, 1, { 'src/summary/view.ts': 'export const view = (p) => `-${p}%`;\n' });
  const rj = RUN(d, run);
  rj.tasks[1].units = { 1: [{ id: 1, name: 'all' }, { id: 2, name: 'ui', agent: 'dwmt-ui-verifier' }] };
  writeFileSync(runFile(d, run, 'run.json'), JSON.stringify(rj, null, 2));
  writeFileSync(runFile(d, run, 'review-1.md', 2), review(2, { verdict: 'FIX', fix: ['F-1'], defer: ['F-2'], units: ['all', 'ui'] },
    `\n# Unit all\n\n${finding('F-1', 'major', 'Summary ignores 0%', 'src/summary/view.ts:2')}\n# Unit ui\n\n${finding('F-2', 'minor', 'Summary: discount label grey, mockup black', 'src/summary/view.ts:1')}`));
  st = cliAs(d, 'sess-2', 'state', run).json;
  assert.equal(st.next, 'commit', 'puste now: bez rundy poprawek');
  assert.match(st.hint, /do rundy zbiorczej: F-1, F-2/);
  assert.equal(cliAs(d, 'sess-2', 'commit', run).json.next, 'handoff');

  // T-3 (ostatnie): nic nie jest „późniejsze”, więc major w pliku z kotwic innych zadań idzie do rundy zbiorczej.
  st = cliAs(d, 'sess-3', 'state', run).json;
  assert.equal(st.next, 'implement');
  execute(d, 'sess-3', run, 3, 1, { 'src/export/csv.ts': 'export const csv = (p) => `${p}`;\n' });
  writeFileSync(runFile(d, run, 'review-1.md', 3), review(3, { verdict: 'FIX', fix: ['F-1'] }, finding('F-1', 'major', 'Export uses the old invoice', 'src/billing/invoice.ts:3')));
  st = cliAs(d, 'sess-3', 'state', run).json;
  assert.equal(st.next, 'commit');
  const c3 = cliAs(d, 'sess-3', 'commit', run).json;
  assert.equal(c3.ok, true);
  assert.equal(c3.next, undefined);

  // Runda zbiorcza: state → batch (świeży executor-high, prompt z notatki, ścieżki względne), status running/batch.
  st = cliAs(d, 'sess-3', 'state', run).json;
  const B = `.dwmt/runs/${run}/batch`;
  assert.deepEqual([st.next, st.agent, st.batch, st.round, st.items], ['batch', 'dwmt-executor-high', true, 1, 6], JSON.stringify(st));
  assert.equal(st.prompt, `Batch round 1. Repo root: ${top}. Artifacts: English. Batch: ${B}/batch.md. Progress (append only): ${B}/progress.md. Result: ${B}/result-1.md. The script runs \`verify\` in ${st.prompt.match(/runs `verify` in (\S+)\./)[1]}. Fix mode: fix every item of the batch; read the plan of an item's task for context. List \`fixed\` and \`notReproduced\` by the items' T-k/F-n (or T-k/KR-n) ids.`);
  assert.deepEqual([status().state, status().step, status().batchStep], ['running', 'batch', 'batch']);
  const bh = hdr(runFile(d, run, 'batch/batch.md'));
  assert.deepEqual([bh.schema, bh.items, bh.tasks], ['dwmt/batch@1', ['T-1/F-2', 'T-1/F-4', 'T-1/F-6', 'T-2/F-1', 'T-2/F-2', 'T-3/F-1'], ['T-1', 'T-2', 'T-3']]);
  const batchText = readFileSync(runFile(d, run, 'batch/batch.md'), 'utf8');
  assert.match(batchText, new RegExp(`### T-1/F-2 \\[major\\] Test misses 0%\\n- Evidence: \`src/billing/invoice\\.test\\.ts:2\`\\n- Impact: wrong total shown\\n- Test: 100 with 10 → 90\\n- Reason: fix\\n- Task plan: \`\\.dwmt/runs/${esc(run)}/tasks/1/brief\\.md\``));
  assert.match(batchText, /### T-2\/F-2 \[minor\] Summary: discount label grey, mockup black\n[\s\S]*?- Reason: deferred-visible \(visible to the user\)/);
  assert.equal(cliAs(d, 'sess-3', 'finish', run).code, 1, 'finish czeka na rundę zbiorczą');

  // Runda 1: verify = suma komend zadań pozycji (bez powtórzeń, w kolejności zadań) + verify.targeted.
  const e1 = execute(d, 'sess-3', run, 'batch', 1, { 'src/billing/invoice.test.ts': '// test 0%\n' }, { fixed: [{ id: 'T-1/F-2', redTest: 'zero' }], notReproduced: ['T-2/F-1: the view already handles 0%'] });
  assert.deepEqual(e1.v.commands, ['0 node -e "1"', '0 node -e 0', '0 node -e "2"', '0 node -e "3"']);
  assert.match(e1.v.file, /\/batch\/tests\.md$/);
  const ih = hdr(e1.ri.file);
  assert.deepEqual([ih.fix, ih.passes, e1.ri.batch], [['T-1/F-2', 'T-1/F-4', 'T-1/F-6', 'T-2/F-1', 'T-2/F-2', 'T-3/F-1'], ['recheck'], true]);
  assert.match(ih.delta, /\/batch\/diff\.patch$/, 'runda 1: delta = cały diff od commitu ostatniego zadania');
  assert.match(readFileSync(join(d, '.dwmt', 'runs', run, 'batch', 'diff.patch'), 'utf8'), /invoice\.test\.ts/);
  const input = readFileSync(e1.ri.file, 'utf8');
  assert.match(input, /## Fix batch[\s\S]*## Re-review[\s\S]*### T-1\/F-6 \[major\] Label rounds 9\.95 up/);
  assert.match(input, /## Fixer: NOT_REPRODUCED\n\n- T-2\/F-1: the view already handles 0%/);
  st = cliAs(d, 'sess-3', 'state', run).json;
  assert.deepEqual([st.next, st.batch, st.prompt], ['review', true, `Repo root: ${top}. Artifacts: English. Input: ${B}/review-input.md. Output: ${B}/review-1.md.`]);
  writeFileSync(runFile(d, run, 'batch/review-1.md'), review(0, { passes: ['recheck'], verdict: 'FIX', fix: ['T-1/F-6'], acceptance: [] }, '- T-1/F-6 open: still rounds up\n'));
  st = cliAs(d, 'sess-3', 'state', run).json;
  assert.deepEqual([st.next, st.round], ['batch', 2]);
  assert.match(st.prompt, new RegExp(`^Batch round 2\\. .*Fix mode: fix the items on the fix list in the header of ${esc(B)}/review-1\\.md; diff: ${esc(B)}/diff\\.patch\\.`));
  const e2 = execute(d, 'sess-3', run, 'batch', 2, {});
  assert.deepEqual([hdr(e2.ri.file).fix, /fix-delta\.patch$/.test(hdr(e2.ri.file).delta)], [['T-1/F-6'], true]);
  writeFileSync(runFile(d, run, 'batch/review-2.md'), review(0, { round: 2, passes: ['recheck'], verdict: 'FIX', fix: ['T-1/F-6'], acceptance: [] }, '- T-1/F-6 open\n'));
  st = cliAs(d, 'sess-3', 'state', run).json;
  assert.deepEqual([st.next, st.batch], ['commit', true], 'ostatnia runda bez blockera: commit, pozycja zostaje otwarta');
  const bc = cliAs(d, 'sess-3', 'commit', run).json;
  assert.deepEqual([bc.ok, bc.batch, bc.open], [true, true, ['T-1/F-6']], JSON.stringify(bc));
  assert.match(gitIn(d)('log', '-1', '--format=%B'), new RegExp(`^Fix batch: 6 review finding\\(s\\)[\\s\\S]*\\ndwmt-run: ${esc(run)} batch$`));
  const br = hdr(runFile(d, run, 'batch/report.md'));
  assert.deepEqual([br.schema, br.rounds, br.items], ['dwmt/batch-report@1', 2, [
    'T-1/F-2 fix resolved', 'T-1/F-4 deferred-visible resolved', 'T-1/F-6 open-after-last-round open', 'T-2/F-1 fix notReproduced', 'T-2/F-2 deferred-visible resolved', 'T-3/F-1 fix resolved',
  ]]);

  // Potem kontrola celu i finish jak dotąd.
  st = cliAs(d, 'sess-3', 'state', run).json;
  assert.deepEqual([st.next, st.agent, st.batch], ['goal-check', 'dwmt-checker', undefined]);
  assert.match(st.prompt, new RegExp(`Repo root: ${esc(top)}\\. Task: \\.dwmt/runs/${esc(run)}/task\\.md\\..* Fix batch report: \\.dwmt/runs/${esc(run)}/batch/report\\.md\\. Template: .*Artifacts: English; gap reasons in the user's language: en\\. The full suite \\(.*\\) runs after you, at finish.*not a gap\\. Final state of the sprint criteria after the fix batch \\(it supersedes the statuses in the task reports\\): AC-1 met; AC-2 met; AC-3 met\\.$`));
  writeFileSync(runFile(d, run, 'goal-check.md'), `---\nschema: dwmt/goal-check@1\nitems:\n  - {id: I-1, element: "Discount", status: delivered, task: T-1, evidence: "T-1/report.md: AC-1 met"}\ngaps: 0\n---\n`);
  assert.equal(cliAs(d, 'sess-3', 'state', run).json.next, 'finish');
  // K2 R-2 (D-9): T-1/F-6 (major, otwarta po rundzie zbiorczej) zatrzymuje finish; supervisor widzi czekanie na użytkownika.
  const stop = cliAs(d, 'sess-3', 'finish', run).json;
  assert.deepEqual([stop.status, stop.ok], ['deferred-major', false], JSON.stringify(stop));
  assert.deepEqual(stop.majors.map((m) => m.split(' ').slice(0, 2).join(' ')), ['T-1/F-6 [major]']);
  assert.match(stop.majors[0], /^T-1\/F-6 \[major\] Label rounds 9\.95 up/);
  assert.deepEqual([status().state, status().reason], ['waiting-user', 'deferred-major']);
  assert.match(status().questions[0], new RegExp(`dwmt finish ${esc(run)} --accept-deferred`));
  const st2 = cliAs(d, 'sess-3', 'state', run).json;
  assert.deepEqual([st2.next, /--accept-deferred/.test(st2.hint)], ['finish', true]);
  assert.equal(status().state, 'waiting-user', 'state nie nadpisuje czekania statusem running');
  const fin = cliAs(d, 'sess-3', 'finish', run, '--accept-deferred').json;
  assert.equal(fin.status, 'squashed', JSON.stringify(fin));
  const fh = hdr(runFile(d, run, 'final-report.md'));
  assert.equal(fh.status, 'ACCEPTED', 'otwarta pozycja rundy zbiorczej');
  assert.deepEqual([fh.batch.items.length, fh.batch.byReason, fh.batch.byResult, fh.batch.rounds, fh.batch.roundsAvoided],
    [6, { fix: 3, 'deferred-visible': 2, 'open-after-last-round': 1 }, { resolved: 4, open: 1, notReproduced: 1 }, 2, 2]);
  assert.equal(fh.rounds, 2 + 1 + 1 + 2);
  assert.deepEqual(fh.deferred, ['T-1/F-5', 'T-1/F-6'], 'poprawione odłożone uwagi znikają, otwarta pozycja jest odłożona');
  const report = readFileSync(runFile(d, run, 'final-report.md'), 'utf8');
  assert.match(report, /\| Fix batch \(6 items\) \| ACCEPTED \| 2 \| - \| [0-9a-f]{7} \| `batch\/report\.md` \|/);
  assert.match(report, /## Fix batch\n\n- Items: 6 \(fix 3, deferred-visible 2, open-after-last-round 1\); result: resolved 4, open 1, notReproduced 1\.\n- Commit: [0-9a-f]{10}, rounds: 2, task fix rounds avoided: 2 \(`batch\/report\.md`\)\./);
  assert.match(report, /\| T-1\/F-6 \[major\] \| open-after-last-round \| open \| Label rounds 9\.95 up \|/);
  const assess = /### For your assessment\n\n([\s\S]*?)\n\n###/.exec(report)[1];
  assert.match(assess, /- Decision to confirm T-3\/D-2: Rabat w eksporcie jako „-10%”/);
  assert.match(assess, /- Open after the fix batch T-1\/F-6 \[major\] Label rounds 9\.95 up/);
  assert.doesNotMatch(assess, /grey/, 'odłożona uwaga UI poprawiona w rundzie zbiorczej nie trafia na listę UAT');
  assert.ok(existsSync(join(main, '.dwmt', 'runs', run, 'batch', 'report.md')), 'kopia przebiegu w głównym drzewie z batch/');
});

// ---------- replan od k do końca ----------

function sprintAtT2(rules) {
  const { d } = repo28();
  const run = start(d, `rp${rules.replace('.', '')}`);
  asRules(d, run, rules); // v2.10: scenariusz biegnie dokładnie w podanych regułach
  writePlans(d, run);
  assert.equal(cliAs(d, 'sess-1', 'state', run).json.next, 'implement');
  const notes = ['`src/billing/discount.ts#Discount`: percent is a fraction', '`src/billing/invoice.ts#invoice`: rounds half up'];
  execute(d, 'sess-1', run, 1, 1, { 'src/billing/discount.ts': 'export class Discount {}\n' }, { laterNotes: notes });
  writeFileSync(runFile(d, run, 'review-1.md', 1), review(1, {}));
  assert.equal(cliAs(d, 'sess-1', 'commit', run).json.next, 'handoff');
  return { d, run, notes };
}

test('v2.8 replan: przyczyny wszystkich zadań od k (for T-j), replan-done zapisuje wszystkie, przed T-3 bez nowego replanu; [visible] w prompcie', () => {
  const { d, run, notes } = sprintAtT2('2.8');
  let st = cliAs(d, 'sess-2', 'state', run).json;
  assert.deepEqual([st.next, st.from], ['replan', 2], JSON.stringify(st));
  assert.deepEqual(st.causes, [`for T-2: T-1 note for later tasks: ${notes[0]}`, `for T-3: T-1 note for later tasks: ${notes[1]}`]);
  assert.match(st.prompt, /Drift causes: \(1\) for T-2: T-1 note .*; \(2\) for T-3: T-1 note .*rounds half up\./);
  assert.match(st.prompt, /settle it yourself as `### D-n \[visible\] <title in the user's language>` with the reason; scope, business rules, external contracts and data loss still go to the user\./);
  assert.match(st.prompt, /Task plans from T-2: \.dwmt\/runs\/.*\/tasks\/2\/brief\.md, \.dwmt\/runs\/.*\/tasks\/3\/brief\.md\./);
  const ok = cliAs(d, 'sess-2', 'replan-done', run, '2', '--result', 'unchanged').json;
  assert.deepEqual([ok.ok, ok.handled], [true, 2], JSON.stringify(ok));
  assert.equal(cliAs(d, 'sess-2', 'state', run).json.next, 'implement');
  execute(d, 'sess-2', run, 2, 1, { 'src/summary/view.ts': 'export const view = () => "-";\n' });
  writeFileSync(runFile(d, run, 'review-1.md', 2), review(2, {}));
  assert.equal(cliAs(d, 'sess-2', 'commit', run).json.next, 'handoff');
  st = cliAs(d, 'sess-3', 'state', run).json;
  assert.deepEqual([st.next, st.agent], ['implement', 'dwmt-executor'], 'uwaga dla T-3 obsłużona przy replanie przed T-2');
});

test('przebieg 2.7 bez zmian: replan tylko z przyczynami zadania k i drugi replan przed T-3; pełne ścieżki, Language; recenzja FIX bez podziału', () => {
  const { d, run, notes } = sprintAtT2('2.7');
  let st = cliAs(d, 'sess-2', 'state', run).json;
  assert.deepEqual([st.next, st.causes], ['replan', [`T-1 note for later tasks: ${notes[0]}`]]);
  assert.doesNotMatch(st.prompt, /Repo root|\[visible\]|in English/);
  assert.match(st.prompt, /Task: [A-Za-z]?:?\/.*\.dwmt\/runs\/.*\/task\.md\..* Language: en\. Verify shell/);
  assert.equal(cliAs(d, 'sess-2', 'replan-done', run, '2', '--result', 'unchanged').json.handled, 1);
  st = cliAs(d, 'sess-2', 'state', run).json;
  assert.equal(st.next, 'implement');
  assert.match(st.prompt, /^Round 1\. Brief: [A-Za-z]?:?\/.*\/tasks\/2\/brief\.md\./);
  execute(d, 'sess-2', run, 2, 1, { 'src/summary/view.ts': 'export const view = () => "-";\n' });
  writeFileSync(runFile(d, run, 'review-1.md', 2), review(2, { verdict: 'FIX', fix: ['F-1'], defer: ['F-2'], visible: ['F-2'] }, `${finding('F-1', 'major', 'x', 'src/summary/view.ts:1')}${finding('F-2', 'minor', 'y', 'src/summary/view.ts:1')}`));
  st = cliAs(d, 'sess-2', 'state', run).json;
  assert.deepEqual([st.next, hdr(runFile(d, run, 'review-1.md', 2)).now, RUN(d, run).batch], ['fix', undefined, undefined], 'v2.7: fixer w zadaniu, bez rundy zbiorczej');
  assert.match(st.prompt, /Fix mode: fix the items on the fix list/);
  execute(d, 'sess-2', run, 2, 2, {});
  writeFileSync(runFile(d, run, 'review-2.md', 2), review(2, { round: 2 }));
  assert.equal(cliAs(d, 'sess-2', 'commit', run).json.next, 'handoff');
  st = cliAs(d, 'sess-3', 'state', run).json;
  assert.deepEqual([st.next, st.causes], ['replan', [`T-1 note for later tasks: ${notes[1]}`]], 'v2.7: uwaga dla T-3 czeka na T-3');
});

test('review.batch: false w przebiegu 2.8 przywraca poprawki w zadaniu (bez podziału)', () => {
  const { d } = repo28({ review: { batch: false } });
  const run = start(d, 'nobatch');
  writePlans(d, run);
  assert.equal(cliAs(d, 'sess-1', 'state', run).json.next, 'implement');
  execute(d, 'sess-1', run, 1, 1, { 'src/billing/discount.ts': 'export class Discount {}\n' });
  writeFileSync(runFile(d, run, 'review-1.md', 1), review(1, { verdict: 'FIX', fix: ['F-1'] }, finding('F-1', 'major', 'x', 'src/billing/invoice.test.ts:1')));
  const st = cliAs(d, 'sess-1', 'state', run).json;
  assert.deepEqual([st.next, hdr(runFile(d, run, 'review-1.md', 1)).now], ['fix', undefined]);
});

// ---------- UAT: bez linii do roadmapy ----------

test('uat record: zmiana wymagań zostaje w uat.md (requirement, fix null) bez linii do roadmapy', () => {
  const d = repo();
  const dir = join(d, '.dwmt', 'runs', 'r1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ schema: 'dwmt/run@1', run: 'r1', sprint: 'S9', target: 'master', created: '2026-10-01T00:00:00Z', finish: { status: 'squashed', commit: null, at: '2026-10-01T01:00:00Z' } }));
  writeFileSync(join(dir, 'final-report.md'), `${header({ schema: 'dwmt/final-report@1', run: 'r1', status: 'PASS', goal: 'x', rounds: 1, tests: {}, sessions: [], uat: 'pending' })}# r\n`);
  const res = join(d, '..', 'uat-result.json');
  writeFileSync(res, JSON.stringify({ result: 'positive', findings: [{ text: 'Export should also have a total row', place: 'export', weight: 'minor', kind: 'requirement' }] }));
  const r = cliAs(d, 'sess-1', 'uat', 'record', 'S9', res, '--late').json;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.roadmap, undefined, 'bez linii do roadmapy');
  assert.deepEqual(r.requirements, ['S9 U-1']);
  const u = hdr(join(dir, 'uat.md'));
  assert.deepEqual(u.defects.map((x) => [x.id, x.kind, x.fix]), [['U-1', 'requirement', null]]);
});
