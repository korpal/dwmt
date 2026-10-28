// dwmt: wybór komend verify w rundach poprawek i naprawy oraz zamykające verify całej listy (kt, D-4, D-13, D-14, D-18).
// Same decyzje, bez gita, plików i procesów: cmdVerify, state i commit zbierają drzewa, pliki i stan przebiegu.
import { globToRegExp } from './text.mjs';

const isAbs = (p) => /^[a-zA-Z]:\//.test(p) || p.startsWith('/');

// Jedna lokalna postać ścieżki (D-10): bez `file://`, względna do `top`, `/`, bez wiodącego `./`, małe litery na win32.
export function normPath(p, top, platform = process.platform) {
  let s = String(p ?? '').trim();
  if (/^file:\/\//i.test(s)) {
    s = s.replace(/^file:\/\//i, '');
    try { s = decodeURIComponent(s); } catch { /* zostaje jak jest */ }
    if (/^\/[a-zA-Z]:\//.test(s)) s = s.slice(1);
  }
  s = s.replace(/\\/g, '/');
  const win = platform === 'win32';
  const t = top ? String(top).replace(/\\/g, '/').replace(/\/+$/, '') : '';
  if (t && isAbs(s)) {
    const [a, b] = win ? [s.toLowerCase(), t.toLowerCase()] : [s, t];
    if (a === b) s = '';
    else if (a.startsWith(`${b}/`)) s = s.slice(t.length + 1);
  }
  while (s.startsWith('./')) s = s.slice(2);
  return win ? s.toLowerCase() : s;
}

// Tokeny komendy: odstępy dzielą, `"…"` i `'…'` grupują (wartość bez cudzysłowów, backslash dosłownie).
export function splitCommand(cmd) {
  const out = [];
  const s = String(cmd ?? '');
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    const start = i;
    let value = '';
    while (i < s.length && !/\s/.test(s[i])) {
      const c = s[i];
      if (c === '"' || c === "'") {
        const end = s.indexOf(c, i + 1);
        if (end < 0) { value += s.slice(i + 1); i = s.length; break; }
        value += s.slice(i + 1, end);
        i = end + 1;
      } else { value += c; i++; }
    }
    out.push({ raw: s.slice(start, i), value });
  }
  return out;
}

// Czerwone pliki z wyjścia komendy: grupa 1 (albo całe dopasowanie) każdego trafienia, po normalizacji, bez powtórzeń.
export function redFiles(output, regex, top, platform = process.platform) {
  if (!regex || !output) return [];
  const files = [...String(output).matchAll(new RegExp(regex, 'g'))].map((m) => normPath(m[1] ?? m[0], top, platform)).filter(Boolean);
  return [...new Set(files)];
}

const testMatcher = (testGlob, platform) => {
  if (!testGlob) return null;
  const re = globToRegExp(platform === 'win32' ? String(testGlob).toLowerCase() : String(testGlob));
  return (p) => re.test(p);
};

// K4 (C-3): plik testu. Z globem `verify.testFiles` decyduje glob (jak w `testMatcher`); bez niego wbudowany wzorzec:
// `*.test.*` i `*.spec.*` plików js/ts, Java i Kotlin `*Test`, `*Tests`, `*IT`, Python `test_*.py` i `*_test.py`,
// Go `*_test.go`, C# `*Tests.cs`. Ścieżka względna z `/` (ukośniki odwrotne są zamieniane).
const TEST_NAME = [
  /\.(?:test|spec)\.(?:js|mjs|cjs|jsx|ts|tsx)$/,
  /(?:Test|Tests|IT)\.(?:java|kt)$/,
  /^test_[^/]*\.py$/,
  /_test\.py$/,
  /_test\.go$/,
  /Tests\.cs$/,
];
export function isTestPath(path, testGlob = null) {
  const p = String(path ?? '').replace(/\\/g, '/');
  if (!p) return false;
  if (testGlob) return globToRegExp(String(testGlob)).test(p);
  const name = p.split('/').pop();
  return TEST_NAME.some((re) => re.test(name));
}

// Plan na komendę: run (całość), narrow (tylko część plików testów), rerun (`rerunCmd` na czerwony plik), carry (wynik
// poprzedniego verify). `prev`: komendy poprzedniego verify `[{cmd, exit, red}]`; `changed`: pliki zmienione od niego.
export function selectRuns({ cmds, prev = [], changed = [], testGlob = null, rerunCmd = null, top = '', platform = process.platform }) {
  const isTest = testMatcher(testGlob, platform);
  const norm = (p) => normPath(p, top, platform);
  const changedSet = new Set(changed.map(norm));
  const prevBy = new Map(prev.map((p) => [p.cmd, p]));
  const named = new Set();
  const selection = cmds.map((cmd) => {
    const tokens = splitCommand(cmd);
    const tests = isTest ? tokens.map((t, i) => ({ i, file: norm(t.value) })).filter((x) => x.file && isTest(x.file)) : [];
    for (const x of tests) named.add(x.file);
    const p = prevBy.get(cmd);
    if (!p) return { cmd, mode: 'run', runs: [cmd], files: [] };
    const narrow = (keep) => {
      const keepIdx = new Set(tests.filter((x) => keep.has(x.file)).map((x) => x.i));
      if (keepIdx.size === tests.length) return { cmd, mode: 'run', runs: [cmd], files: [] };
      const testIdx = new Set(tests.map((x) => x.i));
      const text = tokens.filter((t, i) => !testIdx.has(i) || keepIdx.has(i)).map((t) => t.raw).join(' ');
      return { cmd, mode: 'narrow', runs: [text], files: tests.filter((x) => keepIdx.has(x.i)).map((x) => x.file) };
    };
    const changedArgs = new Set(tests.filter((x) => changedSet.has(x.file)).map((x) => x.file));
    if (p.exit === 0) return changedArgs.size ? narrow(changedArgs) : { cmd, mode: 'carry', runs: [], files: [] };
    const red = (p.red ?? []).map(norm).filter(Boolean);
    const redArgs = red.filter((f) => tests.some((x) => x.file === f));
    if (red.length && redArgs.length) return narrow(new Set([...redArgs, ...changedArgs]));
    // `testFiles` null = command level only (D-4): no per-file rerun either.
    if (isTest && red.length && !tests.length && rerunCmd) {
      return { cmd, mode: 'rerun', runs: red.map((f) => rerunCmd.replace('{file}', `"${f}"`)), files: red };
    }
    return { cmd, mode: 'run', runs: [cmd], files: [] };
  });
  const changedUnrun = isTest ? [...changedSet].filter((f) => isTest(f) && !named.has(f)) : [];
  return { selection, changedUnrun, runs: selection.flatMap((s) => s.runs) };
}

// Jeden wpis na zaplanowaną komendę (D-14). `results`: wyniki `runs` w kolejności spłaszczonej selekcji.
export function mergeResults(selection, results, prevByCmd, regex, top, platform = process.platform) {
  let i = 0;
  const reds = (r) => (r.exit !== 0 ? redFiles(r.output, regex, top, platform) : []);
  const entries = selection.map((s) => {
    const rs = results.slice(i, i + s.runs.length);
    i += s.runs.length;
    if (s.mode === 'carry') {
      const p = prevByCmd instanceof Map ? prevByCmd.get(s.cmd) : prevByCmd?.[s.cmd];
      return { cmd: s.cmd, exit: p?.exit ?? 0, ms: 0, carried: true, red: [] };
    }
    if (s.mode === 'rerun') {
      const exit = rs.find((r) => r.exit !== 0)?.exit ?? 0;
      return {
        cmd: s.cmd, exit, ms: rs.reduce((a, r) => a + (r.ms ?? 0), 0), ran: s.runs.join(' ; '), narrowed: s.files,
        red: s.files.filter((f, k) => rs[k] && rs[k].exit !== 0), ...(rs.some((r) => r.flaky) ? { flaky: rs.find((r) => r.flaky).flaky } : {}),
        ...(rs.some((r) => r.heavy) ? { heavy: true } : {}),
      };
    }
    const r = rs[0];
    return { ...r, cmd: s.cmd, red: reds(r), ...(s.mode === 'narrow' ? { ran: s.runs[0], narrowed: s.files } : {}) };
  });
  return { entries, whole: selection.every((s) => s.mode === 'run') };
}

// Zamykające verify (D-13): `record` = ostatnie verify całej listy, `cur` = bieżące drzewo.
export function closingDecision({ record, cur, accepted = false, repairPending = false, closingRuns = 0 }) {
  if (!record) return 'commit';
  if (record.tree !== cur) return closingRuns >= 3 ? 'ask' : 'verify';
  if (record.ok || accepted || !record.closing) return 'commit';
  if (record.repair && repairPending) return 'repair';
  return 'ask';
}
