import './tmp-root.mjs';
// Product layer: read-only human view (spec warstwy produktowej §3.11): view model, HTML writer, regeneration hooks,
// translation memory with a cheap-model stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync, mkdirSync, utimesSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Script } from 'node:vm';
import { createHash } from 'node:crypto';
import { repo, gitIn, cli, header, runFile } from './helpers.mjs';
import { pr, prEnv, dw, write, config, fakeRun } from './product-helpers.mjs';
import { loadConfig } from '../scripts/lib/config.mjs';
import { productConfig } from '../scripts/lib/product-config.mjs';
import { paths, renderRoadmap, renderIndex } from '../scripts/lib/product-store.mjs';
import { viewModel, noIds, translatable, mockupLinks } from '../scripts/lib/product-view.mjs';
import { openerOf } from '../scripts/lib/platform.mjs';
import { contextHome } from '../scripts/lib/run.mjs';
import { samePath } from '../scripts/lib/util.mjs';
import { mergeKey } from '../scripts/lib/finish.mjs';

const STUB = fileURLToPath(new URL('./fixtures-view-claude.mjs', import.meta.url));
const VIEW = (d) => join(d, '.dwmt', 'product', 'view', 'index.html');
const ctx = (d) => { const cfg = loadConfig(d); const pc = productConfig(d, cfg); return { top: d, cfg, pc, P: paths(d, pc) }; };
const dataOf = (html) => JSON.parse(/<script type="application\/json" id="dwmt-data">([\s\S]*?)<\/script>/.exec(html)[1]);
const logLines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

const spec = (id, h, body) => `---\n${Object.entries({ schema: 'dwmt/sprint-spec@1', id, kind: 'feature', items: [], touch: [], refs: [], ...h }).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n\n${body}`;
const L = (id, state, goal, after = []) => ({ id, state, goal, after, detail: state === 'topic' ? 'none' : `sprints/${id}.md`, alias: null, current: false });

// Tiny product: roadmap in every state, a For you section, archive with est/actual, an item on a closed sprint, decisions in two areas.
function project(cfg = {}, { goal = 'Client export works' } = {}) {
  const d = repo();
  // These tests assert the page under .dwmt/ (publish off); the default page in the product dir has its own tests.
  config(d, { git: { target: 'master' }, ...cfg, product: { ...cfg.product, view: { publish: null, ...cfg.product?.view } } });
  assert.equal(pr(d, 'init').code, 0);
  const W = (f, t) => write(d, `docs/product/${f}`, t);
  W('vision.md', '# Vision (stage 1: goal only)\n\n## Goal\nStage: pilot.\nOptimization goal: build cost first. Then the rest.\n');
  W('roadmap.md', renderRoadmap([
    L('s-run', 'running', 'Import of price lists'), L('s-ord', 'ordered', 'Supplier list'), L('s-done', 'done', 'Search by colour'),
    L('s-todo', 'todo', goal, ['s-run']), L('s-ready', 'ready', 'Faster start screen', ['s-done', 's-old']), L('s-todo2', 'todo', 'Discount list in invoices'),
    L('s-notes', 'notes', 'Offline editor sync'), L('s-topic', 'topic', 'Second computer'),
  ]));
  W('archive/index.md', renderIndex([
    { id: 's-old', goal: 'Old export', merged: '2026-10-01', run: 'r-1', files: 10, tokensM: 2, lines: 400 },
    { id: 's-old2', goal: 'Small fix', merged: '2026-10-05', run: 'r-2', files: 4, tokensM: 2 },
    { id: 's-drop', goal: 'Dropped idea', merged: 'dropped', run: null, files: null, tokensM: null },
  ]));
  W('archive/s-old.md', spec('s-old', { items: ['B-1', 'B-2'], est: 'start:[1,3]', actual: { files: 10, tokens: 2, uat: 'pending' } }, '## Goal\nOld export.\n'));
  W('archive/s-old2.md', spec('s-old2', { est: 'start:[0.5,1]', actual: { files: 4, tokens: 2, uat: 'n/a' } }, '## Goal\nSmall fix.\n'));
  write(d, 'mock/001-list/index.html', '<p>mock</p>');
  const todoBody = '## Goal\nClient export (B-3, PD-1) works.\n\n## Acceptance\n- AC-1 [human] The client sees B-3 items\n\n## Decisions\n- PD-1\n\n## Mockups\nmock/001-list variant B; also mock/001 and docs/none/x.html\n\n## Open questions\n- [architect] where the filter lives\n\n## For you\nTitle: Export for the client\nWhy: You send the client a list of what they accepted.\nChanges:\n- A download button\nCheck:\n- Press download\n';
  W('sprints/s-todo.md', spec('s-todo', { items: ['B-2'], ui: true, est: 'start:[1,2]' }, todoBody));
  W('sprints/s-todo2.md', spec('s-todo2', { ui: true }, '## Goal\nDiscounts in invoices.\n\n## Acceptance\n- AC-1 Discounts listed\n\n## Mockups\nsketches/404 not made yet\n\n## Open questions\n- Which order of discounts?\n- [architect] reuse the table\n'));
  W('sprints/s-ready.md', spec('s-ready', { est: 'E-1', ready: { at: '2026-10-10', by: 'decydent' } }, '## Goal\nStart faster.\n\n## Acceptance\n- AC-1 Opens in 1 s\n'));
  for (const id of ['s-run', 's-ord', 's-done']) W(`sprints/${id}.md`, spec(id, { kind: 'bugfix' }, `## Goal\nGoal of ${id}.\n\n## Acceptance\n- AC-1 Works\n\n## Out of scope\n- PDF (B-9)\n`));
  W('sprints/s-notes.md', spec('s-notes', {}, '## Goal\nSync the editor.\n\n## Notes\n- Talk to B-3 owner\n'));
  W('backlog.jsonl', [
    { id: 'B-1', type: 'debt', title: 'Leftover from old export', state: 'open', triage: 'sprint:s-old', sprint: null, anchors: [] },
    { id: 'B-2', type: 'feature', title: 'Export button', state: 'planned', triage: 'sprint:s-todo', sprint: 's-todo', anchors: ['src/export.ts'] },
    { id: 'B-3', type: 'bug', title: 'Wrong total in export', sev: 'major', state: 'new', triage: null, anchors: [] },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  W('backlog-archive.jsonl', `${JSON.stringify({ id: 'B-9', type: 'feature', title: 'Done thing', state: 'done', triage: 'sprint:s-old', anchors: [] })}\n`);
  W('decisions.md', '# dwmt/decisions@1 — active decisions\n\n### PD-1 Export lists accepted items only\narea: export; at: 2026-10-02; src: -; by: po\nDecision: Only accepted.\nWhy: Client asked.\nAgainst recommendation: no\n\n### PD-2 Dark mode later\narea: ui, settings; at: 2026-10-03; src: -; by: import\nDecision: Later.\nAgainst recommendation: yes — PO wanted it now\n');
  W('estimates.jsonl', `${JSON.stringify({ id: 'E-1', at: '2026-10-09', for: ['s-ready'], level: 0, areas: [], files: [3, 6], tokensM: [2, 4], flags: {}, cost: 0.1, stale: false, actual: null })}\n`);
  gitIn(d)('add', '-A');
  gitIn(d)('commit', '-q', '-m', 'product');
  return d;
}

// ---------- view model ----------

test('view model: human states, next, open after, needs, For you or fallback, mockups, decisions, estimates, analogs, archive, history, stale items', () => {
  const d = project();
  const D = viewModel(ctx(d));
  const S = Object.fromEntries(D.sprints.map((s) => [s.id, s]));
  assert.deepEqual(Object.fromEntries(D.sprints.map((s) => [s.id, s.human])), {
    's-run': 'inprogress', 's-ord': 'inprogress', 's-done': 'review', 's-todo': 'todo', 's-ready': 'todo', 's-todo2': 'todo', 's-notes': 'draft', 's-topic': 'draft',
    's-old': 'review', 's-old2': null, 's-drop': null,
  });
  assert.deepEqual([S['s-todo'].pos, S['s-topic'].pos, S['s-old'].pos], [4, 8, null]);
  assert.deepEqual([S['s-old'].state, S['s-old2'].state, S['s-drop'].state, S['s-drop'].dropped], ['review', 'closed', 'dropped', true]);
  assert.deepEqual(D.next, { id: 's-ready', why: 'ready, dependencies merged', also: [] });
  assert.deepEqual([S['s-todo'].afterOpen, S['s-ready'].after, S['s-ready'].afterOpen], [['s-run'], ['s-done', 's-old'], []]);
  // needs only on To do lines that are not ready: mockup (ui, no existing path), price (no est), questions for the user.
  assert.deepEqual([S['s-todo'].needs, S['s-todo2'].needs, S['s-ready'].needs, S['s-run'].needs], [[], ['mockup', 'price', 'answers'], [], []]);
  assert.equal(S['s-todo2'].questions, 1);
  assert.deepEqual(S['s-todo'].forYou, { title: 'Export for the client', why: 'You send the client a list of what they accepted.', changes: ['A download button'], notIncluded: [], check: ['Press download'] });
  assert.equal(S['s-todo'].fallback, null);
  assert.deepEqual(S['s-run'].fallback, { goal: 'Goal of s-run.', changes: ['Works'], notIncluded: ['PDF'], notes: [] });
  assert.deepEqual(S['s-notes'].fallback.notes, ['Talk to owner']);
  assert.equal(S['s-topic'].hasFile, false);
  assert.ok(!S['s-todo'].sections.some(([k]) => k === 'For you'), 'technical sections without For you');
  assert.deepEqual(S['s-todo'].mockups, [{ path: 'mock/001-list', href: '../../../mock/001-list/index.html' }]);
  assert.deepEqual(S['s-todo'].decisions, [{ id: 'PD-1', title: 'Export lists accepted items only', titleTr: null }]);
  assert.deepEqual([S['s-ready'].estRange, S['s-todo'].estRange, S['s-old'].estRange, S['s-todo2'].estRange], [[2, 4], [1, 2], [1, 3], null]);
  assert.equal(S['s-ready'].readyAt, '2026-10-10');
  // Analogs: closed sprints of the same kind, nearest item count (tie: newer first), two.
  assert.deepEqual(S['s-todo'].analogs, [{ id: 's-old2', files: 4, tokensM: 2 }, { id: 's-old', files: 10, tokensM: 2 }]);
  assert.deepEqual(S['s-run'].analogs, []);
  assert.deepEqual([S['s-old'].merged, S['s-old'].files, S['s-old'].tokensM, S['s-old'].perFile, S['s-old'].uat, S['s-old'].run, S['s-drop'].merged], ['2026-10-01', 10, 2, 0.2, 'pending', 'r-1', null]);
  assert.deepEqual(D.history, [
    { id: 's-old', merged: '2026-10-01', files: 10, tokensM: 2, perFile: 0.2, lines: 400, perLineK: 5, estRange: [1, 3], fit: 'in', kind: 'feature', uat: 'pending' },
    { id: 's-old2', merged: '2026-10-05', files: 4, tokensM: 2, perFile: 0.5, lines: null, perLineK: null, estRange: [0.5, 1], fit: 'above', kind: 'feature', uat: 'n/a' },
  ]);
  const I = Object.fromEntries(D.items.map((x) => [x.id, x]));
  assert.deepEqual([I['B-1'].stale, I['B-2'].stale, I['B-1'].tri, I['B-3'].tri, I['B-1'].sprint, I['B-9'].closed, I['B-2'].closed], [true, false, 'sprint', 'new', 's-old', true, false]);
  assert.deepEqual(D.stale, { 's-old': ['B-1'] });
  assert.ok(D.warnings.some((w) => /1 open item\(s\) assigned to closed sprint s-old: B-1/.test(w)), D.warnings.join('\n'));
  assert.deepEqual(D.decisions.map((x) => [x.id, x.areas, x.against, x.why]), [['PD-1', ['export'], null, 'Client asked.'], ['PD-2', ['ui', 'settings'], 'PO wanted it now', null]]);
  assert.deepEqual(D.goal, { text: 'build cost first.', tr: null });
  assert.deepEqual([D.project, D.language, D.untranslated], [basename(d), 'en', 0]);
  assert.deepEqual(D.forYouMissing, ['s-run', 's-ord', 's-done', 's-ready', 's-todo2', 's-old']);
  assert.deepEqual(translatable(D).length, 1 + 11 + 3 + 2 + 1, 'goal, 11 sprint goals, 3 open item titles, 2 decision titles, 1 user question of an open sprint');
  assert.equal(noIds('Cover (later, B-12); see AC-2 [human] (PD-1)'), 'Cover (later); see');
});

// ---------- HTML writer and command ----------

test('product view: one self-contained file, data JSON parses back, </script> escaped, no network resources, --out, --open', () => {
  const d = project({}, { goal: 'Export </script><b>x</b> list' });
  const plog = join(mkdtempSync(join(tmpdir(), 'pl-')), 'platform.jsonl');
  const r = prEnv(d, { DWMT_PLATFORM_LOG: plog }, 'view', '--open');
  assert.equal(r.code, 0, r.out);
  assert.deepEqual([r.json.ok, r.json.sprints, r.json.items, r.json.decisions, r.json.untranslated, r.json.forYouMissing, r.json.opened], [true, 11, 3, 2, 0, 6, true]);
  assert.match(r.json.file, /\/\.dwmt\/product\/view\/index\.html$/);
  assert.ok(existsSync(r.json.file));
  assert.ok(r.json.warnings.some((w) => /closed sprint s-old/.test(w)));
  assert.deepEqual(logLines(plog).map((x) => [x.fn, x.file.replace(/\\/g, '/')]), [['open', r.json.file]]);
  const html = readFileSync(VIEW(d), 'utf8');
  assert.equal((html.match(/<\/script>/g) ?? []).length, 2, 'only the data and the code blocks close');
  assert.doesNotMatch(html, /<\/script><b>/);
  const D = dataOf(html);
  assert.equal(D.sprints.find((s) => s.id === 's-todo').goal, 'Export </script><b>x</b> list');
  assert.equal(D.schema, 'dwmt/view@1');
  assert.doesNotMatch(html, /(?:src|href)\s*=\s*["']?(?:https?:)?\/\/|url\(\s*["']?(?:https?:)?\/\/|@import|<link\b|<script\s+src/i);
  assert.match(html, /<style>[\s\S]*prefers-color-scheme: dark[\s\S]*<\/style>/);
  const js = /<script>\n([\s\S]*?)\n<\/script>/.exec(html)[1];
  assert.doesNotThrow(() => new Script(js), 'view.js parses');
  assert.match(gitIn(d)('check-ignore', '-v', '.dwmt/product/view/index.html'), /exclude/);
  assert.equal(gitIn(d)('status', '--porcelain'), '');
  // --out: elsewhere, mockup links relative to that file.
  const out = join(mkdtempSync(join(tmpdir(), 'view-')), 'page.html');
  const o = pr(d, 'view', '--out', out);
  assert.equal(o.code, 0, o.out);
  const D2 = dataOf(readFileSync(out, 'utf8'));
  assert.match(D2.sprints.find((s) => s.id === 's-todo').mockups[0].href, /^(\.\.\/)+.*mock\/001-list\/index\.html$/);
  assert.equal(o.json.opened, undefined);
});

// ---------- regeneration hooks ----------

test('view regenerated after product commit, sync and brief (0 tokens, no model call without language); product.view.enabled false: not', () => {
  const d = project();
  const log = join(mkdtempSync(join(tmpdir(), 'vl-')), 'calls.jsonl');
  for (const cmd of [['commit'], ['sync'], ['brief']]) {
    rmSync(VIEW(d), { force: true });
    const r = prEnv(d, { DWMT_CLAUDE: STUB, STUB_LOG: log }, ...cmd);
    assert.equal(r.code, 0, r.out);
    assert.ok(existsSync(VIEW(d)), `${cmd} regenerates`);
    if (r.json) assert.equal(r.json.viewWarning, undefined);
  }
  assert.deepEqual(logLines(log), [], 'language en: no translation');
  pr(d, 'roadmap', 'set', 's-notes', 'goal', 'Offline editor sync v2');
  rmSync(VIEW(d), { force: true });
  const c = pr(d, 'commit');
  assert.equal(c.json.committed, true, c.out);
  assert.equal(dataOf(readFileSync(VIEW(d), 'utf8')).sprints.find((s) => s.id === 's-notes').goal, 'Offline editor sync v2');
  // `product intake` from the command line regenerates too (in process, finish and uat record refresh once, below).
  fakeRun(d, 'r-9', { spec: 's-run' });
  rmSync(VIEW(d), { force: true });
  assert.equal(pr(d, 'intake', 'r-9').json.ok, true);
  assert.ok(existsSync(VIEW(d)), 'intake regenerates');
  // A failing generator is a warning, never the caller's failure.
  rmSync(join(d, '.dwmt', 'product', 'view'), { recursive: true, force: true });
  write(d, '.dwmt/product/view', 'not a directory');
  const w = pr(d, 'sync');
  assert.equal(w.code, 0, w.out);
  assert.match(w.json.viewWarning, /^view: /);
  assert.match(pr(d, 'brief').out, /\nview: /);
  // product.view.enabled false: no regeneration.
  const e = project({ product: { view: { enabled: false } } });
  pr(e, 'sync');
  pr(e, 'commit');
  pr(e, 'brief');
  assert.equal(existsSync(VIEW(e)), false);
  assert.equal(pr(e, 'view').code, 0, 'explicit view still works');
});

// ---------- translation memory ----------

test('translations: --translate sends only missing strings, memory keyed by source, changed source retranslated, failures are warnings', () => {
  const d = project({ language: 'pl', product: { view: { translateTimeoutS: 2 } } });
  const log = join(mkdtempSync(join(tmpdir(), 'vl-')), 'calls.jsonl');
  const env = (extra = {}) => ({ DWMT_CLAUDE: STUB, STUB_LOG: log, ...extra });
  let r = prEnv(d, env(), 'view', '--translate');
  assert.equal(r.code, 0, r.out);
  assert.deepEqual([r.json.sent, r.json.translated, r.json.untranslated, r.json.language], [18, 18, 0, 'pl']);
  assert.match(r.json.costHint, /^1 call\(s\), 0\.003 M tokens, \$0\.001 \(haiku\)$/);
  let calls = logLines(log);
  assert.equal(calls.length, 1);
  const a = calls[0].args;
  assert.deepEqual([a[a.indexOf('--model') + 1], a[a.indexOf('--tools') + 1], a[a.indexOf('--output-format') + 1], a[a.indexOf('--setting-sources') + 1]], ['haiku', '', 'json', 'user']);
  assert.ok(a.includes('--no-session-persistence') && a.includes('--strict-mcp-config'), 'no transcript, no MCP servers');
  assert.match(calls[0].prompt, /language with code "pl"/);
  assert.match(calls[0].prompt, /Keep identifiers unchanged/);
  const sent = JSON.parse(calls[0].prompt.trim().split('\n').at(-1));
  assert.ok(Object.values(sent).includes('Export lists accepted items only') && Object.values(sent).includes('Wrong total in export'));
  assert.ok(!Object.values(sent).includes('Done thing'), 'closed items are not translated');
  const mem = JSON.parse(readFileSync(join(d, '.dwmt', 'product', 'view', 'i18n-pl.json'), 'utf8'));
  assert.equal(Object.keys(mem).length, 18);
  assert.ok(Object.values(sent).includes('Which order of discounts?'), 'the user question of an open sprint is sent');
  const D = dataOf(readFileSync(VIEW(d), 'utf8'));
  assert.deepEqual([D.sprints.find((s) => s.id === 's-run').goalTr, D.items.find((x) => x.id === 'B-3').titleTr, D.decisions[0].titleTr, D.goal.tr],
    ['PL Import of price lists', 'PL Wrong total in export', 'PL Export lists accepted items only', 'PL build cost first.']);
  // Nothing missing: no call.
  r = prEnv(d, env(), 'view', '--translate');
  assert.deepEqual([r.json.sent, r.json.costHint, logLines(log).length], [0, 'no calls', 1]);
  // Changed source: only that string.
  pr(d, 'roadmap', 'set', 's-notes', 'goal', 'Offline editor sync v2');
  r = prEnv(d, env(), 'view', '--translate');
  assert.deepEqual([r.json.sent, r.json.translated], [1, 1]);
  calls = logLines(log);
  assert.deepEqual(Object.values(JSON.parse(calls.at(-1).prompt.trim().split('\n').at(-1))), ['Offline editor sync v2']);
  assert.equal(dataOf(readFileSync(VIEW(d), 'utf8')).sprints.find((s) => s.id === 's-notes').goalTr, 'PL Offline editor sync v2');
  // Failures: bad answer, timeout and a partial answer are warnings; the page stands.
  for (const [mode, re] of [['bad', /^translation: bad answer: no JSON object/], ['slow', /^translation: timeout after 2 s/], ['partial', /1 string\(s\) without a translation/]]) {
    pr(d, 'roadmap', 'set', 's-topic', 'goal', `Second computer ${mode}`);
    rmSync(VIEW(d), { force: true });
    r = prEnv(d, env({ STUB_MODE: mode }), 'view', '--translate');
    assert.equal(r.code, 0, r.out);
    assert.ok(r.json.warnings.some((w) => re.test(w)), r.out);
    assert.ok(existsSync(VIEW(d)));
    assert.equal(dataOf(readFileSync(VIEW(d), 'utf8')).untranslated, 1);
  }
  // --lang en: no call at all.
  const n = logLines(log).length;
  r = prEnv(d, env(), 'view', '--translate', '--lang', 'en');
  assert.deepEqual([r.json.costHint, r.json.untranslated, logLines(log).length], ['no calls (language en)', 0, n]);
});

test('translations: batches of 150, view --translate sends all of them in one run', () => {
  const d = project({ language: 'pl' });
  const big = (n) => Array.from({ length: n }, (_, i) => JSON.stringify({ id: `B-${i + 1}`, type: 'idea', title: `Idea number ${i + 1}`, state: 'open', triage: 'later', anchors: [] })).join('\n') + '\n';
  write(d, 'docs/product/backlog.jsonl', big(310));
  const log = join(mkdtempSync(join(tmpdir(), 'vl-')), 'calls.jsonl');
  const sizes = () => logLines(log).map((c) => Object.keys(JSON.parse(c.prompt.trim().split('\n').at(-1))).length);
  const r = prEnv(d, { DWMT_CLAUDE: STUB, STUB_LOG: log }, 'view', '--translate');
  assert.deepEqual([r.json.sent, r.json.translated, r.json.untranslated], [325, 325, 0]);
  assert.deepEqual(sizes(), [150, 150, 25]);
});

test('product commit never waits for the model: a detached translator starts only when strings are missing and the language is not en', () => {
  const plog = join(mkdtempSync(join(tmpdir(), 'pl-')), 'platform.jsonl');
  const log = join(mkdtempSync(join(tmpdir(), 'vl-')), 'calls.jsonl');
  const env = { DWMT_CLAUDE: STUB, STUB_LOG: log, DWMT_PLATFORM_LOG: plog };
  const spawns = () => logLines(plog).filter((x) => x.fn === 'spawn');
  // Language en: nothing to translate.
  const e = project();
  pr(e, 'roadmap', 'set', 's-notes', 'goal', 'Changed');
  let r = prEnv(e, env, 'commit');
  assert.equal(r.json.committed, true, r.out);
  assert.equal(r.json.viewTranslating, undefined);
  assert.deepEqual(spawns(), []);
  // Language pl, 18 strings missing: the page at once, one detached `product view --translate --quiet` in the main tree.
  const d = project({ language: 'pl' });
  rmSync(VIEW(d), { force: true });
  r = prEnv(d, env, 'commit');
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.json.viewTranslating, { strings: 18, pid: null });
  assert.ok(existsSync(VIEW(d)), 'page written before any translation');
  let sp = spawns();
  assert.equal(sp.length, 1);
  assert.equal(sp[0].cmd, process.execPath);
  assert.match(sp[0].args[0].replace(/\\/g, '/'), /\/scripts\/dwmt\.mjs$/);
  assert.deepEqual(sp[0].args.slice(1), ['product', 'view', '--translate', '--quiet']);
  assert.equal(basename(sp[0].cwd), basename(d));
  assert.deepEqual(logLines(log), [], 'the commit itself calls no model');
  // A live translator holds the lock: no second one, and an explicit --translate sends nothing.
  const lock = '.dwmt/product/view/translate.lock';
  write(d, lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  r = prEnv(d, env, 'commit');
  assert.deepEqual(r.json.viewTranslating, { strings: 18, running: process.pid });
  assert.equal(spawns().length, 1);
  r = prEnv(d, env, 'view', '--translate');
  assert.equal(r.code, 0, r.out);
  assert.ok(r.json.warnings.some((w) => /a background translation is running/.test(w)), r.out);
  assert.deepEqual([r.json.sent, logLines(log).length], [undefined, 0]);
  // A holder silent past one call's timeout + 1 min is taken over.
  write(d, lock, JSON.stringify({ pid: process.pid, at: '2020-01-01T00:00:00Z' }));
  r = prEnv(d, env, 'commit');
  assert.deepEqual(r.json.viewTranslating, { strings: 18, pid: null });
  assert.equal(spawns().length, 2);
  // Nothing missing: no translator.
  rmSync(join(d, lock), { force: true });
  assert.equal(prEnv(d, env, 'view', '--translate').json.translated, 18);
  assert.ok(!existsSync(join(d, lock)), 'lock released');
  r = prEnv(d, env, 'commit');
  assert.equal(r.json.viewTranslating, undefined);
  assert.equal(spawns().length, 2);
  // product.view.translate false: none either.
  pr(d, 'roadmap', 'set', 's-notes', 'goal', 'Offline editor sync v3');
  write(d, '.claude/dwmt.json', JSON.stringify({ git: { target: 'master' }, language: 'pl', product: { view: { translate: false } } }));
  r = prEnv(d, env, 'commit');
  assert.equal(r.json.committed, true, r.out);
  assert.equal(r.json.viewTranslating, undefined);
  assert.equal(spawns().length, 2);
});

test('the background translator: a real detached process translates every missing string, then regenerates the page (stub model)', async () => {
  const d = project({ language: 'pl' });
  const log = join(mkdtempSync(join(tmpdir(), 'vl-')), 'calls.jsonl');
  const r = prEnv(d, { DWMT_CLAUDE: STUB, STUB_LOG: log }, 'commit');
  assert.equal(r.code, 0, r.out);
  assert.equal(r.json.viewTranslating.strings, 18);
  assert.ok(r.json.viewTranslating.pid > 0, r.out);
  const lock = join(d, '.dwmt', 'product', 'view', 'translate.lock');
  const page = () => { try { return dataOf(readFileSync(VIEW(d), 'utf8')); } catch { return null; } };
  const done = () => !existsSync(lock) && page()?.untranslated === 0;
  for (let i = 0; i < 300 && !done(); i++) await new Promise((res) => setTimeout(res, 100));
  assert.ok(done(), 'translated, page regenerated, lock released');
  assert.equal(logLines(log).length, 1);
  assert.equal(page().sprints.find((s) => s.id === 's-run').goalTr, 'PL Import of price lists');
});

// ---------- template, opener, worktree, merged results, refresh points ----------

test('renderHtml: placeholders inside the content stay content (one pass over the template)', () => {
  const tricky = 'Export /*{{js}}*/ {{data}} {{title}} /*{{css}}*/ {{lang}} $& $1';
  const d = project({}, { goal: tricky });
  assert.equal(pr(d, 'view').code, 0);
  const html = readFileSync(VIEW(d), 'utf8');
  assert.equal(dataOf(html).sprints.find((s) => s.id === 's-todo').goal, tricky);
  const js = /<script>\n([\s\S]*?)\n<\/script>/.exec(html)[1];
  assert.doesNotThrow(() => new Script(js), 'view.js parses');
  assert.equal(html.split('dwmt product view (read-only, generated)').length, 2, 'view.js inserted once');
  assert.equal((html.match(/prefers-color-scheme: dark/g) ?? []).length >= 1, true);
  assert.match(html, new RegExp(`<title>${basename(d)} · dwmt</title>`));
});

test('openFile: Windows opener without a command interpreter; a path with space, &, % and ^ is one argument', () => {
  const f = 'C:\\Users\\a b\\x&y %PATH% ^z\\index.html';
  assert.deepEqual(openerOf(f, 'win32'), ['rundll32.exe', ['url.dll,FileProtocolHandler', f]]);
  assert.deepEqual(openerOf('/tmp/a b/x&y.html', 'darwin'), ['open', ['/tmp/a b/x&y.html']]);
  assert.deepEqual(openerOf('/tmp/a b/x&y.html', 'linux'), ['xdg-open', ['/tmp/a b/x&y.html']]);
  const d = project();
  const plog = join(mkdtempSync(join(tmpdir(), 'pl-')), 'platform.jsonl');
  const out = join(mkdtempSync(join(tmpdir(), 'v &%^ x-')), 'page.html');
  const r = prEnv(d, { DWMT_PLATFORM_LOG: plog }, 'view', '--open', '--out', out);
  assert.equal(r.json.opened, true, r.out);
  const [o] = logLines(plog).filter((x) => x.fn === 'open');
  assert.deepEqual([o.cmd, o.args], openerOf(resolve(out)));
  assert.equal(o.args.at(-1), resolve(out));
});

test('view from a sprint worktree: page, data and mockup links of the main tree; a page on another drive links mockups by file URL', () => {
  const d = project();
  const wt = join(mkdtempSync(join(tmpdir(), 'wt-')), 'wt');
  gitIn(d)('worktree', 'add', '-q', '-b', 'dwmt/x', wt);
  // The worktree's product files differ (not merged yet): the page shows the main tree.
  write(wt, 'docs/product/roadmap.md', readFileSync(join(wt, 'docs', 'product', 'roadmap.md'), 'utf8').replace('Import of price lists', 'Worktree goal'));
  const r = pr(wt, 'view');
  assert.equal(r.code, 0, r.out);
  assert.ok(existsSync(VIEW(d)) && !existsSync(VIEW(wt)), 'page in the main tree only');
  assert.equal(basename(dirname(dirname(dirname(dirname(r.json.file))))), basename(d));
  const D = dataOf(readFileSync(VIEW(d), 'utf8'));
  assert.equal(D.sprints.find((s) => s.id === 's-run').goal, 'Import of price lists');
  assert.deepEqual(D.sprints.find((s) => s.id === 's-todo').mockups, [{ path: 'mock/001-list', href: '../../../mock/001-list/index.html' }]);
  assert.equal(D.project, basename(d));
  // The hook after a write command run in the worktree goes to the main tree as well.
  rmSync(VIEW(d), { force: true });
  assert.equal(pr(wt, 'sync').code, 0);
  assert.ok(existsSync(VIEW(d)) && !existsSync(VIEW(wt)));
  // `--out` on another drive (Windows): no relative path, a file URL instead.
  if (process.platform === 'win32') {
    const drive = /^([A-Za-z]):/.exec(resolve(d))[1].toUpperCase();
    const [m] = mockupLinks(d, 'mock/001-list', `${drive === 'Z' ? 'Y' : 'Z'}:\\pages`);
    assert.equal(m.href, pathToFileURL(join(d, 'mock', '001-list', 'index.html')).href);
    assert.match(m.href, /^file:\/\/\/[A-Za-z]:\//);
  }
});

test('home tree: the worktree holding the target branch, also while a sprint runs there on a run branch (bugs.txt 1)', () => {
  const d = repo();
  const wt = join(mkdtempSync(join(tmpdir(), 'wt-')), 'wt');
  gitIn(d)('worktree', 'add', '-q', '-b', 'feature/x', wt);
  config(wt, { git: { target: 'feature/x' }, product: { view: { publish: null } } });
  assert.equal(pr(wt, 'init').code, 0);
  assert.equal(pr(wt, 'roadmap', 'add', 's-1', '--goal', 'Home tree goal').code, 0);
  const r = pr(wt, 'view');
  assert.equal(r.code, 0, r.out);
  assert.equal(r.json.sprints, 1, r.out);
  assert.ok(existsSync(VIEW(wt)) && !existsSync(VIEW(d)), 'page in the tree with the target branch');
  // A sprint without --worktree takes the target branch off this tree: its run.json keeps the home here (D-3).
  gitIn(wt)('switch', '-q', '-c', 'dwmt/r');
  mkdirSync(join(wt, '.dwmt', 'runs', 'r'), { recursive: true });
  writeFileSync(join(wt, '.dwmt', 'runs', 'r', 'run.json'), JSON.stringify({ run: 'r', homeTree: wt }));
  // Paths as git prints them: the temp dir may be an 8.3 short name on Windows.
  const real = (p) => gitIn(p)('rev-parse', '--show-toplevel');
  assert.ok(samePath(contextHome(wt), real(wt)));
  // An older run worktree of the first tree (run.json with mainTree only) while the target is checked out nowhere.
  config(d, { git: { target: 'master' } });
  gitIn(d)('switch', '-q', '-c', 'other');
  const run = join(d, '.claude', 'worktrees', 'r2');
  gitIn(d)('worktree', 'add', '-q', '-b', 'dwmt/r2', run);
  config(run, { git: { target: 'master' } });
  mkdirSync(join(run, '.dwmt', 'runs', 'r2'), { recursive: true });
  writeFileSync(join(run, '.dwmt', 'runs', 'r2', 'run.json'), JSON.stringify({ run: 'r2', mainTree: d }));
  assert.ok(samePath(contextHome(run), real(d)));
});

test('view publish: the only page lives in the product dir, refreshed by every refresh, committed with the product; a refresh with no change writes nothing (bugs.txt 5)', () => {
  const d = project({ product: { view: { publish: 'docs/product/roadmap.html' } } });
  const g = gitIn(d);
  const PUB = join(d, 'docs', 'product', 'roadmap.html');
  assert.equal(pr(d, 'roadmap', 'add', 's-new', '--goal', 'Published goal').code, 0);
  // A refresh writes the page in the product dir, not in .dwmt/; live.js is loaded from .dwmt/ by a relative path.
  const v = pr(d, 'view');
  assert.equal(v.code, 0, v.out);
  assert.ok(v.json.file.endsWith('/docs/product/roadmap.html') && existsSync(PUB), v.json.file);
  assert.ok(!existsSync(VIEW(d)), 'no second page in .dwmt/');
  const D = dataOf(readFileSync(PUB, 'utf8'));
  assert.ok(D.sprints.some((s) => s.id === 's-new'));
  assert.deepEqual([D.live.enabled, D.live.src], [true, '../../.dwmt/product/view/live.js']);
  const r = pr(d, 'commit');
  assert.equal(r.json.committed, true, r.out);
  assert.equal(r.json.published, 'docs/product/roadmap.html');
  assert.match(g('show', '--name-only', '--format=', 'HEAD'), /docs\/product\/roadmap\.html/);
  assert.equal(g('status', '--porcelain'), '', 'nothing left after commit (the refresh after it changed only generatedAt)');
  // Refreshes without a change write nothing, so a commit after them has nothing to take.
  assert.equal(pr(d, 'commit').json.committed, false);
  assert.equal(pr(d, 'brief').code, 0);
  assert.equal(pr(d, 'view').json.unchanged, true);
  assert.equal(g('status', '--porcelain'), '');
});

test('view publish default (no publish key): product commit writes and commits docs/product/roadmap.html, status clean, the old .dwmt page untouched (D-5, D-8, R-6)', () => {
  const d = repo();
  const g = gitIn(d);
  config(d, { git: { target: 'master' } });
  assert.equal(pr(d, 'init', '--goal', 'Pilot').code, 0);
  const OLD = '<html>old page under .dwmt</html>';
  write(d, '.dwmt/product/view/index.html', OLD);
  const before = readFileSync(VIEW(d));
  g('add', '-A'); g('commit', '-q', '-m', 'product init');
  assert.equal(pr(d, 'roadmap', 'add', 's-new', '--goal', 'Default page goal').code, 0);
  const r = pr(d, 'commit');
  assert.equal(r.json.committed, true, r.out);
  assert.equal(r.json.published, 'docs/product/roadmap.html');
  assert.match(g('show', '--name-only', '--format=', 'HEAD'), /^docs\/product\/roadmap\.html$/m);
  const PUB = join(d, 'docs', 'product', 'roadmap.html');
  assert.ok(dataOf(readFileSync(PUB, 'utf8')).sprints.some((s) => s.id === 's-new'));
  assert.equal(g('status', '--porcelain'), '');
  assert.deepEqual(readFileSync(VIEW(d)), before, 'old page byte-identical');
});

test('view model: a merged sprint still on the roadmap (done) shows its result from the header and joins the history', () => {
  const d = project();
  write(d, 'docs/product/sprints/s-done.md', spec('s-done', { kind: 'bugfix', actual: { files: 5, tokens: 1.5, lines: 300, uat: 'pending', merged: '2026-10-08' } }, '## Goal\nGoal of s-done.\n'));
  let D = viewModel(ctx(d));
  const s = D.sprints.find((x) => x.id === 's-done');
  assert.deepEqual([s.human, s.merged, s.files, s.tokensM, s.perFile, s.lines, s.perLineK, s.uat], ['review', '2026-10-08', 5, 1.5, 0.3, 300, 5, 'pending']);
  assert.deepEqual(D.history.map((h) => h.id), ['s-old', 's-old2', 's-done']);
  assert.deepEqual(D.history.at(-1), { id: 's-done', merged: '2026-10-08', files: 5, tokensM: 1.5, perFile: 0.3, lines: 300, perLineK: 5, estRange: null, fit: null, kind: 'bugfix', uat: 'pending' });
  // Without lines in the header: unknown, never 0.
  write(d, 'docs/product/sprints/s-done.md', spec('s-done', { kind: 'bugfix', actual: { files: 5, tokens: 1.5, uat: 'pending', merged: '2026-10-08' } }, '## Goal\nGoal of s-done.\n'));
  D = viewModel(ctx(d));
  assert.deepEqual([D.history.at(-1).lines, D.history.at(-1).perLineK, D.history.at(-1).perFile], [null, null, 0.3]);
});

test('view model: an old archive row without the lines column', () => {
  const d = project();
  write(d, 'docs/product/archive/index.md', '# dwmt/archive-index@2 — closed sprints\n\n| id | goal | merged | run | files | tokensM |\n|---|---|---|---|---|---|\n| s-1 | Old | 2026-10-01 | r-1 | 4 | 2 |\n');
  let D;
  assert.doesNotThrow(() => { D = viewModel(ctx(d)); });
  const h = D.history.find((x) => x.id === 's-1');
  assert.deepEqual([h.lines, h.perLineK, h.perFile], [null, null, 0.5]);
});

test("view model: the user's open questions as text for the card", () => {
  const d = project({ language: 'pl' });
  write(d, 'docs/product/sprints/s-todo2.md', spec('s-todo2', { ui: true }, '## Goal\nDiscounts in invoices.\n\n## Open questions\n- [decision-maker] Which export format?\n- [architect] Pick the parser.\n- Keep the old links?\n'));
  let S = Object.fromEntries(viewModel(ctx(d)).sprints.map((x) => [x.id, x]));
  assert.deepEqual(S['s-todo2'].questionList, [{ text: 'Which export format?', tr: null }, { text: 'Keep the old links?', tr: null }]);
  assert.equal(S['s-todo2'].questions, 2);
  assert.deepEqual(S['s-todo'].questionList, []);
  write(d, '.dwmt/product/view/i18n-pl.json', JSON.stringify({ [createHash('sha1').update('Which export format?').digest('hex')]: 'Jaki format eksportu?' }));
  S = Object.fromEntries(viewModel(ctx(d)).sprints.map((x) => [x.id, x]));
  assert.deepEqual(S['s-todo2'].questionList.map((q) => q.tr), ['Jaki format eksportu?', null]);
});

// finish: real run with the product layer (inline mode, as in the end-of-sprint tests).
// `product` replaces the product configuration (default: the page under .dwmt/, `publish: null`).
function finishedSprint(product = { view: { publish: null } }) {
  const d = repo();
  config(d, { verify: { full: ['node -e 0'] }, git: { target: 'master' }, product });
  assert.equal(pr(d, 'init', '--goal', 'Pilot: build cost').code, 0);
  assert.equal(pr(d, 'item', 'add', '--type', 'bug', '--title', 'Date picker shows UTC', '--sev', 'major').code, 0);
  gitIn(d)('add', '-A'); gitIn(d)('commit', '-q', '-m', 'product');
  const b = pr(d, 'spec', 'bugfix', 'B-1');
  gitIn(d)('add', '-A'); gitIn(d)('commit', '-q', '-m', 'spec');
  const run = cli(d, 'preflight', '--slug', 'fin').json.run;
  assert.equal(cli(d, 'init', '--run', run, '--mode', 'inline', '--input', `docs/product/sprints/${b.json.id}.md`).json.ok, true);
  const brief = join(d, '..', `${run}-brief.md`);
  writeFileSync(brief, `${header({ schema: 'dwmt/brief@1', run, goal: 'Fix B-1', mode: 'inline', acceptance: ['AC-1 local time'], scope: ['*.txt'], verify: ['node -e 0'], risk: [] })}# Plan\n\n## UAT\nUAT: none.\n`);
  assert.equal(cli(d, 'import-plan', brief, '--run', run).json.ok, true);
  writeFileSync(join(d, 'c.txt'), 'c\n');
  cli(d, 'verify', run);
  cli(d, 'review-input', run);
  writeFileSync(runFile(d, run, 'review-1.md'), header({ schema: 'dwmt/review@1', round: 1, passes: ['correctness'], verdict: 'PASS', fix: [], defer: ['F-1'], drop: [], acceptance: ['AC-1 met'] }) + '### F-1 [minor] Helper name unclear\n`c.txt:1`\n');
  assert.equal(cli(d, 'commit', run).json.ok, true);
  return { d, run };
}

test('finish: the page is written once, after the merge lease is released (in-process intake does not write it)', () => {
  const { d, run } = finishedSprint();
  const log = join(mkdtempSync(join(tmpdir(), 'vw-')), 'writes.jsonl');
  const fin = dw(d, ['finish', run], { DWMT_VIEW_LOG: log });
  assert.equal(fin.json?.status, 'squashed', fin.out);
  assert.ok(fin.json.intake && !fin.json.intake.warning, fin.out);
  const w = logLines(log);
  assert.equal(w.length, 1, JSON.stringify(w));
  assert.deepEqual(w[0].leases, [], 'no lease held while writing the page');
  assert.ok(existsSync(VIEW(d)));
});

test('finish with the default published page: written in the intake product commit under the merge lease, refreshed once after it, nothing left uncommitted', () => {
  const { d, run } = finishedSprint({});
  const log = join(mkdtempSync(join(tmpdir(), 'vw-')), 'writes.jsonl');
  const fin = dw(d, ['finish', run], { DWMT_VIEW_LOG: log });
  assert.equal(fin.json?.status, 'squashed', fin.out);
  assert.ok(fin.json.intake && !fin.json.intake.warning, fin.out);
  const w = logLines(log);
  assert.equal(w.length, 2, JSON.stringify(w));
  for (const x of w) assert.ok(x.file.replace(/\\/g, '/').endsWith('docs/product/roadmap.html'), x.file);
  assert.ok(w[0].leases.includes(mergeKey(d, 'master').key), JSON.stringify(w[0].leases));
  assert.deepEqual(w.at(-1).leases, [], 'the refresh after the lease holds no lease');
  const g = gitIn(d);
  assert.equal(g('log', '-1', '--format=%s').trim(), `product: intake ${run}`);
  assert.ok(g('show', '--name-only', '--format=', 'HEAD').split('\n').map((l) => l.trim()).includes('docs/product/roadmap.html'));
  assert.equal(g('status', '--porcelain', '--', 'docs/product').trim(), '');
});

test('uat record of several sprints: one page write for the batch, outside the merge lease', () => {
  const d = repo();
  const g = gitIn(d);
  // The off path (page under .dwmt/): a published page is also written inside each product commit, under the lease.
  config(d, { product: { view: { publish: null } }, git: { target: 'master' } });
  assert.equal(pr(d, 'init', '--goal', 'g').code, 0);
  g('add', '-A'); g('commit', '-q', '-m', 'p');
  const mk = (id, sp) => {
    const dir = join(d, '.dwmt', 'runs', id);
    write(d, `.dwmt/runs/${id}/run.json`, JSON.stringify({ schema: 'dwmt/run@1', run: id, spec: sp, target: 'master', mode: 'single', created: new Date().toISOString(), session_ids: [], tasks: [], finish: { status: 'squashed', commit: g('rev-parse', '--short=10', 'HEAD'), uat: 'pending' } }));
    writeFileSync(join(dir, 'final-report.md'), `${header({ schema: 'dwmt/final-report@1', run: id, scope: ['src/**'], uat: 'pending' })}# R\n\n## UAT\n1. x\n`);
  };
  mk('r-a', 's-1');
  mk('r-b', 's-2');
  const res = join(mkdtempSync(join(tmpdir(), 'uat-')), 'res.json');
  writeFileSync(res, JSON.stringify({ result: 'positive', findings: [], deferredAccepted: [] }));
  const log = join(mkdtempSync(join(tmpdir(), 'vw-')), 'writes.jsonl');
  const u = dw(d, ['uat', 'record', 's-1', 's-2', res, '--late'], { DWMT_VIEW_LOG: log });
  assert.equal(u.json?.ok, true, u.out);
  assert.equal(u.json.intake.length, 2, u.out);
  const w = logLines(log);
  assert.equal(w.length, 1, JSON.stringify(w));
  assert.deepEqual(w[0].leases, []);
});

test('2026-10-15 F5: sprint w toku zatrzymany przez sterownik albo z pytaniem jest oznaczony w widoku i w brief', () => {
  const d = project();
  write(d, '.dwmt/supervisor/supervisor.json', JSON.stringify({ items: [{ id: 's-run', state: 'stopped', reason: 'child-dead: komenda `dwmt state` zakończyła się bez wyniku\nszczegóły' }] }));
  write(d, '.dwmt/supervisor/status/s-ord.json', JSON.stringify({ sprint: 's-ord', state: 'waiting-user', questions: ['Q-1 Old PDF generator'] }));
  const S = Object.fromEntries(viewModel(ctx(d)).sprints.map((s) => [s.id, s]));
  assert.deepEqual(S['s-run'].halt, { kind: 'stopped', reason: 'child-dead: komenda `dwmt state` zakończyła się bez wyniku' });
  assert.deepEqual(S['s-ord'].halt, { kind: 'waiting', reason: 'Q-1 Old PDF generator' });
  assert.equal(S['s-todo'].halt, null);
  const b = pr(d, 'brief');
  assert.match(b.out, /running s-run \(stopped: child-dead: komenda `dwmt state`/);
});

test('2026-10-16: the live writer rebuilds a page built before a dwmt update (template newer than index.html, no live.js), 0 tokens; a fresh page stays', async () => {
  const { liveLoop } = await import('../scripts/lib/live.mjs');
  const d = repo();
  config(d, { git: { target: 'master' }, product: { view: { publish: null } } });
  assert.equal(pr(d, 'init', '--goal', 'Pilot').code, 0);
  assert.equal(pr(d, 'view').code, 0);
  const f = VIEW(d);
  writeFileSync(f, '<html>page from before the live view</html>');
  utimesSync(f, new Date('2020-01-01'), new Date('2020-01-01'));
  const tr = mkdtempSync(join(tmpdir(), 'dwmt-tr-'));
  await liveLoop(d, { interval: 0.05, maxPolls: 1, transcripts: tr });
  assert.match(readFileSync(f, 'utf8'), /id="dwmt-data"/, 'page rebuilt');
  writeFileSync(f, 'fresh page');
  await liveLoop(d, { interval: 0.05, maxPolls: 1, transcripts: tr });
  assert.equal(readFileSync(f, 'utf8'), 'fresh page');
});

test('live writer with the default page: an old docs/product/roadmap.html is rebuilt, a fresh one stays; an old .dwmt page is not a trigger (D-5, R-6)', async () => {
  const { liveLoop } = await import('../scripts/lib/live.mjs');
  const d = repo();
  config(d, { git: { target: 'master' } });
  assert.equal(pr(d, 'init', '--goal', 'Pilot').code, 0);
  assert.equal(pr(d, 'view').code, 0);
  const f = join(d, 'docs', 'product', 'roadmap.html');
  assert.ok(existsSync(f));
  const old = new Date('2020-01-01');
  writeFileSync(f, '<html>page from before the update</html>');
  utimesSync(f, old, old);
  const tr = mkdtempSync(join(tmpdir(), 'dwmt-tr-'));
  await liveLoop(d, { interval: 0.05, maxPolls: 1, transcripts: tr });
  assert.match(readFileSync(f, 'utf8'), /id="dwmt-data"/, 'published page rebuilt');
  writeFileSync(f, 'fresh page');
  write(d, '.dwmt/product/view/index.html', 'old .dwmt page');
  utimesSync(VIEW(d), old, old);
  await liveLoop(d, { interval: 0.05, maxPolls: 1, transcripts: tr });
  assert.equal(readFileSync(f, 'utf8'), 'fresh page');
  assert.equal(readFileSync(VIEW(d), 'utf8'), 'old .dwmt page');
});
