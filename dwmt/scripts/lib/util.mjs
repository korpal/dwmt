// dwmt: wspólne drobne pomocniki skryptów (bez importów projektu, więc bez cykli przy starcie modułów).
import { readFileSync, writeFileSync, renameSync, rmSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const fwd = (p) => String(p).replace(/\\/g, '/');
export const read = (f) => readFileSync(f, 'utf8');

export const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

export const str = (x) => (typeof x === 'string' ? x : JSON.stringify(x));

// Canonical tree path (C-1): absolute, `realpathSync.native` when the path exists (8.3 short names and letter case as on
// disk), else `resolve`; forward slashes; no trailing slash except a drive or filesystem root (`C:/`, `/`). Not memoised:
// a path may come into existence after a first call.
export function canonPath(p) {
  const abs = resolve(String(p));
  let real = abs;
  try { real = realpathSync.native(abs); } catch { /* missing path: resolve form */ }
  const f = fwd(real);
  return /^[A-Za-z]:\/$|^\/$/.test(f) ? f : f.replace(/\/+$/, '') || '/';
}
// Map, set and hash key of a tree path: canonPath, lower-cased on win32 only.
export const pathKey = (p) => (process.platform === 'win32' ? canonPath(p).toLowerCase() : canonPath(p));
// Two spellings of one tree (short/long name, slashes, letter case on win32); never throws for a missing path.
export const samePath = (a, b) => pathKey(a) === pathKey(b);

export const printJson = (o) => console.log(`{\n${Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n}`);

// Zapis atomowy przez plik tymczasowy i rename (czytelnik w trakcie zapisu widzi stary albo nowy plik, nigdy ucięty).
// Windows: rename na otwarty właśnie plik docelowy daje EPERM/EBUSY/EACCES, więc ponowienia co 25 ms, na końcu zwykły zapis.
// `rename` do podmiany w testach.
export function writeFileAtomic(f, text, { rename = renameSync } = {}) {
  const tmp = `${f}.${process.pid}.tmp`;
  try { writeFileSync(tmp, text); } catch { return writeFileSync(f, text); }
  for (let i = 0; ; i++) {
    try { return rename(tmp, f); } catch (e) {
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { rmSync(tmp, { force: true }); return writeFileSync(f, text); }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}
