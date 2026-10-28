import './tmp-root.mjs';
// Product layer: roadmap state `todo` and the decision-maker's `## For you` section (spec warstwy produktowej §3.5, §3.9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { repo, gitIn, cli, runFile } from './helpers.mjs';
import { pr, prEnv, dw, write, config, fakeRun } from './product-helpers.mjs';
import { splitHeader, parseYaml } from '../scripts/lib/headers.mjs';
import {
  parseRoadmap, renderIndex, nextSprint, markCurrent, humanState, parseForYou, stripForYou, checkForYou, renderForYou, forYouCount,
} from '../scripts/lib/product-store.mjs';

const STUB = fileURLToPath(new URL('./fixtures-foryou-claude.mjs', import.meta.url));
const R = (d, f) => readFileSync(join(d, 'docs', 'product', f), 'utf8');
const row = (d, id) => parseRoadmap(R(d, 'roadmap.md')).find((l) => l.id === id);
const hdr = (d, f) => parseYaml(splitHeader(R(d, f)).yaml);
const file = (text) => { const f = join(mkdtempSync(join(tmpdir(), 'fy-')), 'body.md'); writeFileSync(f, text); return f; };
const BODY = (goal = 'Export accepted items.') => `## Goal\n${goal}\n\n## Acceptance\n- AC-1 The client sees accepted items only.\n\n## Out of scope\n- nothing\n`;
const FY = 'Title: Export of accepted items\nWhy: You can send the client a list of what they accepted.\nChanges:\n- A download button on the list\nNot included:\n- PDF export\nCheck:\n- Open the list and press download\n';

function project(cfg = {}) {
  const d = repo();
  config(d, { git: { target: 'master' }, ...cfg, product: { ...(cfg.product ?? {}), view: { publish: null, ...cfg.product?.view } } });
  assert.equal(pr(d, 'init', '--goal', 'Pilot: build cost').code, 0);
  gitIn(d)('add', '-A');
  gitIn(d)('commit', '-q', '-m', 'product');
  return d;
}
const sprint = (d, id, { body = BODY(), todo = true } = {}) => {
  assert.equal(pr(d, 'roadmap', 'add', id, '--goal', `Goal ${id}`).code, 0);
  const r = pr(d, 'spec', 'new', id, '--file', file(body), ...(todo ? ['--todo'] : []));
  assert.equal(r.code, 0, r.out);
};
// Closed sprint in archive/ with its header (`actual.uat`) and index row.
function archived(d, rows) {
  write(d, 'docs/product/archive/index.md', renderIndex(rows.map((x) => ({ id: x.id, goal: x.goal, merged: x.merged ?? '2026-10-01', run: 'r-x', files: 3, tokensM: 1 }))));
  for (const x of rows.filter((y) => y.uat)) write(d, `docs/product/archive/${x.id}.md`, `---\nschema: "dwmt/sprint-spec@1"\nid: "${x.id}"\nkind: "feature"\nactual: {"files":3,"tokens":1,"uat":"${x.uat}"}\n---\n\n${BODY(x.goal)}`);
}

// ---------- state todo ----------

test('todo: roadmap set state todo (from topic with a file, notes, ready), spec new --todo, ready from todo; errors', () => {
  const d = project();
  pr(d, 'roadmap', 'add', 's-1', '--goal', 'Export');
  let r = pr(d, 'roadmap', 'set', 's-1', 'state', 'todo');
  assert.equal(r.code, 1);
  assert.match(r.json.error, /stan todo wymaga pliku sprintu/);
  assert.equal(pr(d, 'spec', 'new', 's-1', '--file', file('## Goal\n\n## Notes\n- x\n')).code, 0);
  assert.equal(row(d, 's-1').state, 'notes');
  r = pr(d, 'roadmap', 'set', 's-1', 'state', 'todo');
  assert.equal(r.code, 1);
  assert.match(r.json.error, /todo needs a sprint file with a non-empty ## Goal/);
  pr(d, 'spec', 'set', 's-1', '--file', file(BODY()));
  r = pr(d, 'roadmap', 'set', 's-1', 'state', 'todo');
  assert.equal(r.code, 0, r.out);
  assert.match(r.json.line, /^(\* )?s-1 · todo · Export/);
  assert.match(R(d, 'roadmap.md'), /^\| ▶ \| s-1 \| todo \| Export \| \| sprints\/s-1\.md \|/m);
  // ready from todo; back to todo removes the approval from the header.
  pr(d, 'spec', 'set', 's-1', 'est', 'start:1,2');
  r = pr(d, 'ready', 's-1', '--direct');
  assert.equal(r.json.ok, true, r.out);
  assert.equal(hdr(d, 'sprints/s-1.md').ready.direct, true);
  r = pr(d, 'roadmap', 'set', 's-1', 'state', 'todo');
  assert.equal(r.code, 0, r.out);
  assert.equal(row(d, 's-1').state, 'todo');
  assert.equal(hdr(d, 'sprints/s-1.md').ready, null);
  // kf2 D-10: an ordered line goes back to todo too (withdrawal from the supervisor order), approval cleared.
  r = pr(d, 'ready', 's-1', '--direct');
  assert.equal(r.json.ok, true, r.out);
  assert.equal(pr(d, 'roadmap', 'set', 's-1', 'state', 'ordered').code, 0);
  assert.equal(row(d, 's-1').state, 'ordered');
  r = pr(d, 'roadmap', 'set', 's-1', 'state', 'todo');
  assert.equal(r.code, 0, r.out);
  assert.equal(row(d, 's-1').state, 'todo');
  assert.equal(hdr(d, 'sprints/s-1.md').ready, null);
  pr(d, 'roadmap', 'set', 's-1', 'state', 'running');
  r = pr(d, 'roadmap', 'set', 's-1', 'state', 'todo');
  assert.equal(r.code, 1);
  assert.match(r.json.error, /todo only from topic \(with a sprint file\), notes, ready or ordered \(is running\)/);
  // spec new --todo: file and state in one step; empty goal → nothing written.
  pr(d, 'roadmap', 'add', 's-2', '--goal', 'Import');
  r = pr(d, 'spec', 'new', 's-2', '--todo');
  assert.equal(r.code, 0, r.out);
  assert.equal(row(d, 's-2').state, 'todo');
  pr(d, 'roadmap', 'add', 's-3', '--goal', 'Later');
  r = pr(d, 'spec', 'new', 's-3', '--todo', '--file', file('## Goal\n\n## Notes\n- x\n'));
  assert.equal(r.code, 1);
  assert.match(r.json.error, /--todo needs a non-empty ## Goal/);
  assert.ok(!existsSync(join(d, 'docs', 'product', 'sprints', 's-3.md')));
  assert.equal(row(d, 's-3').state, 'topic');
  // A topic line with a sprint file left behind goes to todo directly.
  pr(d, 'roadmap', 'add', 's-4', '--goal', 'Search');
  write(d, 'docs/product/sprints/s-4.md', '---\nschema: "dwmt/sprint-spec@1"\nid: "s-4"\n---\n\n## Goal\nSearch by name.\n');
  r = pr(d, 'roadmap', 'set', 's-4', 'state', 'todo');
  assert.equal(r.code, 0, r.out);
  assert.equal(row(d, 's-4').detail, 'sprints/s-4.md');
  r = pr(d, 'roadmap', 'set', 's-2', 'state', 'later');
  assert.match(r.json.error, /dozwolone topic\|notes\|todo\|ready\|ordered\|running\|done/);
});

test('nextSprint: first To do (todo or ready) from the top with after merged; also = other ready; else first topic/notes', () => {
  const L = (id, state, after = []) => ({ id, state, goal: id, after, detail: state === 'topic' ? 'none' : `sprints/${id}.md`, alias: null, current: false });
  const index = [{ id: 'old', goal: 'x', merged: '2026-10-01', run: null, files: null, tokensM: null }];
  let lines = [L('r0', 'running'), L('n1', 'notes'), L('t1', 'todo', ['r0']), L('r1', 'ready', ['old']), L('t2', 'todo'), L('r2', 'ready')];
  let nx = nextSprint(lines, index);
  assert.deepEqual([nx.line.id, nx.also], ['r1', ['r2']]);
  assert.match(nx.why, /^ready, dependencies merged/);
  lines = [L('r0', 'running'), L('n1', 'notes'), L('t1', 'todo', ['r0']), L('t2', 'todo'), L('r1', 'ready', ['old']), L('r2', 'ready')];
  nx = nextSprint(lines, index);
  assert.deepEqual([nx.line.id, nx.also], ['t2', ['r1', 'r2']]);
  assert.match(nx.why, /^to do, dependencies merged/);
  // A merged dependency (`done`) unblocks the earlier todo line.
  lines[0].state = 'done';
  assert.equal(nextSprint(lines, index).line.id, 't1');
  nx = nextSprint([L('r0', 'running'), L('t1', 'todo', ['r0']), L('n1', 'notes'), L('p1', 'topic')], index);
  assert.deepEqual([nx.line.id, nx.also], ['n1', []]);
  assert.match(nx.why, /^notes: no to-do sprint/);
  assert.deepEqual(markCurrent([L('t1', 'todo', ['r0']), L('r0', 'ready'), L('t2', 'todo')], index).filter((l) => l.current).map((l) => l.id), ['r0']);
  assert.equal(nextSprint([L('t1', 'todo', ['r0']), L('r0', 'running')], index), null);
});

test('humanState: draft, to do, in progress, awaiting review (open done and archived with UAT pending)', () => {
  const hs = (state) => humanState({ id: 'x', state });
  assert.deepEqual(['topic', 'notes', 'todo', 'ready', 'ordered', 'running', 'done'].map(hs), ['draft', 'draft', 'todo', 'todo', 'inprogress', 'inprogress', 'review']);
  assert.equal(humanState({ archived: true, uat: 'pending' }), 'review');
  assert.equal(humanState({ archived: true, h: { actual: { uat: 'pending' } } }), 'review');
  assert.equal(humanState({ archived: true, uat: 'pass' }), null);
  assert.equal(humanState(null), null);
});

test('sync: a started run takes a todo line to running; a stopped run without readiness returns it to todo', () => {
  const d = project();
  sprint(d, 's-1');
  const { dir } = fakeRun(d, 'r-1', { spec: 's-1', status: null });
  assert.equal(pr(d, 'sync').code, 0);
  assert.equal(row(d, 's-1').state, 'running');
  const rj = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ ...rj, stopped: { reason: 'price', at: '2026-10-04T10:00:00Z' } }));
  assert.equal(pr(d, 'sync').code, 0);
  assert.equal(row(d, 's-1').state, 'todo');
  assert.equal(pr(d, 'sync').code, 0);
  assert.equal(row(d, 's-1').state, 'todo', 'stays');
});

test('roadmap todo-from-notes: notes with goal and acceptance → todo; --dry-run changes nothing; brief offers it, then counts to do', () => {
  const d = project();
  sprint(d, 's-1', { todo: false });
  sprint(d, 's-2', { todo: false, body: '## Goal\nImport.\n\n## Acceptance\n-\n' });
  pr(d, 'roadmap', 'add', 's-3', '--goal', 'Topic only');
  assert.match(pr(d, 'brief').out, /notes 2 \(1 with acceptance → product roadmap todo-from-notes\), topics 1/);
  let r = pr(d, 'roadmap', 'todo-from-notes', '--dry-run');
  assert.deepEqual([r.json.todo, r.json.dryRun], [['s-1'], true]);
  assert.equal(row(d, 's-1').state, 'notes');
  r = pr(d, 'roadmap', 'todo-from-notes');
  assert.deepEqual([r.json.todo, r.json.left], [['s-1'], ['s-2']]);
  assert.deepEqual(['s-1', 's-2', 's-3'].map((id) => row(d, id).state), ['todo', 'notes', 'topic']);
  const b = pr(d, 'brief').out;
  assert.match(b, /^sprints: ready -; to do 1; ordered -; running -; waiting for UAT -; notes 1, topics 1$/m);
  assert.match(b, /^next: s-1 · todo · Goal s-1$/m);
  assert.match(pr(d, 'roadmap', 'next').out, /why: to do, dependencies merged/);
});

// ---------- ## For you ----------

test('For you: parse, strip, check (format, budget, identifiers), render round trip', () => {
  const body = `## Goal\nExport.\n\n## For you\n${FY}\n## Acceptance\n- AC-1 x\n`;
  const f = parseForYou(body);
  assert.deepEqual(f, { title: 'Export of accepted items', why: 'You can send the client a list of what they accepted.', changes: ['A download button on the list'], notIncluded: ['PDF export'], check: ['Open the list and press download'] });
  const s = stripForYou(body);
  assert.doesNotMatch(s, /For you|Title:|download/);
  assert.match(s, /^## Goal\nExport\.\n\n## Acceptance\n- AC-1 x\n$/);
  assert.equal(stripForYou('## Goal\nx\n'), '## Goal\nx\n');
  assert.equal(parseForYou('## Goal\nx\n'), null);
  assert.equal(parseForYou('## For you\nTitle: x\n'), null, 'Why required');
  const c = parseForYou('## For you\ntitle: A\nWhy: one\ntwo\nChanges:\n- a\n  more\n## Next\n- y\n');
  assert.deepEqual([c.title, c.why, c.changes, c.check], ['A', 'one two', ['a more'], []]);
  assert.deepEqual(parseForYou(`## For you\n${renderForYou(f)}\n`), f);
  assert.equal(renderForYou({ title: 'T', why: 'W', changes: [], check: ['c'] }), 'Title: T\nWhy: W\nCheck:\n- c');
  const errs = (t) => checkForYou(`## For you\n${t}\n`).errors;
  assert.deepEqual(errs(FY), []);
  assert.match(errs('Why: w').join(), /missing "Title/);
  assert.match(errs('Title: t').join(), /missing "Why/);
  assert.match(errs(`Title: ${'x'.repeat(91)}\nWhy: w`).join(), /Title 91 > 90 characters/);
  assert.match(errs('Hello there\nTitle: t\nWhy: w').join(), /line outside the format.*Hello there/);
  assert.match(errs(`Title: t\nWhy: ${'w'.repeat(2100)}`).join(), /B > 2048 B/);
  assert.deepEqual(checkForYou('## For you\nTitle: Fix B-12\nWhy: see src/app/list.ts\n').warnings.length, 1);
  assert.deepEqual(checkForYou('## Goal\nx\n'), { errors: [], warnings: [] });
});

test('spec set --section "For you": validated on write, outside the file budget; product sprint never shows it', () => {
  const d = project();
  sprint(d, 's-1', { body: `${BODY()}\n## Open questions\n- [architect] where the filter lives\n` });
  let r = pr(d, 'spec', 'set', 's-1', '--section', 'For you', '--file', file('Title: x\n'));
  assert.equal(r.code, 1);
  assert.match(r.json.error, /For you: missing "Why/);
  assert.doesNotMatch(R(d, 'sprints/s-1.md'), /For you/);
  r = pr(d, 'spec', 'set', 's-1', '--section', 'For you', '--file', file(FY));
  assert.equal(r.code, 0, r.out);
  assert.equal(r.json.warning, undefined);
  assert.deepEqual(parseForYou(R(d, 'sprints/s-1.md')).notIncluded, ['PDF export']);
  const t = pr(d, 'sprint', 's-1').out;
  assert.doesNotMatch(t, /For you|Export of accepted items|download button/);
  assert.match(t, /## Acceptance\n- AC-1 The client sees accepted items only\.\n\n## Out of scope/);
  assert.match(t, /\[architect\] where the filter lives/);
  const j = pr(d, 'sprint', 's-1', '--json').json;
  assert.doesNotMatch(j.body, /For you|Title:/);
  assert.match(j.body, /^## Goal\nExport accepted items\./);
  r = pr(d, 'spec', 'set', 's-1', '--section', 'For you', '--file', file('Title: Fix B-12\nWhy: You see accepted items only.\n'));
  assert.equal(r.code, 0, r.out);
  assert.match(r.json.warning, /identifiers or file paths/);
  // Budget: a 5.5 KB file plus a 1.9 KB section is accepted (the section does not count); the size warning ignores it.
  r = pr(d, 'spec', 'set', 's-1', '--section', 'Notes', '--text', 'n'.repeat(5200));
  assert.equal(r.code, 0, r.out);
  assert.match(r.json.warning, /> 3072 B/);
  const big = (n) => `Title: Big\nWhy: ${'w'.repeat(300)}\nChanges:\n${Array.from({ length: n }, (_, i) => `- change ${i} ${'c'.repeat(140)}`).join('\n')}`;
  r = pr(d, 'spec', 'set', 's-1', '--section', 'For you', '--file', file(big(10)));
  assert.equal(r.code, 0, r.out);
  assert.ok(Buffer.byteLength(R(d, 'sprints/s-1.md')) > 6144);
  assert.equal(pr(d, 'ready-check', 's-1', '--direct').json.errors.some((e) => /plik sprintu/.test(e)), false);
  r = pr(d, 'spec', 'set', 's-1', '--section', 'For you', '--file', file(big(13)));
  assert.equal(r.code, 1);
  assert.match(r.json.error, /For you: \d+ B > 2048 B/);
  // An unchanged invalid section (edited by hand) does not block other writes.
  const f = join(d, 'docs', 'product', 'sprints', 's-1.md');
  writeFileSync(f, readFileSync(f, 'utf8').replace(/## For you\n[\s\S]*?(?=\n## |$)/, '## For you\nHello\n'));
  r = pr(d, 'spec', 'set', 's-1', 'kind', 'bugfix');
  assert.equal(r.code, 0, r.out);
});

test('product for-you [--missing]: sprints the user sees without the section, archived with UAT pending; spec set on archive', () => {
  const d = project();
  sprint(d, 's-1');
  sprint(d, 's-2');
  pr(d, 'spec', 'set', 's-2', '--section', 'For you', '--file', file(FY));
  sprint(d, 's-3', { todo: false });
  sprint(d, 's-4');
  pr(d, 'roadmap', 'set', 's-4', 'state', 'running');
  sprint(d, 's-5');
  pr(d, 'roadmap', 'set', 's-5', 'state', 'done');
  archived(d, [{ id: 's-0', goal: 'Old export', uat: 'pending' }, { id: 's-z', goal: 'Checked', uat: 'pass' }, { id: 's-d', goal: 'Dropped', merged: 'dropped' }]);
  const m = pr(d, 'for-you', '--missing').out.split('\n');
  assert.match(m[0], /^for you: 4 of 5 sprints missing \(draft: product for-you --draft, haiku, 1 call\(s\), then product commit\)$/);
  assert.deepEqual(m.slice(1), ['s-1 · todo · Goal s-1', 's-4 · running · Goal s-4', 's-5 · done · Goal s-5', 's-0 · awaiting review (archive) · Old export']);
  const all = pr(d, 'for-you').out;
  assert.match(all, /^s-2 · todo · Goal s-2 · for you: yes$/m);
  assert.match(all, /^s-1 · todo · Goal s-1 · for you: missing$/m);
  assert.doesNotMatch(all, /s-3|s-z|s-d/);
  const r = pr(d, 'spec', 'set', 's-0', '--section', 'For you', '--file', file(FY));
  assert.equal(r.code, 0, r.out);
  assert.equal(r.json.spec, 'docs/product/archive/s-0.md');
  assert.equal(parseForYou(R(d, 'archive/s-0.md')).title, 'Export of accepted items');
  assert.equal(hdr(d, 'archive/s-0.md').actual.uat, 'pending');
  assert.match(pr(d, 'for-you', '--missing').out, /^for you: 3 of 5 sprints missing/);
});

// ---------- drafts by a cheap model ----------

test('for-you --draft: one tool-less call per ≤ 8 sprints, sections written (archive too), nothing committed', () => {
  const d = project({ language: 'pl' });
  const ids = Array.from({ length: 9 }, (_, i) => `s-${i + 1}`);
  for (const id of ids) sprint(d, id, { body: `${BODY()}\n## Decisions\n- PD-1\n\n## Open questions\n- [architect] where the filter lives\n` });
  pr(d, 'spec', 'set', 's-2', '--section', 'For you', '--file', file(FY));
  archived(d, [{ id: 's-0', goal: 'Old export', uat: 'pending' }]);
  gitIn(d)('add', '-A');
  gitIn(d)('commit', '-q', '-m', 'sprints');
  const head = gitIn(d)('rev-parse', 'HEAD');
  const log = join(mkdtempSync(join(tmpdir(), 'fy-')), 'calls.jsonl');
  const r = prEnv(d, { DWMT_CLAUDE: STUB, STUB_LOG: log }, 'for-you', '--draft');
  assert.equal(r.code, 0, r.out);
  assert.equal(r.json.ok, true, r.out);
  assert.deepEqual([...r.json.written].sort(), ['s-0', 's-1', 's-3', 's-4', 's-5', 's-6', 's-7', 's-8', 's-9']);
  assert.deepEqual(r.json.failed, []);
  assert.equal(r.json.costHint, '2 call(s), 0.003 M tokens, $0.004 (haiku)');
  const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(calls.map((c) => (c.prompt.match(/^### /gm) ?? []).length), [8, 1]);
  const a = calls[0].args;
  assert.equal(a[a.indexOf('--tools') + 1], '');
  assert.deepEqual([a[a.indexOf('--model') + 1], a[a.indexOf('--output-format') + 1]], ['haiku', 'json']);
  assert.ok(a.includes('-p') && !a.some((x) => /Plain words/.test(x)), 'prompt on stdin');
  const p = calls[0].prompt;
  assert.match(p, /language with code "pl"/);
  assert.match(p, /no identifiers \(B-n, AC-n, PD-n/);
  assert.match(p, /^### s-1\nRoadmap goal: Goal s-1\nGoal:\nExport accepted items\.\nAcceptance:\n- AC-1 The client/m);
  assert.doesNotMatch(p, /\[architect\]|- PD-1|schema|Export of accepted items/);
  assert.equal(parseForYou(R(d, 'sprints/s-1.md')).title, 'Export the list s-1');
  assert.equal(parseForYou(R(d, 'sprints/s-2.md')).title, 'Export of accepted items', 'existing section kept');
  assert.equal(parseForYou(R(d, 'archive/s-0.md')).title, 'Export the list s-0');
  assert.equal(gitIn(d)('rev-parse', 'HEAD'), head, 'no commit');
  assert.match(gitIn(d)('status', '--porcelain'), /docs\/product\/sprints\/s-1\.md/);
  assert.match(pr(d, 'for-you', '--missing').out, /^for you: 0 of 10 sprints missing$/);
  assert.doesNotMatch(pr(d, 'sprint', 's-1').out, /Export the list/);
});

test('for-you --draft: bad JSON, missing entry, invalid entry, timeout, --ids (unknown, existing section)', () => {
  const d = project();
  for (const id of ['s-1', 's-2', 's-3']) sprint(d, id);
  const before = R(d, 'sprints/s-1.md');
  let r = prEnv(d, { DWMT_CLAUDE: STUB, STUB_MODE: 'bad' }, 'for-you', '--draft');
  assert.equal(r.json.ok, false);
  assert.deepEqual(r.json.written, []);
  assert.deepEqual(r.json.failed.map((x) => x.id), ['s-1', 's-2', 's-3']);
  assert.match(r.json.failed[0].error, /bad answer: no JSON object/);
  assert.equal(R(d, 'sprints/s-1.md'), before);
  r = prEnv(d, { DWMT_CLAUDE: STUB, STUB_MODE: 'partial' }, 'for-you', '--draft');
  assert.deepEqual([r.json.ok, r.json.written, r.json.failed], [true, ['s-2', 's-3'], [{ id: 's-1', error: 'no entry in the answer' }]]);
  r = prEnv(d, { DWMT_CLAUDE: STUB, STUB_MODE: 'noisy' }, 'for-you', '--draft');
  assert.deepEqual(r.json.failed.map((x) => x.id), ['s-1']);
  assert.match(r.json.failed[0].error, /Title 120 > 90/);
  assert.equal(parseForYou(R(d, 'sprints/s-1.md')), null);
  r = prEnv(d, { DWMT_CLAUDE: STUB }, 'for-you', '--draft', '--ids', 's-1,s-2,nope');
  assert.deepEqual([r.json.written, r.json.skipped, r.json.failed], [['s-1'], ['s-2'], [{ id: 'nope', error: 'no sprint in the roadmap or archive' }]]);
  r = prEnv(d, { DWMT_CLAUDE: STUB }, 'for-you', '--draft');
  assert.deepEqual([r.json.ok, r.json.written, r.json.costHint], [true, [], 'no calls']);
  // Timeout (config `product.view.draftTimeoutS`): failure per sprint, nothing written.
  config(d, { git: { target: 'master' }, product: { view: { draftTimeoutS: 1 } } });
  sprint(d, 's-4');
  r = prEnv(d, { DWMT_CLAUDE: STUB, STUB_MODE: 'slow' }, 'for-you', '--draft');
  assert.deepEqual(r.json.failed, [{ id: 's-4', error: 'timeout after 1 s' }]);
  assert.equal(parseForYou(R(d, 'sprints/s-4.md')), null);
});

// ---------- archive with the final UAT state ----------

const uatMd = (id, ...results) => `---\nschema: "dwmt/uat@1"\nsprint: "${id}"\nentries: ${JSON.stringify(results.map((result, i) => ({ n: i + 1, kind: 'uat', result })))}\ndefects: []\n---\n# UAT\n`;
const pageOf = (d) => JSON.parse(/<script type="application\/json" id="dwmt-data">([\s\S]*?)<\/script>/.exec(readFileSync(join(d, '.dwmt', 'product', 'view', 'index.html'), 'utf8'))[1]);

test('sync: a sprint archived after its UAT carries the final UAT state (closed, not awaiting review); for-you --missing skips it', () => {
  const d = project();
  sprint(d, 's-1');
  const { dir } = fakeRun(d, 'r-1', { spec: 's-1', uat: 'pending' });
  assert.equal(pr(d, 'sync').code, 0);
  assert.equal(row(d, 's-1').state, 'done');
  assert.deepEqual([hdr(d, 'sprints/s-1.md').actual.uat, hdr(d, 'sprints/s-1.md').actual.merged], ['pending', '2026-10-01']);
  assert.match(pr(d, 'for-you', '--missing').out, /^s-1 · done · Goal s-1$/m);
  writeFileSync(join(dir, 'uat.md'), uatMd('s-1', 'defects', 'positive'));
  const s = pr(d, 'sync');
  assert.match(s.json.changes.join('; '), /s-1 closed → archive/);
  assert.equal(hdr(d, 'archive/s-1.md').actual.uat, 'positive', 'last recorded UAT');
  assert.equal(hdr(d, 'archive/s-1.md').actual.merged, '2026-10-01');
  assert.match(pr(d, 'for-you', '--missing').out, /^for you: 0 of 0 sprints missing$/);
  const p = pageOf(d).sprints.find((x) => x.id === 's-1');
  assert.deepEqual([p.state, p.human, p.uat], ['closed', null, 'positive']);
  // A run without a UAT scenario (`n/a`) closes at once, with n/a in the header.
  sprint(d, 's-2');
  fakeRun(d, 'r-2', { spec: 's-2', uat: 'n/a' });
  pr(d, 'sync');
  assert.equal(hdr(d, 'archive/s-2.md').actual.uat, 'n/a');
});

test('sync: one-time repair of archived headers still pending while their run recorded the UAT; without the run copy they stay', () => {
  const d = project();
  archived(d, [{ id: 's-0', goal: 'Old export', uat: 'pending' }, { id: 's-9', goal: 'No run left', uat: 'pending' }]);
  const { dir } = fakeRun(d, 'r-s0', { spec: 's-0', uat: 'pending' });
  writeFileSync(join(dir, 'uat.md'), uatMd('s-0', 'defects'));
  const s = pr(d, 'sync');
  assert.equal(s.code, 0, s.out);
  assert.match(s.json.changes.join('; '), /s-0 actual\.uat defects \(archive repair\)/);
  assert.deepEqual([hdr(d, 'archive/s-0.md').actual.uat, hdr(d, 'archive/s-9.md').actual.uat], ['defects', 'pending']);
  assert.match(pr(d, 'for-you', '--missing').out, /^for you: 1 of 1 sprints missing/);
  // One time: a run copy that shows up later does not change the header any more.
  const late = fakeRun(d, 'r-s9', { spec: 's-9', uat: 'pending' });
  writeFileSync(join(late.dir, 'uat.md'), uatMd('s-9', 'positive'));
  assert.deepEqual(pr(d, 'sync').json.changes, []);
  assert.equal(hdr(d, 'archive/s-9.md').actual.uat, 'pending');
});

// ---------- For you: letter case, several sections, numbered lists, CRLF ----------

test('For you: numbered list items; an indented label-like line continues the value', () => {
  const f = parseForYou('## For you\nTitle: Export\nWhy: You get a file.\n  Check: the totals are in it too.\nChanges:\n1. A button\n2) A menu entry\n   Not included: continues the entry\n- A shortcut\nCheck:\n1. Press the button\n');
  assert.deepEqual(f, { title: 'Export', why: 'You get a file. Check: the totals are in it too.', changes: ['A button', 'A menu entry Not included: continues the entry', 'A shortcut'], notIncluded: [], check: ['Press the button'] });
  assert.deepEqual(checkForYou('## For you\nTitle: T\nWhy: W\nCheck:\n1. a\n2. b\n').errors, []);
  assert.deepEqual(parseForYou('## For you\nTitle: T\nWhy: W\nChanges: 1. inline first\n2. second\n').changes, ['inline first', 'second']);
  // Every section in any letter case is stripped; the first one counts.
  const two = '## Goal\nG.\n\n## For You\nTitle: A\nWhy: a\n\n## Notes\n- keep\n\n## for you\nTitle: B\nWhy: b\n';
  assert.equal(stripForYou(two), '## Goal\nG.\n\n## Notes\n- keep\n');
  assert.equal(forYouCount(two), 2);
  assert.equal(parseForYou(two).title, 'A');
});

test('spec set: --file without For you keeps the section, with it replaces it (CRLF, last section); two sections refused; any letter case replaced by one', () => {
  const d = project();
  sprint(d, 's-1');
  pr(d, 'spec', 'set', 's-1', '--section', 'For you', '--file', file(FY));
  let r = pr(d, 'spec', 'set', 's-1', '--file', file(BODY('New goal.')));
  assert.equal(r.code, 0, r.out);
  assert.match(R(d, 'sprints/s-1.md'), /## Goal\nNew goal\./);
  assert.equal(parseForYou(R(d, 'sprints/s-1.md')).title, 'Export of accepted items', 'kept');
  // CRLF body with its own For you as the last section: replaces it.
  r = pr(d, 'spec', 'set', 's-1', '--file', file(`${BODY('CRLF goal.')}\n## For you\nTitle: Line endings\nWhy: Works on any system.\nCheck:\n1. Open it\n`.replace(/\n/g, '\r\n')));
  assert.equal(r.code, 0, r.out);
  const t = R(d, 'sprints/s-1.md');
  assert.doesNotMatch(t, /\r/);
  assert.deepEqual(parseForYou(t), { title: 'Line endings', why: 'Works on any system.', changes: [], notIncluded: [], check: ['Open it'] });
  assert.equal(forYouCount(t), 1);
  assert.doesNotMatch(pr(d, 'sprint', 's-1').out, /Line endings|Works on any system/);
  assert.match(pr(d, 'sprint', 's-1').out, /## Goal\nCRLF goal\./);
  // Two sections in one body: refused, file unchanged.
  r = pr(d, 'spec', 'set', 's-1', '--file', file(`${BODY()}\n## For you\n${FY}\n## For You\nTitle: B\nWhy: b\n`));
  assert.equal(r.code, 1);
  assert.match(r.json.error, /For you: 2 sections, keep one/);
  assert.equal(R(d, 'sprints/s-1.md'), t);
  // Hand-edited headings in other letter cases: --section "for you" leaves one section with the canonical heading.
  const f = join(d, 'docs', 'product', 'sprints', 's-1.md');
  writeFileSync(f, `${readFileSync(f, 'utf8').replace('## For you', '## FOR YOU')}\n## for You\nTitle: Stray\nWhy: stray\n`);
  r = pr(d, 'spec', 'set', 's-1', '--section', 'for you', '--file', file(`## For you\n${FY}`));
  assert.equal(r.code, 0, r.out);
  const u = R(d, 'sprints/s-1.md');
  assert.equal(forYouCount(u), 1);
  assert.match(u, /^## For you$/m);
  assert.doesNotMatch(u, /Stray|Line endings/);
  assert.equal(parseForYou(u).title, 'Export of accepted items');
});

test('For you never reaches agents: a "## For You" heading and a second section stay out of product sprint, init --input task.md and supervise order --file', () => {
  const d = project({ verify: { full: ['node -e 0'] } });
  sprint(d, 's-1');
  pr(d, 'spec', 'set', 's-1', 'est', 'start:1,2');
  assert.equal(pr(d, 'ready', 's-1', '--direct').json.ok, true);
  const f = join(d, 'docs', 'product', 'sprints', 's-1.md');
  writeFileSync(f, `${readFileSync(f, 'utf8')}\n## For You\n${FY}\n## Notes\n- keep\n\n## for you\nTitle: Second\nWhy: Hidden too.\n`);
  const HIDDEN = /## for you|download button|Hidden too|list of what they accepted/i;
  for (const t of [pr(d, 'sprint', 's-1').out, pr(d, 'sprint', 's-1', '--json').json.body]) {
    assert.doesNotMatch(t, HIDDEN);
    assert.match(t, /## Notes\n- keep/);
  }
  gitIn(d)('add', '-A');
  gitIn(d)('commit', '-q', '-m', 'hand edit');
  const run = cli(d, 'preflight', '--slug', 'fy').json.run;
  const i = cli(d, 'init', '--run', run, '--mode', 'inline', '--input', 'docs/product/sprints/s-1.md');
  assert.equal(i.json?.ok, true, i.out);
  const task = readFileSync(runFile(d, run, 'task.md'), 'utf8');
  assert.match(task, /## Acceptance\n- AC-1 The client sees accepted items only\./);
  assert.doesNotMatch(task, HIDDEN);
  gitIn(d)('switch', '-q', 'master');
  const of = join(mkdtempSync(join(tmpdir(), 'fy-')), 'feat-x.md');
  writeFileSync(of, readFileSync(f, 'utf8'));
  const plog = join(mkdtempSync(join(tmpdir(), 'fy-')), 'platform.jsonl');
  const o = dw(d, ['supervise', 'order', '--file', of], { DWMT_SUPERVISE_NOSPAWN: '1', DWMT_PLATFORM_LOG: plog });
  assert.equal(o.json?.ok, true, o.out);
  const input = readFileSync(join(d, '.dwmt', 'supervisor', 'input', 'feat-x.md'), 'utf8');
  assert.match(input, /## Acceptance/);
  assert.doesNotMatch(input, HIDDEN);
});
