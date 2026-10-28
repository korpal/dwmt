import './tmp-root.mjs';
// Product layer: live sprint view on the product page (spec warstwy produktowej §3.11): page data for polling, the page
// polls `live.js` by script re-injection (no network APIs), and renders a contract-v1 snapshot in every status. The page
// logic runs here in a vm with a minimal fake DOM; real-browser behaviour is checked by hand (build note).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Script, createContext } from 'node:vm';
import { repo, gitIn } from './helpers.mjs';
import { pr, write, config } from './product-helpers.mjs';
import { loadConfig } from '../scripts/lib/config.mjs';
import { productConfig } from '../scripts/lib/product-config.mjs';
import { paths, renderRoadmap, renderIndex } from '../scripts/lib/product-store.mjs';
import { createHash } from 'node:crypto';
import { viewModel, renderHtml } from '../scripts/lib/product-view.mjs';
import { STEP_KEYS, FEED_KEYS, NOTE_KEYS } from '../scripts/lib/live.mjs';

const ctx = (d) => { const cfg = loadConfig(d); const pc = productConfig(d, cfg); return { top: d, cfg, pc, P: paths(d, pc) }; };
const spec = (id, h, body) => `---\n${Object.entries({ schema: 'dwmt/sprint-spec@1', id, kind: 'feature', items: [], touch: [], refs: [], ...h }).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n\n${body}`;
const L = (id, state, goal) => ({ id, state, goal, after: [], detail: state === 'topic' ? 'none' : `sprints/${id}.md`, alias: null, current: false });

function project(cfg = {}) {
  const d = repo();
  config(d, { git: { target: 'master' }, language: 'pl', ...cfg });
  assert.equal(pr(d, 'init').code, 0);
  const W = (f, t) => write(d, `docs/product/${f}`, t);
  W('roadmap.md', renderRoadmap([L('s-run', 'running', 'Import of price lists'), L('s-todo', 'todo', 'Client export'), L('s-notes', 'notes', 'Offline sync')]));
  W('sprints/s-run.md', spec('s-run', { run: 'r-run' }, '## Goal\nImport price lists.\n\n## For you\nTitle: Import cenników\nWhy: Cenniki wchodzą z pliku.\n'));
  W('sprints/s-todo.md', spec('s-todo', {}, '## Goal\nClient export.\n\n## Acceptance\n- AC-1 Export works\n'));
  W('sprints/s-notes.md', spec('s-notes', {}, '## Goal\nOffline sync.\n'));
  gitIn(d)('add', '-A');
  gitIn(d)('commit', '-q', '-m', 'product');
  return d;
}

// The page script in a vm: just enough DOM for render() and the live code; timers are not started.
// Listeners the page adds on `document` are kept by type; `click(dataset)` calls the click listener with a target whose
// closest() is an element with that dataset. `ls` is the fake localStorage.
function loadPage(html, { lang = null, timers = null, unit = null } = {}) {
  const data = /<script type="application\/json" id="dwmt-data">([\s\S]*?)<\/script>/.exec(html)[1];
  const js = /<script>\n([\s\S]*?)\n<\/script>/.exec(html)[1];
  const els = {}, appended = [], listeners = {};
  const el = () => ({ innerHTML: '', textContent: '', style: {}, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {}, remove() {}, focus() {}, querySelector: () => null, querySelectorAll: () => [] });
  const ls = new Map([...(lang ? [['dwmt-view:lang', lang]] : []), ...(unit ? [['dwmt-view:unit', unit]] : [])]);
  const document = {
    hidden: false, documentElement: {}, body: { classList: { add() {}, remove() {} }, insertAdjacentHTML() {} }, head: { appendChild: (x) => appended.push(x) },
    getElementById: (id) => (id === 'dwmt-data' ? { textContent: data } : id === 'dwmt-live' || id === 'modal-wrap' ? null : (els[id] ??= el())),
    createElement: () => el(), addEventListener: (type, fn) => (listeners[type] ??= []).push(fn), querySelector: () => null, querySelectorAll: () => [],
  };
  const sb = { document, localStorage: { getItem: (k) => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, v) }, location: { hash: '' }, history: { replaceState() {} },
    setTimeout: (fn, ms) => (timers ? timers.push([fn, ms]) : 0), clearTimeout() {}, setInterval: () => 0, requestAnimationFrame() {}, innerWidth: 1440, innerHeight: 900, console, addEventListener() {} };
  sb.window = sb;
  createContext(sb);
  new Script(js).runInContext(sb);
  const click = (dataset) => {
    if (!listeners.click?.length) throw new Error('the page registered no click listener on document');
    const target = { closest: () => ({ dataset, classList: { contains: () => false } }) };
    for (const fn of listeners.click) fn({ target, stopPropagation() {}, preventDefault() {} });
  };
  return { V: sb.DWMT_VIEW, live: sb.DWMT_VIEW.live, els, appended, ls, click };
}

const M = 60e3;
const iso = (ago) => new Date(Date.now() - ago).toISOString();
let tick = 0;
// Contract v1 snapshot with one run of s-run in the given situation.
function snap(kind, { writtenAgo = 1000, writer = 'alive', intervalSec = 5, extra = [] } = {}) {
  const ask = kind === 'waiting-user';
  const steps = kind === 'red'
    ? [{ key: 'implement', state: 'done', min: 22 }, { key: 'verify', state: 'bad', note: { key: 'tests-red', red: 2, total: 50 } }, { key: 'fix', state: 'run', note: { key: 'attempt', n: 1 } }]
    : ask ? [{ key: 'implement', state: 'wait', note: { key: 'waiting-user' } }, { key: 'verify', state: 'todo' }]
      : [{ key: 'implement', state: 'done', min: 22 }, { key: 'verify', state: 'done', note: { key: 'tests-green', passed: 48 } }, { key: 'review', state: 'run', note: null }];
  const status = kind === 'red' || kind === 'stale' ? 'work' : kind;
  return {
    v: 1, writtenAt: new Date(Date.now() - writtenAgo + ++tick).toISOString(), intervalSec, writer, language: 'pl', unknownTop: { a: 1 },
    runs: [{
      run: 'r-run', sprint: 's-run', goal: 'Import of price lists', mode: 'single', startedAt: iso(90 * M), branch: 'dwmt/s-run', tree: '/work/repo/.claude/worktrees/s-run',
      status, since: iso(kind === 'stall' ? 34 * M : 12 * M), reason: kind === 'stall' ? 'reviewer exited' : null, step: { key: ask ? 'ask' : kind === 'red' ? 'fix' : 'review', task: 3 },
      tasks: [
        { k: 1, title: 'Read the file', titleTr: 'Odczyt pliku', state: 'done', startedAt: iso(60 * M), endedAt: iso(40 * M), costM: 0.9, commit: '3f9a1c2', note: { key: 'review-clean' }, steps: [] },
        { k: 2, title: 'Save rows', titleTr: 'Zapis wierszy', state: 'done', startedAt: iso(40 * M), endedAt: iso(20 * M), costM: 1.1, commit: '8b04e7d', note: { key: 'odd-note' }, steps: [] },
        { k: 3, title: 'Preview window', titleTr: null, state: ask ? 'wait' : 'run', startedAt: iso(20 * M), costM: 0.5, steps },
        { k: 4, title: 'Report', titleTr: 'Raport', state: 'todo' }, { k: 5, title: 'End-to-end tests', titleTr: 'Testy end-to-end', state: 'todo' },
      ],
      pre: [{ key: 'plan', state: 'done', startedAt: iso(90 * M), endedAt: iso(60 * M), costM: 1.4, note: { key: 'plan-ready', tasks: 5, questions: 1 } }],
      post: [{ key: 'batch', state: 'todo', note: { key: 'deferred', n: 2 } }, { key: 'deploy', state: 'todo' }],
      questions: ask ? ['Czy pominąć błędny wiersz?', 'Czy nadpisać stare zamówienie?'] : [],
      cost: { spentM: 4.3, priceM: [9, 14], priceBasis: 'design', forecastM: 10.8, byRole: { plan: 1.4, exec: 1.6 } },
      eta: new Date(Date.now() + 60 * M).toISOString(),
      feed: [{ at: iso(5e3), who: 'reviewer', kind: 'read', text: 'src/orders/Import.tsx', important: false },
        { at: iso(9e3), who: 'script', kind: 'event', text: '', key: 'tests-green', params: { task: 3, passed: 48 }, important: true },
        { at: iso(20e3), who: 'robot', kind: 'event', key: 'some-new-event', params: {}, important: false }],
    }, ...extra],
  };
}
const panelHtml = (live, id) => { const p = live.panel(id); return `${p.head}${p.main}${p.side}`; };

// History and the From you list: two archived sprints (s-old with lines, s-old2 without) and s-todo2 with user and architect questions.
function histProject(questions = ['[decision-maker] Which export format?', '[architect] Pick the parser.', 'Keep the old links?']) {
  const d = project();
  const W = (f, t) => write(d, `docs/product/${f}`, t);
  W('archive/index.md', renderIndex([
    { id: 's-old', goal: 'Old export', merged: '2026-10-01', run: 'r-1', files: 10, tokensM: 2, lines: 400 },
    { id: 's-old2', goal: 'Small fix', merged: '2026-10-05', run: 'r-2', files: 4, tokensM: 2 },
  ]));
  W('archive/s-old.md', spec('s-old', { actual: { files: 10, tokens: 2, lines: 400, uat: 'n/a' } }, '## Goal\nOld export.\n'));
  W('archive/s-old2.md', spec('s-old2', { actual: { files: 4, tokens: 2, uat: 'n/a' } }, '## Goal\nSmall fix.\n'));
  W('roadmap.md', renderRoadmap([L('s-run', 'running', 'Import of price lists'), L('s-todo', 'todo', 'Client export'), L('s-todo2', 'todo', 'Discount list in invoices'), L('s-notes', 'notes', 'Offline sync')]));
  W('sprints/s-todo2.md', spec('s-todo2', {}, `## Goal\nDiscounts in invoices.\n\n## Open questions\n${questions.map((q) => `- ${q}\n`).join('')}`));
  return d;
}
const fakeEl = () => ({ clientWidth: 600, innerHTML: '' });
const dots = (h) => (h.match(/class="dot"/g) ?? []).length;
// Plotted values of the cost chart SVG: dots (sprint order), extreme label, median line and median label.
function chartNums(h) {
  const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v]));
  const num = (o, ...ks) => Object.fromEntries(ks.map((k) => [k, Number(o[k])]));
  const text = (cls) => { const m = new RegExp(`<text class="${cls}"([^>]*)>([^<]*)</text>`, 'g'); return [...h.matchAll(m)].map(([, a, tx]) => ({ text: tx, ...num(attrs(a), 'x', 'y') })); };
  return {
    dots: [...h.matchAll(/<circle class="dot"[^>]*>/g)].map(([tag]) => num(attrs(tag), 'cx', 'cy')),
    val: text('val'), mlbl: text('mlbl'),
    median: [...h.matchAll(/<line class="median"[^>]*>/g)].map(([tag]) => num(attrs(tag), 'x1', 'x2', 'y1', 'y2')),
  };
}
// Deep comparison where numbers match within 1e-6 (the page prints floating-point output such as 122.39999999999999).
function near(actual, expected, path = 'value') {
  if (typeof expected === 'number') return assert.ok(Math.abs(actual - expected) < 1e-6, `${path}: ${actual} != ${expected}`);
  if (expected && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual ?? {}).sort(), Object.keys(expected).sort(), `${path}: keys`);
    for (const k of Object.keys(expected)) near(actual[k], expected[k], `${path}.${k}`);
    return;
  }
  assert.equal(actual, expected, path);
}
// The "From you" box of the card (no nested div inside).
const youBlock = (main) => /<div class="hp-box you[^"]*you-m">[\s\S]*?<\/div>/.exec(main)?.[0] ?? '';

test('live view: page data (live flag, liveIntervalSec); one file; polling by classic script re-injection, no network APIs or modules', () => {
  const D = viewModel(ctx(project()));
  assert.deepEqual(D.live, { enabled: true, intervalSec: 5 });
  assert.equal(D.sprints.find((s) => s.id === 's-run').run, 'r-run', 'run id of the sprint for matching');
  const d2 = project({ product: { view: { live: false, liveIntervalSec: 2 } } });
  assert.deepEqual(viewModel(ctx(d2)).live, { enabled: false, intervalSec: 2 });

  const d = project({ product: { view: { liveIntervalSec: 3 } } });
  const out = join(mkdtempSync(join(tmpdir(), 'view-live-')), 'index.html');
  assert.equal(pr(d, 'view', '--out', out).code, 0);
  const html = readFileSync(out, 'utf8');
  assert.equal((html.match(/<\/script>/g) ?? []).length, 2, 'still one file: data and code blocks only');
  assert.doesNotMatch(html, /(?:src|href)\s*=\s*["']?(?:https?:)?\/\/|url\(\s*["']?(?:https?:)?\/\/|@import|<link\b|<script\s+src/i);
  const js = /<script>\n([\s\S]*?)\n<\/script>/.exec(html)[1];
  for (const s of ["createElement('script')", "'live.js?t='", 'window.__dwmtLive', 'visibilitychange', 'document.hidden']) assert.ok(js.includes(s), s);
  assert.doesNotMatch(js, /\bfetch\b|XMLHttpRequest|type\s*=\s*["']?module|\bimport\s*\(\s*['"`]/);
  // Loading the page starts one poll at once: a classic script next to the page, cache-busted.
  const { appended } = loadPage(html);
  assert.equal(appended.length, 1);
  assert.match(appended[0].src, /^live\.js\?t=\d+$/);
  assert.equal(appended[0].type, undefined);
  // live: false → no polling at all.
  const off = join(mkdtempSync(join(tmpdir(), 'view-live-')), 'index.html');
  assert.equal(pr(d2, 'view', '--out', off).code, 0);
  assert.equal(loadPage(readFileSync(off, 'utf8')).appended.length, 0);
});

test('live view: each status renders on the board card and in the sprint card (PL strings, translated task titles with one EN mark, EN mode)', () => {
  const html = renderHtml(viewModel(ctx(project())));
  const { live } = loadPage(html);
  const now = () => Date.now();
  const R = () => live.state().by['s-run'];

  live.take(snap('work'));
  let h = panelHtml(live, 's-run');
  assert.equal(live.indState(R(), now())[0], 'work');
  assert.match(live.indState(R(), now())[1], /^na żywo · \d+ s temu$/);
  assert.match(live.card(R(), now()), /Zadanie 3 z 5 · Recenzja[\s\S]*4,3 \/ 9–14 mln[\s\S]*class="live work"/);
  assert.match(live.card(R(), now()), /class="segs"[^>]*aria-label="zadania: 2 z 5 gotowe"><span class="done"><\/span><span class="done"><\/span><span class="run"><\/span><span class=""><\/span>/);
  for (const s of ['Cenniki wchodzą z pliku.', 'Postęp', 'Odczyt pliku', 'Preview window', 'Co się dzieje', 'Recenzent', 'czyta', 'src/orders/Import.tsx', 'Skrypt', 'zadanie 3: komendy testów zielone (48)',
    'Some new event', 'Robot', 'Odd note', 'Deploy', 'zadania: 5 · pytania: 1', 'drobne uwagi odłożone do końca: 2', '✓ Pisanie kodu · 22 min', 'komendy testów zielone: 48', 'Nic teraz. Następny raz: przegląd po scaleniu (prognoza',
    'Koszt', '9–14 mln', 'Prognoza z tempa zadań', '✓ w cenie startu', 'Koniec (prognoza)', 'Szczegóły techniczne przebiegu', '/work/repo/.claude/worktrees/s-run', 'plan 1,4 · pisanie 1,6 mln', 'data-lv-part="feed"']) assert.ok(h.includes(s), s);
  assert.equal((h.match(/class="en-badge"/g) ?? []).length, 1, 'one EN mark for the untranslated task title (Progress block)');
  assert.doesNotMatch(h, /class="alert/);

  live.take(snap('waiting-user'));
  h = panelHtml(live, 's-run');
  assert.equal(live.indState(R(), now())[0], 'wait');
  assert.match(live.indState(R(), now())[1], /^czeka na Ciebie · 12 min$/);
  assert.match(live.card(R(), now()), /Zadanie 3 z 5 · Pytanie od wykonawcy[\s\S]*czeka na Ciebie · 12 min/);
  assert.equal((live.card(R(), now()).match(/czeka na Ciebie/gi) ?? []).length, 1, 'said once: the indicator');
  for (const s of ['hp-box you ask', 'Czekają pytania: 2, od 12 min.', 'praca nad zadaniem 3 stoi', '<li>Czy pominąć błędny wiersz?</li>', 'po Twojej odpowiedzi', '! Pisanie kodu · czeka na Ciebie']) assert.ok(h.includes(s), s);

  live.take(snap('red'));
  h = panelHtml(live, 's-run');
  for (const s of ['alert info', 'Czerwone testy w zadaniu 3', 'Nie przechodzi 2 z 50 komend testów', '<span class="bad">✗ Testy · 2 z 50 komend testów nie przechodzi</span>', 'Poprawki · próba 1']) assert.ok(h.includes(s), s);

  live.take(snap('stall'));
  h = panelHtml(live, 's-run');
  assert.equal(live.indState(R(), now())[0], 'stall');
  for (const s of ['alert bad', 'Prawdopodobnie przestój', 'Nic nie pracuje od 34 min; sprint stoi na: Zadanie 3 z 5 · Recenzja', 'co ze sprintem s-run?', 'reviewer exited']) assert.ok(h.includes(s), s);

  live.take(snap('stale', { writtenAgo: 5 * M }));
  live.apply(true);
  h = panelHtml(live, 's-run');
  assert.equal(live.indState(R(), now())[0], 'stale');
  for (const s of ['alert mute', 'Strona nie dostaje nowych danych od 5 min', 'brak świeżych danych od 5 min']) assert.ok(h.includes(s), s);

  live.take(snap('waiting-user', { writtenAgo: 3 * 3600e3, writer: 'ended' }));
  live.apply(true);
  h = panelHtml(live, 's-run');
  assert.equal(live.indState(R(), now())[0], 'wait');
  assert.doesNotMatch(h, /alert mute/);

  // EN mode: UI in English, English task titles, no EN marks.
  const en = loadPage(html, { lang: 'en' }).live;
  en.take(snap('work'));
  const e = panelHtml(en, 's-run');
  for (const s of ['Progress', 'Read the file', 'What&#39;s happening', 'Reviewer', 'reads', 'Nothing now. Next time: the review after the merge (forecast', 'within the start price']) assert.ok(e.includes(s), s);
  assert.doesNotMatch(e, /Odczyt pliku|en-badge/);
  assert.match(en.card(en.state().by['s-run'], Date.now()), /Task 3 of 5 · Review[\s\S]*live · \d+ s ago/);
});

test('live view: stale rule — max(3 × interval, 20 s) while a live writer reports work; waiting-user or an ended writer never goes stale', () => {
  const { live } = loadPage(renderHtml(viewModel(ctx(project()))));
  const at = (kind, o) => { live.take(snap(kind, o)); return live.isStale(Date.now()); };
  assert.equal(at('work', { writtenAgo: 2000 }), false);
  assert.equal(at('work', { writtenAgo: 25e3, intervalSec: 5 }), true, '20 s floor');
  assert.equal(at('work', { writtenAgo: 25e3, intervalSec: 10 }), false, '3 × 10 s');
  assert.equal(at('work', { writtenAgo: 35e3, intervalSec: 10 }), true);
  assert.equal(at('waiting-user', { writtenAgo: 3600e3 }), false);
  assert.equal(at('stall', { writtenAgo: 3600e3 }), false);
  assert.equal(at('work', { writtenAgo: 3600e3, writer: 'ended' }), false, 'ended: no stale warning');
  live.apply(true);
  assert.equal(live.indState(live.state().by['s-run'], Date.now())[0], 'stale', 'an ended writer that left a run in work shows no fresh data');
  assert.equal(at('done', { writtenAgo: -1000, writer: 'ended' }), false, 'written after the page was generated');
  live.apply(true);
  assert.equal(live.indState(live.state().by['s-run'], Date.now())[0], 'done');
});

test('live view: runs on the board — a To do sprint with a live run moves to In progress, a run without a sprint gets its own card, a finished run older than the page is ignored; partial snapshots tolerated', () => {
  const { live } = loadPage(renderHtml(viewModel(ctx(project()))));
  const col = (html, c) => new RegExp(`<section class="col c-${c}"[\\s\\S]*?</section>`).exec(html)[0];
  const other = (o) => ({ run: 'r-x', sprint: null, goal: 'Quick fix of totals', status: 'work', startedAt: iso(5 * M), step: { key: 'implement', task: 1 }, tasks: [{ k: 1, title: 'Fix', state: 'run' }], feed: null, ...o });
  live.take(snap('work', { extra: [{ ...other(), run: 'r-todo', sprint: 's-todo', goal: 'Client export' }, other()] }));
  let b = live.board();
  assert.match(col(b, 'inprogress'), /data-open="s-run"[\s\S]*data-lv-slot="s-run"/);
  assert.match(col(b, 'inprogress'), /data-open="s-todo"[\s\S]*data-lv-slot="s-todo"/);
  assert.doesNotMatch(col(b, 'todo'), /data-open="s-todo"/);
  assert.match(col(b, 'inprogress'), /data-open="r-x"[\s\S]*Quick fix of totals[\s\S]*Zadanie 1 z 1 · Pisanie kodu/);
  assert.match(panelHtml(live, 'r-x'), /Quick fix of totals[\s\S]*Postęp/);
  assert.doesNotMatch(panelHtml(live, 'r-x'), /Co się dzieje/);
  // A run that finished before this page was generated: the page's own data wins.
  live.take({ v: 1, writtenAt: new Date(Date.now() - 3600e3).toISOString(), writer: 'ended', runs: [{ ...other(), run: 'r-todo', sprint: 's-todo', status: 'done' }] });
  b = live.board();
  assert.match(col(b, 'todo'), /data-open="s-todo"/);
  assert.doesNotMatch(b, /data-lv-slot/);
  // Partial and odd snapshots never throw; missing fields mean less UI.
  const odd = { v: 2, writtenAt: new Date().toISOString(), runs: [{ sprint: 's-run' }, null, 'x', 7, { run: 'r-y', status: 'work', tasks: [null, {}, { state: 'zzz', steps: [null, { key: 'mystery', state: 'odd' }] }],
    pre: 'no', post: null, feed: [null, {}, { kind: 'event' }], cost: { spentM: 'a', priceM: [1] }, step: 'x', questions: [1, null], eta: 'not a date' }] };
  assert.doesNotThrow(() => { live.take(odd); live.apply(true); live.board(); panelHtml(live, 's-run'); panelHtml(live, 'r-y'); });
  assert.match(panelHtml(live, 'r-y'), /Postęp/);
  assert.doesNotThrow(() => { live.take({ writtenAt: 'x', runs: 'none' }); live.take(null); live.take('junk'); live.apply(false); });
});

test('live view: every step, feed and note key of the writer has a PL and an EN string', () => {
  const { strings } = loadPage(renderHtml(viewModel(ctx(project())))).live;
  const missing = [];
  for (const [pre, keys] of [['lv_s_', STEP_KEYS], ['lv_e_', FEED_KEYS], ['lv_o_', NOTE_KEYS]]) {
    for (const k of keys) for (const l of ['pl', 'en']) if (typeof strings[l][pre + k] !== 'string') missing.push(`${l} ${pre}${k}`);
  }
  assert.deepEqual(missing, []);
});

test('live view: planned run, finished run without a forecast, script-logged red tests with the task, merge into the target branch', () => {
  const { live } = loadPage(renderHtml(viewModel(ctx(project()))));
  const R = () => live.state().by['s-run'];
  const base = snap('work');
  const run0 = base.runs[0];
  live.take({ ...base, runs: [{ ...run0, status: 'planned', waitingFor: ['s-2', 's-3'], step: { key: 'planned', task: null }, eta: null }] });
  let h = panelHtml(live, 's-run');
  assert.match(live.card(R(), Date.now()), /Plan gotowy, czeka na scalenie: s-2, s-3[\s\S]*class="live mw"[\s\S]*w kolejce/);
  assert.ok(h.includes('Plan gotowy, czeka na scalenie: s-2, s-3.'));
  assert.doesNotMatch(h, /Zapytaj PO|zatrzymany/);
  live.take({ ...snap('work', { writtenAgo: -1000 }), runs: [{ ...run0, status: 'done', since: iso(M), target: 'main', post: [{ key: 'finish', state: 'done' }],
    feed: [{ at: iso(5e3), who: 'script', kind: 'event', key: 'tests-red', params: { task: 4, red: 2, n: 2 }, important: true }, { at: iso(6e3), who: 'script', kind: 'event', key: 'tests-red', params: { task: null, red: 1 }, important: true }] }] });
  h = panelHtml(live, 's-run');
  assert.match(live.card(R(), Date.now()), /Scalono z main[\s\S]*class="live done"/);
  for (const s of ['zakończony', 'Scalenie: pełne testy i połączenie z main', 'zadanie 4: komendy testów nie przechodzą (2)', 'komendy testów nie przechodzą']) assert.ok(h.includes(s), s);
  for (const s of ['Prognoza z tempa zadań', 'Koniec (prognoza)', 'prognoza']) assert.ok(!h.includes(s), s);
});

test('live view: in-place updates replace a part only when its markup changed (clock texts change as text); a missing live.js backs off to 60 s', () => {
  const { live } = loadPage(renderHtml(viewModel(ctx(project()))));
  let sets = 0, html = '';
  const spans = [{ textContent: '' }, { textContent: '' }];
  const el = { get innerHTML() { return html; }, set innerHTML(v) { sets++; html = v; spans[0].textContent = /<span class="lv-t">([^<]*)/.exec(v)?.[1] ?? ''; }, querySelectorAll: () => spans.slice(0, 1) };
  live.put(el, '<b>x</b><span class="lv-t">3 s</span>');
  live.put(el, '<b>x</b><span class="lv-t">4 s</span>');
  assert.deepEqual([sets, spans[0].textContent], [1, '4 s']);
  live.put(el, '<b>x</b><span class="lv-t">4 s</span>');
  assert.equal(sets, 1);
  live.put(el, '<b>y</b><span class="lv-t">4 s</span>');
  assert.equal(sets, 2);
  // Polling: each missing live.js doubles the wait (interval 5 s) up to 60 s; a load goes back to the interval.
  const timers = [];
  const pg = loadPage(renderHtml(viewModel(ctx(project()))), { timers });
  const waits = [];
  for (let i = 0; i < 6; i++) { pg.appended.at(-1).onerror(); waits.push(timers.at(-1)[1]); timers.at(-1)[0](); }
  pg.appended.at(-1).onload();
  waits.push(timers.at(-1)[1]);
  assert.deepEqual(waits, [10e3, 20e3, 40e3, 60e3, 60e3, 60e3, 5e3]);
});

test('history and From you strings exist in PL and EN', () => {
  const { strings } = loadPage(renderHtml(viewModel(ctx(project())))).live;
  const keys = ['k_perLine', 'k_linesOf', 'c_lines', 'c_perLine', 'ch2l', 'ch2ls', 'u_file', 'u_line', 'perLineShort', 'linesN', 'noLines', 'tys', 'you_answersList'];
  const missing = [];
  for (const k of keys) for (const l of ['pl', 'en']) if (typeof strings[l][k] !== 'string') missing.push(`${l} ${k}`);
  assert.deepEqual(missing, []);
});

test('history: per-line tile, columns, chart and switch (a sprint without lines shows "—" and is left out of the per-line median and line chart)', () => {
  const d = histProject();
  const D = viewModel(ctx(d));
  assert.deepEqual(D.history.map((h) => [h.id, h.lines, h.perLineK, h.perFile]), [['s-old', 400, 5, 0.2], ['s-old2', null, null, 0.5]]);
  const html = renderHtml(D);
  const { V } = loadPage(html);
  const H = V.history, rows = V.data.history;
  // KPI tile: median over the sprints with lines only (1 of 2), per-file tile unchanged.
  const k = H.kpis(rows);
  for (const s of ['Koszt na zmienioną linię', '5 tys.', 'mediana; linie znane w 1 z 2', 'Koszt na zmieniony plik', '0,35 mln']) assert.ok(k.includes(s), s);
  assert.equal((k.match(/class="kpi"/g) ?? []).length, 5);
  const ken = loadPage(html, { lang: 'en' }).V.history.kpis(rows);
  for (const s of ['Cost per changed line', '5 k', 'median; lines known for 1 of 2']) assert.ok(ken.includes(s), s);
  // Table: lines and per-line columns, "—" for the sprint without lines.
  const tb = H.table(rows);
  for (const s of ['<th class="r">Linie</th>', '<th class="r">Na linię (tys.)</th>', '<td class="r num">400</td>', '<td class="r num">5</td>']) assert.ok(tb.includes(s), s);
  const old2 = /<tr data-open="s-old2">[\s\S]*?<\/tr>/.exec(tb)[0];
  assert.equal((old2.match(/<td class="r num">—<\/td>/g) ?? []).length, 2, 'lines and per line unknown');
  assert.ok(old2.includes('<td class="r num">0,5</td>'), 'per file stays');
  // Columns chart: lines in the tooltips.
  let el = fakeEl();
  H.columns(el, rows);
  assert.ok(el.innerHTML.includes('400 linii') && el.innerHTML.includes('— linii'), el.innerHTML);
  // Cost chart, file mode (default): per file and lines in the tooltip, both sprints.
  el = fakeEl();
  H.chart(el, rows);
  assert.ok(el.innerHTML.includes('/ plik') && el.innerHTML.includes('400 linii') && el.innerHTML.includes('— linii'));
  assert.equal(dots(el.innerHTML), 2);
  // Plotted values (W 592, plot x 40..520, y 18..192, scale max 0.5): per file 0.2 then 0.5, median 0.35.
  near(chartNums(el.innerHTML), {
    dots: [{ cx: 160, cy: 122.4 }, { cx: 400, cy: 18 }],
    val: [{ text: '0,5', x: 400, y: 10 }],
    median: [{ x1: 40, x2: 520, y1: 70.2, y2: 70.2 }],
    mlbl: [{ text: 'mediana 0,35', x: 524, y: 74.2 }],
  }, 'file chart');
  let page = H.html();
  for (const s of ['id="ch2card"', 'class="card-head"', 'data-unit="file" class="on" aria-pressed="true"', 'data-unit="line" class="" aria-pressed="false"', '>na plik<', '>na linię<', '<h3>Koszt na zmieniony plik</h3>', 'mln tokenów na plik']) assert.ok(page.includes(s), s);
  // Line mode: only the sprint with lines, per-line tooltip.
  H.setUnit('line');
  el = fakeEl();
  H.chart(el, rows);
  assert.ok(el.innerHTML.includes('5 tys. / linię') && el.innerHTML.includes('400 linii'), el.innerHTML);
  assert.ok(!el.innerHTML.includes('s-old2'), 'the sprint without lines is not plotted');
  assert.equal(dots(el.innerHTML), 1);
  assert.ok(el.innerHTML.includes('aria-label="Koszt na zmienioną linię"'));
  // Plotted values (one point, 5 thousand tokens per line, scale max 5): the point is the extreme and the median.
  near(chartNums(el.innerHTML), {
    dots: [{ cx: 280, cy: 18 }],
    val: [{ text: '5', x: 280, y: 10 }],
    median: [{ x1: 40, x2: 520, y1: 18, y2: 18 }],
    mlbl: [{ text: 'mediana 5', x: 524, y: 22 }],
  }, 'line chart');
  page = H.html();
  for (const s of ['<h3>Koszt na zmienioną linię</h3>', 'tys. tokenów na linię', 'data-unit="line" class="on" aria-pressed="true"']) assert.ok(page.includes(s), s);
  el = fakeEl();
  H.chart(el, rows.map((r) => ({ ...r, lines: null, perLineK: null })));
  assert.ok(el.innerHTML.includes('Brak sprintów z liczbą linii w tym okresie.'));
  assert.equal(dots(el.innerHTML), 0);
  // No row with lines: the tile shows "—".
  assert.match(H.kpis(rows.map((r) => ({ ...r, lines: null, perLineK: null }))), /Koszt na zmienioną linię<\/div><div class="value">—<\/div>[\s\S]*?mediana; linie znane w 0 z 2/);
  // The choice is remembered by the page.
  assert.ok(loadPage(html, { unit: 'line' }).V.history.html().includes('<h3>Koszt na zmienioną linię</h3>'));
  assert.ok(loadPage(html).V.history.html().includes('<h3>Koszt na zmieniony plik</h3>'));
});

test('history: the file-or-line switch click stores the choice and redraws only the chart card', () => {
  const html = renderHtml(viewModel(ctx(histProject())));
  const { els, ls, click } = loadPage(html);
  els.ch2 = fakeEl();
  // render() writes #page; the switch must not, so the scroll position stays.
  let pageWrites = 0, pageHtml = '';
  els.page = { get innerHTML() { return pageHtml; }, set innerHTML(v) { pageWrites++; pageHtml = v; } };
  click({ unit: 'line' });
  assert.equal(ls.get('dwmt-view:unit'), 'line');
  for (const s of ['<h3>Koszt na zmienioną linię</h3>', 'data-unit="line" class="on" aria-pressed="true"']) assert.ok(els.ch2card.innerHTML.includes(s), s);
  assert.equal(dots(els.ch2.innerHTML), 1);
  assert.ok(els.ch2.innerHTML.includes('aria-label="Koszt na zmienioną linię"'));
  assert.equal(pageWrites, 0, '#page is not rendered again');
  click({ unit: 'file' });
  assert.equal(ls.get('dwmt-view:unit'), 'file');
  for (const s of ['<h3>Koszt na zmieniony plik</h3>', 'data-unit="file" class="on" aria-pressed="true"']) assert.ok(els.ch2card.innerHTML.includes(s), s);
  assert.equal(dots(els.ch2.innerHTML), 2);
  assert.equal(pageWrites, 0, '#page is not rendered again');
});

test("From you lists the user's questions (no architect line), translated through the memory with one EN mark, as text", () => {
  const d = histProject();
  const D = viewModel(ctx(d));
  assert.deepEqual(D.sprints.find((s) => s.id === 's-todo2').questionList, [{ text: 'Which export format?', tr: null }, { text: 'Keep the old links?', tr: null }]);
  let main = loadPage(renderHtml(D)).live.panel('s-todo2').main;
  let you = youBlock(main);
  for (const s of ['Odpowiedz na pytania:', '<li>Which export format?</li>', '<li>Keep the old links?</li>']) assert.ok(you.includes(s), s);
  // The raw sprint file stays in the collapsed technical details; the From you block lists only the user's questions.
  assert.ok(!you.includes('Pick the parser') && !main.includes('Odpowiedzi na pytania: 2'), main);
  assert.equal((you.match(/class="en-badge"/g) ?? []).length, 1);
  // One translated: the translation shows, still one EN mark for the other.
  const sha = (s) => createHash('sha1').update(s).digest('hex');
  write(d, '.dwmt/product/view/i18n-pl.json', JSON.stringify({ [sha('Which export format?')]: 'Jaki format eksportu?' }));
  main = loadPage(renderHtml(viewModel(ctx(d)))).live.panel('s-todo2').main;
  you = youBlock(main);
  assert.ok(you.includes('<li>Jaki format eksportu?</li>') && you.includes('<li>Keep the old links?</li>'), you);
  assert.equal((you.match(/class="en-badge"/g) ?? []).length, 1);
  // Both translated: no EN mark; EN mode shows the originals.
  write(d, '.dwmt/product/view/i18n-pl.json', JSON.stringify({ [sha('Which export format?')]: 'Jaki format eksportu?', [sha('Keep the old links?')]: 'Zostawić stare linki?' }));
  const html = renderHtml(viewModel(ctx(d)));
  you = youBlock(loadPage(html).live.panel('s-todo2').main);
  assert.ok(you.includes('<li>Zostawić stare linki?</li>'));
  assert.equal((you.match(/class="en-badge"/g) ?? []).length, 0);
  you = youBlock(loadPage(html, { lang: 'en' }).live.panel('s-todo2').main);
  assert.ok(you.includes('Answer these questions:') && you.includes('<li>Which export format?</li>'), you);
  // Text, never markup.
  const d2 = histProject(['Use <b> tags?']);
  you = youBlock(loadPage(renderHtml(viewModel(ctx(d2)))).live.panel('s-todo2').main);
  assert.ok(you.includes('<li>Use &lt;b&gt; tags?</li>') && !you.includes('<b> tags'), you);
  // Without user questions the old line stays away and a sprint with none needs no answers.
  assert.ok(!youBlock(loadPage(renderHtml(viewModel(ctx(histProject(['[architect] Only mine.']))))).live.panel('s-todo2').main).includes('Odpowiedz na pytania'));
});
