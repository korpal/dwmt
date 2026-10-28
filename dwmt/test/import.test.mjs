import './tmp-root.mjs';
// D4 etap 1, B8: narzędzie importu (spec warstwy produktowej §3.10): adaptery md-sections i gsd-planning, rodzaje reguł,
// idempotencja po `src`, kawałek ponad 4k dzielony, `--dry-run` z ceną, gałąź importu, raport, `retire` tylko po scaleniu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { repo, gitIn } from './helpers.mjs';
import { prEnv, write, config, dw } from './product-helpers.mjs';
import { mdChunks, listUnits, gsdChunks, CHUNK_MAX } from '../scripts/lib/product-import.mjs';

const STUB = fileURLToPath(new URL('./fixtures-importer-stub.mjs', import.meta.url));
const counter = () => join(mkdtempSync(join(tmpdir(), 'dwmt-stub-')), 'count');
const calls = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0);
const R = (d, f) => readFileSync(join(d, 'docs', 'product', f), 'utf8');

const ROADMAP = `# Project roadmap

Intro: who we build for.

## Work order
1. pm-1: Archive bulk delete
2. pm-2 (after pm-1): Export accepted only
3. pm-3 (after pm-2): Supplier price import

## Sprints

### pm-2 Export accepted only
Scope: export lists accepted items.
DoD: the client sees accepted items only.

## Appendix A
- A-1 Duplicate query in \`src/a.ts\` — loader runs twice
- A-2 Unsure mapping: rename the module in \`src/missing.ts\`

## Decisions
- 2026-09-27: Export never shows drafts to clients.

## Done
- pm-0: Initial setup

## Design reference
Long design text stays in this document.
`;
const RULES = [
  { name: 'order', heading: '> Work order$', kind: 'roadmap' },
  { name: 'sprints', heading: '> Sprints > ', kind: 'sprint' },
  { name: 'appendix', heading: '> Appendix A', kind: 'item', type: 'debt', triage: 'later' },
  { name: 'decisions', heading: '> Decisions', kind: 'decision' },
  { name: 'done', heading: '> Done', kind: 'done' },
  { name: 'design', heading: '> Design reference', kind: 'ref' },
];

function project() {
  const d = repo();
  write(d, 'docs/ROADMAP.md', ROADMAP);
  write(d, 'src/a.ts', 'export const a = 1;\n');
  config(d, { product: { import: { sources: [{ name: 'main', path: 'docs/ROADMAP.md', adapter: 'md-sections', rules: RULES }] } } });
  // Agent importu wyrenderowany przez setup (import sprawdza go przed wydatkiem, recenzja N-4).
  assert.equal(dw(d, ['setup']).code, 0);
  gitIn(d)('add', '-A');
  gitIn(d)('commit', '-q', '-m', 'project');
  return d;
}

test('md-sections: jednostki listy i tabel, kawałek ponad 4k dzielony, poddrzewo z tą samą regułą w jednym kawałku', () => {
  assert.deepEqual(listUnits(['- A-1 x', '  more', '- A-2 y', '', '| ID | T |', '|---|---|', '| B-1 | z |']), ['- A-1 x\n  more', '- A-2 y', '| ID | T |\n| B-1 | z |']);
  const big = `# R\n## Items\n- X-1 ${'word '.repeat(1000)}\n${'more line\n'.repeat(80)}`;
  const ch = mdChunks(big, 'docs/R.md', [{ name: 'i', kind: 'item', re: /Items/ }]).filter((c) => c.kind === 'item');
  assert.equal(ch.length, 2);
  assert.ok(ch.every((c) => c.text.length <= CHUNK_MAX));
  assert.deepEqual(ch.map((c) => c.src), ['import:docs/R.md#r-items/x-1', 'import:docs/R.md#r-items/x-1+2']);
  const tree = mdChunks('# R\n## S\n### pm-1 A\ntext\n#### DoD\n- d\n', 'R.md', [{ name: 's', kind: 'sprint', re: /> S > / }]);
  const s = tree.filter((c) => c.kind === 'sprint');
  assert.equal(s.length, 1);
  assert.match(s[0].text, /### pm-1 A\ntext\n#### DoD\n- d/);
});

test('import run --dry-run: kawałki, paczki i cena bez gałęzi i bez zapisu produktu', () => {
  const d = project();
  const r = prEnv(d, {}, 'import', 'run', '--dry-run');
  assert.equal(r.code, 0, r.out);
  const s = r.json.sources[0];
  assert.deepEqual([s.source, s.toCondense, s.skip, s.ref, s.batches], ['main', 6, 1, 1, 1]);
  assert.equal(r.json.priceM.length, 2);
  assert.match(r.json.line, /main: 6 chunks, 1 batches; ~\d/);
  assert.equal(gitIn(d)('branch', '--show-current'), 'master');
  assert.ok(!existsSync(join(d, 'docs', 'product')));
  const chunks = readFileSync(join(d, '.dwmt', 'product', 'import', 'main', 'chunks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(chunks.some((c) => c.rule === 'skip' && c.path === 'Project roadmap'));
  assert.ok(chunks.every((c) => /^import:docs\/ROADMAP\.md#/.test(c.src) && c.text.length <= 4000));
});

test('import run: gałąź importu, roadmap zachowuje kolejność i after, notes, pozycje, PD-n by import, done do indeksu, raport ze skip; idempotentny', () => {
  const d = project();
  const count = counter();
  const env = { DWMT_CLAUDE: STUB, STUB_COUNT: count };
  write(d, 'src/a.ts', 'dirty\n');
  const dirty = prEnv(d, env, 'import', 'run');
  assert.equal(dirty.code, 1);
  assert.match(dirty.json.error, /czystego drzewa/);
  gitIn(d)('checkout', '--', 'src/a.ts');
  const r = prEnv(d, env, 'import', 'run');
  assert.equal(r.code, 0, r.out);
  assert.equal(r.json.branch, 'dwmt/product-import');
  assert.equal(gitIn(d)('branch', '--show-current'), 'dwmt/product-import');
  assert.deepEqual(r.json.sources.main, { item: 2, decision: 1, sprint: 3, done: 1, existing: 0, rejected: 0, review: 2, failed: [] });
  assert.equal(calls(count), 1);
  const lines = R(d, 'roadmap.md').split('\n').filter((l) => /^\|[^|]*\| pm-/.test(l)).map((l) => l.replace(/^\| ▶ \|/, '| |'));
  assert.deepEqual(lines, [
    '| | pm-1 | topic | Archive bulk delete | | none | |',
    '| | pm-2 | notes | Export accepted only | pm-1 | sprints/pm-2.md | |',
    '| | pm-3 | topic | Supplier price import | pm-2 | none | |',
  ]);
  assert.match(R(d, 'sprints/pm-2.md'), /^src: "import:docs\/ROADMAP.md#project-roadmap-sprints-pm-2-export-accepted-only"$/m);
  assert.match(R(d, 'sprints/pm-2.md'), /## Notes\nScope: export lists accepted items/);
  const items = R(d, 'backlog.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(items.map((x) => [x.alias, x.type, x.triage, x.anchors]), [['A-1', 'debt', 'later', ['src/a.ts']], ['A-2', 'debt', 'later', []]]);
  assert.match(items[0].src, /^import:docs\/ROADMAP\.md#project-roadmap-appendix-a\/a-1$/);
  assert.match(R(d, 'decisions.md'), /### PD-1 2026-09-27: Export never shows drafts[\s\S]*by: import/);
  assert.match(R(d, 'archive/index.md'), /^\| pm-0 \| pm-0: Initial setup \| - \| - \| - \| - \| - \|$/m);
  assert.match(gitIn(d)('log', '-1', '--format=%B'), /product: import main\n\n- main: 2 item, 1 decision, 3 sprint, 1 done/);
  const rep = prEnv(d, {}, 'import', 'report').out;
  assert.match(rep, /^main: 2 item, 1 decision, 3 sprint, 1 done; existing 0/m);
  assert.match(rep, /review \(2\):[\s\S]*unsure mapping[\s\S]*anchors not found, dropped: src\/missing.ts/);
  assert.match(rep, /skip \(1\): Project roadmap$/m);
  assert.match(rep, /ref \(1\): Project roadmap > Design reference/);
  assert.ok(rep.split('\n').length <= 30);
  // Ponowny run: kawałki obecne po src, brak wywołań agenta i brak nowego commitu.
  const head = gitIn(d)('rev-parse', 'HEAD');
  const again = prEnv(d, env, 'import', 'run');
  assert.equal(again.code, 0, again.out);
  assert.equal(calls(count), 1);
  assert.equal(gitIn(d)('rev-parse', 'HEAD'), head);
  // Bez wyników na dysku (`.dwmt/product/import` usunięty): dalej po src z plików produktu, bez nowych pozycji.
  rmSync(join(d, '.dwmt', 'product', 'import'), { recursive: true, force: true });
  const third = prEnv(d, env, 'import', 'run');
  assert.equal(third.code, 0, third.out);
  assert.deepEqual([third.json.sources.main.item, third.json.sources.main.decision], [0, 0]);
  assert.equal(gitIn(d)('rev-parse', 'HEAD'), head);
});

test('import retire: odmowa przed scaleniem; po scaleniu sekcje przeniesione zastąpione odnośnikiem, skip i ref zostają', () => {
  const d = project();
  const env = { DWMT_CLAUDE: STUB };
  assert.equal(prEnv(d, env, 'import', 'run').code, 0);
  const onBranch = prEnv(d, env, 'import', 'retire', '--source', 'main');
  assert.equal(onBranch.code, 1);
  assert.match(onBranch.json.error, /tylko na master/);
  gitIn(d)('switch', 'master');
  const notMerged = prEnv(d, env, 'import', 'retire', '--source', 'main');
  assert.equal(notMerged.code, 1);
  assert.match(notMerged.json.error, /nie jest scalona/);
  gitIn(d)('merge', '-q', '--no-edit', 'dwmt/product-import');
  const r = prEnv(d, env, 'import', 'retire', '--source', 'main');
  assert.equal(r.code, 0, r.out);
  assert.equal(r.json.retired, 5);
  const text = readFileSync(join(d, 'docs', 'ROADMAP.md'), 'utf8');
  assert.match(text, /Intro: who we build for\./);
  assert.match(text, /Long design text stays in this document\./);
  assert.doesNotMatch(text, /A-1 Duplicate query/);
  assert.match(text, /## Work order\n\n> Moved to `docs\/product\/` by dwmt import/);
  assert.match(text, /### pm-2 Export accepted only\n\n> Moved/);
  assert.match(gitIn(d)('log', '-1', '--format=%s'), /import retire main/);
});

test('gsd-planning: fazy z after i stanem, wymagania z aliasem i triage sprint:<faza>', () => {
  const d = repo();
  write(d, '.planning/ROADMAP.md', `# Roadmap

## Phases
- [x] **Phase 1: Foundation** - base
- [ ] **Phase 2: Auth** - login

## Phase Details

### Phase 1: Foundation
**Goal**: base app
**Status**: Complete

### Phase 2: Auth
**Goal**: users log in
**Depends on**: Phase 1
**Requirements**: AUTH-01

#### Plans
- 02-01 login form
`);
  write(d, '.planning/REQUIREMENTS.md', `# Requirements

## v1
- [ ] **AUTH-01**: User can log in with email
- [x] **BASE-01**: App starts

## Traceability
| Requirement | Phase | Status |
|---|---|---|
| AUTH-01 | Phase 2 | Pending |
| BASE-01 | Phase 1 | Complete |
`);
  write(d, '.planning/CONTINUE.md', '# Continue\n\nNext: finish the login form.\n');
  config(d, { product: { import: { sources: [{ name: 'gsd', path: '.planning', adapter: 'gsd-planning', rules: [] }] } } });
  assert.equal(dw(d, ['setup']).code, 0);
  gitIn(d)('add', '-A');
  gitIn(d)('commit', '-q', '-m', 'gsd');
  const dry = prEnv(d, {}, 'import', 'run', '--dry-run');
  assert.equal(dry.code, 0, dry.out);
  const chunks = readFileSync(join(d, '.dwmt', 'product', 'import', 'gsd', 'chunks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const p2 = chunks.find((c) => c.meta?.id === 'phase-2');
  assert.deepEqual([p2.kind, p2.meta.after, p2.meta.done], ['sprint', ['phase-1'], false]);
  assert.match(p2.text, /#### Plans\n- 02-01 login form/);
  assert.equal(chunks.find((c) => c.meta?.id === 'phase-1').kind, 'done');
  const req = chunks.find((c) => c.meta?.id === 'AUTH-01');
  assert.deepEqual([req.kind, req.type, req.meta.phase, req.src], ['item', 'feature', 'phase-2', 'import:.planning/REQUIREMENTS.md#auth-01']);
  assert.ok(chunks.some((c) => c.path.startsWith('CONTINUE.md') && c.rule === 'skip'));
  const r = prEnv(d, { DWMT_CLAUDE: STUB }, 'import', 'run');
  assert.equal(r.code, 0, r.out);
  assert.match(R(d, 'roadmap.md'), /^\| ▶ \| phase-2 \| notes \| Auth \| phase-1 \|/m);
  assert.match(R(d, 'archive/index.md'), /^\| phase-1 \| Foundation/m);
  const items = R(d, 'backlog.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(items.map((x) => [x.alias, x.triage, x.state]), [['AUTH-01', 'sprint:phase-2', 'open'], ['BASE-01', 'sprint:phase-1', 'done']]);
});

test('import bez źródeł w configu: błąd z nazwą klucza', () => {
  const d = repo();
  const r = prEnv(d, {}, 'import', 'run', '--dry-run');
  assert.equal(r.code, 1);
  assert.match(r.json.error, /product\.import\.sources/);
});

test('gsd-planning: tabela śladu także w formie „| REQ-1 | 2 — Nazwa |”', () => {
  const d = mkdtempSync(join(tmpdir(), 'dwmt-gsd-'));
  write(d, '.planning/REQUIREMENTS.md', '# Req\n\n## v1\n\n- [x] **AUTH-01**: login\n- [ ] **FILE-02**: upload\n\n## Trace\n\n| Wymaganie | Faza | Stan |\n|---|---|---|\n| AUTH-01 | 2 — Wejście | Zrobione |\n| FILE-02 | 10 — Pliki | Zaplanowane |\n');
  const ch = gsdChunks(join(d, '.planning'), '.planning', [{ name: 'r', kind: 'item', re: /^REQUIREMENTS\.md > / }]);
  assert.deepEqual(ch.map((c) => [c.meta.id, c.meta.phase, c.meta.done]), [['AUTH-01', 'phase-2', true], ['FILE-02', 'phase-10', false]]);
});

