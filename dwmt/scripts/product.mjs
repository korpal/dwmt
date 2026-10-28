// dwmt D4 (warstwa produktowa, etap 1): mechanika artefaktów produktu, `dwmt.mjs product <komenda>` (spec warstwy produktowej
// §3, §7). Pliki produktu (`product.dir`) pisze tylko ten skrypt, pod blokadą `.dwmt/product/lock`; agenci czytają wyniki
// zapytań (P-5). Zapytania drukują tekst (agent-facing, po angielsku), komendy piszące JSON. Warstwa wyłączalna (P-11):
// `product.enabled: false` blokuje komendy piszące, a `intake` wtedy nic nie robi; bez katalogu produktu dwmt działa jak v3-driver.
import { existsSync, mkdirSync, appendFileSync, renameSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fwd, read, asList, printJson } from './lib/util.mjs';
import { splitHeader, parseYaml } from './lib/headers.mjs';
import { git, gitRaw, worktreeFor, removeWorktree } from './lib/git.mjs';
import { readWorkplaces, saveWorkplaces, recordPath, workplaceTree, workplaceSprints, workplaceFacts, workplaceReady, openSprintsOf, branchPushed } from './lib/workplace.mjs';
import { loadConfig } from './lib/config.mjs';
import { withLease } from './machine.mjs';
import { mergeKey } from './lib/finish.mjs';
import { productConfig } from './lib/product-config.mjs';
import { explorerPrice, parseRange, cmdPrice } from './lib/price.mjs';
import {
  BUDGET, SPRINT_ID, SPEC_KINDS, specKind, SPEC_MODES, SPRINT_STATES, paths, put, withLock, readJsonl, writeJsonl, appendJsonl,
  normItem, itemErrors, maxNum, loadItems, findItem, itemLine, loadDecisions, decisionEntry, decisionErrors, renderDecision, renderDecisions,
  DECISIONS_HEAD, DECISIONS_ARCHIVE_HEAD, ROADMAP_HEAD, INDEX_HEAD, loadRoadmap, renderRoadmap, roadmapErrors, markCurrent, nextSprint, roadmapLine, renderIndex,
  loadIndex, appendIndex, readSpec, writeSpec, specFile, specSections, setSection, specSizeCheck, loadEstimates, loadState, saveState, updateState,
  logChange, loadChanges, today, merged, stripForYou, FOR_YOU, isForYou, forYouText, archiveSpecFile, readSpecAt, writeSpecAt, specAgreed, specWriteErrors,
} from './lib/product-store.mjs';
import { forYouList, forYouDraft } from './lib/product-foryou.mjs';
import { writeView, translateView, refreshView, translateInBackground, publishView, mainCtx } from './lib/product-view.mjs';
import { openFile } from './lib/platform.mjs';
import {
  syncCore, intakeRun, intakeUat, triageAuto, brief, briefFor, expertFiles, parseExpert, getExpert, EXPERT_TEMPLATE, newestSession,
  startCheck, pinnedBySource, separateGroup, estimateInput, parseEstimateResult, tokensFor, overhead, completedRuns, analogRuns, analogSummary, globMatcher, globsOf,
  trackedFiles, contextK, estimateOf, runCopies,
} from './lib/product-ops.mjs';
import { importRun, importReport, importRetire } from './lib/product-import.mjs';
import { sessionsCost, subagentCostByPrompt } from './lib/sessions.mjs';

// ---------- argumenty ----------

export function parseOpts(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      opts[k] = k in opts && typeof opts[k] === 'string' && typeof v === 'string' ? `${opts[k]},${v}` : v;
    } else pos.push(a);
  }
  return { pos, opts };
}
const list = (v) => asList(v).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
const nul = (v) => (v === undefined || v === true || v === '-' || v === 'null' || v === '' ? null : v);
const need = (v, what) => { if (v === undefined || v === true || v === null || v === '') throw new Error(`brak argumentu: ${what}`); return v; };
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// ---------- kontekst ----------

function ctxOf(top) {
  const cfg = loadConfig(top);
  const pc = productConfig(top, cfg);
  return { top, cfg, pc, P: paths(top, pc) };
}
const requireDir = (c) => { if (!existsSync(c.P.dir)) throw new Error(`brak katalogu produktu ${c.pc.dir}: product init`); };
const requireImport = (c) => { if (c.pc.enabled === false && existsSync(c.P.dir)) throw new Error('warstwa produktowa wyłączona (product.enabled: false)'); };
const requireWrite = (c) => { requireDir(c); if (!c.pc.enabled) throw new Error('warstwa produktowa wyłączona (product.enabled: false): komendy piszące nieaktywne'); };

function ensureExclude(top) {
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: top });
  const ex = join(common, 'info', 'exclude');
  mkdirSync(dirname(ex), { recursive: true });
  const t = existsSync(ex) ? read(ex) : '';
  if (!/^\/?\.dwmt\/?$/m.test(t)) appendFileSync(ex, `${t && !t.endsWith('\n') ? '\n' : ''}.dwmt/\n`);
}

// ---------- init ----------

function cmdInit(c, opts) {
  const { P, top } = c;
  ensureExclude(top);
  const created = [];
  const mk = (f, text) => { if (!existsSync(f)) { put(f, text); created.push(fwd(f).slice(fwd(top).length + 1)); } };
  return withLock(P, () => {
    mk(P.backlog, '');
    mk(P.decisions, `${DECISIONS_HEAD}\n`);
    mk(P.roadmap, renderRoadmap([]));
    mk(P.archiveIndex, renderIndex([]));
    mk(P.estimates, '');
    mkdirSync(P.sprints, { recursive: true });
    const goal = opts['goal-file'] ? read(opts['goal-file']).trim() : nul(opts.goal);
    if (goal) {
      if (goal.split(/\r?\n/).length + 3 > BUDGET.visionLines) throw new Error(`vision.md: cel ponad ${BUDGET.visionLines} linii`);
      put(P.vision, `# Vision (stage 1: goal only)\n\n## Goal\n${goal}\n`);
      logChange(P, 'vision goal set', { kind: 'vision' });
    } else mk(P.vision, '# Vision (stage 1: goal only)\n\n## Goal\n(not set: product stage, optimization goal, hard constraints; set with the decision-maker)\n');
    return { ok: true, dir: c.pc.dir, created, goal: !!goal, hint: goal ? 'product commit' : 'ask the decision-maker one question about the goal, then product init --goal "<text>"' };
  });
}

// ---------- pozycje ----------

export function addItems(P, rows, { partial = false } = {}) {
  const { open, archived } = loadItems(P);
  const all = [...open, ...archived];
  const srcs = new Set(all.map((x) => x.src).filter(Boolean));
  const aliases = new Set(all.map((x) => String(x.alias ?? '').toLowerCase()).filter(Boolean));
  let n = maxNum(all.map((x) => x.id), 'B');
  const added = [];
  const skipped = [];
  const rejected = [];
  for (const row of rows) {
    if (row.src && srcs.has(row.src)) { skipped.push(row.src); continue; }
    const x = normItem({ ...row, id: null, anchors: list(row.anchors), state: row.state ?? (row.triage ? 'open' : 'new'), at: row.at ?? today(), src: row.src ?? `user:${today()}`, detail: false, sprint: row.sprint ?? null });
    const errs = itemErrors({ ...x, id: x.alias ?? x.title });
    if (x.alias && aliases.has(String(x.alias).toLowerCase())) errs.push(`${x.alias}: alias już istnieje`);
    if (errs.length) { rejected.push({ row: row.chunk ?? row.src ?? x.title, errors: errs }); continue; }
    x.id = `B-${++n}`;
    if (x.alias) aliases.add(String(x.alias).toLowerCase());
    if (x.src) srcs.add(x.src);
    added.push(x);
  }
  if (rejected.length && !partial) throw new Error(rejected.flatMap((r) => r.errors).join('; '));
  if (added.length) { writeJsonl(P.backlog, [...open, ...added]); logChange(P, `${added.map((x) => x.id).join(', ')} added`, { kind: 'items', ids: added.map((x) => x.id) }); }
  return { added, skipped, rejected };
}

// K5 D-18: the detail text is checked (40 lines) before any write of the command.
function detailText(id, file) {
  const text = read(file).replace(/\r\n/g, '\n').trim();
  if (text.split('\n').length > BUDGET.detailLines) throw new Error(`szczegóły ${id}: ponad ${BUDGET.detailLines} linii`);
  return text;
}
function itemDetail(P, id, file, text = detailText(id, file)) {
  put(join(P.items, `${id}.md`), `${text}\n`);
}

// K5 D-18: a sprint file write checked in memory (specWriteErrors); `putSpec` writes it after every check of the command.
function specCheck(P, id, h, body, file = specFile(P, id)) {
  const c = specWriteErrors(file, h, body);
  if (c.errors.length) throw new Error(c.errors.join('; '));
  return { ...c, file };
}
const putSpec = (chk) => { put(chk.file, chk.text); return chk.warnings.join('; ') || null; };
function roadmapCheck(P, lines) {
  const errs = roadmapErrors(lines, loadIndex(P));
  if (errs.length) throw new Error(errs.join('; '));
}

// Szacunki, których zakres się zmienił (§3.6): `stale: true`.
function markStale(P, ids) {
  const est = loadEstimates(P);
  let ch = false;
  for (const e of est) if (!e.stale && !e.actual && asList(e.for).some((f) => ids.includes(f))) { e.stale = true; ch = true; }
  if (ch) writeJsonl(P.estimates, est);
}

function itemSet(c, id, pairs, opts) {
  const { P } = c;
  return withLock(P, () => {
    const { open } = loadItems(P);
    const x = open.find((i) => i.id === id || String(i.alias ?? '').toLowerCase() === String(id).toLowerCase());
    if (!x) throw new Error(`brak otwartej pozycji ${id} (archiwum jest tylko do odczytu)`);
    const changed = [];
    // Przegląd 2026-10-04: PO pisał pola jako opcje (`--anchors "frontend/e2e/**"`, `--touch …`) i powtarzał komendę.
    // Opcja o nazwie pola znaczy to samo co para `pole wartość`; `--touch` to kotwice.
    const FIELDS = ['title', 'note', 'sev', 'state', 'triage', 'anchors', 'alias', 'type', 'est'];
    pairs = [...pairs, ...Object.entries(opts).flatMap(([k, v]) => (FIELDS.includes(k) || k === 'touch' ? [k === 'touch' ? 'anchors' : k, v === true ? undefined : v] : []))];
    if (!pairs.length && !opts.detail) throw new Error(`item set <B-n> <pole> <wartość> [<pole> <wartość>…] (albo --pole wartość); pola: ${FIELDS.join(', ')}; --detail plik`);
    for (let i = 0; i < pairs.length; i += 2) {
      const [k, raw] = [pairs[i], pairs[i + 1]];
      if (raw === undefined) throw new Error(`item set: brak wartości dla ${k}`);
      if (!FIELDS.includes(k)) throw new Error(`item set: pole ${k} niedozwolone (przydział do sprintu: product spec set <id> items +${x.id})`);
      const v = k === 'anchors' ? list(raw) : nul(raw);
      if (k === 'triage') {
        x.triage = v;
        if (x.state === 'new' && v) x.state = 'open';
        if (v === 'never') x.state = 'dropped';
      } else x[k] = v;
      changed.push(k);
    }
    const detail = opts.detail ? detailText(x.id, opts.detail) : null;
    if (detail != null) { x.detail = true; changed.push('detail'); }
    const errs = itemErrors(x);
    if (errs.length) throw new Error(errs.join('; '));
    if (detail != null) itemDetail(P, x.id, null, detail);
    // The rewritten line gets every ITEM_KEYS key (a line from before `from` gains `from: null`); other keys stay.
    writeJsonl(P.backlog, open.map((i) => (i === x ? { ...normItem(x), ...x } : i)));
    if (changed.some((k) => ['title', 'note', 'anchors', 'detail', 'type'].includes(k))) markStale(P, [x.id, ...(x.sprint ? [x.sprint] : [])]);
    logChange(P, `${x.id} ${changed.map((k) => (k === 'triage' ? `→ ${x.triage}` : k === 'state' ? `→ ${x.state}` : k)).join(', ')}`, { kind: 'items', ids: [x.id] });
    return { ok: true, item: itemLine(x) };
  });
}

function showRef(c, ref, opts) {
  const { P } = c;
  if (/^PD-\d+$/i.test(ref)) {
    const { active, archived } = loadDecisions(P);
    const d = active.find((x) => x.id === ref.toUpperCase());
    const a = archived.find((x) => x.id === ref.toUpperCase());
    if (!d && !a) throw new Error(`brak decyzji ${ref}`);
    return `${renderDecision(d ?? a)}${d ? '' : '\n(archived: superseded)'}`;
  }
  const hit = findItem(P, ref);
  if (!hit) throw new Error(`brak pozycji ${ref} (szukano po B-n i alias, także w archiwum)`);
  const x = hit.item;
  const out = [`${itemLine(x)}${hit.archived ? ' (archived)' : ''}`, ...(x.note ? [`note: ${x.note}`] : []), ...(x.anchors.length ? [`anchors: ${x.anchors.join(', ')}`] : []),
    `src: ${x.src ?? '-'}; from: ${x.from ?? '-'}; at: ${x.at ?? '-'}; sprint: ${x.sprint ?? '-'}; est: ${x.est ?? '-'}; detail: ${x.detail ? `items/${x.id}.md` : 'no'}`];
  if (opts.detail && x.detail && existsSync(join(P.items, `${x.id}.md`))) out.push('', read(join(P.items, `${x.id}.md`)).trimEnd());
  return out.join('\n');
}

function anchorHit(anchor, hit, files) {
  const a = String(anchor).split('#')[0].replace(/^\.\//, '');
  if (/[*?{]/.test(a)) { const m = globMatcher([a]); return files.some((f) => m(f) && hit(f)); }
  return hit(a) || files.some((f) => f.startsWith(`${a.replace(/\/$/, '')}/`) && hit(f));
}

function cmdList(c, opts) {
  const { P, top, cfg } = c;
  const { open, archived } = loadItems(P);
  let rows = opts.archive ? [...open, ...archived] : open;
  const eq = (k, v) => { const vs = list(v); rows = rows.filter((x) => vs.includes(String(x[k]))); };
  if (opts.state) eq('state', opts.state);
  if (opts.type) eq('type', opts.type);
  if (opts.triage) eq('triage', opts.triage);
  if (opts.sprint) rows = rows.filter((x) => x.sprint === opts.sprint || x.triage === `sprint:${opts.sprint}`);
  if (opts.touch) {
    const hit = globMatcher(opts.touch);
    const files = trackedFiles(top, cfg);
    rows = rows.filter((x) => x.anchors.some((a) => anchorHit(a, hit, files)));
  }
  const max = Number(opts.limit) || 60;
  return [...rows.slice(0, max).map(itemLine), ...(rows.length > max ? [`(+${rows.length - max} more: narrow the filter)`] : []), ...(rows.length ? [] : ['none'])].join('\n');
}

// ---------- rejestr decyzji ----------

function decisionFields(opts) {
  const f = { title: opts.title, area: opts.area, decision: opts.decision, why: opts.why, rejected: opts.rejected, against: nul(opts.against), src: nul(opts.src) };
  if (opts.file) {
    for (const line of read(opts.file).split(/\r?\n/)) {
      const m = /^(Title|Area|Decision|Why|Rejected|Against recommendation|Src):\s*(.*)$/i.exec(line.trim());
      if (!m) continue;
      const k = { title: 'title', area: 'area', decision: 'decision', why: 'why', rejected: 'rejected', 'against recommendation': 'against', src: 'src' }[m[1].toLowerCase()];
      f[k] = k === 'against' && /^no\b/i.test(m[2]) ? null : k === 'against' ? m[2].replace(/^yes\s*[—-]\s*/i, '') : m[2];
    }
  }
  return f;
}

export function addDecision(P, f, { by = 'po', confirmed = null } = {}) {
  if (!['po', 'import'].includes(by) && !confirmed) throw new Error(`decision add --by ${by}: wymagane --confirmed "<dosłowna linia decydenta>" (§4.11 pkt 5)`);
  if (!/^[a-z0-9-]+$/.test(by)) throw new Error(`--by ${by}: dziedzina [a-z0-9-]+`);
  const { active, archived } = loadDecisions(P);
  const id = `PD-${maxNum([...active, ...archived].map((d) => d.id), 'PD') + 1}`;
  const d = decisionEntry(id, { ...f, by, confirmed });
  const errs = decisionErrors(d);
  if (errs.length) throw new Error(errs.join('; '));
  put(P.decisions, renderDecisions(DECISIONS_HEAD, [...active, d]));
  logChange(P, `${id} added (${by}): ${d.title}`, { kind: 'decision', id, by });
  return d;
}

function cmdDecision(c, sub, pos, opts) {
  const { P } = c;
  if (sub === 'add') {
    requireWrite(c);
    const by = nul(opts.by) ?? 'po';
    const d = withLock(P, () => {
      const out = addDecision(P, decisionFields(opts), { by, confirmed: nul(opts.confirmed) });
      if (opts.from) { const drop = list(opts.from); writeJsonl(P.inbox, readJsonl(P.inbox).filter((x) => !drop.includes(x.id))); }
      return out;
    });
    // Decyzja eksperta po potwierdzeniu to od razu commit (§4.11 pkt 5).
    const commit = !['po', 'import'].includes(by) ? productCommit(c, `${d.id} added (${by})`) : null;
    return { ok: true, id: d.id, title: d.title, ...(commit ? { commit } : {}) };
  }
  if (sub === 'supersede') {
    requireWrite(c);
    const [oldId, newId] = [need(pos[0], 'PD-n'), need(opts.by, '--by PD-n')];
    return withLock(P, () => {
      const { active } = loadDecisions(P);
      const o = active.find((d) => d.id === oldId);
      const n = active.find((d) => d.id === newId);
      if (!o || !n) throw new Error(`brak aktywnej decyzji ${!o ? oldId : newId}`);
      if (!n.lines.some((l) => l.startsWith('Supersedes:'))) n.lines.push(`Supersedes: ${oldId}`);
      else n.lines = n.lines.map((l) => (l.startsWith('Supersedes:') ? `${l}, ${oldId}` : l));
      const errs = decisionErrors(n);
      if (errs.length) throw new Error(errs.join('; '));
      o.lines.push(`Superseded by: ${newId} (${today()})`);
      const arch = existsSync(P.decisionsArchive) ? read(P.decisionsArchive).replace(/\r\n/g, '\n').trimEnd() : DECISIONS_ARCHIVE_HEAD;
      put(P.decisionsArchive, `${arch}\n\n${renderDecision(o)}\n`);
      put(P.decisions, renderDecisions(DECISIONS_HEAD, active.filter((d) => d !== o)));
      logChange(P, `${oldId} superseded by ${newId}`, { kind: 'decision', id: newId });
      return { ok: true, superseded: oldId, by: newId };
    });
  }
  const { active, archived } = loadDecisions(P);
  const pool = opts.archive ? [...active, ...archived] : active;
  if (sub === 'list') return pool.map((d) => `${d.id} ${d.title} (${d.area ?? '-'}; ${d.by ?? '-'})`).join('\n') || 'none';
  if (sub === 'find') {
    const words = pos.flatMap((w) => w.toLowerCase().split(/\s+/)).filter(Boolean);
    if (!words.length) throw new Error('decision find <słowa>');
    const scored = pool.map((d) => { const t = renderDecision(d).toLowerCase(); return { d, n: words.filter((w) => t.includes(w)).length }; }).filter((x) => x.n).sort((a, b) => b.n - a.n);
    const all = scored.filter((x) => x.n === words.length);
    return (all.length ? all : scored).slice(0, 5).map((x) => renderDecision(x.d)).join('\n\n') || 'none';
  }
  throw new Error('decision add|supersede|find|list');
}

// ---------- roadmapa ----------

function saveRoadmap(P, lines, what) {
  const index = loadIndex(P);
  const errs = roadmapErrors(lines, index);
  if (errs.length) throw new Error(errs.join('; '));
  put(P.roadmap, renderRoadmap(markCurrent(lines, index)));
  if (what) logChange(P, what, { kind: 'roadmap' });
}
function insertAt(lines, line, opts) {
  let at = lines.length;
  if (opts.before) { at = lines.findIndex((l) => l.id === opts.before); if (at < 0) throw new Error(`--before: brak ${opts.before} w roadmapie`); }
  else if (opts.position) at = Math.max(0, Math.min(lines.length, Number(opts.position) - 1));
  lines.splice(at, 0, line);
}

function roadmapAdd(c, pos, opts) {
  const { P } = c;
  return withLock(P, () => {
    const lines = loadRoadmap(P);
    if (opts.second) return secondSprint(c, lines, opts);
    const id = need(pos[0], 'id sprintu');
    if (!SPRINT_ID.test(id)) throw new Error(`id ${id}: [a-z0-9._-]`);
    if (lines.some((l) => l.id === id) || loadIndex(P).some((x) => x.id === id)) throw new Error(`sprint ${id} już istnieje (roadmapa albo archiwum)`);
    const hasFile = existsSync(specFile(P, id));
    const line = { id, state: hasFile ? 'notes' : 'topic', goal: cut(need(opts.goal, '--goal'), 200), after: list(opts.after === true ? '' : opts.after), detail: hasFile ? `sprints/${id}.md` : 'none', alias: nul(opts.alias), current: false };
    insertAt(lines, line, opts);
    saveRoadmap(P, lines, `${id} added (${line.state})`);
    return { ok: true, line: roadmapLine(line), position: lines.indexOf(line) + 1 };
  });
}

// `roadmap add --second <run>` (§6.2): `<id>-2` zaraz za pierwszym, `after: [<id>]`, `ready` (pod supervisorem `--state ordered`).
function secondSprint(c, lines, opts) {
  const { P, top } = c;
  const runId = opts.second;
  const copy = runCopies(top).find((r) => r.id === runId);
  if (!copy) throw new Error(`brak kopii przebiegu ${runId}`);
  const first = copy.run.spec ?? copy.run.sprint;
  if (!first) throw new Error(`przebieg ${runId} nie ma spec ani sprint`);
  const inbox = readJsonl(P.inbox);
  const ev = inbox.find((x) => x.kind === 'second' && x.run === runId);
  const text = String(opts.goal && opts.goal !== true ? opts.goal : ev?.text ?? (() => { try { return parseYaml(splitHeader(read(join(copy.dir, 'plan.md')))?.yaml ?? '').second; } catch { return null; } })() ?? '');
  if (!text.trim()) throw new Error('brak opisu drugiego sprintu (inbox ani plan.md): podaj --goal');
  let k = 2;
  while (lines.some((l) => l.id === `${first}-${k}`) || loadIndex(P).some((x) => x.id === `${first}-${k}`)) k++;
  const id = `${first}-${k}`;
  const state = opts.state === 'ordered' ? 'ordered' : 'ready';
  const i = lines.findIndex((l) => l.id === first);
  const line = { id, state, goal: cut(text.replace(/^\s*size\s*:?\s*/i, ''), BUDGET.goal), after: [first], detail: `sprints/${id}.md`, alias: null, current: false };
  lines.splice(i < 0 ? 0 : i + 1, 0, line);
  const fh = readSpec(P, first)?.h ?? {};
  const h = { schema: 'dwmt/sprint-spec@1', id, kind: fh.kind ?? 'feature', goal: fh.goal ?? null, items: [], touch: [], refs: [`.dwmt/runs/${runId}/plan.md`], uatGate: !!fh.uatGate, ui: !!fh.ui, mode: fh.mode ?? 'auto', est: null, ready: { at: today(), by: 'second' }, run: null, actual: null };
  // K5 D-18: roadmap and sprint file checked before the first write.
  roadmapCheck(P, lines);
  const chk = specCheck(P, id, h, `## Goal\n${cut(text, 600)}\n\n## Notes\nSecond sprint of ${first} (architect: size). It shares the refinement of ${first}; first plan: .dwmt/runs/${runId}/plan.md\n`);
  putSpec(chk);
  saveRoadmap(P, lines, `${id} added after ${first} (second, ${state})`);
  if (ev) writeJsonl(P.inbox, inbox.filter((x) => x !== ev));
  return { ok: true, line: roadmapLine(line), position: lines.indexOf(line) + 1, spec: `${c.pc.dir}/sprints/${id}.md` };
}

// One-time migration to `todo` (§3.9): a `notes` line whose sprint file has a goal and acceptance criteria is clear already.
function todoFromNotes(c, dry) {
  const { P } = c;
  return withLock(P, () => {
    const lines = loadRoadmap(P);
    const hit = lines.filter((l) => l.state === 'notes' && specAgreed(readSpec(P, l.id)?.body ?? ''));
    if (!dry && hit.length) { for (const l of hit) l.state = 'todo'; saveRoadmap(P, lines, `${hit.map((l) => l.id).join(', ')} notes → todo`); }
    return { ok: true, todo: hit.map((l) => l.id), ...(dry ? { dryRun: true } : {}), left: lines.filter((l) => l.state === 'notes').map((l) => l.id) };
  });
}

function cmdRoadmap(c, sub, pos, opts) {
  const { P } = c;
  // Zawsze format @2 (także plik @1 sprzed pierwszego zapisu).
  if (!sub) { const l = loadRoadmap(P); return l.length ? renderRoadmap(l).trimEnd() : `${ROADMAP_HEAD}\n(empty)`; }
  if (sub === 'next') {
    const nx = nextSprint(loadRoadmap(P), loadIndex(P));
    if (!nx) return 'next: none (no to-do, ready, notes or topic sprint with dependencies merged)';
    return [`next: ${nx.line.id} · ${nx.line.state} · ${nx.line.goal}`, `why: ${nx.why}`, ...(nx.also.length ? [`also ready: ${nx.also.join(', ')}`] : [])].join('\n');
  }
  requireWrite(c);
  if (sub === 'add') return roadmapAdd(c, pos, opts);
  if (sub === 'todo-from-notes') return todoFromNotes(c, !!opts['dry-run']);
  if (opts.help || pos[0] === undefined || pos[0] === true) throw new Error(SPEC_USAGE);
  const id = pos[0];
  return withLock(P, () => {
    const lines = loadRoadmap(P);
    const l = lines.find((x) => x.id === id);
    if (!l) throw new Error(`brak ${id} w roadmapie`);
    if (sub === 'move') {
      lines.splice(lines.indexOf(l), 1);
      if (opts.end) lines.push(l); else insertAt(lines, l, opts);
      saveRoadmap(P, lines, `${id} moved to ${lines.indexOf(l) + 1}`);
      return { ok: true, line: roadmapLine(l), position: lines.indexOf(l) + 1 };
    }
    if (sub === 'set') {
      let unready = false;
      for (let i = 1; i < pos.length; i += 2) {
        const [k, v] = [pos[i], pos[i + 1]];
        if (v === undefined) throw new Error(`roadmap set: brak wartości dla ${k}`);
        if (k === 'state') {
          if (!SPRINT_STATES.includes(v)) throw new Error(`stan ${v}, dozwolone ${SPRINT_STATES.join('|')}`);
          if (v === 'ready') throw new Error('stan ready ustawia product ready <id> (po kontroli gotowości)');
          // Recenzja N-4: `ordered` (zlecony) tylko po gotowości; inaczej ominąłby kontrolę gotowości.
          if (v === 'ordered' && !['ready', 'ordered'].includes(l.state)) throw new Error(`${id}: stan ordered tylko ze stanu ready (jest ${l.state}): najpierw product ready ${id} [--direct]`);
          if (v === 'todo' && !['topic', 'notes', 'todo', 'ready', 'ordered'].includes(l.state)) throw new Error(`${id}: state todo only from topic (with a sprint file), notes, ready or ordered (is ${l.state})`);
          const file = existsSync(specFile(P, id));
          if (v !== 'topic' && !file) throw new Error(`${id}: stan ${v} wymaga pliku sprintu (product spec new ${id})`);
          if (v === 'topic' && file) throw new Error(`${id}: topic nie ma pliku sprintu`);
          if (v === 'todo' && !specSections(readSpec(P, id).body).Goal?.trim()) throw new Error(`${id}: todo needs a sprint file with a non-empty ## Goal (product spec set ${id} --section Goal --text "<goal>")`);
          // Back below the readiness gate (from ready or ordered to todo or notes): the approval in the header goes too, so a
          // stopped run does not bring the line back to ready (sync) and ready-check does not inherit `direct`.
          if (['ready', 'ordered'].includes(l.state) && ['notes', 'todo'].includes(v)) unready = true;
          l.state = v;
          l.detail = v === 'topic' ? 'none' : `sprints/${id}.md`;
        } else if (k === 'goal') l.goal = v;
        else if (k === 'after') l.after = list(v === '-' ? '' : v);
        else if (k === 'alias') l.alias = nul(v);
        else throw new Error(`roadmap set: pole ${k}, dozwolone state|goal|after|alias${k === 'detail' ? ' (detail ustawia skrypt: product spec new <id> albo spec set <id> naprawia linię z plikiem sprintu)' : ''}`);
      }
      // K5 D-18: the sprint file losing its approval is checked before the roadmap is written.
      const s = unready && ['notes', 'todo'].includes(l.state) ? readSpec(P, id) : null;
      let chk = null;
      if (s?.h.ready) { s.h.ready = null; chk = specCheck(P, id, s.h, s.body); }
      saveRoadmap(P, lines, `${id} ${pos.slice(1).join(' ')}`);
      if (chk) putSpec(chk);
      return { ok: true, line: roadmapLine(l) };
    }
    if (sub === 'drop') {
      lines.splice(lines.indexOf(l), 1);
      const spec = readSpec(P, id);
      const { open } = loadItems(P);
      for (const x of open) if (x.sprint === id && x.state === 'planned') Object.assign(x, { sprint: null, state: 'open' });
      roadmapCheck(P, lines);
      writeJsonl(P.backlog, open);
      saveRoadmap(P, lines, null);
      if (spec) { mkdirSync(P.archive, { recursive: true }); renameSync(spec.file, join(P.archive, `${id}.md`)); }
      appendIndex(P, [{ id, goal: cut(`${l.goal}${opts.reason && opts.reason !== true ? ` (dropped: ${opts.reason})` : ' (dropped)'}`, 160), merged: 'dropped', run: null, files: null, tokensM: null }]);
      logChange(P, `${id} dropped`, { kind: 'roadmap' });
      return { ok: true, dropped: id };
    }
    throw new Error('roadmap [next] | add <id> --goal g [--after a,b] [--alias x] [--before id|--position n] | add --second <run> [--state ordered] | move <id> --before id|--position n|--end | set <id> <state|goal|after|alias> <v> | drop <id> [--reason t] | todo-from-notes [--dry-run]');
  });
}

// ---------- miejsca pracy (K7, §3.12) ----------

// `product workplace add|assign|unassign|list|show|remove` (C-2): the record (`workplaces.jsonl`, D-3) and the sprint header
// `workTree` written together (D-4); every refusal is thrown before the first write (git or file).
const WORKPLACE_USAGE = 'workplace add [<name>] --branch <b> [--base <ref>] [--sprints <id,…>] | assign <name> <id…> | unassign <id…> | list | show <name> [--json] | remove <name>';
const worktreeRel = (cfg) => String(cfg.supervisor?.worktreeDir || '.claude/worktrees').replace(/\\/g, '/').replace(/\/+$/, '');
const refExists = (top, ref) => gitRaw(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: top }).status === 0;
const samePath = (a, b) => {
  const n = (p) => fwd(resolve(p)).replace(/\/+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};
// Batch T-1/F-3: a sprint assigned to a new workplace (or unassigned) leaves the removed records that still held it.
const releaseRemoved = (rows, ids) => { for (const w of rows) if (w.state !== 'active') w.sprints = asList(w.sprints).filter((s) => !ids.includes(s)); };
// Batch T-1/F-4: no local branch, but `<remote>/<branch>` exists (another machine, a colleague's branch) → that ref,
// `origin` first; null otherwise.
function remoteBranch(top, branch) {
  const remotes = String(gitRaw(['remote'], { cwd: top }).stdout ?? '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  for (const r of [...remotes.filter((x) => x === 'origin'), ...remotes.filter((x) => x !== 'origin')]) {
    if (gitRaw(['rev-parse', '--verify', '--quiet', `refs/remotes/${r}/${branch}`], { cwd: top }).status === 0) return `${r}/${branch}`;
  }
  return null;
}

// Sprint headers to write for `assign` (D-17): an open roadmap line with a sprint file, not running or done, not in another
// active workplace. → specCheck results (nothing written yet).
function assignChecks(c, rows, name, ids) {
  const { P } = c;
  const lines = loadRoadmap(P);
  return ids.map((id) => {
    const l = lines.find((x) => x.id === id);
    if (!l) throw new Error(`${id}: not an open sprint of the roadmap (closed or unknown)`);
    if (['running', 'done'].includes(l.state)) throw new Error(`${id}: sprint is ${l.state}, its work has started: assign only sprints not started yet`);
    const other = rows.find((w) => w.state === 'active' && w.name !== name && asList(w.sprints).includes(id));
    if (other) throw new Error(`${id}: already in workplace ${other.name} (branch ${other.branch}): product workplace unassign ${id} first`);
    const s = readSpec(P, id);
    if (!s) throw new Error(`${id}: no sprint file (topic): product spec new ${id} first`);
    s.h.workTree = name;
    return specCheck(P, id, s.h, s.body);
  });
}

function workplaceAdd(c, pos, opts) {
  const { P, top, cfg } = c;
  const branch = String(need(opts.branch, '--branch <branch>'));
  // A-1: the name defaults to the last segment of the branch.
  const name = pos[0] !== undefined && pos[0] !== true ? String(pos[0]) : branch.split('/').filter(Boolean).at(-1) ?? '';
  const ids = list(opts.sprints === true ? '' : opts.sprints);
  return withLock(P, () => {
    const rows = readWorkplaces(P);
    const active = rows.filter((w) => w.state === 'active');
    if (!SPRINT_ID.test(name)) throw new Error(`workplace name ${name || '(empty)'}: [a-z0-9._-], starting with a letter or digit (give it: product workplace add <name> --branch ${branch})`);
    if (active.some((w) => w.name === name)) throw new Error(`workplace ${name} already exists (branch ${active.find((w) => w.name === name).branch}): another name, or product workplace assign ${name} <id…>`);
    if (gitRaw(['check-ref-format', '--branch', branch], { cwd: top }).status !== 0) throw new Error(`--branch ${branch}: not a valid branch name`);
    const homeBranch = gitRaw(['branch', '--show-current'], { cwd: top }).stdout.trim();
    if (branch === homeBranch) throw new Error(`--branch ${branch}: the home tree's own branch; a workplace is a separate branch (e.g. feature/<name>)`);
    if (branch === cfg.git.target) throw new Error(`--branch ${branch}: the target branch (git.target); sprints squash into it already without a workplace`);
    if (cfg.git.branchPrefix && branch.startsWith(cfg.git.branchPrefix)) throw new Error(`--branch ${branch}: a run branch (git.branchPrefix ${cfg.git.branchPrefix})`);
    const owner = active.find((w) => w.branch === branch);
    if (owner) throw new Error(`--branch ${branch}: already the branch of workplace ${owner.name}`);
    const exists = gitRaw(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: top }).status === 0;
    // An existing branch is used as is (AC-1), also when only the remote has it: the local branch tracks it, base = that ref.
    const remote = exists ? null : remoteBranch(top, branch);
    const givenBase = opts.base !== undefined && opts.base !== true ? String(opts.base) : null;
    const baseRef = remote ?? givenBase ?? (homeBranch || cfg.git.target);
    if (!baseRef || !refExists(top, baseRef)) throw new Error(`--base ${baseRef || '(none: the home tree has no branch)'}: no such branch or commit`);
    // Batch T-1/F-3: a removed workplace of this name still holding open sprints (their headers name it): they come along
    // with --sprints or are unassigned first, so record and headers agree.
    const held = [...new Set(rows.filter((w) => w.state !== 'active' && w.name === name).flatMap((w) => openSprintsOf(top, w)))].filter((id) => !ids.includes(id));
    if (held.length) throw new Error(`workplace ${name} was removed with open sprints ${held.join(', ')} (their headers name it): add them with --sprints ${[...ids, ...held].join(',')}, or product workplace unassign ${held.join(' ')} first`);
    let tree = exists ? worktreeFor(top, branch) : null;
    const dirRel = worktreeRel(cfg);
    const wt = fwd(resolve(top, dirRel, name));
    if (!tree && existsSync(wt)) throw new Error(`worktree directory ${wt} already exists: another name, or remove the directory`);
    const chks = assignChecks(c, rows, name, ids);
    // Every check passed: git writes, then the record and the sprint headers.
    const baseCommit = exists ? git(['merge-base', baseRef, `refs/heads/${branch}`], { cwd: top }) : git(['rev-parse', `${baseRef}^{commit}`], { cwd: top });
    if (!tree) {
      if (gitRaw(['check-ignore', '-q', `${dirRel}/${name}`], { cwd: top }).status !== 0) {
        const exclude = join(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: top }), 'info', 'exclude');
        mkdirSync(dirname(exclude), { recursive: true });
        const ex = existsSync(exclude) ? read(exclude) : '';
        appendFileSync(exclude, `${ex && !ex.endsWith('\n') ? '\n' : ''}/${dirRel}/\n`);
      }
      mkdirSync(dirname(wt), { recursive: true });
      // An existing branch is checked out as it is (R-1); a missing one starts at the base.
      // A branch only on the remote: a local branch tracking it (as `git switch <branch>` would), never a new one.
      git(['worktree', 'add', '-q', ...(exists ? [wt, branch] : remote ? ['--track', '-b', branch, wt, remote] : ['-b', branch, wt, baseCommit])], { cwd: top });
      tree = wt;
    }
    const made = !exists && !remote;
    const wp = { name, branch, path: recordPath(top, tree), base: { ref: baseRef, commit: baseCommit, at: today() }, created: made, sprints: ids, state: 'active', at: today() };
    releaseRemoved(rows, ids);
    saveWorkplaces(P, [...rows, wp]);
    const warnings = [
      ...(remote && givenBase && givenBase !== remote ? [`--base ${givenBase} ignored: branch ${branch} exists on the remote (${remote}) and is used as is`] : []),
      ...chks.map(putSpec).filter(Boolean),
    ];
    logChange(P, `workplace ${name} added (branch ${branch}${exists ? '' : remote ? `, tracking ${remote}` : `, new from ${baseRef}`}${ids.length ? `; sprints ${ids.join(', ')}` : ''})`, { kind: 'workplace' });
    return { ok: true, workplace: wp, created: made, tree, ...(warnings.length ? { warnings } : {}) };
  });
}

function workplaceLine(top, wp) {
  const sp = workplaceSprints(top, wp);
  const r = workplaceReady(top, wp);
  return `${wp.name} · ${wp.branch} · sprints ${sp.filter((s) => ['done', 'uat'].includes(s.state)).length}/${sp.length}${r.ready ? (branchPushed(top, wp.branch) ? ' · pushed' : ` · ready to push: ${r.pushCmd}`) : ''}`;
}

function cmdWorkplace(c, sub, pos, opts) {
  const { P, top } = c;
  if (sub === 'list') {
    const act = readWorkplaces(P).filter((w) => w.state === 'active');
    return act.length ? act.map((w) => workplaceLine(top, w)).join('\n') : 'workplaces: none';
  }
  if (sub === 'show') {
    const name = need(pos[0], 'workplace name');
    const all = readWorkplaces(P).filter((w) => w.name === name);
    const wp = all.find((w) => w.state === 'active') ?? all.at(-1);
    if (!wp) throw new Error(`no workplace ${name} (product workplace list)`);
    const res = { workplace: wp, tree: workplaceTree(top, wp), sprints: workplaceSprints(top, wp), facts: workplaceFacts(top, wp), ready: workplaceReady(top, wp) };
    if (opts.json) return res;
    const f = res.facts;
    return [
      `workplace ${wp.name} (${wp.state}) · branch ${wp.branch}${wp.created ? ' (created by dwmt)' : ''} · base ${wp.base?.ref ?? '-'}`,
      `tree: ${res.tree ?? `none (record: ${wp.path})`}${f.dirty ? ` · uncommitted: ${f.dirty} (${f.dirtyFiles.join(', ')})` : ''}`,
      `against ${f.baseRef ?? '-'}: ahead ${f.ahead ?? '-'}, behind ${f.behind ?? '-'}${f.behind > c.pc.workplace.farBehind ? ` (more than ${c.pc.workplace.farBehind})` : ''} · pushed: ${f.pushed ? 'yes' : 'no'}`,
      `sprints: ${res.sprints.length ? res.sprints.map((s) => `${s.id} ${s.k}/${s.n} ${s.state}${s.commit ? ` ${s.commit}` : ''}`).join('; ') : 'none'}`,
      ...(res.ready.ready ? [`ready to push: ${wp.branch} (${res.ready.n} sprints): ${res.ready.pushCmd}`] : []),
    ].join('\n');
  }
  requireWrite(c);
  if (sub === 'add') return workplaceAdd(c, pos, opts);
  if (sub === 'assign') {
    const name = need(pos[0], 'workplace name');
    const ids = pos.slice(1).flatMap((x) => list(x));
    if (!ids.length) throw new Error('workplace assign <name> <id…>');
    return withLock(P, () => {
      const rows = readWorkplaces(P);
      const wp = rows.find((w) => w.state === 'active' && w.name === name);
      if (!wp) throw new Error(`no active workplace ${name} (product workplace list)`);
      const add = ids.filter((id) => !asList(wp.sprints).includes(id));
      const chks = assignChecks(c, rows, name, add);
      wp.sprints = [...asList(wp.sprints), ...add];
      releaseRemoved(rows, add);
      saveWorkplaces(P, rows);
      const warnings = chks.map(putSpec).filter(Boolean);
      if (add.length) logChange(P, `workplace ${name}: ${add.join(', ')} assigned`, { kind: 'workplace' });
      return { ok: true, workplace: name, sprints: wp.sprints, ...(warnings.length ? { warnings } : {}) };
    });
  }
  if (sub === 'unassign') {
    const ids = pos.flatMap((x) => list(x));
    if (!ids.length) throw new Error('workplace unassign <id…>');
    return withLock(P, () => {
      const rows = readWorkplaces(P);
      const lines = loadRoadmap(P);
      const chks = ids.map((id) => {
        // Batch T-1/F-3: also a sprint a removed workplace still holds (its header names it; startBlock points here).
        const wp = rows.find((w) => w.state === 'active' && asList(w.sprints).includes(id))
          ?? rows.filter((w) => w.state !== 'active' && asList(w.sprints).includes(id)).at(-1);
        if (!wp) throw new Error(`${id}: not in any workplace`);
        // A-7: a running or finished sprint stays: its work is on the workplace branch already.
        const l = lines.find((x) => x.id === id);
        if (!l || ['running', 'done'].includes(l.state)) throw new Error(`${id}: sprint is ${l?.state ?? 'closed'}, its work is on branch ${wp.branch} already`);
        const s = readSpec(P, id);
        if (!s) return { wp, id, chk: null };
        delete s.h.workTree;
        return { wp, id, chk: specCheck(P, id, s.h, s.body) };
      });
      for (const x of chks) x.wp.sprints = asList(x.wp.sprints).filter((s) => s !== x.id);
      releaseRemoved(rows, ids);
      saveWorkplaces(P, rows);
      for (const x of chks) if (x.chk) putSpec(x.chk);
      logChange(P, `workplace: ${ids.join(', ')} unassigned`, { kind: 'workplace' });
      return { ok: true, unassigned: ids };
    });
  }
  if (sub === 'remove') {
    const name = need(pos[0], 'workplace name');
    return withLock(P, () => {
      const rows = readWorkplaces(P);
      const wp = rows.find((w) => w.state === 'active' && w.name === name);
      if (!wp) throw new Error(`no active workplace ${name} (product workplace list)`);
      const busy = workplaceSprints(top, wp).filter((s) => s.state === 'running');
      if (busy.length) throw new Error(`workplace ${name}: sprint ${busy.map((s) => s.id).join(', ')} is running; remove it after the run ends`);
      const tree = workplaceTree(top, wp);
      // Batch T-1/F-2: only the tree dwmt made at its own place (`<worktreeDir>/<name>`) goes; a tree of the user that
      // the workplace adopted (D-5) stays, with its ignored files.
      const own = !!tree && samePath(tree, resolve(top, worktreeRel(c.cfg), wp.name));
      const kept = !!tree && !own;
      if (own && existsSync(tree)) {
        // D-9: without force; a dirty tree is refused (git refuses too); the branch is never deleted.
        const r = removeWorktree(top, tree, { force: false });
        if (r.status !== 0) throw new Error(`workplace ${name}: worktree ${tree} not removed: ${String(r.stderr || r.stdout).trim().split(/\r?\n/)[0]}`);
      }
      // Batch T-1/F-3: its open sprints stay assigned (record and headers) and do not start (startBlock `removed`) until
      // they are assigned to another workplace or unassigned.
      const held = openSprintsOf(top, wp);
      wp.state = 'removed';
      saveWorkplaces(P, rows);
      logChange(P, `workplace ${name} removed (branch ${wp.branch} kept${kept ? `; tree ${tree} kept: not made by dwmt` : ''})`, { kind: 'workplace' });
      const hint = [
        kept ? `tree ${tree} kept: dwmt did not create it` : null,
        held.length ? `sprints ${held.join(', ')} stay assigned to the removed workplace and will not start: product workplace assign <name> ${held.join(' ')} or product workplace unassign ${held.join(' ')}` : null,
      ].filter(Boolean);
      return { ok: true, removed: name, tree, branch: wp.branch, ...(kept ? { treeKept: true } : {}), ...(held.length ? { held } : {}), ...(hint.length ? { hint: hint.join('; ') } : {}) };
    });
  }
  throw new Error(WORKPLACE_USAGE);
}

// ---------- plik sprintu ----------

// Przydział do sprintu w obu miejscach (§3.3): `sprint` w pozycji i id w `items`/`touch` pliku.
// K5 D-18: `assignIn` edits a loaded backlog in memory (throws before any write); `assign` also writes it.
function assign(P, id, field, add, remove) {
  const { open } = loadItems(P);
  assignIn(open, id, field, add, remove);
  writeJsonl(P.backlog, open);
}
function assignIn(open, id, field, add, remove) {
  for (const ref of add) {
    const x = open.find((i) => i.id === ref);
    if (!x) throw new Error(`${ref}: brak otwartej pozycji`);
    if (['done', 'dropped'].includes(x.state)) throw new Error(`${ref}: pozycja ${x.state}`);
    if (x.sprint && x.sprint !== id) throw new Error(`${ref}: już w sprincie ${x.sprint}`);
    Object.assign(x, { sprint: id, state: 'planned', ...(field === 'items' ? { triage: `sprint:${id}` } : {}) });
  }
  for (const ref of remove) { const x = open.find((i) => i.id === ref); if (x && x.sprint === id) Object.assign(x, { sprint: null, state: 'open' }); }
  return open;
}
function listEdit(cur, raw) {
  const v = list(raw);
  if (!v.length || !v.every((x) => /^[+-]/.test(x))) return { next: v.filter((x) => x !== '-'), add: v.filter((x) => !cur.includes(x)), remove: cur.filter((x) => !v.includes(x)) };
  const add = v.filter((x) => x.startsWith('+')).map((x) => x.slice(1));
  const remove = v.filter((x) => x.startsWith('-')).map((x) => x.slice(1));
  return { next: [...cur.filter((x) => !remove.includes(x)), ...add.filter((x) => !cur.includes(x))], add: add.filter((x) => !cur.includes(x)), remove };
}
// K5 D-18: `pend` collects the items and touch edits; the caller assigns them after every pair and check.
function setHeaderField(P, h, id, k, raw, pend = null) {
  if (['items', 'touch'].includes(k)) {
    const e = listEdit(asList(h[k]), raw);
    if (pend) pend.push({ field: k, add: e.add, remove: e.remove }); else assign(P, id, k, e.add, e.remove);
    h[k] = e.next;
    return true;
  }
  if (k === 'refs') { h.refs = listEdit(asList(h.refs), raw).next; return false; }
  const v = k === 'kind' ? specKind(nul(raw)) : nul(raw);
  if (k === 'kind' && v !== null && !SPEC_KINDS.includes(v)) throw new Error(`kind ${v}, dozwolone ${SPEC_KINDS.join('|')} (fix = bugfix)`);
  if (k === 'mode' && v !== null && !SPEC_MODES.includes(v)) throw new Error(`mode ${v}, dozwolone ${SPEC_MODES.join('|')}`);
  if (k === 'est' && v !== null && !estimateOf(P, v)) throw new Error(`est ${v}: E-n z estimates.jsonl albo start:[min,max]`);
  // K7 D-4: one writer of `workTree` (record and header together).
  if (k === 'workTree') throw new Error('spec set: workTree is written by product workplace assign <name> <id> (and unassign <id>), with the workplace record');
  if (['uatGate', 'ui'].includes(k)) h[k] = v === 'true' || v === true; else if (['kind', 'goal', 'mode', 'est', 'run'].includes(k)) h[k] = v;
  else throw new Error(`spec set: pole ${k}, dozwolone kind|goal|items|touch|refs|uatGate|ui|mode|est|run`);
  return false;
}

// Linia roadmapy sprintu z plikiem: `topic` → `notes`, detail na plik (ten sam skutek co `spec new`).
function healLine(l, id) {
  if (l.state === 'topic') l.state = 'notes';
  l.detail = `sprints/${id}.md`;
}

const SPEC_USAGE ='spec new <id> [--goal g] [--items B-1,B-2] [--kind feature|bugfix|fix|maintenance] [--ui] [--file body.md] [--todo] | set <id> [<pole> <wartość>…] [--file plik.md] [--section Name --text t] | bugfix|fix <B-n…> [--id id] [--goal g] [--file body.md] [--before id|--after id] (pozycje bug i remark: sprint poprawek gotowy od razu)';
// `## For you` of a closed sprint (archive/, e.g. waiting for review): the only section written there.
function archiveForYou(c, id, text) {
  const { P } = c;
  const file = archiveSpecFile(P, id);
  return withLock(P, () => {
    const s = readSpecAt(file);
    if (!s) throw new Error(`${id}: no sprint file in the roadmap or archive`);
    const warning = writeSpecAt(file, s.h, setSection(s.body, FOR_YOU, text));
    logChange(P, `${id} spec ${FOR_YOU} (archive)`, { kind: 'spec' });
    return { ok: true, spec: `${c.pc.dir}/archive/${id}.md`, ...(warning ? { warning } : {}) };
  });
}
function cmdSpec(c, sub, pos, opts) {
  const { P } = c;
  requireWrite(c);
  // Przegląd 2026-10-09 (W-7): jedna ścieżka sprintu poprawek z uwag (`spec fix` = `spec bugfix`, pozycje bug i remark).
  if (sub === 'bugfix' || sub === 'fix') return specBugfix(c, pos, opts);
  if (opts.help || pos[0] === undefined || pos[0] === true) throw new Error(SPEC_USAGE);
  const id = pos[0];
  const sectionText = () => (opts.text && opts.text !== true ? opts.text : opts.file ? read(opts.file) : need(opts.text, '--text'));
  if (sub === 'set' && isForYou(opts.section) && pos.length === 1 && !loadRoadmap(P).some((x) => x.id === id) && existsSync(archiveSpecFile(P, id))) return archiveForYou(c, id, sectionText());
  const todo = !!opts.todo && opts.todo !== 'false';
  return withLock(P, () => {
    const lines = loadRoadmap(P);
    const l = lines.find((x) => x.id === id);
    if (!l) throw new Error(`brak ${id} w roadmapie: najpierw product roadmap add ${id} --goal "<cel>" (sprint poprawek z uwag: product spec fix <B-n…> --id ${id})`);
    let warning = null;
    // `--todo` (§3.9): the file and the `todo` state in one step; todo needs a non-empty `## Goal`.
    const toTodo = (body) => {
      if (!todo) return;
      if (!specSections(body).Goal?.trim()) throw new Error(`${id}: --todo needs a non-empty ## Goal`);
      if (['topic', 'notes'].includes(l.state)) l.state = 'todo';
    };
    if (sub === 'new') {
      if (existsSync(specFile(P, id))) {
        // W-7: plik został z poprzedniej próby, a linia roadmapy nadal `topic`: naprawa linii zamiast błędu bez wyjścia.
        if (l.detail !== `sprints/${id}.md`) {
          healLine(l, id);
          toTodo(readSpec(P, id).body);
          saveRoadmap(P, lines, `${id} ${l.state} (plik sprintu był już zapisany)`);
          return { ok: true, repaired: true, spec: `${c.pc.dir}/sprints/${id}.md`, hint: `plik sprintu już był; linia roadmapy poprawiona (${l.state}, sprints/${id}.md); zmiany: product spec set ${id} …` };
        }
        throw new Error(`${id}: plik sprintu już istnieje: product spec set ${id} <pole> <wartość> albo --file <plik.md>`);
      }
      const h = { schema: 'dwmt/sprint-spec@1', id, kind: specKind(nul(opts.kind)) ?? 'feature', items: [], touch: [], refs: list(opts.refs), uatGate: false, ui: opts.ui === true || opts.ui === 'true', mode: 'auto', est: null, ready: null, run: null, actual: null };
      if (!SPEC_KINDS.includes(h.kind)) throw new Error(`kind ${h.kind}, dozwolone ${SPEC_KINDS.join('|')} (fix = bugfix)`);
      const body0 = opts.file ? read(opts.file) : `## Goal\n${nul(opts.goal) ?? l.goal}\n\n## Notes\n${nul(opts.notes) ?? '-'}\n`;
      const body = splitHeader(body0)?.body ?? body0;
      // W-7: najpierw sprawdzenie roadmapy po zmianie (limit 2 KB), potem zapis pliku: błąd nie zostawia pliku bez linii.
      healLine(l, id);
      toTodo(body);
      // K5 D-18: roadmap, sprint file and backlog edits checked before the first write.
      roadmapCheck(P, lines);
      const items = list(opts.items);
      h.items = items;
      const chk = specCheck(P, id, h, body);
      const open = items.length ? assignIn(loadItems(P).open, id, 'items', items, []) : null;
      if (open) writeJsonl(P.backlog, open);
      warning = putSpec(chk);
      saveRoadmap(P, lines, `${id} ${l.state}`);
      return { ok: true, spec: `${c.pc.dir}/sprints/${id}.md`, items, ...(warning ? { warning } : {}) };
    }
    if (sub === 'set') {
      const s = readSpec(P, id);
      if (!s) throw new Error(`${id}: brak pliku sprintu (product spec new ${id})`);
      let { h, body } = s;
      let scope = false;
      const pend = [];
      if (opts.file && !opts.section) {
        const t = read(opts.file);
        const sp = splitHeader(t);
        if (sp) { const nh = parseYaml(sp.yaml); for (const [k, v] of Object.entries(nh)) if (!['schema', 'id'].includes(k) && !(k === 'workTree' && (v ?? null) === (h.workTree ?? null))) scope = setHeaderField(P, h, id, k, Array.isArray(v) ? v.join(',') || '-' : v === null ? '-' : String(typeof v === 'object' ? JSON.stringify(v) : v), pend) || scope; }
        // A new body without `## For you` keeps the existing section (it is the user's, written apart from the body).
        const kept = forYouText(body);
        body = sp ? sp.body : t;
        if (kept !== null && forYouText(body) === null) body = setSection(body, FOR_YOU, kept);
        scope = true;
      }
      if (opts.section) {
        const name = String(opts.section);
        body = setSection(body, name, opts.text && opts.text !== true ? opts.text : opts.file ? read(opts.file) : need(opts.text, '--text'));
        if (['Acceptance', 'Decisions', 'Goal', 'Out of scope'].includes(name)) scope = true;
      }
      for (let i = 1; i < pos.length; i += 2) {
        if (pos[i + 1] === undefined) throw new Error(`spec set: brak wartości dla ${pos[i]}`);
        scope = setHeaderField(P, h, id, pos[i], pos[i + 1], pend) || scope;
      }
      // K5 D-18: every pair and check first (sprint file, backlog edits, roadmap line), then the writes.
      const chk = specCheck(P, id, h, body);
      let open = null;
      if (pend.length) { open = loadItems(P).open; for (const x of pend) assignIn(open, id, x.field, x.add, x.remove); }
      const heal = l.detail !== `sprints/${id}.md`;
      if (heal) { healLine(l, id); roadmapCheck(P, lines); }
      if (open) writeJsonl(P.backlog, open);
      warning = putSpec(chk);
      if (heal) saveRoadmap(P, lines, `${id} notes (linia roadmapy bez pliku)`);
      if (scope) markStale(P, [id]);
      logChange(P, `${id} spec ${[...(opts.file ? ['file'] : []), ...(opts.section ? [opts.section] : []), ...pos.slice(1).filter((_, i) => i % 2 === 0)].join(', ')}`, { kind: 'spec' });
      return { ok: true, spec: `${c.pc.dir}/sprints/${id}.md`, ...(warning ? { warning } : {}) };
    }
    throw new Error(SPEC_USAGE);
  });
}

// `spec bugfix` (§3.5): z pozycji `bug`, bez refinementu; decyzja `now` = zatwierdzenie gotowości.
// Przegląd 2026-10-09 (W-7): także uwagi (`remark`, np. z recenzji), alias `spec fix` (fix-review-1009: ok. 12 nieudanych
// wywołań przez `spec new --kind fix`, `roadmap set detail` i limit 2 KB). `--goal` krótszy cel linii, `--file` własna treść
// (nagłówek pliku, jeśli jest, pomijany); limit roadmapy sprawdzany przed zapisem pliku.
const FIX_TYPES = ['bug', 'remark'];
function specBugfix(c, pos, opts) {
  const { P } = c;
  const refs = pos.flatMap((p) => list(p));
  if (!refs.length) throw new Error('spec fix <B-n…> [--id id] [--goal g] [--file body.md] [--before id|--after id] (pozycje bug i remark)');
  return withLock(P, () => {
    const { open } = loadItems(P);
    const bugs = refs.map((r) => { const x = open.find((i) => i.id === r); if (!x) throw new Error(`${r}: brak otwartej pozycji`); if (!FIX_TYPES.includes(x.type)) throw new Error(`${r}: typ ${x.type}, sprint poprawek bierze ${FIX_TYPES.join('|')} (inne: product spec new <id> --items …)`); return x; });
    const lines = loadRoadmap(P);
    const id = nul(opts.id) ?? `fix-${bugs[0].id.toLowerCase()}`;
    if (lines.some((l) => l.id === id) || loadIndex(P).some((x) => x.id === id) || existsSync(specFile(P, id))) throw new Error(`sprint ${id} już istnieje: podaj inne --id (zmiany istniejącego: product spec set ${id} …)`);
    const src = opts.after ? lines.findIndex((l) => l.id === opts.after) : -1;
    const ids = bugs.map((b) => b.id);
    const idList = ids.length > 3 ? `${ids.slice(0, 2).join(', ')} (+${ids.length - 2})` : ids.join(', ');
    const line = { id, state: 'ready', goal: cut(nul(opts.goal) ?? `Fix ${idList}: ${bugs[0].title}`, BUDGET.goal), after: src >= 0 ? [opts.after] : [], detail: `sprints/${id}.md`, alias: null, current: false };
    if (opts.before) insertAt(lines, line, { before: opts.before });
    else if (src >= 0) lines.splice(src + 1, 0, line);
    else { const at = lines.findIndex((l) => l.state !== 'running'); lines.splice(at < 0 ? lines.length : at, 0, line); }
    roadmapCheck(P, lines);
    const h = { schema: 'dwmt/sprint-spec@1', id, kind: 'bugfix', goal: 'time to fix', items: ids, touch: [], refs: [], uatGate: false, ui: false, mode: nul(opts.mode) ?? 'auto', est: null, ready: { at: today(), by: 'decydent' }, run: null, actual: null };
    // K5 D-19: lean text: item ids only (titles stay in the backlog, `product sprint` expands them) and one criterion.
    const own = opts.file && opts.file !== true ? read(opts.file) : null;
    const body = own ? (splitHeader(own)?.body ?? own) : [
      '## Goal', `Resolve the ${ids.length} listed items: ${ids.join(', ')}.`, '',
      '## Acceptance', `- AC-1 Each listed item is resolved: a bug no longer happens (its repro steps), a remark no longer holds (details: product item <id> --detail).`, '',
      '## Out of scope', `- Anything beyond the listed items.`, '',
    ].join('\n');
    // K5 D-18: sprint file and backlog edits checked before the first write (a refused fix sprint pins nothing).
    const chk = specCheck(P, id, h, body);
    writeJsonl(P.backlog, assignIn(loadItems(P).open, id, 'items', ids, []));
    const warning = putSpec(chk);
    saveRoadmap(P, lines, `${id} bugfix ready (${ids.join(', ')})`);
    return { ok: true, id, spec: `${c.pc.dir}/sprints/${id}.md`, line: roadmapLine(line), ...(warning ? { warning } : {}) };
  });
}

// Sprint poprawek z UAT w roadmapie (§4.6; cel reguły T2 `sprint:<źródło>-fix`): linia `<źródło>-fix` zaraz za sprintem
// źródłowym i plik `bugfix` (ready) z pozycjami `bug` tego UAT, gdy jest wśród nich blocker albo major (minor dołącza).
// Kolejny wpis UAT dokłada pozycje do istniejącego pliku. Przebieg z `uat.md` dostaje `run.spec` = to id (init), więc
// `sync` zamyka linię i pozycje po scaleniu. ZAŁOŻENIE (budujący B, N-4).
function uatFixSprint(c, sid) {
  const { P } = c;
  const fixId = `${sid}-fix`;
  const bugs = loadItems(P).open.filter((x) => x.type === 'bug' && x.state === 'new' && String(x.src ?? '').startsWith(`uat:${sid}/`));
  const s = readSpec(P, fixId);
  if (s) {
    if (!bugs.length) return null;
    return withLock(P, () => {
      const ids = bugs.map((b) => b.id);
      s.h.items = [...new Set([...asList(s.h.items), ...ids])];
      // K5 D-18: checked before the first write.
      const chk = specCheck(P, fixId, s.h, s.body);
      writeJsonl(P.backlog, assignIn(loadItems(P).open, fixId, 'items', ids, []));
      putSpec(chk);
      logChange(P, `${fixId} items +${ids.join(', +')} (UAT ${sid})`, { kind: 'spec' });
      return fixId;
    });
  }
  if (!bugs.some((x) => ['blocker', 'major'].includes(x.sev))) return null;
  if (loadRoadmap(P).some((l) => l.id === fixId) || loadIndex(P).some((x) => x.id === fixId)) return null;
  specBugfix(c, bugs.map((b) => b.id), { id: fixId, after: sid });
  return fixId;
}

// ---------- sprint <id> (§3.9) ----------

function cmdSprint(c, id, opts) {
  const { P } = c;
  const lines = loadRoadmap(P);
  const l = lines.find((x) => x.id === id);
  const arch = !l ? loadIndex(P).find((x) => x.id === id) : null;
  if (!l && !arch) throw new Error(`brak sprintu ${id} w roadmapie ani w archiwum`);
  const s = l ? readSpec(P, id) : (existsSync(join(P.archive, `${id}.md`)) ? (() => { const t = read(join(P.archive, `${id}.md`)).replace(/\r\n/g, '\n'); const sp = splitHeader(t); return { h: parseYaml(sp?.yaml ?? ''), body: sp?.body ?? t, text: t }; })() : null);
  const { open, archived } = loadItems(P);
  const all = [...open, ...archived];
  const { active } = loadDecisions(P);
  const exp = (ids) => asList(ids).map((r) => { const x = all.find((i) => i.id === r); return x ? `- ${itemLine(x)}${x.note ? ` — ${x.note}` : ''}${x.anchors.length ? ` [anchors: ${x.anchors.join(', ')}]` : ''}` : `- ${r} (missing)`; });
  const pds = [...new Set((specSections(s?.body ?? '').Decisions ?? '').match(/\bPD-\d+\b/g) ?? [])];
  const extra = [
    ...(s?.h.items?.length ? ['## Items (expanded)', ...exp(s.h.items), ''] : []),
    ...(s?.h.touch?.length ? ['## Touch items (expanded)', ...exp(s.h.touch), ''] : []),
    ...(pds.length ? ['## Decisions (expanded)', ...pds.map((p) => { const d = active.find((x) => x.id === p); return d ? renderDecision(d) : `### ${p} (missing or superseded)`; }), ''] : []),
    ...(asList(s?.h.refs).length ? ['## Refs (read with dwmt section <file> <heading>)', ...asList(s.h.refs).map((r) => `- ${r}`), ''] : []),
  ].join('\n');
  // `## For you` is the decision-maker's section (§3.5): agents never get it (this text feeds task.md and supervisor inputs).
  const body = `${stripForYou(s?.body).trim()}\n${extra ? `\n${extra}` : ''}`;
  const state = l?.state ?? (arch.merged === 'dropped' ? 'dropped' : 'closed');
  if (opts.json) return { id, state, goal: l?.goal ?? arch.goal, after: l?.after ?? [], alias: l?.alias ?? null, header: s?.h ?? null, body };
  const head = l ? roadmapLine({ ...l, current: false }) : `${id} · ${state} · ${arch.goal} (archive)`;
  if (!s) return `${head}\nno sprint file (topic): settle the scope at execution or refinement`;
  return `${head}\n---\n${Object.entries(s.h).map(([k, v]) => `${k}: ${JSON.stringify(v ?? null)}`).join('\n')}\n---\n${body}`.trimEnd();
}

// ---------- gotowość (§4.8 krok 8) ----------

function readyCheck(c, id, direct0) {
  const { P } = c;
  const lines = loadRoadmap(P);
  const l = lines.find((x) => x.id === id);
  if (!l) throw new Error(`brak ${id} w roadmapie`);
  const s = readSpec(P, id);
  if (!s) return { ok: false, errors: [`${id}: brak pliku sprintu (topic): product spec new ${id}`], warnings: [] };
  // W-7: sprint zatwierdzony `ready --direct` przechodzi `ready-check` także bez flagi (fix-review-1009: ready ok, potem
  // ready-check „start wystarcza tylko z --direct”).
  const direct = direct0 || !!s.h.ready?.direct;
  const sec = specSections(s.body);
  const errors = [];
  const warnings = [];
  if (!sec.Goal?.trim()) errors.push('## Goal pusty');
  if (!/\bAC-\d+\b/.test(sec.Acceptance ?? '')) errors.push('## Acceptance bez AC-n');
  if (!('Out of scope' in sec)) errors.push('brak ## Out of scope (może brzmieć "nothing")');
  const oq = (sec['Open questions'] ?? '').split('\n').map((x) => x.trim()).filter((x) => x && !/^[-*]?\s*(none|-)?\s*$/i.test(x));
  if (oq.some((x) => !/\[architect\]/i.test(x))) errors.push('## Open questions: pytania do decydenta (dozwolone tylko linie [architect])');
  const est = estimateOf(P, s.h.est);
  // Specyfikacja `bugfix` (§3.5) powstaje bez szacunku architekta: brak `est` nie blokuje gotowości (założenie B, N-4).
  if (!est && s.h.kind === 'bugfix') { /* bez wymogu est */ } else if (!est) errors.push(direct ? 'brak est (E-n albo start:[min,max])' : 'brak est E-n (start:[min,max] tylko z --direct)');
  else if (est.stale) errors.push(`${est.id} nieaktualny (stale): nowy szacunek albo cena startu z --direct`);
  else if (est.start && !direct) errors.push(`est start:[min,max] wystarcza tylko z --direct: product ready-check ${id} --direct (albo szacunek E-n)`);
  if (s.h.ui && !/variant/i.test(sec.Mockups ?? '') && !/\bSD-\d+\b.*\b(no|without) mockups?\b/i.test(sec.Decisions ?? '')) errors.push('ui: true bez ## Mockups z wybranym wariantem ani SD-n "no mockup"');
  // Przegląd a6-fix (2026-10-07): makiety A6 sprzed dwóch tygodni, dwie na jeden ekran, bez przejścia ścieżki na dzisiejszych
  // ekranach; pytania UX padły dopiero po UAT. Decyzja użytkownika: UX sprintu z ekranami należy do PO przed gotowością.
  if (s.h.ui && s.h.kind !== 'bugfix' && !sec.Journey?.trim()) errors.push('ui: true bez ## Journey (ścieżka użytkownika i wejścia na ekranach: krok PO "Screens (UX)")');
  const { active } = loadDecisions(P);
  for (const p of new Set((sec.Decisions ?? '').match(/\bPD-\d+\b/g) ?? [])) if (!active.some((d) => d.id === p)) errors.push(`${p}: brak albo zastąpiona`);
  const { open } = loadItems(P);
  for (const r of [...s.h.items, ...s.h.touch]) { const x = open.find((i) => i.id === r); if (!x) errors.push(`${r}: brak otwartej pozycji`); else if (x.state !== 'planned' || x.sprint !== id) errors.push(`${r}: stan ${x.state}, sprint ${x.sprint ?? '-'} (oczekiwano planned w ${id})`); }
  const at = lines.indexOf(l);
  for (const a of l.after) { const i = lines.findIndex((x) => x.id === a); if (i < 0 && !loadIndex(P).some((x) => x.id === a)) errors.push(`after ${a}: nie istnieje`); else if (i > at) errors.push(`after ${a}: stoi w roadmapie później`); }
  const sz = specSizeCheck(s.text);
  if (sz.error) errors.push(sz.error);
  if (sz.warning) warnings.push(sz.warning);
  return { ok: !errors.length, errors, warnings };
}

// ---------- touch (§4.8 krok 5) ----------

function cmdTouch(c, id, opts) {
  const { P, top, cfg } = c;
  return withLock(P, () => {
    const s = readSpec(P, id);
    if (!s) throw new Error(`${id}: brak pliku sprintu`);
    const areas = opts.globs ? globsOf(opts.globs) : asList(estimateOf(P, s.h.est)?.areas);
    if (!areas.length) throw new Error('brak obszarów: --globs <globy> albo est E-n z obszarami');
    const hit = globMatcher(areas);
    const files = trackedFiles(top, cfg);
    const { open } = loadItems(P);
    const all = open.filter((x) => x.triage === 'touch' && x.state === 'open' && !x.sprint && x.anchors.some((a) => anchorHit(a, hit, files)));
    // Przegląd sprintu 16 (UI): uwagi z recenzji albo UAT (12 uwag atrapy e2e przez kotwicę `frontend/e2e/**`) kosztowały w sprincie
    // z architektem ok. 0,37 mln na plik wobec 0,10 trybu direct: nie jadą przy okazji, wracają jako osobna grupa.
    // Przegląd a6 (2026-10-06): PO puścił taką grupę (B-169) przed sprintem i użytkownik nie wiedział po co. Decyzja
    // użytkownika: bez sprintów mieszanych, uwagi czekają na osobny sprint poprawkowy; długi (nie uwagi) dalej jadą w touch.
    const cand = all.filter((x) => !pinnedBySource(x));
    const sep = all.filter((x) => pinnedBySource(x));
    if (cand.length) {
      // K5 D-18: sprint file and backlog edits checked before the first write.
      s.h.touch = [...s.h.touch, ...cand.map((x) => x.id)];
      const chk = specCheck(P, id, s.h, s.body);
      assignIn(open, id, 'touch', cand.map((x) => x.id), []);
      writeJsonl(P.backlog, open);
      putSpec(chk);
      markStale(P, [id]);
      logChange(P, `${id} touch +${cand.map((x) => x.id).join(', +')}`, { kind: 'spec' });
    }
    return {
      ok: true, areas, added: cand.map((x) => itemLine({ ...x, state: 'planned', sprint: id })),
      ...(sep.length ? { separate: separateGroup(top, c.pc, sep), hint: 'uwagi z recenzji/UAT w tym obszarze: nie touch i nie przed sprintem; czekają na osobny sprint poprawkowy (separate.recommend), propozycja po tym sprincie' } : {}),
    };
  });
}

// ---------- commit (§3.1) ----------

// N-5: `intake` (przy `finish` i `uat record`) sam commituje katalog produktu w głównym drzewie: skrypt jest jedynym
// autorem plików produktu, a następny `init` na miejscu odmawiał przy niezacommitowanym katalogu. Commit obejmuje tylko
// ścieżki produktu (`productCommit`: `git add/commit -- <dir>`), nigdy innych zmian użytkownika; przy błędzie gita pliki
// zostają z ostrzeżeniem (jak dotąd: `product commit` przez PO).
// Commit tylko na gałęzi docelowej (główne drzewo na innej gałęzi należy do pracy użytkownika); przy `merge-wait` wcale
// (`--no-commit` z `finish`): commit przesunąłby cel i ponowny `finish` powtarzałby pełną suitę.
function intakeCommit(c, res, message) {
  try {
    const branch = git(['branch', '--show-current'], { cwd: c.top });
    if (branch !== c.cfg.git.target) return { ...res, warnings: [...asList(res.warnings), `product files not committed: main tree on ${branch || 'detached HEAD'}, not ${c.cfg.git.target} (dwmt product commit)`] };
    const r = productCommit(c, message);
    return r.committed ? { ...res, committed: r.commit } : res;
  } catch (e) { return { ...res, warnings: [...asList(res.warnings), `product commit: ${e.message.split(/\r?\n/)[0]}`] }; }
}

export function productCommit(c, message = null) {
  const { P, top, cfg } = c;
  const rel = c.pc.dir;
  const { key, repo } = mergeKey(top, cfg.git.target);
  return withLease(key, { who: 'product commit', cmd: `commit ${rel}`, repo }, () => {
    // The page in git is written only when its content changes (not for generatedAt alone), so a page change is a change.
    // D-5 (K2): the page enters the pathspec only when publishView wrote it (null with the view disabled or publish off).
    let pub = null;
    let viewWarning;
    if (c.pc.view?.publish) { try { pub = publishView(c, top); } catch (e) { viewWarning = `view publish: ${String(e.message).split(/\r?\n/)[0]}`; } }
    git(['add', '-A', '--', rel, ...(pub && !viewWarning ? [pub] : [])], { cwd: top });
    if (gitRaw(['diff', '--cached', '--quiet', '--', rel, ...(pub && !viewWarning ? [pub] : [])], { cwd: top }).status === 0) return { committed: false };
    const st = loadState(P);
    const ch = loadChanges(P).filter((x) => !st.lastCommit || x.at > st.lastCommit).map((x) => x.text);
    const subject = cut(message ?? (ch.length ? ch.join('; ') : 'product update'), 72);
    const body = ch.length > 1 || (message && ch.length) ? `\n\n${ch.slice(0, 40).map((x) => `- ${cut(x, 200)}`).join('\n')}` : '';
    git(['commit', '-q', '-m', `product: ${subject}${body}`, '--', rel, ...(pub && !viewWarning ? [pub] : [])], { cwd: top });
    updateState(P, () => ({ lastCommit: new Date().toISOString() }));
    return { committed: true, commit: git(['rev-parse', '--short=10', 'HEAD'], { cwd: top }), subject, ...(pub && !viewWarning ? { published: pub } : {}), ...(viewWarning ? { viewWarning } : {}) };
  });
}

// ---------- estimate ----------

function describeFor(c) {
  const { P } = c;
  const lines = loadRoadmap(P);
  const { open, archived } = loadItems(P);
  return (id) => {
    const l = lines.find((x) => x.id === id);
    if (l) {
      const s = readSpec(P, id);
      const sec = s ? specSections(s.body) : {};
      const items = s ? [...s.h.items, ...s.h.touch].map((r) => [...open, ...archived].find((x) => x.id === r)).filter(Boolean) : [];
      return [`### ${id} (sprint, ${l.state}): ${l.goal}`, ...['Goal', 'Acceptance', 'Out of scope', 'Notes'].filter((k) => sec[k]).map((k) => `${k}: ${cut(sec[k], 800)}`),
        ...items.map((x) => `- ${itemLine(x)}${x.note ? ` — ${x.note}` : ''}${x.anchors.length ? ` [anchors: ${x.anchors.join(', ')}]` : ''}`)].join('\n');
    }
    const x = [...open, ...archived].find((i) => i.id === id || String(i.alias ?? '').toLowerCase() === id.toLowerCase());
    if (!x) throw new Error(`${id}: brak sprintu w roadmapie ani pozycji`);
    const det = x.detail && existsSync(join(P.items, `${x.id}.md`)) ? read(join(P.items, `${x.id}.md`)).trim().split('\n').slice(0, BUDGET.detailLines) : [];
    return [`### ${x.id} (item): ${itemLine(x)}`, ...(x.note ? [`note: ${x.note}`] : []), ...(x.anchors.length ? [`anchors: ${x.anchors.join(', ')}`] : []), ...det].join('\n');
  };
}

function estimateRecord(c, id, opts) {
  const { P, top, cfg, pc } = c;
  if (!/^E-\d+$/.test(id)) throw new Error(`estimate-record ${id}: oczekiwano E-n`);
  const file = opts.file && opts.file !== true ? opts.file : join(P.work, `estimate-${id}`, 'result.md');
  if (!existsSync(file)) throw new Error(`brak wyniku szacunku ${fwd(file)}`);
  const { entries, facts } = parseEstimateResult(file);
  const runs = completedRuns(top, cfg, pc);
  // Bez --session i --cost: koszt subagenta tej sesji, którego prompt wskazuje ten plik wyniku (budujący B, N-4).
  const auto = () => (process.env.CLAUDE_CODE_SESSION_ID ? subagentCostByPrompt([process.env.CLAUDE_CODE_SESSION_ID], fwd(file)) : null);
  const cost = opts.session ? (sessionsCostOf(opts.session) ?? null) : opts.cost !== undefined ? Number(opts.cost) : auto();
  return withLock(P, () => {
    const est = loadEstimates(P);
    if (est.some((e) => e.id === id)) throw new Error(`${id} już zapisany`);
    const lines = loadRoadmap(P);
    const { open, archived } = loadItems(P);
    // Kolejne wpisy jednego wyniku: za najwyższym numerem zapisanym i zarezerwowanym przez estimate-input.
    const reserved = existsSync(P.work) ? readdirSync(P.work).filter((x) => /^estimate-E-\d+$/.test(x)).map((x) => x.slice(9)) : [];
    let next = Math.max(maxNum([...est.map((e) => e.id), ...reserved], 'E'), Number(id.slice(2)));
    const out = entries.map((e, i) => {
      const forIds = list(e.for);
      for (const f of forIds) if (!lines.some((l) => l.id === f) && ![...open, ...archived].some((x) => x.id === f)) throw new Error(`for ${f}: brak sprintu ani pozycji`);
      const files = parseRange(e.files, `entries[${i}].files`);
      const areas = asList(e.areas).slice(0, 5);
      return { id: i === 0 ? id : `E-${++next}`, at: today(), for: forIds, level: 0, areas, files, tokensM: tokensFor(files, runs), flags: { newArea: !!e.flags?.newArea, contract: !!e.flags?.contract, migration: !!e.flags?.migration, screens: Number(e.flags?.screens) || 0 }, cost: cost == null ? null : Math.round((cost / entries.length) * 100) / 100, stale: false, actual: null, ...(e.split ? { split: String(e.split) } : {}) };
    });
    // K5 D-18: sprint files checked before the first write (estimates, sprint files, backlog).
    const specs = new Map();
    for (const e of out) {
      for (const f of e.for) {
        const x = open.find((i) => i.id === f);
        if (x) x.est = e.id;
        const s = specs.get(f)?.s ?? readSpec(P, f);
        if (s) { s.h.est = e.id; specs.set(f, { s }); }
      }
    }
    const checks = [...specs].map(([f, { s }]) => specCheck(P, f, s.h, s.body));
    writeJsonl(P.estimates, [...est, ...out]);
    for (const chk of checks) putSpec(chk);
    writeJsonl(P.backlog, open);
    logChange(P, `${out.map((e) => `${e.id} (${e.for.join(', ')})`).join('; ')} estimated`, { kind: 'estimate' });
    return { ok: true, estimates: out.map((e) => ({ id: e.id, for: e.for, files: e.files, tokensM: e.tokensM, flags: e.flags, ...(e.split ? { split: e.split } : {}) })), cost, facts };
  });
}
const sessionsCostOf = (sid) => sessionsCost(list(sid))?.total ?? null;

function cmdAnalog(c, opts) {
  const { P, top, cfg, pc } = c;
  const runs = completedRuns(top, cfg, pc);
  const area = opts.area && opts.area !== true ? opts.area : null;
  const hits = analogRuns(runs, area);
  const index = loadIndex(P);
  const byRun = new Map(hits.map((r) => [r.run, r]));
  const rows = [];
  for (const x of index) {
    if (x.merged === 'dropped') continue;
    const r = x.run ? byRun.get(x.run) : null;
    if (area && !r) continue;
    const files = r?.files ?? x.files;
    const tok = r?.costM ?? x.tokensM;
    if (r) byRun.delete(x.run);
    rows.push({ id: x.id, goal: x.goal, files, tok, mode: r?.mode ?? '-' });
  }
  for (const r of byRun.values()) rows.push({ id: r.spec ?? r.sprint ?? r.run, goal: r.goal ?? '-', files: r.files, tok: r.costM, mode: r.mode });
  const ok = rows.filter((r) => r.files && r.tok);
  const sum = analogSummary(ok.map((r) => ({ costM: r.tok, files: r.files, mode: r.mode, mPerFile: r.tok / r.files })));
  return [`analog (a comparison, not an estimate)${area ? ` for ${globsOf(area).join(', ')}` : ''}: n=${ok.length}`,
    ...rows.slice(-15).map((r) => `${r.id} · ${cut(r.goal, 60)} · ${r.mode} · files ${r.files ?? '-'} · ${r.tok ?? '-'} M${r.files && r.tok ? ` · ${(r.tok / r.files).toFixed(2)} M/file` : ''}`),
    sum ? `median ${sum.mPerFile} M/file; sprint median ${sum.medianM} M (p25-p75 ${sum.rangeM.join('-')}), files p25-p75 ${sum.files.join('-')}` : 'no finished sprint with files and cost'].join('\n');
}

// ---------- eksperci (§3.8, §4.11) ----------

function cmdExpert(c, sub, pos, opts) {
  const { P } = c;
  if (sub === 'list') {
    const all = expertFiles(P);
    return Object.keys(all).sort().map((d) => { const e = parseExpert(all[d].file, d); return `${d} · ${e.h.title ?? '-'} · ${all[d].source} · explorers ${e.h.explorers.allowed ? `yes (${e.h.explorers.areas.join(', ')})` : 'no'}${e.errors.length ? ` · INVALID: ${e.errors.join('; ')}` : ''}`; }).join('\n') || 'none';
  }
  const d = need(pos[0], 'dziedzina');
  if (sub === 'new') {
    requireWrite(c);
    if (!/^[a-z0-9-]+$/.test(d)) throw new Error('dziedzina: [a-z0-9-]+');
    const f = join(P.experts, `${d}.md`);
    if (existsSync(f)) throw new Error(`${fwd(f)} już istnieje`);
    put(f, EXPERT_TEMPLATE(d));
    logChange(P, `expert ${d} added (template)`, { kind: 'expert' });
    return { ok: true, file: `${c.pc.dir}/experts/${d}.md`, hint: 'fill it in the conversation (≤ 40 lines), the decision-maker approves with one line, then product commit' };
  }
  const e = getExpert(P, d);
  if (e.errors.length) throw new Error(`ekspert ${d} (${e.file}): ${e.errors.join('; ')}`);
  const show = `# expert ${d} (${e.source}): ${e.file}\n${e.text.trimEnd()}`;
  if (sub === 'show') return show;
  if (sub === 'start') {
    // Niepodstawione `${CLAUDE_SESSION_ID}` ze skilla to brak identyfikatora (wtedy zmienna środowiska albo najnowszy transkrypt).
    const given = nul(opts.session);
    const sid = (given && !/^\$\{/.test(String(given)) ? given : null) ?? process.env.CLAUDE_CODE_SESSION_ID ?? newestSession(c.top);
    if (existsSync(P.dir)) {
      withLock(P, () => {
        const st = loadState(P);
        const ss = { ...(st.sessions ?? {}) };
        if (sid && !asList(ss[d]).includes(sid)) ss[d] = [...asList(ss[d]), sid];
        saveState(P, { ...st, sessions: ss });
      });
    }
    return `${show}\n\n${existsSync(P.dir) ? briefFor(P, d) : 'brief: no product dir (product init)'}`;
  }
  throw new Error('expert list | show <d> | new <d> | start <d> [--session id]');
}

// ---------- CLI ----------

// Human view (§3.11): `product view [--open] [--translate] [--lang l] [--out file]` (`--out`: elsewhere, e.g. a render check).
// `--translate --quiet`: the background translator `product commit` starts (one at a time, lock file), no output.
function cmdView(c, opts) {
  const lang = nul(opts.lang);
  if (opts.translate && opts.quiet) { translateInBackground(c, { lang }); return null; }
  const tr = opts.translate ? translateView(c, { lang, exclusive: true }) : null;
  const r = writeView(c, { out: nul(opts.out), lang });
  const warnings = [...r.warnings, ...(tr?.errors ?? []).map((e) => `translation: ${e}`),
    ...(tr?.busy ? [`translation: a background translation is running (pid ${tr.busy.pid}); the page refreshes when it ends`] : [])];
  const opened = opts.open ? openFile(resolve(r.file)) : undefined;
  return { ...r, warnings, ...(tr && !tr.busy ? { translated: tr.translated, sent: tr.sent, costHint: tr.costHint } : {}), ...(opts.open ? { opened } : {}) };
}

// The view is regenerated (0 tokens) after these CLI commands, outside their locks. After `commit`, missing titles are
// translated by a detached background process that regenerates the page when done: the commit never waits for the model.
// Errors are warnings only, never the caller's failure. In-process calls (`productRun`: intake from `finish` and
// `uat record`) skip this refresh; with a published page each intake's `productCommit` writes the page into its product
// commit, under the merge lease (the page is committed with the product); `finish` and `uat record` then refresh it once
// after the lease, without a commit (`productViewRefresh`); with `publish: null` only that after-lease refresh of the
// `.dwmt/` page happens.
const VIEW_AFTER = ['commit', 'sync', 'brief', 'intake'];
function run(top, argv) {
  const out = dispatch(top, argv);
  if (!VIEW_AFTER.includes(argv[0]) || (argv[0] === 'brief' && argv.includes('--for')) || (out && typeof out === 'object' && out.skipped)) return out;
  const v = productViewRefresh(top, { translate: argv[0] === 'commit' });
  if (typeof out === 'string') return v.viewWarning ? `${out}\n${v.viewWarning}` : out;
  return { ...out, ...v };
}
export function productViewRefresh(top, { translate = false } = {}) {
  try { return refreshView(ctxOf(top), { translate }); } catch (e) { return { viewWarning: `view: ${String(e.message).split(/\r?\n/)[0]}` }; }
}

function dispatch(top, argv) {
  const [cmd, ...rest] = argv;
  const { pos, opts } = parseOpts(rest);
  const c = ctxOf(top);
  const { P } = c;
  switch (cmd) {
    case 'init': return cmdInit(c, opts);
    case 'brief': {
      requireDir(c);
      if (opts.for) return briefFor(P, String(opts.for));
      const synced = c.pc.enabled ? withLock(P, () => syncCore(P, top, c.cfg, c.pc)) : [];
      return brief(P, top, c.cfg, c.pc, synced);
    }
    case 'sync': requireWrite(c); return { ok: true, changes: withLock(P, () => syncCore(P, top, c.cfg, c.pc)) };
    case 'item': {
      requireDir(c);
      const [sub, ...r] = pos;
      if (sub === 'add') {
        requireWrite(c);
        const rows = opts.file ? readJsonl(opts.file) : [{ type: opts.type, title: nul(opts.title), note: nul(opts.note), sev: nul(opts.sev), anchors: list(opts.anchors), triage: nul(opts.triage), alias: nul(opts.alias), src: nul(opts.src), ...(opts.state ? { state: opts.state } : {}) }];
        // K5 D-18: the detail (40 lines) is checked before the item is added.
        const detail = opts.detail && rows.length === 1 ? detailText(String(rows[0].title ?? 'item'), opts.detail) : null;
        const res = withLock(P, () => {
          const out = addItems(P, rows, { partial: !!opts.partial });
          if (detail != null && out.added.length === 1) {
            itemDetail(P, out.added[0].id, null, detail);
            const { open } = loadItems(P);
            open.find((x) => x.id === out.added[0].id).detail = true;
            writeJsonl(P.backlog, open);
          }
          return out;
        });
        return { ok: true, added: res.added.map(itemLine), ...(res.skipped.length ? { skipped: res.skipped } : {}), ...(res.rejected.length ? { rejected: res.rejected } : {}) };
      }
      if (sub === 'set') { requireWrite(c); return itemSet(c, need(r[0], 'B-n'), r.slice(1), opts); }
      if (sub === 'show') return showRef(c, need(r[0], 'B-n|alias|PD-n'), opts);
      return showRef(c, need(sub, 'B-n|alias|PD-n'), opts);
    }
    case 'list': requireDir(c); return cmdList(c, opts);
    case 'inbox': {
      requireDir(c);
      if (pos[0] === 'drop') { requireWrite(c); const drop = pos.slice(1).flatMap((x) => list(x)); return withLock(P, () => { const all = readJsonl(P.inbox); writeJsonl(P.inbox, all.filter((x) => !drop.includes(x.id))); return { ok: true, dropped: all.filter((x) => drop.includes(x.id)).map((x) => x.id) }; }); }
      const news = loadItems(P).open.filter((x) => x.state === 'new');
      const cands = readJsonl(P.inbox);
      return [`new items: ${news.length}`, ...news.slice(0, 20).map((x) => `- ${itemLine(x)} (${x.src ?? '-'})`), `register candidates and events: ${cands.length}`, ...cands.map((x) => `- ${x.id} ${x.kind} (${x.src}): ${cut(x.text, 200)}`)].join('\n');
    }
    case 'intake': {
      // P-11: bez warstwy albo wyłączona → nic; wołający (finish, uat record) tylko ostrzega przy błędzie.
      if (!c.pc.present || !existsSync(P.dir)) return { ok: true, skipped: 'no product layer' };
      if (!c.pc.enabled) return { ok: true, skipped: 'product.enabled false' };
      // Recenzja S3 (11): zapis i commit pod jedną blokadą produktu (inny zapis PO nie wchodzi między nie), w kolejności
      // blokad jak `finish` i `product commit`: najpierw scalanie (merge lease), potem produkt.
      const { key: mk, repo: mrepo } = mergeKey(top, c.cfg.git.target);
      const locked = (fn) => withLease(mk, { who: 'product intake', cmd: `intake ${c.pc.dir}`, repo: mrepo }, () => withLock(P, fn));
      // B-7 (D-1, D-7): `--sync` (z `finish` po squashu lub leave) liczy roadmapę po pozycjach, pod tą samą blokadą i w tym
      // samym commicie; błąd sync tylko ostrzega. `--no-commit` (merge-wait) pomija sam commit; flagi są niezależne.
      if (!opts.uat) return locked(() => {
        const r = intakeRun(P, top, need(pos[0], 'run'));
        if (opts.sync) {
          try { r.sync = syncCore(P, top, c.cfg, c.pc); } catch (e) { r.warnings = [...asList(r.warnings), `sync: ${e.message.split(/\r?\n/)[0]}`]; }
        }
        return opts['no-commit'] ? r : intakeCommit(c, r, `intake ${pos[0]}`);
      });
      return locked(() => {
        const res = intakeUat(P, top, String(opts.uat));
        try { const fix = uatFixSprint(c, String(opts.uat)); if (fix) res.fixSprint = fix; } catch (e) { res.warnings = [...asList(res.warnings), `fix sprint: ${e.message}`]; }
        // D-14: `--sync` (z `uat record`) zamyka sprint z zapisanym UAT w roadmapie pod tą samą blokadą i w tym samym commicie.
        if (opts.sync) {
          try { res.sync = syncCore(P, top, c.cfg, c.pc); } catch (e) { res.warnings = [...asList(res.warnings), `sync: ${e.message.split(/\r?\n/)[0]}`]; }
        }
        return intakeCommit(c, res, `intake UAT ${opts.uat}`);
      });
    }
    case 'triage-auto': {
      requireWrite(c);
      const r = withLock(P, () => triageAuto(P));
      return [`triage-auto: ${r.decided.length} decided, ${r.ask.length} for the decision-maker, ${r.candidates.length} register candidates`, ...r.moved.map((x) => `- proposal ${x}`),
        ...r.decided.map((x) => `- ${x}`), ...r.ask.map((x) => `- ask: ${x}`), ...r.candidates.map((x) => `- T5/T6 (PO decides: decision add --from <C-n> or inbox drop): ${x}`),
        ...(r.decided.length ? ['undo: product triage <B-n> <now|sprint:<id>|touch|later|never>'] : [])].join('\n');
    }
    case 'triage': { requireWrite(c); return itemSet(c, need(pos[0], 'B-n'), ['triage', need(pos[1], 'decyzja')], {}); }
    case 'decision': requireDir(c); return cmdDecision(c, pos[0], pos.slice(1), opts);
    case 'spec': return cmdSpec(c, pos[0], pos.slice(1), opts);
    case 'roadmap': requireDir(c); return cmdRoadmap(c, pos[0], pos.slice(1), opts);
    case 'workplace': requireDir(c); return cmdWorkplace(c, pos[0], pos.slice(1), opts);
    case 'sprint': requireDir(c); return cmdSprint(c, need(pos[0], 'id sprintu'), opts);
    case 'propose': {
      requireWrite(c);
      const by = need(opts.by, '--by <dziedzina>');
      const rows = readJsonl(need(opts.file, '--file <jsonl>')).map((x) => ({ ...x, by, at: today(), src: `expert:${by}:${today()}` }));
      const errs = rows.flatMap((x) => itemErrors(normItem({ ...x, id: x.title, state: 'new', triage: null, anchors: list(x.anchors) })));
      if (errs.length) throw new Error(errs.join('; '));
      withLock(P, () => appendJsonl(P.proposals, rows.map((x) => ({ ...x, anchors: list(x.anchors) }))));
      return { ok: true, proposed: rows.length, hint: 'the PO sees them in its brief and triages them' };
    }
    case 'ready-check': requireDir(c); return readyCheck(c, need(pos[0], 'id sprintu'), !!opts.direct);
    case 'ready': {
      requireWrite(c);
      const id = need(pos[0], 'id sprintu');
      return withLock(P, () => {
        const rc = readyCheck(c, id, !!opts.direct);
        if (!rc.ok) return rc;
        const s = readSpec(P, id);
        s.h.ready = { at: today(), by: 'decydent', ...(opts.direct ? { direct: true } : {}) };
        // K5 D-18: sprint file and roadmap checked before the first write.
        const chk = specCheck(P, id, s.h, s.body);
        const lines = loadRoadmap(P);
        const l = lines.find((x) => x.id === id);
        l.state = 'ready';
        l.detail = `sprints/${id}.md`;
        roadmapCheck(P, lines);
        putSpec(chk);
        saveRoadmap(P, lines, `${id} ready`);
        return { ok: true, id, state: 'ready', warnings: rc.warnings };
      });
    }
    case 'touch': requireWrite(c); return cmdTouch(c, need(pos[0], 'id sprintu'), opts);
    case 'estimate-input': {
      requireWrite(c);
      const ids = pos.flatMap((x) => list(x));
      if (!ids.length) throw new Error('estimate-input <id…>');
      const describe = describeFor(c);
      return withLock(P, () => estimateInput(P, top, c.cfg, c.pc, ids, describe));
    }
    case 'estimate-record': requireWrite(c); return estimateRecord(c, need(pos[0], 'E-n'), opts);
    case 'analog': requireDir(c); return cmdAnalog(c, opts);
    case 'commit': requireWrite(c); return { ok: true, ...productCommit(c, nul(opts.message)) };
    case 'expert': return cmdExpert(c, pos[0], pos.slice(1), opts);
    case 'price': {
      if (pos[0] === 'explore') return explorerPrice(top, Number(need(opts.areas, '--areas <n>')), { cfg: c.cfg });
      if (pos[0] === 'design' || opts.files) return cmdPrice(top, opts);
      throw new Error('price explore --areas <n> | price --files <min,max> [--mode m]');
    }
    case 'start-check': {
      requireDir(c);
      const { open, archived } = loadItems(P);
      const items = list(opts.item).map((r) => { const x = [...open, ...archived].find((i) => i.id === r || String(i.alias ?? '').toLowerCase() === r.toLowerCase()); if (!x) throw new Error(`${r}: brak pozycji`); return x; });
      const spec = opts.spec ? readSpec(P, String(opts.spec)) : null;
      if (opts.spec && !spec) throw new Error(`${opts.spec}: brak pliku sprintu`);
      if (opts.text && !existsSync(opts.text)) throw new Error(`brak pliku ${opts.text}`);
      if (!items.length && !spec && !opts.text) throw new Error('start-check (--item <B-n…> | --spec <id> | --text <plik>) --globs <globy>');
      return startCheck(P, top, c.cfg, c.pc, { items, spec, globs: need(opts.globs, '--globs') });
    }
    case 'import': {
      const sub = pos[0];
      if (sub === 'run') { requireImport(c); return importRun({ ...c, ops: { addItems, addDecision } }, opts); }
      if (sub === 'report') return importReport(c, opts);
      if (sub === 'retire') { requireImport(c); return importRetire(c, opts); }
      throw new Error('import run [--source n] [--dry-run] [--force] | report [--source n] | retire --source n');
    }
    case 'overhead': requireDir(c); if (!/^[\w.-]+$/.test(need(pos[0], 'run'))) throw new Error(`zły identyfikator przebiegu: ${pos[0]}`); return overhead(P, top, pos[0]);
    case 'for-you': {
      requireDir(c);
      if (!opts.draft) return forYouList(c, { missing: !!opts.missing });
      requireWrite(c);
      return forYouDraft(c, { ids: opts.ids && opts.ids !== true ? list(opts.ids) : null, lang: nul(opts.lang), force: !!opts.force });
    }
    // The page re-roots to the home tree (mainCtx, A-5): from a tree without the product dir it still works there.
    case 'view': requireDir(mainCtx(c)); return cmdView(c, opts);
    case 'design-input': case 'design-record': throw new Error(`${cmd}: etap 4 (projektant makiet), jeszcze nie zbudowane`);
    default:
      throw new Error('product: init | brief [--for d] | sync | item add|set|show|<id> | list | inbox [drop] | intake <run> [--sync] [--no-commit]|--uat <sprint> [--sync] | triage-auto | triage <B-n> <t> | decision add|supersede|find|list | spec new|set|bugfix|fix | roadmap [next|add|move|set|drop|todo-from-notes] | workplace add|assign|unassign|list|show|remove | sprint <id> [--json] | for-you [--missing] [--draft [--ids a,b] [--lang l] [--force]] | view [--open] [--translate] [--lang l] [--out file] | propose | ready-check|ready <id> [--direct] | touch <id> | estimate-input|estimate-record | analog | commit | expert list|show|new|start | price explore | start-check | import run|report|retire | overhead <run>');
  }
}

// Wywołanie w procesie (dwmt: `init` z plikiem sprintu albo `--item`, `intake` przy `finish` i `uat record`): wynik komendy bez druku.
// It skips the CLI view refresh (`run`); with a published page each intake's `productCommit` still writes the page into its
// product commit, under the merge lease; `finish` and `uat record` then refresh it once after the lease, without a commit.
export const productRun = (top, argv) => dispatch(top, argv);

// Wynik: obiekt → JSON (printJson), tekst → tak jak jest. Kontekst sesji PO ponad próg: ostrzeżenie (§4.1).
export function productMain(top, argv) {
  const out = run(top, argv);
  if (out == null) return undefined;
  let warn = null;
  if (argv[0] !== 'brief') {
    try { const pc = productConfig(top, loadConfig(top)); const k = contextK(); if (k != null && k > pc.contextWarnK) warn = `context ${k}k > ${pc.contextWarnK}k: finish this mode, product commit, propose /clear and /dwmt:po`; } catch { /* bez transkryptu */ }
  }
  if (typeof out === 'string') return console.log(warn ? `${out}\n${warn}` : out);
  return printJson(warn ? { ...out, context: warn } : out);
}
