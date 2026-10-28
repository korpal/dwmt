// dwmt D4: import starych dokumentów projektu do formatu PO (spec warstwy produktowej §3.10). Narzędzie generyczne: specyfika
// projektu (ścieżki, adapter, reguły cięcia) jest tylko w `product.import.sources`. Przebieg: gałąź importu → wyciąg (adapter,
// 0 tokenów) → kondensacja (agent `dwmt-importer`, `claude -p`, paczki po ok. 40 kawałków; wynik paczki zostaje na dysku, więc
// ponowny `run` jej nie powtarza) → zapis skryptem (walidacja, pominięcie istniejących `src`) → commit na gałęzi importu.
// Idempotencja po `src: import:<plik>#<znacznik>`; kawałek ponad 4k znaków dzielony (`#znacznik+2`).
import { existsSync, readdirSync, mkdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { ROOT, fwd, read, asList } from './util.mjs';
import { git, gitRaw, clearGitMemo } from './git.mjs';
import { sessionsCost, leanPlugins } from './sessions.mjs';
import { trackedFiles, globMatcher, r1 } from './price.mjs';
import {
  BUDGET, SPRINT_ID, put, withLock, readJsonl, writeJsonl, loadItems, loadDecisions, loadRoadmap, loadIndex, appendIndex, renderRoadmap,
  markCurrent, roadmapErrors, writeSpec, logChange, today, ROADMAP_HEAD, INDEX_HEAD, DECISIONS_HEAD, renderIndex,
} from './product-store.mjs';

export const KINDS = ['roadmap', 'sprint', 'item', 'decision', 'done', 'ref', 'skip'];
const MOVED = ['roadmap', 'sprint', 'item', 'decision', 'done'];
const LIST_KINDS = ['item', 'decision', 'done'];
export const CHUNK_MAX = 4000;
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'x';
const hash = (s) => createHash('sha1').update(String(s).replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 8);

// ---------- reguły ----------

function compileRules(src, defaults = []) {
  return [...asList(src.rules), ...defaults].map((r, i) => {
    if (!KINDS.includes(r.kind)) throw new Error(`import.sources ${src.name}: reguła ${r.name ?? i + 1}: kind ${r.kind}, dozwolone ${KINDS.join('|')}`);
    return { ...r, name: r.name ?? `rule-${i + 1}`, re: new RegExp(r.heading ?? '.*', 'i') };
  });
}
const ruleFor = (rules, path) => rules.find((r) => r.re.test(path)) ?? null;

// ---------- md-sections: sekcje po nagłówkach, kawałki po punktach listy i wierszach tabel ----------

export function mdSections(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  const stack = [];
  let cur = { path: [], level: 0, start: 0, head: null, own: [] };
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    const h = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
    if (!h) { cur.own.push(l); return; }
    out.push(cur);
    const level = h[1].length;
    while (stack.length && stack.at(-1).level >= level) stack.pop();
    stack.push({ level, title: h[2].trim() });
    cur = { path: stack.map((s) => s.title), level, start: i, head: l, own: [] };
  });
  out.push(cur);
  return out.map((s, i) => ({ ...s, end: (out[i + 1]?.start ?? lines.length) }));
}

const ID_RE = /^(?:[-*+]\s+|\d+[.)]\s+)?(?:\[[ xX]\]\s+)?(?:\*\*|\[|\|\s*|`)?([A-Z][A-Za-z0-9]{0,6}-?\d+(?:\.\d+)?)\b/;
// Jednostki listy: punkt najwyższego poziomu z kontynuacją, wiersz tabeli (z nagłówkiem tabeli), akapit.
export function listUnits(own) {
  const units = [];
  let cur = null;
  let tableHead = null;
  const flush = () => { if (cur && cur.join('\n').trim()) units.push(cur.join('\n').trim()); cur = null; };
  for (const l of own) {
    if (/^\|/.test(l)) {
      if (/^\|[\s:|-]+\|?\s*$/.test(l)) continue;
      if (!tableHead) { flush(); tableHead = l; continue; }
      flush(); units.push(`${tableHead}\n${l}`); continue;
    }
    tableHead = null;
    if (/^([-*+]|\d+[.)])\s+/.test(l)) { flush(); cur = [l]; continue; }
    if (!l.trim()) { if (cur && cur.length && !cur.at(-1).trim()) flush(); else cur?.push(l); continue; }
    if (cur && (/^\s+/.test(l) || cur.length)) { cur.push(l); continue; }
    cur = [l];
  }
  flush();
  return units;
}

function splitLong(text) {
  if (text.length <= CHUNK_MAX) return [text];
  const parts = [];
  let buf = '';
  for (const line of text.split('\n')) {
    for (let piece = line; piece.length;) {
      const room = CHUNK_MAX - buf.length - (buf ? 1 : 0);
      if (piece.length <= room) { buf = buf ? `${buf}\n${piece}` : piece; piece = ''; }
      else if (buf) { parts.push(buf); buf = ''; } else { parts.push(piece.slice(0, CHUNK_MAX)); piece = piece.slice(CHUNK_MAX); }
    }
  }
  if (buf) parts.push(buf);
  return parts;
}

// Kawałki jednego pliku markdown: grupa = poddrzewo z tą samą regułą (sprint/roadmap/ref/skip w jednym kawałku),
// reguły list (item/decision/done) cięte na jednostki.
export function mdChunks(text, fileRel, rules, { prefix = '', metaOf = null } = {}) {
  const secs = mdSections(text);
  const chunks = [];
  const used = new Map();
  const mark = (m) => { const n = (used.get(m) ?? 0) + 1; used.set(m, n); return n > 1 ? `${m}~${n}` : m; };
  let group = null;
  const emit = (path, rule, kind, body, marker, meta = null) => {
    splitLong(body).forEach((t, i) => chunks.push({ src: `import:${fileRel}#${marker}${i ? `+${i + 1}` : ''}`, path, rule: rule?.name ?? 'skip', kind, text: t, ...(meta ? { meta } : {}), ...(rule?.type ? { type: rule.type } : {}), ...(rule?.triage ? { triage: rule.triage } : {}) }));
  };
  // Sekcja `skip` z samymi nagłówkami (kontener) nie trafia do raportu.
  const closeGroup = () => { if (group && group.kind === 'skip' && group.text.every((l) => !l.trim() || /^#{1,6}\s/.test(l))) group = null; if (group) { emit(group.path, group.rule, group.kind, group.text.join('\n').trim(), mark(slug(group.path)), group.meta); group = null; } };
  for (const s of secs) {
    const pathStr = [prefix, ...s.path].filter(Boolean).join(' > ');
    const meta = metaOf ? metaOf(s) : null;
    const rule = ruleFor(rules, pathStr);
    const kind = meta?.kind ?? rule?.kind ?? 'skip';
    const ownText = s.own.join('\n').trim();
    // Podsekcja grupy (ta sama reguła albo grupa z meta, np. faza GSD) idzie do kawałka grupy.
    const desc = group && s.path.length > group.depth && s.path.slice(0, group.depth).join('\u0000') === group.key;
    if (desc && !meta && (group.meta || (group.rule === rule && group.kind === kind))) { group.text.push(s.head, ...s.own); continue; }
    closeGroup();
    if (LIST_KINDS.includes(kind) && !meta) {
      for (const u of listUnits(s.own)) emit(pathStr, rule, kind, u, mark(`${slug(pathStr)}/${(ID_RE.exec(u)?.[1] ?? hash(u)).toLowerCase()}`), meta);
      continue;
    }
    if (!s.path.length && !ownText) continue;
    group = { path: pathStr, rule, kind, text: [s.head ?? '', ...s.own], depth: s.path.length, key: s.path.join('\u0000'), meta };
  }
  closeGroup();
  return chunks.filter((c) => c.text.trim());
}

// gsd-planning: `.planning/` (ROADMAP.md: fazy → sprint/done z `after`; REQUIREMENTS.md: wymagania → item; reszta jak md-sections).
const GSD_DEFAULTS = [
  { name: 'gsd-phase', heading: '^ROADMAP\\.md > (?:.* > )?Phase [\\d.]+', kind: 'sprint' },
  { name: 'gsd-requirement', heading: '^REQUIREMENTS\\.md > ', kind: 'item', type: 'feature' },
];
export function gsdChunks(dir, dirRel, rules) {
  const out = [];
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).sort() : [];
  const roadmap = files.includes('ROADMAP.md') ? read(join(dir, 'ROADMAP.md')).replace(/\r\n/g, '\n') : '';
  const doneSet = new Set([...roadmap.matchAll(/^\s*[-*]\s+\[[xX]\]\s+\*{0,2}Phase\s+([\d.]+)/gm)].map((m) => m[1]));
  const reqText = files.includes('REQUIREMENTS.md') ? read(join(dir, 'REQUIREMENTS.md')).replace(/\r\n/g, '\n') : '';
  // Tabela śladu: „| REQ-1 | Phase 2 |” (GSD) albo „| REQ-1 | 2 — Nazwa |” (wariant spotykany w praktyce).
  const trace = new Map([...reqText.matchAll(/^\|\s*([A-Z][A-Z0-9]*-\d+)\s*\|\s*(?:Phase\s+)?(\d+(?:\.\d+)?)(?=\s*(?:\||—|-|:|$))/gm)].map((m) => [m[1], m[2]]));
  for (const f of files) {
    const text = read(join(dir, f));
    const rel = `${dirRel}/${f}`;
    if (f === 'ROADMAP.md') {
      out.push(...mdChunks(text, rel, rules, {
        prefix: f,
        metaOf: (s) => {
          const m = /^Phase\s+([\d.]+)\s*[:—-]\s*(.+)$/i.exec(s.path.at(-1) ?? '');
          if (!m) return null;
          const body = s.own.join('\n');
          const after = [...(/\*{0,2}Depends on\*{0,2}\s*:?\s*\*{0,2}\s*(.+)$/im.exec(body)?.[1] ?? '').matchAll(/Phase\s+([\d.]+)/gi)].map((x) => `phase-${x[1]}`);
          const done = doneSet.has(m[1]) || /\*{0,2}Status\*{0,2}\s*:?\s*\*{0,2}\s*(complete|done)/i.test(body);
          return { phase: m[1], id: `phase-${m[1]}`, title: m[2].trim(), after, done, ...(done ? { kind: 'done' } : {}) };
        },
      }));
    } else if (f === 'REQUIREMENTS.md') {
      for (const s of mdSections(text)) {
        const pathStr = [f, ...s.path].join(' > ');
        for (const u of listUnits(s.own)) {
          const id = /\*\*([A-Z][A-Z0-9]*-\d+)\*\*/.exec(u)?.[1];
          if (!id) continue;
          const p = `${pathStr} > ${id}`;
          const rule = ruleFor(rules, p);
          const kind = rule?.kind ?? 'skip';
          out.push({ src: `import:${rel}#${id.toLowerCase()}`, path: p, rule: rule?.name ?? 'skip', kind, text: u.slice(0, CHUNK_MAX), meta: { id, phase: trace.get(id) ? `phase-${trace.get(id)}` : null, done: /^\s*[-*]\s+\[[xX]\]/.test(u) }, ...(rule?.type ? { type: rule.type } : {}), ...(rule?.triage ? { triage: rule.triage } : {}) });
        }
      }
    } else out.push(...mdChunks(text, rel, rules, { prefix: f }));
  }
  return out;
}

export function extract(top, src) {
  if (!src?.name || !src.path || !src.adapter) throw new Error('import.sources: każde źródło ma name, path, adapter');
  const abs = join(top, src.path);
  if (!existsSync(abs)) throw new Error(`import ${src.name}: brak ${src.path}`);
  const rel = fwd(src.path).replace(/^\.\//, '').replace(/\/$/, '');
  let chunks;
  if (src.adapter === 'md-sections') chunks = mdChunks(read(abs), rel, compileRules(src));
  else if (src.adapter === 'gsd-planning') { if (!statSync(abs).isDirectory()) throw new Error(`gsd-planning: ${src.path} nie jest katalogiem`); chunks = gsdChunks(abs, rel, compileRules(src, GSD_DEFAULTS)); }
  else throw new Error(`import ${src.name}: adapter ${src.adapter}, dozwolone md-sections|gsd-planning`);
  return chunks.map((c, i) => ({ chunk: `c-${i + 1}`, ...c }));
}

// ---------- obecne `src` (idempotencja) ----------

function presentSrcs(P) {
  const s = new Set();
  const { open, archived } = loadItems(P);
  for (const x of [...open, ...archived]) if (x.src) s.add(x.src);
  const { active, archived: da } = loadDecisions(P);
  for (const d of [...active, ...da]) if (d.src) s.add(d.src);
  for (const f of existsSync(P.sprints) ? readdirSync(P.sprints) : []) { const m = /^src: "?([^"\n]+)"?$/m.exec(read(join(P.sprints, f))); if (m) s.add(m[1]); }
  // Linie roadmapy i indeksu archiwum nie mają pola `src`: ich kawałki zapisane w imporcie pamięta `import/srcs.json`.
  try { for (const x of JSON.parse(read(join(P.import, 'srcs.json')))) s.add(x); } catch { /* pierwszy import */ }
  return s;
}
const srcBase = (src) => src.replace(/\.\d+$/, '');
const chunkDone = (present, c) => [...present].some((s) => s === c.src || srcBase(s) === c.src);

// ---------- run ----------

function sourcesOf(pc, name) {
  const all = asList(pc.import.sources);
  if (!all.length) throw new Error('brak product.import.sources w .claude/dwmt.json (spec §8)');
  const sel = name && name !== true ? all.filter((s) => s.name === name) : all;
  if (!sel.length) throw new Error(`brak źródła ${name}; są: ${all.map((s) => s.name).join(', ')}`);
  return sel;
}

// Przebiegi w toku (recenzja N-4): niezakończone przebiegi w `.dwmt/runs` głównego drzewa (także kopie z worktree
// w `merge-wait`) i worktree na gałęziach przebiegów. Import przełącza główne drzewo na swoją gałąź do końca przeglądu
// (§3.10 pkt 1), więc ich `finish` czekałby w `merge-wait`.
export function activeWork(top, cfg) {
  const out = [];
  const base = join(top, '.dwmt', 'runs');
  for (const id of existsSync(base) ? readdirSync(base) : []) {
    try {
      const r = JSON.parse(read(join(base, id, 'run.json')));
      if (!['squashed', 'left'].includes(r.finish?.status) && !r.stopped) out.push(id);
    } catch { /* nie przebieg */ }
  }
  const prefix = cfg.git.branchPrefix;
  for (const b of git(['worktree', 'list', '--porcelain'], { cwd: top }).split(/\r?\n\r?\n/)) {
    const m = /^branch refs\/heads\/(.+)$/m.exec(b);
    if (m && prefix && m[1].startsWith(prefix) && !out.includes(m[1].slice(prefix.length))) out.push(m[1].slice(prefix.length));
  }
  return out;
}

function ensureBranch(c, force = false) {
  const { top, cfg, pc } = c;
  const branch = pc.import.branch;
  const cur = git(['branch', '--show-current'], { cwd: top });
  if (cur === branch) return { branch, created: false };
  const dirtyTracked = git(['status', '--porcelain', '--untracked-files=no'], { cwd: top }).split(/\r?\n/).filter(Boolean);
  if (dirtyTracked.length) throw new Error(`import wymaga czystego drzewa: ${dirtyTracked.slice(0, 5).join(', ')}`);
  const busy = force ? [] : activeWork(top, cfg).filter((id) => `${cfg.git.branchPrefix}${id}` !== branch);
  if (busy.length) throw new Error(`przebiegi w toku: ${busy.slice(0, 5).join(', ')}; import przełącza główne drzewo na ${branch} do końca przeglądu, więc ich finish czekałby (merge-wait): import po ich końcu albo --force`);
  const exists = gitRaw(['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { cwd: top }).status === 0;
  if (exists) git(['switch', branch], { cwd: top });
  else git(['switch', '-c', branch, cfg.git.target], { cwd: top });
  return { branch, created: !exists };
}

function skeleton(P) {
  const mk = (f, t) => { if (!existsSync(f)) put(f, t); };
  mk(P.backlog, '');
  mk(P.decisions, `${DECISIONS_HEAD}\n`);
  mk(P.roadmap, renderRoadmap([]));
  mk(P.archiveIndex, renderIndex([]));
  mk(P.estimates, '');
  mkdirSync(P.sprints, { recursive: true });
}

// Agent kondensacji: `claude -p --agent dwmt-importer` (DWMT_CLAUDE w testach podmienia binarkę).
function condense(c, src, batch, inFile, outFile) {
  const { top, cfg, pc } = c;
  const rules = asList(src.rules).map((r) => `${r.name ?? '?'}: kind ${r.kind}${r.type ? `, type ${r.type}` : ''}${r.triage ? `, triage ${r.triage}` : ''}`).join('; ') || 'adapter defaults';
  const sprints = [...loadRoadmap(c.P).map((l) => l.id), ...loadIndex(c.P).map((x) => x.id)];
  const prompt = [
    `Repo root: ${fwd(top)}.`, `Source: ${src.name} (${src.path}, adapter ${src.adapter}). Rules: ${rules}.`,
    `Input: ${fwd(inFile)} (${batch.length} chunks). Write the output lines to ${fwd(outFile)} with Write.`,
    `Sprint ids already in the product: ${sprints.slice(0, 60).join(', ') || 'none'}.`,
  ].join('\n');
  const a = pc.import.agent;
  const sid = randomUUID();
  const pm = cfg.drive?.permissionMode ?? cfg.launch?.permissionMode ?? 'auto';
  // Jak agenci sterownika (recenzja N-4): bez innych wtyczek (`launch.lean`) i bez serwerów MCP.
  const off = cfg.launch?.lean !== false ? leanPlugins(top) : {};
  const args = ['-p', prompt, '--output-format', 'json', '--plugin-dir', fwd(ROOT), '--strict-mcp-config', ...(pm ? ['--permission-mode', pm] : []),
    '--agent', 'dwmt-importer', '--session-id', sid, '--model', a.model, '--effort', a.effort, ...(Object.keys(off).length ? ['--settings', JSON.stringify({ enabledPlugins: off })] : [])];
  const [bin, argv] = process.env.DWMT_CLAUDE ? [process.execPath, [process.env.DWMT_CLAUDE, ...args]] : ['claude', args];
  const r = spawnSync(bin, argv, { cwd: top, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20, windowsHide: true, timeout: (cfg.drive?.agentTimeoutMin ?? 240) * 60e3 });
  clearGitMemo();
  let res = null;
  try { res = JSON.parse(r.stdout); } catch { /* bez JSON */ }
  const costM = sessionsCost([res?.session_id ?? sid])?.total ?? null;
  if (r.error || r.status !== 0 || res?.is_error || !existsSync(outFile)) return { ok: false, error: cut(r.error?.message ?? res?.result ?? r.stderr ?? 'brak wyniku', 300), costM, session: res?.session_id ?? sid };
  return { ok: true, costM, session: res?.session_id ?? sid };
}

// Walidacja i zapis rekordów importera.
function anchorOk(a, files) {
  const p = String(a).split('#')[0].replace(/^\.\//, '');
  if (!p) return false;
  if (/[*?{]/.test(p)) { const m = globMatcher([p]); return files.some((f) => m(f)); }
  return files.includes(p) || files.some((f) => f.startsWith(`${p.replace(/\/$/, '')}/`));
}

function writeRecords(c, src, chunks, records, rep) {
  const { P, top, cfg } = c;
  const byChunk = new Map(chunks.map((x) => [x.chunk, x]));
  const seen = new Map();
  const files = trackedFiles(top, cfg);
  const present = presentSrcs(P);
  const items = [];
  const decisions = [];
  const sprints = new Map();
  const done = [];
  const reject = (r, why) => rep.rejected.push({ chunk: r?.chunk ?? '?', reason: why });
  for (const r of records) {
    const ch = byChunk.get(r?.chunk);
    if (!ch) { reject(r, 'unknown chunk'); continue; }
    const k = (seen.get(ch.chunk) ?? 0) + 1;
    seen.set(ch.chunk, k);
    const rsrc = k === 1 ? ch.src : `${ch.src}.${k}`;
    const kind = r.kind === 'roadmap' ? 'sprint' : r.kind;
    if (r.review) rep.review.push({ chunk: ch.chunk, src: rsrc, reason: cut(r.review, 160) });
    if (present.has(rsrc)) { rep.existing++; continue; }
    if (kind === 'item') {
      const anchors = asList(r.anchors).map(String);
      const bad = anchors.filter((a) => !anchorOk(a, files));
      if (bad.length) rep.review.push({ chunk: ch.chunk, src: rsrc, reason: `anchors not found, dropped: ${bad.join(', ')}` });
      const good = anchors.filter((a) => !bad.includes(a));
      let triage = r.triage ?? ch.triage ?? (ch.meta?.phase ? `sprint:${ch.meta.phase}` : null);
      if (triage === 'touch' && !good.length) { rep.review.push({ chunk: ch.chunk, src: rsrc, reason: 'touch without anchors: triage cleared' }); triage = null; }
      items.push({ chunk: ch.chunk, type: r.type ?? ch.type, title: r.title, note: r.note ?? null, sev: r.sev ?? null, anchors: good, triage, alias: r.alias ?? ch.meta?.id ?? null, src: rsrc, ...(ch.meta?.done ? { state: 'done' } : {}) });
    } else if (kind === 'decision') decisions.push({ chunk: ch.chunk, title: r.title, area: r.area, decision: r.decision, why: r.why, rejected: r.rejected, src: rsrc });
    else if (kind === 'sprint') {
      const id = String(r.id ?? ch.meta?.id ?? '').toLowerCase();
      if (!SPRINT_ID.test(id)) { reject(r, `sprint id ${r.id}`); continue; }
      const old = sprints.get(id);
      const after = [...new Set([...(old?.after ?? []), ...asList(r.after ?? ch.meta?.after).map((x) => String(x).toLowerCase())])];
      sprints.set(id, { id, chunk: old?.chunk ?? ch.chunk, order: old?.order ?? (r.kind === 'roadmap' || ch.kind === 'roadmap' ? 0 : 1), seq: old?.seq ?? sprints.size, goal: old?.goal || r.goal, alias: old?.alias ?? r.alias ?? null, after, notes: [old?.notes, r.notes].filter(Boolean).join('\n'), questions: [...(old?.questions ?? []), ...asList(r.questions)], items: [...(old?.items ?? []), ...asList(r.items)], refs: [...(old?.refs ?? []), ...asList(r.refs)], src: r.notes && !old?.notes ? rsrc : old?.src ?? rsrc, srcs: [...(old?.srcs ?? []), rsrc], roadmapSeq: r.kind === 'roadmap' || ch.kind === 'roadmap' ? (old?.roadmapSeq ?? records.indexOf(r)) : old?.roadmapSeq ?? null });
    } else if (kind === 'done') done.push({ id: String(r.id ?? ch.meta?.id ?? '').toLowerCase(), goal: r.goal ?? ch.meta?.title, merged: r.merged ?? '-', run: r.run ?? null, files: r.files ?? null, tokensM: r.tokensM ?? null, chunk: ch.chunk });
    else reject(r, `kind ${r.kind}`);
  }
  // Pozycje (z aliasami), decyzje, linie archiwum, roadmapa i pliki notes — tymi samymi funkcjami co w rozmowie.
  const { addItems, addDecision } = c.ops;
  const res = addItems(P, items.map((x) => ({ ...x, state: x.state ?? (x.triage ? 'open' : 'new') })), { partial: true });
  for (const x of res.rejected) reject({ chunk: x.row }, x.errors.join('; '));
  rep.counts.item += res.added.length;
  rep.existing += res.skipped.length;
  for (const d of decisions) {
    try { addDecision(P, d, { by: 'import' }); rep.counts.decision++; } catch (e) { reject(d, e.message); }
  }
  const index = loadIndex(P);
  const lines = loadRoadmap(P);
  const doneRows = done.filter((d) => {
    if (!SPRINT_ID.test(d.id) || !d.goal) { reject(d, `done: id ${d.id} or goal missing`); return false; }
    return !index.some((x) => x.id === d.id) && !lines.some((l) => l.id === d.id);
  }).map((d) => ({ ...d, goal: cut(d.goal, 160) }));
  if (doneRows.length) { appendIndex(P, doneRows); rep.counts.done += doneRows.length; }
  const idx = loadIndex(P);
  // Kolejność: linie z reguły `roadmap` w ich kolejności, potem reszta w kolejności kawałków; stabilne sortowanie topologiczne.
  const list = [...sprints.values()].filter((s) => {
    if (lines.some((l) => l.id === s.id) || idx.some((x) => x.id === s.id)) { rep.existing++; return false; }
    if (!s.goal) { reject(s, `sprint ${s.id}: goal missing`); return false; }
    return true;
  }).sort((a, b) => (a.roadmapSeq ?? Infinity) - (b.roadmapSeq ?? Infinity) || a.seq - b.seq);
  const known = new Set([...lines.map((l) => l.id), ...idx.map((x) => x.id), ...list.map((s) => s.id)]);
  for (const s of list) {
    const missing = s.after.filter((a) => !known.has(a));
    if (missing.length) { rep.review.push({ chunk: s.chunk, src: s.src, reason: `${s.id}: after not found, dropped: ${missing.join(', ')}` }); s.after = s.after.filter((a) => known.has(a)); }
  }
  const ordered = [];
  const placed = new Set([...lines.map((l) => l.id), ...idx.map((x) => x.id)]);
  const pending = [...list];
  while (pending.length) {
    const i = pending.findIndex((s) => s.after.every((a) => placed.has(a)));
    const s = pending.splice(i < 0 ? 0 : i, 1)[0];
    if (i < 0) { rep.review.push({ chunk: s.chunk, src: s.src, reason: `${s.id}: dependency cycle, after cleared` }); s.after = []; }
    if (i > 0) rep.review.push({ chunk: s.chunk, src: s.src, reason: `${s.id}: moved after its dependencies` });
    ordered.push(s);
    placed.add(s.id);
  }
  const { open } = loadItems(P);
  for (const s of ordered) {
    const hasNotes = !!(s.notes || s.questions.length || s.items.length || s.refs.length);
    const line = { id: s.id, state: hasNotes ? 'notes' : 'topic', goal: cut(s.goal, BUDGET.goal), after: s.after, detail: hasNotes ? `sprints/${s.id}.md` : 'none', alias: s.alias ? cut(s.alias, 30).replace(/ · /g, ' ') : null, current: false };
    const errs = roadmapErrors([...lines, line], idx);
    if (errs.length) { reject(s, errs.join('; ')); continue; }
    lines.push(line);
    if (hasNotes) {
      const itemIds = [...new Set(s.items.map((ref) => open.find((x) => x.id === ref || String(x.alias ?? '').toLowerCase() === String(ref).toLowerCase())?.id).filter(Boolean))];
      for (const id of itemIds) { const x = open.find((i) => i.id === id); if (!x.sprint && !['done', 'dropped'].includes(x.state)) Object.assign(x, { sprint: s.id, state: 'planned', triage: `sprint:${s.id}` }); }
      const h = { schema: 'dwmt/sprint-spec@1', id: s.id, kind: 'feature', items: itemIds.filter((id) => open.find((x) => x.id === id)?.sprint === s.id), touch: [], refs: [...new Set(s.refs.map(String))], uatGate: false, ui: false, mode: 'auto', est: null, ready: null, run: null, actual: null, src: s.src };
      const body = [`## Goal\n${s.goal}`, `## Notes\n${s.notes || '-'}`, ...(s.questions.length ? [`## Open questions\n${s.questions.map((q) => `- ${q}`).join('\n')}`] : [])].join('\n\n');
      try { writeSpec(P, s.id, h, body); } catch (e) { lines.pop(); line.state = 'topic'; line.detail = 'none'; lines.push(line); rep.review.push({ chunk: s.chunk, src: s.src, reason: `${s.id}: notes not written (${e.message}); topic only` }); }
    }
    rep.counts.sprint++;
  }
  writeJsonl(P.backlog, open);
  const written = new Set([...presentSrcs(P), ...[...sprints.values()].flatMap((s) => s.srcs), ...doneRows.map((d) => byChunk.get(d.chunk)?.src)].filter((x) => x?.startsWith('import:')));
  mkdirSync(P.import, { recursive: true });
  writeFileSync(join(P.import, 'srcs.json'), `${JSON.stringify([...written].sort())}\n`);
  const errs = roadmapErrors(lines, idx);
  if (errs.length) throw new Error(`roadmapa po imporcie: ${errs.join('; ')}`);
  put(P.roadmap, renderRoadmap(markCurrent(lines, idx)));
}

export function importRun(c, opts) {
  const { P, top, pc } = c;
  const srcs = sourcesOf(pc, opts.source);
  const plans = srcs.map((src) => {
    const chunks = extract(top, src);
    const present = presentSrcs(P);
    const todo = chunks.filter((x) => MOVED.includes(x.kind) && !chunkDone(present, x));
    const dir = join(P.import, src.name);
    mkdirSync(dir, { recursive: true });
    writeJsonl(join(dir, 'chunks.jsonl'), chunks);
    const kChars = todo.reduce((a, x) => a + x.text.length, 0) / 1000;
    return { src, chunks, todo, dir, kChars, batches: Math.ceil(todo.length / pc.import.batch) };
  });
  const kAll = plans.reduce((a, p) => a + p.kChars, 0);
  const priceM = [r1(kAll * pc.import.mPerKChars[0]), r1(kAll * pc.import.mPerKChars[1])];
  const summary = plans.map((p) => ({ source: p.src.name, chunks: p.chunks.length, toCondense: p.todo.length, skip: p.chunks.filter((x) => x.kind === 'skip').length, ref: p.chunks.filter((x) => x.kind === 'ref').length, batches: p.batches, kChars: Math.round(p.kChars) }));
  if (opts['dry-run']) return { ok: true, dryRun: true, sources: summary, priceM, line: `import ${summary.map((s) => `${s.source}: ${s.toCondense} chunks, ${s.batches} batches`).join('; ')}; ~${priceM[0]}-${priceM[1]} M tokens`, chunks: plans.map((p) => fwd(join(p.dir, 'chunks.jsonl'))) };
  // Agent importu musi być wyrenderowany (`setup` przy kluczu `product`), zanim cokolwiek wydamy (recenzja N-4).
  const agentFile = join(c.cfg.agentsScope === 'user' ? join(homedir(), '.claude', 'agents') : join(top, '.claude', 'agents'), 'dwmt-importer.md');
  if (!existsSync(agentFile)) throw new Error(`brak agenta dwmt-importer (${fwd(agentFile)}): uruchom /dwmt:setup (klucz product w .claude/dwmt.json), zacommituj agentów i zrestartuj sesję; import nic nie wydał`);
  const br = ensureBranch(c, !!opts.force);
  const report = { at: new Date().toISOString(), branch: br.branch, sources: {}, costM: 0, commit: null };
  withLock(P, () => skeleton(P));
  for (const p of plans) {
    const rep = { chunks: p.chunks.length, skip: p.chunks.filter((x) => x.kind === 'skip').map((x) => x.path), ref: p.chunks.filter((x) => x.kind === 'ref').map((x) => x.path), batches: p.batches, counts: { item: 0, decision: 0, sprint: 0, done: 0 }, existing: 0, rejected: [], review: [], costM: 0, failed: [], moved: [] };
    const records = [];
    for (let b = 0; b < p.batches; b++) {
      const batch = p.todo.slice(b * pc.import.batch, (b + 1) * pc.import.batch);
      // Recenzja N-4: plik paczki nazwany skrótem jej kawałków (id, src, tekst), nie numerem: po nieudanej paczce ponowny
      // `run` dzieli resztę inaczej, a wynik starej paczki o tym samym numerze przypisałby rekordy złym kawałkom.
      const key = createHash('sha1').update(batch.map((x) => `${x.chunk}|${x.src}|${hash(x.text)}`).join(';')).digest('hex').slice(0, 12);
      const inFile = join(p.dir, `batch-${key}.in.jsonl`);
      const outFile = join(p.dir, `batch-${key}.out.jsonl`);
      const ids = new Set(batch.map((x) => x.chunk));
      writeJsonl(inFile, batch);
      if (!existsSync(outFile)) {
        const r = condense(c, p.src, batch, inFile, outFile);
        rep.costM += r.costM ?? 0;
        if (!r.ok) { rmSync(outFile, { force: true }); rep.failed.push(`batch ${b + 1}: ${r.error}`); continue; }
      }
      try {
        const rows = readJsonl(outFile);
        const foreign = rows.filter((x) => !ids.has(x?.chunk)).map((x) => x?.chunk ?? '?');
        if (foreign.length) throw new Error(`chunks outside the batch: ${[...new Set(foreign)].slice(0, 5).join(', ')}`);
        records.push(...rows);
      } catch (e) { rmSync(outFile, { force: true }); rep.failed.push(`batch ${b + 1}: ${e.message}`); }
    }
    withLock(P, () => writeRecords(c, p.src, p.todo, records, rep));
    rep.moved = p.chunks.filter((x) => MOVED.includes(x.kind)).map((x) => x.src);
    rep.costM = r1(rep.costM);
    report.costM = r1(report.costM + rep.costM);
    report.sources[p.src.name] = rep;
    logChange(P, `import ${p.src.name}: ${Object.entries(rep.counts).map(([k, v]) => `${v} ${k}`).join(', ')}`, { kind: 'import' });
  }
  git(['add', '-A', '--', pc.dir], { cwd: top });
  if (gitRaw(['diff', '--cached', '--quiet', '--', pc.dir], { cwd: top }).status === 1) {
    const lines = Object.entries(report.sources).map(([n, r]) => `- ${n}: ${Object.entries(r.counts).map(([k, v]) => `${v} ${k}`).join(', ')}; existing ${r.existing}; rejected ${r.rejected.length}; review ${r.review.length}`);
    git(['commit', '-q', '-m', `product: import ${Object.keys(report.sources).join(', ')}\n\n${lines.join('\n')}\n`, '--', pc.dir], { cwd: top });
    report.commit = git(['rev-parse', '--short=10', 'HEAD'], { cwd: top });
  }
  const prev = existsSync(join(P.import, 'report.json')) ? JSON.parse(read(join(P.import, 'report.json'))) : {};
  writeFileSync(join(P.import, 'report.json'), `${JSON.stringify({ ...prev, ...report, sources: { ...(prev.sources ?? {}), ...report.sources } }, null, 2)}\n`);
  return { ok: Object.values(report.sources).every((r) => !r.failed.length), branch: br.branch, created: br.created, commit: report.commit, costM: report.costM, sources: Object.fromEntries(Object.entries(report.sources).map(([n, r]) => [n, { ...r.counts, existing: r.existing, rejected: r.rejected.length, review: r.review.length, failed: r.failed }])), hint: 'product import report; review with the decision-maker; merge only on their yes' };
}

export function importReport(c, opts) {
  const f = join(c.P.import, 'report.json');
  if (!existsSync(f)) throw new Error('brak raportu importu: najpierw product import run');
  const r = JSON.parse(read(f));
  const names = Object.keys(r.sources).filter((n) => !opts.source || opts.source === true || n === opts.source);
  const out = [`import ${r.at.slice(0, 16)} on ${r.branch}; commit ${r.commit ?? '-'}; agent ${r.costM} M`];
  for (const n of names) {
    const s = r.sources[n];
    out.push(`${n}: ${Object.entries(s.counts).map(([k, v]) => `${v} ${k}`).join(', ')}; existing ${s.existing}; chunks ${s.chunks}, batches ${s.batches}${s.failed.length ? `; FAILED ${s.failed.join(' | ')}` : ''}`);
    if (s.review.length) out.push(`  review (${s.review.length}):`, ...s.review.slice(0, 8).map((x) => `  - ${x.src}: ${x.reason}`));
    if (s.rejected.length) out.push(`  rejected (${s.rejected.length}):`, ...s.rejected.slice(0, 6).map((x) => `  - ${x.chunk}: ${cut(x.reason, 140)}`));
    if (s.skip.length) out.push(`  skip (${s.skip.length}): ${cut([...new Set(s.skip)].join('; '), 220)}`);
    if (s.ref.length) out.push(`  ref (${s.ref.length}): ${cut([...new Set(s.ref)].join('; '), 160)}`);
  }
  return out.slice(0, 30).join('\n');
}

// `retire` (§3.10): po scaleniu gałęzi importu zastępuje przeniesione sekcje starego pliku odnośnikiem; `skip` i `ref` zostają.
export function importRetire(c, opts) {
  const { P, top, cfg, pc } = c;
  const [src] = sourcesOf(pc, need(opts.source));
  const f = join(P.import, 'report.json');
  const rep = existsSync(f) ? JSON.parse(read(f)) : null;
  if (!rep?.sources?.[src.name]) throw new Error(`źródło ${src.name} nie było importowane`);
  if (git(['branch', '--show-current'], { cwd: top }) !== cfg.git.target) throw new Error(`retire tylko na ${cfg.git.target} po scaleniu gałęzi importu`);
  const ref = rep.commit ?? pc.import.branch;
  if (gitRaw(['merge-base', '--is-ancestor', ref, 'HEAD'], { cwd: top }).status !== 0) throw new Error(`gałąź importu (${ref}) nie jest scalona do ${cfg.git.target}: retire dopiero po scaleniu`);
  if (git(['status', '--porcelain', '--untracked-files=no'], { cwd: top })) throw new Error('retire wymaga czystego drzewa');
  const files = src.adapter === 'gsd-planning' ? readdirSync(join(top, src.path)).filter((x) => x.endsWith('.md')).map((x) => `${fwd(src.path).replace(/\/$/, '')}/${x}`) : [fwd(src.path)];
  const rules = compileRules(src, src.adapter === 'gsd-planning' ? GSD_DEFAULTS : []);
  const note = `> Moved to \`${pc.dir}/\` by dwmt import (${today()}): \`dwmt.mjs product roadmap\`, \`product list\`, \`product decision list\`.`;
  let n = 0;
  const changed = [];
  for (const rel of files) {
    const orig = read(join(top, rel));
    // Recenzja N-4: końce linii pliku źródłowego zostają (CRLF w projektach Windows); zmieniają się tylko sekcje.
    const eol = orig.includes('\r\n') ? '\r\n' : '\n';
    const text = orig.replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    const prefix = src.adapter === 'gsd-planning' ? basename(rel) : '';
    const out = [];
    for (const s of mdSections(text)) {
      const pathStr = [prefix, ...s.path].filter(Boolean).join(' > ');
      const own = lines.slice(s.start + (s.head ? 1 : 0), s.end);
      if (s.head) out.push(s.head);
      // Ta sama reguła co przy wyciągu; w REQUIREMENTS.md tylko sekcje z wymaganiami `**ID**`.
      const kind = ruleFor(rules, pathStr)?.kind ?? 'skip';
      const req = prefix !== 'REQUIREMENTS.md' || /\*\*[A-Z][A-Z0-9]*-\d+\*\*/.test(own.join('\n'));
      if (MOVED.includes(kind) && req && own.join('').trim()) { out.push('', note, ''); n++; } else out.push(...own);
    }
    const next = out.join('\n');
    if (next !== text) { writeFileSync(join(top, rel), eol === '\n' ? next : next.replace(/\n/g, eol)); changed.push(rel); }
  }
  if (!changed.length) return { ok: true, retired: 0, hint: 'nothing to retire' };
  git(['add', '--', ...changed], { cwd: top });
  git(['commit', '-q', '-m', `product: import retire ${src.name} (${n} sections moved to ${pc.dir})`, '--', ...changed], { cwd: top });
  return { ok: true, retired: n, files: changed, commit: git(['rev-parse', '--short=10', 'HEAD'], { cwd: top }), hint: 'propose removing project rules that made agents edit the old roadmap (same commit or next)' };
}
const need = (v) => { if (!v || v === true) throw new Error('retire --source <nazwa>'); return v; };

