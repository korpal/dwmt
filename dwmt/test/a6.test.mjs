import './tmp-root.mjs';
// Przegląd a6 (2026-10-06): znana czerwień w pliku testu zmienianym przez sprint idzie do rundy zbiorczej (finish stanął
// na `s3_031a_areaOpen`), raport bez dopisków o uwagach rozwiązanych przez partię, uwagi z recenzji nie jadą ze sprintem
// ani przed nim (osobny sprint poprawkowy).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { header, runFile } from './helpers.mjs';

// ---------- 1. znana czerwień w pliku zmienianym przez sprint ----------

test('redTestNames: plik z powodu (komenda e2e wymienia kilka), klasa Javy, bez nazw pusto', async () => {
  const { redTestNames } = await import('../scripts/lib/known-red.mjs');
  assert.deepEqual(redTestNames("npm --prefix frontend run test:e2e -- e2e/orders.spec.ts e2e/screenshots.spec.ts: screenshots.spec.ts › s3_031a_areaOpen expects '(9 z 14)'"), ['screenshots.spec.ts']);
  assert.deepEqual(redTestNames('`mvn -q test -Dtest=FooTest,BarTest`: BarTest fails on the base'), ['BarTest.java']);
  assert.deepEqual(redTestNames('npx vitest run src/a/b.test.tsx: red on the base already'), ['b.test.tsx'], 'powód bez nazwy: z komendy');
  assert.deepEqual(redTestNames('cmd1: old red'), []);
});

test('knownRedToFix: tylko twierdzenia o plikach testów, które sprint zmienił; w rundzie zbiorczej pozycja nie jest już znana', async () => {
  const { knownRed, knownRedToFix } = await import('../scripts/lib/known-red.mjs');
  const top = mkdtempSync(join(tmpdir(), 'dwmt-a6-'));
  const g = (...a) => execFileSync('git', a, { cwd: top, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'master'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  mkdirSync(join(top, 'e2e'), { recursive: true });
  writeFileSync(join(top, 'e2e', 'screens.spec.ts'), 'old\n');
  writeFileSync(join(top, 'e2e', 'other.spec.ts'), 'old\n');
  g('add', '-A'); g('commit', '-q', '-m', 'base');
  g('switch', '-q', '-c', 'dwmt/x');
  writeFileSync(join(top, 'e2e', 'screens.spec.ts'), 'new\n');
  g('add', '-A'); g('commit', '-q', '-m', 'sprint');
  const root = join(top, 'run');
  mkdirSync(join(root, 'tasks', '7'), { recursive: true });
  const changed = 'npm run e2e -- e2e/screens.spec.ts e2e/other.spec.ts: screens.spec.ts › banner expects 14, the stub gives 13';
  const untouched = 'npm run e2e -- e2e/other.spec.ts: other.spec.ts › old locator';
  writeFileSync(join(root, 'tasks', '7', 'result-1.md'), header({ schema: 'dwmt/result@1', status: 'DONE', unrelatedRed: [changed, untouched] }));
  const run = { target: 'master', tasks: [{ k: 7, commit: 'abc' }] };
  assert.deepEqual(knownRedToFix(top, root, run), [{ k: 7, claim: changed, file: 'result-1.md', files: ['e2e/screens.spec.ts'] }]);
  run.batch = { items: [{ id: 'T-7/KR-1', reason: 'known-red', claim: changed }] };
  assert.deepEqual(knownRed(root, run).map((x) => x.claim), [untouched], 'runda zbiorcza: naprawiana pozycja nie jest znaną czerwienią');
  assert.deepEqual(knownRed(root, run, 8).map((x) => x.claim), [changed, untouched], 'zadania: bez zmian');
});

test('runda zbiorcza: znana czerwień T-1 w pliku testu dodanym przez sprint to pozycja T-1/KR-1, także bez uwag recenzji', async () => {
  const { repo28, start, writePlans, cliAs, T1, review, execute, RUN } = await import('./fixtures28.mjs');
  const red = 'node -e "process.exit(1)"';
  const claim = `\`${red}\`: discount.test.ts › total fails on the base already (stale literal)`;
  const { d } = repo28({ verify: { full: ['node -e 0'], targeted: null } });
  const run = start(d, 'kr');
  writePlans(d, run, { t1: T1(run, { verify: ['node -e 0', red] }) });
  assert.equal(cliAs(d, 'sess-1', 'state', run).json.next, 'implement');
  writeFileSync(join(d, 'src', 'billing', 'discount.ts'), 'export class Discount {}\n');
  writeFileSync(join(d, 'src', 'billing', 'discount.test.ts'), 'test("total", () => {});\n');
  writeFileSync(runFile(d, run, 'result-1.md', 1), header({ schema: 'dwmt/result@1', status: 'DONE', unrelatedRed: [claim] }));
  assert.deepEqual(cliAs(d, 'sess-1', 'verify', run).json.expectedRed, [red]);
  assert.equal(cliAs(d, 'sess-1', 'review-input', run).json.ok, true);
  writeFileSync(runFile(d, run, 'review-1.md', 1), review(1, {}));
  assert.equal(cliAs(d, 'sess-1', 'commit', run).json.next, 'handoff');
  for (const [k, f] of [[2, 'src/summary/view.ts'], [3, 'src/export/csv.ts']]) {
    assert.equal(cliAs(d, `sess-${k}`, 'state', run).json.next, 'implement');
    execute(d, `sess-${k}`, run, k, 1, { [f]: `export const v${k} = 1;\n` });
    writeFileSync(runFile(d, run, 'review-1.md', k), review(k, {}));
    cliAs(d, `sess-${k}`, 'commit', run);
  }
  const st = cliAs(d, 'sess-3', 'state', run).json;
  assert.deepEqual([st.next, st.batch, st.items], ['batch', true, 1], JSON.stringify(st));
  assert.ok(!/Known red from earlier tasks/.test(st.prompt), 'naprawiana pozycja nie jest w prompcie jako znana czerwień');
  assert.match(st.prompt, /T-k\/F-n \(or T-k\/KR-n\) ids/);
  assert.deepEqual(RUN(d, run).batch.items.map((x) => [x.id, x.reason, x.severity, x.file]), [['T-1/KR-1', 'known-red', 'major', 'src/billing/discount.test.ts']]);
  const text = readFileSync(join(d, '.dwmt', 'runs', run, 'batch', 'batch.md'), 'utf8');
  assert.match(text, /### T-1\/KR-1 \[major\] Known red test in a file this sprint changed \(src\/billing\/discount\.test\.ts\)\n- Red since T-1; [^\n]*\(stale literal\)\n- Reason: known-red\./);
});

// ---------- 2. raport: dopiski o uwagach rozwiązanych przez partię ----------

test('raport: spełnione kryterium traci człony notatki o uwagach rozwiązanych przez partię; nierozwiązane zostają', async () => {
  const { batchStatuses, pruneResolved } = await import('../scripts/lib/report.mjs');
  const resolved = new Set(['T-6/F-3', 'T-7/F-6']);
  assert.equal(pruneResolved('AC-1 met (Invoices part; the totals-to-ledger wiring is untested, F-3)', 6, resolved), 'AC-1 met (Invoices part; F-3 resolved by the fix batch)');
  assert.equal(pruneResolved('AC-1 met (F-3)', 7, resolved), 'AC-1 met (F-3)', 'F-3 innego zadania');
  assert.equal(pruneResolved('AC-5 (part) met', 1, resolved), 'AC-5 (part) met');
  const mk = (k, acceptance) => ({ k, acceptance, risks: [], riskStatus: {} });
  const data = [
    mk(6, ['AC-1 met (Invoices part; the totals-to-ledger wiring is untested, F-3)']),
    mk(7, ['AC-8 met (F-6 Settings link missing on the region action; F-5 test gap)', 'AC-9 not met: guard missing (F-5, F-6)']),
  ];
  batchStatuses(data, { resolved, reviews: [], many: true });
  assert.deepEqual(data[0].acceptance, ['AC-1 met (Invoices part; F-3 resolved by the fix batch)']);
  assert.deepEqual(data[1].acceptance, ['AC-8 met (F-5 test gap; F-6 resolved by the fix batch)', 'AC-9 not met: guard missing (F-5, F-6)']);
});

// ---------- 3. uwagi z recenzji: osobny sprint poprawkowy ----------

test('PO i touch: uwagi z recenzji czekają na osobny sprint poprawkowy, nie przed sprintem', () => {
  const po = readFileSync(new URL('../skills/po/SKILL.md', import.meta.url), 'utf8');
  assert.match(po, /never ride along in a feature sprint and never run before it or beside it/);
  assert.match(po, /Debt items \(not remarks\) that `touch` adds stay in the sprint/);
  assert.ok(!/before the sprint; `intermediate`/.test(po));
  const product = readFileSync(new URL('../scripts/product.mjs', import.meta.url), 'utf8');
  assert.match(product, /nie touch i nie przed sprintem; czekają na osobny sprint poprawkowy/);
});
