// dwmt D4: pliki warstwy produktowej (spec warstwy produktowej §3): ścieżki, blokada zapisu, schematy, budżety, odczyt i zapis.
// Pliki produktu (`product.dir`, w gicie) pisze tylko skrypt; robocze (`.dwmt/product/`, poza gitem): lock, state.json,
// proposals.jsonl, inbox.jsonl, changes.jsonl (dziennik zmian dla `commit` i `brief --for`), import/, estimate-E-n/.
// Zapis: plik tymczasowy + rename (util.writeFileAtomic), zawsze LF.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fwd, read, asList, writeFileAtomic } from './util.mjs';
import { splitHeader, parseYaml } from './headers.mjs';
import { alive } from '../machine.mjs';
import { clearGitMemo } from './git.mjs';

export const TYPES = ['idea', 'feature', 'bug', 'debt', 'change', 'remark', 'mockups'];
export const SEVS = ['blocker', 'major', 'minor'];
export const ITEM_STATES = ['new', 'open', 'planned', 'done', 'dropped'];
export const TRIAGES = ['now', 'touch', 'later', 'never'];
// `todo` (§3.9): it is clear what the sprint is about (decision-maker and PO agreed); `ready` stays the readiness gate (DoR).
export const SPRINT_STATES = ['topic', 'notes', 'todo', 'ready', 'ordered', 'running', 'done'];
// Human states of the read-only view (§3.9): key → label.
export const HUMAN_STATES = { draft: 'Draft', todo: 'To do', inprogress: 'In progress', review: 'Awaiting review' };
const HUMAN_OF = { topic: 'draft', notes: 'draft', todo: 'todo', ready: 'todo', ordered: 'inprogress', running: 'inprogress', done: 'review' };
// Roadmap line → human state key. An archived sprint (`{archived: true, uat}`, or its header with `actual.uat`) is `review`
// while its UAT is pending, else null (closed).
export function humanState(l) {
  if (!l) return null;
  if (!l.archived && HUMAN_OF[l.state]) return HUMAN_OF[l.state];
  const uat = l.uat ?? l.actual?.uat ?? l.h?.actual?.uat ?? l.header?.actual?.uat ?? null;
  return uat === 'pending' ? 'review' : null;
}
export const SPEC_KINDS = ['feature', 'bugfix', 'maintenance'];
// W-7: `fix` (sprint poprawek z uwag recenzji albo UAT) to ten sam rodzaj co `bugfix`.
export const specKind = (v) => (v === 'fix' ? 'bugfix' : v);
export const SPEC_MODES = ['direct', 'inline', 'intermediate', 'single', 'auto'];
// Budżety rozmiaru (§3.2); próg odrzucenia pliku sprintu: ZAŁOŻENIE spec (6 KB).
export const BUDGET = { title: 90, note: 300, detailLines: 40, decisionLines: 8, roadmapBytes: 2048, roadmapLine: 160, specWarnB: 3072, specMaxB: 6144, visionLines: 15, expertLines: 40, goal: 90, forYouB: 2048 };
// `from` (D-13, K2): source sprint of a review remark (`sprint` means planned in); null for other items and old lines.
export const ITEM_KEYS = ['id', 'alias', 'type', 'title', 'note', 'sev', 'state', 'triage', 'anchors', 'src', 'from', 'at', 'sprint', 'est', 'detail'];
const SPEC_KEYS = ['schema', 'id', 'kind', 'goal', 'items', 'touch', 'refs', 'uatGate', 'ui', 'mode', 'workTree', 'est', 'ready', 'run', 'actual', 'src'];
// v2 (2026-10-04, decyzja użytkownika): tabele markdown zamiast linii z „ · ” — czytelne w podglądzie, ok. 7% mniej znaków
// (etykiety raz w nagłówku). Odczyt rozumie też format @1; zapis zawsze @2.
export const ROADMAP_HEAD = '# dwmt/roadmap@2 — row order = work order; ▶ = current';
export const INDEX_HEAD = '# dwmt/archive-index@2 — closed sprints';
const ROADMAP_COLS = ['', 'id', 'state', 'goal', 'after', 'detail', 'alias'];
const INDEX_COLS = ['id', 'goal', 'merged', 'run', 'files', 'tokensM', 'lines'];
const tableRow = (cells) => `| ${cells.join(' | ')} |`.replace(/ {2,}\|/g, ' |');
const tableHead = (cols) => `${tableRow(cols)}\n|${cols.map(() => '---').join('|')}|\n`;
// Wiersz tabeli → komórki; null dla nagłówka (komórka `head.at` = `head.name`) i separatora.
function tableCells(raw, head) {
  const cells = raw.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((x) => x.trim());
  if (cells.every((x) => /^:?-*:?$/.test(x)) || cells[head.at] === head.name) return null;
  return cells;
}
export const DECISIONS_HEAD = '# dwmt/decisions@1 — active decisions, one section each (≤ 8 lines); superseded ones in decisions-archive.md';
export const DECISIONS_ARCHIVE_HEAD = '# dwmt/decisions@1 — superseded decisions';

export const today = () => new Date().toISOString().slice(0, 10);
export const SPRINT_ID = /^[a-z0-9][a-z0-9._-]*$/;

export function paths(top, pc) {
  const d = pc.abs;
  const w = join(top, '.dwmt', 'product');
  return {
    top, dir: d, rel: fwd(pc.dir).replace(/\/$/, ''), backlog: join(d, 'backlog.jsonl'), backlogArchive: join(d, 'backlog-archive.jsonl'), items: join(d, 'items'),
    decisions: join(d, 'decisions.md'), decisionsArchive: join(d, 'decisions-archive.md'), roadmap: join(d, 'roadmap.md'), sprints: join(d, 'sprints'),
    archive: join(d, 'archive'), archiveIndex: join(d, 'archive', 'index.md'), estimates: join(d, 'estimates.jsonl'), workplaces: join(d, 'workplaces.jsonl'), vision: join(d, 'vision.md'), experts: join(d, 'experts'),
    work: w, lock: join(w, 'lock'), state: join(w, 'state.json'), proposals: join(w, 'proposals.jsonl'), inbox: join(w, 'inbox.jsonl'), changes: join(w, 'changes.jsonl'), import: join(w, 'import'),
  };
}

export function put(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, text.replace(/\r\n/g, '\n'));
}

// ---------- blokada zapisu (§7): plik {pid, at}; martwa (proces nie żyje) albo starsza niż 2 min jest przejmowana ----------

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// Recenzja N-4 (jak blokada sterownika po N-2): martwą blokadę usuwa tylko proces, który założył `lock.takeover` (`wx`),
// i tylko gdy plik ma dalej oceniony rekord; zwolnienie usuwa plik tylko z własnym rekordem (pid, at, nonce), bo blokadę
// starszą niż 2 min mógł przejąć inny proces.
// Recenzja S3 (11): blokada wielokrotnego wejścia w tym samym procesie (`intake` commituje pod blokadą, a `productCommit`
// zapisuje stan przez `updateState`, który bierze ją znowu).
const heldLocks = new Map();
export function withLock(P, fn, opts = {}) {
  const key = fwd(P.lock).toLowerCase();
  if (heldLocks.has(key)) {
    heldLocks.set(key, heldLocks.get(key) + 1);
    try { return fn(); } finally { heldLocks.set(key, heldLocks.get(key) - 1); }
  }
  heldLocks.set(key, 1);
  try { return lockOnce(P, fn, opts); } finally { heldLocks.delete(key); }
}
function lockOnce(P, fn, { timeoutMs = 20000 } = {}) {
  mkdirSync(P.work, { recursive: true });
  const guard = `${P.lock}.takeover`;
  const raw = () => { try { return read(P.lock); } catch { return null; } };
  const t0 = Date.now();
  let mine = null;
  let retried = false;
  for (;;) {
    const rec = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), nonce: Math.random().toString(36).slice(2, 10) });
    try { writeFileSync(P.lock, rec, { flag: 'wx' }); mine = rec; break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const seen = raw();
      let h = null;
      try { h = JSON.parse(seen); } catch { /* zapis w toku albo zwolniona */ }
      let stale = false;
      if (h) stale = !alive(h.pid) || Date.now() - Date.parse(h.at) > 120000;
      else { try { stale = Date.now() - statSync(P.lock).mtimeMs > 5000; } catch { continue; } }
      if (stale) {
        try { if (Date.now() - statSync(guard).mtimeMs > 30000) rmSync(guard, { force: true }); } catch { /* brak znacznika */ }
        let got = false;
        try { writeFileSync(guard, String(process.pid), { flag: 'wx' }); got = true; } catch (e2) { if (e2.code !== 'EEXIST') throw e2; }
        if (got) { try { if (raw() === seen) rmSync(P.lock, { force: true }); } finally { rmSync(guard, { force: true }); } continue; }
      }
      if (Date.now() - t0 > timeoutMs) throw new Error(`blokada zapisu produktu zajęta (pid ${h?.pid ?? '?'}): ${fwd(P.lock)}`);
      retried = true;
      sleep(25 + Math.floor(Math.random() * 25));
    }
  }
  if (retried) clearGitMemo(); // another process held the lock meanwhile
  try { return fn(); } finally { if (raw() === mine) rmSync(P.lock, { force: true, maxRetries: 10, retryDelay: 20 }); }
}

// ---------- JSONL ----------

export function readJsonl(file) {
  if (!existsSync(file)) return [];
  return read(file).split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
    try { return JSON.parse(l); } catch { throw new Error(`${fwd(file)}:${i + 1}: zła linia JSON`); }
  });
}
export const writeJsonl = (file, rows) => put(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
export const appendJsonl = (file, rows) => { mkdirSync(dirname(file), { recursive: true }); if (rows.length) appendFileSync(file, rows.map((r) => `${JSON.stringify(r)}\n`).join('')); };

// ---------- pozycje (§3.3) ----------

export const normItem = (x) => Object.fromEntries(ITEM_KEYS.map((k) => [k, x[k] === undefined ? (k === 'anchors' ? [] : k === 'detail' ? false : null) : x[k]]));
const validTriage = (t) => t === null || TRIAGES.includes(t) || /^sprint:[\w.-]+$/.test(t);
export function itemErrors(x) {
  const e = [];
  const who = x.id ?? x.alias ?? x.title ?? '?';
  if (!TYPES.includes(x.type)) e.push(`${who}: type ${x.type}, dozwolone ${TYPES.join('|')}`);
  if (!x.title || typeof x.title !== 'string') e.push(`${who}: brak title`);
  else if (x.title.length > BUDGET.title) e.push(`${who}: title ${x.title.length} > ${BUDGET.title} znaków: skróć albo przenieś do szczegółów`);
  if (x.note != null && String(x.note).length > BUDGET.note) e.push(`${who}: note ${String(x.note).length} > ${BUDGET.note} znaków: skróć albo przenieś do szczegółów (--detail)`);
  if (x.sev != null && !SEVS.includes(x.sev)) e.push(`${who}: sev ${x.sev}, dozwolone ${SEVS.join('|')}`);
  if (!ITEM_STATES.includes(x.state)) e.push(`${who}: state ${x.state}, dozwolone ${ITEM_STATES.join('|')}`);
  if (!validTriage(x.triage)) e.push(`${who}: triage ${x.triage}, dozwolone now|sprint:<id>|touch|later|never`);
  if (!Array.isArray(x.anchors)) e.push(`${who}: anchors musi być listą`);
  else {
    if (x.triage === 'touch' && !x.anchors.length) e.push(`${who}: triage touch wymaga kotwic (anchors)`);
    for (const a of x.anchors) if (/:\d+(-\d+)?$/.test(String(a))) e.push(`${who}: kotwica ${a} z numerem linii: użyj ścieżki albo ścieżka#Symbol (Z11)`);
  }
  if (x.alias != null && !/^\S{1,40}$/.test(String(x.alias))) e.push(`${who}: alias bez spacji, ≤ 40 znaków`);
  if (x.from != null && (typeof x.from !== 'string' || !/^\S+$/.test(x.from))) e.push(`${who}: from ${JSON.stringify(x.from)}: id sprintu bez spacji albo null`);
  return e;
}
export const maxNum = (ids, prefix) => Math.max(0, ...ids.map((i) => (new RegExp(`^${prefix}-(\\d+)$`).exec(String(i)) || [])[1]).filter(Boolean).map(Number));

export function loadItems(P) { return { open: readJsonl(P.backlog), archived: readJsonl(P.backlogArchive) }; }
export function findItem(P, ref) {
  const { open, archived } = loadItems(P);
  const key = String(ref).toLowerCase();
  const m = (x) => String(x.id).toLowerCase() === key || (x.alias != null && String(x.alias).toLowerCase() === key);
  const o = open.find(m);
  if (o) return { item: o, archived: false };
  const a = archived.find(m);
  return a ? { item: a, archived: true } : null;
}
export const itemLine = (x) => `${x.id} ${x.type}${x.sev ? ` ${x.sev}` : ''} ${x.state}${x.triage ? ` ${x.triage}` : ''}${x.alias ? ` (${x.alias})` : ''}: ${x.title}`;

// ---------- rejestr decyzji (§3.4) ----------

export function parseDecisions(text) {
  const out = [];
  let cur = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const h = /^###\s+(PD-\d+)\s+(.*)$/.exec(line);
    if (h) { cur = { id: h[1], title: h[2].trim(), lines: [] }; out.push(cur); continue; }
    if (cur && line.trim()) cur.lines.push(line.trimEnd());
  }
  for (const d of out) {
    const meta = d.lines[0] && /^area:/.test(d.lines[0]) ? d.lines[0] : '';
    d.meta = Object.fromEntries(meta.split(';').map((p) => p.trim()).filter(Boolean).map((p) => { const i = p.indexOf(':'); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }));
    const field = (k) => d.lines.find((l) => l.startsWith(`${k}:`))?.slice(k.length + 1).trim() ?? null;
    Object.assign(d, { area: d.meta.area ?? null, at: d.meta.at ?? null, src: d.meta.src ?? null, by: d.meta.by ?? null, decision: field('Decision'), supersedes: field('Supersedes') });
  }
  return out;
}
export const renderDecision = (d) => [`### ${d.id} ${d.title}`, ...d.lines].join('\n');
export const renderDecisions = (head, list) => `${head}\n${list.map((d) => `\n${renderDecision(d)}\n`).join('')}`;
export function loadDecisions(P) {
  return { active: existsSync(P.decisions) ? parseDecisions(read(P.decisions)) : [], archived: existsSync(P.decisionsArchive) ? parseDecisions(read(P.decisionsArchive)) : [] };
}

// Wpis z pól: tytuł, obszar, decyzja, dlaczego, odrzucone, wbrew rekomendacji, potwierdzenie, źródło, kto.
export function decisionEntry(id, f) {
  const clean = (s) => String(s ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();
  const lines = [`area: ${clean(f.area) || 'general'}; at: ${f.at || today()}; src: ${clean(f.src) || '-'}; by: ${f.by || 'po'}`, `Decision: ${clean(f.decision)}`];
  if (clean(f.why)) lines.push(`Why: ${clean(f.why)}`);
  if (clean(f.rejected)) lines.push(`Rejected: ${clean(f.rejected)}`);
  lines.push(`Against recommendation: ${clean(f.against) ? `yes — ${clean(f.against)}` : 'no'}`);
  if (f.confirmed) lines.push(`Confirmed: ${JSON.stringify(clean(f.confirmed))}`);
  if (f.supersedes) lines.push(`Supersedes: ${f.supersedes}`);
  return { id, title: clean(f.title), lines };
}
export function decisionErrors(d) {
  const e = [];
  if (!d.title) e.push('decyzja: brak tytułu');
  else if (d.title.length > BUDGET.title) e.push(`decyzja: tytuł ${d.title.length} > ${BUDGET.title} znaków`);
  if (!d.lines.some((l) => /^Decision: \S/.test(l))) e.push('decyzja: brak treści (Decision)');
  if (d.lines.length + 1 > BUDGET.decisionLines) e.push(`decyzja: ${d.lines.length + 1} linii > ${BUDGET.decisionLines}: skróć`);
  if (d.lines.some((l) => l.length > 400)) e.push('decyzja: linia ponad 400 znaków: skróć');
  return e;
}

// ---------- roadmapa (§3.9) ----------

export function parseRoadmap(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    if (!raw.trim() || raw.startsWith('#')) continue;
    if (/^\|/.test(raw)) {
      const c = tableCells(raw, { at: 1, name: 'id' });
      if (!c) continue;
      if (c.length < 6) throw new Error(`roadmap.md: zły wiersz: ${raw}`);
      out.push({ id: c[1], state: c[2], goal: c[3], after: c[4].split(',').map((x) => x.trim()).filter(Boolean), detail: c[5] || 'none', alias: c[6] || null, current: !!c[0] });
      continue;
    }
    const current = /^\*\s+/.test(raw);
    const parts = raw.replace(/^\*\s+/, '').split(' · ').map((s) => s.trim());
    if (parts.length < 5) throw new Error(`roadmap.md: zła linia: ${raw}`);
    const [id, state, goal, ...rest] = parts;
    const kv = Object.fromEntries(rest.map((p) => { const i = p.indexOf(':'); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }));
    const after = String(kv.after ?? '[]').replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
    out.push({ id, state, goal, after, detail: kv.detail ?? 'none', alias: kv.alias ?? null, current });
  }
  return out;
}
export const roadmapLine = (l) => `${l.current ? '* ' : ''}${l.id} · ${l.state} · ${l.goal} · after: [${l.after.join(', ')}] · detail: ${l.detail}${l.alias ? ` · alias: ${l.alias}` : ''}`;
// Wiersz pliku (tabela); `roadmapLine` zostaje zwięzłą linią w wynikach komend.
export const roadmapRow = (l) => tableRow([l.current ? '▶' : '', l.id, l.state, l.goal, l.after.join(', '), l.detail, l.alias ?? '']);
export const renderRoadmap = (lines) => `${ROADMAP_HEAD}\n\n${tableHead(ROADMAP_COLS)}${lines.map((l) => `${roadmapRow(l)}\n`).join('')}`;
export const loadRoadmap = (P) => (existsSync(P.roadmap) ? parseRoadmap(read(P.roadmap)) : []);

// Indeks archiwum (§3.9): zamknięte sprinty, po jednej linii.
export function parseIndex(text) {
  return String(text ?? '').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => (/^\|/.test(l) ? tableCells(l, { at: 0, name: 'id' }) : l.split(' · ').map((s) => s.trim()))).filter(Boolean).map(([id, goal, merged, run, files, tokensM, lines]) => {
    const num = (v) => (v == null || v === '-' || v === '' ? null : Number(v));
    return { id, goal: goal ?? '-', merged: merged ?? '-', run: run && run !== '-' ? run : null, files: num(files), tokensM: num(tokensM), lines: num(lines) };
  });
}
// Cel w archiwum bez „|” (pochodzi z importu albo z roadmapy).
export const indexLine = (x) => tableRow([x.id, String(x.goal || '-').replace(/\|/g, '/'), x.merged || '-', x.run || '-', x.files ?? '-', x.tokensM ?? '-', x.lines ?? '-']);
export const renderIndex = (rows) => `${INDEX_HEAD}\n\n${tableHead(INDEX_COLS)}${rows.map((r) => `${indexLine(r)}\n`).join('')}`;
export const loadIndex = (P) => (existsSync(P.archiveIndex) ? parseIndex(read(P.archiveIndex)) : []);
// Całość od nowa: plik @1 przechodzi na tabelę przy pierwszym dopisaniu.
export function appendIndex(P, rows) {
  writeIndex(P, [...loadIndex(P), ...rows]);
}
// Rewrites the whole archive index from a row list.
export const writeIndex = (P, rows) => put(P.archiveIndex, renderIndex(rows));

// Sprint scalony = w archiwum albo w stanie `done` (czeka na UAT).
export const merged = (id, lines, index) => index.some((x) => x.id === id) || lines.some((l) => l.id === id && l.state === 'done');

// Walidacja roadmapy: unikalne id, stany, kolejność zależności, istnienie `after`, detail, budżet.
export function roadmapErrors(lines, index) {
  const e = [];
  const seen = new Map();
  lines.forEach((l, i) => {
    if (!SPRINT_ID.test(l.id)) e.push(`${l.id}: identyfikator [a-z0-9._-]`);
    if (seen.has(l.id)) e.push(`${l.id}: powtórzony identyfikator`);
    seen.set(l.id, i);
    if (!SPRINT_STATES.includes(l.state)) e.push(`${l.id}: stan ${l.state}, dozwolone ${SPRINT_STATES.join('|')}`);
    if (!l.goal || l.goal.length > BUDGET.goal) e.push(`${l.id}: cel pusty albo > ${BUDGET.goal} znaków`);
    if (/\|/.test(l.goal) || /\r|\n/.test(l.goal)) e.push(`${l.id}: cel bez „|” i nowych linii`);
    if (l.state === 'topic' ? l.detail !== 'none' : l.detail !== `sprints/${l.id}.md`) e.push(`${l.id}: detail ${l.detail}: przy topic none, inaczej sprints/${l.id}.md`);
    if (l.alias && (/\|/.test(l.alias) || l.alias.length > 30)) e.push(`${l.id}: alias ≤ 30 znaków, bez „|”`);
    if (roadmapRow({ ...l, current: true }).length > BUDGET.roadmapLine) e.push(`${l.id}: wiersz > ${BUDGET.roadmapLine} znaków: skróć cel`);
  });
  lines.forEach((l, i) => {
    for (const a of l.after) {
      if (a === l.id) e.push(`${l.id}: zależy od siebie`);
      else if (seen.has(a)) { if (seen.get(a) > i) e.push(`${l.id}: stoi przed swoją zależnością ${a}`); } else if (!index.some((x) => x.id === a)) e.push(`${l.id}: zależność ${a} nie istnieje w roadmapie ani w archiwum`);
    }
  });
  // K5 D-19: the budget counts the header and the rows not `done` (done rows wait only for UAT and leave with the archive).
  const open = lines.filter((l) => l.state !== 'done');
  const bytes = Buffer.byteLength(renderRoadmap(open.map((l) => ({ ...l, current: false }))));
  // Przegląd 2026-10-09 (W-7): PO trafiał na limit 2 KB kilka razy przy zakładaniu sprintu poprawek; komunikat podaje składnię
  // i najdłuższe cele (limit bez zmian).
  if (bytes > BUDGET.roadmapBytes) {
    const longest = [...open].sort((a, b) => b.goal.length - a.goal.length).slice(0, 3).map((l) => `${l.id} (${l.goal.length} zn.)`).join(', ');
    e.push(`roadmap.md: ${bytes} B > ${BUDGET.roadmapBytes} B (o ${bytes - BUDGET.roadmapBytes} B za dużo): skróć cele \`product roadmap set <id> goal "<krótko>"\` (najdłuższe: ${longest}) albo zamień dalekie tematy na pozycje later \`product roadmap drop <id>\` + \`product item add --type idea --title "<temat>"\` i \`product triage <B-n> later\``);
  }
  return e;
}

// Next sprint (§4.9): the first line in roadmap order that is To do (`todo` or `ready`) with `after` merged; `also` = the other
// `ready` lines with `after` merged (they can run without the user); without any, the first `topic`/`notes` with `after` merged.
export function nextSprint(lines, index) {
  const met = (l) => l.after.every((a) => merged(a, lines, index));
  const first = lines.find((l) => ['todo', 'ready'].includes(l.state) && met(l));
  if (first) {
    const also = lines.filter((l) => l !== first && l.state === 'ready' && met(l)).map((l) => l.id);
    return { line: first, why: first.state === 'ready' ? 'ready, dependencies merged' : 'to do, dependencies merged: close price, mockups and last questions, then product ready (§4.8)', also };
  }
  const t = lines.find((l) => ['topic', 'notes'].includes(l.state) && met(l));
  if (t) return { line: t, why: `${t.state}: no to-do sprint with dependencies merged; agree what it is about (todo), then lead it to ready (§4.8)`, also: [] };
  return null;
}
// Znacznik `*`: sprinty `running`, a bez nich wynik `next`.
export function markCurrent(lines, index) {
  const running = lines.filter((l) => l.state === 'running').map((l) => l.id);
  const cur = running.length ? running : [nextSprint(lines, index)?.line.id].filter(Boolean);
  return lines.map((l) => ({ ...l, current: cur.includes(l.id) }));
}

// ---------- plik sprintu (§3.5) ----------

export const specFile = (P, id) => join(P.sprints, `${id}.md`);
export const archiveSpecFile = (P, id) => join(P.archive, `${id}.md`);
export const readSpec = (P, id) => readSpecAt(specFile(P, id));
export function readSpecAt(file) {
  if (!existsSync(file)) return null;
  const text = read(file).replace(/\r\n/g, '\n');
  const s = splitHeader(text);
  if (!s) throw new Error(`${fwd(file)}: brak nagłówka YAML`);
  const h = parseYaml(s.yaml);
  for (const k of ['items', 'touch', 'refs']) h[k] = asList(h[k]);
  return { file, h, body: s.body.replace(/^\n+/, ''), text };
}
export function renderSpec(h, body) {
  const keys = [...SPEC_KEYS.filter((k) => k in h), ...Object.keys(h).filter((k) => !SPEC_KEYS.includes(k))];
  return `---\n${keys.map((k) => `${k}: ${JSON.stringify(h[k] ?? null)}`).join('\n')}\n---\n\n${String(body ?? '').replace(/\r\n/g, '\n').trim()}\n`;
}
// The `## For you` section (human view, §3.5) has its own budget and does not count toward the sprint file budget.
export function specSizeCheck(text) {
  const b = Buffer.byteLength(stripForYou(text));
  if (b > BUDGET.specMaxB) return { error: `plik sprintu ${b} B > ${BUDGET.specMaxB} B: skróć albo przenieś do szczegółów pozycji` };
  return b > BUDGET.specWarnB ? { warning: `plik sprintu ${b} B > ${BUDGET.specWarnB} B (cel ok. 3 KB)` } : {};
}
export const writeSpec = (P, id, h, body) => writeSpecAt(specFile(P, id), h, body);
// A new or changed `## For you` is validated (format, budget); an unchanged one never blocks other writes. More than one
// For you section is refused (agents would get none of them, the user only the first).
// K5 D-18: what writeSpecAt checks, without writing (multi-write commands check every file before the first write).
// → {errors, warnings, text}.
export function specWriteErrors(file, h, body) {
  const errors = [];
  const warnings = [];
  const n = forYouCount(body);
  if (n > 1) errors.push(`For you: ${n} sections, keep one (spec set <id> --section "For you" --file <f> replaces them all)`);
  const text = renderSpec(h, body);
  const c = specSizeCheck(text);
  if (c.error) errors.push(c.error);
  if (c.warning) warnings.push(c.warning);
  const fy = forYouText(body);
  if (n <= 1 && fy !== null && fy !== (existsSync(file) ? forYouText(read(file)) : null)) {
    const v = checkForYou(body);
    errors.push(...v.errors);
    warnings.push(...v.warnings);
  }
  return { errors, warnings, text };
}
export function writeSpecAt(file, h, body) {
  const c = specWriteErrors(file, h, body);
  if (c.errors.length) throw new Error(c.errors.join('; '));
  put(file, c.text);
  return c.warnings.join('; ') || null;
}
// Sekcje `## Name` treści pliku sprintu.
export function specSections(body) {
  const out = {};
  let cur = null;
  for (const line of String(body).split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) { cur = m[1]; out[cur] = []; continue; }
    if (cur) out[cur].push(line);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n').trim()]));
}
// A sprint file that says what the sprint is about: goal and acceptance filled (one-time `notes` → `todo` migration, §3.9).
const filled = (t) => String(t ?? '').split('\n').some((x) => x.trim() && !/^[-*]?\s*(none|-)?\s*$/i.test(x.trim()));
export const specAgreed = (body) => { const sec = specSections(body); return filled(sec.Goal) && filled(sec.Acceptance); };
// `## For you` matches in any letter case; setting it replaces every For you section with one (at the first one's place).
export function setSection(body, name, text) {
  if (isForYou(name)) {
    const lines = bodyLines(body);
    const rs = forYouRanges(lines);
    const block = [`## ${FOR_YOU}`, String(text).replace(/\r\n/g, '\n').trim().replace(/^##\s+For you\s*(\n|$)/i, '').trim()];
    if (!rs.length) return `${String(body).trimEnd()}\n\n${block.join('\n')}\n`;
    const out = [];
    lines.forEach((l, i) => {
      const r = rs.find(([a, b]) => i >= a && i < b);
      if (!r) out.push(l);
      else if (i === rs[0][0]) out.push(...block, '');
    });
    return out.join('\n').replace(/\n{3,}/g, '\n\n');
  }
  const lines = String(body).split('\n');
  const at = lines.findIndex((l) => new RegExp(`^##\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`).test(l));
  const block = [`## ${name}`, String(text).trim()];
  if (at < 0) return `${String(body).trimEnd()}\n\n${block.join('\n')}\n`;
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) if (/^##\s/.test(lines[i])) { end = i; break; }
  return [...lines.slice(0, at), ...block, '', ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n');
}

// ---------- `## For you` (§3.5): the decision-maker's section, never in agent inputs ----------

export const FOR_YOU = 'For you';
const FOR_YOU_LISTS = { changes: 'Changes', notIncluded: 'Not included', check: 'Check' };
const FOR_YOU_LABEL = /^(title|why|changes|not included|check)\s*:\s*(.*)$/i;
const FOR_YOU_KEY = { title: 'title', why: 'why', changes: 'changes', 'not included': 'notIncluded', check: 'check' };
const FOR_YOU_HEAD = /^##\s+For you\s*$/i;
const LIST_ITEM = /^(?:[-*]|\d+[.)])\s+(.*)$/;
export const isForYou = (name) => /^\s*for you\s*$/i.test(String(name ?? ''));
// Lines [start, end) of every For you section (heading included), in file order.
function forYouRanges(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!FOR_YOU_HEAD.test(lines[i])) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) if (/^##\s/.test(lines[j])) { end = j; break; }
    out.push([i, end]);
    i = end - 1;
  }
  return out;
}
const bodyLines = (body) => String(body ?? '').replace(/\r\n/g, '\n').split('\n');
export const forYouCount = (body) => forYouRanges(bodyLines(body)).length;
// Content of the first section without the heading, trimmed; null without the section.
export function forYouText(body) {
  const lines = bodyLines(body);
  const r = forYouRanges(lines)[0];
  return r ? lines.slice(r[0] + 1, r[1]).join('\n').trim() : null;
}
// The text without any For you section (agents' inputs).
export function stripForYou(body) {
  const lines = bodyLines(body);
  const rs = forYouRanges(lines);
  if (!rs.length) return String(body ?? '');
  return lines.filter((_, i) => !rs.some(([a, b]) => i >= a && i < b)).join('\n').replace(/\n{3,}/g, '\n\n');
}
// A label starts an unindented line; an indented line that looks like a label continues the previous value.
// List items: `- `, `* `, `1. `, `1) `.
function readForYou(raw) {
  const f = { title: '', why: '', changes: [], notIncluded: [], check: [], stray: [] };
  let cur = null;
  for (const line of String(raw).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const m = /^\S/.test(line) ? FOR_YOU_LABEL.exec(t) : null;
    if (m) {
      cur = FOR_YOU_KEY[m[1].toLowerCase()];
      if (Array.isArray(f[cur])) { if (m[2].trim()) f[cur].push(m[2].trim().replace(/^(?:[-*]|\d+[.)])\s+/, '')); } else f[cur] = m[2].trim();
      continue;
    }
    const li = LIST_ITEM.exec(t);
    if (li && Array.isArray(f[cur])) f[cur].push(li[1].trim());
    else if (cur === 'title' || cur === 'why') f[cur] = `${f[cur]} ${t}`.trim();
    else if (Array.isArray(f[cur]) && f[cur].length) f[cur][f[cur].length - 1] += ` ${t}`;
    else f.stray.push(t);
  }
  return f;
}
// → {title, why, changes[], notIncluded[], check[]}; null without the section or without Title and Why.
export function parseForYou(body) {
  const raw = forYouText(body);
  if (raw === null) return null;
  const { stray, ...f } = readForYou(raw);
  return f.title && f.why ? f : null;
}
// Section content (without the heading) from fields.
export function renderForYou(f) {
  const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const list = (k) => (asList(f[k]).map(one).filter(Boolean).length ? [`${FOR_YOU_LISTS[k]}:`, ...asList(f[k]).map(one).filter(Boolean).map((x) => `- ${x}`)] : []);
  return [`Title: ${one(f.title)}`, `Why: ${one(f.why)}`, ...list('changes'), ...list('notIncluded'), ...list('check')].join('\n');
}
// Identifiers and file paths do not belong in the user's section (plain words): a warning, not an error.
const FOR_YOU_NOISE = /\b(?:AC|PD|SD|B|C|D|E|F|T)-\d+\b|(?:^|\s)[\w.-]+\/[\w./-]*\.\w+/;
export function checkForYou(body) {
  const raw = forYouText(body);
  if (raw === null) return { errors: [], warnings: [] };
  const errors = [];
  const f = readForYou(raw);
  const bytes = Buffer.byteLength(`## ${FOR_YOU}\n${raw}\n`);
  if (bytes > BUDGET.forYouB) errors.push(`For you: ${bytes} B > ${BUDGET.forYouB} B: shorten`);
  if (!f.title) errors.push('For you: missing "Title: <short title>"');
  else if (f.title.length > BUDGET.title) errors.push(`For you: Title ${f.title.length} > ${BUDGET.title} characters`);
  if (!f.why) errors.push('For you: missing "Why: <what the user gets>"');
  if (f.stray.length) errors.push(`For you: line outside the format (Title, Why, Changes, Not included, Check): ${f.stray[0].slice(0, 60)}`);
  return { errors, warnings: FOR_YOU_NOISE.test(raw) ? ['For you: identifiers or file paths found; the section is for the user: plain words, what they see'] : [] };
}

// ---------- szacunki, stan, dzienniki ----------

export const loadEstimates = (P) => readJsonl(P.estimates);
export function loadState(P) {
  try { const s = JSON.parse(read(P.state)); return { lastBrief: {}, doorBrief: {}, sessions: {}, ...s }; } catch { return { lastBrief: {}, doorBrief: {}, sessions: {} }; }
}
export const saveState = (P, s) => put(P.state, `${JSON.stringify(s, null, 2)}\n`);
// Zmiana stanu pod blokadą (recenzja N-4): odczyt świeżego stanu i zapis w jednej sekcji, bez gubienia zapisów innych drzwi.
export const updateState = (P, patch) => withLock(P, () => { const s = loadState(P); const next = { ...s, ...patch(s) }; saveState(P, next); return next; });
// Dziennik zmian: opis commita (`product commit`) i „co się zmieniło” dla `brief --for`.
export const logChange = (P, text, extra = {}) => appendJsonl(P.changes, [{ at: new Date().toISOString(), text, ...extra }]);
export const loadChanges = (P) => { try { return readJsonl(P.changes); } catch { return []; } };

export const listSprintFiles = (P) => (existsSync(P.sprints) ? readdirSync(P.sprints).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)) : []);
