import './tmp-root.mjs';
// D4 etap 1, B4 i B6: cena bez modelu (`dwmt price`, `product start-check`, `product price explore`), zmieniony plik kodu,
// szacunek poziomu 0 (`estimate-input`, `estimate-record`), analogia z indeksu archiwum, kalibracja, `overhead`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { repo, gitIn } from './helpers.mjs';
import { pr, dw, write, config, fakeRun, productRepo } from './product-helpers.mjs';
import { completedRuns, explorerPrice, changedCode, changedCodeFiles } from '../scripts/lib/price.mjs';
import { loadConfig } from '../scripts/lib/config.mjs';

const exclude = (d) => { mkdirSync(join(d, '.git', 'info'), { recursive: true }); writeFileSync(join(d, '.git', 'info', 'exclude'), '.dwmt/\n'); };

test('zmieniony plik kodu (cost-per-file.py uogólniony): codeGlobs minus review.ignoreGlobs, bez binarnych i dokumentów', () => {
  const d = repo();
  exclude(d);
  config(d, { review: { ignoreGlobs: ['src/api/generated/**'] } });
  write(d, 'src/api/generated/client.ts', 'gen\n');
  write(d, 'README.md', 'doc\n');
  writeFileSync(join(d, 'logo.png'), Buffer.from([0, 1, 2, 0, 255, 0]));
  const g = gitIn(d);
  g('add', '-A', '--', 'src', 'README.md', 'logo.png');
  g('commit', '-q', '-m', 'noise');
  fakeRun(d, 'r1', { files: ['src/a.ts', 'web/b.tsx', 'web/c.css', 'docs/x.md'], cost: 3 });
  // Commit „squash” z plikami szumu: przestawiamy run na commit, który zawiera też szum.
  write(d, 'src/api/generated/client.ts', 'gen2\n');
  write(d, 'README.md', 'doc2\n');
  writeFileSync(join(d, 'logo.png'), Buffer.from([0, 9, 2, 0, 255, 0]));
  write(d, 'src/z.java', 'class Z {}\n');
  g('add', '-A', '--', 'src', 'README.md', 'logo.png');
  g('commit', '-q', '-m', 'squash r2');
  const commit = g('rev-parse', '--short=10', 'HEAD');
  mkdirSync(join(d, '.dwmt', 'runs', 'r2'), { recursive: true });
  writeFileSync(join(d, '.dwmt', 'runs', 'r2', 'run.json'), JSON.stringify({ run: 'r2', mode: 'single', created: '2026-10-02', finish: { status: 'squashed', commit, cost: 1 } }));
  const runs = completedRuns(d, loadConfig(d));
  assert.deepEqual(runs.find((r) => r.run === 'r1').changed.sort(), ['src/a.ts', 'web/b.tsx', 'web/c.css']);
  assert.deepEqual(runs.find((r) => r.run === 'r2').changed, ['src/z.java']);
  assert.equal(runs.find((r) => r.run === 'r1').mPerFile, 1);
  assert.ok(existsSync(join(d, '.dwmt', 'price-cache.json')));
  // Lines: r1 three one-line code files (docs/x.md is not code); r2 only src/z.java (ignored, doc and binary add nothing).
  assert.equal(runs.find((r) => r.run === 'r1').lines, 3);
  assert.equal(runs.find((r) => r.run === 'r2').lines, 1);
  assert.equal(runs.find((r) => r.run === 'r1').mPerLine, 1);
  // Old cache entries without lines are recomputed once and rewritten with lines.
  const cacheFile = join(d, '.dwmt', 'price-cache.json');
  const old = JSON.parse(readFileSync(cacheFile, 'utf8'));
  for (const e of Object.values(old)) delete e.lines;
  writeFileSync(cacheFile, JSON.stringify(old));
  assert.equal(completedRuns(d, loadConfig(d)).find((r) => r.run === 'r1').lines, 3);
  const again = JSON.parse(readFileSync(cacheFile, 'utf8'));
  assert.ok(Object.values(again).length >= 2 && Object.values(again).every((e) => Number.isInteger(e.lines)));
  // Reuse (D-2): an entry with the same commit and globs and an integer lines is taken as is, the file is not rewritten.
  again.r1.lines = 4242;
  writeFileSync(cacheFile, JSON.stringify(again));
  const bytes = readFileSync(cacheFile);
  assert.equal(completedRuns(d, loadConfig(d)).find((r) => r.run === 'r1').lines, 4242);
  assert.ok(readFileSync(cacheFile).equals(bytes), 'cache file byte-identical');
});

test('completedRuns: the copy in the home tree (worktree holding git.target, not the first) is counted from either tree; price-cache.json goes there (K3 T-3, D-4, R-1)', () => {
  const first = repo();
  exclude(first);
  config(first, { git: { target: 'feature/x' } });
  const g = gitIn(first);
  g('add', '-A', '--', '.claude');
  g('commit', '-q', '-m', 'config');
  const second = join(mkdtempSync(join(tmpdir(), 'dwmt-pr2-')), 'second');
  g('worktree', 'add', '-q', '-b', 'feature/x', second);
  g('switch', '-q', '-c', 'develop');
  fakeRun(second, 'r-home', { files: ['src/h.ts', 'src/i.ts'], cost: 4 });
  for (const top of [first, second]) {
    const r = completedRuns(top, loadConfig(top)).find((x) => x.run === 'r-home');
    assert.ok(r, `counted from ${top}`);
    assert.equal(r.files, 2);
    assert.equal(r.mPerFile, 2);
  }
  assert.ok(existsSync(join(second, '.dwmt', 'price-cache.json')));
  assert.ok(!existsSync(join(first, '.dwmt')), 'nothing under the first tree');
});

test('changedCode: lines = added + deleted of the counted code files; binary and non-code files skipped', () => {
  const d = repo();
  const g = gitIn(d);
  write(d, 'src/a.ts', 'a\nb\nc\n');
  write(d, 'src/old.ts', 'x\ny\n');
  writeFileSync(join(d, 'logo.png'), Buffer.from([0, 1, 2, 0]));
  // A binary file named like code (D-3): the code filter accepts it, only the binary check drops it.
  writeFileSync(join(d, 'src', 'blob.ts'), Buffer.from([0, 1, 2, 0]));
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  write(d, 'src/a.ts', 'a\nB\nc\nd\ne\n');
  g('rm', '-q', 'src/old.ts');
  writeFileSync(join(d, 'logo.png'), Buffer.from([0, 9, 9, 0]));
  writeFileSync(join(d, 'src', 'blob.ts'), Buffer.from([0, 9, 9, 0]));
  write(d, 'README.md', '1\n2\n3\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'second');
  const commit = g('rev-parse', 'HEAD');
  const isTs = (p) => p.endsWith('.ts');
  const r = changedCode(d, commit, isTs);
  assert.deepEqual(r.files.sort(), ['src/a.ts', 'src/old.ts']);
  assert.equal(r.lines, 6);
  assert.deepEqual(changedCodeFiles(d, commit, isTs).sort(), ['src/a.ts', 'src/old.ts']);
  assert.equal(changedCode(d, '0000000000', isTs), null);
  assert.equal(changedCodeFiles(d, '0000000000', isTs), null);
});

test('dwmt price: mediana według trybu (modeLabel ?? mode), przejście do wszystkich przebiegów i do wartości domyślnych', () => {
  const d = repo();
  exclude(d);
  // Bez warstwy produktowej i bez danych: 0,2 mln na plik.
  let r = dw(d, ['price', '--files', '10,20', '--mode', 'inline']).json;
  // Przegląd 2026-10-09 (W-4): cena × (1 + udział rundy zbiorczej), bez danych o partii 0,15.
  assert.deepEqual([r.m, r.basis, r.designM], [0.2, 'default (no product layer); batch +15% default', [2.3, 4.6]]);
  // Warstwa produktowa (klucz w configu), bez danych: domyślne według trybu.
  config(d, { product: {} });
  r = dw(d, ['price', '--files', '10,20', '--mode', 'intermediate']).json;
  assert.deepEqual([r.m, r.basis], [0.15, 'default intermediate; batch +15% default']);
  // 3 przebiegi inline (0,1 / 0,2 / 0,3 mln na plik) i 1 pośredni (single + modeLabel) → inline z mediany trybu.
  fakeRun(d, 'i1', { files: ['a/1.ts', 'a/2.ts'], cost: 0.2, mode: 'inline' });
  fakeRun(d, 'i2', { files: ['b/1.ts'], cost: 0.2, mode: 'auto', reportMode: 'inline' });
  fakeRun(d, 'i3', { files: ['c/1.ts', 'c/2.ts'], cost: 0.6, mode: 'inline' });
  fakeRun(d, 'm1', { files: ['d/1.ts', 'd/2.ts'], cost: 2, mode: 'single', modeLabel: 'intermediate' });
  r = dw(d, ['price', '--files', '10,20', '--mode', 'inline']).json;
  // Przegląd 2026-10-04: przedział [10 × p25 0,15; 20 × p75 0,25], mediana tylko do opisu.
  assert.deepEqual([r.m, r.mRange, r.basis, r.designM], [0.2, [0.15, 0.25], 'inline n=3; batch +15% default', [1.7, 5.8]]);
  // Pośredni: 1 przebieg w trybie → wszystkie (4): mediana z 0,1 0,2 0,3 1,0 = 0,25.
  r = dw(d, ['price', '--files', '4,8', '--mode', 'intermediate']).json;
  assert.deepEqual([r.m, r.basis, r.designM], [0.25, 'all n=4; batch +15% default', [0.8, 4.4]]); // 4 × p25 0,175 × 1,15; 8 × p75 0,475 × 1,15
  assert.equal(dw(d, ['price', '--files', '8,4']).code, 1);
});

test('start-check: small przy 30k i progu analogii, prices null bez danych, risks new-area, reguła recommend', () => {
  const d = productRepo(repo);
  write(d, 'src/small/a.ts', 'x'.repeat(120000));
  write(d, 'src/big/a.ts', 'x'.repeat(124000));
  gitIn(d)('add', '-A', '--', 'src');
  gitIn(d)('commit', '-q', '-m', 'code');
  pr(d, 'item', 'add', '--type', 'bug', '--title', 'Bug in big');
  pr(d, 'item', 'add', '--type', 'feature', '--title', 'Feature in big');
  let r = pr(d, 'start-check', '--item', 'B-1', '--globs', 'src/small/**').json;
  // K5 D-20: a bug alone is a fix sprint, priced without history from 1 item × fixFilesPerItem [1, 3].
  assert.deepEqual([r.workingSetK, r.small, r.recommend, r.prices.direct, r.analog], [30, true, 'inline', [0.1, 0.2], null]);
  r = pr(d, 'start-check', '--item', 'B-2', '--globs', 'src/small/**').json;
  assert.equal(r.prices, null, 'a feature without data has no price');
  r = pr(d, 'start-check', '--item', 'B-1', '--globs', 'src/big/**').json;
  assert.deepEqual([r.workingSetK, r.small, r.recommend], [31, false, 'intermediate']);
  r = pr(d, 'start-check', '--item', 'B-2', '--globs', 'src/big/**,src/new-module/**').json;
  assert.deepEqual([r.small, r.risks, r.recommend, r.emptyGlobs], [false, ['new-area'], 'single', ['src/new-module/**']]);
  // Analogia powyżej 1,0 mln wyłącza small mimo małego zbioru roboczego; ceny z plików analogii × mln na plik trybu.
  fakeRun(d, 'r1', { files: ['src/small/b.ts', 'src/small/c.ts'], cost: 1.5, mode: 'inline' });
  // K5 D-20: the feature item (a bug would compare with fix sprints only).
  r = pr(d, 'start-check', '--item', 'B-2', '--globs', 'src/small/**').json;
  assert.equal(r.small, false);
  assert.deepEqual(r.analog, { n: 1, mode: 'inline', medianM: 1.5, rangeM: [1.5, 1.5], files: [2, 2] });
  assert.deepEqual(r.prices, { direct: [0.1, 0.1], inline: [0.2, 0.2], intermediate: [0.3, 0.3], single: [0.5, 0.5] });
  assert.match(r.basis, /analog inline n=1/);
  assert.equal(pr(d, 'start-check', '--globs', 'src/**').code, 1);
});

test('price explore: n × explorerM, a przy ≥ 6 eksploratorach p25–p75 projektu', () => {
  const d = productRepo(repo);
  const r = pr(d, 'price', 'explore', '--areas', '2').json;
  assert.deepEqual(r.rangeM, [0.5, 1.7]);
  assert.match(r.line, /scan of 2 areas ~0.5-1.7 M tokens/);
  const p = explorerPrice(d, 3, { costs: [0.2, 0.3, 0.4, 0.5, 0.6, 0.7] });
  assert.deepEqual([p.perExplorerM, p.rangeM, p.basis], [[0.33, 0.57], [1, 1.7], 'project explorers n=6 p25-p75']);
  assert.equal(pr(d, 'price', 'explore', '--areas', '0').code, 1);
});

test('szacunek poziomu 0: estimate-input (E-n, input.md, sizes.txt), estimate-record (tokeny skryptem, est w pozycjach i pliku)', () => {
  const d = productRepo(repo);
  write(d, 'docs/adr/0001-modules.md', '# ADR 1: Modular monolith\n');
  write(d, 'CLAUDE.md', '# rules\n');
  gitIn(d)('add', '-A');
  gitIn(d)('commit', '-q', '-m', 'docs');
  pr(d, 'item', 'add', '--type', 'feature', '--title', 'Export filter', '--note', 'client view');
  pr(d, 'roadmap', 'add', 'pm-1', '--goal', 'Export');
  pr(d, 'spec', 'new', 'pm-1', '--goal', 'Export accepted only');
  const inp = pr(d, 'estimate-input', 'pm-1', 'B-1');
  assert.equal(inp.code, 0, inp.out);
  assert.equal(inp.json.id, 'E-1');
  assert.equal(inp.json.maxTurns, 40);
  assert.match(inp.json.prompt, /^Mode: product-estimate\. Input: .*estimate-E-1\/input\.md\. Result: .*result\.md\.$/);
  const text = readFileSync(inp.json.input, 'utf8');
  assert.match(text, /### pm-1 \(sprint, notes\): Export/);
  assert.match(text, /### B-1 \(item\): B-1 feature new: Export filter\nnote: client view/);
  assert.match(text, /- docs\/adr\/0001-modules.md: ADR 1: Modular monolith/);
  assert.match(text, /CLAUDE.md: CLAUDE.md/);
  assert.match(text, /no data \(script uses 0.2\)/);
  assert.ok(existsSync(join(inp.json.dir, 'sizes.txt')));
  assert.equal(pr(d, 'estimate-input', 'B-1').json.id, 'E-2', 'kolejny numer także bez zapisu E-1');
  writeFileSync(inp.json.result, '---\nschema: dwmt/estimate-result@1\nentries:\n  - {for: [pm-1], areas: ["src/export/**"], files: [8, 14], flags: {newArea: true, contract: false, migration: false, screens: 1}, split: null}\n  - {for: [B-1], areas: ["src/export/**"], files: [2, 3], flags: {}}\n---\n## Facts\n- src/export has ExportService\n');
  const rec = pr(d, 'estimate-record', 'E-1', '--cost', '0.4');
  assert.equal(rec.code, 0, rec.out);
  assert.deepEqual(rec.json.estimates.map((e) => [e.id, e.for, e.files, e.tokensM]), [['E-1', ['pm-1'], [8, 14], [1.6, 2.8]], ['E-3', ['B-1'], [2, 3], [0.4, 0.6]]]);
  assert.deepEqual(rec.json.facts, ['- src/export has ExportService']);
  const est = readFileSync(join(d, 'docs', 'product', 'estimates.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual([est[0].cost, est[0].level, est[0].flags.newArea, est[0].stale], [0.2, 0, true, false]);
  assert.match(readFileSync(join(d, 'docs', 'product', 'sprints', 'pm-1.md'), 'utf8'), /^est: "E-1"$/m);
  assert.match(pr(d, 'item', 'B-1').out, /est: E-3/);
  // start-check bierze flagi i pliki szacunku.
  const sc = pr(d, 'start-check', '--spec', 'pm-1', '--globs', 'src/export/**').json;
  assert.deepEqual([sc.est.id, sc.risks, sc.prices.single], ['E-1', ['new-area'], [1.8, 3.2]], 'cena trybu z udziałem partii; tokeny szacunku bez zmian');
});

test('estimate-record: tokeny z p25/p75 mln na plik zakończonych przebiegów (≥ 3)', () => {
  const d = productRepo(repo);
  fakeRun(d, 'a', { files: ['x/1.ts'], cost: 0.1 });
  fakeRun(d, 'b', { files: ['x/2.ts'], cost: 0.2 });
  fakeRun(d, 'c', { files: ['x/3.ts'], cost: 0.3 });
  pr(d, 'item', 'add', '--type', 'feature', '--title', 'F');
  const inp = pr(d, 'estimate-input', 'B-1').json;
  assert.match(readFileSync(inp.input, 'utf8'), /p25 0.15, p75 0.25 \(n=3\)/);
  writeFileSync(inp.result, JSON.stringify({ entries: [{ for: ['B-1'], areas: ['x/**'], files: [10, 20] }] }));
  assert.deepEqual(pr(d, 'estimate-record', 'E-1').json.estimates[0].tokensM, [1.5, 5]);
});

test('analog: z indeksu archiwum i kopii przebiegów, filtr obszaru', () => {
  const d = productRepo(repo);
  fakeRun(d, 'r-pm-1', { files: ['src/a/1.ts', 'src/a/2.ts'], cost: 4, spec: 'pm-1' });
  fakeRun(d, 'r-pm-2', { files: ['src/b/1.ts'], cost: 1, spec: 'pm-2' });
  write(d, 'docs/product/archive/index.md', '# dwmt/archive-index@1 — id · goal · merged · run · files · tokensM\npk-0 · Old import · 2026-09-01 · - · 155 · 34\npk-1 · Archive · 2026-10-01 · r-pm-1 · 2 · 4\npk-9 · Dropped thing (dropped) · dropped · - · - · -\n');
  const all = pr(d, 'analog').out;
  assert.match(all, /^analog \(a comparison, not an estimate\): n=3/);
  assert.match(all, /^pm-0 · Old import · - · files 155 · 34 M · 0.22 M\/file$/m);
  assert.match(all, /^pm-1 · Archive · single · files 2 · 4 M · 2.00 M\/file$/m);
  assert.match(all, /^pm-2 · - · single · files 1 · 1 M/m);
  assert.doesNotMatch(all, /pm-9/);
  const area = pr(d, 'analog', '--area', 'src/b/**').out;
  assert.match(area, /n=1/);
  assert.match(area, /^pm-2 /m);
  assert.doesNotMatch(area, /pm-0|pm-1 /);
});

test('overhead: narzut szacowania z turą tylko z ceną i bez niej', () => {
  const d = productRepo(repo);
  pr(d, 'roadmap', 'add', 'pm-1', '--goal', 'A');
  pr(d, 'roadmap', 'add', 'pm-2', '--goal', 'B');
  pr(d, 'spec', 'new', 'pm-1');
  pr(d, 'spec', 'new', 'pm-2');
  write(d, '.dwmt/product/estimate-E-1/result.md', JSON.stringify({ entries: [{ for: ['pm-1', 'pm-2'], areas: ['src/**'], files: [1, 2] }] }));
  pr(d, 'estimate-record', 'E-1', '--cost', '0.4');
  fakeRun(d, 'r1', { spec: 'pm-1', cost: 10, extra: { price: { onlyTurn: true, turnM: 0.1 } } });
  fakeRun(d, 'r2', { spec: 'pm-2', cost: 10 });
  const a = pr(d, 'overhead', 'r1').json;
  assert.deepEqual([a.E, a.P, a.S, a.estOverhead, a.estimates], [0.2, 0.1, 10, 0.03, ['E-1']]);
  const b = pr(d, 'overhead', 'r2').json;
  assert.deepEqual([b.E, b.P, b.estOverhead], [0.2, 0, 0.02]);
  fakeRun(d, 'r3', { cost: 5 });
  assert.equal(pr(d, 'overhead', 'r3').json.estOverhead, 0);
});
