// dwmt D4: read-only human view of the product layer (spec warstwy produktowej §3.11). One self-contained HTML file
// (`<main tree>/.dwmt/product/view/index.html`, outside git): inline CSS, JS and the data JSON built here from the product
// files of the main tree only (never run dirs), 0 tokens; called from a sprint worktree it still shows the main tree.
// Titles and goals get translations from a memory (`i18n-<lang>.json`, key = sha1 of the English source), filled by a
// cheap model only for new and changed strings: `product view --translate` in the foreground, or after `product commit`
// a detached background translator (one at a time, `translate.lock`) that regenerates the page when done. Agents never
// read the page.
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, appendFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, basename, relative, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { ROOT, fwd, read, asList, writeFileAtomic, samePath } from './util.mjs';
import { git } from './git.mjs';
import { contextHome } from './run.mjs';
import { loadConfig } from './config.mjs';
import { productConfig } from './product-config.mjs';
import { alive, heldLeases } from '../machine.mjs';
import { spawnDetached } from './platform.mjs';
import {
  paths, loadRoadmap, loadIndex, loadItems, loadDecisions, readSpecAt, specFile, archiveSpecFile, specSections, stripForYou,
  parseForYou, humanState, nextSprint, merged, specKind,
} from './product-store.mjs';
import { visionGoal, estimateOf } from './product-ops.mjs';
import { haltsOf } from './supervisor-loop.mjs';
import { cheapClaude, answerJson } from './product-foryou.mjs';
import { activeWorkplaces, workplaceSprints, workplaceFacts, workplaceReady } from './workplace.mjs';

export const TRANSLATE_BATCH = 150;
const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const r3 = (x) => Math.round(x * 1000) / 1000;

export const viewDir = (top) => join(contextHome(top), '.dwmt', 'product', 'view');
// Context of the main tree: the page, its data and its links come from there, also when called from a sprint worktree.
// Project name on the page (T-3/F-3): the folder of the repo's main worktree, read from the shared git dir (`<repo>/.git`;
// a bare `<name>.git` gives `<name>`), so a home tree in another worktree (`shop-develop`) still shows `shop`.
// Outside git: the home tree's folder.
export function projectName(top) {
  try {
    const common = resolve(top, git(['rev-parse', '--git-common-dir'], { cwd: top }));
    return basename(common) === '.git' ? basename(dirname(common)) : basename(common).replace(/\.git$/, '');
  } catch { return basename(contextHome(top)); }
}

export function mainCtx(c) {
  if (c.main) return c;
  let main = null;
  try { main = contextHome(c.top); } catch { /* not a git repo */ }
  if (!main || samePath(main, c.top)) return { ...c, main: true };
  const cfg = loadConfig(main);
  const pc = productConfig(main, cfg);
  return { top: main, cfg, pc, P: paths(main, pc), main: true };
}
export const memoryFile = (top, lang) => join(viewDir(top), `i18n-${lang}.json`);
// The page: `product.view.publish` (path from the repo root, in git; then the only page), else `.dwmt/` of the home tree.
export const pageFile = (c) => (c.pc.view?.publish ? join(c.top, c.pc.view.publish) : join(viewDir(c.top), 'index.html'));
// live.js stays in `.dwmt/` of the main tree (`dwmt live` rewrites it every few seconds; never in git): the page loads it
// by a path relative to itself, by a file URL across drives.
function liveSrc(top, pageDir) {
  const f = join(contextHome(top), '.dwmt', 'product', 'view', 'live.js');
  const rel = relative(pageDir, f);
  return isAbsolute(rel) || /^[A-Za-z]:/.test(rel) ? pathToFileURL(f).href : fwd(rel);
}
export function loadMemory(file) { try { const m = JSON.parse(read(file)); return m && typeof m === 'object' && !Array.isArray(m) ? m : {}; } catch { return {}; } }

// Content language of the page: `--lang`, else config `language` (default en).
export const viewLang = (c, lang = null) => String(lang ?? c.cfg.language ?? 'en').toLowerCase();

// ---------- helpers on sprint files ----------

// Identifiers out of agent text shown as the fallback for the human section (B-n, AC-n, PD-n, …, [human] marks).
export function noIds(s) {
  return String(s ?? '').replace(/\[(?:human|architect)\]/gi, '').replace(/\b(?:AC|PD|SD|B|E|U|Q|R|C|D|T)-\d+\b:?/g, '').replace(/(^|[^.])\.\.(?!\.)/g, '$1')
    .replace(/\s*[,;/](?:\s*[,;/])*\s*([)\]])/g, '$1').replace(/([([])\s*[,;/](?:\s*[,;/])*\s*/g, '$1').replace(/,(\s*,)+/g, ',')
    .replace(/\([\s,;/]*\)|\[[\s,;/]*\]/g, '').replace(/\s+([,.;:])/g, '$1').replace(/^[\s,.;:–-]+/, '').replace(/\s{2,}/g, ' ').trim();
}
const bullets = (txt) => String(txt ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !/^#/.test(l)).map((l) => l.replace(/^[-*]\s+/, ''))
  .map(noIds).filter((l) => l && !/^(none|n\/a|-)\.?$/i.test(l));
const listItems = (txt) => String(txt ?? '').split('\n').filter((l) => /^\s*[-*]\s+\S/.test(l)).map((l) => l.replace(/^\s*[-*]\s+/, '').trim())
  .filter((l) => !/^(none|n\/a|-)\.?$/i.test(l));
// Open questions for the user: list lines without `[architect]`.
const userQuestions = (txt) => listItems(txt).filter((l) => !/\[architect\]/i.test(l));

// Paths in `## Mockups` that exist under the repo: a directory links to its index.html; `dir/NNN` also finds `dir/NNN-name`.
const PATH_TOKEN = /[\w@.\-]*\/[\w@.\-/]*|[\w@.\-]+\.html?\b/g;
export function mockupLinks(top, text, outDir) {
  const out = [];
  const seen = new Set();
  for (let tok of String(text ?? '').match(PATH_TOKEN) ?? []) {
    tok = tok.replace(/[.,;:)]+$/, '').replace(/^\.\//, '');
    if (!tok || /^[a-z]+:/i.test(tok) || tok.startsWith('/') || tok.split('/').includes('..') || isAbsolute(tok)) continue;
    let abs = join(top, tok);
    if (!existsSync(abs)) {
      const parent = dirname(abs);
      const last = basename(abs);
      let hit = [];
      try { hit = existsSync(parent) && statSync(parent).isDirectory() ? (readdirSync(parent).filter((n) => n.startsWith(`${last}-`))) : []; } catch { hit = []; }
      if (hit.length !== 1) continue;
      abs = join(parent, hit[0]);
    }
    let target = abs;
    try { if (statSync(abs).isDirectory()) { if (!existsSync(join(abs, 'index.html'))) continue; target = join(abs, 'index.html'); } } catch { continue; }
    const rel = fwd(relative(top, abs));
    if (seen.has(rel)) continue;
    seen.add(rel);
    // A page on another drive (Windows) has no relative path to the mockup: a file URL then.
    const back = relative(outDir, target);
    out.push({ path: rel, href: isAbsolute(back) ? pathToFileURL(target).href : fwd(back).split('/').map(encodeURIComponent).join('/') });
  }
  return out;
}

const decisionField = (d, k) => d.lines.find((l) => l.startsWith(`${k}:`))?.slice(k.length + 1).trim() ?? null;
const areasOf = (d) => String(d.area ?? 'general').split(',').map((x) => x.trim()).filter(Boolean);
const triKey = (x) => (!x.triage ? 'new' : String(x.triage).startsWith('sprint:') ? 'sprint' : x.triage);
const sprintOf = (x) => x.sprint || (String(x.triage ?? '').startsWith('sprint:') ? String(x.triage).slice(7) : null);
const closedItem = (x) => ['done', 'dropped'].includes(x.state);
const fitOf = (tok, rg) => (!rg || tok == null ? null : tok > rg[1] ? 'above' : tok < rg[0] ? 'below' : 'in');

// The optimization goal sentence of `vision.md` (`## Goal`), else its first line.
export function goalLine(P) {
  const g = visionGoal(P);
  if (!g?.length) return null;
  const all = g.join(' ').replace(/\s+/g, ' ');
  const m = /Optimization goal:\s*(.+?\.)(?:\s|$)/i.exec(all) ?? /Optimization goal:\s*(.+)$/i.exec(all);
  return (m ? m[1] : g[0]).trim();
}

// ---------- workplaces (K7, sketch 006 variant C) ----------

// Colours of the workplace badges cycle over this many palette entries (view.css `.wpc0`…).
export const WP_COLOURS = 6;
// Active workplaces for the page: record fields, sprints in order (C-1), git facts as of this generation without their
// time (D-15: the page shows "stan z" from `generatedAt`, so a page with the same git state stays byte-equal), readiness,
// a state for the pill and the attention lines (SD-7): a sprint waiting for UAT; uncommitted files (naming the queued sprint
// they hold, if any); the branch at least `product.workplace.farBehind` commits behind its base. Never throws.
export function workplacesView(c) {
  let act = [];
  try { act = activeWorkplaces(c.top); } catch { return []; }
  const far = num(c.pc?.workplace?.farBehind) ?? 20;
  return act.map((wp, i) => {
    const sprints = workplaceSprints(c.top, wp);
    const { at: _at, ...facts } = workplaceFacts(c.top, wp);
    const ready = workplaceReady(c.top, wp).ready;
    const has = (st) => sprints.some((x) => x.state === st);
    const queued = sprints.find((x) => x.state === 'queued');
    const attention = [
      ...sprints.filter((x) => x.state === 'uat').map((x) => ({ key: 'uat', id: x.id })),
      // Batch T-4/F-3: always with uncommitted files (the pill says "Czeka na Ciebie"); `held` only while a sprint is queued.
      ...(facts.dirty ? [{ key: 'dirty', n: facts.dirty, files: facts.dirtyFiles, held: queued?.id ?? null }] : []),
      ...(facts.behind != null && facts.behind >= far ? [{ key: 'behind', n: facts.behind, ref: facts.baseRef, since: wp.base?.at ?? null }] : []),
    ];
    const state = ready && facts.pushed ? 'pushed' : has('uat') || facts.dirty ? 'attn' : has('running') ? 'running' : ready ? 'ready' : 'waiting';
    return { name: wp.name, branch: wp.branch, path: wp.path ?? null, base: wp.base ?? null, ci: i % WP_COLOURS, state, ready, farBehind: far, facts, sprints, attention };
  });
}

// ---------- view model ----------

export function viewModel(c0, { lang = null, outDir = null, live = true, liveFrom = false } = {}) {
  const c = mainCtx(c0);
  const { P, top } = c;
  const language = viewLang(c, lang);
  const mem = language === 'en' ? {} : loadMemory(memoryFile(top, language));
  const trOf = (s) => (language === 'en' || !s ? null : mem[sha1(s)] ?? null);
  const dir = outDir ?? viewDir(top);
  const warnings = [];
  const lines = loadRoadmap(P);
  const index = loadIndex(P);
  const { open: itemsOpen, archived: itemsArch } = loadItems(P);
  const { active, archived: decArch } = loadDecisions(P);
  const estRange = (est) => {
    if (!est) return null;
    try { const e = estimateOf(P, est); if (Array.isArray(e?.tokensM)) return e.tokensM; } catch { /* unreadable log */ }
    warnings.push(`est ${est}: not in estimates.jsonl`);
    return null;
  };
  const decTitle = new Map([...decArch, ...active].map((d) => [d.id, d.title]));
  const read1 = (file, id) => { try { return readSpecAt(file); } catch (e) { warnings.push(`${id}: ${e.message}`); return null; } };
  const nx = nextSprint(lines, index);
  // Thousand tokens per changed line; unknown (null) when lines are missing or 0, never 0.
  const perLineK = (tokensM, n) => (n > 0 && tokensM != null ? r3(tokensM * 1000 / n) : null);

  const sprintCore = (s) => {
    const h = s?.h ?? {};
    const body = s ? stripForYou(s.body) : '';
    const sec = s ? specSections(body) : {};
    const forYou = s ? parseForYou(s.body) : null;
    const pds = [...new Set(body.match(/\bPD-\d+\b/g) ?? [])];
    return {
      kind: specKind(h.kind) ?? null, ui: !!h.ui, mode: h.mode ?? null, est: h.est ?? null, estRange: estRange(h.est), readyAt: h.ready?.at ?? null, run: h.run ?? null,
      items: asList(h.items), touch: asList(h.touch), hasFile: !!s, forYou,
      fallback: !s || forYou ? null : { goal: noIds(sec.Goal ?? ''), changes: bullets(sec.Acceptance ?? sec['Acceptance criteria']), notIncluded: bullets(sec['Out of scope']), notes: bullets(sec.Notes).slice(0, 12) },
      mockups: h.ui ? mockupLinks(top, sec.Mockups, dir) : [],
      questions: userQuestions(sec['Open questions']).length,
      // The user's questions as text for the card: leading `[tag]` markers removed, translated through the memory.
      questionList: userQuestions(sec['Open questions']).map((q) => q.replace(/^(?:\s*\[[^\]]*\])+\s*/, '').trim()).filter(Boolean).map((text) => ({ text, tr: trOf(text) })),
      decisions: pds.map((p) => ({ id: p, title: decTitle.get(p) ?? null, titleTr: trOf(decTitle.get(p)) })),
      sections: Object.entries(sec).filter(([, v]) => v.trim()),
    };
  };

  // Closed sprints (archive index), with the archived file header when present.
  const closed = index.map((x) => {
    const s = existsSync(archiveSpecFile(P, x.id)) ? read1(archiveSpecFile(P, x.id), x.id) : null;
    const core = sprintCore(s);
    const dropped = x.merged === 'dropped';
    const human = dropped ? null : humanState({ archived: true, h: s?.h ?? {} });
    const uat = s?.h?.actual?.uat ?? null;
    return { id: x.id, open: false, pos: null, state: dropped ? 'dropped' : human === 'review' ? 'review' : 'closed', human, current: false, goal: x.goal === '-' ? x.id : x.goal,
      after: [], afterOpen: [], alias: null, ...core, merged: /^\d{4}-\d\d-\d\d/.test(x.merged) ? x.merged.slice(0, 10) : null, dropped, run: x.run ?? core.run,
      files: num(x.files), tokensM: num(x.tokensM), perFile: num(x.files) && num(x.tokensM) != null ? r3(num(x.tokensM) / num(x.files)) : null,
      lines: num(x.lines), perLineK: perLineK(num(x.tokensM), num(x.lines)), uat };
  });
  const measured = closed.filter((x) => x.merged && x.files && x.tokensM != null);

  let halts = {};
  try { halts = haltsOf(contextHome(top)); } catch { /* best effort */ }
  const openS = lines.map((l, i) => {
    const s = l.state === 'topic' && l.detail === 'none' && !existsSync(specFile(P, l.id)) ? null : read1(specFile(P, l.id), l.id);
    const core = sprintCore(s);
    const human = humanState(l);
    const needs = [];
    if (human === 'todo' && l.state !== 'ready') {
      if (core.ui && !core.mockups.length) needs.push('mockup');
      if (!core.est) needs.push('price');
      if (core.questions) needs.push('answers');
    }
    const analogs = human === 'todo' ? measured.filter((a) => a.kind && a.kind === core.kind)
      .map((a) => ({ a, d: Math.abs(a.items.length - core.items.length) })).sort((x, y) => x.d - y.d || String(y.a.merged).localeCompare(String(x.a.merged))).slice(0, 2)
      .map(({ a }) => ({ id: a.id, files: a.files, tokensM: a.tokensM })) : [];
    // A merged sprint still on the roadmap (`done`, waiting for its UAT): its result from the header (`actual`, sync).
    const a = l.state === 'done' ? s?.h?.actual ?? null : null;
    const files = num(a?.files);
    const tokensM = num(a?.tokens);
    const lns = num(a?.lines);
    return { id: l.id, open: true, pos: i + 1, state: l.state, human, current: !!l.current, goal: l.goal, after: l.after,
      afterOpen: l.after.filter((x) => !merged(x, lines, index)), alias: l.alias ?? null, ...core, needs, analogs,
      merged: /^\d{4}-\d\d-\d\d/.test(String(a?.merged ?? '')) ? String(a.merged).slice(0, 10) : null, dropped: false, files, tokensM,
      perFile: files && tokensM != null ? r3(tokensM / files) : null, lines: lns, perLineK: perLineK(tokensM, lns), uat: a?.uat ?? null, halt: human === 'inprogress' ? halts[l.id] ?? null : null };
  });

  // K7: position badge per workplace sprint; a closed sprint of an active workplace stays in review until the workplace
  // is removed (D-10: done on the branch, waiting for the push and the team's review).
  const workplaces = workplacesView(c);
  const wpOf = new Map(workplaces.flatMap((w) => w.sprints.map((s) => [s.id, { name: w.name, k: s.k, n: s.n, ci: w.ci, st: s.state }])));
  const sprints = [...openS, ...closed].map((x) => {
    const wp = wpOf.get(x.id);
    return { ...x, goalTr: trOf(x.goal), ...(wp ? { wp, ...(!x.open && !x.dropped ? { human: 'review' } : {}) } : {}) };
  });
  const known = new Map(sprints.map((x) => [x.id, x]));
  const history = [...measured, ...openS.filter((x) => x.merged && x.files && x.tokensM != null)].map((x) => ({ id: x.id, merged: x.merged, files: x.files, tokensM: x.tokensM, perFile: r3(x.tokensM / x.files), lines: x.lines, perLineK: x.perLineK, estRange: x.estRange,
    fit: fitOf(x.tokensM, x.estRange), kind: x.kind, uat: x.uat })).sort((a, b) => a.merged.localeCompare(b.merged) || a.id.localeCompare(b.id));

  // Backlog: open and archived (archived hidden by default in the page); open items on closed sprints are flagged.
  const stale = {};
  const items = [...itemsOpen.map((x) => ({ x, closed: closedItem(x) })), ...itemsArch.map((x) => ({ x, closed: true }))].map(({ x, closed: cl }) => {
    const sp = sprintOf(x);
    const isStale = !cl && !!sp && !lines.some((l) => l.id === sp) && index.some((r) => r.id === sp && r.merged !== 'dropped');
    if (isStale) (stale[sp] ??= []).push(x.id);
    return { id: x.id, type: x.type, title: x.title, titleTr: cl ? null : trOf(x.title), note: x.note ?? null, sev: x.sev ?? null, state: x.state, tri: triKey(x),
      sprint: sp, anchors: asList(x.anchors), at: x.at ?? null, est: x.est ?? null, src: x.src ?? null, alias: x.alias ?? null, closed: cl, stale: isStale };
  });
  for (const [sp, ids] of Object.entries(stale)) warnings.push(`${ids.length} open item(s) assigned to closed sprint ${sp}: ${ids.slice(0, 6).join(', ')}${ids.length > 6 ? ', …' : ''}`);
  for (const l of openS) for (const a of l.after) if (!known.has(a)) warnings.push(`${l.id}: after ${a} not in the roadmap or archive`);

  const decisions = active.map((d) => {
    const ag = decisionField(d, 'Against recommendation');
    return { id: d.id, title: d.title, titleTr: trOf(d.title), areas: areasOf(d), at: d.at, by: d.by, decision: d.decision, why: decisionField(d, 'Why'), rejected: decisionField(d, 'Rejected'),
      against: ag && /^yes/i.test(ag) ? ag.replace(/^yes\s*[—–-]?\s*/i, '') || 'yes' : null };
  });

  const goal = goalLine(P);
  const forYouMissing = sprints.filter((x) => ['todo', 'inprogress', 'review'].includes(x.human) && !x.forYou && !(x.wp && !x.open)).map((x) => x.id);
  // Live sprint view: the page polls `live.js` next to itself (written by `dwmt live`) every `intervalSec` while enabled.
  const view = c.pc?.view ?? {};
  const D = {
    schema: 'dwmt/view@1', project: projectName(top), generatedAt: new Date().toISOString(), language,
    live: { enabled: live && view.live !== false, intervalSec: Math.max(1, num(view.liveIntervalSec) ?? 5), ...(liveFrom ? { src: liveSrc(top, dir) } : {}) },
    goal: goal ? { text: goal, tr: trOf(goal) } : null,
    next: nx ? { id: nx.line.id, why: nx.why, also: nx.also } : null,
    // Only with active workplaces: without them the page data (and so the page) stays as before (D-12).
    ...(workplaces.length ? { workplaces, mainBranch: c.cfg?.git?.target ?? null } : {}),
    sprints, items, decisions, history, stale, warnings: [...new Set(warnings)], forYouMissing,
  };
  const strings = translatable(D);
  D.untranslated = language === 'en' ? 0 : strings.filter((s) => !mem[sha1(s)]).length;
  return D;
}

// Strings the translation memory covers: sprint goals (roadmap and archive), open item titles, active decision titles, product goal,
// the user's open questions of open sprints.
export function translatable(D) {
  return [...new Set([D.goal?.text, ...D.sprints.map((x) => x.goal), ...D.items.filter((x) => !x.closed).map((x) => x.title), ...D.decisions.map((x) => x.title),
    ...D.sprints.filter((x) => x.open).flatMap((x) => (x.questionList ?? []).map((q) => q.text))]
    .filter((s) => s && String(s).trim()))];
}

// ---------- HTML writer ----------

const TEMPLATES = join(ROOT, 'templates', 'view');
export function renderHtml(D) {
  const tpl = read(join(TEMPLATES, 'view.html'));
  const css = read(join(TEMPLATES, 'view.css'));
  const js = read(join(TEMPLATES, 'view.js')).replace(/<\/script/gi, '<\\/script');
  const data = JSON.stringify(D).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const title = `${D.project} · dwmt`.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  // One pass over the template: inserted text (data, code) is never scanned for placeholders again.
  const parts = { '{{title}}': title, '{{lang}}': D.language === 'pl' ? 'pl' : 'en', '/*{{css}}*/': css, '{{data}}': data, '/*{{js}}*/': js };
  return tpl.replace(/\{\{title\}\}|\{\{lang\}\}|\/\*\{\{css\}\}\*\/|\{\{data\}\}|\/\*\{\{js\}\}\*\//g, (m) => parts[m]);
}

// `.dwmt/` of the main tree stays out of git (as `init` does).
function ensureExcluded(top) {
  try {
    const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: top });
    const ex = join(common, 'info', 'exclude');
    mkdirSync(dirname(ex), { recursive: true });
    const t = existsSync(ex) ? readFileSync(ex, 'utf8') : '';
    if (!/^\/?\.dwmt\/?$/m.test(t)) appendFileSync(ex, `${t && !t.endsWith('\n') ? '\n' : ''}.dwmt/\n`);
  } catch { /* not a git repo: nothing to exclude */ }
}

export function writeView(c0, { out = null, lang = null, live = true, liveFrom = false } = {}) {
  const c = mainCtx(c0);
  const pub = !out && !!c.pc.view?.publish;
  const file = out ? resolve(out) : pageFile(c);
  const D = viewModel(c, { lang, outDir: dirname(file), live, liveFrom: liveFrom || pub });
  if (!out && !pub) ensureExcluded(c.top);
  mkdirSync(dirname(file), { recursive: true });
  const html = renderHtml(D);
  // The published page is in git: a write that changes only `generatedAt` would leave the product dir dirty for nothing.
  const bare = (s) => s.replace(/"generatedAt":"[^"]*"/, '');
  const unchanged = (pub || liveFrom) && existsSync(file) && bare(readFileSync(file, 'utf8')) === bare(html);
  if (!unchanged) writeFileAtomic(file, html);
  // Tests: `DWMT_VIEW_LOG=<file>` gets one JSON line per page write, with the leases this process holds.
  if (process.env.DWMT_VIEW_LOG) { try { appendFileSync(process.env.DWMT_VIEW_LOG, `${JSON.stringify({ at: new Date().toISOString(), file: fwd(file), leases: heldLeases() })}\n`); } catch { /* best effort */ } }
  return {
    ok: true, file: fwd(file), sprints: D.sprints.length, items: D.items.filter((x) => !x.closed).length, decisions: D.decisions.length,
    untranslated: D.untranslated, forYouMissing: D.forYouMissing.length, warnings: D.warnings, language: D.language,
    ...(unchanged ? { unchanged: true } : {}),
  };
}

// The published page in the tree `top` before `product commit`'s `git add`, so the commit carries the page of its own state.
export function publishView(c, top = c.top) {
  const rel = c.pc.view?.publish;
  if (!rel || c.pc.view?.enabled === false) return null;
  writeView(c, { out: join(top, rel), liveFrom: true });
  return fwd(rel);
}

// ---------- translation memory ----------

const translatePrompt = (lang, obj) => [
  `Translate the values of the JSON object below from English into the language with code "${lang}".`,
  'They are short texts from a software product plan: sprint goals, backlog item titles and decision titles, read by the product owner.',
  'Plain product language, about as short as the source. Keep identifiers unchanged: ids like B-12, PD-3, AC-1, sprint ids, file paths, code, product and library names.',
  'Answer with one JSON object only, no other text, with exactly the same keys and one translated string per key.',
  '', JSON.stringify(obj, null, 0),
].join('\n');

// Missing strings in batches of ≤ 150, one tool-less `claude -p` call each; merged into the memory file (re-read before the
// write, so a parallel run loses nothing). `exclusive`: under the translator lock; while another live translator holds
// it, nothing is sent (→ {busy: {pid, at}}). `onBatch` runs after every call (the lock's heartbeat).
// → {ok, language, sent, translated, left, calls, errors, costHint}.
export function translateView(c0, { lang = null, timeoutMs = null, exclusive = false, onBatch = null } = {}) {
  const c = mainCtx(c0);
  const language = viewLang(c, lang);
  if (language === 'en') return { ok: true, language, sent: 0, translated: 0, left: 0, calls: 0, errors: [], costHint: 'no calls (language en)' };
  if (exclusive) {
    const r = withTranslator(c, (beat) => translateView(c, { lang: language, timeoutMs, onBatch: beat }));
    return r ?? { ok: true, language, sent: 0, translated: 0, left: null, calls: 0, errors: [], costHint: 'no calls', busy: translatorRunning(c) ?? { pid: null } };
  }
  const { top, cfg, pc } = c;
  const view = pc.view ?? {};
  const file = memoryFile(top, language);
  const D = viewModel(c, { lang: language });
  const mem = loadMemory(file);
  const missing = translatable(D).filter((s) => !mem[sha1(s)]);
  const model = view.model ?? 'haiku';
  const usage = { calls: 0, tokens: 0, usd: 0 };
  const errors = [];
  const got = {};
  for (let i = 0; i < missing.length; i += TRANSLATE_BATCH) {
    const batch = missing.slice(i, i + TRANSLATE_BATCH);
    const obj = Object.fromEntries(batch.map((s, k) => [`t${k + 1}`, s]));
    const r = cheapClaude(top, cfg, translatePrompt(language, obj), { model, timeoutMs: timeoutMs ?? (view.translateTimeoutS ?? 120) * 1e3 });
    usage.calls++; usage.tokens += r.usage.tokens; usage.usd += r.usage.usd;
    onBatch?.();
    if (!r.ok) { errors.push(r.error); continue; }
    let ans;
    try { ans = answerJson(r.text); } catch (e) { errors.push(`bad answer: ${e.message}`); continue; }
    batch.forEach((s, k) => { const v = ans[`t${k + 1}`]; if (typeof v === 'string' && v.trim()) got[sha1(s)] = v.replace(/\s+/g, ' ').trim(); });
  }
  const translated = Object.keys(got).length;
  if (translated) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileAtomic(file, `${JSON.stringify({ ...loadMemory(file), ...got }, null, 1)}\n`);
  }
  if (missing.length && translated < missing.length && !errors.length) errors.push(`${missing.length - translated} string(s) without a translation in the answer`);
  const costHint = usage.calls ? `${usage.calls} call(s), ${(usage.tokens / 1e6).toFixed(3)} M tokens${usage.usd ? `, $${usage.usd.toFixed(3)}` : ''} (${model})` : 'no calls';
  return { ok: !errors.length, language, sent: missing.length, translated, left: missing.length - translated, calls: usage.calls, errors, costHint };
}

// ---------- background translator (after `product commit`) ----------

// Lock file {pid, at} under the view directory: one translator at a time. A holder that is dead, or silent for longer
// than one call's timeout plus a minute (the time is renewed after every call), is taken over.
const translatorLock = (c) => join(viewDir(c.top), 'translate.lock');
const lockRecord = (file) => { try { return JSON.parse(read(file)); } catch { return null; } };
const staleMs = (c) => ((c.pc.view?.translateTimeoutS ?? 120) + 60) * 1e3;
// The live translator of another process holding the lock ({pid, at}), or null.
export function translatorRunning(c0) {
  const c = mainCtx(c0);
  const h = lockRecord(translatorLock(c));
  return h && h.pid !== process.pid && alive(h.pid) && Date.now() - Date.parse(h.at) <= staleMs(c) ? h : null;
}
// fn(beat) under the lock; null (fn not run) while another live translator holds it.
function withTranslator(c, fn) {
  const file = translatorLock(c);
  mkdirSync(dirname(file), { recursive: true });
  const rec = () => JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  let got = false;
  for (let i = 0; i < 2 && !got; i++) {
    try { writeFileSync(file, rec(), { flag: 'wx' }); got = true; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (i || translatorRunning(c)) return null;
      rmSync(file, { force: true });
    }
  }
  if (!got) return null;
  const mine = () => lockRecord(file)?.pid === process.pid;
  try { return fn(() => { try { if (mine()) writeFileSync(file, rec()); } catch { /* best effort */ } }); } finally { if (mine()) rmSync(file, { force: true }); }
}

// The detached process (`product view --translate --quiet`): every missing string, then the page. Never throws.
export function translateInBackground(c0, { lang = null } = {}) {
  const c = mainCtx(c0);
  try {
    return withTranslator(c, (beat) => {
      const t = translateView(c, { lang, onBatch: beat });
      writeView(c, { lang });
      return t;
    });
  } catch { return null; }
}

// Starts the background translator unless one runs. → {pid} | {running: pid} | null (could not start).
function startTranslator(c) {
  const busy = translatorRunning(c);
  if (busy) return { running: busy.pid };
  const p = spawnDetached(process.execPath, [join(ROOT, 'scripts', 'dwmt.mjs'), 'product', 'view', '--translate', '--quiet'], { cwd: c.top });
  return p ? { pid: p.pid ?? null } : null;
}

// ---------- regeneration hook (commit, sync, brief, intake) ----------

// Never throws: errors become one warning. `translate` (after `product commit`): when the page has untranslated strings,
// the language is not en and `product.view.translate` is not false, the background translator starts (detached; it
// regenerates the page when done); the caller never waits for the model.
export function refreshView(c0, { translate = false } = {}) {
  const c = mainCtx(c0);
  const view = c.pc.view ?? {};
  if (view.enabled === false || !existsSync(c.P.dir)) return {};
  const out = {};
  try {
    const r = writeView(c);
    if (translate && view.translate !== false && r.language !== 'en' && r.untranslated) {
      const t = startTranslator(c);
      if (t) out.viewTranslating = { strings: r.untranslated, ...t };
      else out.viewWarning = 'view translation: the background translator did not start (product view --translate)';
    }
  } catch (e) { out.viewWarning = `view: ${String(e.message).split(/\r?\n/)[0]}`; }
  return out;
}
