// dwmt: runda zbiorcza v2.8 (specyfikacja-dwmt.md §5.6, §5.9 „Koniec sprintu”, docs/v28-working-note.md A).
// Po scaleniu recenzji zadania k skrypt dzieli listę `fix` na `now` (blocker, uwaga w miejscu późniejszego zadania)
// i `batch` (reszta, odłożone widoczne, otwarte po ostatniej rundzie); pozycje `T-k/F-n` czekają w `run.batch.items`
// na jedną rundę poprawek po ostatnim zadaniu: `batch/batch.md`, wynik pozycji, `batch/report.md`, miary.
// Import z dwmt.mjs tworzy cykl ES (jak plan.mjs); żadna funkcja stąd nie jest używana na poziomie modułu.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  tryHeader, withHeader, taskDir, isLegacy, unitFindings, planInfo, resultFiles, sessionsCost, emitYaml, deferredEntries,
} from './dwmt.mjs';
import { is28, pathsFor, planAnchors, headFiles, touches } from './plan.mjs';
import { knownRedToFix } from './lib/known-red.mjs';
import { recordScriptFindings } from './lib/script-checks.mjs';

const fwd = (p) => String(p).replace(/\\/g, '/');
const read = (f) => readFileSync(f, 'utf8');
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const str = (x) => (typeof x === 'string' ? x : JSON.stringify(x));
const idOf = (s) => str(s).split(/\s/)[0].replace(/[:,;]+$/, '');
const unique = (xs) => [...new Set(xs)];
export const REASONS = ['fix', 'deferred-visible', 'deferred-major', 'open-after-last-round', 'known-red'];

// Runda zbiorcza działa w przebiegu 2.8 z planem sprintu architekta; nie w `inline` i przy imporcie planu zadania bez
// `plan.md` (tam v2.7); `review.batch: false` przywraca v2.7.
export function batchOn(root, run, cfg) {
  if (!is28(run) || isLegacy(run) || cfg?.review?.batch === false) return false;
  if (!existsSync(join(root, 'plan.md'))) return false;
  const mode = tryHeader(join(taskDir(root, run.task ?? 1), 'brief.md'))?.mode ?? run.mode;
  return mode !== 'inline';
}
export const batchPending = (root, run, cfg) => batchOn(root, run, cfg) && asList(run.batch?.items).length > 0 && !run.batch.commit;
export const batchCtx = (root, run) => ({ root, dir: join(root, 'batch'), t: run.batch, k: run.task, n: run.count ?? 1, legacy: false, batch: true });

// Stan rundy zbiorczej (jak stan zadania): punkt odniesienia diffu to commit ostatniego zadania.
export function ensureBatch(run, cfg) {
  const b = (run.batch ??= { items: [] });
  if (b.baseline) return b;
  const last = [...run.tasks].sort((a, c) => c.k - a.k)[0];
  Object.assign(b, {
    baseline: last.commit, at: new Date().toISOString(), started: {}, trees: {}, verified: 0, reviewInput: 0, units: {}, repairs: {},
    commit: null, accepted: false, maxRounds: cfg?.review?.maxRounds ?? 2,
  });
  return b;
}

// Sekcja uwagi, której nagłówek zaczyna się identyfikatorem (`### F-3 …`, `### T-2/F-3 …`); `F-3` nie trafia w `T-2/F-3`.
export function findingSection(text, id) {
  const src = String(text ?? '');
  const e = String(id).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const m = new RegExp(`^(#{1,6})\\s+[*\`]*${e}(?![\\w/-])`, 'm').exec(src);
  if (!m) return null;
  const lines = src.slice(m.index).split(/\r?\n/);
  const level = m[1].length;
  let end = lines.length;
  let fence = false;
  for (let i = 1; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    else if (!fence && /^(#{1,6})\s/.test(lines[i]) && /^(#+)/.exec(lines[i])[1].length <= level) { end = i; break; }
  }
  return lines.slice(0, end).join('\n').trimEnd();
}

const SEV = /\[(blocker|major|minor)\]/i;
const SEV_LOOSE = /\(\s*(blocker|major|minor)\s*\)/i;
// K2 (D-3, C-2): podłoga wagi. Uwaga z `[floor: <klasa>]` w tytule ma co najmniej `major` wszędzie, gdzie skrypty czytają wagę.
export const FLOOR = /\[floor:\s*([a-z-]+)\]/i;
const SEV_RANK = { minor: 1, major: 2, blocker: 3 };
export const effectiveSeverity = (severity, floor) => (floor && (SEV_RANK[severity] ?? 0) < SEV_RANK.major ? 'major' : severity ?? null);
// Plik z dowodu: tylko linia „Evidence”, pierwszy token w backtickach (albo pierwszy token), dowolne znaki bez spacji
// (`app/(auth)/[id]/page.tsx:12`), bez `:linia`; bez linii Evidence null (bez zgadywania z innych linii, np. „Test:”).
// Uwaga z plikiem null nie jest „teraz” z powodu późniejszego zadania (zostaje w rundzie zbiorczej; tylko blocker idzie teraz).
export function evidenceFile(sec, top) {
  const lines = String(sec ?? '').split(/\r?\n/).slice(1).join('\n');
  const ev = /^\s*[-*]?\s*\**Evidence\**\s*:\**\s*(.*)$/im.exec(lines)?.[1];
  if (!ev) return null;
  const tick = /`([^`]+)`/.exec(ev)?.[1];
  let tok = (tick ?? ev).trim().split(/\s+/)[0] ?? '';
  if (!tick) tok = tok.replace(/[,;]+$/, '');
  if (!tok) return null;
  const f = fwd(tok).replace(/:\d+(?:[-:]\d+)*$/, '').replace(/^(\.\/)+/, '');
  if (!f || !/[./]/.test(f)) return null;
  const t = `${fwd(top).replace(/\/+$/, '')}/`;
  return f.toLowerCase().startsWith(t.toLowerCase()) ? f.slice(t.length) : f;
}
const cleanTitle = (head, id) => head.replace(/^#+\s*/, '').replace(/[*`]/g, '').trim()
  .replace(new RegExp(`^${id.replace(/[/-]/g, '\\$&')}\\b\\s*`), '').replace(SEV, '').replace(FLOOR, '').replace(/\s+/g, ' ').trim() || id;

// Opis uwagi z recenzji zadania: pierwsza sekcja z wagą (źródło, tytuł, treść), waga z najnowszej, plik z dowodu.
export function findingInfo(texts, id, top) {
  const out = { severity: null, title: id, file: null, source: null, section: null, floor: null };
  texts.forEach((text, i) => {
    const sec = findingSection(text, id);
    if (!sec) return;
    const head = sec.split(/\r?\n/)[0];
    const m = SEV.exec(head);
    if (m && !out.source) {
      out.source = i + 1;
      out.section = sec;
      out.title = cleanTitle(head, id);
    }
    if (m) out.severity = m[1].toLowerCase();
    const fl = FLOOR.exec(head.replace(/[*`]/g, ''));
    if (fl) out.floor = fl[1].toLowerCase();
    if (!out.file) out.file = evidenceFile(sec, top);
  });
  // Nagłówek bez wagi w nawiasach kwadratowych (`### F-3 (major) Wrong total`): waga z nawiasu okrągłego, tytuł z nagłówka.
  if (!out.section) {
    const last = [...texts].reverse().find((x) => findingSection(x, id));
    if (last) {
      out.section = findingSection(last, id);
      out.source = texts.lastIndexOf(last) + 1;
      const head = out.section.split(/\r?\n/)[0];
      const m = SEV_LOOSE.exec(head.replace(/[*`]/g, ''));
      if (m && !out.severity) out.severity = m[1].toLowerCase();
      out.title = cleanTitle(head.replace(/[*`]/g, '').replace(SEV_LOOSE, ''), id);
    }
  }
  out.severity = effectiveSeverity(out.severity, out.floor);
  return out;
}

// K2 (D-12): linia przejścia pragmatism jednej uwagi w obu formach szablonów: `- F-n: defer — powód` i ``- F-n `defer` — powód``
// (dwukropek i backticki opcjonalne, myślnik długi, krótki albo `-`). Ostatnia pasująca linia tekstu; bez niej null.
const escId = (id) => String(id).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
export function triageOf(text, id) {
  const re = new RegExp(`^\\s*[-*]\\s+\\**\`?${escId(id)}(?![\\w/-])\`?\\**\\s*:?\\s*\`?(fix|defer|drop)\`?\\s*:?\\s*(?:[—–-]+\\s*(.*?))?\\s*$`, 'gim');
  let last = null;
  for (const m of String(text ?? '').matchAll(re)) last = { triage: m[1].toLowerCase(), reason: m[2] ?? '' };
  return last;
}

// K2 (C-2): odłożone identyfikatory jednej recenzji: `defer` z nagłówka plus każde `drop` uwagi z podłogą, której linia
// pragmatism nie podaje kontrdowodu `plik:linia`. Recenzja zostaje artefaktem recenzenta (bez przepisywania pliku).
// `texts`: recenzje do tej włącznie (ostatnia to ta recenzja; sekcja uwagi może być we wcześniejszej).
const COUNTER = /[\w./-]+:\d+/;
export function deferredIdsOf(h, texts, top = '') {
  const all = Array.isArray(texts) ? texts : [texts];
  const own = all[all.length - 1] ?? '';
  const defer = unique(asList(h?.defer).map(idOf));
  const dropped = unique(asList(h?.drop).map(idOf)).filter((id) => !defer.includes(id)
    && findingInfo(all, id, top).floor && !COUNTER.test(triageOf(own, id)?.reason ?? ''));
  return [...defer, ...dropped];
}

// Kotwice i `scope` planów zadań po k (dla ostatniego zadania nic nie jest „późniejsze”).
function laterTargets(top, root, run, k) {
  const plan = planInfo(root, run);
  const n = asList(plan?.h?.tasks).length || (run.count ?? 1);
  if (!plan || k >= n) return [];
  const head = headFiles(top);
  const out = [];
  for (let j = k + 1; j <= n; j++) {
    const f = join(taskDir(root, j), 'brief.md');
    const h = tryHeader(f);
    if (!h || h.errors) continue;
    out.push({ j, anchors: planAnchors(read(f), h, j, plan, head).paths, scope: asList(h.scope) });
  }
  return out;
}

const reviewTexts = (dir) => { const out = []; for (let n = 1; existsSync(join(dir, `review-${n}.md`)); n++) out.push(read(join(dir, `review-${n}.md`))); return out; };

// Podział listy `fix` recenzji rundy `round` zadania k (§5.6). Zwraca `now` i pozycje rundy zbiorczej z opisem.
export function splitFix({ top, root, run, cfg, ctx, round, h, texts }) {
  const { k, t } = ctx;
  const last = round >= (t.maxRounds ?? cfg.review?.maxRounds ?? 2);
  const fix = unique(asList(h.fix).map(idOf));
  const defer = deferredIdsOf(h, texts.slice(0, round), top);
  const uiUnits = asList(t.units?.[round]).filter((u) => u.agent === 'dwmt-ui-verifier');
  const byUnit = uiUnits.length ? unitFindings(texts[round - 1] ?? '') : {};
  const ui = new Set(uiUnits.flatMap((u) => byUnit[u.name] || []));
  const visible = new Set([...asList(h.visible).map(idOf), ...ui]);
  const seen = texts.slice(0, round);
  const info = new Map([...fix, ...defer].map((id) => [id, findingInfo(seen, id, top)]));
  const later = last ? [] : laterTargets(top, root, run, k);
  const forLater = (file) => !!file && later.some((x) => touches(file, x.anchors, x.scope));
  const now = fix.filter((id) => info.get(id).severity === 'blocker' || forLater(info.get(id).file));
  const items = [
    ...fix.filter((id) => !now.includes(id)).map((id) => ({ id, reason: last ? 'open-after-last-round' : 'fix' })),
    // K2 (D-6): odłożona uwaga o wadze (po podłodze) `major` albo `blocker` też idzie do rundy zbiorczej; widoczna zostaje `deferred-visible`.
    ...defer.filter((id) => !fix.includes(id) && (visible.has(id) || ['major', 'blocker'].includes(info.get(id).severity)))
      .map((id) => ({ id, reason: visible.has(id) ? 'deferred-visible' : 'deferred-major' })),
  ].map(({ id, reason }) => itemOf({ k, finding: id, reason, visible: visible.has(id), ui: ui.has(id), round, info: info.get(id) }));
  return { now, items };
}

const itemOf = ({ k, finding, reason, visible, ui, round, info: x }) => ({
  id: `T-${k}/${finding}`, task: k, finding, severity: x.severity, title: x.title, file: x.file,
  review: x.source ? `tasks/${k}/review-${x.source}.md` : `tasks/${k}/review-${round}.md`, round, reason, visible, ui,
});
// Wpis listy `batch` w nagłówku recenzji: `F-n <powód> [visible] [ui]` (pozycję da się odtworzyć z samego nagłówka).
const entryOf = (x) => [x.finding, x.reason, ...(x.visible ? ['visible'] : []), ...(x.ui ? ['ui'] : [])].join(' ');

// `run.batch.items` odtworzone z nagłówków podzielonych recenzji wszystkich zadań (kolejność: zadanie, runda, lista).
// Wywoływane przy każdym podziale: przerwana komenda (podział zapisany, run.json nie) nie gubi pozycji (recenzja v2.8 F1).
export function syncBatchItems(top, root, run, cfg) {
  if (isLegacy(run) || !batchOn(root, run, cfg)) return asList(run.batch?.items);
  const items = [];
  for (const t of [...asList(run.tasks)].sort((a, b) => a.k - b.k)) {
    const dir = taskDir(root, t.k);
    const texts = reviewTexts(dir);
    texts.forEach((_, i) => {
      const h = tryHeader(join(dir, `review-${i + 1}.md`));
      if (!h || h.errors || !Array.isArray(h.now)) return;
      for (const e of asList(h.batch)) {
        const [finding, reason = 'fix', ...flags] = str(e).trim().split(/\s+/);
        if (!finding || items.some((x) => x.id === `T-${t.k}/${finding}`)) continue;
        items.push(itemOf({ k: t.k, finding, reason, visible: flags.includes('visible'), ui: flags.includes('ui'), round: i + 1, info: findingInfo(texts.slice(0, i + 1), finding, top) }));
      }
    });
  }
  // Przegląd a6: znana czerwień w pliku testu zmienianym przez sprint (`known-red.mjs`) to pozycja `T-k/KR-n`.
  knownRedToFix(top, root, run).forEach((x, i) => items.push({
    id: `T-${x.k}/KR-${i + 1}`, task: x.k, finding: `KR-${i + 1}`, severity: 'major', title: `Known red test in a file this sprint changed (${x.files.join(', ')})`,
    file: x.files[0], review: `tasks/${x.k}/${x.file}`, round: null, reason: 'known-red', visible: false, ui: false, claim: x.claim,
  }));
  if (!items.length && !run.batch) return items;
  (run.batch ??= { items: [] }).items = items;
  return items;
}

// Po scaleniu recenzji zadania (state, commit, review-input): recenzja bez `now` dostaje w nagłówku `now` i `batch`,
// pozycje trafiają do `run.batch.items` (bez powtórzeń). Idempotentne: recenzja z `now` jest już podzielona.
export function splitReviews(top, root, run, cfg, ctx) {
  // K4 (D-24): S-n kontroli skryptu do recenzji zadania przed podziałem (także przy `review.batch: false`).
  if (!ctx.legacy && !ctx.batch) recordScriptFindings(ctx.dir, ctx.t);
  if (ctx.legacy || ctx.batch || !batchOn(root, run, cfg)) return 0;
  const texts = reviewTexts(ctx.dir);
  let changed = 0;
  texts.forEach((text, i) => {
    const round = i + 1;
    const file = join(ctx.dir, `review-${round}.md`);
    const h = tryHeader(file);
    if (!h || h.errors || h.now !== undefined) return;
    const { now, items } = splitFix({ top, root, run, cfg, ctx, round, h, texts });
    const m = /^﻿?---\r?\n[\s\S]*?(\r?\n)---[ \t]*(?:\r?\n|$)/.exec(text);
    if (!m) return;
    const at = m.index + m[0].lastIndexOf(`${m[1]}---`);
    const eol = m[1];
    const add = `${eol}${emitYaml({ now, batch: items.map(entryOf) }).replace(/\n/g, eol)}`;
    texts[i] = `${text.slice(0, at)}${add}${text.slice(at)}`;
    writeFileSync(file, texts[i]);
    changed++;
  });
  syncBatchItems(top, root, run, cfg);
  return changed;
}

// Najwyższy numer F-n pozycji: nowe uwagi rundy zbiorczej numerujemy od niego dalej, więc gołe `F-n` ≤ tej liczby
// to pozycja, której recenzent zgubił przedrostek `T-k/` (recenzja v2.8 F4).
export const itemMax = (items) => Math.max(0, ...asList(items).map((x) => Number(/F-(\d+)$/.exec(x.finding)?.[1] || 0)));
export function resolveIds(ids, items) {
  const max = itemMax(items);
  const out = [];
  const ambiguous = [];
  for (const raw of asList(ids)) {
    const id = idOf(typeof raw === 'object' && raw ? raw.id ?? str(raw) : raw);
    const bare = /^F-(\d+)$/.exec(id);
    const hits = bare && Number(bare[1]) <= max ? asList(items).filter((x) => x.finding === id) : [];
    if (hits.length > 1) ambiguous.push(id);
    out.push(...(hits.length ? hits.map((x) => x.id) : [id]));
  }
  return { ids: unique(out), ambiguous: unique(ambiguous) };
}
// Pozycje zamknięte przez skrypt (BLOCKED z planIssue bez pytań): zostają otwarte z powodem, fixer ich nie rusza.
// Wyprowadzane z plików, bez stanu w run.json (komendy tylko do odczytu, np. hook SessionStart, nic nie gubią):
// zarchiwizowane wyniki `result-N.blocked-M.md` po kolei, a przy `current` także bieżący `result-N.md` tej rundy.
// Pozycje wymienione w planIssue (całe identyfikatory: T-1/F-10 nie zamyka T-1/F-1), inaczej wszystkie niepoprawione.
export const planIssueOnly = (h) => !!(h && !h.errors && h.status === 'BLOCKED' && !asList(h.questions).length && h.planIssue);
const names = (text, id) => new RegExp(`(?<![\\w/])${id.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?!\\w)`).test(text);
export function batchClosed(dir, items, current = null) {
  const files = existsSync(dir) ? readdirSync(dir).map((f) => /^result-(\d+)\.blocked-(\d+)\.md$/.exec(f)).filter(Boolean)
    .sort((a, b) => Number(a[1]) - Number(b[1]) || Number(a[2]) - Number(b[2])).map((m) => ({ f: m[0], round: Number(m[1]) })) : [];
  if (current != null) files.push({ f: `result-${current}.md`, round: current });
  const closed = {};
  for (const { f, round } of files) {
    const h = tryHeader(join(dir, f));
    if (!planIssueOnly(h)) continue;
    const text = typeof h.planIssue === 'string' ? h.planIssue : JSON.stringify(h.planIssue);
    const left = asList(items).filter((x) => !closed[x.id]);
    const fixed = new Set(resolveIds(asList(h.fixed), items).ids);
    const named = left.filter((x) => names(text, x.id)).map((x) => x.id);
    for (const id of named.length ? named : left.filter((x) => !fixed.has(x.id)).map((x) => x.id)) closed[id] = `closed: planIssue in round ${round}: ${text.replace(/\s+/g, ' ').slice(0, 160)}`;
  }
  return closed;
}
export const closedIds = (root, run, current = null) => Object.keys(batchClosed(join(root, 'batch'), asList(run.batch?.items), current));
export const remainingItems = (root, run, closed = closedIds(root, run)) => asList(run.batch?.items).filter((x) => !closed.includes(x.id));

// Nowe uwagi rundy zbiorczej odłożone przez jej recenzję (`defer`, nie pozycje): do raportu i pliku odłożonych uwag.
export function batchDeferred(root, run) {
  const dir = join(root, 'batch');
  const texts = reviewTexts(dir);
  const items = asList(run.batch?.items);
  const ids = unique(texts.flatMap((_, i) => resolveIds(deferredIdsOf(tryHeader(join(dir, `review-${i + 1}.md`)), texts.slice(0, i + 1)), items).ids))
    .filter((id) => !items.some((x) => x.id === id));
  return { ids, entries: deferredEntries(texts, ids) };
}

// Pozycje zadania k do raportu zadania: `batched: ["F-n reason"]`.
export const batchedOf = (run, k) => asList(run.batch?.items).filter((x) => x.task === k).map((x) => `${x.finding} ${x.reason}`);

// batch/batch.md (`dwmt/batch@1`): treść uwagi skopiowana z recenzji źródłowej i ścieżka planu zadania pozycji.
export function writeBatchFile(top, root, run) {
  const { rel } = pathsFor(run, top);
  const items = asList(run.batch?.items);
  const tasks = unique(items.map((x) => x.task)).sort((a, b) => a - b);
  const body = ['# Fix batch', '', 'Findings that the task reviews moved to one round of fixes after the last task. Each item: the finding as its review wrote it, why it is here and the plan of its task (read it for context). Items `T-k/KR-n` are red tests known since task k in test files this sprint changed.', ''];
  for (const x of items) {
    if (x.reason === 'known-red') {
      body.push(`### ${x.id} [${x.severity}] ${x.title}`, `- Red since T-${x.task}; its review accepted it as not caused by that change: ${x.claim}`,
        '- Reason: known-red. The sprint changed this test file, so finish runs it and would stop red. Fix it in this round: a stale test gets corrected, a real defect it shows gets fixed. It is not known red for this round any more.',
        `- Task plan: \`${rel(join(taskDir(root, x.task), 'brief.md'))}\``, `- Source: \`${rel(join(root, x.review))}\``, '');
      continue;
    }
    const src = join(root, x.review);
    const sec = existsSync(src) ? findingSection(read(src), x.finding) : null;
    const rest = sec ? sec.split(/\r?\n/).slice(1).join('\n').trim() : '';
    body.push(`### ${x.id} [${x.severity ?? 'minor'}] ${x.title}`, ...(rest ? [rest] : []),
      `- Reason: ${x.reason}${x.visible ? ' (visible to the user)' : ''}`, `- Task plan: \`${rel(join(taskDir(root, x.task), 'brief.md'))}\``, `- Review: \`${rel(src)}\``, '');
  }
  const dir = join(root, 'batch');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'batch.md');
  writeFileSync(file, withHeader({ schema: 'dwmt/batch@1', run: run.run, items: items.map((x) => x.id), tasks: tasks.map((k) => `T-${k}`) }, `\n${body.join('\n')}`));
  return fwd(file);
}

// Zadania z pozycjami w kolejności zadań.
const ownerTasks = (run, filter = () => true) => unique(asList(run.batch?.items).filter(filter).map((x) => x.task)).sort((a, b) => a - b);

// verify rundy zbiorczej: suma bieżących komend `verify` zadań pozycji (bez powtórzeń, w kolejności zadań).
export const batchVerify = (root, run) => unique(ownerTasks(run).flatMap((k) => asList(tryHeader(join(taskDir(root, k), 'brief.md'))?.verify)));

// Ryzyka `ui` zadań, których pozycje pochodzą z jednostek `ui` (identyfikatory z przedrostkiem zadania).
export const batchUiRisks = (root, run, uiRisks) => ownerTasks(run, (x) => x.ui).flatMap((k) => {
  const f = join(taskDir(root, k), 'brief.md');
  return existsSync(f) ? uiRisks(read(f)).map((r) => ({ ...r, id: `T-${k}/${r.id}` })) : [];
});

// Wynik pozycji: `open` na liście `fix` (albo `defer`) ostatniej recenzji rundy, bez recenzji albo zamknięta przez skrypt;
// `notReproduced` od fixera; inaczej `resolved`. Gołe `F-n` wskazuje pozycję; niejednoznaczne otwiera wszystkie pasujące.
export function batchItemResults(root, run) {
  const dir = join(root, 'batch');
  const items = asList(run.batch?.items);
  const texts = reviewTexts(dir);
  const last = texts.length ? tryHeader(join(dir, `review-${texts.length}.md`)) : null;
  const open = resolveIds([...asList(last?.fix), ...asList(last?.defer)], items);
  const nr = new Set(resolveIds(resultFiles(dir).flatMap((f) => asList(tryHeader(join(dir, f))?.notReproduced)).map((x) => idOf(str(x))), items).ids);
  const closed = batchClosed(dir, items);
  return items.map((x) => ({
    ...x, result: !last || last.errors || open.ids.includes(x.id) || closed[x.id] ? 'open' : nr.has(x.id) ? 'notReproduced' : 'resolved',
    ...(closed[x.id] ? { closed: closed[x.id] } : {}), ...(open.ambiguous.includes(x.finding) ? { note: `ambiguous id ${x.finding} in the batch review: counted open` } : {}),
  }));
}

// Zadania, którym podział oszczędził rundę poprawek: lista `fix` niepusta, `now` puste, przed ostatnią dozwoloną rundą.
function roundsAvoided(root, run, cfg) {
  let n = 0;
  for (const t of asList(run.tasks)) {
    const dir = taskDir(root, t.k);
    for (let r = 1; existsSync(join(dir, `review-${r}.md`)); r++) {
      const h = tryHeader(join(dir, `review-${r}.md`));
      if (h && asList(h.fix).length && Array.isArray(h.now) && !h.now.length && r < (t.maxRounds ?? cfg?.review?.maxRounds ?? 2)) n++;
    }
  }
  return n;
}

// Miary rundy zbiorczej (§9): pozycje według powodu i wyniku, rundy, uniknięte rundy poprawek, commit, koszt z transkryptów.
export function batchStats(root, run, cfg, cost = true) {
  const items = batchItemResults(root, run);
  if (!items.length) return null;
  const count = (key) => items.reduce((a, x) => ({ ...a, [x[key]]: (a[x[key]] || 0) + 1 }), {});
  const b = run.batch;
  const spent = cost && b.at ? sessionsCost(run.session_ids, undefined, { from: b.at, to: b.committedAt ?? new Date().toISOString() }) : null;
  return {
    items, byReason: count('reason'), byResult: count('result'), rounds: reviewTexts(join(root, 'batch')).length,
    roundsAvoided: roundsAvoided(root, run, cfg), commit: b.commit?.slice(0, 10) ?? null, cost: spent?.total ?? null,
  };
}

// batch/report.md przy commicie rundy zbiorczej: pozycje z wynikiem, commit, rundy.
export function writeBatchReport(top, root, run, cfg) {
  const s = batchStats(root, run, cfg, false);
  const items = s?.items ?? [];
  const cell = (x) => String(x ?? '').replace(/\|/g, '\\|');
  const header = {
    schema: 'dwmt/batch-report@1', run: run.run, commit: s?.commit ?? null, rounds: s?.rounds ?? 0,
    items: items.map((x) => `${x.id} ${x.reason} ${x.result}`), byReason: s?.byReason ?? {}, byResult: s?.byResult ?? {},
  };
  const body = [
    '# Fix batch', '', `Commit: ${header.commit ?? '-'}, rounds: ${header.rounds}.`, '',
    '| Item | Severity | Reason | Result | Title |', '|---|---|---|---|---|',
    ...items.map((x) => `| ${x.id} | ${x.severity ?? '-'} | ${x.reason} | ${x.result} | ${cell([x.title, x.closed, x.note].filter(Boolean).join('; '))} |`), '',
  ];
  const file = join(root, 'batch', 'report.md');
  mkdirSync(join(root, 'batch'), { recursive: true });
  writeFileSync(file, withHeader(header, `\n${body.join('\n')}`));
  return fwd(file);
}
