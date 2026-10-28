// dwmt: czy zależność sprintu (`after`) jest scalona i w jakim stanie jest sprint w roadmapie. Jedna odpowiedź dla pętli
// supervisora, sterownika (`dwmt state`) i podglądu na żywo. Zgłoszenie z 2026-10-16 (pkt 12): pętla widziała pozycję
// zlecenia `done` (scaloną poza zleceniem), a sterownik czytał tylko plik statusu, którego nie było; ok. 450 startów
// z `planned` bez postępu.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { read, asList } from './util.mjs';
import { readSup } from './supervisor-loop.mjs';
import { loadConfig } from './config.mjs';
import { productConfig } from './product-config.mjs';
import { paths, loadRoadmap, loadIndex } from './product-store.mjs';
import { workplaceOf } from './workplace.mjs';

const statusOf = (main, id) => { try { return JSON.parse(read(join(main, '.dwmt', 'supervisor', 'status', `${id}.json`))); } catch { return null; } };

// Stan sprintu w roadmapie: linia roadmapy (`topic` … `done`), archiwum (`closed`, `dropped`); null bez warstwy produktowej
// albo bez takiego sprintu.
export function roadmapState(main, id) {
  try {
    const pc = productConfig(main, loadConfig(main));
    const P = paths(main, pc);
    if (!existsSync(P.dir)) return null;
    const l = loadRoadmap(P).find((x) => x.id === id);
    if (l) return l.state ?? null;
    const a = loadIndex(P).find((x) => x.id === id);
    return a ? (a.merged === 'dropped' ? 'dropped' : 'closed') : null;
  } catch { return null; }
}

// Sprint scalony do celu przez przebieg w głównym drzewie (kopia przebiegu po finish).
function squashedRun(main, id) {
  const base = join(main, '.dwmt', 'runs');
  let ids = [];
  try { ids = readdirSync(base); } catch { return null; }
  for (const r of ids) {
    try {
      const run = JSON.parse(read(join(base, r, 'run.json')));
      if ((run.sprint === id || run.spec === id) && run.finish?.status === 'squashed') return r;
    } catch { /* inny katalog */ }
  }
  return null;
}

// Zależność scalona → {merged, via, state}. Pozycja tego samego zlecenia rozstrzyga sama (`done` = scalona; plik statusu
// `done` jej bieżącego przebiegu też, gdy pętla jeszcze go nie odczytała). Poza zleceniem po kolei: plik statusu,
// przebieg ze squashem w głównym drzewie, sprint `done`/`closed` w roadmapie. Nic nie wiadomo = niescalona.
// `sup`: stan zlecenia w pamięci (pętla pod blokadą); bez niego odczyt `supervisor.json`.
export function depMerged(main, id, { sup = undefined } = {}) {
  const order = sup === undefined ? readSup(main) : sup;
  const it = order?.items?.find((x) => x.id === id);
  const st = statusOf(main, id);
  if (it) {
    if (it.state === 'done') return { merged: true, via: 'order', state: 'done' };
    if (st?.state === 'done' && it.run && st.run === it.run) return { merged: true, via: 'status', state: 'done' };
    return { merged: false, via: 'order', state: it.state ?? null };
  }
  if (st) return { merged: st.state === 'done', via: 'status', state: st.state ?? null };
  if (squashedRun(main, id)) return { merged: true, via: 'run', state: 'squashed' };
  const rs = roadmapState(main, id);
  if (rs) return { merged: ['done', 'closed'].includes(rs), via: 'roadmap', state: rs };
  return { merged: false, via: null, state: null };
}

// Zależności `after` jeszcze niescalone.
export const unmergedDeps = (main, ids, opts = {}) => (Array.isArray(ids) ? ids : []).filter((id) => !depMerged(main, id, opts).merged);

// ---------- kf2: zależności i kolejność startu z bieżącej roadmapy (D-1 … D-4) ----------

const offRoadmap = (it) => ['file', 'fix'].includes(it?.src);

// Linie roadmapy głównego drzewa w kolejności wierszy; null bez warstwy produktowej albo gdy odczyt się nie udał.
export function roadmapLines(main) {
  try {
    const pc = productConfig(main, loadConfig(main));
    const P = paths(main, pc);
    if (!existsSync(P.dir)) return null;
    return loadRoadmap(P);
  } catch { return null; }
}

// Bieżące zależności pozycji zlecenia (C-1): `after` jej linii roadmapy, przy `seq` także najbliższa wyżej w roadmapie
// pozycja zlecenia (D-2). Bez linii, bez roadmapy, plik (`--file`) i poprawki: lista zapisana (D-1, D-3). Nie rzuca.
// K7 (D-6): sprint miejsca pracy zależy też od najbliższego wyżej w roadmapie wiersza tego samego miejsca pracy (jeden tor
// na gałąź docelową). K7 (D-18): `overrides.after` (`supervise resume <id> --now`) = żadnych zależności, dla pętli
// i sterownika (`runDepsNow`) jednakowo.
export function currentAfter(main, item, { sup = undefined, lines = undefined } = {}) {
  if (item?.overrides?.after) return [];
  const stored = asList(item?.after);
  try {
    const ls = lines === undefined ? roadmapLines(main) : lines;
    if (!Array.isArray(ls) || offRoadmap(item)) return [...stored];
    const row = ls.findIndex((l) => l.id === item.id);
    if (row < 0) return [...stored];
    const now = [...asList(ls[row].after)];
    if (item.seq) {
      const order = sup === undefined ? readSup(main) : sup;
      let best = -1;
      for (const o of asList(order?.items)) {
        if (o.id === item.id) continue;
        const i = ls.findIndex((l) => l.id === o.id);
        if (i >= 0 && i < row && i > best) best = i;
      }
      if (best >= 0 && !now.includes(ls[best].id)) now.push(ls[best].id);
    }
    const wp = workplaceOf(main, item.id);
    if (wp) {
      const mine = new Set(asList(wp.sprints));
      for (let i = row - 1; i >= 0; i--) {
        if (!mine.has(ls[i]?.id)) continue;
        if (!now.includes(ls[i].id)) now.push(ls[i].id);
        break;
      }
    }
    return now;
  } catch { return [...stored]; }
}

// Priorytet startu (D-4): pozycje z linią roadmapy w kolejności wierszy, na swoich miejscach listy; reszta bez zmian.
export function orderByRoadmap(items, lines) {
  const list = [...asList(items)];
  if (!Array.isArray(lines)) return list;
  const rowOf = new Map(lines.map((l, i) => [l.id, i]));
  const slots = [];
  list.forEach((it, i) => { if (!offRoadmap(it) && rowOf.has(it.id)) slots.push(i); });
  const sorted = slots.map((i) => list[i]).sort((a, b) => rowOf.get(a.id) - rowOf.get(b.id));
  slots.forEach((i, k) => { list[i] = sorted[k]; });
  return list;
}

const orderOf = (main, sup) => { try { return sup === undefined ? readSup(main) : sup; } catch { return null; } };

// Bieżące zależności przebiegu (C-1, strona przebiegu T-2): pozycja zlecenia `run.sprint`, inaczej własne `after`.
export function runAfter(main, run, { sup = undefined } = {}) {
  try {
    const order = orderOf(main, sup);
    const it = asList(order?.items).find((x) => x.id === run?.sprint);
    return it ? currentAfter(main, it, { sup: order }) : [...asList(run?.after)];
  } catch { return [...asList(run?.after)]; }
}

// Kolejność zlecenia w priorytecie startu (D-4), gdy zlecenie ma pozycję `run.sprint`; inaczej własne `order`.
export function runOrder(main, run, { sup = undefined } = {}) {
  try {
    const order = orderOf(main, sup);
    if (!asList(order?.items).some((x) => x.id === run?.sprint)) return [...asList(run?.order)];
    return orderByRoadmap(order.items, roadmapLines(main)).map((x) => x.id);
  } catch { return [...asList(run?.order)]; }
}

// Pierwsze zadanie przebiegu ruszyło (C-2, strona przebiegu): zadanie > 1, start zadania 1 w dzienniku (`startEvent`)
// albo wykonawca zadania 1 ruszył (`started`). Od tej chwili przebieg nie czyta zlecenia (D-9). Nie rzuca.
export function firstTaskStarted(run) {
  try {
    if (Number(run?.task) > 1) return true;
    const t1 = asList(run?.tasks)[0];
    return Boolean(t1?.startEvent) || Object.keys(t1?.started || {}).length > 0;
  } catch { return false; }
}

// Co przebieg używa teraz (D-6, D-9): przed pierwszym zadaniem bieżące zależności i kolejność ze zlecenia,
// potem własne `after` i `order` z run.json. Jedna definicja dla sterownika, architekta i podglądu.
export function runDepsNow(main, run, { sup = undefined } = {}) {
  if (firstTaskStarted(run)) return { after: [...asList(run?.after)], order: [...asList(run?.order)] };
  return { after: runAfter(main, run, { sup }), order: runOrder(main, run, { sup }) };
}
