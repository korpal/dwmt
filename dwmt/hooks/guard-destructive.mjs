// dwmt: PreToolUse (Bash i PowerShell) blokujący komendy destrukcyjne (specyfikacja §8).
// Mały plik bez ciężkich importów: dokłada ok. 0,15 s do każdego wywołania (capabilities.md T13).
// T-4: blokuje w sesjach przebiegu (env DWMT_RUN albo session_id w otwartym run.json); `guard.scope` run|repo|always.
import { pathToFileURL } from 'node:url';
import { resolve, join, dirname, basename } from 'node:path';
import { readFileSync, readdirSync, statSync } from 'node:fs';

const GIT = /(?:^|[\s&(])(?:[^\s"'&|;]*[\\/])?git(?:\.exe)?((?:\s+(?:-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|--?[\w-]+(?:=\S+)?))*)\s+([\w-]+)(.*)$/i;
const RM = /(?:^|[\s&(])(?:[^\s"'&|;]*[\\/])?(rm|remove-item|ri|del|erase|rd|rmdir)(?:\.exe)?(?:\s+(.*))?$/i;

function gitRule(sub, rest) {
  switch (sub.toLowerCase()) {
    case 'push': return 'git push';
    case 'reset': return /\s--hard\b/.test(rest) ? 'git reset --hard' : null;
    case 'checkout':
      if (/\s(?:-f|--force)\b/.test(rest)) return 'git checkout -f';
      return /^(?:\s+--)?\s+\.(?:\s|$)|\s--\s+\.(?:\s|$)/.test(rest) ? 'git checkout .' : null;
    case 'restore': {
      const onlyStaged = /\s(?:--staged|-S)\b/.test(rest) && !/\s(?:--worktree|-W)\b/.test(rest);
      return /(?:^|\s)\.(?:\s|$)/.test(rest) && !onlyStaged ? 'git restore .' : null;
    }
    case 'clean': return /\s(?:-[a-zA-Z]*f[a-zA-Z]*|--force)\b/.test(rest) ? 'git clean -f' : null;
    case 'stash': return /^\s+(?:list|show)\b/.test(rest) ? null : 'git stash';
    case 'branch':
      return /\s-[a-zA-Z]*D|\s-[a-zA-Z]*(?:d[a-zA-Z]*f|f[a-zA-Z]*d)|\s--delete\b.*\s(?:--force|-f)\b|\s(?:--force|-f)\b.*\s(?:--delete|-d)\b|\s-d\b.*\s(?:--force|-f)\b/.test(rest) ? 'git branch -D' : null;
    default: return null;
  }
}

function rmRule(name, args, tool) {
  const tokens = (args || '').split(/\s+/).filter(Boolean);
  if (tool === 'PowerShell') {
    if (/^(rd|rmdir)$/i.test(name) && tokens.some((t) => /^\/s$/i.test(t))) return `${name} /s`;
    return tokens.some((t) => /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?(?::\$true)?$/i.test(t) || /^-r[a-z]*f/i.test(t)) ? `${name} -Recurse` : null;
  }
  if (name !== 'rm') return null;
  const short = tokens.filter((t) => /^-[a-zA-Z]+$/.test(t)).join('');
  const r = /[rR]/.test(short) || tokens.includes('--recursive');
  const f = /f/.test(short) || tokens.includes('--force');
  return r && f ? 'rm -rf' : null;
}

export function verdict(command, tool = 'Bash') {
  for (const raw of String(command).split(/&&|\|\||[;|\r\n]/)) {
    const seg = raw.trim();
    // Wyjątek §8 dla `dwmt.mjs finish` nie jest potrzebny: skrypt woła git przez spawnSync, którego hook nie widzi.
    if (!seg) continue;
    const g = GIT.exec(seg);
    const hit = (g && gitRule(g[2], g[3])) || (() => { const m = RM.exec(seg); return m ? rmRule(m[1], m[2], tool) : null; })();
    if (hit) return hit;
  }
  return null;
}

// v3 (T-4, D-9/D-10/D-16): strażnik blokuje domyślnie tylko w sesjach przebiegu dwmt. Wszystko poniżej czyta pliki
// dopiero po trafieniu `verdict` i bez procesów potomnych (AC-11: hook biegnie przy każdym poleceniu powłoki).
const readSafe = (f) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const exists = (p) => { try { statSync(p); return true; } catch { return false; } };

// Drzewo z `cwd` i katalog wspólny gita, z samych plików (bez `git rev-parse`).
function findTree(cwd) {
  let dir = resolve(cwd);
  for (;;) {
    const g = join(dir, '.git');
    if (isDir(g)) return { tree: dir, common: g };
    const text = readSafe(g);
    if (text !== null) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
      if (!m) return { tree: dir, common: null };
      const gitDir = resolve(dir, m[1]);
      const cd = readSafe(join(gitDir, 'commondir'));
      return { tree: dir, common: cd && cd.trim() ? resolve(gitDir, cd.trim()) : gitDir };
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// Drzewa robocze repo z `cwd`: drzewo `cwd` pierwsze, potem główne i z `<common>/worktrees/*/gitdir`; bez `.git` → [cwd].
export function repoTrees(cwd) {
  const found = findTree(cwd);
  if (!found) return [resolve(cwd)];
  const trees = [found.tree];
  if (found.common) {
    if (basename(found.common) === '.git') trees.push(dirname(found.common));
    let names = [];
    try { names = readdirSync(join(found.common, 'worktrees')); } catch { /* brak dodatkowych drzew */ }
    for (const n of names) {
      const gd = readSafe(join(found.common, 'worktrees', n, 'gitdir'));
      if (gd && gd.trim()) trees.push(dirname(resolve(found.common, 'worktrees', n, gd.trim())));
    }
  }
  return [...new Set(trees)].filter(exists);
}

// D-16 (T-4/F-3): przebieg bez `stopped`, którego `finish` nie jest `squashed` ani `left` (jak product-import#activeWork):
// także `merge-wait` i zatrzymania finish (`conflict`, `red`, `env`, `deferred-major`), gdy sesja przebiegu naprawia
// drzewo przed ponownym finish; nieczytelne i nieparsowalne pliki pomijane po cichu.
export function openRuns(trees) {
  const out = [];
  for (const t of trees) {
    let ids = [];
    try { ids = readdirSync(join(t, '.dwmt', 'runs')); } catch { continue; }
    for (const id of ids) {
      const text = readSafe(join(t, '.dwmt', 'runs', id, 'run.json'));
      if (text === null) continue;
      let r;
      try { r = JSON.parse(text); } catch { continue; }
      if (!r || typeof r !== 'object' || r.stopped) continue;
      if (!['squashed', 'left'].includes(r.finish?.status)) out.push(r);
    }
  }
  return out;
}

// Lokalna kopia `config.mjs#stripJsonComments`: import config.mjs ciągnie helpery gita (AC-11).
function stripJsonComments(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { out += c; if (c === '\\') out += text[++i] ?? ''; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    out += c;
  }
  return out;
}

const SCOPES = ['run', 'repo', 'always'];
// D-10: env `DWMT_GUARD_SCOPE`, potem `guard.scope` z `.claude/dwmt.json` drzewa z `cwd`, potem `run`; nieznane = `run`.
export function guardScope(cwd, env = {}) {
  let v = env.DWMT_GUARD_SCOPE;
  if (!v) {
    const tree = findTree(cwd)?.tree ?? resolve(cwd);
    const text = readSafe(join(tree, '.claude', 'dwmt.json'));
    try { v = text ? JSON.parse(stripJsonComments(text))?.guard?.scope : null; } catch { v = null; }
  }
  return SCOPES.includes(v) ? v : 'run';
}

// Werdykt bez I/O: w sesji przebiegu dzisiejszy komunikat; poza nią tylko przy `always` albo `repo` z otwartym przebiegiem.
export function decide(hit, { scope, inRun, repoOpen }) {
  if (!hit) return null;
  if (inRun) return `dwmt guard: \`${hit}\` jest zablokowane (dwmt §8). Zmiany zostają w drzewie; commit robi skrypt dwmt. Jeśli to konieczne, poproś użytkownika, by wykonał to sam.`;
  if (scope === 'always' || (scope === 'repo' && repoOpen)) {
    return `dwmt guard (guard.scope: ${scope}): \`${hit}\` jest zablokowane także poza sesją przebiegu. Zmień \`guard.scope\` w .claude/dwmt.json albo DWMT_GUARD_SCOPE, albo zrób to sam.`;
  }
  return null;
}

const asList = (x) => (Array.isArray(x) ? x : []);
const lists = (r, sid) => asList(r.session_ids).includes(sid)
  || asList(r.tasks).some((t) => asList(t?.sessions).includes(sid))
  || asList(r.callers).some((c) => c?.id === sid);

// Jedno wywołanie hooka: bez trafienia `verdict` żaden plik nie jest czytany.
export function hookMain(ev, env = {}) {
  const hit = verdict(ev?.tool_input?.command ?? '', ev?.tool_name);
  if (!hit) return null;
  const cwd = ev.cwd || process.cwd();
  let reason;
  if (env.DWMT_RUN) reason = decide(hit, { scope: 'run', inRun: true, repoOpen: true });
  else {
    const runs = openRuns(repoTrees(cwd));
    const sid = ev.session_id;
    const inRun = Boolean(sid) && runs.some((r) => lists(r, sid));
    reason = decide(hit, { scope: inRun ? 'run' : guardScope(cwd, env), inRun, repoOpen: runs.length > 0 });
  }
  return reason ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } : null;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let ev = null;
  try { ev = JSON.parse(raw || '{}'); } catch { /* wejście nie jest JSON: przepuść */ }
  const out = ev && typeof ev === 'object' ? hookMain(ev, process.env) : null;
  if (out) process.stdout.write(JSON.stringify(out));
}
