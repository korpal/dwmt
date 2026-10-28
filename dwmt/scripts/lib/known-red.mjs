// dwmt: czerwień znana z wcześniejszych zadań przebiegu.
// Przegląd sprintu 16 (UI) (2026-10-05): dwa e2e czerwone już na bazie; T-3 i T-4 przypisały je innej przyczynie (`unrelatedRed`),
// ich recenzje to sprawdziły, a mimo to runda zbiorcza dostała naprawę (0,25 mln), recenzje i wykonawcy badali je od nowa.
// Twierdzenia zadań już zatwierdzonych (commit po recenzji) przechodzą do kolejnych zadań i rundy zbiorczej: verify nie
// woła naprawy, gdy czerwone są tylko te komendy, wykonawca ich nie bada, a recenzja nadal sprawdza je wobec diffu.
import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { asList, str, read, writeFileAtomic } from './util.mjs';
import { tryHeader } from './headers.mjs';
import { taskDir, isLegacy } from './run.mjs';
import { sprintChangedFiles } from './git.mjs';

// Wszystkie twierdzenia zatwierdzonych zadań z plikiem wyniku, w którym stoją (`tasks/k/<plik>`).
function allKnownRed(root, run, beforeK) {
  if (isLegacy(run)) return [];
  const out = [];
  for (const t of asList(run.tasks)) {
    if (!t.commit || t.k >= beforeK) continue;
    const dir = taskDir(root, t.k);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((n) => /^(result|repair)-\d+\.md$/.test(n)).sort()) {
      for (const x of asList(tryHeader(join(dir, f))?.unrelatedRed)) {
        const claim = str(x);
        if (!out.some((o) => o.claim === claim)) out.push({ k: t.k, claim, file: f });
      }
    }
  }
  return out;
}

// `beforeK`: tylko zadania o numerze mniejszym (zadanie k); bez niego wszystkie zatwierdzone (runda zbiorcza).
// W rundzie zbiorczej czerwień, która jest jej pozycją (`known-red`), nie jest już znana: wykonawca ją naprawia, verify
// bez niej woła naprawę, recenzja sprawdza ją jak każdą pozycję.
export function knownRed(root, run, beforeK = Infinity) {
  const fixing = beforeK === Infinity ? new Set(asList(run.batch?.items).filter((x) => x.reason === 'known-red').map((x) => x.claim)) : new Set();
  return allKnownRed(root, run, beforeK).filter((x) => !fixing.has(x.claim)).map(({ k, claim }) => ({ k, claim }));
}

// Nazwy plików testów, które twierdzenie wskazuje („<komenda>: <powód>”): najpierw z powodu (komenda e2e albo Maven
// wymienia często kilka plików, a czerwony jest jeden), bez nich z komendy. Spec/test JS/TS albo klasa testu Javy.
const TEST_NAME = /[\w.-]+\.(?:spec|test)\.[cm]?[jt]sx?\b|\b[A-Z]\w*(?:Test|Tests|IT)\b/g;
export function redTestNames(claim) {
  const s = str(claim).trim();
  const tick = /^`([^`]+)`\s*:?\s*([\s\S]*)$/.exec(s);
  const [cmd, why] = tick ? [tick[1], tick[2]] : [s.split(/:\s/)[0], s.split(/:\s/).slice(1).join(': ')];
  const names = (t) => [...new Set([...t.matchAll(TEST_NAME)].map((m) => (/\./.test(m[0]) ? m[0].split('/').pop() : `${m[0]}.java`)))];
  const fromWhy = names(why);
  return fromWhy.length ? fromWhy : names(cmd);
}

// Przegląd a6 (2026-10-06): e2e `s3_031a_areaOpen` było czerwone już na bazie (stara liczba w teście), zadanie T-7
// i recenzje uznały je za znane, ale sprint zmienił ten plik spec, więc `finish` (e2e zmienionych plików) stanął na
// czerwieni, a PO pytał użytkownika (29 min) o poprawkę jednej linii. Decyzja użytkownika: znana czerwień w pliku testu,
// który sprint zmienia, idzie do rundy zbiorczej jako pozycja do naprawy. Czerwień w plikach nietkniętych zostaje znana.
export function knownRedToFix(top, root, run) {
  const list = allKnownRed(root, run, Infinity);
  if (!list.length) return [];
  let changed;
  try { changed = sprintChangedFiles(top, run); } catch { return []; }
  if (!changed.length) return [];
  const out = [];
  for (const x of list) {
    const names = redTestNames(x.claim);
    const files = changed.filter((f) => names.includes(f.split('/').pop()));
    if (files.length) out.push({ ...x, files });
  }
  return out;
}

export const knownRedClaims = (list) => list.map((x) => x.claim);

// Dopisek do promptu wykonawcy: znanej czerwieni nie bada ani nie naprawia.
export function knownRedPrompt(list) {
  if (!list.length) return '';
  return ` Known red from earlier tasks of this sprint (their reviews accepted it as not caused by their change): ${list.slice(0, 8).map((x) => `T-${x.k}: ${x.claim.slice(0, 300)}`).join(' | ')}${list.length > 8 ? ` (+${list.length - 8} more)` : ''}. Do not investigate or fix it; if it is still red after your change, copy its entry into \`unrelatedRed\` unchanged. Any other red in the same command is yours.`;
}

// Sekcja wejścia recenzji: recenzja nadal sprawdza, czy diff nie dołożył czerwieni w tych komendach.
export function knownRedSection(list) {
  if (!list.length) return [];
  return ['## Red tests known from earlier tasks (accepted by their reviews)', '', ...list.map((x) => `- T-${x.k}: ${x.claim}`), '',
    'Do not investigate their cause again. Check only that `tests.md` shows no other failure in these commands than the known one: a new failure there is a finding.', ''];
}

// ---------- K5 D-17: project registry of accepted red (outlives the run, so not run.json) ----------
// `<home tree>/.dwmt/known-red.json`: {schema, entries: [{key, cmd, file|null, reason, run, sprint, at, expires, item}]};
// the key is `<cmd>` or `<cmd> :: <file>`. `DWMT_NOW` (ISO) is the clock seam for tests.
const registryFile = (home) => join(home, '.dwmt', 'known-red.json');
export const nowMs = (env = process.env) => (env.DWMT_NOW && Number.isFinite(Date.parse(env.DWMT_NOW)) ? Date.parse(env.DWMT_NOW) : Date.now());
export const redKey = (cmd, file = null) => (file ? `${cmd} :: ${file}` : String(cmd));

export function loadKnownRed(home) {
  try { return asList(JSON.parse(read(registryFile(home))).entries); } catch { return []; }
}
function saveKnownRed(home, entries) {
  mkdirSync(join(home, '.dwmt'), { recursive: true });
  writeFileAtomic(registryFile(home), `${JSON.stringify({ schema: 'dwmt/known-red@1', entries }, null, 2)}\n`);
}

// Red units of a failed full suite: its red test files (`run.fullVerify.red[cmd]`, by `verify.failedFileRegex`), else the
// command itself.
export function redUnits(fullVerify) {
  const red = fullVerify?.red ?? {};
  return asList(fullVerify?.failed).flatMap((cmd) => (asList(red[cmd]).length
    ? asList(red[cmd]).map((file) => ({ key: redKey(cmd, file), cmd, file }))
    : [{ key: redKey(cmd), cmd, file: null }]));
}

// `finish --accept-red`: one entry per red unit, expiring after `days`; `item(entry)` → owner item id (product layer) or
// null. An entry accepted again keeps its owner item and gets a new expiry.
export function acceptKnownRed(home, units, { reason = null, run = null, sprint = null, days = 7, now = nowMs(), item = () => null } = {}) {
  const entries = loadKnownRed(home);
  const at = new Date(now).toISOString();
  const expires = new Date(now + Number(days) * 864e5).toISOString();
  const out = [];
  for (const u of units) {
    const old = entries.find((e) => e.key === u.key);
    const e = { key: u.key, cmd: u.cmd, file: u.file ?? null, reason, run, sprint, at, expires, item: old?.item ?? null };
    if (!e.item) { try { e.item = item(e) ?? null; } catch { e.item = null; } }
    if (old) Object.assign(old, e); else entries.push(e);
    out.push(e);
  }
  saveKnownRed(home, entries);
  return out;
}

// Later finishes: every unit with an unexpired entry is covered; a unit without one is uncovered; an expired entry blocks.
export function knownRedVerdict(entries, units, now = nowMs()) {
  const covered = [];
  const uncovered = [];
  const expired = [];
  for (const u of units) {
    const e = asList(entries).find((x) => x.key === u.key);
    if (!e) uncovered.push(u.key);
    else if (!(Date.parse(e.expires) > now)) expired.push(e);
    else covered.push(e);
  }
  return { covered, uncovered, expired };
}

// A unit that passes again loses its entry (its owner item stays for the PO): entries of commands that ran in this suite
// and are no longer red (the whole command green, or its red files listed without this one). → dropped entries.
export function dropGreenKnownRed(home, ranCmds, units) {
  const entries = loadKnownRed(home);
  if (!entries.length) return [];
  const ran = new Set(asList(ranCmds));
  const keys = new Set(units.map((u) => u.key));
  const byFiles = new Set(units.filter((u) => u.file).map((u) => u.cmd));
  const redCmds = new Set(units.map((u) => u.cmd));
  const drop = entries.filter((e) => ran.has(e.cmd) && !keys.has(e.key) && (!redCmds.has(e.cmd) || byFiles.has(e.cmd)));
  if (drop.length) saveKnownRed(home, entries.filter((e) => !drop.includes(e)));
  return drop;
}
