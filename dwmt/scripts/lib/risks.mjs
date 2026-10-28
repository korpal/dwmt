// dwmt: ryzyka, walidacja briefu i planu, zadania, jednostki i scalanie recenzji (D1).
import { asList } from './util.mjs';
import { splitHeader, parseYaml, withHeader, normalizeLists, section } from './headers.mjs';
import { globToRegExp } from './text.mjs';

// ---------- ryzyka, pytania, jednostki recenzji (D1, docs/weryfikacja-od-ryzyk.md) ----------

export const WEIGHTS = ['critical', 'high', 'medium', 'low'];
export const METHODS = ['guard', 'test', 'investigate', 'human', 'accepted', 'ui'];
const clean = (s) => String(s ?? '').replace(/[`*]/g, '').trim();

// `### R-n [waga] <niezmiennik>` z liniami `Method: <metoda> …` i `Area: <obszar>` w sekcji `## Risks`.
// Metoda `ui` (X7) ma dodatkowo `Mockup: <html|png>`, opcjonalnie `Mockup-state: <JS>` i `Shot: <nazwa zrzutu>`.
export function parseRisks(text) {
  const sec = section(text, 'Risks');
  if (!sec) return [];
  const out = [];
  const field = (block, name) => new RegExp(`^\\s*[-*]?\\s*\\**${name}\\**:\\s*(.*)$`, 'im').exec(block)?.[1];
  for (const block of sec.split(/\r?\n(?=#{2,6}\s+R-\d+\b)/)) {
    const m = /^#{2,6}\s+(R-\d+)\b\s*(?:\[([^\]]*)\])?\s*(.*)$/m.exec(block);
    if (!m) continue;
    const [kind = '', ...detail] = clean(field(block, 'Method')).split(/\s+/);
    const raw = (name) => { const v = field(block, name)?.trim().replace(/^`(.*)`$/, '$1'); return v || null; };
    out.push({
      id: m[1], weight: clean(m[2]).toLowerCase() || null, title: m[3].trim(),
      method: kind.toLowerCase().replace(/[,;.:]$/, '') || null, detail: detail.join(' '),
      area: clean(field(block, 'Area')).split(/[\s,;]/)[0] || null, text: block.trim(),
      mockup: raw('Mockup'), state: raw('Mockup-state'), shot: raw('Shot'),
    });
  }
  return out;
}

// v2.10: komenda `verify` z podstawieniem powłoki albo zmienną środowiska (zepsute `api-check` z `$(…)`
// przeszło z kodem 0); pliki `delete` jako pełne ścieżki (bez globów, `..` i ścieżek bezwzględnych).
// Zmienna (`$VAR`, cmd `%VAR%`) poza apostrofami: `awk '{print $NF}'` i `sed -n '$p'` to tekst, nie zmienna.
const VERIFY_BAD = [[/\$\(/, '$( … )'], [/`/, 'a backtick'], [/\$\{?[A-Za-z_]|%\w+%/, 'an environment variable ($VAR, %VAR%)', true]];
export function verifyCommandErrors(h) {
  const errors = [];
  for (const c of asList(h.verify)) {
    for (const [re, what, unquoted] of VERIFY_BAD) {
      if (re.test(unquoted ? String(c).replace(/'[^']*'/g, "''") : String(c))) errors.push(`verify: „${String(c).slice(0, 80)}” uses ${what}: put complex logic into a script in the repo and call that script`);
    }
  }
  return errors;
}
export function deleteErrors(h) {
  const errors = [];
  if (h.delete != null && !Array.isArray(h.delete)) return ['delete musi być listą pełnych ścieżek plików'];
  for (const d of asList(h.delete)) {
    const s = String(d);
    if (typeof d !== 'string' || !s.trim()) errors.push('delete: pusty wpis');
    else if (/[*?[\]{}]/.test(s)) errors.push(`delete: ${s} to glob; wypisz pliki pełnymi ścieżkami`);
    else if (/^([a-zA-Z]:|[\\/])/.test(s) || s.split(/[\\/]/).includes('..')) errors.push(`delete: ${s} nie jest ścieżką od katalogu głównego repo`);
    else if (s.split(/[\\/]/).some((x) => x === '' || x === '.')) errors.push(`delete: ${s} nie jest pełną ścieżką pliku (bez ., pustych członów i / na końcu)`);
    else if (/^\.(git|dwmt)$/i.test(s.split(/[\\/]/)[0])) errors.push(`delete: ${s} leży w ${s.split(/[\\/]/)[0]}, nie w kodzie repo`);
  }
  return errors;
}

export function briefErrors(text, h, cfg = null, { strictVerify = false } = {}) {
  const errors = [...deleteErrors(h), ...(strictVerify ? verifyCommandErrors(h) : [])];
  const risks = parseRisks(text);
  for (const id of asList(h.risks)) {
    const r = risks.find((x) => x.id === id);
    if (!r) { errors.push(`brak sekcji ${id} w ## Risks`); continue; }
    if (!WEIGHTS.includes(r.weight)) errors.push(`${id}: waga [${r.weight ?? ''}], dozwolone: ${WEIGHTS.join('|')}`);
    if (!METHODS.includes(r.method)) errors.push(`${id}: Method ${r.method ?? '(brak)'}, dozwolone: ${METHODS.join('|')}`);
    if (r.method === 'ui') {
      if (cfg && !cfg.ui) errors.push(`${id}: Method ui wymaga klucza ui w .claude/dwmt.json; bez niego użyj human`);
      if (!r.mockup || !r.shot) errors.push(`${id}: Method ui wymaga linii Mockup i Shot`);
    }
  }
  for (const id of asList(h.questions)) if (section(text, id) === null) errors.push(`brak sekcji ${id}`);
  if (h.areas != null && (typeof h.areas !== 'object' || Array.isArray(h.areas))) errors.push('areas musi być mapą: nazwa → lista globów');
  return errors;
}

export const answeredIds = (text) => [...String(text).matchAll(/^#{1,6}\s+(Q-\d+)\b/gm)].map((m) => m[1]);

// Sekcja o dokładnym tytule (`## UAT`, `## Tasks`): `section` szuka słowa w dowolnym nagłówku, a Q-n bywa o UAT.
export function namedSection(text, title) {
  const src = String(text);
  const m = new RegExp(`^#{1,6}\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*\\r?$`, 'mi').exec(src);
  if (!m) return null;
  const lines = src.slice(m.index).split(/\r?\n/);
  const level = /^(#+)/.exec(lines[0])[1].length;
  let end = lines.length;
  let fence = false;
  for (let i = 1; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    else if (!fence && /^(#{1,6})\s/.test(lines[i]) && /^(#+)/.exec(lines[i])[1].length <= level) { end = i; break; }
  }
  return lines.slice(0, end).join('\n').trimEnd();
}
export const sectionBody = (sec) => (sec ? sec.split(/\r?\n/).slice(1).join('\n').trim() : null);
export const acIds = (s) => [...String(s ?? '').matchAll(/\bAC-\d+\b/g)].map((m) => m[0]);
export const idOf = (s) => String(s).split(/\s/)[0];

// Zadania planu sprintu: `### T-k <tytuł>` w `## Tasks` z liniami Goal, Acceptance, Scope, Contracts, Depends.
export function parseTasks(text) {
  const sec = namedSection(text, 'Tasks');
  if (!sec) return [];
  const field = (block, name) => new RegExp(`^\\s*[-*]?\\s*\\**${name}\\**:\\s*(.*)$`, 'im').exec(block)?.[1]?.trim() ?? null;
  const out = [];
  for (const block of sec.split(/\r?\n(?=#{2,6}\s+T-\d+\b)/)) {
    const m = /^#{2,6}\s+(T-\d+)\b\s*(.*)$/m.exec(block);
    if (!m) continue;
    const acc = field(block, 'Acceptance');
    out.push({
      id: m[1], k: Number(m[1].slice(2)), title: clean(m[2]), goal: field(block, 'Goal'), acceptance: acc, ac: acIds(acc),
      scope: field(block, 'Scope'), contracts: [...String(field(block, 'Contracts') ?? '').matchAll(/\bC-\d+\b/g)].map((x) => x[0]), text: block.trim(),
    });
  }
  return out;
}

// Scenariusz UAT (§5.11): treść `## UAT`; „UAT: none” = sprint bez zmian widocznych dla użytkownika.
export const uatScenario = (text) => sectionBody(namedSection(text, 'UAT'));
export const uatNone = (body) => /^\s*(?:[-*]\s*)?(?:UAT:\s*)?(?:none|brak)\b/i.test(String(body ?? ''));

// K5 D-4 (rules 2.12): every `## UAT` step names what the human checks: `(R-n)` inside a `### T-k` group (or in a task
// plan without a sprint plan, `single` = its k), `(T-k/R-n)` anywhere, both naming a risk of that task with method
// `human` or `ui`, or `(AC-n)` naming a sprint criterion whose text has `[human]`. "UAT: none" is valid.
// `risks`: {k: parseRisks(task plan)}; `criteria`: acceptance strings. → error lines (English, they go to the architect).
const UAT_STEP = /^\s*(?:\d+[.)]|[-*])\s+\S/;
const UAT_REF = /\(\s*(?:(?:(T-\d+)\/)?(R-\d+)|(AC-\d+))\s*\)\s*[.!]?\s*$/;
export const stripUatRef = (line) => String(line).replace(/\s*\(\s*(?:(?:T-\d+\/)?R-\d+|AC-\d+)\s*\)(\s*[.!]?\s*)$/, '$1');
export function uatRefErrors(body, { risks = {}, criteria = [], single = null } = {}) {
  if (body == null || uatNone(body)) return [];
  const errors = [];
  let group = single;
  const human = new Set(asList(criteria).map(String).filter((c) => /\[human\]/i.test(c)).map((c) => c.split(/\s/)[0]));
  for (const line of String(body).split(/\r?\n/)) {
    const g = /^#{2,6}\s+T-(\d+)\b/.exec(line);
    if (g) { group = Number(g[1]); continue; }
    if (!UAT_STEP.test(line)) continue;
    const step = line.trim().slice(0, 80);
    const m = UAT_REF.exec(line);
    if (!m) { errors.push(`UAT step "${step}" ends without (R-n), (T-k/R-n) or (AC-n): name the human or ui risk, or the [human] criterion, it checks`); continue; }
    if (m[3]) {
      if (!human.has(m[3])) errors.push(`UAT step "${step}": ${m[3]} is not a sprint criterion marked [human]`);
      continue;
    }
    const k = m[1] ? Number(m[1].slice(2)) : group;
    if (k == null) { errors.push(`UAT step "${step}": (${m[2]}) outside a ### T-k group: write (T-k/${m[2]})`); continue; }
    const r = asList(risks[k]).find((x) => x.id === m[2]);
    if (!r) errors.push(`UAT step "${step}": T-${k} has no risk ${m[2]}`);
    else if (!['human', 'ui'].includes(r.method)) errors.push(`UAT step "${step}": T-${k}/${m[2]} has method ${r.method ?? '(none)'}; a UAT step checks a human or ui risk only (a test, guard, investigate or accepted risk needs no human)`);
  }
  return errors;
}

// Walidacja planu (§5.9). Przy otwartych pytaniach tylko ich sekcje; potem zadania, pokrycie AC sprintu i UAT.
export function planErrors(text, h) {
  const errors = [];
  for (const id of asList(h.questions)) if (section(text, id) === null) errors.push(`brak sekcji ${id}`);
  if (asList(h.questions).length) return errors;
  const tasks = parseTasks(text);
  const ids = asList(h.tasks).map(String);
  if (!ids.length) errors.push('tasks: lista zadań jest pusta');
  ids.forEach((id, i) => {
    if (id !== `T-${i + 1}`) errors.push(`tasks: oczekiwano T-${i + 1}, jest ${id} (zadania numerowane po kolei)`);
    const t = tasks.find((x) => x.id === id);
    if (!t) errors.push(`brak sekcji ### ${id} w ## Tasks`);
    else if (!t.ac.length) errors.push(`${id}: brak linii Acceptance z AC-n`);
  });
  for (const ac of asList(h.acceptance).map(idOf)) if (!tasks.some((t) => ids.includes(t.id) && t.ac.includes(ac))) errors.push(`${ac} nie ma zadania (Acceptance w ### T-k)`);
  if (uatScenario(text) === null) errors.push('brak sekcji ## UAT (scenariusz po zadaniach albo „UAT: none”)');
  return errors;
}

// Jedna jednostka, dopóki szacunek kontekstu mieści się w budżecie; potem obszary z briefu łączone zachłannie.
// Ryzyko `critical` dostaje dodatkową jednostkę „drugie spojrzenie” na swój obszar.
export function planUnits({ files, sizes = {}, areas = {}, risks = [], budgetK = 150, secondLook = true }) {
  const names = Object.keys(areas || {});
  const areaOf = (f) => names.find((n) => asList(areas[n]).some((g) => globToRegExp(g).test(f))) ?? 'rest';
  const groups = new Map();
  for (const f of files) { const a = areaOf(f); if (!groups.has(a)) groups.set(a, []); groups.get(a).push(f); }
  const tokens = (fs) => fs.reduce((s, f) => s + (sizes[f] || 0), 0) / 4;
  const budget = budgetK * 1000;
  let units;
  if (tokens(files) <= budget || groups.size < 2) units = [{ name: 'all', areas: [...groups.keys()], files: [...files] }];
  else {
    units = [];
    let cur = null;
    for (const a of [...names, 'rest'].filter((n) => groups.has(n))) {
      const t = tokens(groups.get(a));
      if (cur && cur.t + t <= budget) { cur.areas.push(a); cur.files.push(...groups.get(a)); cur.t += t; }
      else { cur = { areas: [a], files: [...groups.get(a)], t }; units.push(cur); }
    }
    units = units.map(({ areas: as, files: fs }) => ({ name: as.join('+'), areas: as, files: fs }));
  }
  const unitOf = (r) => units.find((u) => u.areas.includes(r.area ?? 'rest')) ?? units[0];
  for (const u of units) u.risks = risks.filter((r) => unitOf(r) === u).map((r) => r.id);
  if (secondLook) {
    const byArea = new Map();
    for (const r of risks.filter((x) => x.weight === 'critical')) {
      const a = r.area ?? 'rest';
      if (!byArea.has(a)) byArea.set(a, []);
      byArea.get(a).push(r.id);
    }
    for (const [a, ids] of byArea) {
      const fs = groups.get(a) ?? unitOf({ area: a }).files;
      units.push({ name: `${a} (second look)`, areas: [a], files: [...fs], risks: ids, secondLook: true });
    }
  }
  return units.map((u, i) => ({ id: i + 1, ...u }));
}

// Diff podzielony na pliki (D2): rozmiar recenzji liczymy z patcha, nie z całych plików
// (sprint 3: openapi.json 337 KB przy hunku 7 KB dał 368k „tokenów” przy diffie 75k).
export function splitPatch(text) {
  return String(text).split(/^(?=diff --git )/m).filter((p) => p.startsWith('diff --git ')).map((p) => {
    const plus = /^\+\+\+ b\/(.+)$/m.exec(p)?.[1];
    const renamed = /^rename to (.+)$/m.exec(p)?.[1];
    const minus = /^--- a\/(.+)$/m.exec(p)?.[1];
    const head = /^diff --git a\/(.+) b\/(.+)$/m.exec(p)?.[2];
    return { file: String(plus ?? renamed ?? minus ?? head ?? '').replace(/\t$/, ''), text: p };
  });
}

// Najwyższy numer F-n w tekście recenzji: nowe uwagi rechecku numerujemy dalej.
// `T-k/F-n` (pozycje rundy zbiorczej, v2.8) to identyfikatory uwag zadań: nie liczą się ani nie są przenumerowywane.
export const maxFinding = (text) => Math.max(0, ...[...String(text).matchAll(/(?<!\/)\bF-(\d+)\b/g)].map((m) => Number(m[1])));

// Uwagi F-n (nagłówki ### F-n) w sekcjach `# Unit <name>` scalonej recenzji.
export function unitFindings(text) {
  const out = {};
  const parts = String(text).split(/^# Unit (.+)$/m);
  // `T-k/F-n`: pozycje rundy zbiorczej (v2.8) w recenzji jej jednostek.
  for (let i = 1; i < parts.length; i += 2) out[parts[i].trim()] = [...parts[i + 1].matchAll(/^#{2,6}\s+[*`]*((?:T-\d+\/)?F-\d+)\b/gm)].map((m) => m[1]);
  return out;
}

// Najgorszy status na identyfikator (AC-n, R-n): przy podziale każda jednostka widzi tylko część zmiany.
// Status bez rozstrzygnięcia („not checked here”, „human”) ustępuje każdemu rozstrzygnięciu.
export const rank = (s) => (/\b(not met|unmet|fail\w*|unproven|open|missing)\b/i.test(s) ? 0 : /\bpartial\b/i.test(s) ? 1 : /\b(met|proven|resolved)\b/i.test(s) ? 2 : 3);
// Przegląd 2026-10-09 (W-6): wśród spełnionych gołe `met` (dopisek tylko w nawiasie albo po dwukropku) wygrywa z `met`
// z zastrzeżeniem o obszarze jednostki („AC-7 met in the backend” obok „AC-7 met” z frontendu, phase-5); „pending UAT”
// zostaje zawsze (dowód tylko u człowieka).
export const PENDING_UAT = /\bpending UAT\b/i;
const plainMet = (s) => /^\S+\s+(met|proven|resolved)\s*(?:$|[(:])/i.test(s);
const metPref = (s) => (PENDING_UAT.test(s) ? 3 : plainMet(s) ? 2 : 1);
export function worstById(lists) {
  const by = new Map();
  for (const s of lists.flat().filter((x) => x != null).map(String)) {
    const id = s.split(/\s/)[0];
    const cur = by.get(id);
    if (!by.has(id) || rank(s) < rank(cur) || (rank(s) === 2 && rank(cur) === 2 && metPref(s) > metPref(cur))) by.set(id, s);
  }
  return [...by.values()];
}

// Scalenie recenzji jednostek: F-n numerowane dalej w kolejności jednostek, liczniki sumowane, najgorszy status.
// `base` (recheck, D2): identyfikatory ≤ base to uwagi poprzedniej rundy i zostają bez zmian.
export function mergeReviews(units, base = 0) {
  let offset = 0;
  const hs = [];
  const parts = [];
  for (const u of units) {
    const nums = [...u.text.matchAll(/(?<!\/)\bF-(\d+)\b/g)].map((m) => Number(m[1])).filter((n) => n > base);
    const text = u.text.replace(/(?<!\/)\bF-(\d+)\b/g, (m, n) => (Number(n) > base ? `F-${Number(n) + offset}` : m));
    offset += nums.length ? Math.max(...nums) - base : 0;
    const s = splitHeader(text);
    hs.push(normalizeLists(parseYaml(s.yaml)));
    parts.push(`# Unit ${u.name}`, '', s.body.trim(), '');
  }
  const cat = (k) => hs.flatMap((h) => asList(h[k]));
  const counts = {};
  for (const h of hs) for (const [k, v] of Object.entries(h.counts || {})) counts[k] = (counts[k] || 0) + (Number(v) || 0);
  const fix = cat('fix');
  return withHeader({
    schema: 'dwmt/review@1', round: hs[0]?.round ?? 1, passes: [...new Set(cat('passes'))], verdict: fix.length ? 'FIX' : 'PASS', counts,
    fix, defer: cat('defer'), drop: cat('drop'), ...(hs.some((h) => h.visible != null) ? { visible: cat('visible') } : {}), acceptance: worstById(hs.map((h) => asList(h.acceptance))),
    // Weryfikator UI podaje w `risks` tytuły par, a wynik w `proven` (sprint 3 cz. 2: raport miał „ui unit (shot written)”).
    risks: worstById(hs.map((h) => asList(h.proven ?? h.risks))), missed: cat('missed'), units: units.map((u) => u.name),
  }, `\n${parts.join('\n')}`);
}
