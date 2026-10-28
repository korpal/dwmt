// dwmt: wywołania git (bez shella, tablica argumentów), worktree gałęzi.
import { spawnSync } from 'node:child_process';
import { readdirSync, lstatSync, unlinkSync, rmdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fwd } from './util.mjs';
import { esc, trimOutput } from './text.mjs';

// ---------- git, config, przebieg ----------

// Pamięć odczytów gita w jednym krótkim procesie CLI (kt, D-11): włącza ją tylko `dwmt.mjs#main`; każde inne
// wywołanie gita, komenda verify, proces agenta i czekanie na kolejkę lub blokadę produktu ją czyszczą.
let memo = null;
export function enableGitMemo(on = true) { memo = on ? new Map() : null; }
export function clearGitMemo() { if (memo) memo.clear(); }
const LOOKUPS = [
  ['rev-parse', '--show-toplevel'], ['rev-parse', '--path-format=absolute', '--git-common-dir'], ['rev-parse', '--git-common-dir'],
  ['rev-parse', '--git-dir'], ['rev-parse', '--git-path', 'index'], ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
  ['branch', '--show-current'], ['worktree', 'list', '--porcelain'],
];
export function isGitLookup(args) {
  const s = args.join('\0');
  if (LOOKUPS.some((l) => l.join('\0') === s)) return true;
  if (args.length === 4 && args[0] === 'rev-parse' && args[1] === '--verify' && /^(--quiet|-q)$/.test(args[2]) && args[3].startsWith('refs/heads/')) return true;
  return args.length === 3 && args[0] === 'for-each-ref' && args[1] === '--format=%(refname:short)';
}

export function gitRaw(args, { cwd = process.cwd(), env } = {}) {
  let key = null;
  if (memo) {
    if (!env && isGitLookup(args)) {
      key = `${resolve(cwd)}\0${args.join('\0')}`;
      const hit = memo.get(key);
      if (hit) return { ...hit };
    } else memo.clear();
  }
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd, encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env, maxBuffer: 256 << 20, windowsHide: true,
  });
  if (r.error) throw r.error;
  if (key && memo) memo.set(key, { ...r });
  return r;
}
export function git(args, opts) {
  const r = gitRaw(args, opts);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${trimOutput(r.stderr || r.stdout, 3).lines.join(' | ')}`);
  return r.stdout.trimEnd();
}
export const topOf = (cwd = process.cwd()) => fwd(git(['rev-parse', '--show-toplevel'], { cwd }));
export const dirty = (cwd) => git(['status', '--porcelain'], { cwd }).split(/\r?\n/).filter(Boolean);

// Dowiązania (symlink, junction) w drzewie katalogów, bez wchodzenia w nie i bez `.git`: same ścieżki dowiązań.
export function linksIn(dir) {
  const out = [];
  const walk = (d) => {
    let names;
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      if (n === '.git') continue;
      const p = join(d, n);
      let s;
      try { s = lstatSync(p); } catch { continue; }
      if (s.isSymbolicLink()) out.push(p);
      else if (s.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

// Usunięcie worktree bez skutków poza nim (noc 2026-10-05, F): Git dla Windows (2.47) przy `worktree remove` wchodzi
// w junction i opróżnia katalog docelowy (`frontend/node_modules` głównego drzewa po sprzątaniu dwóch sprintów).
// Najpierw odpinamy dowiązania (samo dowiązanie, cel zostaje), potem git. `force` jak `git worktree remove --force`.
// Recenzja nocy: dowiązania śledzone przez git (tryb 120000) zostają (ich usunięcie brudzi worktree i git odmawia); bez
// `force` brudny worktree nie traci niczego (git i tak odmówi); dowiązanie, którego nie da się odpiąć, zatrzymuje usuwanie.
export function removeWorktree(main, wt, { force = false } = {}) {
  const fail = (msg, unlinked = []) => ({ status: 1, stderr: msg, stdout: '', unlinked });
  if (!force) {
    const st = gitRaw(['status', '--porcelain'], { cwd: wt });
    if (st.status === 0 && st.stdout.trim()) return fail(`worktree ma niezacommitowane zmiany: ${st.stdout.trim().split(/\r?\n/).slice(0, 3).join('; ')}`);
  }
  const tracked = new Set();
  const ls = gitRaw(['ls-files', '-s', '-z'], { cwd: wt });
  if (ls.status === 0) for (const e of ls.stdout.split('\0')) { const m = /^120000 \S+ \d+\t(.+)$/.exec(e); if (m) tracked.add(m[1]); }
  const unlinked = [];
  const stuck = [];
  for (const p of linksIn(wt)) {
    const rel = fwd(relative(wt, p));
    if (tracked.has(rel)) continue;
    try { unlinkSync(p); unlinked.push(fwd(p)); } catch {
      try { rmdirSync(p); unlinked.push(fwd(p)); } catch (e) { stuck.push(`${fwd(p)} (${e.code ?? e.message})`); }
    }
  }
  if (stuck.length) return fail(`nie da się odpiąć dowiązań (git wszedłby w nie i opróżnił ich cel): ${stuck.join(', ')}`, unlinked);
  const r = gitRaw(['worktree', 'remove', ...(force ? ['--force'] : []), wt], { cwd: main });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout, unlinked };
}

export function worktreeFor(top, branch) {
  const blocks = git(['worktree', 'list', '--porcelain'], { cwd: top }).split(/\r?\n\r?\n/);
  for (const b of blocks) {
    const path = /^worktree (.+)$/m.exec(b)?.[1];
    if (path && new RegExp(`^branch refs/heads/${esc(branch)}$`, 'm').test(b)) return fwd(path);
  }
  return null;
}

// K5 D-5 (extracted from verify.mjs#e2eChangedFiles): files the sprint changed, from the merge-base with the target to
// HEAD (after the finish rebase that is the sprint's own work); `deleted` adds deleted files. [] without a base.
export function sprintChangedFiles(top, run, { deleted = false } = {}) {
  let base;
  try { base = git(['merge-base', run.target, 'HEAD'], { cwd: top }); } catch { base = run.planBase ?? null; }
  if (!base) return [];
  return git(['diff', '--name-only', `--diff-filter=${deleted ? 'AMRD' : 'AMR'}`, base, 'HEAD'], { cwd: top }).split(/\r?\n/).filter(Boolean);
}
