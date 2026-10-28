// dwmt K7: workplaces (the user's branches). One record per workplace in `<product.dir>/workplaces.jsonl` (D-3, C-1); this
// module is the only reader: the PO commands (`product workplace`), the brief, and later the run start, the supervisor and
// the page ask it, so they agree. Every read takes the home tree and never throws on a missing product layer (empty/null).
// The writes (`saveWorkplaces`) are called only by `product.mjs#cmdWorkplace`, under the product lock.
import { existsSync, readdirSync } from 'node:fs';
import { join, isAbsolute, relative, resolve } from 'node:path';
import { fwd, read, asList } from './util.mjs';
import { gitRaw, worktreeFor } from './git.mjs';
import { loadConfig } from './config.mjs';
import { productConfig } from './product-config.mjs';
import { paths, readJsonl, writeJsonl, loadRoadmap, loadIndex } from './product-store.mjs';

export const WORKPLACE_STATES = ['active', 'removed'];
const DIRTY_MAX = 10;

function productPaths(home) {
  try {
    const pc = productConfig(home, loadConfig(home));
    const P = paths(home, pc);
    return existsSync(P.dir) ? P : null;
  } catch { return null; }
}
const out = (args, cwd) => { try { const r = gitRaw(args, { cwd }); return r.status === 0 ? r.stdout.trim() : null; } catch { return null; } };

// ---------- record ----------

export function loadWorkplaces(home) {
  const P = productPaths(home);
  if (!P) return [];
  try { return readJsonl(P.workplaces).filter((w) => w && typeof w === 'object' && w.name); } catch { return []; }
}
// The writers read through this one: a bad line or a row without a name fails the command, so a record it could not
// read is never rewritten (only the read API above answers empty).
export function readWorkplaces(P) {
  return readJsonl(P.workplaces).map((w, i) => {
    if (!w || typeof w !== 'object' || !w.name) throw new Error(`${fwd(P.workplaces)}:${i + 1}: not a workplace record (fix the line, then retry)`);
    return w;
  });
}
export const saveWorkplaces = (P, rows) => writeJsonl(P.workplaces, rows);
export const activeWorkplaces = (home) => loadWorkplaces(home).filter((w) => w.state === 'active');
export const findWorkplace = (home, name) => activeWorkplaces(home).find((w) => w.name === name) ?? null;

export function workplaceOf(home, sprintId) {
  return activeWorkplaces(home).find((w) => asList(w.sprints).includes(sprintId)) ?? null;
}

// Open sprints of a workplace record: assigned, still a roadmap line and not done (a removed workplace keeps them, D-7).
export function openSprintsOf(home, wp) {
  const P = productPaths(home);
  const lines = P ? loadRoadmap(P) : [];
  return [...new Set(asList(wp?.sprints))].filter((id) => lines.some((l) => l.id === id && l.state !== 'done'));
}

// The workplace that decides whether a sprint may start (init, supervisor): its active workplace, else the last removed
// record that still holds it as an open sprint, so startBlock answers `removed` (D-7) instead of a main-tree start.
export function startWorkplaceOf(home, sprintId) {
  const act = workplaceOf(home, sprintId);
  if (act) return act;
  const gone = loadWorkplaces(home).filter((w) => w.state !== 'active' && asList(w.sprints).includes(sprintId));
  return gone.length && openSprintsOf(home, gone.at(-1)).includes(sprintId) ? gone.at(-1) : null;
}

// `path` of the record: relative to the home tree with `/` when inside it (the product dir is committed), else absolute.
export function recordPath(home, abs) {
  const rel = relative(resolve(home), resolve(abs));
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? fwd(rel) : fwd(resolve(abs));
}

// The tree that has the workplace branch checked out (absolute, `/`), null when none has.
export function workplaceTree(home, wp) {
  if (!wp?.branch) return null;
  try { return worktreeFor(home, wp.branch); } catch { return null; }
}

// ---------- sprints of a workplace ----------

// Squashed run copies of the home tree, per sprint id: the last one (commit and finish time).
function squashes(home) {
  const base = join(home, '.dwmt', 'runs');
  const by = new Map();
  let ids = [];
  try { ids = readdirSync(base); } catch { return by; }
  for (const r of ids) {
    try {
      const run = JSON.parse(read(join(base, r, 'run.json')));
      const id = run.spec ?? run.sprint;
      if (!id || run.finish?.status !== 'squashed') continue;
      const prev = by.get(id);
      if (!prev || String(run.finish.at ?? '') >= String(prev.at ?? '')) by.set(id, { run: r, commit: run.finish.commit ?? null, at: run.finish.at ?? null });
    } catch { /* another directory */ }
  }
  return by;
}

// [{id, k, n, state, commit}]: `done` (closed), `uat` (done, UAT pending), `running` (ordered or running), `queued`;
// finished first in finish order, then the open ones in roadmap order. A dropped sprint is not counted (A-5).
export function workplaceSprints(home, wp) {
  const ids = [...new Set(asList(wp?.sprints))];
  if (!ids.length) return [];
  const P = productPaths(home);
  const lines = P ? loadRoadmap(P) : [];
  const index = P ? loadIndex(P) : [];
  const sq = squashes(home);
  const rows = [];
  for (const id of ids) {
    const l = lines.find((x) => x.id === id);
    const a = l ? null : index.find((x) => x.id === id);
    if (a?.merged === 'dropped') continue;
    const state = a ? 'done' : l?.state === 'done' ? 'uat' : ['ordered', 'running'].includes(l?.state) ? 'running' : 'queued';
    const s = sq.get(id);
    rows.push({ id, state, commit: s?.commit ?? null, fin: s?.at ?? (a && a.merged !== '-' ? a.merged : null), row: l ? lines.indexOf(l) : Infinity, rec: ids.indexOf(id) });
  }
  const fin = rows.filter((r) => ['done', 'uat'].includes(r.state)).sort((x, y) => String(x.fin ?? '').localeCompare(String(y.fin ?? '')) || x.rec - y.rec);
  const open = rows.filter((r) => !fin.includes(r)).sort((x, y) => x.row - y.row || x.rec - y.rec);
  const all = [...fin, ...open];
  return all.map((r, i) => ({ id: r.id, k: i + 1, n: all.length, state: r.state, commit: r.commit }));
}

// ---------- git facts ----------

export function remoteOf(home, branch) {
  return out(['config', '--get', `branch.${branch}.remote`], home) || 'origin';
}
export const pushCmdOf = (remote, branch) => `git push -u ${remote} ${branch}`;

// The branch has an upstream (or `<remote>/<branch>`) and no commits beyond it; the brief drops its ready line then.
export const branchPushed = (home, branch) => (branch ? pushedOf(home, branch, remoteOf(home, branch)) : false);
function pushedOf(home, branch, remote) {
  const up = out(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`], home)
    ?? (out(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`], home) ? `${remote}/${branch}` : null);
  if (!up) return false;
  return out(['rev-list', '--count', `${up}..refs/heads/${branch}`], home) === '0';
}

export function dirtyOf(tree) {
  const s = out(['status', '--porcelain'], tree);
  if (s === null) return null;
  return s.split(/\r?\n/).filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, ''));
}

// {tree, dirty, dirtyFiles, ahead, behind, baseRef, pushed, remote, pushCmd, at}; counts null when a ref is missing.
export function workplaceFacts(home, wp) {
  const tree = workplaceTree(home, wp);
  const files = tree && existsSync(tree) ? dirtyOf(tree) : null;
  const baseRef = wp?.base?.ref ?? null;
  let ahead = null;
  let behind = null;
  if (baseRef && wp?.branch) {
    const lr = out(['rev-list', '--left-right', '--count', `${baseRef}...refs/heads/${wp.branch}`], home);
    const m = /^(\d+)\s+(\d+)$/.exec(lr ?? '');
    if (m) { behind = Number(m[1]); ahead = Number(m[2]); }
  }
  const remote = wp?.branch ? remoteOf(home, wp.branch) : 'origin';
  return {
    tree, dirty: files ? files.length : null, dirtyFiles: files ? files.slice(0, DIRTY_MAX) : [], ahead, behind, baseRef,
    pushed: wp?.branch ? pushedOf(home, wp.branch, remote) : false, remote, pushCmd: wp?.branch ? pushCmdOf(remote, wp.branch) : null, at: new Date().toISOString(),
  };
}

// ---------- readiness and start ----------

// D-8: every assigned sprint is done (closed or waiting for UAT); one answer for finish, brief, supervisor and page.
export function workplaceReady(home, wp) {
  const sp = workplaceSprints(home, wp);
  const n = sp.length;
  const branch = wp?.branch ?? null;
  return { ready: wp?.state === 'active' && n > 0 && sp.every((s) => ['done', 'uat'].includes(s.state)), branch, n, pushCmd: branch ? pushCmdOf(remoteOf(home, branch), branch) : null };
}

// Why a sprint of this workplace may not start now: null | {reason, files, text}.
export function startBlock(home, wp) {
  if (!wp) return null;
  if (wp.state !== 'active') return { reason: 'removed', files: [], text: `workplace ${wp.name} is removed: assign the sprint to another workplace or unassign it (product workplace unassign <id>)` };
  const tree = workplaceTree(home, wp);
  if (!tree || !existsSync(tree)) return { reason: 'missing-tree', files: [], text: `workplace ${wp.name}: no worktree has branch ${wp.branch} checked out (expected ${wp.path}); check it out there again or remove the workplace` };
  const files = dirtyOf(tree) ?? [];
  if (files.length) return { reason: 'dirty', files: files.slice(0, DIRTY_MAX), text: `workplace ${wp.name} (${tree}) has uncommitted changes: ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` (+${files.length - 3})` : ''}; commit or stash them first` };
  return null;
}
