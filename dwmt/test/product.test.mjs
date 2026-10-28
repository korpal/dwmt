import './tmp-root.mjs';
// D4 etap 1, B1: mechanika `product.mjs` (spec warstwy produktowej §3, §7, §10 „Testy”).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { repo, gitIn } from './helpers.mjs';
import { pr, prEnv, prAsync, dw, write, config, fakeRun, productRepo, expertText } from './product-helpers.mjs';
import { parseRoadmap, renderRoadmap, parseIndex, appendIndex, readSpecAt, ITEM_KEYS, normItem, itemErrors } from '../scripts/lib/product-store.mjs';
import { productConfig } from '../scripts/lib/product-config.mjs';

const R = (d, f) => readFileSync(join(d, 'docs', 'product', f), 'utf8');
const items = (d) => R(d, 'backlog.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('warstwy (P-11): bez katalogu produktu komendy produktu odmawiają, intake nic nie robi, setup bez agenta importu', () => {
  const d = repo();
  const b = pr(d, 'brief');
  assert.equal(b.code, 1);
  assert.match(b.json.error, /product init/);
  const i = pr(d, 'intake', 'x');
  assert.equal(i.code, 0);
  assert.equal(i.json.skipped, 'no product layer');
  const s = dw(d, ['setup']);
  assert.equal(s.code, 0, s.out);
  assert.ok(!existsSync(join(d, '.claude', 'agents', 'dwmt-importer.md')));
  // Z kluczem `product` setup renderuje agenta importu (model i effort z product.import.agent).
  const cfg = JSON.parse(readFileSync(join(d, '.claude', 'dwmt.json'), 'utf8'));
  config(d, { ...cfg, product: { import: { agent: { model: 'opus', effort: 'medium' } } } });
  assert.equal(dw(d, ['setup']).code, 0);
  const imp = readFileSync(join(d, '.claude', 'agents', 'dwmt-importer.md'), 'utf8');
  assert.match(imp, /^name: dwmt-importer$/m);
  assert.match(imp, /^effort: medium$/m);
  assert.ok(imp.split('\n').length <= 40);
});

test('product.enabled false: komendy piszące odmawiają, intake pomija', () => {
  const d = productRepo(repo);
  config(d, { product: { enabled: false } });
  const r = pr(d, 'item', 'add', '--type', 'idea', '--title', 'X');
  assert.equal(r.code, 1);
  assert.match(r.json.error, /wyłączona/);
  assert.equal(pr(d, 'intake', 'r1').json.skipped, 'product.enabled false');
  assert.equal(pr(d, 'list').code, 0);
});

test('init: szkielet, cel, .dwmt wykluczone z gita', () => {
  const d = productRepo(repo);
  for (const f of ['backlog.jsonl', 'decisions.md', 'roadmap.md', 'archive/index.md', 'estimates.jsonl', 'vision.md']) assert.ok(existsSync(join(d, 'docs', 'product', f)), f);
  assert.match(R(d, 'vision.md'), /## Goal\nPilot: build cost/);
  assert.match(readFileSync(join(d, '.git', 'info', 'exclude'), 'utf8'), /^\.dwmt\/$/m);
});

test('PD-n: numeracja pod blokadą przy równoczesnych zapisach', async () => {
  const d = productRepo(repo);
  const rs = await Promise.all([1, 2, 3, 4].map((n) => prAsync(d, ['decision', 'add', '--title', `Rule ${n}`, '--area', 'export', '--decision', `Decision ${n}`])));
  for (const r of rs) assert.equal(r.code, 0, r.out);
  assert.deepEqual(rs.map((r) => r.json.id).sort(), ['PD-1', 'PD-2', 'PD-3', 'PD-4']);
  const list = pr(d, 'decision', 'list').out.split('\n');
  assert.equal(list.length, 4);
  assert.ok(!existsSync(join(d, '.dwmt', 'product', 'lock')));
});

test('decision add --by ux bez --confirmed: odmowa; z potwierdzeniem: linia Confirmed i commit od razu', () => {
  const d = productRepo(repo);
  const no = pr(d, 'decision', 'add', '--by', 'ux', '--title', 'Two steps max', '--decision', 'Wizard has two steps');
  assert.equal(no.code, 1);
  assert.match(no.json.error, /--confirmed/);
  const ok = pr(d, 'decision', 'add', '--by', 'ux', '--confirmed', 'tak, max dwa kroki', '--title', 'Two steps max', '--area', 'ux', '--decision', 'Wizard has two steps');
  assert.equal(ok.code, 0, ok.out);
  assert.equal(ok.json.id, 'PD-1');
  assert.equal(ok.json.commit.committed, true);
  assert.match(R(d, 'decisions.md'), /^area: ux; at: \d{4}-\d\d-\d\d; src: -; by: ux$/m);
  assert.match(R(d, 'decisions.md'), /^Confirmed: "tak, max dwa kroki"$/m);
  assert.match(gitIn(d)('log', '-1', '--format=%s'), /PD-1 added \(ux\)/);
  assert.equal(gitIn(d)('status', '--porcelain'), '');
});

test('decision supersede, find, list; item PD-n z archiwum', () => {
  const d = productRepo(repo);
  pr(d, 'decision', 'add', '--title', 'Export all items', '--area', 'export', '--decision', 'Export lists all items', '--why', 'simple');
  pr(d, 'decision', 'add', '--title', 'Export accepted only', '--area', 'export', '--decision', 'Export lists accepted items only', '--against', 'export with status column');
  const s = pr(d, 'decision', 'supersede', 'PD-1', '--by', 'PD-2');
  assert.equal(s.code, 0, s.out);
  assert.doesNotMatch(R(d, 'decisions.md'), /PD-1 /);
  assert.match(R(d, 'decisions.md'), /Supersedes: PD-1/);
  assert.match(R(d, 'decisions.md'), /Against recommendation: yes — export with status column/);
  assert.match(R(d, 'decisions-archive.md'), /### PD-1 Export all items[\s\S]*Superseded by: PD-2/);
  assert.match(pr(d, 'decision', 'find', 'accepted', 'export').out, /### PD-2/);
  assert.equal(pr(d, 'decision', 'find', 'nothinglikethis').out, 'none');
  assert.match(pr(d, 'item', 'PD-1').out, /archived: superseded/);
});

test('pozycje: add z budżetem, alias, item <alias>, pozycja z archiwum, list z filtrami', () => {
  const d = productRepo(repo);
  write(d, 'src/ui/date-picker.tsx', 'x\n');
  const long = pr(d, 'item', 'add', '--type', 'bug', '--title', 'x'.repeat(91));
  assert.equal(long.code, 1);
  assert.match(long.json.error, /title 91 > 90/);
  assert.equal(pr(d, 'item', 'add', '--type', 'remark', '--title', 'T', '--triage', 'touch').code, 1, 'touch bez kotwic');
  assert.equal(pr(d, 'item', 'add', '--type', 'remark', '--title', 'T', '--anchors', 'src/a.ts:12').code, 1, 'kotwica z numerem linii');
  const a = pr(d, 'item', 'add', '--type', 'bug', '--title', 'Date picker overflows', '--sev', 'minor', '--anchors', 'src/ui/date-picker.tsx', '--alias', 'A-7', '--note', 'at 1024 px');
  assert.equal(a.code, 0, a.out);
  assert.equal(pr(d, 'item', 'add', '--type', 'idea', '--title', 'Dup', '--alias', 'a-7').code, 1, 'alias unikalny');
  pr(d, 'item', 'add', '--type', 'idea', '--title', 'Offline mode', '--triage', 'later');
  const det = join(d, '..', `det-${Date.now()}.md`);
  writeFileSync(det, 'Repro:\n1. open dialog\nExpected: fits\n');
  assert.equal(pr(d, 'item', 'set', 'B-1', '--detail', det).code, 0);
  assert.match(pr(d, 'item', 'B-1', '--detail').out, /detail: items\/B-1.md\n\nRepro:\n1. open dialog/);
  writeFileSync(det, 'x\n'.repeat(41));
  assert.match(pr(d, 'item', 'set', 'B-1', '--detail', det).json.error, /ponad 40 linii/);
  assert.match(pr(d, 'item', 'a-7').out, /^B-1 bug minor new \(A-7\): Date picker overflows\nnote: at 1024 px/);
  assert.equal(pr(d, 'list', '--state', 'open').out, 'B-2 idea open later: Offline mode');
  assert.match(pr(d, 'list', '--touch', 'src/ui/**').out, /^B-1 /);
  assert.equal(pr(d, 'list', '--touch', 'src/api').out, 'none');
  // Zamknięta pozycja przechodzi do archiwum przy sync, a item <id> dalej ją znajduje.
  assert.equal(pr(d, 'item', 'set', 'B-2', 'state', 'dropped').code, 0);
  pr(d, 'sync');
  assert.equal(items(d).length, 1);
  assert.match(R(d, 'backlog-archive.jsonl'), /"B-2"/);
  assert.match(pr(d, 'item', 'B-2').out, /\(archived\)$/m);
  assert.equal(pr(d, 'item', 'set', 'B-2', 'title', 'x').code, 1, 'archiwum tylko do odczytu');
});

test('expert: walidacja pliku, plik projektu zastępuje wbudowanego, start zapisuje sesję', () => {
  const d = productRepo(repo);
  const builtin = mkdtempSync(join(tmpdir(), 'dwmt-experts-'));
  writeFileSync(join(builtin, 'ux.md'), expertText('ux', { title: 'Built-in UX' }));
  writeFileSync(join(builtin, 'po.md'), expertText('po'));
  writeFileSync(join(builtin, 'bad.md'), expertText('bad', { drop: 'maximizes' }));
  writeFileSync(join(builtin, 'long.md'), expertText('long', { lines: 40 }));
  const E = { DWMT_EXPERTS_DIR: builtin };
  write(d, 'docs/product/experts/ux.md', expertText('ux', { title: 'Project UX' }));
  const list = prEnv(d, E, 'expert', 'list').out;
  assert.match(list, /^ux · Project UX · project/m);
  assert.match(list, /^bad · .*INVALID: brak pola maximizes/m);
  assert.match(list, /^long · .*INVALID: \d+ linii > 40/m);
  assert.match(prEnv(d, E, 'expert', 'show', 'ux').out, /title: Project UX/);
  assert.equal(prEnv(d, E, 'expert', 'show', 'bad').code, 1);
  assert.match(prEnv(d, E, 'expert', 'show', 'nope').json.error, /dostępni: bad, long, po, ux/);
  const st = prEnv(d, E, 'expert', 'start', 'ux', '--session', 'abc-123');
  assert.equal(st.code, 0, st.out);
  assert.match(st.out, /brief for ux/);
  const state = JSON.parse(readFileSync(join(d, '.dwmt', 'product', 'state.json'), 'utf8'));
  assert.deepEqual(state.sessions.ux, ['abc-123']);
  assert.ok(state.doorBrief.ux, 'drzwi mają własny znacznik (recenzja N-4)');
  assert.equal(prEnv(d, E, 'expert', 'new', 'security').code, 0);
  assert.match(readFileSync(join(d, 'docs', 'product', 'experts', 'security.md'), 'utf8'), /domain: security/);
});

test('roadmapa: zależności, budżet, znacznik *, next', () => {
  const d = productRepo(repo);
  assert.equal(pr(d, 'roadmap', 'add', 'pm-1', '--goal', 'Archive bulk delete').code, 0);
  const bad = pr(d, 'roadmap', 'add', 'pm-2', '--goal', 'Export', '--after', 'pm-9');
  assert.equal(bad.code, 1);
  assert.match(bad.json.error, /zależność pm-9 nie istnieje/);
  assert.equal(pr(d, 'roadmap', 'add', 'pm-2', '--goal', 'Export accepted only', '--after', 'pm-1').code, 0);
  const before = pr(d, 'roadmap', 'move', 'pm-2', '--before', 'pm-1');
  assert.equal(before.code, 1);
  assert.match(before.json.error, /stoi przed swoją zależnością pm-1/);
  assert.equal(pr(d, 'roadmap', 'add', 'pm-3', '--goal', 'Supplier price import', '--alias', 'R2.3').code, 0);
  assert.match(R(d, 'roadmap.md'), /^\| ▶ \| pm-1 \| topic \|/m);
  // next: bez ready pierwszy topic ze spełnionymi after; po ready pm-2 (zależność niescalona) dalej pm-1.
  assert.match(pr(d, 'roadmap', 'next').out, /^next: pm-1 · topic/);
  pr(d, 'decision', 'add', '--title', 'Accepted only', '--decision', 'Accepted items only');
  pr(d, 'spec', 'new', 'pm-2', '--goal', 'Export');
  pr(d, 'spec', 'set', 'pm-2', '--file', writeSpecBody(d));
  pr(d, 'spec', 'set', 'pm-2', 'est', 'start:1,2');
  assert.equal(pr(d, 'ready', 'pm-2', '--direct').json.ok, true);
  assert.match(pr(d, 'roadmap', 'next').out, /^next: pm-1 · topic/);
  pr(d, 'spec', 'new', 'pm-3');
  pr(d, 'spec', 'set', 'pm-3', '--file', writeSpecBody(d));
  pr(d, 'spec', 'set', 'pm-3', 'est', 'start:1,2');
  pr(d, 'ready', 'pm-3', '--direct');
  const nx = pr(d, 'roadmap', 'next').out;
  assert.match(nx, /^next: pm-3 · ready/);
  assert.match(R(d, 'roadmap.md'), /^\| ▶ \| pm-3 \| ready \|/m);
  // running ma pierwszeństwo w znaczniku.
  pr(d, 'roadmap', 'set', 'pm-1', 'state', 'running');
  assert.equal(pr(d, 'roadmap', 'set', 'pm-1', 'state', 'running').code, 1, 'running wymaga pliku sprintu');
  // Ponad budżet 2 KB: odmowa.
  let r;
  for (let i = 10; i < 40; i++) { r = pr(d, 'roadmap', 'add', `pm-${i}`, '--goal', `Long topic number ${i} with a goal that takes a fair share of the line`); if (r.code) break; }
  assert.equal(r.code, 1);
  assert.match(r.json.error, /B > 2048 B/);
});

function writeSpecBody(d) {
  const f = join(d, '..', `spec-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(f, '## Goal\nExport lists accepted items only (PD-1).\n\n## Acceptance\n- AC-1 The client sees accepted items only.\n\n## Decisions\n- PD-1\n\n## Out of scope\n- nothing\n\n## Open questions\n- [architect] where the filter lives\n');
  return f;
}

test('sprint <id>: rozwija pozycje i PD-n, refs jako lista; --json z after z roadmapy i nagłówkiem', () => {
  const d = productRepo(repo);
  pr(d, 'decision', 'add', '--title', 'Export accepted only', '--area', 'export', '--decision', 'Accepted items only');
  pr(d, 'item', 'add', '--type', 'feature', '--title', 'Export filter', '--note', 'client view');
  pr(d, 'roadmap', 'add', 'pm-1', '--goal', 'Base');
  pr(d, 'roadmap', 'add', 'pm-2', '--goal', 'Export accepted only', '--after', 'pm-1', '--alias', 'R2');
  assert.equal(pr(d, 'spec', 'new', 'pm-2', '--items', 'B-1').code, 0);
  pr(d, 'spec', 'set', 'pm-2', '--file', writeSpecBody(d), 'refs', 'docs/DESIGN.md#Archive screen');
  const t = pr(d, 'sprint', 'pm-2').out;
  assert.match(t, /^pm-2 · notes · Export accepted only · after: \[pm-1\]/);
  assert.match(t, /## Items \(expanded\)\n- B-1 feature planned sprint:pm-2: Export filter — client view/);
  assert.match(t, /## Decisions \(expanded\)\n### PD-1 Export accepted only\narea: export/);
  assert.match(t, /## Refs.*\n- docs\/DESIGN.md#Archive screen/);
  const j = pr(d, 'sprint', 'pm-2', '--json').json;
  assert.deepEqual(j.after, ['pm-1']);
  assert.equal(j.alias, 'R2');
  assert.equal(j.state, 'notes');
  assert.deepEqual(j.header.items, ['B-1']);
  assert.deepEqual(j.header.refs, ['docs/DESIGN.md#Archive screen']);
  assert.equal(j.header.mode, 'auto');
  assert.match(j.body, /### PD-1/);
  assert.equal(items(d)[0].sprint, 'pm-2');
  assert.match(pr(d, 'sprint', 'pm-1').out, /no sprint file \(topic\)/);
});

test('ready-check: --direct z est start:, bez --direct odmowa; kontrole AC, pytań, PD-n, pozycji', () => {
  const d = productRepo(repo);
  pr(d, 'roadmap', 'add', 'pm-1', '--goal', 'Export');
  pr(d, 'spec', 'new', 'pm-1');
  let rc = pr(d, 'ready-check', 'pm-1', '--direct').json;
  assert.equal(rc.ok, false);
  assert.ok(rc.errors.some((e) => /AC-n/.test(e)));
  assert.ok(rc.errors.some((e) => /Out of scope/.test(e)));
  pr(d, 'spec', 'set', 'pm-1', '--file', writeSpecBody(d), 'est', 'start:1.2,2.4');
  rc = pr(d, 'ready-check', 'pm-1', '--direct').json;
  assert.deepEqual(rc.errors, ['PD-1: brak albo zastąpiona']);
  pr(d, 'decision', 'add', '--title', 'Accepted only', '--decision', 'Accepted items only');
  assert.equal(pr(d, 'ready-check', 'pm-1', '--direct').json.ok, true);
  assert.match(pr(d, 'ready-check', 'pm-1').json.errors.join(), /start:\[min,max\] wystarcza tylko z --direct/);
  pr(d, 'spec', 'set', 'pm-1', '--section', 'Open questions', '--text', '- Which clients see it?');
  assert.match(pr(d, 'ready-check', 'pm-1', '--direct').json.errors.join(), /Open questions/);
  pr(d, 'spec', 'set', 'pm-1', '--section', 'Open questions', '--text', '- [architect] where');
  pr(d, 'spec', 'set', 'pm-1', 'ui', 'true');
  assert.match(pr(d, 'ready-check', 'pm-1', '--direct').json.errors.join(), /Mockups/);
  pr(d, 'spec', 'set', 'pm-1', '--section', 'Mockups', '--text', 'sketches/029, variant B, states: empty, many');
  assert.match(pr(d, 'ready-check', 'pm-1', '--direct').json.errors.join(), /## Journey/, 'a6-fix: ekran bez przejścia ścieżki nie jest gotowy');
  pr(d, 'spec', 'set', 'pm-1', '--section', 'Journey', '--text', '- Export: list -> "Eksportuj" -> file; entry kept: list menu; added: none');
  const ready = pr(d, 'ready', 'pm-1', '--direct');
  assert.equal(ready.json.ok, true, ready.out);
  assert.match(R(d, 'roadmap.md'), /\| pm-1 \| ready \|/);
  assert.match(R(d, 'sprints/pm-1.md'), /^ready: \{"at":"\d{4}-\d\d-\d\d","by":"decydent","direct":true\}$/m);
  assert.equal(pr(d, 'roadmap', 'set', 'pm-1', 'state', 'ready').code, 1, 'ready tylko przez product ready');
});

test('rozmiar pliku sprintu: ostrzeżenie ponad 3 KB, odmowa ponad 6 KB', () => {
  const d = productRepo(repo);
  pr(d, 'roadmap', 'add', 'pm-1', '--goal', 'Big');
  pr(d, 'spec', 'new', 'pm-1');
  const w = pr(d, 'spec', 'set', 'pm-1', '--section', 'Notes', '--text', 'n'.repeat(3500));
  assert.match(w.json.warning, /> 3072 B/);
  const e = pr(d, 'spec', 'set', 'pm-1', '--section', 'Notes', '--text', 'n'.repeat(7000));
  assert.equal(e.code, 1);
  assert.match(e.json.error, /> 6144 B/);
});

test('zamknięcie sprintu przez sync: plik w archive/, linia indeksu, brak linii w rdzeniu, pozycje done, kalibracja actual', () => {
  const d = productRepo(repo);
  pr(d, 'item', 'add', '--type', 'feature', '--title', 'Bulk delete');
  pr(d, 'item', 'add', '--type', 'remark', '--title', 'Gap item');
  pr(d, 'roadmap', 'add', 'pm-1', '--goal', 'Archive bulk delete');
  pr(d, 'roadmap', 'add', 'pm-2', '--goal', 'Next', '--after', 'pm-1');
  pr(d, 'spec', 'new', 'pm-1', '--items', 'B-1,B-2');
  write(d, '.dwmt/product/estimate-E-1/result.md', '---\nschema: dwmt/estimate-result@1\nentries:\n  - {for: [pm-1], areas: ["src/**"], files: [2, 4], flags: {newArea: false, contract: false, migration: false, screens: 0}, split: null}\n---\n## Facts\n- x\n');
  assert.equal(pr(d, 'estimate-record', 'E-1', '--cost', '0.3').code, 0);
  pr(d, 'roadmap', 'set', 'pm-1', 'state', 'ordered');
  // Przebieg w toku: running; po squashu z luką B-2 i uat pending: done, B-1 done, B-2 planned.
  const { dir } = fakeRun(d, 'r-pm-1', { files: ['src/a.ts', 'src/b.ts', 'src/c.ts'], cost: 3, spec: 'pm-1', uat: 'pending' });
  writeFileSync(join(dir, 'goal-check.md'), '---\nschema: dwmt/goal-check@1\nitems:\n  - {id: "AC-1", element: "B-1 bulk delete", status: delivered}\n  - {id: "B-2", element: "gap item", status: gap}\n---\n');
  const s1 = pr(d, 'sync');
  assert.equal(s1.code, 0, s1.out);
  assert.match(R(d, 'roadmap.md'), /\| pm-1 \| done \|/);
  assert.match(pr(d, 'item', 'B-2').out, /^B-2 remark planned/);
  assert.match(pr(d, 'item', 'B-1').out, /\(archived\)/);
  assert.deepEqual(JSON.parse(R(d, 'estimates.jsonl').trim()).actual, { files: 3, tokensM: 3, run: 'r-pm-1' });
  assert.match(pr(d, 'brief').out, /waiting for UAT pm-1/);
  // Lines of the squash commit: three one-line files.
  assert.equal(readSpecAt(join(d, 'docs', 'product', 'sprints', 'pm-1.md')).h.actual.lines, 3);
  // An older archived sprint (6-column row) is filled in the same sync that appends pm-1: both rows survive.
  fakeRun(d, 'r-s1', { files: ['src/x.ts', 'src/y.ts'], cost: 3, spec: 's-1' });
  write(d, 'docs/product/archive/index.md', '# dwmt/archive-index@2 — closed sprints\n\n| id | goal | merged | run | files | tokensM |\n|---|---|---|---|---|---|\n| s-1 | Old one | 2026-10-01 | r-s1 | 2 | 3 |\n');
  // Zapis UAT → zamknięcie.
  writeFileSync(join(dir, 'uat.md'), '---\nschema: "dwmt/uat@1"\nsprint: "pm-1"\nentries: [{"n":1,"kind":"uat","result":"positive"}]\ndefects: []\n---\n# UAT\n');
  pr(d, 'sync');
  assert.ok(existsSync(join(d, 'docs', 'product', 'archive', 'pm-1.md')));
  assert.ok(!existsSync(join(d, 'docs', 'product', 'sprints', 'pm-1.md')));
  assert.doesNotMatch(R(d, 'roadmap.md'), /pm-1 ·/);
  assert.match(R(d, 'roadmap.md'), /^\| ▶ \| pm-2 \| topic \| Next \| pm-1 \|/m);
  const ix = R(d, 'archive/index.md');
  assert.match(ix, /^\| pm-1 \| Archive bulk delete \| 2026-10-01 \| r-pm-1 \| 3 \| 3 \| 3 \|$/m);
  assert.match(ix, /^\| s-1 \| Old one \| .*\| 2 \| 3 \| 2 \|$/m);
  assert.equal(parseIndex(ix).length, 2);
  assert.equal(readSpecAt(join(d, 'docs', 'product', 'archive', 'pm-1.md')).h.actual.lines, 3);
  assert.match(pr(d, 'item', 'B-2').out, /^B-2 remark new:/, 'luka wraca do triażu');
  assert.match(pr(d, 'sprint', 'pm-1').out, /pm-1 · closed/);
  assert.match(pr(d, 'brief').out, /calibration: n=1: files in range 1\/1/);
});

test("sync fills lines of archived sprints by the archive row's run id", () => {
  const d = productRepo(repo);
  fakeRun(d, 'r-s1', { files: ['src/x.ts', 'src/y.ts'], cost: 3, spec: 's-1' });
  write(d, 'docs/product/archive/index.md', [
    '# dwmt/archive-index@2 — closed sprints', '', '| id | goal | merged | run | files | tokensM |', '|---|---|---|---|---|---|',
    '| s-0 | Imported | - | - | 155 | 34 |', '| s-1 | Old one | 2026-10-01 | r-s1 | 2 | 3 |', '| s-2 | Gone | 2026-10-01 | r-gone | 4 | 1 |',
    '| s-9 | Dropped (dropped) | dropped | - | - | - |', '',
  ].join('\n'));
  write(d, 'docs/product/archive/s-1.md', '---\nid: "s-1"\nactual: {"files":2,"tokens":3,"uat":"n/a","merged":"2026-10-01"}\n---\n\n# s-1\n');
  const s1 = pr(d, 'sync');
  assert.equal(s1.code, 0, s1.out);
  assert.ok(s1.json.changes.includes('s-1 lines 2'), s1.out);
  const ix = R(d, 'archive/index.md');
  assert.match(ix, /^\| s-1 \| Old one \| 2026-10-01 \| r-s1 \| 2 \| 3 \| 2 \|$/m);
  for (const id of ['s-0', 's-2', 's-9']) assert.match(ix, new RegExp(`^\\| ${id} \\|.*\\| - \\|$`, 'm'));
  assert.equal(parseIndex(ix).length, 4);
  assert.deepEqual(readSpecAt(join(d, 'docs', 'product', 'archive', 's-1.md')).h.actual, { files: 2, tokens: 3, uat: 'n/a', merged: '2026-10-01', lines: 2 });
  assert.deepEqual(pr(d, 'sync').json.changes, []);
});

test('sync merges lines into an existing actual of a sprint awaiting UAT, keeping its keys', () => {
  const d = productRepo(repo);
  pr(d, 'roadmap', 'add', 'pm-1', '--goal', 'Pending UAT sprint');
  const file = join(d, 'docs', 'product', 'sprints', 'pm-1.md');
  write(d, 'docs/product/sprints/pm-1.md', '---\nid: "pm-1"\nactual: {"files":5,"tokens":7,"uat":"pending","merged":"2026-09-30"}\n---\n\n# pm-1\n');
  // A fresh row is `topic`, which sync skips; `notes` needs only the sprint file (`ordered` would need `ready` first).
  assert.equal(pr(d, 'roadmap', 'set', 'pm-1', 'state', 'notes').code, 0);
  fakeRun(d, 'r-pm-1', { spec: 'pm-1', uat: 'pending' });
  const s1 = pr(d, 'sync');
  assert.equal(s1.code, 0, s1.out);
  // The hand-written values differ from the run's (files 1, tokens 2, merged 2026-10-01): a rewrite from the run would show.
  assert.deepEqual(readSpecAt(file).h.actual, { files: 5, tokens: 7, uat: 'pending', merged: '2026-09-30', lines: 1 });
  assert.ok(!existsSync(join(d, 'docs', 'product', 'archive', 'pm-1.md')), 'still awaiting UAT');
  const bytes = readFileSync(file);
  const s2 = pr(d, 'sync');
  assert.equal(s2.code, 0, s2.out);
  assert.ok(readFileSync(file).equals(bytes), 'second sync leaves the header byte-identical');
});

test('sync: przebieg init --item zamyka pozycje po squashu', () => {
  const d = productRepo(repo);
  pr(d, 'item', 'add', '--type', 'bug', '--title', 'Typo', '--triage', 'now');
  fakeRun(d, 'r-inline', { mode: 'inline', items: ['B-1'] });
  const s = pr(d, 'sync');
  assert.match(s.json.changes.join(';'), /B-1 done \(r-inline\)/);
  assert.match(pr(d, 'item', 'B-1').out, /done.*\(archived\)/);
});

test('propose → triage-auto → src expert:, reguły T1–T4, triage cofnięcie', () => {
  const d = productRepo(repo);
  write(d, 'src/a.ts', 'x\n');
  const f = join(d, '..', `prop-${Date.now()}.jsonl`);
  writeFileSync(f, `${JSON.stringify({ type: 'debt', title: 'Split the wizard store', anchors: ['src/a.ts'] })}\n`);
  assert.equal(pr(d, 'propose', '--by', 'ux', '--file', f).json.proposed, 1);
  assert.match(pr(d, 'brief').out, /\+1 expert proposals/);
  const rows = [
    { type: 'bug', title: 'Crash on save', sev: 'major', src: 'uat:pm-1/U-1' },
    { type: 'bug', title: 'Wrong label', sev: 'minor', src: 'uat:pm-1/U-2' },
    { type: 'bug', title: 'Tooltip cut', sev: 'minor', anchors: ['src/a.ts'], src: 'uat:pm-2/U-1' },
    { type: 'change', title: 'Sort by date', src: 'uat:pm-2/U-2' },
  ];
  const rf = join(d, '..', `rows-${Date.now()}.jsonl`);
  writeFileSync(rf, rows.map((r) => JSON.stringify(r)).join('\n'));
  pr(d, 'item', 'add', '--file', rf);
  const t = pr(d, 'triage-auto').out;
  assert.match(t, /B-1 → now \(T1\)/);
  assert.match(t, /B-2 → sprint:pm-1-fix \(T2\)/);
  assert.match(t, /B-3 → touch \(T4\)/);
  assert.match(t, /ask: B-4 change/);
  assert.match(t, /B-5 → touch \(T3\)/);
  const b6 = items(d).find((x) => x.id === 'B-5');
  assert.match(b6.src, /^expert:ux:\d{4}-\d\d-\d\d$/);
  assert.equal(readFileSync(join(d, '.dwmt', 'product', 'proposals.jsonl'), 'utf8'), '');
  assert.equal(pr(d, 'triage', 'B-3', 'later').code, 0);
  assert.equal(items(d).find((x) => x.id === 'B-3').triage, 'later');
});

test('intake <run>: odłożone uwagi → remark z kotwicą, odpowiedzi i D-n [visible] → kandydaci, second; idempotentny', () => {
  const d = productRepo(repo);
  const { dir } = fakeRun(d, 'r1', { spec: 'pm-1' });
  write(d, '.dwmt/runs/r1/tasks/1/report.md', '---\nschema: "dwmt/task-report@1"\n---\n# T-1 x\n\n## Decisions\n- D-1 [visible] Empty state shows a hint\n- D-2 internal\n\n## Deferred findings\n- F-2 Duplicate query in loader — cosmetic (src/data/loader.ts:40)\n');
  writeFileSync(join(dir, 'answers.md'), '### Q-1 Who sees drafts?\nOnly the owner.\n\n### Q-2 Export format\nXLSX only.\n');
  writeFileSync(join(dir, 'plan.md'), '---\nschema: "dwmt/plan@1"\nsecond: "size: the import part goes to a second sprint"\n---\n');
  const r = pr(d, 'intake', 'r1');
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.json.items, ['B-1 remark new: Duplicate query in loader']);
  const b1 = items(d)[0];
  assert.deepEqual(b1.anchors, ['src/data/loader.ts']);
  assert.equal(b1.src, 'review:r1/T-1/F-2');
  assert.equal(r.json.candidates.length, 4);
  const inbox = pr(d, 'inbox').out;
  assert.match(inbox, /C-1 decision \(visible:r1\/T-1\/D-1\)/);
  assert.match(inbox, /decision \(answers:r1\/Q-1\): Who sees drafts\?: Only the owner\./);
  assert.match(inbox, /second \(second:r1\): the import part/);
  assert.equal(pr(d, 'intake', 'r1').json.items.length, 0, 'idempotentny po src');
  // Kandydat → decyzja (--from usuwa go z inbox).
  pr(d, 'decision', 'add', '--from', 'C-2', '--title', 'Drafts owner only', '--decision', 'Only the owner sees drafts');
  assert.doesNotMatch(pr(d, 'inbox').out, /C-2 /);
});

test('intake <run> from the final report section (C-1): task and batch findings → remark with sev, title without tags, src, from; idempotent (R-1)', () => {
  const d = productRepo(repo);
  const { dir } = fakeRun(d, 'r1', { spec: 'pm-1' });
  writeFileSync(join(dir, 'final-report.md'), '---\nschema: "dwmt/final-report@1"\nrun: "r1"\n---\n# Final report: r1\n- Deferred findings: 2, of which 1 major.\n  - T-1/F-2 [major] Cleanup removes the parent dir\n- Run: r1\n\n## Deferred findings\n- T-1/F-2 [major] [floor: data-loss] Cleanup removes the parent dir — outside the brief (src/fs/clean.ts)\n- batch/F-1 [minor] Header spacing differs — cosmetic\n\n## Reviews\n- T-1: passed\n');
  // A task report bullet that is also in the section: the section wins, no second item.
  write(d, '.dwmt/runs/r1/tasks/1/report.md', '---\nschema: "dwmt/task-report@1"\n---\n# T-1 x\n\n## Deferred findings\n- F-2 [major] Cleanup removes the parent dir — outside the brief (src/fs/clean.ts)\n');
  const r = pr(d, 'intake', 'r1');
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.json.items, ['B-1 remark major new: Cleanup removes the parent dir', 'B-2 remark minor new: Header spacing differs']);
  const [b1, b2] = items(d);
  assert.equal(b1.src, 'review:r1/T-1/F-2');
  assert.equal(b2.src, 'review:r1/batch/F-1');
  assert.equal(b1.from, 'pm-1');
  assert.equal(b2.from, 'pm-1');
  assert.deepEqual(b1.anchors, ['src/fs/clean.ts']);
  assert.match(b1.note, /^floor: data-loss; outside the brief/);
  assert.equal(b2.note, 'cosmetic');
  assert.match(pr(d, 'item', 'B-1').out, /src: review:r1\/T-1\/F-2; from: pm-1;/);
  assert.equal(pr(d, 'intake', 'r1').json.items.length, 0, 'idempotent by src');
  assert.equal(items(d).length, 2);
  // An item added by hand has no source sprint.
  pr(d, 'item', 'add', '--type', 'idea', '--title', 'Dark mode');
  assert.match(pr(d, 'item', 'B-3').out, /; from: -;/);
  // Batch T-3/F-2: every field of the `src` line keeps `key: value`.
  assert.match(pr(d, 'item', 'B-1').out, /; from: pm-1; at: \d{4}-\d{2}-\d{2}; sprint: -;/);
});

test('intake <run> from the final report section (C-1): a bullet without — <why> keeps the (<where>) out of the title; an empty title falls back to the finding id (batch T-3/F-1)', () => {
  const d = productRepo(repo);
  const { dir } = fakeRun(d, 'r1', { spec: 'pm-1' });
  writeFileSync(join(dir, 'final-report.md'), '---\nschema: "dwmt/final-report@1"\nrun: "r1"\n---\n# Final report: r1\n- Deferred findings: 4, of which 0 major.\n- Run: r1\n\n## Deferred findings\n'
    + '- T-1/F-2 [minor] Leaks a file handle (src/io.ts:40)\n- T-1/F-3 [minor] — cosmetic\n- T-1/F-4 [minor]\n- T-1/F-5 [minor] Retry count (per request)\n\n## Reviews\n- T-1: passed\n');
  const r = pr(d, 'intake', 'r1');
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.json.warnings ?? [], []);
  assert.deepEqual(r.json.items, ['B-1 remark minor new: Leaks a file handle', 'B-2 remark minor new: Deferred finding T-1/F-3',
    'B-3 remark minor new: Deferred finding T-1/F-4', 'B-4 remark minor new: Retry count (per request)']);
  const [b1, b2, b3, b4] = items(d);
  assert.equal(b1.note, 'src/io.ts:40');
  assert.deepEqual(b1.anchors, ['src/io.ts']);
  assert.equal(b2.note, 'cosmetic');
  assert.equal(b3.note, null);
  assert.equal(b4.note, null, 'a parenthesis without a path stays in the title');
});

test('intake <run>: a finding fixed by the user (finish --fixed-deferred) does not reach the backlog from the task report (batch T-2/F-2)', () => {
  const d = productRepo(repo);
  const taskReport = '---\nschema: "dwmt/task-report@1"\n---\n# T-1 x\n\n## Deferred findings\n- F-1 [major] Cleanup removes the parent dir — outside the brief (src/fs/clean.ts)\n- F-2 [minor] Header spacing differs — cosmetic\n';
  // run.json carries deferredFixed; the final report has no Deferred findings section (count 0 after the fix).
  fakeRun(d, 'r1', { spec: 'pm-1', extra: { deferredFixed: { ids: ['T-1/F-1'], at: '2026-10-01T10:00:00Z', head: 'abc' } } });
  write(d, '.dwmt/runs/r1/tasks/1/report.md', taskReport);
  const r = pr(d, 'intake', 'r1');
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.json.items, ['B-1 remark minor new: Header spacing differs']);
  // Only the final report header names the fixed finding (fixedDeferred), run.json without deferredFixed.
  const { dir: dir2 } = fakeRun(d, 'r2', { spec: 'pm-2' });
  writeFileSync(join(dir2, 'final-report.md'), '---\nschema: "dwmt/final-report@1"\nrun: "r2"\nfixedDeferred: ["T-1/F-1"]\n---\n# Final report: r2\n- Deferred findings: 0, of which 0 major.\n- Run: r2\n');
  write(d, '.dwmt/runs/r2/tasks/1/report.md', taskReport);
  const r2 = pr(d, 'intake', 'r2');
  assert.equal(r2.code, 0, r2.out);
  assert.deepEqual(r2.json.items, ['B-2 remark minor new: Header spacing differs']);
  assert.ok(!items(d).some((x) => /parent dir/.test(x.title)), 'a fixed finding is not a backlog item');
});

test('intake <run> without the section: a [sev] tag of a task report bullet becomes sev and leaves the title (R-2)', () => {
  const d = productRepo(repo);
  fakeRun(d, 'r1', { sprint: 'pm-2' });
  write(d, '.dwmt/runs/r1/tasks/1/report.md', '---\nschema: "dwmt/task-report@1"\n---\n# T-1 x\n\n## Deferred findings\n- F-3 [minor] Duplicate query — cosmetic\n- F-4 [major] [floor: security] Token in log — leaks (src/log.ts)\n');
  const r = pr(d, 'intake', 'r1');
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.json.items, ['B-1 remark minor new: Duplicate query', 'B-2 remark major new: Token in log']);
  const [b1, b2] = items(d);
  assert.equal(b1.sev, 'minor');
  assert.equal(b1.from, 'pm-2');
  assert.equal(b1.src, 'review:r1/T-1/F-3');
  assert.match(b2.note, /^floor: security; leaks/);
});

test('backlog key from: a line without it loads, item set keeps every field and adds from: null; itemErrors checks from (R-3)', () => {
  const d = productRepo(repo);
  const old = { id: 'B-1', alias: 'dq', type: 'remark', title: 'Duplicate query', note: 'cosmetic', sev: 'minor', state: 'open', triage: 'later', anchors: ['src/a.ts'], src: 'review:r0/T-1/F-1', at: '2026-10-01', sprint: null, est: null, detail: false };
  write(d, 'docs/product/backlog.jsonl', `${JSON.stringify(old)}\n`);
  assert.match(pr(d, 'item', 'B-1').out, /B-1 remark minor open later \(dq\): Duplicate query/);
  const r = pr(d, 'item', 'set', 'B-1', 'note', 'still cosmetic');
  assert.equal(r.code, 0, r.out);
  const b1 = items(d)[0];
  assert.deepEqual(b1, { ...old, note: 'still cosmetic', from: null });
  assert.deepEqual(Object.keys(b1), ITEM_KEYS);
  const base = normItem({ id: 'B-9', type: 'remark', title: 'x', state: 'new' });
  assert.deepEqual(itemErrors(base), []);
  assert.deepEqual(itemErrors({ ...base, from: 'pm-1' }), []);
  assert.equal(itemErrors({ ...base, from: 'pk 1' }).length, 1);
  assert.equal(itemErrors({ ...base, from: '' }).length, 1);
});

test('productConfig: view.publish defaults to <dir>/roadmap.html, explicit null and path kept (R-4)', () => {
  const top = mkdtempSync(join(tmpdir(), 'dwmt-pc-'));
  const pub = (product) => productConfig(top, product === undefined ? {} : { product }).view.publish;
  assert.equal(pub(undefined), 'docs/product/roadmap.html');
  assert.equal(pub({}), 'docs/product/roadmap.html');
  assert.equal(pub({ dir: './docs/prod/' }), 'docs/prod/roadmap.html');
  assert.equal(pub({ dir: 'docs\\prod' }), 'docs/prod/roadmap.html');
  assert.equal(pub({ view: { publish: null } }), null);
  assert.equal(pub({ view: { publish: 'site/page.html' } }), 'site/page.html');
  assert.equal(pub({ view: { enabled: false } }), 'docs/product/roadmap.html');
  assert.doesNotThrow(() => pub({ view: null }));
});

test('intake --uat: defekty → bug z wagą i kotwicami zakresu, zmiana wymagań → change, środowisko pominięte', () => {
  const d = productRepo(repo);
  const { dir } = fakeRun(d, 'r1', { spec: 'pm-1', files: ['src/ui/a.tsx'], scope: ['src/ui/**'] });
  writeFileSync(join(dir, 'uat.md'), '---\nschema: "dwmt/uat@1"\nsprint: "pm-1"\nentries: [{"n":1,"kind":"uat","result":"defects"}]\ndefects: [{"id":"U-1","weight":"major","kind":"bug","class":"plan"},{"id":"U-2","weight":"minor","kind":"requirement","class":null},{"id":"U-3","weight":"minor","kind":"environment","class":null}]\n---\n# UAT\n\n### U-1 [major] bug, plan: Save button does nothing\n- Place: editor\n\n### U-2 [minor] requirement: Sort by date\n- Place: list\n\n### U-3 [minor] environment: Docker down\n- Place: -\n');
  const r = pr(d, 'intake', '--uat', 'pm-1');
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.json.items, ['B-1 bug major new: Save button does nothing', 'B-2 change new: Sort by date']);
  const b1 = items(d)[0];
  assert.deepEqual(b1.anchors, ['src/ui/**']);
  assert.equal(b1.src, 'uat:pm-1/U-1');
  // Budujący B (N-4): defekt major tworzy od razu sprint poprawek `pm-1-fix` (cel T1/T2), więc pozycja jest już w nim.
  assert.equal(r.json.fixSprint, 'pm-1-fix');
  assert.deepEqual([b1.state, b1.sprint, b1.triage], ['planned', 'pm-1-fix', 'sprint:pm-1-fix']);
  assert.doesNotMatch(pr(d, 'triage-auto').out, /B-1/);
});

test('roadmap add --second: linia zaraz za pierwszym, after [pierwszy], plik ready z refs planu', () => {
  const d = productRepo(repo);
  pr(d, 'roadmap', 'add', 'pm-1', '--goal', 'First');
  pr(d, 'roadmap', 'add', 'pm-3', '--goal', 'Third');
  pr(d, 'spec', 'new', 'pm-1');
  const { dir } = fakeRun(d, 'r1', { spec: 'pm-1', status: null });
  writeFileSync(join(dir, 'plan.md'), '---\nsecond: "size: import of supplier lists"\n---\n');
  pr(d, 'intake', 'r1');
  const r = pr(d, 'roadmap', 'add', '--second', 'r1');
  assert.equal(r.code, 0, r.out);
  assert.equal(r.json.position, 2);
  const lines = R(d, 'roadmap.md').split('\n').filter((l) => /^\|[^|]*\| pm-/.test(l));
  assert.match(lines[1], /^\| \| pm-1-2 \| ready \| import of supplier lists \| pm-1 \| sprints\/pm-1-2.md \| \|$/);
  assert.match(lines[2], /pm-3/);
  assert.match(R(d, 'sprints/pm-1-2.md'), /"refs": \[".dwmt\/runs\/r1\/plan.md"\]|refs: \[".dwmt\/runs\/r1\/plan.md"\]/);
  assert.doesNotMatch(pr(d, 'inbox').out, /second \(/);
});

test('spec bugfix: przed pierwszym sprintem nie w toku, ready, pozycje planned', () => {
  const d = productRepo(repo);
  pr(d, 'item', 'add', '--type', 'bug', '--title', 'Crash on save', '--sev', 'major', '--triage', 'now');
  pr(d, 'roadmap', 'add', 'pm-1', '--goal', 'Running one');
  pr(d, 'roadmap', 'add', 'pm-2', '--goal', 'Next one');
  pr(d, 'spec', 'new', 'pm-1');
  pr(d, 'roadmap', 'set', 'pm-1', 'state', 'running');
  const r = pr(d, 'spec', 'bugfix', 'B-1');
  assert.equal(r.code, 0, r.out);
  const ids = parseRoadmap(R(d, 'roadmap.md')).map((l) => l.id);
  assert.deepEqual(ids, ['pm-1', 'fix-b-1', 'pm-2']);
  assert.match(R(d, 'sprints/fix-b-1.md'), /AC-1 Each listed item is resolved/); // K5 D-19
  assert.equal(items(d)[0].state, 'planned');
});

test('touch <id>: pozycje touch z kotwicami w obszarze trafiają do touch pliku sprintu', () => {
  const d = productRepo(repo);
  write(d, 'src/ui/a.tsx', 'x\n');
  write(d, 'src/api/b.ts', 'x\n');
  gitIn(d)('add', '-A');
  gitIn(d)('commit', '-q', '-m', 'code');
  pr(d, 'item', 'add', '--type', 'remark', '--title', 'UI remark', '--anchors', 'src/ui/a.tsx', '--triage', 'touch');
  pr(d, 'item', 'add', '--type', 'remark', '--title', 'API remark', '--anchors', 'src/api', '--triage', 'touch');
  pr(d, 'roadmap', 'add', 'pm-1', '--goal', 'UI work');
  pr(d, 'spec', 'new', 'pm-1');
  const t = pr(d, 'touch', 'pm-1', '--globs', 'src/ui/**');
  assert.deepEqual(t.json.added, ['B-1 remark planned touch: UI remark']);
  assert.match(R(d, 'sprints/pm-1.md'), /^touch: \["B-1"\]$/m);
});

test('commit: tylko katalog produktu, opis z dziennika zmian', () => {
  const d = productRepo(repo);
  write(d, 'other.txt', 'user change\n');
  gitIn(d)('add', 'other.txt');
  pr(d, 'item', 'add', '--type', 'idea', '--title', 'Dark mode', '--triage', 'later');
  pr(d, 'decision', 'add', '--title', 'No dark mode yet', '--decision', 'Later');
  const c = pr(d, 'commit');
  assert.equal(c.json.committed, true, c.out);
  assert.match(gitIn(d)('log', '-1', '--format=%B'), /B-1 added; PD-1 added \(po\)/);
  assert.equal(gitIn(d)('show', '--name-only', '--format=', 'HEAD').split('\n').every((f) => f.startsWith('docs/product/')), true);
  assert.match(gitIn(d)('status', '--porcelain'), /^A {2}other.txt$/m);
  assert.equal(pr(d, 'commit').json.committed, false);
});

test('commit with product.view.enabled false and the default page: committed, the page not in the commit (R-5)', () => {
  const d = repo();
  config(d, { git: { target: 'master' }, product: { view: { enabled: false } } });
  assert.equal(pr(d, 'init', '--goal', 'Pilot: build cost').code, 0);
  gitIn(d)('add', '-A'); gitIn(d)('commit', '-q', '-m', 'product init');
  pr(d, 'item', 'add', '--type', 'idea', '--title', 'Dark mode', '--triage', 'later');
  const c = pr(d, 'commit');
  assert.equal(c.code, 0, c.out);
  assert.equal(c.json.committed, true, c.out);
  assert.equal(c.json.published, undefined);
  const files = gitIn(d)('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean);
  assert.ok(files.includes('docs/product/backlog.jsonl'), files.join(','));
  assert.ok(!files.includes('docs/product/roadmap.html'), files.join(','));
  assert.equal(existsSync(join(d, 'docs', 'product', 'roadmap.html')), false);
});

test('brief --for: tylko decyzje dziedziny i zmiany od ostatniego briefu tych drzwi', () => {
  const d = productRepo(repo);
  pr(d, 'decision', 'add', '--by', 'ux', '--confirmed', 'tak', '--title', 'Two steps', '--area', 'ux', '--decision', 'Two steps');
  pr(d, 'decision', 'add', '--title', 'Export rule', '--area', 'export', '--decision', 'x');
  const b = pr(d, 'brief', '--for', 'ux').out;
  assert.match(b, /- PD-1 Two steps \(ux\)/);
  assert.doesNotMatch(b, /PD-2 Export rule \(/);
  assert.match(b, /PD-2 added \(po\)/);
  assert.match(pr(d, 'brief', '--for', 'ux').out, /changes: none/);
  assert.ok(b.split('\n').length <= 15);
  const full = pr(d, 'brief').out;
  assert.ok(full.split('\n').length <= 25);
  // N-5 (S3): supervisor zbudowany (scripts/supervise.mjs), więc on; bez zlecenia bez linii zlecenia.
  assert.match(full, /^supervisor: on$/m);
});

test('spec set: zmiana zakresu oznacza szacunek jako stale', () => {
  const d = productRepo(repo);
  pr(d, 'item', 'add', '--type', 'feature', '--title', 'A');
  pr(d, 'roadmap', 'add', 'pm-1', '--goal', 'G');
  pr(d, 'spec', 'new', 'pm-1', '--items', 'B-1');
  write(d, '.dwmt/product/estimate-E-1/result.md', '---\nentries:\n  - {for: [pm-1], areas: ["src/**"], files: [1, 2], flags: {}}\n---\n');
  pr(d, 'estimate-record', 'E-1');
  assert.equal(JSON.parse(R(d, 'estimates.jsonl')).stale, false);
  pr(d, 'spec', 'set', 'pm-1', '--section', 'Acceptance', '--text', '- AC-1 new');
  assert.equal(JSON.parse(R(d, 'estimates.jsonl')).stale, true);
  assert.match(pr(d, 'ready-check', 'pm-1').json.errors.join(), /stale/);
  assert.ok(readdirSync(join(d, 'docs', 'product')).includes('estimates.jsonl'));
});

test('roadmapa i indeks archiwum: tabele @2, odczyt formatu @1, indeks @1 przechodzi na tabelę przy dopisaniu', () => {
  const old = '# dwmt/roadmap@1 — line order = work order; * = current\n* pm-1 · notes · Export · after: [] · detail: sprints/pm-1.md\npk-2 · topic · Import · after: [pm-1] · detail: none · alias: R2\n';
  const lines = parseRoadmap(old);
  assert.deepEqual(lines.map((l) => [l.id, l.current, l.after, l.alias]), [['pm-1', true, [], null], ['pm-2', false, ['pm-1'], 'R2']]);
  const t = renderRoadmap(lines);
  assert.match(t, /^# dwmt\/roadmap@2 .*\n\n\| \| id \| state \| goal \| after \| detail \| alias \|\n\|---\|/);
  assert.match(t, /^\| ▶ \| pm-1 \| notes \| Export \| \| sprints\/pm-1.md \| \|$/m);
  assert.deepEqual(parseRoadmap(t), lines);
  const d = mkdtempSync(join(tmpdir(), 'dwmt-idx-'));
  const P = { archiveIndex: join(d, 'index.md') };
  writeFileSync(P.archiveIndex, '# dwmt/archive-index@1 — id · goal · merged · run · files · tokensM\ns-0 · Setup · - · - · - · -\n');
  appendIndex(P, [{ id: 's-1', goal: 'A|B', merged: '2026-10-04', run: 'r1', files: 4, tokensM: 2.5 }]);
  const ix = readFileSync(P.archiveIndex, 'utf8');
  assert.match(ix, /^# dwmt\/archive-index@2/);
  assert.match(ix, /^\| s-0 \| Setup \| - \| - \| - \| - \| - \|$/m);
  assert.match(ix, /^\| s-1 \| A\/B \| 2026-10-04 \| r1 \| 4 \| 2.5 \| - \|$/m);
  assert.deepEqual(parseIndex(ix).map((x) => [x.id, x.run, x.files]), [['s-0', null, null], ['s-1', 'r1', 4]]);
  // Lines: a 6-cell @2 row reads as unknown, a 7-cell row as a number; appended lines render as the 7th cell.
  const six = '# dwmt/archive-index@2 — closed sprints\n\n| id | goal | merged | run | files | tokensM |\n|---|---|---|---|---|---|\n| s-2 | Old | 2026-10-02 | r2 | 3 | 1 |\n| s-3 | New | 2026-10-03 | r3 | 2 | 1 | 40 |\n';
  assert.deepEqual(parseIndex(six).map((x) => [x.id, x.lines]), [['s-2', null], ['s-3', 40]]);
  appendIndex(P, [{ id: 's-4', goal: 'Lines', merged: '2026-10-05', run: 'r4', files: 2, tokensM: 1, lines: 120 }]);
  assert.match(readFileSync(P.archiveIndex, 'utf8'), /^\| s-4 \| Lines \| 2026-10-05 \| r4 \| 2 \| 1 \| 120 \|$/m);
});
