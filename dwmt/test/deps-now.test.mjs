import './tmp-root.mjs';
// kf2 (C-1, D-1 … D-4): bieżące zależności pozycji zlecenia i priorytet startu z roadmapy głównego drzewa; lista zapisana
// przy zleceniu tylko w zastępstwie (bez warstwy produktowej, bez linii, `--file`, poprawki, roadmapa nieczytelna).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { currentAfter, orderByRoadmap, runAfter, runOrder, roadmapLines, firstTaskStarted, runDepsNow } from '../scripts/lib/deps.mjs';
import { renderRoadmap } from '../scripts/lib/product-store.mjs';

const line = (id, after = [], state = 'ready') => ({ id, state, goal: `Goal ${id}`, after, detail: `sprints/${id}.md`, alias: null, current: false });
function main({ product = true, rows = null, raw = null, sup = null } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'dwmt-depsnow-'));
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude', 'dwmt.json'), JSON.stringify(product ? { product: {} } : {}));
  if (product) {
    mkdirSync(join(d, 'docs', 'product'), { recursive: true });
    if (rows || raw) writeFileSync(join(d, 'docs', 'product', 'roadmap.md'), raw ?? renderRoadmap(rows));
  }
  if (sup) {
    mkdirSync(join(d, '.dwmt', 'supervisor'), { recursive: true });
    writeFileSync(join(d, '.dwmt', 'supervisor', 'supervisor.json'), JSON.stringify(sup));
  }
  return d;
}
const ids = (xs) => xs.map((x) => x.id);

test('kf2 currentAfter: no product dir → stored list; roadmap line wins over the stored list', () => {
  const none = main({ product: false });
  assert.equal(roadmapLines(none), null);
  assert.deepEqual(currentAfter(none, { id: 'b', src: 'spec', after: ['a'] }, { sup: { items: [] } }), ['a']);
  const d = main({ rows: [line('a'), line('b', ['a'])] });
  assert.deepEqual(currentAfter(d, { id: 'b', src: 'spec', after: ['x'] }, { sup: { items: [] } }), ['a']);
  // Item without a line: stored list (D-3).
  assert.deepEqual(currentAfter(d, { id: 'z', src: 'spec', after: ['q'] }, { sup: { items: [] } }), ['q']);
});

test('kf2 currentAfter seq: nearest order item above in the roadmap, not the item appended before (B-16 shape)', () => {
  const items = [{ id: 'a', src: 'spec', after: [] }, { id: 'b', src: 'spec', seq: true, after: ['a'] }, { id: 'c', src: 'spec', seq: true, after: ['b'] }];
  const d = main({ rows: [line('a'), line('c'), line('b')], sup: { items } });
  assert.deepEqual(currentAfter(d, items[1]), ['c'], 'sup read from main');
  assert.deepEqual(currentAfter(d, items[2], { sup: { items } }), ['a']);
  assert.deepEqual(currentAfter(d, items[0], { sup: { items } }), []);
  // Already listed: not added twice.
  const lines = [line('a'), line('c', ['a'])];
  assert.deepEqual(currentAfter(d, { id: 'c', src: 'spec', seq: true, after: [] }, { sup: { items }, lines }), ['a']);
});

test('kf2 currentAfter fallback: --file and fix items keep the stored list; malformed roadmap → stored list, no throw', () => {
  const d = main({ rows: [line('f'), line('g', ['f'])] });
  assert.deepEqual(currentAfter(d, { id: 'g', src: 'file', after: ['q'] }, { sup: { items: [] } }), ['q']);
  assert.deepEqual(currentAfter(d, { id: 'g', src: 'fix', after: [] }, { sup: { items: [] } }), []);
  const bad = main({ raw: '# dwmt/roadmap@2 — row order = work order\n\n| | id | state | goal | after | detail | alias |\n|---|---|---|---|---|---|---|\n| | b | ready |\n' });
  assert.equal(roadmapLines(bad), null);
  assert.deepEqual(currentAfter(bad, { id: 'b', src: 'spec', after: ['a'] }), ['a']);
  // A broken line object passed in: still the stored list.
  assert.deepEqual(currentAfter(d, { id: 'b', src: 'spec', after: ['a'] }, { lines: [null] }), ['a']);
});

test('kf2 orderByRoadmap: roadmap items in row order on their own slots, the others keep their position', () => {
  const lines = [line('a'), line('b')];
  assert.deepEqual(ids(orderByRoadmap([{ id: 'f1', src: 'file' }, { id: 'b', src: 'spec' }, { id: 'a', src: 'spec' }], lines)), ['f1', 'a', 'b']);
  assert.deepEqual(ids(orderByRoadmap([{ id: 'a', src: 'spec' }, { id: 'f1', src: 'file' }, { id: 'b', src: 'spec' }], [line('b'), line('a')])), ['b', 'f1', 'a']);
  const items = [{ id: 'b', src: 'spec' }, { id: 'a', src: 'spec' }];
  assert.deepEqual(ids(orderByRoadmap(items, null)), ['b', 'a'], 'no roadmap: unchanged copy');
  assert.deepEqual(ids(items), ['b', 'a'], 'input not sorted in place');
  // A file item whose id has a line does not follow the roadmap (D-3).
  assert.deepEqual(ids(orderByRoadmap([{ id: 'b', src: 'file' }, { id: 'a', src: 'spec' }], lines)), ['b', 'a']);
});

test('kf2 runAfter and runOrder: the order item of run.sprint follows the roadmap; otherwise the run\'s own lists', () => {
  const items = [{ id: 'a', src: 'spec', after: ['b'] }, { id: 'b', src: 'spec', after: [] }];
  const d = main({ rows: [line('b', ['a']), line('a')], sup: { items } });
  assert.deepEqual(runAfter(d, { sprint: 'x', after: ['q'], order: ['q', 'x'] }), ['q']);
  assert.deepEqual(runOrder(d, { sprint: 'x', after: ['q'], order: ['q', 'x'] }), ['q', 'x']);
  assert.deepEqual(runAfter(d, { sprint: 'a', after: ['b'], order: ['a', 'b'] }), []);
  assert.deepEqual(runAfter(d, { sprint: 'b', after: [], order: ['a', 'b'] }), ['a']);
  assert.deepEqual(runOrder(d, { sprint: 'a', after: ['b'], order: ['a', 'b'] }), ['b', 'a']);
  // `sup` in memory wins over the file.
  assert.deepEqual(runOrder(d, { sprint: 'a', order: ['z'] }, { sup: { items: [] } }), ['z']);
  // No product layer: run lists for an item of the order too.
  const none = main({ product: false, sup: { items } });
  assert.deepEqual(runAfter(none, { sprint: 'a', after: ['b'] }), ['b']);
  assert.deepEqual(runOrder(none, { sprint: 'a', order: ['a', 'b'] }), ['a', 'b']);
});

test('kf2 firstTaskStarted (C-2): task 1 without startEvent and started → false; startEvent, started or task > 1 → true', () => {
  assert.equal(firstTaskStarted({ task: 1, tasks: [{ started: {} }] }), false);
  assert.equal(firstTaskStarted({ task: 1, tasks: [{ started: {}, startEvent: '2026-10-23T00:00:00.000Z' }] }), true);
  assert.equal(firstTaskStarted({ task: 1, tasks: [{ started: { 1: '2026-10-23T00:00:00.000Z' } }] }), true);
  assert.equal(firstTaskStarted({ task: 2, tasks: [{ started: {} }, { started: {} }] }), true);
  assert.equal(firstTaskStarted(null), false, 'never throws');
  assert.equal(firstTaskStarted({ task: 1, tasks: null }), false);
});

test('kf2 runDepsNow (D-6, D-9): the order before the first task, the run\'s own lists once it started', () => {
  const items = [{ id: 'a', src: 'spec', after: ['b'] }, { id: 'b', src: 'spec', after: [] }];
  const d = main({ rows: [line('b', ['a']), line('a')], sup: { items } });
  const fresh = { sprint: 'b', after: ['q'], order: ['q', 'b'], task: 1, tasks: [{ started: {} }] };
  assert.deepEqual(runDepsNow(d, fresh), { after: runAfter(d, fresh), order: runOrder(d, fresh) });
  assert.deepEqual(runDepsNow(d, fresh), { after: ['a'], order: ['b', 'a'] });
  const started = { ...fresh, tasks: [{ started: {}, startEvent: '2026-10-23T00:00:00.000Z' }] };
  assert.deepEqual(runDepsNow(d, started), { after: ['q'], order: ['q', 'b'] });
  assert.deepEqual(runDepsNow(d, { ...fresh, task: 2 }), { after: ['q'], order: ['q', 'b'] });
});
