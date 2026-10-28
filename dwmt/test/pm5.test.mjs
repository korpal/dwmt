import './tmp-root.mjs';
// Przegląd pm-5 i poprawki-recenzji-e2e (2026-10-05): błąd nagłówka wyniku w prompcie agenta, PARTIAL z pytaniami jako
// pytanie, sesja PO w worktree przebiegu jako wywołująca, statusy recenzji partii `T-k AC-n`, odchylenia bez powtórzeń.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { repo, prepared, cli, put, runFile, gitIn } from './helpers.mjs';
import { cliAs } from './fixtures28.mjs';

// `"…\s+"` parses since k3-2 D-8 (unknown escapes keep the backslash); a path ending in `\"` still leaves the string open.
const BAD = '---\nschema: dwmt/result@1\nstatus: DONE\nassumptions: ["A-1 output in C:\\tmp\\out\\"]\n---\nbody\n';

test('state: nagłówek wyniku, który się nie parsuje — błąd w prompcie wykonawcy i w polu invalid', () => {
  const d = repo();
  const run = prepared(d, 'b');
  writeFileSync(runFile(d, run, 'result-1.md'), BAD);
  const st = cli(d, 'state', run).json;
  assert.equal(st.agent, 'dwmt-executor', JSON.stringify(st));
  assert.match(st.prompt, /The header of \S*result-1\.md does not parse \(nieczytelna wartość YAML: \["A-1 output in C:\\tmp\\out\\"\]/);
  assert.match(st.prompt, /if the work is already done, change only the header/);
  assert.match(st.invalid.file, /result-1\.md$/);
  assert.equal(st.invalid.errors.length, 1);
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'PARTIAL' });
  const ok = cli(d, 'state', run).json;
  assert.equal(ok.invalid, undefined);
  assert.ok(!/does not parse/.test(ok.prompt));
});

test('state: PARTIAL z pytaniami → pytanie do użytkownika; unblock archiwizuje wynik i wykonawca kontynuuje', () => {
  const d = repo();
  const run = prepared(d, 'b');
  assert.equal(cli(d, 'state', run).json.next, 'implement', 'start rundy zapisany');
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'PARTIAL', questions: ['Q-1'] }, '### Q-1 Add the code to the contract?\n(a) yes (b) no\n');
  const st = cli(d, 'state', run).json;
  assert.equal(st.next, 'ask', JSON.stringify(st));
  assert.deepEqual(st.questions, ['Q-1']);
  assert.equal(cli(d, 'unblock', run).json.ok, true);
  assert.ok(existsSync(runFile(d, run, 'result-1.blocked-1.md')));
  assert.equal(cli(d, 'state', run).json.next, 'continue');
  // PARTIAL bez pytań: kontynuacja jak dotąd.
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'PARTIAL', questions: [] });
  assert.equal(cli(d, 'state', run).json.next, 'continue');
});

test('run: sesja z run.callers (PO przeszła do worktree przebiegu) nie trafia do session_ids ani do sesji zadania', () => {
  const d = repo();
  const run = prepared(d, 'b');
  const f = runFile(d, run, 'run.json');
  const rj = JSON.parse(readFileSync(f, 'utf8'));
  rj.callers = [{ id: 'po-1', from: '2026-10-05T16:25:53.535Z', to: '2026-10-05T16:25:53.535Z' }];
  writeFileSync(f, JSON.stringify(rj, null, 2));
  cliAs(d, 'po-1', 'state', run);
  const after = JSON.parse(readFileSync(f, 'utf8'));
  assert.ok(!after.session_ids.includes('po-1'), JSON.stringify(after.session_ids));
  assert.ok(!after.tasks[0].sessions.includes('po-1'));
  assert.notEqual(after.callers[0].to, '2026-10-05T16:25:53.535Z', 'okno wywołującej rośnie');
});

test('raport: recenzja partii z „T-3 AC-8 met” i „T-3 R-1 proven” (spacja zamiast /) zastępuje status zadania', async () => {
  const { batchStatuses } = await import('../scripts/lib/report.mjs');
  const data = [{ k: 3, acceptance: ['AC-2 met', 'AC-8 partial: Stop honoured only before a batch'], risks: [{ id: 'R-1' }], riskStatus: { 'R-1': 'R-1 partly proven: a failing setting save is untested' } }];
  batchStatuses(data, { resolved: new Set(['T-3/F-1']), reviews: [{ acceptance: ['T-3 AC-8 met'], risks: ['T-3 R-1 proven'] }], many: true });
  assert.deepEqual(data[0].acceptance, ['AC-2 met', 'AC-8 met (fix batch review)']);
  assert.equal(data[0].riskStatus['R-1'], 'R-1 proven (fix batch review)');
});

test('raport: odchylenie powtórzone w kolejnych odcinkach (PARTIAL, potem DONE) jest w raporcie raz', () => {
  const d = repo();
  const run = prepared(d, 'b');
  const dev = 'src/x.ts#f: now takes a narrower type so the self-test can use it';
  put(d, run, 'result-1.partial-1.md', { schema: 'dwmt/result@1', status: 'PARTIAL', outOfScopeChanges: [dev] });
  writeFileSync(join(d, 'b.txt'), 'b\n');
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'DONE', outOfScopeChanges: [dev, 'src/y.ts#g: checks before it removes'] });
  assert.equal(cli(d, 'verify', run).json.result, 'pass');
  cli(d, 'review-input', run);
  put(d, run, 'review-1.md', { schema: 'dwmt/review@1', round: 1, passes: ['correctness'], verdict: 'PASS', fix: [], acceptance: ['AC-1 met'] });
  assert.equal(cli(d, 'commit', run).json.ok, true);
  const fin = cli(d, 'finish', run);
  assert.equal(fin.json.status, 'squashed', fin.out);
  const rep = readFileSync(runFile(d, run, 'final-report.md'), 'utf8');
  const line = /^deviations: (.*)$/m.exec(rep)[1];
  assert.deepEqual(JSON.parse(line), [dev, 'src/y.ts#g: checks before it removes']);
  assert.equal(gitIn(d)('branch', '--show-current'), 'master');
});
