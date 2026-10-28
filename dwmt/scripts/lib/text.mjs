// dwmt: globy, perspektywy recenzji, przycinanie outputu.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './util.mjs';

// ---------- globy, perspektywy, przycinanie outputu ----------

export const esc = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
export function globToRegExp(glob) {
  return new RegExp(`^${globSource(glob)}$`);
}
function globSource(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{' && glob.indexOf('}', i) > i) {
      const end = glob.indexOf('}', i);
      re += `(?:${glob.slice(i + 1, end).split(',').map(globSource).join('|')})`;
      i = end;
    } else re += esc(c);
  }
  return re;
}

export const LENSES = () => readdirSync(join(ROOT, 'templates', 'lenses')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));

export function pickLenses({ risk = [], changed = [], lensGlobs = {}, max = 2, available = LENSES() }) {
  const fixed = ['correctness', 'pragmatism', 'risks'];
  const picked = [];
  for (const r of risk) if (available.includes(r) && !fixed.includes(r) && !picked.includes(r)) picked.push(r);
  const scored = Object.entries(lensGlobs)
    .filter(([lens]) => available.includes(lens) && !fixed.includes(lens) && !picked.includes(lens))
    .map(([lens, globs]) => [lens, changed.filter((f) => globs.some((g) => globToRegExp(g).test(f))).length])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  for (const [lens] of scored) picked.push(lens);
  return ['correctness', ...picked.slice(0, max), 'pragmatism'];
}

const NOISE = [
  /^warning: (in the working copy of|LF will be replaced|CRLF will be replaced)/i,
  /^Picked up (JAVA_TOOL_OPTIONS|_JAVA_OPTIONS)/,
  /^\s*$/,
];
export function trimOutput(text, max = 40, width = 300) {
  const lines = String(text).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n/).filter((l) => !NOISE.some((r) => r.test(l)));
  return {
    lines: lines.slice(-max).map((l) => (l.length > width ? `${l.slice(0, width)}…` : l)),
    dropped: Math.max(0, lines.length - max),
  };
}
