// dwmt: pliki z nagłówków `delete` (zgoda użytkownika, `delete-consent`) i katalog roboczy wykonawców.
import { rmSync, lstatSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fwd, asList } from './util.mjs';
import { tryHeader } from './headers.mjs';
import { deleteErrors } from './risks.mjs';
import { gitRaw } from './git.mjs';
import { runDir, taskDir, loadRun, saveRun, sprintCount } from './run.mjs';

// v2.10 (B): pliki do usunięcia z nagłówków `delete` planów zadań od k; usuwa je skrypt za zgodą użytkownika (`delete-consent`),
// nigdy wykonawca. `run.deletions`: {asked, approved, declined, at}.
// v2.10 (decyzja użytkownika 2026-10-03): pliki z nagłówka `delete` planu sprintu (k: null) idą do zgody w turze pytań architekta.
export function planDeletes(root, run, from = run.task ?? 1) {
  const out = [];
  for (const f of asList(tryHeader(join(root, 'plan.md'))?.delete)) if (typeof f === 'string' && !out.some((x) => x.file === f)) out.push({ k: null, file: f });
  const n = run.count ?? sprintCount(root, run);
  for (let k = from; k <= Math.max(n, from); k++) {
    for (const f of asList(tryHeader(join(taskDir(root, k), 'brief.md'))?.delete)) if (typeof f === 'string' && !out.some((x) => x.file === f)) out.push({ k, file: f });
  }
  return out;
}
export const pendingDeletes = (root, run) => {
  const asked = new Set(asList(run.deletions?.asked));
  return planDeletes(root, run).filter((x) => !asked.has(x.file));
};
export const deleteLabel = (x) => (x.k ? `T-${x.k} ${x.file}` : x.file);
// Plik z `delete` bezpieczny do usunięcia: pełna ścieżka wewnątrz drzewa, poza .git i .dwmt, zwykły plik śledzony przez git
// (nigdy katalog). Zwraca powód odmowy albo null; plik, którego nie ma, nie ma powodu.
export function deletePathError(top, f) {
  const s = String(f);
  const e = deleteErrors({ delete: [s] });
  if (e.length) return e[0];
  const rel = relative(resolve(top), resolve(top, s));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return `delete: ${s} poza repo`;
  let st;
  try { st = lstatSync(resolve(top, s)); } catch { return null; }
  if (!st.isFile() && !st.isSymbolicLink()) return `delete: ${s} nie jest plikiem`;
  if (gitRaw(['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', fwd(rel)], { cwd: top }).status !== 0) return `delete: ${s} nie jest śledzony przez git`;
  return null;
}
// Usunięcie z drzewa roboczego (zatwierdza je `git add -A` przy commicie zadania): `removed` i `refused` (zostają).
export function removeFiles(top, files) {
  const removed = [];
  const refused = [];
  for (const f of files) {
    try { lstatSync(resolve(top, String(f))); } catch { continue; }
    if (deletePathError(top, f)) { refused.push(f); continue; }
    rmSync(resolve(top, String(f)), { force: true });
    removed.push(f);
  }
  return { removed, refused };
}
// v2.10: katalog roboczy wykonawców na skrypty pomocnicze i zrzuty (`.dwmt/` jest w .git/info/exclude); opróżnia go commit.
const scratchDir = (top) => join(top, '.dwmt', 'scratch');
export function emptyScratch(top) {
  try { rmSync(scratchDir(top), { recursive: true, force: true, maxRetries: 3 }); } catch { /* plik zajęty: następny commit */ }
}

// v2.10 (B): zgoda użytkownika na usunięcie plików z `delete` (wszystkie, o które pytał `ask-delete`).
export function cmdDeleteConsent(top, id, opts) {
  const run = loadRun(top, id);
  const root = runDir(top, id);
  if (!opts.yes === !opts.no) throw new Error('podaj --yes (usuń) albo --no (zostaw)');
  const pending = pendingDeletes(root, run).map((x) => x.file);
  const d = run.deletions ?? { asked: [], approved: [], declined: [] };
  run.deletions = {
    asked: [...new Set([...asList(d.asked), ...pending])],
    approved: [...new Set([...asList(d.approved), ...(opts.yes ? pending : [])])],
    declined: [...new Set([...asList(d.declined), ...(opts.no ? pending : [])])],
    at: new Date().toISOString(),
  };
  saveRun(top, run);
  return { ok: true, [opts.yes ? 'approved' : 'declined']: pending, hint: opts.yes ? 'state: skrypt usuwa pliki na starcie ich zadania' : 'state: pliki zostają, raport pokaże kryterium jako niespełnione' };
}
