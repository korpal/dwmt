// dwmt D4: operacje warstwy produktowej wołane z kilku komend: synchronizacja ze statusów i kopii przebiegów (`sync`,
// zamknięcie sprintu do archiwum), wejście po sprincie i UAT (`intake`), triaż regułami (`triage-auto`), brief, eksperci,
// szacunek poziomu 0 i kalibracja, analogia, sprawdzenie startu, narzut szacowania, rozmiar kontekstu sesji.
// Spec warstwy produktowej §3.8, §3.9, §4.5–§4.7, §4.11, §4.12, §5, §9.
import { existsSync, readdirSync, mkdirSync, renameSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ROOT, fwd, read, asList } from './util.mjs';
import { splitHeader, parseYaml, tryHeader } from './headers.mjs';
import { contextHome } from './run.mjs';
import { git } from './git.mjs';
import { assess, queueTickets } from '../watch.mjs';
import { ensureLoop, briefLine, hasOrder, haltsOf } from './supervisor-loop.mjs';
import { writeSizes } from '../plan.mjs';
import { findingSources } from './direct.mjs';
import { findingSection } from '../batch.mjs';
import { activeWorkplaces, workplaceReady, branchPushed } from './workplace.mjs';
import {
  completedRuns, mPerFile, priceRange, analogRuns, analogSummary, workingSet, trackedFiles, globMatcher, globsOf, pct, median, r1, r2, MODES,
} from './price.mjs';
import {
  BUDGET, SEVS, ITEM_STATES, put, readJsonl, writeJsonl, appendJsonl, normItem, itemErrors, maxNum, loadItems, itemLine,
  loadDecisions, loadRoadmap, renderRoadmap, markCurrent, nextSprint, loadIndex, appendIndex, writeIndex, readSpec, renderSpec,
  loadEstimates, loadState, updateState, logChange, loadChanges, today, specSections, specAgreed, readSpecAt,
} from './product-store.mjs';

const headerOf = (file) => { try { const s = splitHeader(read(file)); return s ? parseYaml(s.yaml) : null; } catch { return null; } };
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// ---------- kopie przebiegów (główne drzewo) ----------

export function runCopies(top) {
  const base = join(contextHome(top), '.dwmt', 'runs');
  if (!existsSync(base)) return [];
  return readdirSync(base).flatMap((id) => {
    try { return [{ id, dir: join(base, id), run: JSON.parse(read(join(base, id, 'run.json'))) }]; } catch { return []; }
  }).sort((a, b) => String(a.run.created).localeCompare(String(b.run.created)));
}
const finished = (r) => ['squashed', 'left'].includes(r.run.finish?.status);
const uatEntries = (r) => (existsSync(join(r.dir, 'uat.md')) ? asList(headerOf(join(r.dir, 'uat.md'))?.entries).filter((e) => e?.kind === 'uat') : []);
const uatRecorded = (r) => uatEntries(r).length > 0;
// UAT state for the sprint header (`actual.uat`): the result of the last recorded UAT (positive|defects), else the run's
// `finish.uat` (pending|n/a).
const finalUat = (r) => { const e = uatEntries(r).at(-1); return e ? String(e.result ?? 'recorded') : r.run.finish?.uat ?? null; };
const mergedOn = (r) => String(r.run.finish?.at ?? '').slice(0, 10) || null;
const statusOf = (top, id) => { try { return JSON.parse(read(join(contextHome(top), '.dwmt', 'supervisor', 'status', `${id}.json`))); } catch { return null; } };

// ---------- sync (§3.9, §5.4, §6.1): stany roadmapy i pozycji, `actual`, archiwum ----------

export function syncCore(P, top, cfg, pc) {
  const changes = [];
  const lines = loadRoadmap(P);
  const index = loadIndex(P);
  let { open, archived } = loadItems(P);
  const estimates = loadEstimates(P);
  const copies = runCopies(top);
  let stats = null;
  const statOf = (runId) => (stats ??= completedRuns(top, cfg, pc)).find((s) => s.run === runId) ?? null;
  const setItem = (id, patch) => { const x = open.find((i) => i.id === id); if (x) Object.assign(x, patch); };
  const closeEstimates = (ids, runId) => {
    const st = statOf(runId);
    for (const e of estimates) if (!e.actual && asList(e.for).some((f) => ids.includes(f)) && st) { e.actual = { files: st.files, tokensM: st.costM, run: runId }; changes.push(`${e.id} actual`); }
  };
  const closed = [];
  for (const l of lines) {
    if (['topic'].includes(l.state)) continue;
    const all = copies.filter((r) => r.run.spec === l.id || (!r.run.spec && r.run.sprint === l.id));
    // Przebieg zatrzymany (`run.stopped`, np. „stop” na pytaniu o cenę) nie pracuje: linia wraca do stanu sprzed startu.
    const runs = all.filter((r) => !r.run.stopped);
    const r = runs.at(-1);
    const st = statusOf(top, l.id)?.state;
    let state = l.state;
    if (r && finished(r)) state = 'done';
    else if (r || ['planning', 'running', 'waiting-user', 'planned', 'handoff', 'merge-wait'].includes(st)) { if (['ready', 'ordered', 'todo', 'notes'].includes(state)) state = 'running'; }
    // A stopped run without readiness goes back to `todo`: it was taken, so it is clear what it is about (§3.9).
    else if (state === 'running' && all.at(-1)?.run.stopped) state = readSpec(P, l.id)?.h.ready ? 'ready' : existsSync(join(P.sprints, `${l.id}.md`)) ? 'todo' : 'topic';
    if (st === 'done' && !r) state = 'done';
    if (state !== l.state) { changes.push(`${l.id} ${l.state} → ${state}`); l.state = state; }
    if (state !== 'done' || !r) continue;
    // Pozycje sprintu: `delivered` → done; `gap` zostaje `planned` do wyniku UAT (§6.1).
    const spec = readSpec(P, l.id);
    const gc = headerOf(join(r.dir, 'goal-check.md'));
    const gapIds = new Set(asList(gc?.items).filter((x) => x?.status === 'gap').flatMap((x) => String(`${x.id ?? ''} ${x.element ?? ''}`).match(/\bB-\d+\b/g) ?? []));
    const ids = spec ? [...spec.h.items, ...spec.h.touch] : [];
    for (const id of ids) { const x = open.find((i) => i.id === id); if (x && x.state === 'planned' && !gapIds.has(id)) { x.state = 'done'; changes.push(`${id} done`); } }
    const sst = statOf(r.id);
    // `actual.merged` (merge date): the view's history of sprints still waiting for their UAT.
    if (spec && !spec.h.actual && sst) { spec.h.actual = { files: sst.files, tokens: sst.costM, lines: sst.lines, uat: r.run.finish?.uat ?? null, merged: mergedOn(r) }; put(spec.file, renderSpec(spec.h, spec.body)); }
    else if (spec?.h.actual) {
      // Fill what an older `actual` lacks: the merge date and the changed lines of the squash commit.
      const add = { ...(!spec.h.actual.merged && mergedOn(r) ? { merged: mergedOn(r) } : {}), ...(!Number.isInteger(spec.h.actual.lines) && Number.isInteger(sst?.lines) ? { lines: sst.lines } : {}) };
      if (Object.keys(add).length) { spec.h.actual = { ...spec.h.actual, ...add }; put(spec.file, renderSpec(spec.h, spec.body)); }
    }
    closeEstimates([l.id, ...ids], r.id);
    // Zamknięcie: po zapisie UAT albo od razu przy `uat: n/a` (§3.9).
    if (r.run.finish?.uat === 'n/a' || uatRecorded(r)) {
      for (const id of ids) { const x = open.find((i) => i.id === id); if (x && x.state === 'planned') { Object.assign(x, { state: 'new', sprint: null, triage: null }); changes.push(`${id} back to triage (gap)`); } }
      closed.push({ l, r, sst, spec });
    }
  }
  for (const { l, r, sst, spec } of closed) {
    mkdirSync(P.archive, { recursive: true });
    if (spec) {
      // The archived header carries the final UAT state (`actual` was written at the merge, usually with `pending`).
      const uat = finalUat(r);
      if (!spec.h.actual || spec.h.actual.uat !== uat) {
        spec.h.actual = { ...(spec.h.actual ?? { files: sst?.files ?? null, tokens: sst?.costM ?? null, lines: sst?.lines ?? null, merged: mergedOn(r) }), uat };
        put(spec.file, renderSpec(spec.h, spec.body));
      }
      renameSync(spec.file, join(P.archive, `${l.id}.md`));
    }
    appendIndex(P, [{ id: l.id, goal: l.goal, merged: String(r.run.finish?.at ?? '').slice(0, 10) || '-', run: r.id, files: sst?.files ?? null, tokensM: sst?.costM ?? null, lines: sst?.lines ?? null }]);
    lines.splice(lines.indexOf(l), 1);
    changes.push(`${l.id} closed → archive`);
  }
  // Przebiegi `init --item` (§4.12 pkt 2): pozycje `done` po scaleniu.
  for (const r of copies) {
    if (r.run.finish?.status !== 'squashed') continue;
    const ids = asList(r.run.items).filter((id) => open.some((i) => i.id === id && !['done', 'dropped'].includes(i.state)));
    if (!ids.length) continue;
    for (const id of ids) { setItem(id, { state: 'done' }); changes.push(`${id} done (${r.id})`); }
    closeEstimates(ids, r.id);
  }
  changes.push(...fillLines(P, statOf));
  changes.push(...repairArchivedUat(P, index, copies));
  const moved = open.filter((x) => ['done', 'dropped'].includes(x.state));
  if (moved.length) { archived = [...archived, ...moved]; open = open.filter((x) => !moved.includes(x)); writeJsonl(P.backlogArchive, archived); changes.push(`${moved.length} items → archive`); }
  if (changes.length) {
    writeJsonl(P.backlog, open);
    writeJsonl(P.estimates, estimates);
    const idx = loadIndex(P);
    put(P.roadmap, renderRoadmap(markCurrent(lines, idx)));
    logChange(P, `sync: ${changes.join('; ')}`, { kind: 'sync' });
  } else if (existsSync(P.roadmap)) {
    // Znacznik `*` zawsze aktualny.
    const marked = markCurrent(lines, index);
    if (marked.some((l, i) => l.current !== lines[i].current)) put(P.roadmap, renderRoadmap(marked));
  }
  return changes;
}

// Archived sprints without changed lines: filled from the price history of the archive row's run id only (another run
// of the same spec would attach a different squash commit). Reloads the index from disk so rows appended earlier in
// this sync survive the rewrite. Runs on every sync: a squash commit may enter the repo later.
export function fillLines(P, statOf) {
  const rows = loadIndex(P);
  const todo = rows.filter((x) => x.run && x.lines == null && x.merged !== 'dropped');
  if (!todo.length) return [];
  const out = [];
  for (const x of todo) {
    const n = statOf(x.run)?.lines;
    if (!Number.isInteger(n)) continue;
    x.lines = n;
    let s = null;
    try { s = readSpecAt(join(P.archive, `${x.id}.md`)); } catch { /* no header */ }
    if (s?.h.actual && typeof s.h.actual === 'object' && !Number.isInteger(s.h.actual.lines)) { s.h.actual = { ...s.h.actual, lines: n }; put(s.file, renderSpec(s.h, s.body)); }
    out.push(`${x.id} lines ${n}`);
  }
  if (out.length) writeIndex(P, rows);
  return out;
}

// One-time repair (state `archiveUatRepair`): archived sprint headers that still say `actual.uat: pending` while their
// run's UAT is recorded (sync archived them after the UAT without updating the header). Without the run copy the
// header stays as it is.
function repairArchivedUat(P, index, copies) {
  if (loadState(P).archiveUatRepair) return [];
  const out = [];
  for (const x of index.filter((y) => y.merged !== 'dropped')) {
    let s = null;
    try { s = readSpecAt(join(P.archive, `${x.id}.md`)); } catch { /* no header */ }
    if (s?.h.actual?.uat !== 'pending') continue;
    const own = (c) => !c.run.stopped && (c.run.spec === x.id || (!c.run.spec && c.run.sprint === x.id));
    const r = copies.find((c) => c.id === x.run && own(c)) ?? copies.filter(own).at(-1);
    const uat = r ? finalUat(r) : null;
    if (!uat || uat === 'pending') continue;
    s.h.actual = { ...s.h.actual, uat };
    put(s.file, renderSpec(s.h, s.body));
    out.push(`${x.id} actual.uat ${uat} (archive repair)`);
  }
  updateState(P, () => ({ archiveUatRepair: today() }));
  return out;
}

// ---------- intake (§4.5, §4.6): wejście z kopii przebiegu i z UAT; błąd źródła = ostrzeżenie ----------

const pathsIn = (s) => [...new Set((String(s ?? '').match(/[\w@.-]+(?:\/[\w@.-]+)+(?:#[\w$.]+)?|[\w@-]+\.[a-z]{1,5}(?:#[\w$.]+)?/gi) ?? []).map((p) => p.replace(/:\d+(-\d+)?$/, '')))].slice(0, 5);
// Index of the `(` that opens the parenthesis closing the text (after a space), or -1 (`a (b (c)) ` → index of `(b`).
function trailingParen(s) {
  if (!s.endsWith(')')) return -1;
  let depth = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] === ')') depth++;
    else if (s[i] === '(' && --depth === 0) return i > 0 && s[i - 1] === ' ' ? i : -1;
  }
  return -1;
}
function bulletsOf(text, title) {
  const s = new RegExp(`^##\\s+${title}\\s*$`, 'm').exec(text);
  if (!s) return [];
  const rest = text.slice(s.index + s[0].length);
  const end = rest.search(/^##\s/m);
  return (end < 0 ? rest : rest.slice(0, end)).split(/\r?\n/).filter((l) => /^- /.test(l)).map((l) => l.slice(2).trim());
}

export function intakeRun(P, top, runId) {
  const copy = runCopies(top).find((r) => r.id === runId);
  if (!copy) throw new Error(`brak kopii przebiegu ${runId} w ${fwd(join(contextHome(top), '.dwmt', 'runs'))}`);
  const { open, archived } = loadItems(P);
  const srcs = new Set([...open, ...archived].map((x) => x.src));
  const inbox = readJsonl(P.inbox);
  const isrcs = new Set(inbox.map((c) => c.src));
  const items = [];
  const cands = [];
  const warnings = [];
  const add = (x) => { if (!srcs.has(x.src)) { srcs.add(x.src); items.push(x); } };
  const cand = (c) => { if (!isrcs.has(c.src)) { isrcs.add(c.src); cands.push(c); } };
  const tasksDir = join(copy.dir, 'tasks');
  // B (noc 2026-10-05, sprint 16): raport zadania powstaje przed rundą zbiorczą, więc jego „Deferred findings” zawiera też uwagi,
  // które partia potem rozwiązała (trzy pozycje w projekcie testowym); rozwiązane według nagłówka raportu końcowego pomijamy.
  // Batch T-2/F-2: findings the user fixed after a deferred-major stop (`finish --fixed-deferred`: run.deferredFixed,
  // final report header `fixedDeferred`) are not deferred any more, so the task reports' bullets for them are skipped too.
  const resolved = new Set(asList(copy.run.deferredFixed?.ids).map(String));
  // K2 (D-4, D-13, C-1): the final report's `## Deferred findings` lists task and fix-batch findings with their effective
  // severity; with that section the task reports' bullets are not read (old copies without it: task reports as before).
  // `from` = the run's sprint id. The `src` stays as in earlier intakes, so a second intake adds nothing.
  const from = copy.run.sprint ?? copy.run.spec ?? null;
  let finalDeferred = null;
  try {
    const fp = join(copy.dir, 'final-report.md');
    const fr = tryHeader(fp);
    for (const x of asList(fr?.fixedDeferred)) resolved.add(String(x));
    for (const x of asList(fr?.batch?.items)) { const m = /^(T-\d+\/F-\d+)\s+\S+\s+(resolved|notReproduced)\b/.exec(String(x)); if (m) resolved.add(m[1]); }
    if (existsSync(fp)) {
      const body = splitHeader(read(fp))?.body ?? read(fp);
      if (/^##\s+Deferred findings\s*$/m.test(body)) finalDeferred = bulletsOf(body, 'Deferred findings');
    }
  } catch { /* bez raportu końcowego: jak dotąd */ }
  // C-1 bullet `<title>[ — <why>][ (<where>)]`: the why (with the where) goes to the note; without a why, a trailing
  // parenthesis holding a path is the where and goes to the note too (batch T-3/F-1). An empty title (no section in
  // any review) falls back to the finding id, so the finding still becomes an item.
  const remark = (b, src, id) => {
    const sev = /\[(blocker|major|minor)\]/i.exec(b)?.[1]?.toLowerCase() ?? null;
    const floor = /\[floor:\s*([a-z-]+)\]/i.exec(b)?.[1]?.toLowerCase() ?? null;
    const rest = b.replace(/^(?:(?:T-\d+\/|batch\/)?F-\d+)\s*/, '').replace(/\[(?:blocker|major|minor)\]\s*/gi, '').replace(/\[floor:\s*[a-z-]+\]\s*/gi, '').trim();
    const [head, ...why] = rest.split(/(?:^|\s)—\s/);
    let title = head.trim();
    let where = null;
    if (!why.length) {
      const open = trailingParen(title);
      if (open > 0 && pathsIn(title.slice(open + 1, -1)).length) { where = title.slice(open + 1, -1).trim(); title = title.slice(0, open).trim(); }
    }
    const note = [floor ? `floor: ${floor}` : null, why.length ? why.join(' — ').trim() : where].filter(Boolean).join('; ');
    add({ type: 'remark', sev, title: cut(title || `Deferred finding ${id}`, BUDGET.title), note: note ? cut(note, BUDGET.note) : null, anchors: pathsIn(rest), src, from });
  };
  if (finalDeferred) {
    finalDeferred.forEach((b, i) => {
      const id = /^((?:T-\d+|batch)\/F-\d+)\b/.exec(b)?.[1] ?? `d${i + 1}`;
      if (resolved.has(id)) return;
      remark(b, `review:${runId}/${id}`, id);
    });
  }
  try {
    for (const k of existsSync(tasksDir) ? readdirSync(tasksDir) : []) {
      const f = join(tasksDir, k, 'report.md');
      if (!existsSync(f)) continue;
      const text = read(f);
      if (!finalDeferred) bulletsOf(text, 'Deferred findings').forEach((b, i) => {
        const id = /^(F-\d+)\b/.exec(b)?.[1] ?? `d${i + 1}`;
        if (resolved.has(`T-${k}/${id}`)) return;
        remark(b, `review:${runId}/T-${k}/${id}`, `T-${k}/${id}`);
      });
      bulletsOf(text, 'Decisions').filter((d) => /\[visible\]/i.test(d)).forEach((d) => {
        const id = /^(D-\d+)/.exec(d)?.[1] ?? 'D-?';
        cand({ kind: 'decision', text: cut(d.replace(/\[visible\]\s*/i, ''), 300), src: `visible:${runId}/T-${k}/${id}`, run: runId });
      });
    }
  } catch (e) { warnings.push(`reports: ${e.message}`); }
  try {
    const af = join(copy.dir, 'answers.md');
    if (existsSync(af)) {
      const text = read(af);
      for (const m of text.matchAll(/^###\s+(Q-\d+)\s*(.*)$/gm)) {
        const body = text.slice(m.index + m[0].length).split(/^###\s/m)[0].trim();
        cand({ kind: 'decision', text: cut(`${m[2]}: ${body}`, 300), src: `answers:${runId}/${m[1]}`, run: runId });
      }
    }
  } catch (e) { warnings.push(`answers: ${e.message}`); }
  try {
    const second = headerOf(join(copy.dir, 'plan.md'))?.second;
    if (second) {
      const text = String(second);
      if (/^\s*decision\b/i.test(text)) add({ type: 'feature', title: cut(`Second sprint of ${copy.run.spec ?? runId}: ${text.replace(/^\s*decision\s*:?\s*/i, '')}`, BUDGET.title), note: cut(text, BUDGET.note), anchors: [], src: `second:${runId}` });
      else cand({ kind: 'second', text: cut(text.replace(/^\s*size\s*:?\s*/i, ''), 300), src: `second:${runId}`, run: runId, spec: copy.run.spec ?? null });
    }
  } catch (e) { warnings.push(`plan: ${e.message}`); }
  try {
    const st = copy.run.sprint ? statusOf(top, copy.run.sprint) : null;
    if (st?.state === 'stopped' && /goal|criteri|scope|requirement|change/i.test(String(st.reason ?? ''))) add({ type: 'change', title: cut(`Stopped ${copy.run.spec ?? runId}: ${st.reason}`, BUDGET.title), anchors: [], src: `stopped:${runId}` });
  } catch (e) { warnings.push(`status: ${e.message}`); }
  return finishIntake(P, open, items, inbox, cands, warnings);
}

function finishIntake(P, open, items, inbox, cands, warnings) {
  const { archived } = loadItems(P);
  let n = maxNum([...open, ...archived].map((x) => x.id), 'B');
  const rows = items.map((x) => normItem({ ...x, id: `B-${++n}`, state: 'new', at: today() }));
  for (const r of rows) { const e = itemErrors(r); if (e.length) warnings.push(...e); }
  const ok = rows.filter((r) => !itemErrors(r).length);
  let c = maxNum(inbox.map((x) => x.id), 'C');
  const crow = cands.map((x) => ({ id: `C-${++c}`, at: today(), ...x }));
  if (ok.length) { writeJsonl(P.backlog, [...open, ...ok]); logChange(P, `intake: ${ok.map((r) => r.id).join(', ')} new`, { kind: 'items', ids: ok.map((r) => r.id) }); }
  if (crow.length) appendJsonl(P.inbox, crow);
  return { ok: true, items: ok.map(itemLine), candidates: crow.map((x) => `${x.id} ${x.kind}: ${cut(x.text, 80)}`), ...(warnings.length ? { warnings } : {}) };
}

// UAT (§4.6): defekty → `bug` z wagą, zmiany wymagań → `change`; środowisko bez pozycji.
export function intakeUat(P, top, sprint) {
  const r = runCopies(top).filter((x) => (x.run.spec === sprint || x.run.sprint === sprint || x.id === sprint) && existsSync(join(x.dir, 'uat.md'))).at(-1);
  if (!r) throw new Error(`brak uat.md sprintu ${sprint} w kopiach przebiegów`);
  const text = read(join(r.dir, 'uat.md'));
  const h = parseYaml(splitHeader(text)?.yaml ?? '');
  const scope = asList(headerOf(join(r.dir, 'final-report.md'))?.scope).map(String).slice(0, 5);
  const { open, archived } = loadItems(P);
  const srcs = new Set([...open, ...archived].map((x) => x.src));
  const sid = r.run.spec ?? r.run.sprint ?? r.id;
  const items = [];
  for (const d of asList(h.defects)) {
    if (!['bug', 'requirement'].includes(d?.kind)) continue;
    const src = `uat:${sid}/${d.id}`;
    if (srcs.has(src)) continue;
    const m = new RegExp(`^###\\s+${d.id}\\b[^:]*:\\s*(.*)$`, 'm').exec(text);
    const place = m ? /^- Place:\s*(.*)$/m.exec(text.slice(m.index))?.[1] : null;
    items.push({ type: d.kind === 'bug' ? 'bug' : 'change', sev: d.kind === 'bug' && SEVS.includes(d.weight) ? d.weight : null, title: cut(m?.[1] ?? `${d.id} from UAT ${sid}`, BUDGET.title), note: place && place !== '-' ? cut(`Place: ${place}`, BUDGET.note) : null, anchors: d.kind === 'bug' ? scope : [], src });
  }
  return finishIntake(P, open, items, readJsonl(P.inbox), [], []);
}

// ---------- triaż (§4.7) ----------

export function triageAuto(P) {
  const { open, archived } = loadItems(P);
  let n = maxNum([...open, ...archived].map((x) => x.id), 'B');
  const props = readJsonl(P.proposals);
  const moved = props.map((p) => normItem({ ...p, id: `B-${++n}`, state: 'new', triage: null, at: p.at ?? today() }));
  const all = [...open, ...moved];
  const uatOf = (x) => /^uat:([^/]+)\//.exec(x.src ?? '')?.[1] ?? null;
  const fixFor = (sprint) => all.some((x) => x.type === 'bug' && uatOf(x) === sprint && ['blocker', 'major'].includes(x.sev));
  const decided = [];
  const ask = [];
  for (const x of all.filter((i) => i.state === 'new')) {
    const u = uatOf(x);
    let t = null;
    let rule = null;
    if (x.type === 'bug' && u && ['blocker', 'major'].includes(x.sev)) [t, rule] = ['now', 'T1'];
    else if (x.type === 'bug' && x.sev === 'minor' && u && fixFor(u)) [t, rule] = [`sprint:${u}-fix`, 'T2'];
    else if (['remark', 'debt'].includes(x.type) && x.anchors.length && (!x.sev || x.sev === 'minor')) [t, rule] = ['touch', 'T3'];
    else if (x.type === 'bug' && x.sev === 'minor' && x.anchors.length) [t, rule] = ['touch', 'T4'];
    if (t) { Object.assign(x, { triage: t, state: 'open' }); decided.push(`${x.id} → ${t} (${rule}) ${x.title}`); } else ask.push(`${x.id} ${x.type}${x.sev ? ` ${x.sev}` : ''}${x.anchors.length ? '' : ' no-anchors'}: ${x.title}`);
  }
  writeJsonl(P.backlog, all);
  if (props.length) writeJsonl(P.proposals, []);
  if (decided.length || moved.length) logChange(P, `triage-auto: ${[...moved.map((x) => `${x.id} from ${x.src}`), ...decided.map((d) => d.split(' ').slice(0, 3).join(' '))].join('; ')}`, { kind: 'items', ids: moved.map((x) => x.id) });
  const cands = readJsonl(P.inbox);
  return { decided, ask, moved: moved.map((x) => `${x.id} ← ${x.src}`), candidates: cands.map((c) => `${c.id} ${c.kind}: ${cut(c.text, 80)}`) };
}

// ---------- kalibracja (§5.4), mln na plik ----------

export function calibration(P) {
  const done = loadEstimates(P).filter((e) => e.actual && Array.isArray(e.files));
  if (!done.length) return null;
  const inR = (v, r) => Array.isArray(r) && v != null && v >= r[0] && v <= r[1];
  const mid = (r) => (r[0] + r[1]) / 2;
  return {
    n: done.length, filesInRange: done.filter((e) => inR(e.actual.files, e.files)).length, tokensInRange: done.filter((e) => inR(e.actual.tokensM, e.tokensM)).length,
    filesRatio: r2(median(done.filter((e) => mid(e.files)).map((e) => e.actual.files / mid(e.files)))),
    tokensRatio: r2(median(done.filter((e) => e.actual.tokensM != null && Array.isArray(e.tokensM) && mid(e.tokensM)).map((e) => e.actual.tokensM / mid(e.tokensM)))),
  };
}
export const calibrationLine = (c) => (c ? `n=${c.n}: files in range ${c.filesInRange}/${c.n}, tokens in range ${c.tokensInRange}/${c.n}, median actual/estimate files ${c.filesRatio ?? '-'}, tokens ${c.tokensRatio ?? '-'}` : 'no estimate with actual yet');
export function filesM(runs) {
  const v = runs.map((r) => r.mPerFile).filter((x) => x != null);
  return v.length >= 3 ? { p25: r2(pct(v, 0.25)), p75: r2(pct(v, 0.75)), n: v.length } : null;
}

// ---------- rozmiar kontekstu sesji (§4.1) ----------

export function transcriptOf(sid) {
  const root = process.env.DWMT_TRANSCRIPTS || join(homedir(), '.claude', 'projects');
  if (!sid || !existsSync(root)) return null;
  for (const p of readdirSync(root)) if (existsSync(join(root, p, `${sid}.jsonl`))) return join(root, p, `${sid}.jsonl`);
  return null;
}
export function contextK(sid = process.env.CLAUDE_CODE_SESSION_ID) {
  const f = transcriptOf(sid);
  if (!f) return null;
  try {
    const size = statSync(f).size;
    const len = Math.min(size, 512 * 1024);
    const fd = openSync(f, 'r');
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    closeSync(fd);
    const lines = buf.toString('utf8').split('\n').reverse();
    for (const l of lines) {
      if (!l.includes('"usage"')) continue;
      try {
        const d = JSON.parse(l);
        const u = d?.message?.usage;
        if (d?.type === 'assistant' && u && !d.isSidechain) return Math.round(((u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)) / 1000);
      } catch { /* urwana linia */ }
    }
  } catch { /* brak dostępu */ }
  return null;
}
// Najnowszy transkrypt projektu (expert start bez --session): katalog projektu Claude Code = ścieżka z „-” zamiast znaków spoza [A-Za-z0-9].
export function newestSession(top) {
  const root = process.env.DWMT_TRANSCRIPTS || join(homedir(), '.claude', 'projects');
  const dir = join(root, fwd(top).replace(/[^A-Za-z0-9]/g, '-'));
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).filter((x) => x.endsWith('.jsonl')).map((x) => ({ x, t: statSync(join(dir, x)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
  return f ? f.x.slice(0, -6) : null;
}

// ---------- eksperci (§3.8) ----------

export const builtinExperts = () => process.env.DWMT_EXPERTS_DIR || join(ROOT, 'experts');
export function expertFiles(P) {
  const out = {};
  for (const [dir, source] of [[builtinExperts(), 'built-in'], [P.experts, 'project']]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md') && !/^readme/i.test(x))) out[f.slice(0, -3)] = { file: join(dir, f), source };
  }
  return out;
}
export function parseExpert(file, domain) {
  const text = read(file).replace(/\r\n/g, '\n');
  const errors = [];
  const lines = text.trimEnd().split('\n').length;
  if (lines > BUDGET.expertLines) errors.push(`${lines} linii > ${BUDGET.expertLines}`);
  const s = splitHeader(text);
  let h = {};
  if (!s) errors.push('brak nagłówka YAML');
  else { try { h = parseYaml(s.yaml); } catch (e) { errors.push(e.message); } }
  if (s) {
    if (h.schema !== 'dwmt/expert@1') errors.push(`schema ${h.schema ?? '(brak)'}, oczekiwano dwmt/expert@1`);
    for (const k of ['domain', 'title', 'maximizes']) if (!h[k]) errors.push(`brak pola ${k}`);
    if (h.domain && h.domain !== domain) errors.push(`domain ${h.domain} ≠ nazwa pliku ${domain}`);
    if (h.domain && !/^[a-z0-9-]+$/.test(h.domain)) errors.push('domain: [a-z0-9-]+');
    if (!Array.isArray(h.guards) || !h.guards.length) errors.push('brak pola guards (lista)');
    else if (h.guards.length > 8) errors.push(`guards: ${h.guards.length} > 8`);
    if (typeof h.explorers?.allowed !== 'boolean') errors.push('brak pola explorers.allowed (true|false)');
  }
  const explorers = { allowed: !!h.explorers?.allowed, areas: h.explorers?.allowed ? asList(h.explorers?.areas ?? ['**']) : [], maxPerAsk: h.explorers?.maxPerAsk ?? 3 };
  return { domain, file: fwd(file), text, h: { ...h, reads: asList(h.reads), explorers, effort: h.effort ?? 'high' }, errors };
}
export function getExpert(P, domain) {
  const all = expertFiles(P);
  if (!all[domain]) throw new Error(`brak eksperta ${domain}; dostępni: ${Object.keys(all).sort().join(', ') || '(brak)'}; nowy: product expert new ${domain}`);
  return { ...parseExpert(all[domain].file, domain), source: all[domain].source };
}
export const EXPERT_TEMPLATE = (d) => `---
schema: dwmt/expert@1
domain: ${d}
title: ${d} expert
maximizes: "<one line: what this expert maximizes>"
guards:
  - "<what it watches in every proposal, 1 line each, at most 8>"
vocabulary:
  - "<term: definition; the dwmt dictionary wins on conflict>"
reads: []
explorers:
  allowed: false
  areas: []
  maxPerAsk: 3
effort: high
---
## Rules
<at most 20 lines: questions this expert asks first, what it hands to the PO (items) and what never (work orders)>
`;


// K5 D-10: sprints of running runs stalled by a failed agent session ({sprint: detail}), from the same assess call as the
// live view (`live.mjs#assessRun`: run files, command record, read-only queue, driver), over the main tree and worktrees.
export function stalledSprints(top) {
  const main = contextHome(top);
  const trees = [main];
  try {
    for (const m of git(['worktree', 'list', '--porcelain'], { cwd: main }).matchAll(/^worktree (.+)$/gm)) trees.push(m[1].trim());
  } catch { /* not a git repo: the main tree only */ }
  const out = {};
  for (const tree of trees) {
    const base = join(tree, '.dwmt', 'runs');
    for (const id of existsSync(base) ? readdirSync(base) : []) {
      try {
        const root = join(base, id);
        const run = JSON.parse(read(join(root, 'run.json')));
        if (!run.sprint || out[run.sprint] || ['squashed', 'left'].includes(run.finish?.status)) continue;
        const a = assess({ root, run: { ...run, session_ids: [] }, queue: (x) => queueTickets(x, { readOnly: true }) });
        if (a.state === 'stall' && a.reason === 'session') out[run.sprint] = a.detail;
      } catch { /* run.json in a write */ }
    }
  }
  return out;
}
// ---------- brief (§3.2, §4.11 pkt 2) ----------

export function visionGoal(P) {
  if (!existsSync(P.vision)) return null;
  const g = specSections(read(P.vision).replace(/\r\n/g, '\n')).Goal ?? '';
  return g.split('\n').map((l) => l.trim()).filter(Boolean).filter((l) => !/^\(.*\)$/.test(l));
}

// Drzwi (`expert start <d>`, `brief --for <d>`) mają własny znacznik `doorBrief[d]`, a `brief` PO swój `lastBrief.po`:
// wspólny klucz zerował „nowe decyzje z innych drzwi” w briefie PO zaraz po `expert start po` (recenzja N-4).
export function briefFor(P, domain) {
  const st = loadState(P);
  const since = st.doorBrief?.[domain] ?? null;
  const goal = visionGoal(P);
  const { active } = loadDecisions(P);
  const mine = active.filter((d) => d.area === domain || d.by === domain);
  const ch = loadChanges(P).filter((c) => !since || c.at > since);
  const out = [
    `brief for ${domain}${since ? ` (changes since ${since.slice(0, 16)})` : ''}`,
    `goal: ${goal?.length ? cut(goal.join(' '), 200) : 'not set'}`,
    `decisions (${domain}): ${mine.length ? '' : 'none'}`, ...mine.slice(-6).map((d) => `- ${d.id} ${d.title} (${d.by ?? '-'})`),
    `changes: ${ch.length ? '' : 'none'}`, ...ch.slice(-6).map((c) => `- ${cut(c.text, 150)}`),
  ];
  updateState(P, (s) => ({ doorBrief: { ...s.doorBrief, [domain]: new Date().toISOString() } }));
  return out.slice(0, 15).join('\n');
}

export function brief(P, top, cfg, pc, synced) {
  const st = loadState(P);
  const since = st.lastBrief?.po ?? null;
  const goal = visionGoal(P);
  const { open } = loadItems(P);
  const by = Object.fromEntries(ITEM_STATES.map((s) => [s, open.filter((x) => x.state === s).length]));
  const props = readJsonl(P.proposals).length;
  const lines = loadRoadmap(P);
  const index = loadIndex(P);
  let halts = {};
  try { halts = haltsOf(contextHome(top)); } catch { /* best effort */ }
  // Linia `running` zatrzymanego przebiegu z powodem (sterownik stoi, potrzebna decyzja).
  // K5 D-10: a run stopped by a failed agent session reads `(stalled: <detail>)`.
  let stalled = {};
  if (lines.some((l) => l.state === 'running')) { try { stalled = stalledSprints(top); } catch { /* best effort */ } }
  const ids = (s) => lines.filter((l) => l.state === s).map((l) => (s === 'running' && stalled[l.id] ? `${l.id} (stalled: ${cut(stalled[l.id], 80)})` : s === 'running' && halts[l.id]?.kind === 'stopped' ? `${l.id} (stopped: ${cut(halts[l.id].reason, 80)})` : l.id)).join(', ') || '-';
  const nx = nextSprint(lines, index);
  // `notes` lines with acceptance criteria are clear already (§3.9): the one-time migration to `todo` is offered here.
  const clear = lines.filter((l) => { try { return l.state === 'notes' && specAgreed(readSpec(P, l.id)?.body ?? ''); } catch { return false; } }).length;
  const { active } = loadDecisions(P);
  const newPd = since ? loadChanges(P).filter((c) => c.at > since && c.kind === 'decision' && c.by && c.by !== 'po').map((c) => c.text) : [];
  const inbox = readJsonl(P.inbox);
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const week = loadEstimates(P).filter((e) => String(e.at) >= weekAgo);
  const weekCost = r2(week.reduce((a, e) => a + (Number(e.cost) || 0), 0));
  const waiting = [];
  const sdir = join(contextHome(top), '.dwmt', 'supervisor', 'status');
  for (const f of existsSync(sdir) ? readdirSync(sdir).filter((x) => /^[^.]+\.json$/.test(x)) : []) {
    // Pod sterownikiem `session` to identyfikator wywołań skryptu (`drive-…`), nie sesja do `attach` (tę podaje linia supervisora).
    try { const s = JSON.parse(read(join(sdir, f))); if (s.state === 'waiting-user') waiting.push(`${s.sprint}${s.session && !/^drive-/.test(s.session) ? `: claude attach ${s.session}` : ''}`); } catch { /* zapis w toku */ }
  }
  const overheads = runCopies(top).map((r) => headerOf(join(r.dir, 'final-report.md'))?.estOverhead).filter((x) => Number.isFinite(Number(x)) && x !== null).map(Number).slice(-5);
  const om = overheads.length ? median(overheads) : null;
  const supervisor = existsSync(join(ROOT, 'scripts', 'supervise.mjs')) && cfg.supervisor?.enabled !== false ? 'on' : 'off';
  // S3 (spec supervisora §4.2): przy otwartym zleceniu `brief` uruchamia pętlę, jeśli nie działa; stan zlecenia w tej samej linii.
  const main = contextHome(top);
  let order = null;
  if (supervisor === 'on' && hasOrder(main)) { try { ensureLoop(main); order = briefLine(main); } catch { /* best effort */ } }
  const ctx = contextK();
  // K7 D-8: one line per workplace whose assigned sprints are all done; gone once the branch is pushed (batch T-1/F-5).
  let ready = [];
  try { ready = activeWorkplaces(top).map((w) => workplaceReady(top, w)).filter((r) => r.ready && !branchPushed(top, r.branch)); } catch { /* best effort */ }
  const out = [
    `product brief ${today()}${pc.enabled ? '' : ' (layer disabled: product.enabled false)'}`,
    `goal: ${goal?.length ? cut(goal.join(' '), 200) : 'not set: ask the decision-maker one question, then product init --goal'}`,
    `items: new ${by.new}${props ? ` (+${props} expert proposals)` : ''}, open ${by.open}, planned ${by.planned}${by.new || props ? ' → product triage-auto' : ''}`,
    `sprints: ready ${ids('ready')}; to do ${lines.filter((l) => l.state === 'todo').length}; ordered ${ids('ordered')}; running ${ids('running')}; waiting for UAT ${ids('done')}; notes ${lines.filter((l) => l.state === 'notes').length}${clear ? ` (${clear} with acceptance → product roadmap todo-from-notes)` : ''}, topics ${lines.filter((l) => l.state === 'topic').length}`,
    `next: ${nx ? `${nx.line.id} · ${nx.line.state} · ${nx.line.goal}` : 'none'}`,
    ...ready.map((r) => `ready to push: ${r.branch} (${r.n} sprints): ${r.pushCmd}`),
    ...(waiting.length ? [`waiting for sprint questions: ${waiting.join('; ')}`] : []),
    ...(inbox.length ? [`inbox: ${inbox.filter((c) => c.kind === 'decision').length} decision candidates, ${inbox.filter((c) => c.kind === 'second').length} second-sprint events (product inbox)`] : []),
    `decisions: ${active.length} active${newPd.length ? `; new from other doors: ${newPd.slice(-4).join('; ')}` : ''}`,
    `estimates this week: ${week.length}, ${weekCost} M${weekCost > pc.estimate.weeklyWarnM ? ` (above ${pc.estimate.weeklyWarnM} M: say so before the next one)` : ''}; calibration: ${calibrationLine(calibration(P))}`,
    ...(om != null ? [`estOverhead median last ${overheads.length}: ${r2(om * 100)}%${om > 0.03 ? ' (above 3%)' : ''}`] : []),
    `supervisor: ${supervisor}${order ? ` · ${order}` : ''}`,
    ...(ctx != null ? [`context: ${ctx}k${ctx > pc.contextWarnK ? ` > ${pc.contextWarnK}k: finish this mode, product commit, propose /clear and /dwmt:po` : ''}`] : []),
    // Przegląd 2026-10-09 (W-7): sesja bez wyłącznika T-OOM1 traci `wait` w tle przy braku pamięci; raz na start sesji PO.
    ...(process.env.CLAUDE_CODE_SESSION_ID && process.env.CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP !== '1'
      ? ['context: this session started without CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1, so its background waits can be stopped when memory is low: tell the user once to restart the session (claude --continue); if .claude/settings.json has no such env, run dwmt setup first'] : []),
    ...(synced?.length ? [`synced: ${cut(synced.join('; '), 300)}`] : []),
  ];
  updateState(P, (s) => ({ lastBrief: { ...s.lastBrief, po: new Date().toISOString() } }));
  return out.slice(0, 25).join('\n');
}

// ---------- start pracy (§4.12 pkt 1) ----------

export function estimateOf(P, ref) {
  if (!ref) return null;
  const s = String(ref);
  const m = /^start:\s*\[?\s*([\d.]+)\s*,\s*([\d.]+)\s*\]?$/.exec(s);
  if (m) return { start: [Number(m[1]), Number(m[2])], tokensM: [Number(m[1]), Number(m[2])], src: 'start' };
  const e = loadEstimates(P).find((x) => x.id === s);
  return e ? { id: e.id, files: e.files, tokensM: e.tokensM, flags: e.flags ?? {}, stale: !!e.stale, src: e.id, areas: e.areas } : null;
}

// Przegląd sprintu 16 (UI): uwaga z recenzji albo UAT wskazuje kod w swojej treści (dowody `plik:linia`), nawet gdy jej kotwica to
// szeroki glob (`frontend/e2e/**`). Takie pozycje nie jadą „przy okazji” w sprincie z architektem, tylko osobnym przebiegiem.
export const pinnedBySource = (x) => /^(review|uat):/.test(String(x?.src ?? ''));
const CODE_PATH = /(?:^|[\s`'"(])((?:[\w@-]+\/)*[\w.@-]+\.(?:java|kt|tsx?|jsx?|mjs|cjs|css|scss|py|go|rs|cs|json|ya?ml|sql|md))(?![\w])/g;

// Pliki, które wskazują pozycje: kotwice bez globów i pliki z treści uwag źródłowej recenzji (recenzenci często cytują samą
// nazwę, `invoices.ts:745`; nazwa bez katalogu liczy się raz, chyba że ta sama ścieżka jest pełna); bez `node_modules`.
// Służy tylko liczbie plików do wyboru trybu. null, gdy któraś pozycja nie wskazuje żadnego pliku.
export function pinnedFiles(top, items) {
  const files = new Set();
  for (const x of items) {
    const own = new Set(asList(x.anchors).map((a) => String(a).split('#')[0].replace(/^\.\//, '')).filter((a) => a && !/[*?{]/.test(a) && /\.\w+$/.test(a)));
    if (pinnedBySource(x)) {
      let text = '';
      try { text = findingSources(contextHome(top), [x], findingSection); } catch { /* bez źródła */ }
      for (const m of text.matchAll(CODE_PATH)) if (!m[1].includes('...') && !/(^|\/)node_modules\//.test(m[1])) own.add(m[1]);
    }
    if (!own.size) return null;
    for (const f of own) files.add(f);
  }
  const full = [...files].filter((f) => f.includes('/'));
  return [...files].filter((f) => f.includes('/') || !full.some((p) => p.endsWith(`/${f}`)));
}

// Próg trybu direct dla liczby wskazanych plików: pliki cytowane w uwagach recenzji to także dowody, których się nie zmienia
// (sprint 16 (UI): 19 cytowanych, 9 zmienionych), więc liczone z treści uwag mają własny próg `start.directMaxCited`; wykonawca
// direct i tak eskaluje, gdy pracy jest więcej niż ok. `directMaxFiles` plików.
const pinnedMax = (pc, items) => (items.some(pinnedBySource) ? pc.start.directMaxCited ?? 20 : pc.start.directMaxFiles ?? 10);

export function startCheck(P, top, cfg, pc, { items = [], spec = null, globs }) {
  if (!globsOf(globs).length) throw new Error('--globs: obszary zadania (globy) są wymagane');
  const ws = workingSet(top, globs, cfg);
  let types = items.map((x) => x.type);
  let est = null;
  let all = items;
  if (spec) {
    est = estimateOf(P, spec.h.est);
    const { open, archived } = loadItems(P);
    all = spec.h.items.map((id) => [...open, ...archived].find((x) => x.id === id)).filter(Boolean);
    types = all.map((x) => x.type);
  }
  if (!est) est = items.map((x) => estimateOf(P, x.est)).find(Boolean) ?? null;
  // K5 D-20: a fix sprint (kind bugfix, or only bugs and remarks) is priced and compared with finished fix sprints only.
  const fix = spec?.h.kind === 'bugfix' || (types.length > 0 && types.every((t) => ['bug', 'remark'].includes(t)));
  const done = completedRuns(top, cfg, pc);
  const runs = fix ? fixRunsOf(P, done) : done;
  const an = analogSummary(analogRuns(runs, globs));
  const small = ws.workingSetK <= pc.start.smallMaxK && (!an || an.medianM <= pc.start.smallMaxM);
  const fixFiles = fix ? fixFilesOf(top, pc, runs, est, all, spec ? asList(spec.h.items).length + asList(spec.h.touch).length : items.length) : null;
  const filesRange = fixFiles?.files ?? est?.files ?? an?.files ?? null;
  const prices = filesRange ? Object.fromEntries(MODES.map((m) => [m, priceRange(filesRange, mPerFile(runs, m, pc))])) : null;
  // Przegląd 2026-10-09 (W-4): phase-5 dostał `intermediate`, bo drugi start-check szedł już bez globu nowego obszaru
  // (pierwszy: `new-area`, glob bez plików). Globy bez plików zapamiętane przy sprincie dają `new-area`, dopóki nie mają plików.
  let remembered = [];
  if (spec?.h?.id) {
    const id = spec.h.id;
    const old = asList(loadState(P).newArea?.[id]);
    remembered = old.length ? workingSet(top, old, cfg).empty.filter((g) => !ws.empty.includes(g)) : [];
    if (ws.empty.some((g) => !old.includes(g))) updateState(P, (s0) => ({ newArea: { ...(s0.newArea ?? {}), [id]: [...new Set([...asList(s0.newArea?.[id]), ...ws.empty])] } }));
  }
  const empty = [...ws.empty, ...remembered];
  const risks = [...new Set([
    ...(empty.length ? ['new-area'] : []),
    ...(est?.flags?.newArea ? ['new-area'] : []), ...(est?.flags?.contract ? ['contract'] : []), ...(est?.flags?.migration ? ['migration'] : []),
  ])];
  const maint = (types.length && types.every((t) => ['bug', 'debt', 'remark'].includes(t))) || spec?.h.kind === 'maintenance';
  // Noc 2026-10-05 (E, D; ZAŁOŻENIE do przeglądu): direct dla poprawek wskazanych w kodzie (kotwica albo źródło z recenzji
  // lub UAT) do `directMaxFiles` plików; intermediate według liczby plików (bez flag ryzyka); dalej jak w v0.2.
  const flagged = risks.some((r) => ['new-area', 'contract', 'migration'].includes(r));
  const anchored = all.length > 0 && all.every((x) => asList(x.anchors).length || pinnedBySource(x));
  const s = pc.start;
  // Przegląd sprintu 16 (UI): wielkość do wyboru trybu tylko z tego sprintu: szacunek plików, dla poprawek wskazane pliki, inaczej
  // zbiór roboczy. Pliki analogii to wielkość dawnych sprintów w tych obszarach (sprint 16 (UI): 73–227 przy 55 faktycznych) i
  // służą tylko cenie; z nich wyszedł `single` zamiast `intermediate`.
  const sizeFiles = est?.files ?? null;
  const pinned = maint && anchored && !sizeFiles ? pinnedFiles(top, all) : null;
  const direct = maint && anchored && !flagged && (sizeFiles ? sizeFiles[1] <= (s.directMaxFiles ?? 10) : pinned ? pinned.length <= pinnedMax(pc, all) : small);
  const mid = !flagged && (sizeFiles ? sizeFiles[1] <= (s.intermediateMaxFiles ?? 60) : ws.workingSetK <= (s.intermediateMaxK ?? 150));
  const recommend = direct ? 'direct' : small ? 'inline' : mid || (maint && !flagged) ? 'intermediate' : 'single';
  const sizeFrom = sizeFiles ? `estimate ${sizeFiles.join('-')} files` : pinned ? `${pinned.length} pinned files` : `working set ${ws.workingSetK}k`;
  const basis = [`size: ${sizeFrom}`, est?.id ? `estimate ${est.id}` : est?.start ? `start price ${est.start.join('-')}` : null, ...(fix ? [`fix sprints n=${runs.length}`, fixFiles.rule] : []), an ? `analog ${an.mode} n=${an.n}` : 'no analog', prices ? 'M/file by mode' : 'no price'].filter(Boolean).join('; ');
  // Uwagi z recenzji albo UAT przypięte do sprintu (`touch`) idą osobnym przebiegiem, nie przy okazji pracy architekta.
  let separate = null;
  if (spec) {
    const { open } = loadItems(P);
    const ids = asList(spec.h.touch).filter((id) => pinnedBySource(open.find((x) => x.id === id)));
    if (ids.length) separate = separateGroup(top, pc, ids.map((id) => open.find((x) => x.id === id)));
  }
  return {
    workingSetK: ws.workingSetK, analog: an ? { n: an.n, mode: an.mode, medianM: an.medianM, rangeM: an.rangeM, files: an.files } : null,
    est: est ? (est.id ? { id: est.id, files: est.files, tokensM: est.tokensM, stale: est.stale } : { start: est.start }) : null,
    small, risks, recommend, prices, basis, ...(pinned ? { pinnedFiles: pinned.length } : {}), ...(separate ? { separate } : {}), ...(empty.length ? { emptyGlobs: empty } : {}),
  };
}

// K5 D-20: completed runs whose sprint file (`sprints/<id>.md`, else `archive/<id>.md`; id = the run's spec or sprint) has
// kind `bugfix`, with `items` = header items + touch.
export function fixRunsOf(P, runs) {
  const out = [];
  for (const r of runs) {
    const id = r.spec ?? r.sprint;
    if (!id) continue;
    let s = null;
    try { s = readSpecAt(join(P.sprints, `${id}.md`)) ?? readSpecAt(join(P.archive, `${id}.md`)); } catch { /* broken header: not a fix run */ }
    if (s?.h.kind === 'bugfix') out.push({ ...r, items: asList(s.h.items).length + asList(s.h.touch).length });
  }
  return out;
}
// K5 D-20: files of a fix sprint: the estimate files; else the pinned files; else items × the p25–p75 files per item of the
// fix runs (default `product.price.fixFilesPerItem`). → {files, rule}.
export function fixFilesOf(top, pc, fixRuns, est, all, nItems) {
  if (est?.files) return { files: est.files, rule: `files: estimate ${est.files.join('-')}` };
  let pinned = null;
  try { pinned = all.length ? pinnedFiles(top, all) : null; } catch { /* no pinned files */ }
  if (pinned?.length) return { files: [pinned.length, pinned.length], rule: `files: ${pinned.length} pinned` };
  const per = fixRuns.filter((r) => r.files > 0 && r.items > 0).map((r) => r.files / r.items);
  const [lo, hi] = per.length ? [r1(pct(per, 0.25)), r1(pct(per, 0.75))] : (pc.price?.fixFilesPerItem ?? [1, 3]);
  const n = Math.max(1, nItems);
  return { files: [Math.max(1, Math.round(n * lo)), Math.max(1, Math.round(n * hi))], rule: `files: ${n} items × ${lo}-${hi} files/item${per.length ? ` (fix runs n=${per.length})` : ' (default)'}` };
}

// Grupa uwag z recenzji albo UAT poza sprintem: tryb `direct`, gdy wskazane pliki mieszczą się w progu, inaczej `intermediate`.
export function separateGroup(top, pc, items) {
  const files = pinnedFiles(top, items);
  return { items: items.map((x) => x.id), files: files ? files.length : null, recommend: files && files.length <= pinnedMax(pc, items) ? 'direct' : 'intermediate' };
}

// ---------- szacunek poziomu 0 (§5.1) ----------

export function estimateInput(P, top, cfg, pc, ids, describe) {
  const est = loadEstimates(P);
  const dirs = existsSync(P.work) ? readdirSync(P.work).filter((d) => /^estimate-E-\d+$/.test(d)).map((d) => d.slice(9)) : [];
  const id = `E-${maxNum([...est.map((e) => e.id), ...dirs], 'E') + 1}`;
  const dir = join(P.work, `estimate-${id}`);
  mkdirSync(dir, { recursive: true });
  const sizes = writeSizes(top, dir, cfg);
  const files = trackedFiles(top, cfg);
  const adrs = files.filter((f) => /(^|\/)(adr|adrs)\/[^/]+\.md$/i.test(f)).slice(0, 30).map((f) => {
    const t = /^#\s+(.+)$/m.exec(read(join(top, f)))?.[1] ?? '';
    return `- ${f}${t ? `: ${cut(t, 100)}` : ''}`;
  });
  const runs = completedRuns(top, cfg, pc);
  const fm = filesM(runs);
  const goal = visionGoal(P);
  const text = [
    `# Estimate ${id} input (level 0)`, '',
    'Mode: product-estimate. Areas from docs and the directory layout, names via Grep and Glob; read no code beyond Grep hit lines.',
    'Start no explorers and no other agent (no Agent tool): the price of this estimate assumes none. Write no plans; write only result.md.', '',
    '## For', '', ...ids.flatMap((x) => [describe(x), '']),
    '## Product goal', '', ...(goal?.length ? goal : ['not set']), '',
    '## ADRs (titles; read only those relevant to the case)', '', ...(adrs.length ? adrs : ['- none']), '',
    '## Project', '', `- CLAUDE.md: ${existsSync(join(top, 'CLAUDE.md')) ? 'CLAUDE.md' : 'none'}`, `- Sizes: ${fwd(sizes)}`,
    `- Split above: ${pc.sprintMax.files} changed code files or ${pc.sprintMax.tokensM} M tokens (propose a split by size)`, '',
    '## Calibration (input, not a rule)', '', `- ${calibrationLine(calibration(P))}`,
    `- M tokens per changed code file in this project: ${fm ? `p25 ${fm.p25}, p75 ${fm.p75} (n=${fm.n}); the script prices tokens, not you` : 'no data (script uses 0.2)'}`, '',
    '## Result: write result.md in this directory', '', '```', '---', 'schema: dwmt/estimate-result@1', 'entries:',
    '  - {for: [<id>], areas: ["<glob>"], files: [<min>, <max>], flags: {newArea: false, contract: false, migration: false, screens: 0}, split: null}',
    '---', '## Facts', '- <at most 5 lines from Grep hits>', '```',
    'One entry per id (or one for several ids that are one piece of work); areas ≤ 5 globs; files = changed code files; split: null or a one-line proposal. Reply in ≤ 10 lines.', '',
  ].join('\n');
  put(join(dir, 'input.md'), text);
  return { ok: true, id, dir: fwd(dir), input: fwd(join(dir, 'input.md')), result: fwd(join(dir, 'result.md')), agent: 'dwmt-architect', effort: 'xhigh', maxTurns: pc.estimate.maxTurns, prompt: `Mode: product-estimate. Input: ${fwd(join(dir, 'input.md'))}. Result: ${fwd(join(dir, 'result.md'))}.` };
}

export function parseEstimateResult(file) {
  const text = read(file);
  let h;
  if (/^\s*\{/.test(text)) h = JSON.parse(text);
  else { const s = splitHeader(text); if (!s) throw new Error(`${fwd(file)}: brak nagłówka YAML`); h = parseYaml(s.yaml); }
  const entries = asList(h.entries);
  if (!entries.length) throw new Error(`${fwd(file)}: brak entries`);
  const facts = /##\s+Facts\s*\n([\s\S]*)$/.exec(text)?.[1]?.split('\n').filter((l) => /^- /.test(l)).slice(0, 5) ?? [];
  return { entries, facts };
}

export function tokensFor(files, runs) {
  const v = runs.map((r) => r.mPerFile).filter((x) => x != null);
  const [lo, hi] = v.length >= 3 ? [pct(v, 0.25), pct(v, 0.75)] : [0.2, 0.2];
  return [r1(files[0] * lo), r1(files[1] * hi)];
}

// ---------- narzut szacowania (§9) ----------

export function overhead(P, top, runId) {
  const copy = runCopies(top).find((r) => r.id === runId);
  const runFile = copy ? join(copy.dir, 'run.json') : join(top, '.dwmt', 'runs', runId, 'run.json');
  if (!existsSync(runFile)) throw new Error(`brak przebiegu ${runId}`);
  const run = JSON.parse(read(runFile));
  const specId = run.spec ?? null;
  const spec = specId ? (readSpec(P, specId) ?? (existsSync(join(P.archive, `${specId}.md`)) ? { h: parseYaml(splitHeader(read(join(P.archive, `${specId}.md`)))?.yaml ?? '') } : null)) : null;
  const { open, archived } = loadItems(P);
  const itemIds = [...asList(spec?.h.items), ...asList(spec?.h.touch), ...asList(run.items)];
  const refs = new Set([spec?.h.est, ...[...open, ...archived].filter((x) => itemIds.includes(x.id)).map((x) => x.est)].filter((x) => /^E-\d+$/.test(String(x))));
  const est = loadEstimates(P).filter((e) => refs.has(e.id));
  const E = r2(est.reduce((a, e) => a + (Number(e.cost) || 0) / Math.max(1, asList(e.for).length), 0));
  const P_ = run.price?.onlyTurn ? Number(run.price.turnM) || 0 : 0;
  const rep = copy ? headerOf(join(copy.dir, 'final-report.md')) : null;
  const S = Number(run.finish?.cost ?? rep?.cost?.total) || null;
  return { ok: true, run: runId, spec: specId, estimates: est.map((e) => e.id), E, P: P_, S, estOverhead: S ? Math.round(((E + P_) / S) * 10000) / 10000 : null };
}

export { analogRuns, analogSummary, completedRuns, globMatcher, globsOf, trackedFiles };
