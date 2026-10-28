// dwmt: K4 (D-7, D-23–D-25, D-32): kontrole skryptu po każdym kroku wykonawcy w przebiegu 2.11 z planem sprintu.
// Zakres (plik poza `scope` bez powodu w `outOfScopeChanges`), asercje (mniej wywołań albo ścisły matcher zamieniony na
// słaby w pliku testu) i dodane znaczniki skip/only/disabled. Trafienie raz wraca do wykonawcy (naprawa rundy), potem idzie
// do recenzji jako `S-n [major]`; `recordScriptFindings` zapisuje je w recenzji z dyspozycją recenzenta.
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { changeItems, parseChange, anchorTokens, anchorOf } from '../plan.mjs';
import { findingSection, triageOf } from '../batch.mjs';
import { read, asList, str } from './util.mjs';
import { splitHeader, parseYaml, withHeader, tryHeader } from './headers.mjs';
import { splitPatch } from './risks.mjs';
import { git } from './git.mjs';
import { snapshotTree, diffParts, diffFilter } from './review.mjs';
import { isTestPath } from './verify-select.mjs';

// ---------- reguły (D-25: dane, heurystyka z wyboru) ----------

export const CHECK_CMD = 'dwmt checks: script';
// Wywołania asercji: `assert(`, `assert.equal(`, `assertThat(`, `self.assertEqual(`, `expect(`, `t.equal(` i podobne.
const ASSERT = /\b(?:assert\w*(?:\.\w+)*|expect|t\.(?:equal|notEqual|deepEqual|notDeepEqual|strictEqual|same|ok|notOk|is|not|true|false|throws|match))\s*\(/g;
const STRICT = /\b(?:strictEqual|deepStrictEqual|deepEqual|toBe|toEqual|toStrictEqual|assertEquals|isEqualTo)\s*\(|\.equal\s*\(/g;
const WEAK = /(?:\.|\b)(?:ok|toBeTruthy|toBeDefined|assertTrue|assertNotNull|isNotNull)\s*\(|\bassert\s*\(/g;
// Globalne `fit(`/`xit(` Jasmine tylko jako goła nazwa: `model.fit(X, y)` (sklearn, Keras) ani `$fit(` nie jest znacznikiem.
const SKIP = [
  /\.(?:skip|only|todo)\s*\(/g, /(?<![.\w$])(?:xit|xdescribe|fit|fdescribe)\s*\(/g, /\{\s*(?:skip|only)\s*:\s*true\s*\}/g,
  /@Disabled\b/g, /@Ignore\b/g, /@pytest\.mark\.skip/g, /@unittest\.skip/g, /\bt\.Skip\s*\(/g, /\[Fact\(\s*Skip/g,
];

// Treść literałów napisów nie liczy się (test o kontrolach zawiera `'.skip('` w napisie).
const code = (line) => line.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');
const hits = (line, re) => (code(line).match(re) || []).length;
const countAll = (lines, res) => lines.reduce((a, l) => a + asList(res).reduce((b, re) => b + hits(l, re), 0), 0);

// Linie usunięte i dodane fragmentu diffu jednego pliku (bez nagłówków `---`/`+++`).
export function chunkLines(text) {
  const removed = [];
  const added = [];
  let body = false;
  for (const l of String(text ?? '').split(/\r?\n/)) {
    if (l.startsWith('@@')) { body = true; continue; }
    if (!body) continue;
    if (l.startsWith('+')) added.push(l.slice(1));
    else if (l.startsWith('-')) removed.push(l.slice(1));
  }
  return { removed, added };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Czysta polityka (D-7, D-25). `chunks`: [{file, text}] z `splitPatch`; `planned`: Map pliku testu → tekst wpisu `[change]`
// albo `[remove]`, który go kotwiczy. Zwraca `{hits: [{key, kind, file, detail}], planned: [{file, detail, entry}]}`.
export function checkChange({ files = null, chunks = [], scope = [], reported = [], productDir = null, publish = null, testGlob = null, planned = new Map() } = {}) {
  const out = { hits: [], planned: [] };
  const all = files ?? chunks.map((c) => c.file);
  const parts = diffParts(all.filter((f) => !f.startsWith('.dwmt/')), { scope, reported, productDir, publish });
  for (const f of parts.outside) out.hits.push({ key: `scope:${f}`, kind: 'scope', file: f, detail: 'changed outside the task scope and not named in `outOfScopeChanges`' });
  for (const c of chunks) {
    if (!c.file || c.file.startsWith('.dwmt/') || !isTestPath(c.file, testGlob)) continue;
    const { removed, added } = chunkLines(c.text);
    const why = [];
    const lost = countAll(removed, ASSERT) - countAll(added, ASSERT);
    if (lost > 0) why.push(`${plural(lost, 'assertion')} removed`);
    if (countAll(removed, STRICT) > countAll(added, STRICT) && countAll(added, WEAK) > countAll(removed, WEAK)) why.push('a strict matcher replaced by a weak one');
    if (why.length) {
      const detail = why.join('; ');
      const entry = planned instanceof Map ? planned.get(c.file) : planned?.[c.file];
      if (entry) out.planned.push({ file: c.file, detail, entry });
      else out.hits.push({ key: `assert:${c.file}`, kind: 'assert', file: c.file, detail });
    }
    const marks = added.filter((l) => SKIP.some((re) => hits(l, re)));
    const skipped = countAll(added, SKIP) - countAll(removed, SKIP);
    if (skipped > 0) {
      out.hits.push({ key: `skip:${c.file}`, kind: 'skip', file: c.file, detail: `${plural(skipped, 'skip/only/disabled marker')} added: \`${marks[0].trim().slice(0, 120)}\`` });
    }
  }
  return out;
}

// ---------- wejścia z dysku ----------

const briefFiles = (ctx) => {
  if (!ctx.batch) return [join(ctx.dir, 'brief.md')];
  const tasks = join(ctx.root, 'tasks');
  return existsSync(tasks) ? readdirSync(tasks).sort((a, b) => Number(a) - Number(b)).map((k) => join(tasks, k, 'brief.md')) : [];
};

// Pliki testów kotwiczone przez `[change]`/`[remove]` planu zadania (runda zbiorcza: wszystkich planów zadań).
export function plannedTests(ctx, testGlob = null) {
  const out = new Map();
  for (const f of briefFiles(ctx).filter((x) => existsSync(x))) {
    for (const item of changeItems(read(f)) ?? []) {
      const c = parseChange(item);
      if (c.kind !== 'change' && c.kind !== 'remove') continue;
      for (const tok of anchorTokens(c.head)) {
        const a = anchorOf(tok);
        if (a && isTestPath(a.path, testGlob) && !out.has(a.path)) out.set(a.path, String(item).replace(/\s+/g, ' ').trim());
      }
    }
  }
  return out;
}

// Zakres zadania (runda zbiorcza: suma zakresów planów zadań), jak filtr diffu.
export const scopeOf = (ctx) => [...new Set(briefFiles(ctx).flatMap((f) => asList(tryHeader(f)?.scope).map(String)))];

// Kontrole na zmianie od punktu odniesienia zadania (bez `diffRun`: ten zapisuje diff.patch i stan przebiegu).
export function runScriptChecks(top, ctx, cfg) {
  const tree = snapshotTree(top);
  const chunks = splitPatch(git(['diff', '--no-color', '--no-ext-diff', ctx.t.baseline, tree], { cwd: top }));
  const filter = diffFilter(top, ctx);
  const testGlob = cfg.verify?.testFiles || null;
  return checkChange({ chunks, ...filter, testGlob, planned: plannedTests(ctx, testGlob) });
}

// ---------- verify (D-23) ----------

// Zapis wyniku rundy w stanie; zwraca linie sekcji `## Script checks` tests.md i czy runda jest przez nie czerwona.
export function applyChecks(t, round, checks) {
  const returned = new Set(asList(t.checksReturned));
  const fresh = checks.hits.filter((h) => !returned.has(h.key));
  const red = fresh.length > 0 && !t.repairs?.[round];
  const prev = t.checks?.[round];
  const now = red ? fresh.map((h) => h.key) : [];
  t.checks = { ...t.checks, [round]: { hits: checks.hits, planned: checks.planned, returned: [...new Set([...asList(prev?.returned), ...now])] } };
  if (red) t.checksReturned = [...returned, ...now];
  if (!checks.hits.length && !checks.planned.length) return { red, body: '' };
  const lines = ['## Script checks', ''];
  if (red) lines.push(`\`${CHECK_CMD}\` (exit 1): revert each change below, or for a file outside the scope name it in \`outOfScopeChanges\` (path first, then the reason). Never weaken or skip tests. This return happens once; what stays goes to the review as a major finding.`, '');
  else if (checks.hits.length) lines.push('Already returned once, or found after the round\'s repair: these go to the review as major findings.', '');
  for (const h of checks.hits) lines.push(`- ${h.kind}: \`${h.file}\` — ${h.detail}${returned.has(h.key) ? ' (returned before)' : ''}`);
  if (checks.planned.length) lines.push('', 'Planned changes to tests (a change entry of the task plan anchors the file):', ...checks.planned.map((x) => `- \`${x.file}\` — ${x.detail}; entry: ${x.entry}`));
  lines.push('', '');
  return { red, body: lines.join('\n') };
}

// Czy runda ma trafienia odesłane do wykonawcy (zdanie w prompcie naprawy).
export const checksReturned = (t, round) => asList(t?.checks?.[round]?.returned).length > 0;

// ---------- wejście recenzji (D-24, D-32) ----------

// Sekcja `## Script checks` wejścia recenzji: trafienia ostatniego verify rundy z identyfikatorami S-n (stałymi po kluczu),
// zapisane w `t.scriptFindings[round]`. `scope`: w rundzie zbiorczej suma zakresów zadań (wejście nie ma `## Scope`).
// Batch T-3/F-4: S-n, które wcześniejsza recenzja tego katalogu ostatnio odłożyła albo odrzuciła (nagłówek `defer`/`drop`),
// nie wracają w recheck jako nowe uwagi (brak linii znaczyłby `fix`); odłożone są już pozycjami rundy zbiorczej.
export function triagedScript(dir, round) {
  const last = {};
  for (let n = 1; dir && n < round; n++) {
    const h = tryHeader(join(dir, `review-${n}.md`));
    if (!h) continue;
    for (const k of ['fix', 'defer', 'drop']) for (const x of asList(h[k])) {
      const id = str(x).split(/\s/)[0].replace(/[:,;]+$/, '');
      if (/^S-\d+$/.test(id)) last[id] = k;
    }
  }
  return new Map(Object.entries(last).filter(([, k]) => k !== 'fix'));
}

export function scriptSection(t, round, { scope = null, dir = null } = {}) {
  const c = t.checks?.[round];
  if (!c || (!asList(c.hits).length && !asList(c.planned).length)) {
    if (t.scriptFindings?.[round]) t.scriptFindings = { ...t.scriptFindings, [round]: [] };
    return [];
  }
  const ids = { ...t.scriptIds };
  let seq = t.scriptSeq ?? 0;
  const all = asList(c.hits).map((h) => {
    if (!ids[h.key]) ids[h.key] = `S-${++seq}`;
    return { id: ids[h.key], kind: h.kind, file: h.file, detail: h.detail };
  });
  const triaged = triagedScript(dir, round);
  const list = all.filter((x) => !triaged.has(x.id));
  const before = all.filter((x) => triaged.has(x.id));
  t.scriptIds = ids;
  t.scriptSeq = seq;
  t.scriptFindings = { ...t.scriptFindings, [round]: list };
  const out = ['## Script checks', ''];
  if (before.length) out.push(`Hits triaged in an earlier round (not findings again here, write no line for them): ${before.map((x) => `${x.id} ${triaged.get(x.id)} (${x.kind}: \`${x.file}\`)`).join(', ')}.`, '');
  if (list.length) {
    out.push('The script checks each executor step for files changed outside the task scope without a reason in `outOfScopeChanges`, removed or weakened assertions, and added skip/only/disabled markers. The hits below stayed after the executor\'s one return. The script records each as a major finding in your review: write one pragmatism line per hit, `- S-n: fix|defer|drop — <reason>`; `drop` needs counter-evidence `file:line`, and no line counts as fix.', '');
    if (scope?.length && list.some((x) => x.kind === 'scope')) out.push(`Scope of the sprint's tasks (union of the task plans' scope globs): ${scope.map((g) => `\`${g}\``).join(', ')}.`, '');
    for (const x of list) out.push(`### ${x.id} [major] ${x.kind}: ${x.file}`, `- ${x.detail}`, '');
  }
  if (asList(c.planned).length) out.push('Planned changes to tests (a change entry of the task plan anchors the test file; judge the change against the entry, not as a finding by itself):', '', ...c.planned.map((x) => `- \`${x.file}\` — ${x.detail}; entry: ${x.entry}`), '');
  return out;
}

// ---------- recenzja (D-24) ----------

const COUNTER = /[\w./-]+:\d+/;
const SEV_HEAD = /\[(?:blocker|major|minor)\]/i;

// Zapis S-n rundy (ze stanu przebiegu, nie z wejścia recenzji) w review-N.md, raz (znacznik `scriptFindings`): sekcja
// `### S-n [major]`, identyfikator w `fix` (brak linii albo `fix`), `defer` (`defer`, `drop` bez `plik:linia`) albo `drop`.
export function recordScriptFindings(dir, t) {
  let changed = 0;
  for (let n = 1; existsSync(join(dir, `review-${n}.md`)); n++) {
    const list = asList(t?.scriptFindings?.[n]);
    if (!list.length) continue;
    const file = join(dir, `review-${n}.md`);
    const text = read(file);
    const s = splitHeader(text);
    if (!s) continue;
    let h;
    try { h = parseYaml(s.yaml); } catch { continue; }
    if (!h || h.scriptFindings !== undefined || h.schema !== 'dwmt/review@1') continue;
    let body = s.body;
    const lists = { fix: asList(h.fix).map(str), defer: asList(h.defer).map(str), drop: asList(h.drop).map(str) };
    const idOf = (x) => x.split(/\s/)[0].replace(/[:,;]+$/, '');
    let added = 0;
    let toFix = false;
    for (const x of list) {
      const tr = triageOf(body, x.id);
      const where = !tr || tr.triage === 'fix' ? 'fix' : tr.triage === 'drop' && COUNTER.test(tr.reason) ? 'drop' : 'defer';
      for (const k of Object.keys(lists)) lists[k] = lists[k].filter((y) => idOf(y) !== x.id);
      lists[where].push(x.id);
      if (where === 'fix') toFix = true;
      const sec = findingSection(body, x.id);
      if (!sec) {
        body = `${body.replace(/\s*$/, '\n')}\n### ${x.id} [major] ${x.kind}: ${x.file}\n- Evidence: \`${x.file}\`\n- ${x.detail}\n- Source: script check (not the reviewer's finding)\n`;
        added++;
      } else if (!SEV_HEAD.test(sec.split(/\r?\n/)[0])) {
        const head = sec.split(/\r?\n/)[0];
        body = body.replace(head, head.replace(x.id, `${x.id} [major]`));
        added++;
      }
    }
    const out = { ...h, ...lists, ...(toFix ? { verdict: 'FIX' } : {}) };
    if (added) out.counts = { ...(h.counts && typeof h.counts === 'object' ? h.counts : {}), major: Number(h.counts?.major ?? 0) + added };
    out.scriptFindings = list.map((x) => x.id);
    writeFileSync(file, withHeader(out, body));
    changed++;
  }
  return changed;
}
