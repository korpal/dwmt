// Okna konsoli na Windows: procesy w tle (sterownik, supervisor, `dwmt live`) startują bez konsoli (`detached`),
// więc każdy proces potomny bez `windowsHide` dostaje własne okno, które miga na ekranie (2026-10-16: `git worktree list`
// z widoku live co kilka sekund). Każde wywołanie spawn/spawnSync w scripts/ i hooks/ ma `windowsHide: true`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from '../scripts/lib/util.mjs';

// Wywołania tylko poza Windows (macOS, Linux): okna konsoli tam nie ma.
const POSIX_ONLY = ['caffeinate', 'systemd-inhibit', 'ps'];

const files = (d) => readdirSync(d).flatMap((n) => {
  const f = join(d, n);
  return statSync(f).isDirectory() ? files(f) : /\.(mjs|js|cjs)$/.test(n) ? [f] : [];
});

// Tekst wywołania od nawiasu otwierającego do domykającego (bez analizy napisów: wystarcza dla tego kodu).
function callText(src, at) {
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(at, i + 1);
  }
  return src.slice(at);
}

test('spawn i spawnSync w scripts/ i hooks/ ukrywają okno konsoli (windowsHide)', () => {
  const missing = [];
  for (const f of ['scripts', 'hooks'].flatMap((d) => files(join(ROOT, d)))) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\bspawn(?:Sync)?\(/g)) {
      const call = callText(src, m.index + m[0].length - 1);
      if (POSIX_ONLY.some((b) => call.startsWith(`('${b}'`))) continue;
      // Opcje ze zmiennej (`opts`): zmienna zdefiniowana w tym pliku z windowsHide.
      const vars = [...call.matchAll(/\b(\w+)\b/g)].map((x) => x[1]);
      const viaVar = vars.some((v) => new RegExp(`\\b(?:const|let)\\s+${v}\\s*=\\s*\\{[^}]*windowsHide:\\s*true`).test(src));
      if (!/windowsHide:\s*true/.test(call) && !viaVar) {
        missing.push(`${relative(ROOT, f).replace(/\\/g, '/')}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});
