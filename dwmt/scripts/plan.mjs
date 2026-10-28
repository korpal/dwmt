// dwmt: planowanie v2.7 (specyfikacja-dwmt.md §5.2, §5.8–§5.10): architekt zamiast planistów.
// Profile walidacji planu sprintu i planów zadań, kotwice `ścieżka#Symbol` wobec bazy zadania, numery linii i skróty
// ścieżek (Z11), pokrycie wejścia, nakładanie zakresów, przyczyny rozjazdu przed zadaniem k, stany architekta
// (plan, replan) i kontroli celu, kopia odpowiedzi eksploratorów do explore/ i sizes.txt.
// Import z dwmt.mjs tworzy cykl ES (jak uat.mjs); żadna funkcja stąd nie jest używana na poziomie modułu, więc cykl jest bezpieczny.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  git, globToRegExp, namedSection, section, parseTasks, planErrors, briefErrors, parseRisks, acIds, parseYaml, splitHeader,
  validateHeader, normalizeLists, withHeader, slugify, taskDir, taskCtx, bullets, tryHeader, tryTaskBrief, isMet, questionState,
  planEnv, sprintExtras, planInfo, deleteErrors, answeredIds,
} from './dwmt.mjs';
import { PRICE_Q, priceTurn, priceQuestion, productArchitectLines } from './lib/price-gate.mjs';
import { intermediateLimit } from './lib/plan-state.mjs';
import { runHome } from './lib/run.mjs';
import { runDepsNow } from './lib/deps.mjs';
import { isTestPath } from './lib/verify-select.mjs';
import { uatRefErrors, uatScenario, sectionBody } from './lib/risks.mjs';
// D (noc 2026-10-05): tryb pośredni (`init --mode intermediate`: single z etykietą) z jednym zadaniem i jedną recenzją;
// eksploratorzy jak w `single`, według obszaru (przegląd sprintu 16 (UI)).
export const isIntermediate = (run) => run?.modeLabel === 'intermediate';

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fwd = (p) => String(p).replace(/\\/g, '/');
const read = (f) => readFileSync(f, 'utf8');
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const idOf = (s) => String(s).split(/\s/)[0];
const sessionId = () => process.env.CLAUDE_CODE_SESSION_ID || null;
const body = (sec) => (sec == null ? null : sec.split(/\r?\n/).slice(1).join('\n').trim());
const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const short = (s, n = 70) => { const t = squash(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const sha8 = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 8);
const unique = (xs) => [...new Set(xs)];
const REF = (n) => fwd(join(PLUGIN, 'templates', 'reference', n));
const TPL = (n) => fwd(join(PLUGIN, 'templates', 'artifacts', n));

export const RULES = '2.12';
export const ARCHITECT = 'dwmt-architect';
// Przebieg rozpoczęty w v2.7 albo później (`init` zapisuje `rules`); bez pola to przebieg v2.6 z regułami v2.6 do końca (§5.9).
// Porównanie wersji reguł jako liczb całkowitych major.minor („2.10” > „2.9”); brak pola = 0.0 (v2.6).
export function rulesAtLeast(run, min) {
  const v = (s) => { const m = /^(\d+)\.(\d+)$/.exec(String(s ?? '').trim()); return m ? [Number(m[1]), Number(m[2])] : [0, 0]; };
  const [a, b] = v(run?.rules);
  const [x, y] = v(min);
  return a > x || (a === x && b >= y);
}
export const is27 = (run) => rulesAtLeast(run, '2.7');
// v2.8 (runda zbiorcza, replan od k do końca, artefakty po angielsku, ścieżki względne): tylko przebiegi z `rules: 2.8`;
// przebieg 2.7 kończy się regułami 2.7 (jak przejście 2.6 → 2.7).
export const is28 = (run) => rulesAtLeast(run, '2.8');
// v2.9 (po sprintach 6+7): uwagi `info` idą do wykonawcy zamiast do replanu, `[plan]` wyzwala replan; `(C-n)` w zmianie kontraktu
// to zmiana z planu; testy czerwone z góry (`expectedRed`, `unrelatedRed` wyniku) bez naprawy.
export const is29 = (run) => rulesAtLeast(run, '2.9');
// v2.10: komendy `verify` bez `$(`, odwrotnych apostrofów i `$ZMIENNA`, pliki do usunięcia w nagłówku `delete` za zgodą
// użytkownika (bramka `ask-delete`), recenzent `high` dla zmian bez kodu.
export const is210 = (run) => rulesAtLeast(run, '2.10');
// v2.11 (K4, opcja B): plan zadania jako szkielet projektu: limit rozmiaru, krótkie punkty zmian, przypadki testowe z wartościami,
// bez bloków kodu, decyzje i kontrakty sprintu jako same nagłówki, kryteria po identyfikatorze (resolver `entityText`).
export const is211 = (run) => rulesAtLeast(run, '2.11');
// v2.12 (K5): UAT steps name what the human checks, plain summary, one status word per criterion, ids with titles in the
// report body, UAT pending only when a human has something to do (D-4, D-6, D-13..D-16).
export const is212 = (run) => rulesAtLeast(run, '2.12');

// v2.8 (E): ścieżki w promptach agentów względem katalogu głównego repo (katalog roboczy agentów), katalog nazwany raz;
// przebiegi sprzed v2.8 i ścieżki poza repo (szablony pluginu) zostają pełne.
export function pathsFor(run, top) {
  const on = is28(run);
  const rel = (f) => {
    const r = fwd(relative(top, f));
    return on && r && !r.startsWith('..') && !isAbsolute(r) ? r : fwd(f);
  };
  return { rel, root: on ? `Repo root: ${fwd(top)}. ` : '' };
}
export const artifactsLang = (run) => (is28(run) ? 'Artifacts: English. ' : '');
// Katalog główny repo z katalogu przebiegu `<top>/.dwmt/runs/<id>`.
export const topOfRoot = (root) => resolve(root, '..', '..', '..');

// ---------- plan sprintu (profil architekta) ----------

// `Depends: none` albo `T-1, T-3`; zakres `T-1…T-4` (także `..`, `–`) to wszystkie zadania pomiędzy (prototyp architekta pisał zakresy).
export function taskDepends(block) {
  const raw = /^\s*[-*]?\s*\**Depends\**:\s*(.*)$/im.exec(String(block ?? ''))?.[1];
  if (raw == null) return null;
  const v = raw.replace(/[`*]/g, '').trim();
  if (/^(none|brak|nie|-|—)?\.?$/i.test(v)) return { raw, ids: [], bad: false };
  const ids = new Set();
  const rest = v.replace(/T-(\d+)\s*(?:…|\.{2,3}|–|—|-)\s*T-(\d+)/g, (m, a, b) => { for (let i = Number(a); i <= Number(b); i++) ids.add(i); return ' '; });
  for (const m of rest.matchAll(/\bT-(\d+)\b/g)) ids.add(Number(m[1]));
  return { raw, ids: [...ids].sort((a, b) => a - b), bad: !ids.size };
}

// Pokrycie wejścia (§5.2): każdy punkt wskazuje istniejące AC-n albo `out: <powód>` (część po strzałce, gdy jest).
export function inputCoverageErrors(text, h) {
  const sec = namedSection(text, 'Input coverage');
  if (sec === null) return ['brak sekcji ## Input coverage (każdy element wejścia → AC-n albo out: <powód>)'];
  const items = bullets(body(sec) ?? '');
  if (!items.length) return ['## Input coverage bez punktów (każdy element wejścia → AC-n albo out: <powód>)'];
  const known = asList(h.acceptance).map(idOf);
  const errors = [];
  for (const item of items) {
    const arrow = Math.max(item.lastIndexOf('→'), item.lastIndexOf('->'));
    const target = arrow >= 0 ? item.slice(arrow) : item;
    const acs = acIds(target);
    const unknown = acs.filter((a) => !known.includes(a));
    if (unknown.length) errors.push(`Input coverage: „${short(item)}” wskazuje ${unknown.join(', ')}, których nie ma w acceptance planu`);
    else if (!acs.length && !/\bout\s*:\s*\S/i.test(target)) errors.push(`Input coverage: „${short(item)}” nie ma AC-n ani out: <powód>`);
  }
  return errors;
}

// Walidacja planu sprintu w profilu architekta (§5.9): reguły v2.6, `Depends` każdego zadania, `## Design`,
// niepusty `## UAT` i `## Input coverage`. Przy otwartych pytaniach tylko ich sekcje.
export function sprintPlanErrors(text, h) {
  // v2.10: pliki usuwane w sprincie stoją w nagłówku planu przed pytaniami (zgoda użytkownika w tej samej turze).
  const errors = [...planErrors(text, h), ...deleteErrors(h)];
  if (asList(h.questions).length) return errors;
  const ids = asList(h.tasks).map(String);
  for (const t of parseTasks(text).filter((x) => ids.includes(x.id))) {
    const d = taskDepends(t.text);
    if (!d) errors.push(`${t.id}: brak linii Depends (none albo wcześniejsze T-j)`);
    else if (d.bad) errors.push(`${t.id}: Depends „${short(d.raw, 40)}” nieczytelne (none albo T-j)`);
    else for (const j of d.ids) if (j >= t.k || !ids.includes(`T-${j}`)) errors.push(`${t.id}: Depends T-${j} (tylko wcześniejsze zadania planu)`);
  }
  if (!body(namedSection(text, 'Design'))) errors.push('brak treści ## Design (3–8 linii na poziomie zdolności i granic)');
  if (body(namedSection(text, 'UAT')) === '') errors.push('## UAT jest pusta (scenariusz po zadaniach albo „UAT: none”)');
  errors.push(...inputCoverageErrors(text, h));
  return errors;
}

// ---------- plan zadania: zmiany, kotwice, baza ----------

// Punkty pierwszego poziomu `## Changes` z wierszami kontynuacji (wcięte, także wcięte podpunkty);
// kroki nazwanego wzorca (1., 2.) i inny tekst bez wcięcia kończą punkt.
export function changeItems(text) {
  const sec = namedSection(text, 'Changes');
  if (sec === null) return null;
  const out = [];
  let open = false;
  for (const line of sec.split(/\r?\n/).slice(1)) {
    const m = /^[-*]\s+(.*)$/.exec(line);
    if (m) { out.push(m[1].trim()); open = true; }
    else if (open && /^\s+\S/.test(line)) out[out.length - 1] += ` ${line.trim()}`;
    else if (line.trim()) open = false;
  }
  return out;
}

// Separator opisu: em dash, en dash albo ` - ` (pierwszy w linii).
function firstSeparator(s) {
  const hits = ['—', '–', ' - '].map((sep) => ({ at: s.indexOf(sep), len: sep.length })).filter((x) => x.at >= 0);
  return hits.sort((a, b) => a.at - b.at)[0] ?? null;
}

const KEYWORDS = /(?:^|[\s;.,(])(?:pattern|wzór|wzor|not|nie|test first|check)\s*:/i;
// `[new <pojęcie>] X w <plik> — …; pattern: ścieżka#Symbol; not: …`, `[change] ścieżka#Symbol — …`, `[remove] …`.
// v2.9: `[sweep] \`<glob>\` — <reguła dla każdego trafienia>; check: \`<wzorzec grep>\`` (praca mechaniczna po wielu plikach:
// reguła zamiast listy linii, która starzeje się przed zadaniem; sprinty 6+7: 28 z 45 błędów formatu to zbiorcze punkty).
// Część przed separatorem (i przed `;` albo słowem kluczowym) niesie kotwice; `pattern:`/`wzór:` w dowolnym segmencie.
export function parseChange(item) {
  const m = /^\**\s*\[\s*(new|change|remove|sweep)\b([^\]]*)\]\s*\**\s*(.*)$/i.exec(String(item));
  if (!m) return { kind: null, text: item };
  const rest = m[3];
  const cut = firstSeparator(rest);
  let head = cut ? rest.slice(0, cut.at) : rest;
  const kw = KEYWORDS.exec(head);
  if (kw) head = head.slice(0, kw.index);
  head = head.split(';')[0];
  const patterns = [...rest.matchAll(/(?:^|[\s;.,(])(?:pattern|wzór|wzor)\s*:\s*([^;]*)/gi)].map((x) => x[1]);
  const check = /(?:^|[\s;.,(])check\s*:\s*`([^`]+)`/i.exec(rest)?.[1] ?? null;
  return { kind: m[1].toLowerCase(), term: m[2].trim(), head, patterns, check, text: item };
}

// Punkty `[sweep]` planu zadania: globy i wzorzec sprawdzenia (review-input uruchamia go przed recenzją).
export function sweepItems(text) {
  return (changeItems(text) ?? []).map(parseChange).filter((c) => c.kind === 'sweep')
    .map((c) => ({ globs: anchorTokens(c.head).filter((t) => t.includes('/') || isGlob(t)), check: c.check }));
}

const PUNCT_L = /^[(["'„“«]+/;
const PUNCT_R = /[)\]"'”»,;:.!?]+$/;
// Tokeny kotwic: w backtickach, a bez backticków słowa ze `/` (§5.9).
export function anchorTokens(seg) {
  const ticks = [...String(seg ?? '').matchAll(/`([^`]+)`/g)].map((x) => x[1]);
  const src = ticks.length ? ticks : [String(seg ?? '')];
  return src.flatMap((s) => s.split(/\s+|,(?=\s)/)).map((t) => t.replace(PUNCT_L, '').replace(PUNCT_R, ''))
    .filter((t) => t && (ticks.length || t.includes('/')));
}

const isGlob = (p) => /[*?{[]/.test(p);
const extOf = (p) => /\.[A-Za-z0-9]{1,10}$/.test(p.split('/').pop());
const inScope = (p, scope) => asList(scope).some((g) => globToRegExp(String(g)).test(p));
// Ścieżka to token bez spacji ze `/`, dokładna ścieżka z bazy (także plik w katalogu głównym bez rozszerzenia, np. `Makefile`)
// albo, dla `[new]`, nowy plik z rozszerzeniem w katalogu głównym objęty `scope`. Adnotacja po spacji („docs/adr/1.md (modules)”)
// odpada; `@…`, `/…` i adresy z `://` pomijamy.
export function anchorOf(token, base = null, scope = null) {
  const tok = String(token ?? '').trim().replace(/^`|`$/g, '').split(/\s+/)[0].replace(/`/g, '');
  if (!tok || /^[@/]/.test(tok) || tok.includes('://')) return null;
  // Metody HTTP (`GET/PUT/DELETE`) to nie ścieżka (sprinty 6+7: fałszywy błąd w T-10).
  if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)(\/(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS))*$/.test(tok)) return null;
  const hash = tok.indexOf('#');
  const path = (hash >= 0 ? tok.slice(0, hash) : tok).replace(/^(\.\/)+/, '').replace(PUNCT_R, '');
  const symbol = hash >= 0 ? tok.slice(hash + 1).replace(PUNCT_R, '') || null : null;
  if (!path) return null;
  // Nowy plik w katalogu głównym: z rozszerzeniem w `scope`, a bez rozszerzenia (`Dockerfile`) tylko wymieniony w `scope` dosłownie.
  const newRoot = scope && ((extOf(path) && inScope(path, scope)) || asList(scope).includes(path));
  if (!path.includes('/') && !base?.has(path) && !newRoot) return null;
  return { path, symbol, raw: tok };
}

// Baza zadania (§5.9): pliki HEAD plus lokalizacje `[new …]` wcześniejszych zadań i wcześniejszych linii tego zadania,
// minus pliki usunięte w całości (`[remove]` bez symbolu).
export function makeBase(files) {
  const f = new Set(files);
  const dirs = new Set();
  const addDirs = (p) => { const parts = p.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join('/')}/`); };
  for (const p of f) addDirs(p);
  return {
    files: f, dirs,
    has(p) {
      if (isGlob(p)) { const re = globToRegExp(p); for (const x of f) if (re.test(x)) return true; for (const x of dirs) if (re.test(x)) return true; return false; }
      return f.has(p) || dirs.has(p.endsWith('/') ? p : `${p}/`);
    },
    isDir: (p) => dirs.has(p.endsWith('/') ? p : `${p}/`) && !f.has(p),
    add(p) { if (p.endsWith('/')) { dirs.add(p); addDirs(p.slice(0, -1)); } else { f.add(p); addDirs(p); } },
    remove(p) {
      if (p.endsWith('/')) { for (const x of [...f]) if (x.startsWith(p)) f.delete(x); for (const x of [...dirs]) if (x.startsWith(p)) dirs.delete(x); }
      else f.delete(p);
    },
  };
}

// Lokalizacja `[new]` to plik (szablon: pełna ścieżka pliku). Katalog: końcowy `/`, istniejący katalog albo nowa ścieżka
// bez rozszerzenia, której nazwa nie zaczyna się wielką literą (`Makefile`, `Dockerfile` to pliki).
const newIsDir = (p, base) => p.endsWith('/') || base.isDir(p) || (!extOf(p) && !base.files.has(p) && !/^[A-Z]/.test(p.split('/').pop()));

// Przejście po kotwicach planu zadania w kolejności: read_first, potem linie `## Changes` (baza rośnie o `[new]`
// i traci pliki z `[remove]` w całości). Zwraca listę kotwic z wynikiem i lokalizacje `[new]`.
export function anchorWalk(text, h, base, scope = asList(h.scope)) {
  const out = { anchors: [], news: [], items: changeItems(text), problems: [] };
  for (const e of asList(h.read_first)) {
    const a = anchorOf(e, base);
    if (!a) out.problems.push(`read_first: „${short(e, 50)}” nie jest ścieżką od katalogu głównego repo`);
    else out.anchors.push({ kind: 'read_first', ...a, ok: base.has(a.path) });
  }
  for (const item of out.items ?? []) {
    const c = parseChange(item);
    if (!c.kind) { out.problems.push(`Changes: punkt bez typu [new <pojęcie>] | [change] | [remove] | [sweep]: „${short(item, 60)}”`); continue; }
    if (c.kind === 'new' && !c.term) out.problems.push(`Changes: [new] bez pojęcia ze słownika: „${short(item, 60)}”`);
    if (c.kind !== 'new' && c.term) out.problems.push(`Changes: nieznany typ [${c.kind} ${c.term}]`);
    if (c.kind === 'sweep') {
      // Glob (albo plik) przed opisem i wzorzec `check:` w backtickach; glob musi trafiać w bazę zadania.
      const globs = anchorTokens(c.head).map((t) => anchorOf(t, base)).filter(Boolean);
      if (!globs.length) out.problems.push(`Changes: [sweep] bez globu plików przed opisem: „${short(item, 60)}”`);
      if (!c.check) out.problems.push(`Changes: [sweep] bez check: \`<wzorzec grep>\` (sprawdzenie kompletności): „${short(item, 60)}”`);
      for (const a of globs) out.anchors.push({ kind: 'sweep', ...a, ok: base.has(a.path) });
      continue;
    }
    const heads = anchorTokens(c.head).map((t) => anchorOf(t, base, c.kind === 'new' ? scope : null)).filter(Boolean);
    if (c.kind === 'new') {
      if (!heads.length) out.problems.push(`Changes: [new ${c.term}] bez pełnej ścieżki pliku: „${short(item, 60)}”`);
      for (const a of heads) {
        if (newIsDir(a.path, base)) { out.problems.push(`Changes: [new ${c.term}]: podaj pełną ścieżkę pliku, nie katalog (${a.path})`); continue; }
        out.anchors.push({ kind: 'new', ...a, ok: base.files.has(a.path) || inScope(a.path, scope) });
        out.news.push(a.path);
        base.add(a.path);
      }
    } else {
      if (!heads.length) out.problems.push(`Changes: [${c.kind}] bez kotwicy ścieżka#Symbol przed opisem: „${short(item, 60)}”`);
      for (const a of heads) out.anchors.push({ kind: c.kind, ...a, ok: base.has(a.path) });
      // Plik usunięty w całości znika z bazy: późniejsze `[change]` na nim (to zadanie i następne) nie przejdzie.
      if (c.kind === 'remove') for (const a of heads.filter((x) => !x.symbol)) base.remove(a.path);
    }
    for (const seg of c.patterns) for (const a of anchorTokens(seg).map((t) => anchorOf(t, base)).filter(Boolean)) out.anchors.push({ kind: 'pattern', ...a, ok: base.has(a.path) });
  }
  return out;
}

// Numery linii (Z11): `plik.ext:NN` i „linia/line NN” tuż po ścieżce pliku (`X.java line 42`, `X.java, linia 42`);
// samo „linia 2” to pojęcie domeny. Nie dotyczy `verify`, linii `Method: guard …` ani wyciągów ze standardów.
const LINE_RES = [/\b[\w./-]+\.[A-Za-z]{1,5}:\d+\b/g, /[\w./-]+\.[A-Za-z]{1,5}(?:#[\w.$-]+)?`?\)?,?\s*\(?(?:line|lines|linia|linii|linie|wiersz)\s+\d+/gi];
export const lineNumberHits = (text) => LINE_RES.flatMap((re) => [...String(text).matchAll(re)].map((m) => m[0]));

// Skróty ścieżek (test decyzji: `FB/` = `frontend/src/features/billing/`): definicja, linia „Skrót:”, `...` w ścieżce.
export function shortcutHits(text) {
  const s = String(text);
  const hits = [];
  for (const m of s.matchAll(/(?<![\w./@-])`?([\w.@-]+\/)`?\s*(?::=|=|≡|→)\s*`?[\w.@-]+\/[\w.@/-]*`?/g)) hits.push(`definicja skrótu ${m[1]}`);
  for (const m of s.matchAll(/^\s*(?:[-*]\s*)?\**(skrót|skróty|abbreviations?|shorthand)\**\s*:/gim)) hits.push(`linia „${m[1]}:”`);
  // Adres trasy (`/invoices?id=…`), alias importu (`@/…`) i URL to nie ścieżki repo, jak przy kotwicach.
  for (const t of s.split(/[\s`]+/)) if (t.includes('/') && /\.\.\.|…/.test(t) && !/^["'„(]*[@/]/.test(t) && !t.includes('://')) hits.push(`„${short(t, 40)}”`);
  return unique(hits);
}

// Tekst planu zadania bez `verify` w nagłówku i bez sekcji wyciągów (tam cytaty ze źródłem mogą mieć linie).
function checkedText(text, h) {
  const head = Object.entries(h).filter(([k]) => k !== 'verify').map(([, v]) => JSON.stringify(v)).join('\n');
  const b = splitHeader(text)?.body ?? text;
  const ex = namedSection(b, 'Standards and docs excerpts');
  // Linia `Method: guard <komenda>` to komenda strażnika (jak `verify`): może wskazywać plik testu z linią.
  return `${head}\n${(ex ? b.replace(ex, '') : b).replace(/^\s*[-*]?\s*\**Method\**:\s*`?guard\b.*$/gim, '')}`;
}

// Sekcja, której nagłówek zaczyna się identyfikatorem (`### C-1 …`); inne nagłówki mogą o nim wspominać.
// `shared`: nagłówek zaczyna się innym identyfikatorem tego rodzaju i wymienia szukany (wspólna sekcja „### D-3 i D-4 …”).
function idSection(text, id, { shared = false } = {}) {
  const span = idSpan(text, id, { shared });
  if (span) return span.text;
  return shared ? null : section(String(text), id);
}

// Położenie sekcji z nagłówkiem zaczynającym się identyfikatorem (bez zapasowego `section()`, które łapie dowolny nagłówek
// z identyfikatorem, np. `### R-1 … C-1 …`): {start, end, text} w tekście z LF. Bloki kodu (```) nie kończą sekcji
// (recenzja v2.9: komentarz `# …` w kontrakcie ucinał kopię).
export function idSpan(text, id, { shared = false } = {}) {
  const src = String(text);
  const kind = id.split('-')[0];
  const m = new RegExp(`^#{1,6}\\s+[*\`]*${id}\\b.*$`, 'm').exec(src)
    ?? (shared ? new RegExp(`^#{1,6}\\s+[*\`]*${kind}-\\d+\\b.*\\b${id}\\b.*$`, 'm').exec(src) : null);
  if (!m) return null;
  const lines = src.slice(m.index).split('\n');
  const level = /^(#+)/.exec(lines[0])[1].length;
  let end = lines.length;
  let fence = false;
  for (let i = 1; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    else if (!fence && /^(#{1,6})\s/.test(lines[i]) && /^(#+)/.exec(lines[i])[1].length <= level) { end = i; break; }
  }
  const body = lines.slice(0, end).join('\n').trimEnd();
  return { start: m.index, end: m.index + body.length, text: body.replace(/\r$/gm, '') };
}
const splice = (s, span, repl) => `${s.slice(0, span.start)}${repl}${s.slice(span.end)}`;

// K4 (C-1): jedno źródło na byt planu. `AC-n` z nagłówka planu sprintu (z dopiskiem `(part: …)` planu zadania), bez planu
// sprintu z nagłówka planu zadania (przebieg inline); D-n i C-n z sekcji planu sprintu, gdy ją ma, inaczej z planu zadania;
// R-n i A-n z planu zadania. Zwraca {id, title, text, source: 'plan'|'brief'} albo null.
const headerList = (text, key) => {
  const s = text == null ? null : splitHeader(String(text));
  if (!s) return [];
  try { return asList(normalizeLists(parseYaml(s.yaml))[key]).map(String); } catch { return []; }
};
const acEntry = (text, id) => headerList(text, 'acceptance').find((e) => idOf(e) === id) ?? null;
const acRest = (entry, id) => squash(String(entry).slice(id.length)).replace(/^[:—–-]\s*/, '');
const PART = /^\(part:\s*([\s\S]*)\)$/i;
const sectionEntity = (text, id, source) => {
  if (text == null) return null;
  const span = idSpan(String(text).replace(/\r\n/g, '\n'), id, { shared: id.startsWith('D-') });
  if (!span) return null;
  const head = span.text.split('\n')[0].replace(/^#{1,6}\s+[*`]*/, '');
  const title = head.startsWith(id) ? head.slice(id.length).replace(/^[*`]*\s*/, '').trim() : head.trim();
  return { id, title, text: body(span.text) ?? '', source };
};
export function entityText({ planText = null, briefText = null } = {}, id) {
  const key = String(id ?? '').trim();
  if (/^AC-\d+$/.test(key)) {
    const mine = acEntry(briefText, key);
    const rest = mine ? acRest(mine, key) : '';
    const theirs = acEntry(planText, key);
    if (theirs != null) {
      const t = acRest(theirs, key);
      const part = PART.test(rest) ? rest : '';
      return { id: key, title: t, text: part ? `${t} ${part}` : t, source: 'plan' };
    }
    return mine != null ? { id: key, title: rest, text: rest, source: 'brief' } : null;
  }
  if (/^[DC]-\d+$/.test(key)) {
    const p = sectionEntity(planText, key, 'plan');
    if (p && p.text) return p;
    return sectionEntity(briefText, key, 'brief') ?? p;
  }
  if (/^[RA]-\d+$/.test(key)) return sectionEntity(briefText, key, 'brief');
  return null;
}

// v2.9: wstawienie sekcji `### X-n` na końcu sekcji `## <name>` (albo nowej sekcji przed pierwszą z `before`, inaczej na końcu).
function appendToSection(text, name, block, before) {
  const sec = namedSection(text, name);
  if (sec !== null) return text.replace(sec, () => `${sec.trimEnd()}\n\n${block.trim()}\n`);
  for (const b of before) {
    const m = new RegExp(`^##\\s+${b}\\b.*$`, 'm').exec(text);
    if (m) return `${text.slice(0, m.index)}## ${name}\n${block.trim()}\n\n${text.slice(m.index)}`;
  }
  return `${text.trimEnd()}\n\n## ${name}\n${block.trim()}\n`;
}

// v2.9: jednoznaczny skrót ścieżki (`.../core/api/X.java#y`, `frontend/…/x.ts`) rozwinięty według bazy zadania; null, gdy
// pasuje zero albo więcej niż jedna ścieżka (wtedy zostaje błąd dla architekta).
export function expandShortPath(token, base) {
  const m = /^(.*?)\/?(?:\.\.\.|…)(\/.+)$/.exec(token);
  if (!m) return null;
  const [path, sym] = m[2].split('#');
  const pre = m[1] ? `${m[1].replace(/\/$/, '')}/` : '';
  const pool = path.endsWith('/') ? [...base.dirs] : [...base.files];
  const hits = pool.filter((f) => f.startsWith(pre) && `/${f}`.endsWith(path) && f.length > pre.length + path.length - 1);
  return hits.length === 1 ? `${hits[0]}${sym != null ? `#${sym}` : ''}` : null;
}

// v2.9 (po sprintach 6+7: 45 błędów formatu poprawianych przez architekta przy kontekście 600–730k za 1,78 mln): to, co skrypt
// zrobi sam, robi sam. Kontrakty C-n zadania kopiuje z planu sprintu (sam nagłówek w planie zadania wystarcza), decyzje D-n
// bez treści dostają treść z planu sprintu, jednoznaczne skróty ścieżek rozwija według bazy zadania (HEAD i `[new]` wcześniej).
// v2.11 (K4, D-6, D-16): odwrotnie: kontrakt i decyzja planu sprintu zostają samym nagłówkiem (treść dostaje wykonawca
// z planu sprintu), a kryterium z tekstem równym planowi staje się samym identyfikatorem; decyzje tylko zadania zostają.
const firstLine = (s) => String(s).split('\n')[0].trimEnd();
const SHIP = '(the executor gets the sprint plan\'s text)';
const sprintSection = (plan, id) => {
  if (!plan) return null;
  const s = idSection(plan.text, id, { shared: id.startsWith('D-') });
  return s && body(s) ? s : null;
};
// Nagłówek wspólny („### D-3 i D-4 …”) traci treść tylko wtedy, gdy każda jego decyzja jest decyzją planu sprintu.
const sprintOnlyHeading = (plan, span) => [...firstLine(span.text).matchAll(/\b[DC]-\d+\b/g)].every((x) => sprintSection(plan, x[0]));
function headerReplace(text, from, to) {
  const m = /^---\n[\s\S]*?\n---(?:\n|$)/.exec(text);
  if (!m) return null;
  for (const [a, b] of [[JSON.stringify(from), JSON.stringify(to)], [from, to]]) {
    const at = m[0].indexOf(a);
    if (at >= 0) return `${text.slice(0, at)}${b}${text.slice(at + a.length)}`;
  }
  return null;
}
function autofix211({ out, h, task, plan, fixes }) {
  for (const c of task?.contracts ?? []) {
    const theirs = sprintSection(plan, c);
    if (!theirs) continue;
    const mine = idSpan(out, c);
    if (mine === null) { out = appendToSection(out, 'Contracts', firstLine(theirs), ['Changes', 'Decisions']); fixes.push(`${c} heading added ${SHIP}`); }
    else if (body(mine.text) && sprintOnlyHeading(plan, mine)) { out = splice(out, mine, firstLine(mine.text)); fixes.push(`${c} body removed ${SHIP}`); }
  }
  for (const id of asList(h.decisions).map(idOf)) {
    const theirs = sprintSection(plan, id);
    if (!theirs) continue;
    const mine = idSpan(out, id, { shared: true });
    if (mine === null) { out = appendToSection(out, 'Decisions', firstLine(theirs), ['Assumptions', 'Risks', 'Out of scope']); fixes.push(`${id} heading added ${SHIP}`); }
    else if (body(mine.text) && sprintOnlyHeading(plan, mine)) { out = splice(out, mine, firstLine(mine.text)); fixes.push(`${id} body removed ${SHIP}`); }
  }
  for (const entry of asList(h.acceptance).map(String)) {
    const id = idOf(entry);
    const rest = acRest(entry, id);
    const theirs = /^AC-\d+$/.test(id) ? acEntry(plan?.text, id) : null;
    if (!rest || theirs == null || PART.test(rest) || squash(rest) !== acRest(theirs, id)) continue;
    const next = headerReplace(out, entry, id);
    if (next !== null) { out = next; fixes.push(`${id} text removed from acceptance ${SHIP}`); }
  }
  return out;
}

export function autofixTaskPlan({ text, h, k, plan, base, v211 = false }) {
  let out = text.replace(/\r\n/g, '\n');
  const fixes = [];
  const task = plan?.tasks.find((x) => x.k === k);
  if (v211 && plan) out = autofix211({ out, h, task, plan, fixes });
  for (const c of v211 && plan ? [] : task?.contracts ?? []) {
    const theirs = idSection(plan.text, c);
    if (theirs === null) continue;
    // Tylko nagłówek zaczynający się od C-n (nie ryzyko, które o nim wspomina); podmiana po położeniu, nie po tekście.
    const mine = idSpan(out, c);
    if (mine === null) { out = appendToSection(out, 'Contracts', theirs, ['Changes', 'Decisions']); fixes.push(`${c} copied from the sprint plan`); }
    else if (squash(mine.text) !== squash(theirs)) { out = splice(out, mine, theirs.trimEnd()); fixes.push(`${c} replaced by the sprint plan's text`); }
  }
  for (const id of v211 && plan ? [] : asList(h.decisions).map(idOf)) {
    const theirs = plan ? idSection(plan.text, id, { shared: true }) : null;
    if (!theirs || !body(theirs)) continue;
    const mine = idSpan(out, id, { shared: true });
    if (mine === null) { out = appendToSection(out, 'Decisions', theirs, ['Assumptions', 'Risks', 'Out of scope']); fixes.push(`${id} copied from the sprint plan`); }
    else if (!body(mine.text)) { out = splice(out, mine, theirs.trimEnd()); fixes.push(`${id} text copied from the sprint plan`); }
  }
  // Dłuższe skróty najpierw i tylko całe tokeny (recenzja v2.9: `.../api/Foo.java` psuł `core/.../api/Foo.java`).
  const tokens = unique([...out.matchAll(/[^\s`'"„”()[\],;]*(?:\.\.\.|…)\/[^\s`'"„”()[\],;]*/g)].map((x) => x[0].replace(PUNCT_R, ''))).sort((a, b) => b.length - a.length);
  for (const t of tokens) {
    const full = expandShortPath(t, base);
    if (!full) continue;
    const re = new RegExp(`(?<![^\\s\`'"„”()[\\],;])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w./@#$-])`, 'g');
    const next = out.replace(re, () => full);
    if (next !== out) { out = next; fixes.push(`${t} → ${full}`); }
  }
  return { text: out, fixes };
}

// v2.11 (D-19): punkt `## Changes` z wierszami kontynuacji; wcięte wiersze `N.` pod nim to jego kroki (mierzone osobno).
export function changeEntries(text) {
  const sec = namedSection(text, 'Changes');
  if (sec === null) return null;
  const out = [];
  let open = false;
  for (const line of sec.split(/\r?\n/).slice(1)) {
    const m = /^[-*]\s+(.*)$/.exec(line);
    const e = out[out.length - 1];
    if (m) { out.push({ text: m[1].trim(), steps: [] }); open = true; }
    else if (open && /^\s+\d+[.)]\s+\S/.test(line)) e.steps.push(line.trim());
    else if (open && /^\s+\S/.test(line)) { if (e.steps.length) e.steps[e.steps.length - 1] += ` ${line.trim()}`; else e.text += ` ${line.trim()}`; }
    else if (line.trim()) open = false;
  }
  return out;
}

export const ENTRY_MAX = 400;
export const STEP_MAX = 200;
export const STEPS_MAX = 4;
// D-17: rozszerzenia plików kodu, których `[change]`/`[new]` niesie `test first:` z wartością.
const SOURCE_EXT = /\.(?:js|mjs|cjs|jsx|ts|tsx|java|kt|py|go|cs|rb|php|rs|swift|scala|vue|svelte)$/i;
// D-19: wartość przypadku testowego: cyfra, napis w cudzysłowie albo literał w backtickach.
const TEST_VALUE = /\d|"[^"]+"|(?<![\w])'[^']+'(?![\w])|„[^”]+”|“[^”]+”|`[^`]+`/;
const WAYS_OUT = 'keep each change entry to 1–2 lines, drop code-level parameters (only product decisions and contracts stay), or split the task';

// v2.11 (D-5, D-19): kształt opcji B: długość punktu, kroki, `test first:` z wartością przy kodzie (bez plików testów), bez bloków kodu.
function shapeErrors211(text, testGlob) {
  const errors = [];
  for (const e of changeEntries(text) ?? []) {
    const len = e.text.length;
    if (len > ENTRY_MAX) errors.push(`Changes: entry of ${len} characters (at most ${ENTRY_MAX}, about two lines: file, element with name and signature, who calls whom, pattern, not:; the how is the executor's): „${short(e.text, 60)}”`);
    if (e.steps.length > STEPS_MAX) errors.push(`Changes: ${e.steps.length} numbered steps under „${short(e.text, 40)}” (at most ${STEPS_MAX})`);
    for (const s of e.steps.filter((x) => x.length > STEP_MAX)) errors.push(`Changes: step of ${s.length} characters (at most ${STEP_MAX}): „${short(s, 60)}”`);
    const c = parseChange(e.text);
    if (!['change', 'new'].includes(c.kind) || /^test/i.test(c.term ?? '')) continue;
    const src = anchorTokens(c.head).map((t) => t.split('#')[0]).filter((p) => SOURCE_EXT.test(p) && !isTestPath(p, testGlob));
    if (!src.length) continue;
    const all = [e.text, ...e.steps].join(' ');
    const tf = /(?:^|[\s;.,(])test first\s*:\s*(.*)$/i.exec(all);
    if (!tf) { errors.push(`Changes: [${c.kind}] ${src[0]} changes code without test first: add a test case with values that is red before the change (e.g. test first: 100 with 10 → 90)`); continue; }
    const kw = KEYWORDS.exec(tf[1]);
    const seg = (kw ? tf[1].slice(0, kw.index) : tf[1]).trim();
    if (!TEST_VALUE.test(seg)) errors.push(`Changes: test first: „${short(seg, 60)}” has no value; give the input and the expected result (a number, a quoted string or a backtick literal)`);
  }
  const b = splitHeader(text)?.body ?? text;
  if (/^\s*(```|~~~)/m.test(b)) errors.push('code fence in the task plan: name the element and its signature instead of writing code (no fenced blocks)');
  return errors;
}

// v2.11 (C-1, D-16): `acceptance` to `AC-n` albo `AC-n (part: …)`; tekst równy planowi usuwa autopoprawka.
function acceptanceErrors211(h, plan) {
  const errors = [];
  for (const entry of asList(h.acceptance).map(String)) {
    const id = idOf(entry);
    const rest = acRest(entry, id);
    if (!/^AC-\d+$/.test(id) || !rest || PART.test(rest)) continue;
    const theirs = acEntry(plan.text, id);
    if (theirs != null && squash(rest) === acRest(theirs, id)) continue;
    errors.push(`acceptance: „${short(entry, 60)}” carries text; write ${id} or ${id} (part: <this task's part>) (the executor gets the sprint plan's text)`);
  }
  return errors;
}

// Reguły planu zadania k (§5.9). `plan` null: plan zadania bez planu sprintu (import, test), bez AC i C-n z planu.
// `base` rośnie o lokalizacje `[new]` tego zadania (baza zadania k+1).
export function taskPlanErrors({ text, h, k, plan = null, base, v210 = false, v211 = false, testGlob = null }) {
  const errors = [];
  if (h.task != null && String(h.task) !== `T-${k}`) errors.push(`task: ${h.task}, oczekiwano T-${k}`);
  const task = plan?.tasks.find((x) => x.k === k);
  // v2.11 z planem sprintu: kryteria, decyzje i kontrakty sprintu przez odwołanie (C-1); bez planu sprintu pełny tekst (D-6).
  const refs = v211 && !!plan;
  if (plan) {
    const have = asList(h.acceptance).flatMap(acIds);
    for (const ac of task?.ac ?? []) if (!have.includes(ac)) errors.push(`brak ${ac}, które plan przypisuje temu zadaniu (część kryterium dzielonego też)`);
  }
  if (refs) errors.push(...acceptanceErrors211(h, plan));
  for (const id of asList(h.decisions)) {
    // Nagłówek zaczynający się identyfikatorem (wzmianka o D-n w innym nagłówku nie jest treścią decyzji);
    // bez takiego nagłówka zostaje wspólny nagłówek kilku decyzji („### D-3 i D-4 …”).
    const sec = idSection(text, id, { shared: true });
    if (refs && sprintSection(plan, idOf(id))) {
      if (sec === null) errors.push(`missing heading ### ${id} (a sprint decision: the heading alone, the executor gets the sprint plan's text)`);
      else if (body(sec)) errors.push(`${id}: a sprint decision keeps the heading only, without a body (the executor gets the sprint plan's text)`);
    } else if (sec === null) errors.push(`brak sekcji ### ${id} z treścią decyzji`);
    else if (!body(sec)) errors.push(`${id}: sekcja bez treści (pełna treść decyzji, nie sam identyfikator)`);
  }
  for (const c of task?.contracts ?? []) {
    const mine = idSection(text, c);
    const theirs = idSection(plan.text, c);
    if (theirs === null) errors.push(`${c}: brak sekcji w planie sprintu`);
    else if (refs) {
      if (mine === null) errors.push(`missing heading ### ${c} (a sprint contract: the heading alone, the executor gets the sprint plan's text)`);
      else if (body(mine)) errors.push(`${c}: a sprint contract keeps the heading only, without a body (the executor gets the sprint plan's text)`);
    } else if (mine === null) errors.push(`brak sekcji ### ${c} (kontrakt dosłownie jak w planie sprintu)`);
    else if (squash(body(mine)) !== squash(body(theirs))) errors.push(`${c}: treść inna niż w planie sprintu (kontrakt dosłownie)`);
  }
  if (v211) errors.push(...shapeErrors211(text, testGlob));
  if (!asList(h.read_first).length) errors.push('read_first jest pusty (pliki i symbole do przeczytania przed zmianą)');
  const walk = anchorWalk(text, h, base);
  if (walk.items === null || !walk.items.length) errors.push('## Changes bez punktów ([new <pojęcie>], [change], [remove])');
  errors.push(...walk.problems);
  // v2.10 (B): plik usuwany w całości stoi w nagłówku `delete` (usuwa go skrypt za zgodą użytkownika, nie wykonawca);
  // plik z `delete` musi istnieć w bazie zadania i znika z niej dla późniejszych kotwic.
  const del = asList(h.delete).map(String);
  const wholeRemoved = walk.anchors.filter((a) => a.kind === 'remove' && !a.symbol);
  if (v210) for (const a of wholeRemoved.filter((x) => !del.includes(x.path))) errors.push(`Changes: [remove] ${a.path} usuwa cały plik: wpisz go do nagłówka delete (skrypt usuwa pliki za zgodą użytkownika)`);
  for (const d of del) {
    // Tylko pliki: katalog z `delete` usunąłby rekurencyjnie więcej, niż plan wypisuje.
    if (d.endsWith('/') || base.isDir(d)) errors.push(`delete: ${d} to katalog; wypisz jego pliki pełnymi ścieżkami`);
    else if (base.has(d)) base.remove(d);
    else if (!wholeRemoved.some((a) => a.path === d && a.ok)) errors.push(`delete: ${d} nie istnieje w bazie zadania (HEAD i [new] wcześniejszych zadań)`);
  }
  for (const a of walk.anchors.filter((x) => !x.ok)) {
    errors.push(a.kind === 'new'
      ? `Changes: [new] ${a.path} nie istnieje w bazie zadania ani nie pasuje do scope`
      : `${a.kind === 'read_first' ? 'read_first' : a.kind === 'pattern' ? 'Changes: pattern' : `Changes: [${a.kind}]`} ${a.path} nie istnieje w bazie zadania (HEAD i [new] wcześniejszych zadań)`);
  }
  const checked = checkedText(text, h);
  for (const x of unique(lineNumberHits(checked))) errors.push(`numer linii „${x}” (plan wskazuje symbole, nie linie)`);
  for (const x of shortcutHits(checked)) errors.push(`skrót ścieżki: ${x} (pełne ścieżki od katalogu głównego)`);
  for (const r of parseRisks(text).filter((x) => asList(h.risks).includes(x.id))) {
    const other = [...`${r.method ?? ''} ${r.detail ?? ''}`.matchAll(/\bT-(\d+)\b/g)].map((m) => Number(m[1])).filter((j) => j !== k);
    if (other.length) errors.push(`${r.id}: Method odsyła do T-${other[0]}; dowód ryzyka powstaje w tym samym zadaniu`);
  }
  return { errors: unique(errors), news: walk.news, changed: unique(walk.anchors.filter((a) => ['new', 'change', 'remove'].includes(a.kind)).map((a) => a.path)) };
}

// Przegląd 2026-10-09 (W-5): zadanie zmieniło plik `.ts` frontendu bez komendy testów frontendu w planie zadania, więc czerwień
// wyszła dopiero przy finish. `verify.unit: [{glob, cmd}]` (testy jednostkowe obszaru, tanio; bez IT i e2e): zadanie, które
// zmienia plik pasujący do `glob`, ma w `verify` komendę zaczynającą się od `cmd` (z plikami albo wzorcem testów).
export function unitVerifyErrors(h, changed, cfg) {
  const out = [];
  for (const u of asList(cfg?.verify?.unit)) {
    if (!u?.glob || !u?.cmd) continue;
    const re = globToRegExp(String(u.glob));
    const hit = asList(changed).filter((f) => re.test(f));
    if (!hit.length || asList(h.verify).some((c) => String(c).trim().startsWith(String(u.cmd)))) continue;
    out.push(`verify: zadanie zmienia ${hit[0]}${hit.length > 1 ? ` (+${hit.length - 1})` : ''}, a żadna komenda nie uruchamia testów jednostkowych tego obszaru: dodaj \`${u.cmd} <pliki albo wzorzec testów>\` (verify.unit)`);
  }
  return out;
}

// Plan zadania w kształcie v2.7 (`read_first` i `## Changes`): import i brief bez planu sprintu dostają jego reguły.
export const isTaskPlan = (text, h) => h?.read_first != null && namedSection(text, 'Changes') !== null;

// Pliki śledzone na HEAD gałęzi sprintu (pamięć na proces: walidacja biegnie kilka razy na komendę).
const headCache = new Map();
export function headFiles(top) {
  const sha = git(['rev-parse', 'HEAD'], { cwd: top });
  const key = `${top}\n${sha}`;
  if (!headCache.has(key)) headCache.set(key, git(['ls-tree', '-r', '--name-only', '-z', 'HEAD'], { cwd: top }).split('\0').filter(Boolean));
  return headCache.get(key);
}

// Czy zadanie a osiąga b przez `Depends` (skierowanie, przechodnio).
function reaches(deps, a, b) {
  const seen = new Set();
  const stack = [a];
  while (stack.length) {
    for (const y of deps.get(stack.pop()) ?? []) {
      if (y === b) return true;
      if (!seen.has(y)) { seen.add(y); stack.push(y); }
    }
  }
  return false;
}

// Między zadaniami (§5.9): zakresy mogą się nakładać tylko między zadaniami połączonymi `Depends`; przecięcie liczone
// na plikach HEAD i lokalizacjach `[new]`, nie na tekście globów (glob szerszy też się nakłada).
export function overlapErrors({ head, plan, from = 1, news, scopes }) {
  const deps = new Map(plan.tasks.map((t) => [t.k, taskDepends(t.text)?.ids ?? []]));
  const universe = unique([...head, ...Object.values(news).flat()]);
  const ks = Object.keys(scopes).map(Number).filter((k) => k >= from).sort((a, b) => a - b);
  const filesOf = new Map(ks.map((k) => { const res = asList(scopes[k]).map((g) => globToRegExp(String(g))); return [k, new Set(universe.filter((f) => res.some((r) => r.test(f))))]; }));
  const errors = [];
  for (let i = 0; i < ks.length; i++) {
    for (let j = i + 1; j < ks.length; j++) {
      const [a, b] = [ks[i], ks[j]];
      const common = [...filesOf.get(a)].filter((f) => filesOf.get(b).has(f));
      if (common.length && !reaches(deps, a, b) && !reaches(deps, b, a)) {
        errors.push(`T-${a} i T-${b}: zakresy obejmują te same pliki (${common.slice(0, 3).join(', ')}${common.length > 3 ? ` i ${common.length - 3} innych` : ''}), a żadne z nich nie zależy od drugiego (Depends)`);
      }
    }
  }
  return errors;
}

// v2.11 (D-4, D-18): limit `plan.taskPlanMaxKB` (domyślnie 10; konfiguracje częściowe w testach bez klucza), KB = 1024 B.
export const taskPlanMaxKB = (cfg) => Number(cfg?.plan?.taskPlanMaxKB ?? 10);
export function sizeError(text, cfg) {
  const max = taskPlanMaxKB(cfg);
  const size = Buffer.byteLength(String(text), 'utf8');
  if (size <= max * 1024) return null;
  return `task plan is ${(size / 1024).toFixed(1)} KB after autofix, over the limit of ${max} KB (plan.taskPlanMaxKB): ${WAYS_OUT}`;
}

const briefOf = (root, k) => join(taskDir(root, k), 'brief.md');
function headerOf(text) {
  const s = splitHeader(text);
  if (!s) return { errors: ['brak nagłówka YAML (---)'] };
  try { const h = normalizeLists(parseYaml(s.yaml)); const errors = validateHeader(h); return errors.length ? { h, errors } : { h }; }
  catch (e) { return { errors: [e.message] }; }
}

// Plany zadań od `from` w profilu architekta: brakujące, błędy (tylko zadań przed pierwszym brakującym), otwarte pytania,
// nakładanie zakresów (gdy są wszystkie). Baza zadania j = HEAD + `[new]` zadań from…j−1 (zadania wcześniejsze są w HEAD).
// v2.9 `fix`: 'write' zapisuje autopoprawki (`state`), 'memory' tylko waliduje poprawiony tekst (hook po zapisie planu),
// bez wartości bez autopoprawek (computeState jest bez skutków, a `state` poprawił pliki wcześniej).
export function validateTaskPlans({ top, root, plan, from = 1, cfg, fix = null, run = null }) {
  const n = asList(plan.h.tasks).length;
  const head = headFiles(top);
  const base = makeBase(head);
  const out = { missing: [], errors: [], questions: [], news: {}, scopes: {}, fixed: [] };
  const v211 = is211(run);
  const risksOf = {};
  for (let k = from; k <= n; k++) {
    const file = briefOf(root, k);
    if (!existsSync(file)) { out.missing.push(k); continue; }
    if (out.missing.length) continue;
    let text = read(file);
    let { h, errors: herr } = headerOf(text);
    if (herr) { out.errors.push(...herr.map((e) => `T-${k}: ${e}`)); continue; }
    if (fix) {
      const r = autofixTaskPlan({ text, h, k, plan, base, v211 });
      if (r.fixes.length) {
        text = r.text;
        if (fix === 'write') writeFileSync(file, text);
        out.fixed.push({ k, fixes: r.fixes });
        ({ h, errors: herr } = headerOf(text));
        if (herr) { out.errors.push(...herr.map((e) => `T-${k}: ${e}`)); continue; }
      }
    }
    out.scopes[k] = asList(h.scope);
    risksOf[k] = parseRisks(text);
    const r = taskPlanErrors({ text, h, k, plan, base, v210: is210(run), v211, testGlob: cfg?.verify?.testFiles ?? null });
    // v2.11 (D-4, D-18): rozmiar tekstu po autopoprawkach, czyli tego, co czyta wykonawca.
    if (v211) { const e = sizeError(text, cfg); if (e) r.errors.unshift(e); }
    out.news[k] = r.news;
    if (asList(h.questions).length) {
      for (const id of asList(h.questions)) if (section(text, id) === null) out.errors.push(`T-${k}: brak sekcji ${id}`);
      out.questions.push(k);
      continue;
    }
    out.errors.push(...unique([...briefErrors(text, h, cfg, { strictVerify: is210(run) }), ...r.errors, ...unitVerifyErrors(h, r.changed, cfg)]).map((e) => `T-${k}: ${e}`));
  }
  if (!out.missing.length) out.errors.push(...overlapErrors({ head, plan, from, news: out.news, scopes: out.scopes }));
  // K5 D-4 (2.12): UAT steps of the sprint plan name a human or ui risk of their task, or a [human] criterion; once all
  // task plans exist (like the overlap check). Plans before `from` are frozen: their risks come from the files as they are.
  if (!out.missing.length && is212(run)) {
    for (let k = 1; k <= n; k++) { const f = briefOf(root, k); if (!risksOf[k] && existsSync(f)) risksOf[k] = parseRisks(read(f)); }
    out.errors.push(...uatRefErrors(uatScenario(plan.text ?? ''), { risks: risksOf, criteria: asList(plan.h.acceptance) }).map((e) => `plan.md: ${e}`));
  }
  return out;
}

// Walidacja od zadania k: profil architekta przy `plan.md`, bez niego plan zadania 1 w profilu briefu (import, inline).
export function validateFrom({ top, root, run, cfg, from }) {
  const plan = planInfo(root, run);
  if (plan) {
    // Architekt przy replan może zmienić plan sprintu (nowe D-n): jego błędy, w tym zepsuty nagłówek, też blokują.
    if (plan.errors.length) return { missing: [], errors: plan.errors.map((e) => `plan.md: ${e}`), questions: [] };
    return validateTaskPlans({ top, root, plan, from, cfg, run });
  }
  const ctx = taskCtx(root, run, from);
  const b = tryTaskBrief(root, run, ctx, cfg);
  if (!b) return { missing: [from], errors: [], questions: [] };
  const open = asList(b.questions).length && !b.errors;
  let errors = asList(b.errors);
  // Po zamrożeniu tryTaskBrief pomija kotwice; poprawka architekta przy `replan` dostaje je z powrotem (praca jest poza HEAD).
  const text = read(briefOf(root, from));
  if (!errors.length && !open && run.plansReady && isTaskPlan(text, b)) errors = taskPlanErrors({ text, h: b, k: from, base: makeBase(headFiles(top)), v210: is210(run) }).errors;
  return { missing: [], errors: errors.map((e) => `T-${from}: ${e}`), questions: open ? [from] : [] };
}

// v2.9: autopoprawki planów zadań przed obliczeniem stanu (`state`): od zadania 1 przy planowaniu, potem od bieżącego
// zadania (albo początku trwającego replanu). Zwraca listę poprawek dla raportu stanu.
export function autofixPlans({ top, root, run, cfg }) {
  const plan = planInfo(root, run);
  if (!plan || plan.h.errors || asList(plan.h.questions).length) return [];
  const t = asList(run.tasks).find((x) => x.k === run.task);
  // Po zamrożeniu plany zmienia tylko replan: bez niego nie ma czego poprawiać.
  if (run.plansReady && !t?.replan) return [];
  const from = run.plansReady ? (t.replan.from ?? run.task ?? 1) : 1;
  try { return validateTaskPlans({ top, root, plan, from, cfg, fix: 'write', run }).fixed; } catch { return []; }
}

// ---------- stany architekta (§5.2, §5.9, §5.10) ----------

export const architectFresh = (run) => !run.architect || run.architect.session !== sessionId();

// Ścieżki i parametry wspólne dla promptów architekta; `from`: przy `replan` plany od k i raporty wcześniejszych zadań.
export function architectPaths(root, run, cfg, from = null) {
  const { rel, root: repo } = pathsFor(run, topOfRoot(root));
  const p = (...x) => rel(join(root, ...x));
  const n = run.count ?? asList(planInfo(root, run)?.h.tasks).length;
  const parts = [`Task: ${p('task.md')}`, `Sprint answers: ${p('answers.md')}`, `Plan: ${p('plan.md')}`];
  if (from) {
    const ks = Array.from({ length: Math.max(1, n - from + 1) }, (_, i) => from + i);
    parts.push(`Task plans from T-${from}: ${ks.map((k) => rel(briefOf(root, k))).join(', ')}`);
    if (from > 1) parts.push(`Reports of earlier tasks: ${Array.from({ length: from - 1 }, (_, i) => p('tasks', String(i + 1), 'report.md')).join(', ')}`);
  } else parts.push(`Task plans: ${p('tasks')}/<k>/brief.md`);
  parts.push(
    `Templates: ${TPL('plan.md')}, ${TPL('brief.md')}`, `Vocabulary: ${REF('vocabulary.md')}`, `Design questions: ${REF('design-questions.md')}`,
    `Sizes: ${p('sizes.txt')}`,
    // Przegląd sprintu 16 (UI) (decyzja użytkownika): eksploratorzy według potrzeby (wielkość obszaru), nie według trybu. Tryb pośredni
    // to jedno zadanie i jedna recenzja na końcu; o eksploratorach decyduje ta sama reguła obszaru co w `single`.
    `Explorer answers: ${p('explore')}/`, 'Explorer type: dwmt-explorer', `Self-read limit: ${cfg.explore?.selfReadMaxK ?? 30}k tokens per area`, `Rounds per explorer: at most ${cfg.explore?.maxRounds ?? 3}`,
    ...(isIntermediate(run)
      ? [`Mode: intermediate: the sprint is exactly one task (T-1), reviewed once at the end; explorers only by the area rule, never because of the mode; the task plan header keeps mode: single. If your files estimate exceeds ${intermediateLimit(run)}, split the sprint into tasks as in mode single instead (the run becomes single)`]
      : ['Mode: single']),
    finishFacts(cfg),
    unitFacts(cfg),
  );
  return `${repo}${parts.join('. ')}. ${planEnv(cfg, run)}${sprintExtras(run, cfg, runDepsNow(runHome(run, topOfRoot(root)), run).order)}${productArchitectLines(topOfRoot(root), run, cfg)}`;
}

// W-5 (przegląd 2026-10-09): testy jednostkowe obszaru w `verify` każdego zadania, które go zmienia (czerwień przy finish
// kosztowała noce). Z `verify.unit` reguła (sprawdza też walidacja planu), bez niego jedna linia zasady.
export function unitFacts(cfg) {
  const u = asList(cfg.verify?.unit).filter((x) => x?.glob && x?.cmd);
  return u.length
    ? `Unit tests by area: a task that changes ${u.map((x) => `\`${x.glob}\` runs \`${x.cmd} <its test files or pattern>\``).join(', a task that changes ')} in its verify`
    : "A task that changes source files runs, in its verify, the unit tests of every stack it touches with that stack's own runner (e.g. the frontend's test command for frontend files): the full suite at finish is too late to find them red";
}

// A (noc 2026-10-05): sprinty 9 i 16 zapowiadały w planie „Playwright przy finish”, a finish projektu nie uruchamia e2e. Fakt z configu
// w prompcie architekta: co biegnie przy finish; inny test biegnie tylko wtedy, gdy uruchamia go `verify` zadania.
// K5 (D-5, D-17): with `verify.modules` the facts name the modules and their rule; an accepted red test is known red for
// `verify.knownRedDays` days with an owner backlog item.
export function finishFacts(cfg) {
  const full = asList(cfg.verify?.full);
  const mods = asList(cfg.verify?.modules).filter((m) => m && asList(m.full).length);
  const e2e = cfg.verify?.e2eChanged?.glob ? `, plus the e2e spec files the sprint adds or changes (${cfg.verify.e2eChanged.glob})` : '';
  const cmds = (xs) => xs.map((c) => `\`${c}\``).join(', ');
  const base = full.length ? cmds(full) : mods.length ? 'no cross-module command (verify.full is empty)' : 'the verify commands of all tasks';
  const modules = mods.length
    ? `, plus the full commands of each module of verify.modules whose glob matches a file the sprint changes (a changed code file outside every module runs all modules): ${mods.map((m) => `${m.name ?? asList(m.glob).join(', ')} (${asList(m.glob).join(', ')}): ${cmds(asList(m.full))}`).join('; ')}`
    : '';
  const known = `. A red full-suite test accepted with the user's consent stays known red for ${cfg.verify?.knownRedDays ?? 7} days (verify.knownRedDays) with an owner backlog item, then blocks finish again`;
  return `At finish the script runs only: ${base}${modules}${e2e}; any other test runs only if a task's verify runs it, so never plan or claim it "at finish"${known}`;
}

const START = "Plan the sprint: explore, ask all the sprint's questions at once in the sprint plan and stop; after the answers design, run the round for the plan and write the sprint plan and the plans of all its tasks.";
// Przy `after` (§5.9 pkt 6) architekt kończy na planie sprintu; plany zadań pisze świeży architekt po scaleniu zależności.
const START_AFTER = "Plan the sprint: explore, ask all the sprint's questions at once in the sprint plan and stop; after the answers design and write the sprint plan only. This sprint waits for other sprints to merge: do not write task plans now, they are written on the merged code.";
// kf2 (D-6, D-9): przebieg pod zleceniem czyta bieżące zależności swojej pozycji, nie kopię z wejścia.
const waitsForAfter = (run, top) => !run.afterDone && runDepsNow(runHome(run, top), run).after.length > 0;
const SEND = 'odeślij prompt temu samemu architektowi (SendMessage do agenta z tym `key`), a przy `fresh: true` albo bez jego identyfikatora uruchom nowego';

// Po wyjściu z `planned` (§5.10): świeży architekt sprawdza plan wobec kodu po scaleniu zależności i pisze plany zadań.
function afterPrompt(run) {
  const files = asList(run.afterChanged);
  const changed = files.length ? `files changed on the target since planning: ${files.slice(0, 20).join(', ')}${files.length > 20 ? ' …' : ''}` : 'no file changed on the target since planning';
  return `The sprints this one waited for are merged (${changed}). Check the sprint plan against the current code: record changes as new D-n and business questions as a second batch in the sprint plan with \`questionsRound: 2\` (then stop); otherwise run the round for the plan and write the plans of all tasks.`;
}

// Planowanie v2.7 do gotowości planów (§5.9): plan sprintu, pytania, plany wszystkich zadań. null = planowanie gotowe
// (albo, przy `after` przed wyjściem z `planned`, wystarcza plan sprintu).
export function architectPlanState({ top, root, run, cfg, base }) {
  const p = (n) => fwd(join(root, n));
  const briefFile = briefOf(root, 1);
  const plan = planInfo(root, run);
  const brief1 = existsSync(briefFile) ? tryHeader(briefFile) : null;
  const inline = (brief1?.mode ?? run.mode) === 'inline';
  // E (noc 2026-10-05): tryb direct bez architekta; plan zadania 1 pisze skrypt (`direct.mjs`), tu tylko jego walidacja.
  const architect = !inline && run.mode !== 'direct' && existsSync(join(root, 'task.md'));
  const fresh = architectFresh(run);
  const { rel, root: repo } = pathsFor(run, top);
  const mk = (what, hint, output = p('plan.md')) => ({
    ...base, next: 'plan', hint,
    ...(architect && what ? { agent: ARCHITECT, key: 'architect', fresh, output, prompt: `${what} ${architectPaths(root, run, cfg)}` } : {}),
  });
  if (!plan) {
    if (!brief1) {
      if (architect && waitsForAfter(run, top)) return mk(START_AFTER, 'architekt: rozpoznanie, pytania raz, projekt i plan sprintu (plany zadań po scaleniu zależności)');
      if (architect) return mk(START, 'architekt: rozpoznanie, pytania raz, projekt, plan sprintu i plany wszystkich zadań');
      return mk(null, inline ? 'inline: zaplanuj sam i zapisz plan zadania 1 według szablonu (z sekcją ## UAT)' : 'brak task.md i planu zadania: zapisz zadanie do task.md albo import-plan');
    }
    // Tryb single z zadaniem (bez importu, `run.plan`): planuje architekt, a jego profil wymaga planu sprintu zawsze,
    // także przy jednym zadaniu (§5.2); sam plan zadania nie przechodzi.
    if (architect && !run.plan) {
      return mk(`Write the sprint plan: ${p('plan.md')} is missing (the architect writes it always, also for one task: \`tasks: [T-1]\`); keep the plan of task 1 if it passes validation.`, 'brak plan.md: w trybie single plan sprintu jest obowiązkowy (plan zadania bez niego nie przechodzi)');
    }
    // Plan zadania bez planu sprintu (import, inline): reguły briefu v2.6, a przy read_first i ## Changes także planu zadania.
    const brief = tryTaskBrief(root, run, taskCtx(root, run, 1), cfg);
    // Recenzja nocy 2026-10-05: w trybie direct plan zmienia wykonawca (verify, UAT), a architekta nie ma; błąd planu wraca do niego.
    if (brief.errors && run.mode === 'direct') {
      return {
        ...base, next: 'plan', agent: 'dwmt-executor-high', output: fwd(briefFile), hint: `plan zadania 1 niepoprawny (tryb direct): ${brief.errors.join('; ')}`,
        prompt: `${repo}Mode direct (no architect): fix only the task plan ${rel(briefFile)}, not the code: ${brief.errors.join('; ')}. A verify command is a plain command (no $( ), backticks or $VAR; complex logic goes into a script in the repo); keep the ## UAT section.`,
      };
    }
    if (brief.errors) return mk(`Fix the plan of task 1: ${brief.errors.join('; ')}.`, `plan zadania 1 niepoprawny: ${brief.errors.join('; ')}`, fwd(briefFile));
    return questionState(base, briefFile, brief, join(root, 'answers.md'),
      (rec) => mk(`${rec} and finish the plan of task 1.`, architect ? SEND : 'inline: wpisz odpowiedzi do planu zadania jako D-n i usuń questions', fwd(briefFile)), rel);
  }
  if (plan.errors.length) {
    // v2.9: błędy planu sprintu i planów zadań w jednej wiadomości (sprinty 6+7: dwa kolejne powroty do architekta przy 600k kontekstu).
    const tv = !plan.h.errors && !asList(plan.h.questions).length && existsSync(briefOf(root, 1)) ? validateTaskPlans({ top, root, plan, from: 1, cfg, run }) : null;
    const more = tv?.errors.length ? ` Fix the task plans: ${tv.errors.join('; ')}.` : '';
    return mk(`Fix the plan: ${plan.errors.join('; ')}.${more}`, `plan.md niepoprawny: ${plan.errors.join('; ')}${tv?.errors.length ? `; plany zadań: ${tv.errors.length} błędów` : ''}`);
  }
  // D4 (spec warstwy produktowej §6.4 pkt 5): `Q-price` układa skrypt i dokłada je do tej samej tury pytań.
  const answers = join(root, 'answers.md');
  const pt = priceTurn(root, run);
  if (pt?.pending) {
    const answered = existsSync(answers) ? answeredIds(read(answers)) : [];
    const open = asList(plan.h.questions).filter((x) => !answered.includes(x));
    return {
      ...base, next: 'ask-plan', questions: [...open, PRICE_Q], file: fwd(plan.file), answers: fwd(answers), price: priceQuestion(run),
      hint: `${open.length ? 'section <file> Q-n → AskUserQuestion; ' : ''}Q-price bez sekcji: treść i opcje z pola price, w tym samym AskUserQuestion; odpowiedź do answers jako ### Q-price z pierwszą linią continue | shrink: <tekst> | stop`,
    };
  }
  if (pt?.stop) return { ...base, next: 'stopped', reason: 'price', hint: 'użytkownik zatrzymał sprint na pytaniu o cenę (Q-price: stop); gałąź zostaje, pozycje i plik sprintu bez zmian' };
  const shrink = pt?.shrink ? `; the user asked to shrink the scope at the price question (Q-price): ${pt.shrink}, so plan the smaller scope (also \`files\`)` : '';
  const q = questionState(base, plan.file, plan.h, answers,
    (rec) => mk(waitsForAfter(run, top) ? `${rec}${shrink}, then finish the sprint plan only (the task plans come after the dependencies merge).` : `${rec}${shrink}, then continue.`, SEND), rel);
  if (q) return q;
  // Odpowiedź „zmniejsz zakres” bez innych pytań: architekt poprawia plany, dopóki plan.md nie jest nowszy od odpowiedzi.
  if (pt?.shrink && !pt.handled) {
    return mk(`The user asked to shrink the scope at the price question (Q-price in ${rel(answers)}): ${pt.shrink}. Revise the sprint plan (also \`files\`) and the task plans to the smaller scope, then continue.`, `Q-price: zmniejszenie zakresu; ${SEND}`);
  }
  if (waitsForAfter(run, top)) return null;
  const v = validateTaskPlans({ top, root, plan, from: 1, cfg, run });
  if (v.questions.length && !v.errors.length) {
    const k = v.questions[0];
    const f = briefOf(root, k);
    return questionState(base, f, tryHeader(f), join(taskDir(root, k), 'answers.md'), (rec) => mk(`${rec} in the plan of T-${k}, then continue.`, SEND), rel);
  }
  if (!v.errors.length && !v.missing.length) return null;
  const n = asList(plan.h.tasks).length;
  if (run.afterDone && v.missing.length === n) return mk(afterPrompt(run), 'po scaleniu zależności: świeży architekt sprawdza plan i pisze plany wszystkich zadań');
  const parts = [];
  if (v.errors.length) parts.push(`Fix the task plans: ${v.errors.join('; ')}.`);
  if (v.missing.length) parts.push(`Write the missing task plans: ${v.missing.map((k) => `T-${k}`).join(', ')} (keep the existing plans that pass validation).`);
  const hint = [v.errors.length ? `plany zadań niepoprawne (${v.errors.length})` : null, v.missing.length ? `brak planów: ${v.missing.map((k) => `T-${k}`).join(', ')}` : null].filter(Boolean).join('; ');
  return mk(parts.join(' '), hint);
}

// Stan `replan` (§5.8, §5.9): architekt poprawia plany od k; `what` = błędy walidacji albo zapis odpowiedzi.
export function replanState({ root, run, cfg, base, k, causes, what = null }) {
  const list = asList(causes);
  const why = list.length ? `Drift causes: ${list.map((c, i) => `(${i + 1}) ${c.text}`).join('; ')}. ` : '';
  // v2.8 (C): drobny szczegół widoczny dla użytkownika architekt może rozstrzygnąć sam; trafia na listę UAT.
  const visible = is28(run) ? ' A small user-visible detail whose question would stop the run and whose choice follows the mockup or the sprint plan\'s intent: settle it yourself as `### D-n [visible] <title in the user\'s language>` with the reason; scope, business rules, external contracts and data loss still go to the user.' : '';
  const prompt = `Replan from T-${k}. ${why}${what ? `${what} ` : ''}Correct the task plans from T-${k} only: committed tasks and the parts of the sprint plan about them stay; the list of tasks does not change (larger new work: ask the user about a separate sprint); business questions go into the plan of T-${k} as \`### Q-n\`.${visible} ${architectPaths(root, run, cfg, k)} End your reply with \`REPLAN: changed|unchanged <T-ids>; cause: plan|discovery|target\`.`;
  return {
    ...base, next: 'replan', agent: ARCHITECT, key: 'architect', fresh: architectFresh(run), from: k,
    causes: list.map((c) => short(c.text, is28(run) ? 160 : 100)), output: fwd(briefOf(root, k)), prompt, // v2.8: przyczyny dłuższe o „for T-j: ”
    hint: what ? `replan T-${k}: ${short(what, 120)}` : `rozjazd przed T-${k}: architekt poprawia plany od T-${k}, potem replan-done`,
  };
}

// ---------- rozjazd przed zadaniem k (§5.9) ----------

// Obsłużone przyczyny: identyfikatory z `drift` dowolnego zadania (odpowiedź „plan aktualny” nie wraca w pętli).
export const handledIds = (run) => new Set(asList(run.tasks).flatMap((t) => asList(t.drift).map((d) => d.id)));

// Kotwica wpisu `laterNotes` albo `changedContracts`: `ścieżka#Symbol` albo `C-n`, najpierw na początku wpisu.
export function noteAnchor(note) {
  const s = typeof note === 'string' ? note : JSON.stringify(note);
  const first = (/^\s*`([^`]+)`/.exec(s)?.[1] ?? s.trim().split(/\s+/)[0] ?? '').replace(/:+$/, '');
  const pick = (t) => (/^C-\d+$/.test(t) ? { contract: t } : anchorOf(t));
  const lead = pick(first);
  if (lead) return lead;
  const c = /\bC-\d+\b/.exec(s)?.[0];
  for (const t of anchorTokens(s)) { const a = anchorOf(t); if (a) return a; }
  return c ? { contract: c } : null;
}

// Kotwice planu zadania k do dopasowania uwag: `## Changes` (z `[new]`), `read_first`, `pattern:`, ścieżki i C-n kontraktów.
export function planAnchors(text, h, k, plan, head) {
  const walk = anchorWalk(text, h, makeBase(head));
  const paths = walk.anchors.map(({ path, symbol }) => ({ path, symbol }));
  const sec = namedSection(splitHeader(text)?.body ?? text, 'Contracts');
  for (const t of anchorTokens(sec ?? '')) { const a = anchorOf(t); if (a) paths.push({ path: a.path, symbol: a.symbol }); }
  const contracts = new Set([...(plan?.tasks.find((x) => x.k === k)?.contracts ?? []), ...[...String(sec ?? '').matchAll(/^#{1,6}\s+[*`]*(C-\d+)\b/gm)].map((m) => m[1])]);
  return { paths, contracts, walk };
}

// Uwaga pasuje do planu: ta sama ścieżka i uwaga bez symbolu, plan wskazuje cały plik albo ten sam symbol; C-n w kontraktach.
export function anchorMatches(a, anchors) {
  if (!a) return false;
  if (a.contract) return anchors.contracts.has(a.contract);
  return anchors.paths.some((p) => (isGlob(p.path) ? globToRegExp(p.path).test(a.path) : p.path === a.path) && (!a.symbol || !p.symbol || p.symbol === a.symbol));
}

const mergeBase = (top, run) => git(['merge-base', run.target, 'HEAD'], { cwd: top });
export const touches = (f, anchors, scope) => anchors.some((p) => p.path === f || (p.path.endsWith('/') && f.startsWith(p.path)) || (isGlob(p.path) && globToRegExp(p.path).test(f))) || inScope(f, scope);

// Przyczyny rozjazdu przed zadaniem k (0 tokenów): zakotwiczone uwagi i zmiany spoza planu z raportów wcześniejszych
// zadań, niespełniona zależność ACCEPTED, znikająca kotwica i zmiana celu (przy `git.rebase: review` albo po `planned`).
// `extra`: pliki `[new]` zadań od bieżącego do k−1 (v2.8, przyczyny dla późniejszych zadań: tych plików jeszcze nie ma na HEAD).
export function driftCauses({ top, root, run, cfg, k, extra = [] }) {
  const plan = planInfo(root, run);
  const file = briefOf(root, k);
  if (!plan || !existsSync(file)) return [];
  const text = read(file);
  const { h } = headerOf(text);
  if (!h) return [];
  const head = [...headFiles(top), ...extra];
  const mine = planAnchors(text, h, k, plan, head);
  const causes = [];
  const v29 = is29(run);
  const planned = planContracts(plan);
  for (let j = 1; j < k; j++) {
    const rep = tryHeader(join(taskDir(root, j), 'report.md'));
    if (!rep || rep.errors) continue;
    const id = (s) => `T-${j}/report.md#${sha8(s)}`;
    for (const note of asList(rep.laterNotes).map(String)) {
      // v2.9: replan wyzwala tylko uwaga `[plan]`; pozostałe (fakty) dostaje wykonawca zadania k (infoNotesFor).
      if (v29 && !isPlanNote(note)) continue;
      if (anchorMatches(noteAnchor(untag(note)), mine)) causes.push({ id: id(note), kind: 'note', text: `T-${j} note for later tasks: ${untag(note)}` });
    }
    for (const cc of asList(rep.changedContracts).map(String)) {
      if (/^\s*`?C-\d+\b/.test(cc)) continue;
      // v2.9: zmiana opisana kontraktem planu („… removed (C-1)”) jest zmianą z planu (sprinty 6+7: fałszywy rozjazd przed T-2).
      if (v29 && [...cc.matchAll(/\bC-\d+\b/g)].some((m) => planned.has(m[0]))) continue;
      if (anchorMatches(noteAnchor(cc), mine)) causes.push({ id: id(cc), kind: 'contract', text: `T-${j} changed outside the plan: ${cc}` });
    }
  }
  const deps = taskDepends(plan.tasks.find((x) => x.k === k)?.text)?.ids ?? [];
  for (const j of deps.filter((x) => x < k)) {
    const rep = tryHeader(join(taskDir(root, j), 'report.md'));
    if (rep?.status !== 'ACCEPTED') continue;
    for (const s of asList(rep.acceptance).map(String).filter((x) => !isMet(x))) causes.push({ id: `T-${j}/report.md#${idOf(s)}`, kind: 'dependency', text: `T-${j} (a dependency) ended ACCEPTED with ${s}` });
  }
  const seen = new Set();
  for (const a of mine.walk.anchors.filter((x) => x.kind !== 'new' && !x.ok && !seen.has(x.path))) {
    seen.add(a.path);
    causes.push({ id: `anchor:${a.path}`, kind: 'anchor', text: `${a.path} (${a.kind} in the plan of T-${k}) is not on HEAD: removed, renamed or never created` });
  }
  const t = targetCause({ top, root, run, cfg, plan, k, head });
  if (t) causes.push(t);
  const done = handledIds(run);
  return causes.filter((c, i) => !done.has(c.id) && causes.findIndex((x) => x.id === c.id) === i);
}

// v2.9: uwaga wykonawcy dla kolejnych zadań oznaczona `[plan]` (plan dalszej pracy jest błędny); bez znacznika to fakt.
// Znacznik na początku albo zaraz po kotwicy („`a.ts#x`: [plan] …”, jak w przykładzie szablonu wyniku).
const TAG = /^(\s*(?:`[^`]+`\s*:?\s*)?)`?\[(plan|info)\]`?\s*/i;
export const isPlanNote = (note) => TAG.exec(String(note))?.[2]?.toLowerCase() === 'plan';
const untag = (note) => String(note).replace(TAG, '$1');
const planContracts = (plan) => new Set((plan?.tasks ?? []).flatMap((x) => asList(x.contracts)));

// v2.9: uwagi-fakty wcześniejszych zadań zakotwiczone w planie zadania k (do promptu jego wykonawcy, 0 tokenów architekta).
export function infoNotesFor({ top, root, run, k }) {
  if (!is29(run) || k < 2) return [];
  const plan = planInfo(root, run);
  const file = briefOf(root, k);
  if (!plan || !existsSync(file)) return [];
  const text = read(file);
  const { h } = headerOf(text);
  if (!h) return [];
  const mine = planAnchors(text, h, k, plan, headFiles(top));
  const out = [];
  for (let j = 1; j < k; j++) {
    const rep = tryHeader(join(taskDir(root, j), 'report.md'));
    if (!rep || rep.errors) continue;
    for (const note of asList(rep.laterNotes).map(String)) {
      if (!isPlanNote(note) && anchorMatches(noteAnchor(untag(note)), mine)) out.push(`T-${j}: ${short(untag(note), 400)}`);
    }
  }
  return out;
}

// v2.8 (B): replan wyzwala nowa przyczyna pasująca do planu zadania k, ale architekt dostaje nowe przyczyny wszystkich zadań
// od k do końca (każda dopasowana do planu swojego zadania, tekst „for T-j: …”); replan-done zapisuje je wszystkie.
// Baza zadania j > k ma pliki `[new]` zadań k…j−1 (jak walidacja), więc ich kotwice nie „znikają”.
export function driftCausesAll({ top, root, run, cfg, k }) {
  const first = driftCauses({ top, root, run, cfg, k });
  if (!is28(run) || !first.length) return first;
  const n = asList(planInfo(root, run)?.h?.tasks).length;
  const head = headFiles(top);
  const by = new Map();
  const news = [];
  for (let j = k; j <= Math.max(k, n); j++) {
    const cs = j === k ? first : driftCauses({ top, root, run, cfg, k: j, extra: news });
    for (const c of cs) { if (!by.has(c.id)) by.set(c.id, { c, tasks: [] }); by.get(c.id).tasks.push(j); }
    const f = briefOf(root, j);
    if (!existsSync(f)) continue;
    const text = read(f);
    const { h } = headerOf(text);
    if (h) news.push(...anchorWalk(text, h, makeBase([...head, ...news])).news);
  }
  return [...by.values()].map(({ c, tasks }) => ({ ...c, text: `for ${tasks.map((j) => `T-${j}`).join(', ')}: ${c.text}` }));
}

// Zmiana celu, która weszła do gałęzi sprintu (rebase rundy 1 przy `git.rebase: review` albo wyjście z `planned`):
// pliki zmienione od `planBase` do merge-base przecinające kotwice albo `scope` zadań od k.
function targetCause({ top, root, run, cfg, plan, k, head }) {
  if (!run.planBase || !(cfg.git?.rebase === 'review' || run.targetCheck)) return null;
  const mb = mergeBase(top, run);
  if (mb === run.planBase) return null;
  const files = git(['diff', '--name-only', '--no-renames', run.planBase, mb], { cwd: top }).split(/\r?\n/).filter(Boolean);
  const n = asList(plan.h.tasks).length;
  const hit = new Set();
  for (let j = k; j <= n; j++) {
    const f = briefOf(root, j);
    if (!existsSync(f)) continue;
    const text = read(f);
    const { h } = headerOf(text);
    if (!h) continue;
    const anchors = planAnchors(text, h, j, plan, head).paths;
    for (const x of files) if (touches(x, anchors, h.scope)) hit.add(x);
  }
  if (!hit.size) return null;
  const range = `${run.planBase.slice(0, 7)}..${mb.slice(0, 7)}`;
  const list = [...hit];
  return { id: `target:${range}`, kind: 'target', text: `the target changed ${list.slice(0, 5).join(', ')}${list.length > 5 ? ` and ${list.length - 5} more` : ''} since planning (${range}), in the anchors or scope of tasks from T-${k}` };
}

// `planIssue` w wyniku BLOCKED (§5.8): przyczyna `T-k/result-N.md#planIssue` (kolejny BLOCKED tej rundy: `#planIssue-2`…).
export function planIssueCause(ctx, round, res) {
  const blocked = existsSync(ctx.dir) ? readdirSync(ctx.dir).filter((f) => new RegExp(`^result-${round}\\.blocked-\\d+\\.md$`).test(f)).length : 0;
  const text = typeof res.planIssue === 'string' ? res.planIssue : JSON.stringify(res.planIssue);
  return { id: `T-${ctx.k}/result-${round}.md#planIssue${blocked ? `-${blocked + 1}` : ''}`, kind: 'planIssue', round, text: `T-${ctx.k} BLOCKED with planIssue: ${text}` };
}

// Zadanie rozpoczęte: wykonawca ruszył, jest wynik albo weryfikacja (kontrola rozjazdu tylko przed wykonawcą).
export function taskStarted(ctx) {
  const { t, dir } = ctx;
  if (Object.keys(t.started || {}).length || t.verified > 0) return true;
  return existsSync(dir) && readdirSync(dir).some((f) => /^(result|repair)-\d+/.test(f));
}

// Faza `replan` i kontrola rozjazdu przed wykonawcą (v2.7, po gotowości planów). null = zadanie idzie dalej.
export function taskGate({ top, root, run, cfg, base, ctx }) {
  const { t, k } = ctx;
  const file = briefOf(root, k);
  const earlier = asList(t.replan?.causes);
  const fix = (what, hint) => ({ ...base, next: 'plan', hint, agent: ARCHITECT, key: 'architect', fresh: architectFresh(run), output: fwd(file), prompt: `${what} ${architectPaths(root, run, cfg, k)}` });
  if (!existsSync(file)) return fix(`Write the missing task plans: T-${k} (keep the existing plans that pass validation).`, `brak planu T-${k}`);
  if (t.replan) {
    const from = t.replan.from ?? k;
    const v = validateFrom({ top, root, run, cfg, from });
    const causes = asList(t.replan.causes);
    if (v.errors.length || v.missing.length) {
      const what = [v.errors.length ? `Fix the task plans: ${v.errors.join('; ')}.` : null, v.missing.length ? `Write the missing task plans: ${v.missing.map((j) => `T-${j}`).join(', ')}.` : null].filter(Boolean).join(' ');
      return replanState({ root, run, cfg, base, k: from, causes, what });
    }
    if (v.questions.length) {
      const j = v.questions[0];
      const f = briefOf(root, j);
      return questionState(base, f, tryHeader(f), join(taskDir(root, j), 'answers.md'),
        (rec) => replanState({ root, run, cfg, base, k: from, causes, what: `${rec} in the plan of T-${j}, then finish the replan.` }), pathsFor(run, top).rel);
    }
    delete t.replan;
  }
  // Zepsuty nagłówek planu zadania po zamrożeniu (recenzja v2.7: bez `mode` przebieg przechodził w inline i verify bez komend):
  // wraca do architekta jako `replan` z przyczyną `T-k/brief.md#header`, także w trakcie zadania.
  const hb = tryHeader(file);
  if (hb?.errors && existsSync(join(root, 'plan.md'))) {
    const cause = { id: `T-${k}/brief.md#header`, kind: 'header', text: `the header of the plan of T-${k} is broken: ${hb.errors.join('; ')}` };
    const causes = handledIds(run).has(cause.id) ? [] : [cause];
    t.replan = { at: new Date().toISOString(), from: k, causes };
    return replanState({ root, run, cfg, base, k, causes, what: `Fix the header of the plan of T-${k}: ${hb.errors.join('; ')}.` });
  }
  if (taskStarted(ctx)) return null;
  const causes = driftCausesAll({ top, root, run, cfg, k });
  if (!causes.length) return null;
  // Przyczyny poprzedniej fazy bez replan-done zostają (architekt mógł już usunąć ich ślad z planu).
  const done = handledIds(run);
  const all = [...causes, ...earlier.filter((c) => !done.has(c.id) && !causes.some((x) => x.id === c.id))];
  t.replan = { at: new Date().toISOString(), from: k, causes: all };
  return replanState({ root, run, cfg, base, k, causes: all });
}

// Bieżące przyczyny zadania k dla `replan-done`: rozjazd (zadanie nierozpoczęte) i `planIssue` bieżącego wyniku BLOCKED.
export function currentCauses({ top, root, run, cfg, ctx, round }) {
  const out = taskStarted(ctx) ? [] : driftCausesAll({ top, root, run, cfg, k: ctx.k });
  const res = tryHeader(join(ctx.dir, `result-${round}.md`));
  if (res?.status === 'BLOCKED' && res.planIssue) {
    const c = planIssueCause(ctx, round, res);
    if (!handledIds(run).has(c.id)) out.push(c);
  }
  return out;
}

// Zapis obsłużonych przyczyn (`dwmt replan-done`): klasa domyślna target przy zmianie celu, plan przy planIssue, inaczej discovery.
export function recordReplan({ top, run, ctx, causes, result, cause }) {
  const list = asList(causes);
  const kinds = new Set(list.map((c) => c.kind));
  const cls = cause ?? (kinds.has('target') ? 'target' : kinds.has('planIssue') ? 'plan' : 'discovery');
  const at = new Date().toISOString();
  ctx.t.drift = [...asList(ctx.t.drift), ...list.map((c) => ({ id: c.id, kind: c.kind, at, result, cause: cls, ...(c.round ? { round: c.round } : {}) }))];
  let planBase = null;
  // Architekt widział kod po zmianie celu: kolejne przyczyny `target` liczymy od bieżącego merge-base.
  if (kinds.has('target') || cls === 'target' || run.targetCheck) {
    run.planBase = mergeBase(top, run);
    delete run.targetCheck;
    planBase = run.planBase.slice(0, 7);
  }
  return { cause: cls, handled: list.length, planBase, planIssue: list.find((c) => c.kind === 'planIssue') ?? null };
}

// Replany zadania do raportu: wpisy `drift` pogrupowane po czasie zapisu.
export function replansOf(t) {
  const by = new Map();
  for (const d of asList(t.drift)) { if (!by.has(d.at)) by.set(d.at, { at: d.at, result: d.result, cause: d.cause, n: 0 }); by.get(d.at).n++; }
  return [...by.values()];
}

// ---------- kontrola celu (§5.7 pkt 0) ----------

export const GOAL_STATUS = ['delivered', 'out', 'gap'];
export function goalCheckInfo(root) {
  const file = join(root, 'goal-check.md');
  if (!existsSync(file)) return { ok: false, missing: true, errors: [] };
  const { h, errors: herr } = headerOf(read(file));
  if (herr) return { ok: false, errors: herr };
  const items = asList(h.items);
  const errors = [];
  if (!items.length) errors.push('items: brak elementów wejścia');
  items.forEach((x, i) => {
    if (!x || typeof x !== 'object') errors.push(`items[${i + 1}]: oczekiwano mapy {id, element, status, …}`);
    else if (!GOAL_STATUS.includes(x.status)) errors.push(`${x.id ?? `items[${i + 1}]`}: status ${x.status ?? '(brak)'}, dozwolone: ${GOAL_STATUS.join('|')}`);
  });
  if (errors.length) return { ok: false, errors };
  const count = (s) => items.filter((x) => x.status === s).length;
  // K5 D-13: the checker's `## Summary` (at most 4 plain lines in the user's language) opens the final report.
  const summary = (sectionBody(namedSection(read(file), 'Summary')) ?? '').split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').trim()).filter(Boolean).slice(0, 4);
  return { ok: true, errors: [], items, gaps: count('gap'), delivered: count('delivered'), out: count('out'), summary };
}

// Przed `finish` (v2.7, przy `plan.md`): brak albo zły `goal-check.md` → `dwmt-checker` (wejście wobec raportów, bez kodu).
export const GOAL_CHECK_TRIES = 3;
export function goalCheckState({ root, run, cfg, st, finalAc = null }) {
  if (!existsSync(join(root, 'plan.md'))) return null;
  const gc = goalCheckInfo(root);
  if (gc.ok) return null;
  // Limit prób: kolejne złe wyniki (różna treść pliku) liczymy w run.goalCheck; po GOAL_CHECK_TRIES przebieg idzie do finish,
  // a raport mówi, że kontrola celu jest niepoprawna (luki nieznane, uat: pending).
  if (!gc.missing) {
    const m = sha8(read(join(root, 'goal-check.md')));
    run.goalCheck = { invalid: unique([...asList(run.goalCheck?.invalid), m]) };
    if (run.goalCheck.invalid.length >= GOAL_CHECK_TRIES) return null;
  }
  const { rel, root: repo } = pathsFor(run, topOfRoot(root));
  const p = (...x) => rel(join(root, ...x));
  const answers = [join(root, 'answers.md'), ...asList(run.tasks).map((t) => join(taskDir(root, t.k), 'answers.md'))].filter(existsSync).map(rel);
  const reports = asList(run.tasks).map((t) => p('tasks', String(t.k), 'report.md'));
  const again = gc.missing ? '' : ` The existing output is invalid (${gc.errors.join('; ')}): rewrite it.`;
  // v2.8 (D): po angielsku, tylko przyczyny luk (trafiają na listę UAT) w języku użytkownika.
  const lang = is28(run) ? `Artifacts: English; gap reasons in the user's language: ${cfg.language}.` : `Language: ${cfg.language}.`;
  // K5 D-13 (2.12): the `## Summary` of the template, also in the user's language (the report opens with it).
  const summaryNote = is212(run) ? ` Write the ## Summary section (at most 4 plain lines in ${cfg.language}, no identifiers): what changed for the product, and what was not done and why.` : '';
  // v2.8: kontrola celu po rundzie zbiorczej widzi jej wynik (pozycje otwarte, poprawione).
  const batchRep = is28(run) && existsSync(join(root, 'batch', 'report.md')) ? ` Fix batch report: ${p('batch', 'report.md')}.` : '';
  // Przegląd 2026-10-04: kontrola celu działa przed pełną suitą `finish`, więc „brak dowodu pełnej suity” był fałszywą
  // luką. Pełna suita blokuje scalenie, gdy jest czerwona: element, któremu brakuje tylko jej przebiegu, jest dowieziony.
  const full = asList(cfg.verify?.full);
  const fullNote = full.length ? ` The full suite (${full.join('; ')}) runs after you, at finish, and a red result blocks the merge: an element whose only missing evidence is a run of these commands is delivered with evidence "full suite at finish", not a gap.` : '';
  // Przegląd 2026-10-09 (W-6): phase-5 30 fałszywych luk (raport T-1 sprzed partii poprawek: AC-4, AC-5 partial; po partii
  // met), sprint 12: 5 luk (szablony przeniesione przez architekta do sprintu następczego, `second`, D-14).
  let ac = [];
  try { ac = asList(finalAc?.()); } catch { /* bez stanu końcowego: raporty zadań */ }
  const acNote = ac.length ? ` Final state of the sprint criteria after the fix batch (it supersedes the statuses in the task reports): ${ac.join('; ')}.` : '';
  const second = planInfo(root, run)?.h?.second;
  const secondNote = second ? ` The plan moves work to a planned follow-up sprint (second: ${String(second).slice(0, 300)}): an input element it moves there is \`out\` with the reason "planned follow-up sprint", not a gap.` : '';
  return {
    ...st, next: 'goal-check', agent: 'dwmt-checker', output: fwd(join(root, 'goal-check.md')),
    prompt: `Check the sprint goal before the merge.${again} ${repo}Task: ${p('task.md')}. Answers: ${answers.join(', ') || 'none'}. Plan: ${p('plan.md')} (read only ## Input coverage and ## Tasks). Task reports: ${reports.join(', ')}.${batchRep} Template: ${TPL('goal-check.md')}. Output: ${p('goal-check.md')}. ${lang}${summaryNote}${fullNote}${acNote}${secondNote}`,
    hint: gc.missing ? 'kontrola celu przed finish: wejście wobec raportów zadań, bez kodu' : `goal-check.md niepoprawny: ${gc.errors.join('; ')}`,
  };
}

// Uwagi recenzji z linią `- Cause: plan` (przejście correctness, §9 kryterium jakości).
export function planFindingIds(texts) {
  const out = [];
  for (const text of asList(texts)) {
    for (const m of String(text).matchAll(/^#{2,6}\s+(F-\d+)\b/gm)) {
      const sec = section(text, m[1]);
      if (sec && /^\s*[-*]?\s*\**Cause\**\s*:\s*\**\s*plan\b/im.test(sec)) out.push(m[1]);
    }
  }
  return unique(out);
}

// ---------- sizes.txt (§5.2 pkt 2) ----------

// Szacunek tokenów na katalog: `git ls-files` minus `review.ignoreGlobs`, bajty / 4, suma rekurencyjna; bez technologii.
const SIZES_DEPTH = 2;
const SIZES_MIN_TOKENS = 5000;
export function writeSizes(top, root, cfg) {
  const ignored = asList(cfg.review?.ignoreGlobs).map((g) => globToRegExp(String(g)));
  const files = git(['ls-files', '-z'], { cwd: top }).split('\0').filter((f) => f && !ignored.some((r) => r.test(f)));
  const dirs = new Map();
  const add = (d, size) => { const x = dirs.get(d) ?? { bytes: 0, files: 0 }; x.bytes += size; x.files++; dirs.set(d, x); };
  for (const f of files) {
    let size;
    try { size = statSync(join(top, f)).size; } catch { continue; }
    add('./', size);
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) add(`${parts.slice(0, i).join('/')}/`, size);
  }
  const k = (b) => `${(b / 4 / 1000).toFixed(1)}k`;
  // Projekt testowy: 827 katalogów (ok. 18k tokenów) przy każdym czytaniu; płytkie katalogi zawsze, głębsze tylko duże.
  const depth = (d) => d.split('/').length - 1;
  const rows = [...dirs].filter(([d, x]) => d === './' || depth(d) <= SIZES_DEPTH || x.bytes / 4 >= SIZES_MIN_TOKENS).sort(([a], [b]) => (a === './' ? -1 : b === './' ? 1 : a < b ? -1 : a > b ? 1 : 0))
    .map(([d, x]) => `${k(x.bytes).padStart(8)}  ${d}  (${x.files} files)`);
  const file = join(root, 'sizes.txt');
  writeFileSync(file, [
    '# dwmt sizes: estimated tokens (bytes / 4) per directory, recursive, of files tracked by git minus review.ignoreGlobs.',
    '# An area up to explore.selfReadMaxK the architect reads itself; a larger one goes to an explorer.',
    `# Listed: every directory up to depth ${SIZES_DEPTH}; deeper ones only from ${SIZES_MIN_TOKENS / 1000}k tokens (their size is included in their parents).`,
    ...rows, '',
  ].join('\n'));
  return fwd(file);
}

// ---------- explore/ (§5.2): odpowiedzi eksploratorów z transkryptów, best effort ----------

const blocks = (d) => { const c = d?.message?.content; return typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : []; };
const userText = (d) => (d?.type === 'user' ? blocks(d).filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '');

// Rundy jednego eksploratora: runda 1 od pierwszego wpisu, kolejne od wpisu `user` z `origin.kind: peer` (SendMessage);
// odpowiedź = `message` ostatniego `SubagentHandback` w rundzie (powtórzona odpowiedź poprzedniej rundy odpada, T-D3),
// zapas: ostatni tekst asystenta; runda bez odpowiedzi odpada.
export function explorerRounds(entries) {
  const rounds = [];
  let cur = null;
  entries.forEach((d, i) => {
    if (i === 0 || (d?.type === 'user' && d.origin?.kind === 'peer')) { cur = { start: d?.timestamp ?? null, handback: null, text: null, at: null }; rounds.push(cur); }
    if (d?.type !== 'assistant') return;
    for (const b of blocks(d)) {
      if (b.type === 'tool_use' && b.name === 'SubagentHandback' && b.input?.message) { cur.handback = String(b.input.message); cur.at = d.timestamp ?? cur.at; }
      else if (b.type === 'text' && b.text?.trim()) { cur.text = b.text; if (!cur.handback) cur.at = d.timestamp ?? cur.at; }
    }
  });
  const first = userText(entries[0]);
  const area = /^\s*Area:\s*([^.,;\r\n]+)/m.exec(first)?.[1]?.trim() ?? null;
  return { area, rounds: rounds.map((r) => ({ start: r.start, at: r.at, answer: r.handback ?? r.text })).filter((r) => r.answer?.trim()) };
}

function jsonl(file) {
  const out = [];
  for (const line of read(file).split(/\r?\n/)) { if (!line) continue; try { out.push(JSON.parse(line)); } catch { /* urwana linia */ } }
  return out;
}

// Kopia do `explore/<obszar>-r<N>.md` z nagłówkiem `dwmt/explore@1`; numeracja ciągła w obszarze po czasie startu rundy
// (świeży eksplorator po przerwie dostaje kolejne numery). Przetwarza tylko przy zmienionym mtime (`run.exploreSeen`), chyba że `force`.
export function copyExplore(root, run, { force = false } = {}) {
  const troot = process.env.DWMT_TRANSCRIPTS || join(homedir(), '.claude', 'projects');
  if (!existsSync(troot)) return 0;
  const found = [];
  for (const proj of readdirSync(troot)) {
    for (const sid of asList(run.session_ids)) {
      const subs = join(troot, proj, sid, 'subagents');
      if (!existsSync(subs)) continue;
      for (const f of readdirSync(subs).filter((x) => /^agent-.*\.jsonl$/.test(x))) {
        let meta = null;
        try { meta = JSON.parse(read(join(subs, f.replace(/\.jsonl$/, '.meta.json')))); } catch { /* brak meta */ }
        if (meta?.agentType !== 'dwmt-explorer') continue;
        found.push({ file: join(subs, f), sid, agent: f.slice('agent-'.length, -'.jsonl'.length), mtime: statSync(join(subs, f)).mtimeMs });
      }
    }
  }
  const seen = run.exploreSeen ?? {};
  const key = (x) => `${x.sid}/${x.agent}`;
  if (!found.length || (!force && found.every((x) => seen[key(x)] === x.mtime))) return 0;
  const byArea = new Map();
  for (const x of found) {
    const { area, rounds } = explorerRounds(jsonl(x.file));
    const slug = area ? slugify(area) : `explorer-${x.agent.slice(0, 6)}`;
    for (const r of rounds) { if (!byArea.has(slug)) byArea.set(slug, []); byArea.get(slug).push({ ...r, agent: x.agent, session: x.sid }); }
  }
  const dir = join(root, 'explore');
  const staleSince = run.afterDone ?? null;
  let written = 0;
  for (const [slug, rounds] of byArea) {
    rounds.sort((a, b) => String(a.start ?? '').localeCompare(String(b.start ?? '')));
    rounds.forEach((r, i) => {
      // Nieaktualne: ścieżki zmienione przez cel od planowania, które wymienia odpowiedź sprzed wyjścia z `planned`.
      const stale = staleSince && String(r.at ?? r.start ?? '') < staleSince ? asList(run.exploreStale).filter((p) => r.answer.includes(p)) : [];
      const text = withHeader({ schema: 'dwmt/explore@1', area: slug, round: i + 1, agent: r.agent, session: r.session, at: r.at ?? r.start, stale }, `\n${r.answer.trim()}\n`);
      const f = join(dir, `${slug}-r${i + 1}.md`);
      if (existsSync(f) && read(f) === text) return;
      mkdirSync(dir, { recursive: true });
      writeFileSync(f, text);
      written++;
    });
  }
  run.exploreSeen = Object.fromEntries(found.map((x) => [key(x), x.mtime]));
  return written;
}
