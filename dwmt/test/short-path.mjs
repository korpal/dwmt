// C-3: the 8.3 short alias of an existing directory on win32 (cmd's `%~sI`), null off win32, on failure or when the
// volume has no short names (alias equals the long form). Not fsutil (needs admin rights) and not PowerShell (slow start).
import { spawnSync } from 'node:child_process';

const fwd = (p) => String(p).replace(/\\/g, '/');

export function shortAlias(dir) {
  if (process.platform !== 'win32') return null;
  const r = spawnSync('cmd', ['/d', '/s', '/c', `"for %I in ("${dir}") do @echo %~sI"`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true });
  const alias = String(r.stdout ?? '').trim();
  if (r.status !== 0 || !alias || fwd(alias).toLowerCase() === fwd(dir).toLowerCase()) return null;
  return alias;
}
