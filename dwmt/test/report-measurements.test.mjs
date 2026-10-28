import './tmp-root.mjs';
// Sekcja „## Measurements” raportu końcowego (kt, D-17, R-13): treść plików pomiarów z nagłówka `measurements` wyniku.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { measurementsSection } from '../scripts/lib/report.mjs';

const dir = () => {
  const d = mkdtempSync(join(tmpdir(), 'dwmt-meas-'));
  mkdirSync(join(d, 'bench', 'm'), { recursive: true });
  return d;
};

test('measurements: no paths give an empty section', () => {
  assert.equal(measurementsSection(dir(), []), '');
  assert.equal(measurementsSection(dir(), undefined), '');
});

test('measurements: a 3-line file is shown whole under its heading', () => {
  const d = dir();
  writeFileSync(join(d, 'bench', 'm', 'README.md'), '# Times\n| file | s |\n| a | 1 |\n');
  assert.equal(measurementsSection(d, ['bench/m/README.md']), '\n## Measurements\n\n### `bench/m/README.md`\n\n# Times\n| file | s |\n| a | 1 |\n');
});

test('measurements: a 200-line file shows 150 lines and the truncation note', () => {
  const d = dir();
  writeFileSync(join(d, 'bench', 'm', 'long.md'), `${Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n')}\n`);
  const s = measurementsSection(d, ['bench/m/long.md']);
  assert.match(s, /\nline 150\n/);
  assert.doesNotMatch(s, /line 151/);
  assert.match(s, /\(truncated: 50 more lines in the file\)\n$/);
});

test('measurements: a missing path gives the not-found line', () => {
  assert.equal(measurementsSection(dir(), ['bench/m/none.md']), '\n## Measurements\n\n- `bench/m/none.md`: not found in the tree.\n');
});
