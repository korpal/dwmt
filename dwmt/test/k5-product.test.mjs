import './tmp-root.mjs';
// K5 product commands: check everything before the first write (D-18), lean fix sprint file and roadmap budget over open
// rows (D-19), fix sprint price from finished fix sprints (D-20).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { repo } from './helpers.mjs';
import { pr, write, fakeRun, productRepo } from './product-helpers.mjs';
import { specWriteErrors, roadmapErrors, renderRoadmap, BUDGET } from '../scripts/lib/product-store.mjs';

const P = (d, f) => join(d, 'docs', 'product', f);
const R = (d, f) => readFileSync(P(d, f), 'utf8');
const items = (d) => R(d, 'backlog.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const snap = (d, ...files) => files.map((f) => (existsSync(P(d, f)) ? R(d, f) : null));

test('specWriteErrors: a 7000 B body gives 1 error and nothing is written', () => {
  const file = join(repo(), 'none.md');
  const h = { schema: 'dwmt/sprint-spec@1', id: 's1', kind: 'feature', items: [], touch: [], refs: [] };
  const c = specWriteErrors(file, h, `## Goal\n${'x'.repeat(7000)}\n`);
  assert.equal(c.errors.length, 1, c.errors.join('; '));
  assert.equal(existsSync(file), false);
  assert.deepEqual(specWriteErrors(file, h, '## Goal\nSmall.\n').errors, []);
});

test('R-6 spec fix: a 7 KB --file is refused, the item stays unpinned, no sprint file, backlog and roadmap byte-equal', () => {
  const d = productRepo(repo);
  pr(d, 'item', 'add', '--type', 'bug', '--title', 'Crash on save');
  const before = snap(d, 'backlog.jsonl', 'roadmap.md');
  write(d, 'big.md', `## Goal\n${'y'.repeat(7000)}\n\n## Acceptance\n- AC-1 ok\n`);
  const r = pr(d, 'spec', 'fix', 'B-1', '--file', join(d, 'big.md'));
  assert.equal(r.code, 1, r.out);
  assert.equal(items(d)[0].sprint, null);
  assert.equal(existsSync(P(d, 'sprints/fix-b-1.md')), false);
  assert.deepEqual(snap(d, 'backlog.jsonl', 'roadmap.md'), before);
});

test('spec fix: lean goal with ids only and a single criterion; product sprint expands the titles', () => {
  const d = productRepo(repo);
  pr(d, 'item', 'add', '--type', 'bug', '--title', 'Crash on save');
  pr(d, 'item', 'add', '--type', 'remark', '--title', 'Label reads wrong');
  const r = pr(d, 'spec', 'fix', 'B-1', 'B-2', '--id', 'fix-a');
  assert.equal(r.code, 0, r.out);
  const text = R(d, 'sprints/fix-a.md');
  assert.match(text, /## Goal\nResolve the 2 listed items: B-1, B-2\.\n/);
  assert.match(text, /- AC-1 Each listed item is resolved: a bug no longer happens \(its repro steps\), a remark no longer holds \(details: product item <id> --detail\)\./);
  assert.doesNotMatch(text, /AC-2|Crash on save|Label reads wrong/);
  assert.match(pr(d, 'sprint', 'fix-a').out, /Crash on save[\s\S]*Label reads wrong/);
  assert.deepEqual(items(d).map((x) => [x.sprint, x.state]), [['fix-a', 'planned'], ['fix-a', 'planned']]);
});

test('R-6 spec set: items +B-2 with kind wrong is refused, B-2 unpinned, sprint file, backlog and roadmap byte-equal', () => {
  const d = productRepo(repo);
  pr(d, 'item', 'add', '--type', 'feature', '--title', 'One');
  pr(d, 'item', 'add', '--type', 'feature', '--title', 'Two');
  assert.equal(pr(d, 'roadmap', 'add', 's1', '--goal', 'First').code, 0);
  assert.equal(pr(d, 'spec', 'new', 's1', '--items', 'B-1').code, 0);
  const before = snap(d, 'backlog.jsonl', 'roadmap.md', 'sprints/s1.md');
  const r = pr(d, 'spec', 'set', 's1', 'items', '+B-2', 'kind', 'wrong');
  assert.equal(r.code, 1, r.out);
  assert.equal(items(d).find((x) => x.id === 'B-2').sprint, null);
  assert.deepEqual(snap(d, 'backlog.jsonl', 'roadmap.md', 'sprints/s1.md'), before);
  // A valid set still pins.
  assert.equal(pr(d, 'spec', 'set', 's1', 'items', '+B-2', 'kind', 'feature').code, 0);
  assert.equal(items(d).find((x) => x.id === 'B-2').sprint, 's1');
});

test('R-6 item add --detail over 40 lines is refused before the item is added', () => {
  const d = productRepo(repo);
  const before = snap(d, 'backlog.jsonl');
  write(d, 'detail.md', Array.from({ length: BUDGET.detailLines + 1 }, (_, i) => `line ${i}`).join('\n'));
  const r = pr(d, 'item', 'add', '--type', 'bug', '--title', 'Too long', '--detail', join(d, 'detail.md'));
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(snap(d, 'backlog.jsonl'), before);
});

test('roadmapErrors: the 2 KB budget counts rows not done (done rows outside the budget, also in the longest hint)', () => {
  const row = (i, state) => ({ id: `${state === 'done' ? 'd' : 's'}${i}`, state, goal: `Goal number ${i} ${'g'.repeat(50)}`, after: [], alias: null, detail: `sprints/${state === 'done' ? 'd' : 's'}${i}.md`, current: false });
  const open = [];
  while (Buffer.byteLength(renderRoadmap([...open, row(open.length, 'todo')])) <= BUDGET.roadmapBytes - 100) open.push(row(open.length, 'todo'));
  const done = [];
  while (Buffer.byteLength(renderRoadmap([...done, ...open])) - Buffer.byteLength(renderRoadmap(open)) < 600) done.push(row(done.length, 'done'));
  const lines = [...done, ...open];
  assert.ok(Buffer.byteLength(renderRoadmap(lines)) > BUDGET.roadmapBytes, 'the whole roadmap is over the budget');
  assert.deepEqual(roadmapErrors(lines, []), []);
  const all = lines.map((l) => ({ ...l, state: 'todo' }));
  const e = roadmapErrors(all, []);
  assert.equal(e.length, 1, e.join('; '));
  assert.match(e[0], /roadmap\.md: \d+ B > 2048 B/);
});

test('start-check fix sprint: 13 bug items, 3 fix runs and a 293-file feature run give basis "fix sprints n=3" and the items × files rule', () => {
  const d = productRepo(repo);
  const rows = Array.from({ length: 13 }, (_, i) => JSON.stringify({ type: 'bug', title: `Bug ${i + 1}` })).join('\n');
  write(d, 'items.jsonl', `${rows}\n`);
  assert.equal(pr(d, 'item', 'add', '--file', join(d, 'items.jsonl')).code, 0);
  // Fix runs: 2, 3 and 4 changed files for 2 items each (1, 1.5, 2 files per item); their sprint files are archived.
  mkdirSync(P(d, 'archive'), { recursive: true });
  [2, 3, 4].forEach((n, k) => {
    const id = `fix-${k + 1}`;
    fakeRun(d, `r-${id}`, { files: Array.from({ length: n }, (_, i) => `src/fix${k}/f${i}.ts`), cost: n * 0.3, mode: 'direct', spec: id });
    writeFileSync(P(d, `archive/${id}.md`), `---\nschema: dwmt/sprint-spec@1\nid: ${id}\nkind: bugfix\nitems: [B-9${k}, B-8${k}]\ntouch: []\nrefs: []\n---\n## Goal\nFix.\n`);
  });
  fakeRun(d, 'r-feat', { files: Array.from({ length: 293 }, (_, i) => `src/feat/f${i}.ts`), cost: 40, mode: 'single', spec: 'pm-feat' });
  const ids = Array.from({ length: 13 }, (_, i) => `B-${i + 1}`).join(',');
  const r = pr(d, 'start-check', '--item', ids, '--globs', 'src/**');
  assert.equal(r.code, 0, r.out);
  const j = r.json;
  assert.match(j.basis, /fix sprints n=3/);
  assert.match(j.basis, /files: 13 items × 1\.3-1\.8 files\/item \(fix runs n=3\)/);
  assert.equal(j.analog.n, 3, 'the feature run is no analog of a fix sprint');
  // 13 × [1.3, 1.8] = [17, 23] files; M per file from the fix runs (0.3 each) with the batch share default.
  assert.deepEqual(j.prices.direct, [Math.round(17 * 0.3 * 1.15 * 10) / 10, Math.round(23 * 0.3 * 1.15 * 10) / 10]);
});

test('start-check fix sprint without finished fix sprints uses product.price.fixFilesPerItem [1, 3]', () => {
  const d = productRepo(repo);
  pr(d, 'item', 'add', '--type', 'bug', '--title', 'Crash');
  pr(d, 'item', 'add', '--type', 'remark', '--title', 'Wording');
  write(d, 'src/a.ts', 'x\n');
  const j = pr(d, 'start-check', '--item', 'B-1,B-2', '--globs', 'src/**').json;
  assert.match(j.basis, /fix sprints n=0; files: 2 items × 1-3 files\/item \(default\)/);
  assert.ok(j.prices, 'a fix sprint is priced from the item count');
});
