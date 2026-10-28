import './tmp-root.mjs';
// K7 T-4: workplaces on the product page (sketch 006 variant C): page data (`workplaces`, per-sprint `wp`), the switcher
// under the tabs, the board filter, the strips with git facts as of the refresh, the push box with copy, attention lines,
// the badge on cards and the "Miejsce pracy" box on the sprint card; without workplaces the page is as before.
// The page script runs in a vm with a minimal fake DOM (pattern: view-live.test.mjs#loadPage).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Script, createContext } from 'node:vm';
import { repo, gitIn } from './helpers.mjs';
import { pr, write, productRepo } from './product-helpers.mjs';
import { loadConfig } from '../scripts/lib/config.mjs';
import { productConfig } from '../scripts/lib/product-config.mjs';
import { paths, loadRoadmap, renderRoadmap, renderIndex } from '../scripts/lib/product-store.mjs';
import { viewModel, renderHtml, writeView, workplacesView } from '../scripts/lib/product-view.mjs';

const ctx = (d) => { const cfg = loadConfig(d); const pc = productConfig(d, cfg); return { top: d, cfg, pc, P: paths(d, pc) }; };
const ok = (r) => assert.equal(r.code, 0, `${r.out} ${r.err ?? ''}`);
const setLines = (d, fn) => { const c = ctx(d); write(d, 'docs/product/roadmap.md', renderRoadmap(fn(loadRoadmap(c.P)))); };

// The page script in a vm (as view-live.test.mjs#loadPage); `nav` becomes the page's `navigator`.
function loadPage(html, { lang = 'pl', nav = undefined, w = null } = {}) {
  const data = /<script type="application\/json" id="dwmt-data">([\s\S]*?)<\/script>/.exec(html)[1];
  const js = /<script>\n([\s\S]*?)\n<\/script>/.exec(html)[1];
  const els = {}, listeners = {};
  const el = () => ({ innerHTML: '', textContent: '', style: {}, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {}, remove() {}, focus() {}, querySelector: () => null, querySelectorAll: () => [] });
  const ls = new Map([...(lang ? [['dwmt-view:lang', lang]] : []), ...(w ? [['dwmt-view:w', w]] : [])]);
  const document = {
    hidden: false, documentElement: {}, body: { classList: { add() {}, remove() {} }, insertAdjacentHTML() {} }, head: { appendChild() {} },
    getElementById: (id) => (id === 'dwmt-data' ? { textContent: data } : id === 'dwmt-live' || id === 'modal-wrap' ? null : (els[id] ??= el())),
    createElement: () => el(), addEventListener: (type, fn) => (listeners[type] ??= []).push(fn), querySelector: () => null, querySelectorAll: () => [],
  };
  const sb = { document, localStorage: { getItem: (k) => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, v) }, location: { hash: '' }, history: { replaceState() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, requestAnimationFrame() {}, innerWidth: 1440, innerHeight: 900, console, addEventListener() {}, scrollTo() {} };
  if (nav !== undefined) sb.navigator = nav;
  sb.window = sb;
  createContext(sb);
  new Script(js).runInContext(sb);
  const click = (dataset) => {
    const node = { dataset, textContent: '', classList: { contains: () => false } };
    for (const fn of listeners.click) fn({ target: { closest: () => node }, stopPropagation() {}, preventDefault() {} });
    return node;
  };
  return { V: sb.DWMT_VIEW, els, click, ls };
}
const pageOf = (D, o) => loadPage(renderHtml(D), o);
const boardOf = (h) => h.slice(h.indexOf('<div class="board">'));
const colOf = (h, c) => { const b = boardOf(h); const i = b.indexOf(`class="col c-${c}"`); const j = b.indexOf('<section', i + 1); return b.slice(i, j < 0 ? undefined : j); };
const cardOf = (h, id) => { const i = h.lastIndexOf('<div class="bcard', h.indexOf(`data-open="${id}" role="button"`)); const j = h.slice(i + 1).search(/<div class="bcard|<\/section>/); return h.slice(i, j < 0 ? undefined : i + 1 + j); };
const wselOf = (hdr, name) => [...hdr.matchAll(/<button[^>]*data-w="([^"]+)"[^>]*>[\s\S]*?<\/button>/g)].find((m) => m[1] === name)?.[0] ?? '';
const opens = (h) => [...new Set([...boardOf(h).matchAll(/data-open="([^"]+)" role="button"/g)].map((m) => m[1]))].sort();

// Roadmap lines and sprint files written directly (few CLI spawns keep the set fast); workplaces through the commands.
const L = (id) => ({ id, state: 'todo', goal: `Goal ${id}`, after: [], detail: `sprints/${id}.md`, alias: null, current: false });
const spec = (id) => `---\n${Object.entries({ schema: 'dwmt/sprint-spec@1', id, kind: 'feature', items: [], touch: [], refs: [] }).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n\n## Goal\nGoal ${id}.\n`;
function sprints(d, ids) {
  write(d, 'docs/product/roadmap.md', renderRoadmap(ids.map(L)));
  for (const id of ids) write(d, `docs/product/sprints/${id}.md`, spec(id));
}
// s1 (closed) and s2 (to do) on abc, s3 on xyz, s4 without a workplace.
function build({ extra = [] } = {}) {
  const d = productRepo(repo);
  sprints(d, ['s1', 's2', 's3', 's4', ...extra]);
  ok(pr(d, 'workplace', 'add', 'abc', '--branch', 'abc', '--sprints', ['s1', 's2', ...extra].join(',')));
  ok(pr(d, 'workplace', 'add', 'xyz', '--branch', 'xyz', '--sprints', 's3'));
  // s1 is closed: off the roadmap, in the archive index.
  setLines(d, (ls) => ls.filter((l) => l.id !== 's1'));
  write(d, 'docs/product/archive/index.md', renderIndex([{ id: 's1', goal: 'Goal s1', merged: '2026-10-20', run: 'r-1' }]));
  return d;
}
// One shared fixture for the tests that only read it.
let shared = null;
const product = () => (shared ??= build());
let sharedD = null;
const model = () => (sharedD ??= viewModel(ctx(product())));

test('R-1 without workplaces: no workplaces key, no switcher, badge, strip or box markup (AC-6)', () => {
  const d = productRepo(repo);
  sprints(d, ['s1', 's2']);
  const D = viewModel(ctx(d));
  assert.ok(!('workplaces' in D), 'no workplaces key');
  assert.ok(!('mainBranch' in D), 'no mainBranch key');
  assert.ok(D.sprints.every((s) => !('wp' in s)), 'no wp on sprints');
  const { V, els } = pageOf(D);
  const all = `${els['app-header'].innerHTML}${els.page.innerHTML}${['s1', 's2'].map((id) => { const p = V.live.panel(id); return p.head + p.main + p.side; }).join('')}`;
  for (const mark of ['wpc-bar', 'data-w=', 'wsel', 'wpb', 'wpc-list', 'wpc-sel', 'push-box', 'data-copy', 'class="attn"', 'Miejsce pracy', 'k10']) assert.ok(!all.includes(mark), mark);
});

test('page data: closed s1 of active abc is in review, s2 has its position, mainBranch from the config (D-10)', () => {
  const d = product();
  const D = model();
  const S = Object.fromEntries(D.sprints.map((s) => [s.id, s]));
  assert.equal(S.s1.open, false);
  assert.equal(S.s1.human, 'review');
  assert.deepEqual(S.s1.wp, { name: 'abc', k: 1, n: 2, ci: 0, st: 'done' });
  assert.deepEqual(S.s2.wp, { name: 'abc', k: 2, n: 2, ci: 0, st: 'queued' });
  assert.deepEqual(S.s3.wp, { name: 'xyz', k: 1, n: 1, ci: 1, st: 'queued' });
  assert.ok(!('wp' in S.s4));
  assert.equal(D.mainBranch, 'master');
  assert.deepEqual(D.workplaces.map((w) => [w.name, w.branch, w.ci, w.state, w.ready]), [['abc', 'abc', 0, 'waiting', false], ['xyz', 'xyz', 1, 'waiting', false]]);
  const abc = D.workplaces[0];
  assert.deepEqual([abc.facts.ahead, abc.facts.behind, abc.facts.dirty, abc.facts.pushed, abc.facts.baseRef], [0, 0, 0, false, 'master']);
  assert.ok(!('at' in abc.facts), 'facts without a time (D-15)');
  assert.deepEqual(abc.sprints.map((s) => [s.id, s.k, s.state]), [['s1', 1, 'done'], ['s2', 2, 'queued']]);
  assert.deepEqual(abc.attention, []);
});

test('R-2 switcher counts, board filter and badges in roadmap order (AC-6)', () => {
  const d = product();
  const { els, click, ls } = pageOf(model());
  const hdr = els['app-header'].innerHTML;
  const entries = [...hdr.matchAll(/data-w="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)].map((m) => [m[1], /<span class="n">(\d+)<\/span>/.exec(m[2])?.[1]]);
  assert.deepEqual(entries, [['all', '4'], ['main', '1'], ['abc', '2'], ['xyz', '1']]);
  assert.ok(hdr.indexOf('wpc-bar') > hdr.indexOf('app-tabs'), 'switcher right under the tabs');
  // All: the board as today, one facts row per workplace above the stats.
  let h = els.page.innerHTML;
  assert.deepEqual(opens(h), ['s1', 's2', 's3', 's4']);
  assert.equal((h.match(/class="wpc-row /g) ?? []).length, 2);
  assert.ok(h.indexOf('wpc-list') < h.indexOf('class="stats"'));
  assert.match(cardOf(h, 's2'), /abc · 2 z 2/);
  assert.match(cardOf(h, 's3'), /xyz · 1 z 1/);
  assert.doesNotMatch(cardOf(h, 's4'), /class="wpb/);
  click({ w: 'abc' });
  h = els.page.innerHTML;
  assert.deepEqual(opens(h), ['s1', 's2']);
  assert.match(h, /class="wpc-sel wpc0"/);
  assert.match(h, /stan z \d\d:\d\d/);
  assert.equal(ls.get('dwmt-view:w'), 'abc', 'kept like the other filters');
  assert.match(els['app-header'].innerHTML, /class="wsel wpc0 on"/);
  click({ w: 'main' });
  h = els.page.innerHTML;
  assert.deepEqual(opens(h), ['s4']);
  assert.match(h, /Główne drzewo[\s\S]*<code>master<\/code>[\s\S]*scalane do master jak dziś/);
  click({ w: 'xyz' });
  assert.deepEqual(opens(els.page.innerHTML), ['s3']);
  // An unknown kept entry (workplace removed since) falls back to all.
  const again = pageOf(model(), { w: 'gone' });
  assert.deepEqual(opens(again.els.page.innerHTML), ['s1', 's2', 's3', 's4']);
});

test('R-3 closed s1 of active abc stays in "Czeka na przegląd" as a compact card, zrobiony, czeka na wypchnięcie (D-10)', () => {
  const d = product();
  const { els } = pageOf(model());
  const rv = colOf(els.page.innerHTML, 'review');
  assert.match(rv, /data-open="s1"/);
  const c = cardOf(rv, 's1');
  assert.match(c, /bcard compact/);
  assert.match(c, /✓ zrobiony, czeka na wypchnięcie/);
  assert.match(c, /abc · 1 z 2/);
  assert.doesNotMatch(colOf(els.page.innerHTML, 'todo'), /data-open="s1"/);
});

test('sprint card: "Miejsce pracy" box after "Od Ciebie" (name, branch, position, commit), main-tree sprints without it', () => {
  const d = product();
  const { V } = pageOf(model());
  const side = V.live.panel('s2').side;
  assert.match(side, /Miejsce pracy/);
  assert.match(side, /abc/);
  assert.match(side, /2 z 2 \(po s1\)/);
  assert.ok(side.indexOf('Od Ciebie') < side.indexOf('Miejsce pracy'));
  assert.match(side, /jeden commit na gałęzi abc/);
  assert.match(V.live.panel('s1').side, /Miejsce pracy[\s\S]*1 z 2 \(pierwszy\)/);
  assert.doesNotMatch(V.live.panel('s4').side, /Miejsce pracy/);
  // The live side keeps the box (the card of a running sprint).
  const live = V.live;
  live.take({ v: 1, writtenAt: new Date().toISOString(), intervalSec: 5, writer: 'alive', runs: [{ run: 'r-2', sprint: 's2', goal: 'Goal s2', status: 'work', startedAt: new Date().toISOString(), tasks: [], feed: [], cost: {} }] });
  const ls = live.panel('s2').side;
  assert.match(ls, /data-lv-part/);
  assert.ok(ls.indexOf('Od Ciebie') < ls.indexOf('Miejsce pracy') && ls.indexOf('Miejsce pracy') > 0, ls);
});

test('R-6 attention lines and the push box appear exactly when their condition holds (AC-6)', () => {
  const d = build({ extra: ['s5'] });
  const g = gitIn(d);
  // xyz: its only sprint done (UAT pending) → ready, not pushed: push box and one UAT line.
  setLines(d, (ls) => ls.map((l) => (l.id === 's3' ? { ...l, state: 'done' } : l)));
  let c = ctx(d);
  let D = viewModel(c);
  const W = (D0, n) => D0.workplaces.find((w) => w.name === n);
  assert.deepEqual(W(D, 'abc').attention, []);
  assert.deepEqual(W(D, 'xyz').attention.map((a) => a.key), ['uat']);
  assert.equal(W(D, 'xyz').ready, true);
  let p = pageOf(D);
  assert.match(wselOf(p.els['app-header'].innerHTML, 'xyz'), /<span class="ok-t">✓<\/span>/);
  p.click({ w: 'xyz' });
  let h = p.els.page.innerHTML;
  assert.equal((h.match(/<li>/g) ?? []).length, 1);
  assert.match(h, /Sprint s3 czeka na Twój UAT/);
  assert.match(h, /class="push-box"[\s\S]*Gotowe do wypchnięcia[\s\S]*data-copy="git push -u origin xyz"/);
  // Batch T-4/F-1: the open done line (UAT pending) of a workplace sprint carries the D-10 note too.
  assert.match(cardOf(h, 's3'), /xyz · 1 z 1[\s\S]*✓ zrobiony, czeka na wypchnięcie/);
  p.click({ w: 'abc' });
  assert.doesNotMatch(p.els.page.innerHTML, /push-box|<li>/);
  // abc: s2 done (UAT), uncommitted files with s5 queued, behind master ≥ farBehind: one line each.
  setLines(d, (ls) => ls.map((l) => (l.id === 's2' ? { ...l, state: 'done' } : l)));
  writeFileSync(join(d, '.claude', 'worktrees', 'abc', 'notes.txt'), 'mine\n');
  write(d, 'm.txt', 'x\n');
  g('add', 'm.txt');
  g('commit', '-q', '-m', 'master moves on');
  c = ctx(d);
  c.pc.workplace.farBehind = 1;
  D = viewModel(c);
  const abc = W(D, 'abc');
  assert.deepEqual(abc.attention.map((a) => a.key), ['uat', 'dirty', 'behind']);
  assert.equal(abc.state, 'attn');
  assert.deepEqual(abc.attention[1], { key: 'dirty', n: 1, files: ['notes.txt'], held: 's5' });
  p = pageOf(D);
  p.click({ w: 'abc' });
  h = p.els.page.innerHTML;
  assert.equal((h.match(/<li>/g) ?? []).length, 3);
  assert.match(h, /1 plik niezapisanych w miejscu pracy[\s\S]*Następny sprint \(s5\) nie ruszy[\s\S]*<code>notes\.txt<\/code>/);
  assert.match(h, /1 commit za master/);
  assert.doesNotMatch(h, /push-box/, 'not ready: s5 queued');
  assert.match(wselOf(p.els['app-header'].innerHTML, 'abc'), /<span class="warn">!<\/span>/);
  assert.doesNotMatch(wselOf(p.els['app-header'].innerHTML, 'abc'), /ok-t/);
  // Below the threshold the behind line goes.
  c.pc.workplace.farBehind = 2;
  assert.deepEqual(workplacesView(c).find((w) => w.name === 'abc').attention.map((a) => a.key), ['uat', 'dirty']);
  // Batch T-4/F-3: without a queued sprint the dirty line stays (the pill says "Czeka na Ciebie") and says what to do.
  ok(pr(d, 'workplace', 'unassign', 's5'));
  c = ctx(d);
  const idle = workplacesView(c).find((w) => w.name === 'abc');
  assert.deepEqual(idle.attention.map((a) => a.key), ['uat', 'dirty']);
  assert.deepEqual(idle.attention[1], { key: 'dirty', n: 1, files: ['notes.txt'], held: null });
  assert.equal(idle.state, 'attn');
  p = pageOf(viewModel(c));
  p.click({ w: 'abc' });
  h = p.els.page.innerHTML;
  assert.match(h, /1 plik niezapisanych w miejscu pracy[\s\S]*Zapisz je albo odrzuć przed wypchnięciem[\s\S]*<code>notes\.txt<\/code>/);
  assert.doesNotMatch(h, /Następny sprint/);
  // xyz pushed (remote ref at its tip): no push box, state pushed; the ✓ mark only while ready and unpushed.
  g('update-ref', 'refs/remotes/origin/xyz', 'xyz');
  D = viewModel(ctx(d));
  assert.equal(W(D, 'xyz').facts.pushed, true);
  assert.equal(W(D, 'xyz').state, 'pushed');
  p = pageOf(D);
  assert.doesNotMatch(wselOf(p.els['app-header'].innerHTML, 'xyz'), /ok-t/);
  p.click({ w: 'xyz' });
  assert.doesNotMatch(p.els.page.innerHTML, /push-box/);
  assert.match(p.els.page.innerHTML, /✓ tak, origin\/xyz aktualne/);
  assert.match(cardOf(p.els.page.innerHTML, 's3'), /✓ wypchnięty, review zespołu/, 'the done line after the push');
  // A removed workplace: its closed sprint leaves the review column (state as without workplaces) and the key
  // disappears with the last one.
  rmSync(join(d, '.claude', 'worktrees', 'abc', 'notes.txt'));
  ok(pr(d, 'workplace', 'remove', 'abc'));
  ok(pr(d, 'workplace', 'remove', 'xyz'));
  const D2 = viewModel(ctx(d));
  const s1 = D2.sprints.find((s) => s.id === 's1');
  assert.notEqual(s1.human, 'review');
  assert.ok(!('wp' in s1));
  assert.ok(!('workplaces' in D2));
});

test('copy button: the clipboard gets the push command, "Skopiowane"; no clipboard → no error', async () => {
  const d = product();
  const got = [];
  const p = pageOf(model(), { nav: { clipboard: { writeText: (x) => { got.push(x); return Promise.resolve(); } } } });
  const node = p.click({ copy: 'git push -u origin abc' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(got, ['git push -u origin abc']);
  assert.equal(node.textContent, 'Skopiowane');
  const q = pageOf(model());
  assert.doesNotThrow(() => q.click({ copy: 'git push -u origin abc' }));
  const r = pageOf(model(), { nav: {} });
  assert.doesNotThrow(() => r.click({ copy: 'git push -u origin abc' }));
});

test('strings: every new workplace label in T.pl and T.en', () => {
  const d = product();
  const { V } = pageOf(model());
  const T = V.live.strings;
  const keys = (l) => Object.keys(T[l]).filter((k) => k.startsWith('wp_')).sort();
  assert.ok(keys('pl').length >= 20, String(keys('pl').length));
  assert.deepEqual(keys('pl'), keys('en'));
  // EN mode renders the English labels.
  const e = pageOf(model(), { lang: 'en' });
  assert.match(e.els['app-header'].innerHTML, /data-w="all"[^>]*>All /);
  assert.match(e.els.page.innerHTML, /abc · 2 of 2/);
});

test('R-4 a published page with workplaces is not rewritten when only the time changed (D-15)', () => {
  const d = product();
  const out = join(mkdtempSync(join(tmpdir(), 'dwmt-k7v-')), 'roadmap.html');
  const a = writeView(ctx(d), { out, liveFrom: true });
  assert.ok(!a.unchanged);
  const b = writeView(ctx(d), { out, liveFrom: true });
  assert.equal(b.unchanged, true);
});
