// dwmt: live sprint view writer (build note docs/podglad-sprintu.md, product layer spec §3.11). One writer process per
// project (main tree) keeps `<view dir>/live.js` (`window.__dwmtLive = {…}`) up to date while sprints run, for every
// active run of the project across its worktrees; the page re-injects that file as a classic script (file://, no server).
// 0 tokens, except the optional translation of task titles by the cheap model. Everything here is best effort: callers
// (`dwmt state`, the driver) never wait for it and never see its errors. The snapshot never holds file contents, prompts
// or model text: paths, the first line of commands, search patterns, ids, counts and times only.
import { existsSync, readdirSync, statSync, mkdirSync, rmSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname, relative, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { ROOT, fwd, read, asList, writeFileAtomic, canonPath, pathKey } from './util.mjs';
import { git } from './git.mjs';
import { loadConfig } from './config.mjs';
import { productConfig } from './product-config.mjs';
import { contextHome, isLegacy, taskDir } from './run.mjs';
import { unmergedDeps, runDepsNow } from './deps.mjs';
import { tryHeader } from './headers.mjs';
import { planInfo } from './plan-state.mjs';
import { questionInfo, reviewPassed, fixNow } from './state.mjs';
import { answeredIds } from './risks.mjs';
import { PRICE_Q, priceTurn } from './price-gate.mjs';
import { COST_W, callerCost } from './sessions.mjs';
import { knownRuns } from './report.mjs';
import { naiveForecast } from './price-alert.mjs';
import { memoryFile, loadMemory, refreshView, pageFile } from './product-view.mjs';
import { paths as productPaths } from './product-store.mjs';
import { cheapClaude, answerJson } from './product-foryou.mjs';
import { spawnDetached } from './platform.mjs';
import { alive as pidAlive } from '../machine.mjs';
import { assess, processAlive, readDriveLock, readActive, readLockFile, acquireLockFile, queueTickets, WORK_PHASES, WAIT_PHASES } from '../watch.mjs';
import { readEventsFrom } from '../events.mjs';
import { is27, goalCheckInfo } from '../plan.mjs';
import { batchOn } from '../batch.mjs';

export const LIVE_FILE = 'live.js';
const LOCK_FILE = 'live.lock';
const DWMT = join(ROOT, 'scripts', 'dwmt.mjs');
const COST_MS = 30e3; // cost recomputed at most this often
const TREES_MS = 30e3; // `git worktree list` at most this often
const SCAN_MS = 30e3; // transcript lookups (project dirs, missing sessions, subagent lists) for cost
const AGENT_SCAN_MS = 5e3; // the same for the agents working now (their activity shows within one or two polls)
const FEED_MAX = 40;
const MAX_READ = 128 << 20;
const IDLE_POLLS = 2;
const STALL_EXIT_MS = 10 * 60e3;
const FINISHED_KEEP_MS = 30 * 60e3; // a finished run stays on the page (status done) this long after the finish
const STALL_OLD_MS = 48 * 3600e3; // a run stalled for this long is not live any more (abandoned branch)
const ABANDONED_MS = 7 * 24 * 3600e3; // without a live driver: no activity (run.json, run files, events) for this long
const ASK = ['ask-plan', 'ask', 'ask-rounds', 'ask-delete'];
const ASK_REASON = { 'ask-plan': 'questions in the plan', ask: 'questions from the executor', 'ask-rounds': 'review rounds used up', 'ask-delete': 'consent to delete files' };
const FINISH_WAIT = ['conflict', 'red', 'env', 'squash-failed', 'deferred-major'];
const TASK_STEPS = ['implement', 'continue', 'fix', 'repair', 'verify', 'review', 'commit', 'ask', 'ask-rounds', 'ask-delete', 'handoff'];
const TOOL_KIND = { Read: 'read', Edit: 'edit', MultiEdit: 'edit', Write: 'write', Bash: 'run', PowerShell: 'run', Grep: 'search', Glob: 'search' };
const ROLE_WHO = { architect: 'architect', planner: 'architect', explorer: 'explorer', executor: 'executor', reviewer: 'reviewer', checker: 'checker', 'ui-verifier': 'ui-verifier' };
const ROLE_BUCKET = { architect: 'plan', planner: 'plan', explorer: 'plan', executor: 'exec', reviewer: 'review', checker: 'review', 'ui-verifier': 'review' };
const ASK_WHO = { 'ask-plan': 'architect', ask: 'executor', 'ask-rounds': 'reviewer', 'ask-delete': 'architect' };
// Keys a snapshot can carry (step and sub-step keys, feed event keys, note keys): the page has a PL and an EN string for
// each one (test `view-live`), so a key added here without strings fails the suite instead of showing a humanised id.
export const STEP_KEYS = [...new Set([...WORK_PHASES, ...WAIT_PHASES, 'stopped', 'batch'])];
export const FEED_KEYS = ['task-start', 'tests-green', 'tests-red', 'review-start', 'review-clean', 'review-findings', 'task-committed', 'question-waiting', 'answered', 'plan-ready',
  'stall', 'price-alert', 'merge-wait', 'stopped', 'merged', 'mode-switch', 'uat-waiting', 'driver-start', 'driver-stop', 'finish-start'];
export const NOTE_KEYS = ['review-clean', 'review-fixed', 'review-findings', 'accepted', 'tests-green', 'tests-red', 'waiting-user', 'no-progress', 'attempt', 'plan-ready', 'deferred',
  'goal-gaps', 'goal-met', 'merge-wait', ...FINISH_WAIT.map((x) => `finish-${x}`)];

const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex'); // the key of the view's translation memory
const mtime = (f) => { try { return statSync(f).mtimeMs; } catch { return 0; } };
const ms = (x) => (x == null || x === '' ? 0 : typeof x === 'number' ? x : Date.parse(x) || 0);
const iso = (x) => { const t = ms(x); return t ? new Date(t).toISOString() : null; };
const minutes = (a, b) => (ms(a) && ms(b) && ms(b) >= ms(a) ? Math.round((ms(b) - ms(a)) / 60e3) : null);
const round2 = (x) => Math.round(x / 1e4) / 100; // M tokens, as sessionsCost
const roleKey = (name) => String(name ?? '').split(':').pop().replace(/^dwmt-/, '').replace(/-high$/, '');
const firstStarted = (t) => Object.values(t?.started ?? {}).filter(Boolean).sort()[0] ?? null;
const readdir = (d) => { try { return readdirSync(d); } catch { return []; } };
const freshMs = (intervalSec) => Math.max(3 * intervalSec * 1e3, 30e3);
// Same directory as `viewDir(main)` in product-view.mjs, without its `git worktree list` (ensureLive must take a few ms).
export const liveDir = (main) => join(main, '.dwmt', 'product', 'view');

// Live settings of a project from its config: on only with the product layer, the page (`product.view.enabled`) and
// `product.view.live` not false; `cfg`: an already loaded config of the same repo (saves the target detection).
export function liveSettings(main, cfg = null) {
  const c = cfg ?? loadConfig(main);
  const pc = productConfig(main, c);
  const view = pc.view ?? {};
  const sec = Number(view.liveIntervalSec);
  return {
    cfg: c, pc, on: !!pc.enabled && view.enabled !== false && view.live !== false, intervalSec: Number.isFinite(sec) && sec >= 0.1 ? sec : 5,
    language: String(c.language ?? 'en').toLowerCase(), translate: view.translate !== false, model: view.model ?? 'haiku', translateTimeoutS: view.translateTimeoutS ?? 120,
  };
}

// ---------- spawn on demand ----------

// Called by every `dwmt state` and at driver start: when the product layer is on and no live writer is alive (its lock
// with a live pid and a fresh live.js), starts `dwmt live` detached. A few ms, never throws. `DWMT_LIVE=0` turns it off.
// → {running: pid} | {pid} | null.
export function ensureLive(top, { home = null, cfg = null } = {}) {
  try {
    if (process.env.DWMT_LIVE === '0') return null;
    const main = canonPath(home ?? contextHome(top));
    if (!existsSync(main)) return null;
    const s = liveSettings(main, cfg);
    if (!s.on) return null;
    const dir = liveDir(main);
    const held = readLockFile(join(dir, LOCK_FILE));
    const seen = Math.max(mtime(join(dir, LIVE_FILE)), ms(held?.start));
    if (held && pidAlive(held.pid) && Date.now() - seen < freshMs(s.intervalSec)) return { running: held.pid };
    // The writer is no session of the run: without the caller's session id (events, run.json bookkeeping).
    const env = { ...process.env };
    delete env.CLAUDE_CODE_SESSION_ID;
    const p = spawnDetached(process.execPath, [DWMT, 'live'], { cwd: main, env });
    return p ? { pid: p.pid ?? null } : null;
  } catch { return null; }
}

// ---------- transcripts: incremental parsing (cost as sessionsCost, tool calls for the feed) ----------

function callCost(u) {
  const cc = u.cache_creation || {};
  const c = { inp: u.input_tokens || 0, cw5: cc.ephemeral_5m_input_tokens || 0, cw1: cc.ephemeral_1h_input_tokens || 0, cr: u.cache_read_input_tokens || 0, out: u.output_tokens || 0 };
  return Object.entries(COST_W).reduce((b, [k, w]) => b + w * c[k], 0);
}
// Secrets in the first line of a command never reach the page: values of env assignments with a secret-like name
// (`API_KEY=…`, `$env:DB_PASSWORD = …`), `Authorization:` and `Bearer` values, `--password` / `--token` / `--secret`
// style flags, `-p<password>` of MySQL-like clients and `user:pass@` in URLs become `***`.
const SECRET_NAME = /key|token|secret|passw|pwd|auth|credential/i;
const VAL = String.raw`(?:"[^"]*"|'[^']*'|[^\s"';&|]+)`;
export function maskSecrets(line) {
  let s = String(line ?? '');
  s = s.replace(/\b([a-z][\w+.-]*:\/\/)[^\s/@:'"]+:[^\s/@'"]+@/gi, '$1***@');
  s = s.replace(new RegExp(String.raw`((?:\$env:)?\b[A-Za-z_][\w.-]*)(\s*=\s*|=)${VAL}`, 'g'), (m, name, eq) => (SECRET_NAME.test(name) && !/^-/.test(name) ? `${name}${eq}***` : m));
  s = s.replace(new RegExp(String.raw`(\bauthorization\s*[:=]\s*)(?:(bearer|basic|token|digest)\s+)?${VAL}`, 'gi'), (m, a, scheme) => `${a}${scheme ? `${scheme} ` : ''}***`);
  s = s.replace(new RegExp(String.raw`(\bbearer\s+)(?!\*\*\*)${VAL}`, 'gi'), '$1***');
  s = s.replace(new RegExp(String.raw`((?:^|\s)--[\w-]*(?:passw|pwd|token|secret|api-?key|auth|credential)[\w-]*)(=|\s+)(?!-)${VAL}`, 'gi'), '$1$2***');
  if (/\b(?:mysql\w*|mariadb\w*)\b/i.test(s)) s = s.replace(/((?:^|\s)-p)(?=[^\s-])\S+/g, '$1***');
  return s;
}
const toolRaw = (name, inp = {}) => (['Read', 'Edit', 'MultiEdit', 'Write'].includes(name) ? String(inp.file_path ?? inp.path ?? '')
  : ['Bash', 'PowerShell'].includes(name) ? maskSecrets(String(inp.command ?? '').split(/\r?\n/)[0]).slice(0, 120)
    : String(inp.pattern ?? '').slice(0, 120));

// Byte offsets per file live in memory (the writer is long-lived): each call reads only what was appended since the last.
// Per file: the first API call of each request id (cost as `sessionsCost`: same weights, same dedup, same chain of
// continued sessions, same roles), the role from `agent-setting`, the continued-in sessions and the last tool calls.
export class Transcripts {
  constructor(root) {
    this.root = root;
    this.projects = [];
    this.projAt = 0;
    this.where = new Map();
    this.subs = new Map();
    this.state = new Map();
  }

  projectDirs(now, every) {
    if (!this.projAt || now - this.projAt >= every) { this.projects = readdir(this.root).map((p) => join(this.root, p)); this.projAt = now; }
    return this.projects;
  }

  // `<project>/<id>.jsonl` (first project dir that has it, as sessionsCost); driver ids (`drive-…`) have no transcript.
  locate(id, { now = Date.now(), every = SCAN_MS } = {}) {
    if (!id || !/^[\w-]+$/.test(id) || /^drive-/.test(id)) return null;
    const w = this.where.get(id);
    if (w?.file) return w.file;
    if (w && now - w.at < every) return null;
    const proj = this.projectDirs(now, every).find((p) => existsSync(join(p, `${id}.jsonl`)));
    this.where.set(id, proj ? { file: join(proj, `${id}.jsonl`) } : { at: now });
    return proj ? join(proj, `${id}.jsonl`) : null;
  }

  subagents(file, { now = Date.now(), every = SCAN_MS } = {}) {
    const dir = join(file.replace(/\.jsonl$/, ''), 'subagents');
    const c = this.subs.get(dir);
    if (c && now - c.at < every) return c.list;
    const list = readdir(dir).filter((x) => /^agent-.*\.jsonl$/.test(x)).map((x) => {
      const f = join(dir, x);
      const prev = c?.list.find((y) => y.file === f);
      if (prev && prev.type !== '?') return prev;
      let type = '?';
      try { type = JSON.parse(read(f.replace(/\.jsonl$/, '.meta.json'))).agentType || '?'; } catch { /* no meta yet */ }
      return { file: f, type };
    });
    this.subs.set(dir, { at: now, list });
    return list;
  }

  scan(file, main = true) {
    let s = this.state.get(file);
    let size;
    try { size = statSync(file).size; } catch { return s ?? { offset: 0, calls: new Map(), role: null, next: [], tools: [] }; }
    if (!s || size < s.offset) { s = { offset: 0, calls: new Map(), role: null, head: '', next: [], tools: [], main }; this.state.set(file, s); }
    if (size === s.offset) return s;
    // A giant first read (over 128 MB) starts at the last 128 MB, after the first full line there.
    const skip = size - s.offset > MAX_READ;
    if (skip) s.offset = size - MAX_READ;
    const buf = Buffer.alloc(size - s.offset);
    const fd = openSync(file, 'r');
    try { readSync(fd, buf, 0, buf.length, s.offset); } finally { closeSync(fd); }
    let end = buf.lastIndexOf(0x0a) + 1;
    let text = buf.subarray(skip ? buf.indexOf(0x0a) + 1 : 0, end).toString('utf8');
    // A last line without a newline counts once it is complete JSON (else it is still being written).
    if (end < buf.length) {
      const tail = buf.subarray(end).toString('utf8');
      try { JSON.parse(tail); text += tail; end = buf.length; } catch { /* partial line: next time */ }
    }
    if (s.head.length < 4000) {
      s.head += text.slice(0, 4000 - s.head.length);
      s.role ??= /"type":"agent-setting","agentSetting":"([^"]+)"/.exec(s.head)?.[1] ?? null;
    }
    for (const line of text.split(/\r?\n/)) {
      if (line.includes('continuedInSessionId')) for (const m of line.matchAll(/"continuedInSessionId":"([\w-]+)"/g)) if (!s.next.includes(m[1])) s.next.push(m[1]);
      if (!line.includes('"assistant"')) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      if (d?.type !== 'assistant' || (main && d.isSidechain)) continue;
      const u = d.message?.usage;
      const rid = d.requestId || d.message?.id;
      if (u && !s.calls.has(rid)) s.calls.set(rid, { c: callCost(u), t: d.timestamp ?? null });
      for (const b of Array.isArray(d.message?.content) ? d.message.content : []) {
        if (b?.type === 'tool_use' && TOOL_KIND[b.name] && d.timestamp) s.tools.push({ at: d.timestamp, kind: TOOL_KIND[b.name], raw: toolRaw(b.name, b.input ?? {}) });
      }
    }
    if (s.tools.length > 2 * FEED_MAX) s.tools.splice(0, s.tools.length - FEED_MAX);
    s.offset += end;
    return s;
  }

  // Cost of sessions (M tokens) as `sessionsCost(ids, root, win)`: {total, byRole, sessions} or null without transcripts.
  cost(ids, win = null) {
    const inWin = (x) => !win || (x.t && x.t >= win.from && x.t <= win.to);
    const by = { orchestrator: 0 };
    let found = 0;
    const done = new Set();
    for (const id0 of asList(ids)) {
      const seen = new Set();
      let role = null;
      for (let id = id0; id && !done.has(id);) {
        done.add(id);
        const file = this.locate(id);
        if (!file) break;
        if (id === id0) found++;
        const s = this.scan(file, true);
        role ??= s.role ?? 'orchestrator';
        let sum = 0;
        for (const [rid, x] of s.calls) if (!seen.has(rid) && inWin(x)) { seen.add(rid); sum += x.c; }
        by[role] = (by[role] || 0) + sum;
        for (const sub of this.subagents(file)) {
          let part = 0;
          for (const x of this.scan(sub.file, false).calls.values()) if (inWin(x)) part += x.c;
          by[sub.type] = (by[sub.type] || 0) + part;
        }
        id = s.next.find((x) => !done.has(x)) ?? null;
      }
    }
    if (!found) return null;
    const total = Object.values(by).reduce((a, b) => a + b, 0);
    return { total: round2(total), byRole: Object.fromEntries(Object.entries(by).filter(([, v]) => v > 0).map(([k, v]) => [k, round2(v)])), sessions: found };
  }

  // Sizes of the session files (with subagents): a change means the caller cost must be counted again.
  sizeOf(ids) {
    let n = 0;
    for (const id of asList(ids)) {
      const f = this.locate(id);
      if (!f) continue;
      try { n += statSync(f).size; } catch { /* gone */ }
      for (const s of this.subagents(f)) { try { n += statSync(s.file).size; } catch { /* gone */ } }
    }
    return n;
  }
}

// ---------- snapshot ----------

export class LiveWriter {
  constructor(main, { out = null, intervalSec = null, transcripts = null, settings = null } = {}) {
    this.main = canonPath(main);
    this.mainKey = pathKey(main);
    this.s = settings ?? liveSettings(this.main);
    this.intervalSec = Number(intervalSec) > 0 ? Number(intervalSec) : this.s.intervalSec;
    this.viewDir = liveDir(this.main);
    this.dir = out ? resolve(out) : this.viewDir;
    this.file = join(this.dir, LIVE_FILE);
    this.tr = new Transcripts(transcripts ?? process.env.DWMT_TRANSCRIPTS ?? join(homedir(), '.claude', 'projects'));
    this.cache = new Map();
    this.pids = new Map();
    this.cfgs = new Map();
    this.ev = { offset: 0, id: null, byRun: new Map() };
    this.trees = null;
    this.treesAt = 0;
    this.costs = new Map();
    this.feedFiles = new Map();
    this.stallSeen = new Map();
    this.known = new Map();
    this.busy = false;
    this.warnings = [];
  }

  warn(e) { const m = `${String(e?.message ?? e).split(/\r?\n/)[0]}`; if (!this.warnings.includes(m)) this.warnings.push(m); if (this.warnings.length > 10) this.warnings.shift(); }

  // Parsed file, re-read only when its size or mtime changed.
  cached(file, parse) {
    let st;
    try { st = statSync(file); } catch { this.cache.delete(file); return null; }
    const c = this.cache.get(file);
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.v;
    let v = null;
    try { v = parse(file); } catch { v = null; }
    this.cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, v });
    return v;
  }
  json(file) { return this.cached(file, (f) => JSON.parse(read(f))); }
  header(file) { return this.cached(file, tryHeader); }
  cfgOf(tree) {
    if (!this.cfgs.has(tree)) { let c = null; try { c = pathKey(tree) === this.mainKey ? this.s.cfg : loadConfig(tree); } catch { c = this.s.cfg; } this.cfgs.set(tree, c); }
    return this.cfgs.get(tree);
  }

  // Full alive check (pid and its start time) once per lock record, then the cheap `kill(pid, 0)`; dead stays dead.
  alive(pid, pidStart = null) {
    const k = `${pid}|${pidStart ?? ''}`;
    const c = this.pids.get(k);
    if (c === false) return false;
    if (c === true) { const a = pidAlive(Number(pid)); if (!a) this.pids.set(k, false); return a; }
    const v = processAlive(pid, pidStart);
    this.pids.set(k, v);
    return v;
  }

  treesNow(now) {
    if (this.trees && now - this.treesAt < TREES_MS) return this.trees;
    let list = [this.main];
    try {
      const out = git(['worktree', 'list', '--porcelain'], { cwd: this.main });
      for (const m of out.matchAll(/^worktree (.+)$/gm)) { const t = fwd(m[1].trim()); if (!list.some((x) => pathKey(x) === pathKey(t))) list.push(t); }
    } catch { /* not a git repo: the main tree only */ }
    this.trees = list.filter((t) => existsSync(t));
    this.treesAt = now;
    return this.trees;
  }

  events() {
    try {
      const r = readEventsFrom(this.ev.offset, { id: this.ev.id });
      this.ev.offset = r.offset;
      this.ev.id = r.id;
      for (const e of r.events) {
        if (!e?.run || !e.project?.root || pathKey(e.project.root) !== this.mainKey) continue;
        const list = this.ev.byRun.get(e.run) ?? [];
        list.push(e);
        if (list.length > 300) list.splice(0, list.length - 300);
        this.ev.byRun.set(e.run, list);
      }
    } catch (e) { this.warn(e); }
  }
  lastEvent(run, type) { return asList(this.ev.byRun.get(run)).filter((e) => e.type === type).at(-1) ?? null; }

  // Active runs of this main tree in every worktree (rules of `activeRuns`), plus runs finished in the last 30 min (the
  // page shows them as done); the same run id in two trees (copy in the main tree): the live one, else the newest.
  discover(now) {
    const found = new Map();
    for (const tree of this.treesNow(now)) {
      const base = join(tree, '.dwmt', 'runs');
      for (const id of readdir(base)) {
        const root = join(base, id);
        const run = this.json(join(root, 'run.json'));
        if (!run || run.run !== id || isLegacy(run)) continue;
        const home = run.homeTree ?? run.mainTree;
        if (home && pathKey(home) !== this.mainKey) continue;
        const finished = ['squashed', 'left'].includes(run.finish?.status);
        const archive = (run.archiveOf && pathKey(run.archiveOf) !== pathKey(tree))
          || (existsSync(join(root, 'final-report.md')) && !['task.md', 'brief.md', 'tasks'].some((f) => existsSync(join(root, f))));
        if ((finished || archive) && !(finished && now - ms(run.finish.at) < FINISHED_KEEP_MS)) continue;
        const prev = found.get(id);
        const better = !prev || (prev.archive && !archive) || (prev.archive === archive && ms(run.updated) > ms(prev.run.updated));
        if (better) found.set(id, { id, tree: fwd(tree), root, run, archive });
      }
    }
    return [...found.values()].sort((a, b) => ms(a.run.created) - ms(b.run.created));
  }

  // assess (watch.mjs) without its transcript scan of every project dir: run files, command record, queue and driver from
  // assess; transcript growth from this writer's index of the run's session files (same rule: newest mtime). The writer
  // only observes: the machine queue is read without its cleanup of dead tickets.
  assessRun(r, now) {
    const { run, root } = r;
    const watch = this.cfgOf(r.tree).watch ?? {};
    const a = assess({ root, run: { ...run, session_ids: [] }, watch, now, aliveFn: (p, st) => this.alive(p, st), queue: (id) => queueTickets(id, { readOnly: true }) });
    if (a.state !== 'hang' && !(a.state === 'stall' && a.reason === 'idle')) return a;
    const files = [];
    for (const id of asList(run.session_ids)) {
      const f = this.tr.locate(id);
      if (!f) continue;
      if (a.state === 'stall') files.push(f);
      for (const s of this.tr.subagents(f)) files.push(s.file);
    }
    const quiet = Math.min(a.quietMin, files.length ? (now - Math.max(...files.map(mtime))) / 60e3 : Infinity);
    const lim = a.state === 'hang' ? (watch.hangMin ?? 90) : (watch.idleMin ?? 30);
    return quiet <= lim ? { ...a, state: 'working', quietMin: Math.round(quiet) } : { ...a, quietMin: Math.round(quiet) };
  }

  status(r, now) {
    const { run, root } = r;
    const f = run.finish;
    const phase = run.phase ?? null;
    const drive = this.json(join(root, 'drive.json'));
    const lock = readDriveLock(root);
    const driver = lock && this.alive(lock.pid, lock.pidStart ?? null) ? lock : null;
    const out = (status, since, reason = null, extra = {}) => ({ status, since: iso(since) ?? iso(run.updated), reason, driver, drive, ...extra });
    if (['squashed', 'left'].includes(f?.status)) return out('done', f.at);
    if (f?.status === 'merge-wait') return out('merge-wait', f.since ?? f.at, f.reason ? `merge-wait: ${f.reason}` : null);
    if (run.stopped || phase === 'stopped') return out('stopped', run.stopped?.at ?? run.updated, 'stopped at the price question');
    if (ASK.includes(phase)) return out('waiting-user', this.lastEvent(run.run, 'question-waiting')?.ts ?? run.updated, ASK_REASON[phase]);
    if (phase === 'finish' && FINISH_WAIT.includes(f?.status)) return out('waiting-user', f.at ?? run.updated, `finish: ${f.status}`);
    // Plan ready, implementation waits until the sprints of `after` are merged (state.mjs: `planned`, `waitingFor`).
    if (phase === 'planned') {
      const home = run.homeTree ?? run.mainTree ?? this.main;
      const waitingFor = unmergedDeps(home, runDepsNow(home, run).after).map(String);
      return out('planned', run.updated, `planned: waiting for ${waitingFor.join(', ') || 'other sprints'}`, { waitingFor });
    }
    // The driver ended (its record in drive.json, after its start and after the last run step): the session takes over.
    const stop = !driver && drive?.stopped?.at && ms(drive.stopped.at) >= Math.max(ms(drive.startedAt), ms(run.updated) - 5e3) ? drive.stopped : null;
    if (stop) return out(stop.status === 'waiting-user' ? 'waiting-user' : 'stopped', stop.at, `driver stopped: ${stop.cause ?? stop.status ?? 'unknown'}`);
    // After a committed task the session-driven run hands the next task to a new session (`handoff`): work while
    // something is alive (process, transcript or run files growing, as assess judges a work step), else a stall.
    const a = this.assessRun(phase === 'handoff' ? { ...r, run: { ...run, phase: 'commit' } } : r, now);
    // Driver started, without a stop record, its lock gone or its pid dead: it died (killed, out of memory).
    if (!driver && run.drive !== false && drive?.pid && drive.startedAt && !(ms(drive.stopped?.at) >= ms(drive.startedAt)) && WORK_PHASES.includes(phase)) {
      return out('stall', now - Math.min(a.quietMin ?? 0, (now - ms(drive.startedAt)) / 60e3) * 60e3, `driver died (pid ${drive.pid})`);
    }
    if (a.state === 'stall') return out('stall', now - a.quietMin * 60e3, a.reason === 'dead' ? `command died: ${a.cmd ?? '?'} (pid ${a.pid ?? '?'})` : a.reason === 'session' ? `stalled: ${a.detail}` : `no progress for ${a.quietMin} min`);
    if (a.state === 'hang') return out('hang', now - a.quietMin * 60e3, `command hangs: ${a.cmd ?? '?'}`);
    const act = readActive(root);
    return out('work', Math.max(ms(run.stepAt), act && !act.end ? ms(act.start) : 0) || run.updated);
  }

  costOf(r, now) {
    const { run } = r;
    const c = this.costs.get(run.run);
    if (c && now - c.at < COST_MS) return c;
    const callers = [...new Set(asList(run.callers).map((x) => x.id).filter(Boolean))];
    let spent = null;
    try { spent = this.tr.cost(asList(run.session_ids).filter((s) => !callers.includes(s))); } catch (e) { this.warn(e); }
    // Caller sessions (the PO in mode A) by turns, as runCostParts: counted again only when their files changed.
    let w = c?.callerM ?? null;
    const size = callers.length ? this.tr.sizeOf(callers) : 0;
    if (callers.length && (!c || c.callerSize !== size)) {
      try {
        const k = this.known.get(run.run);
        const known = k && now - k.at < 5 * 60e3 ? k.ids : knownRuns(r.tree, run, this.cfgOf(r.tree));
        if (!k || k.ids !== known) this.known.set(run.run, { at: now, ids: known });
        const end = ['squashed', 'left'].includes(run.finish?.status) ? run.finish.at : null;
        w = callerCost(callers, run.run, known, { from: run.created ?? null, to: end ?? null }, this.tr.root);
      } catch (e) { this.warn(e); }
    }
    let cost = spent ? { ...spent, byRole: { ...spent.byRole } } : null;
    if (w) {
      cost ??= { total: 0, byRole: {}, sessions: 0 };
      cost.total = Math.round((cost.total + w) * 100) / 100;
      cost.byRole.caller = Math.round(((cost.byRole.caller ?? 0) + w) * 100) / 100;
    }
    // Per task and for the plan: the task's sessions from its start (as the task-end event of `commit`).
    const tasks = new Map();
    const t1 = run.tasks[0];
    const t1Start = t1?.startEvent ?? firstStarted(t1);
    const win = (from, to) => ({ from: iso(from) ?? '', to: iso(to) ?? new Date(now).toISOString() });
    let planM = null;
    try {
      const ids = (t) => asList(t?.sessions).filter((s) => !callers.includes(s));
      planM = this.tr.cost(ids(t1), win(run.created, run.plansReady ?? t1Start))?.total ?? null;
      for (const t of run.tasks) {
        const start = t.startEvent ?? firstStarted(t);
        if (start) tasks.set(t.k, this.tr.cost(ids(t), win(start, this.taskEnd(r, t)))?.total ?? null);
      }
    } catch (e) { this.warn(e); }
    const v = { at: now, total: cost, callerM: w, callerSize: size, planM, tasks };
    this.costs.set(run.run, v);
    return v;
  }

  taskEnd(r, t) {
    if (!t.commit) return null;
    const e = asList(this.ev.byRun.get(r.run.run)).filter((x) => x.type === 'task-end' && Number(x.task) === t.k).at(-1);
    return e?.ts ?? iso(mtime(join(taskDir(r.root, t.k), 'report.md'))) ?? null;
  }

  planning(run) { return !run.plansReady && ['plan', 'ask-plan', 'replan'].includes(run.phase) && !firstStarted(run.tasks[0]); }
  inBatch(run, n) { return !!run.batch?.baseline && !run.batch.commit && n > 0 && run.tasks.filter((t) => t.commit).length >= n; }

  // Steps of one task from its files (tests.md, review-N.md, result-N.md) and run.json; `marks` collects feed milestones.
  steps(r, t, cur, st, now, marks) {
    const { run, root } = r;
    const dir = taskDir(root, t.k);
    const names = new Set(readdir(dir));
    const mt = (n) => (names.has(n) ? mtime(join(dir, n)) : 0);
    const phase = run.phase;
    let R = 0;
    while (names.has(`review-${R + 1}.md`)) R++;
    const reviews = Array.from({ length: R }, (_, i) => this.header(join(dir, `review-${i + 1}.md`)));
    const last = reviews.at(-1) ?? null;
    const lastOk = last && !last.errors;
    const passed = !!lastOk && (reviewPassed(last) || !!t.accepted);
    const round = !R ? 1 : !lastOk || reviewPassed(last) ? R : R + 1;
    const wait = cur && st.status === 'waiting-user';
    const run_ = (keys) => cur && !wait && keys.includes(phase);
    const res1 = names.has('result-1.md') ? this.header(join(dir, 'result-1.md')) : null;
    const tests = names.has('tests.md') ? this.header(join(dir, 'tests.md')) : null;
    const cmds = asList(tests?.commands);
    const red = cmds.filter((c) => Number(c?.exit) !== 0).length;
    const repairs = Object.keys(t.repairs ?? {}).length;
    const out = [];
    const implDone = res1?.status === 'DONE' || t.verified >= 1 || R >= 1 || !!t.commit || run_(['verify', 'review', 'commit']);
    const implRun = !implDone && cur && !wait;
    out.push({ key: 'implement', state: implDone ? 'done' : wait && round === 1 ? 'wait' : implRun ? 'run' : 'todo', min: minutes(t.started?.[1], implDone ? mt('result-1.md') || null : implRun ? now : null), note: null });
    const testsNote = tests && tests.result !== 'none' ? { key: tests.result === 'fail' ? 'tests-red' : 'tests-green', passed: cmds.length - red, red, total: cmds.length } : null;
    const vState = run_(['verify']) ? 'run' : tests?.result === 'fail' && !(t.verified >= round) && !t.commit ? 'bad' : t.verified >= 1 || tests?.result === 'pass' || t.commit ? 'done' : 'todo';
    out.push({ key: 'verify', state: vState, min: tests ? Math.round(cmds.reduce((a, c) => a + (Number(c?.ms) || 0), 0) / 60e3) : null, note: testsNote });
    if (tests && testsNote) marks.push({ at: mt('tests.md'), who: 'script', key: testsNote.key, params: { task: t.k, passed: testsNote.passed, red, total: cmds.length } });
    const fixNeed = repairs > 0 || round > 1;
    const fix = fixNeed ? {
      key: 'fix',
      state: run_(['fix', 'repair']) || (run_(['continue']) && round > 1) ? 'run' : wait && round > 1 ? 'wait' : passed || t.commit || run_(['verify', 'review', 'commit']) ? 'done' : 'todo',
      min: minutes(round > 1 ? t.started?.[round] : t.repairs?.[round] ?? Object.values(t.repairs ?? {}).at(-1), run_(['fix', 'repair', 'continue']) ? now : null),
      note: { key: 'attempt', n: repairs + Math.max(0, round - 1) },
    } : null;
    if (fix && round === 1) out.push(fix);
    const findings = (h) => fixNow(h).length;
    const rNote = passed ? (t.accepted && !reviewPassed(last) ? { key: 'accepted' } : R === 1 ? { key: 'review-clean' } : { key: 'review-fixed', n: findings(reviews[0] ?? {}) })
      : lastOk ? { key: 'review-findings', n: findings(last) } : null;
    out.push({ key: 'review', state: run_(['review']) ? 'run' : passed || lastOk ? 'done' : 'todo', min: R ? minutes(mt('review-input.md') || null, mt(`review-${R}.md`)) : run_(['review']) ? minutes(mt('review-input.md') || null, now) : null, note: rNote });
    if (fix && round > 1) out.push(fix);
    out.push({ key: 'commit', state: t.commit ? 'done' : run_(['commit']) ? 'run' : 'todo', min: null, note: null });
    if (names.has('review-input.md')) marks.push({ at: mt('review-input.md'), who: 'reviewer', key: 'review-start', params: { task: t.k } });
    reviews.forEach((h, i) => {
      if (h && !h.errors) marks.push({ at: mt(`review-${i + 1}.md`), who: 'reviewer', key: reviewPassed(h) ? 'review-clean' : 'review-findings', params: { task: t.k, n: findings(h) } });
    });
    for (const s of out) {
      if (s.state === 'run' && ['stall', 'hang'].includes(st.status) && !s.note) s.note = { key: 'no-progress' };
      if (s.state === 'wait' && !s.note) s.note = { key: 'waiting-user' };
    }
    return { steps: out, deferred: lastOk ? asList(last.batch).length : 0, note: t.commit ? rNote : null };
  }

  runSnap(r, now, mem) {
    const { run, root } = r;
    const st = this.status(r, now);
    // Not a live sprint any more: stalled for two days, or without a live driver and without any activity for a week (an
    // abandoned branch, a question nobody answers); a stopped run stays on the page as long as a finished one.
    if (['stall', 'hang'].includes(st.status) && now - ms(st.since) > STALL_OLD_MS) return null;
    if (!st.driver && now - this.lastActivity(r, now) > ABANDONED_MS) return null;
    if (st.status === 'stopped' && now - ms(st.since) > FINISHED_KEEP_MS) return null;
    const plan = this.cached(join(root, 'plan.md'), () => planInfo(root, run));
    const n = Number(run.count) || plan?.tasks?.length || run.tasks.length;
    const planning = this.planning(run);
    const batch = this.inBatch(run, n);
    const phase = run.phase ?? null;
    const costs = this.costOf(r, now);
    const marks = [];
    const byK = new Map(run.tasks.map((t) => [t.k, t]));
    const ks = [...new Set([...run.tasks.map((t) => t.k), ...asList(plan?.tasks).map((x) => x.k)])].filter((k) => Number.isInteger(k) && k >= 1 && k <= Math.max(n, run.tasks.length)).sort((a, b) => a - b);
    const trOn = this.s.language !== 'en' && this.s.translate;
    let deferred = 0;
    const tasks = ks.map((k) => {
      const t = byK.get(k) ?? null;
      const title = t?.title || asList(plan?.tasks).find((x) => x.k === k)?.title || null;
      const cur = !!t && !planning && !batch && k === run.task && !t.commit && (TASK_STEPS.includes(phase) || (phase === 'ask-plan' && !!run.plansReady));
      const state = t?.commit ? 'done' : cur ? (st.status === 'waiting-user' ? 'wait' : 'run') : 'todo';
      const s = t && (t.commit || cur) ? this.steps(r, t, cur, st, now, marks) : { steps: [], deferred: 0, note: null };
      deferred += s.deferred;
      const startedAt = iso(t?.startEvent ?? firstStarted(t));
      const endedAt = t ? iso(this.taskEnd(r, t)) : null;
      if (startedAt) marks.push({ at: startedAt, who: 'script', key: 'task-start', params: { task: k } });
      if (t?.commit && endedAt && !asList(this.ev.byRun.get(run.run)).some((e) => e.type === 'task-end' && Number(e.task) === k)) marks.push({ at: endedAt, who: 'script', key: 'task-committed', params: { task: k, commit: t.commit.slice(0, 7) } });
      return {
        k, title, titleTr: trOn && title ? mem[sha1(title)] ?? null : null, state, startedAt, endedAt, costM: costs.tasks.get(k) ?? null,
        commit: t?.commit ? String(t.commit).slice(0, 7) : null, note: s.note, steps: s.steps,
      };
    });
    const t1 = run.tasks[0];
    const pre = [];
    if (run.mode !== 'direct' && (plan || planning)) {
      const end = run.plansReady ?? t1?.startEvent ?? firstStarted(t1) ?? null;
      const answers = join(root, 'answers.md');
      const asked = this.cached(answers, (x) => (read(x).match(/^#{1,6}\s+Q-[\w-]+/gm) ?? []).length) ?? 0;
      const state = !planning && (end || plan) ? 'done' : st.status === 'waiting-user' && phase === 'ask-plan' ? 'wait' : 'run';
      pre.push({ key: 'plan', state, startedAt: iso(run.created), endedAt: iso(end), costM: costs.planM, note: state === 'done' ? { key: 'plan-ready', tasks: n, questions: asked } : state === 'wait' ? { key: 'waiting-user' } : null });
      if (run.plansReady) marks.push({ at: run.plansReady, who: 'architect', key: 'plan-ready', params: { n } });
      if (asked) marks.push({ at: mtime(answers), who: 'user', key: 'answered', params: { n: asked } });
    }
    const post = [];
    const f = run.finish;
    const cfg = this.cfgOf(r.tree);
    if (batchOn(root, run, cfg)) {
      const items = asList(run.batch?.items).length || deferred;
      if (items || run.batch) post.push({ key: 'batch', state: run.batch?.commit ? 'done' : batch ? (st.status === 'waiting-user' ? 'wait' : 'run') : 'todo', note: items ? { key: 'deferred', n: items } : null });
    }
    if (is27(run) && plan) {
      const gc = this.cached(join(root, 'goal-check.md'), () => goalCheckInfo(root));
      post.push({ key: 'goal-check', state: gc?.ok ? 'done' : phase === 'goal-check' ? (st.status === 'waiting-user' ? 'wait' : 'run') : 'todo', note: gc?.ok ? (gc.gaps ? { key: 'goal-gaps', n: gc.gaps } : { key: 'goal-met' }) : null });
    }
    const fDone = ['squashed', 'left'].includes(f?.status);
    const fWait = f?.status === 'merge-wait' || FINISH_WAIT.includes(f?.status);
    post.push({ key: 'finish', state: fDone ? 'done' : fWait ? 'wait' : phase === 'finish' ? 'run' : 'todo', note: f?.status === 'merge-wait' ? { key: 'merge-wait' } : FINISH_WAIT.includes(f?.status) ? { key: `finish-${f.status}` } : null });
    // Time: naive end forecast after the first committed task (elapsed per committed task × tasks left).
    const doneN = run.tasks.filter((t) => t.commit).length;
    const t1Start = ms(t1?.startEvent ?? firstStarted(t1));
    const over = ['done', 'stopped'].includes(st.status);
    const eta = doneN >= 1 && doneN < n && t1Start && !over ? iso(now + ((now - t1Start) / doneN) * (n - doneN)) : null;
    const spentM = fDone && Number.isFinite(Number(f.cost)) && f.cost !== null ? Number(f.cost) : costs.total?.total ?? null;
    const p = run.price;
    const range = [p?.design, p?.estimate, run.estimate?.tokensM].find((x) => Array.isArray(x) && x.length === 2 && x.every((y) => Number.isFinite(Number(y)))) ?? null;
    const byRole = { plan: 0, exec: 0, review: 0, orch: 0 };
    for (const [role, v] of Object.entries(costs.total?.byRole ?? {})) byRole[ROLE_BUCKET[roleKey(role)] ?? 'orch'] += v;
    for (const k of Object.keys(byRole)) byRole[k] = Math.round(byRole[k] * 100) / 100;
    return {
      busy: !!st.driver || st.status === 'work' || (['stall', 'hang'].includes(st.status) && this.stallWithin(run.run, now)),
      snap: {
        run: run.run, sprint: run.spec ?? run.sprint ?? null, goal: plan?.h?.goal || t1?.title || run.run,
        mode: run.modeLabel === 'intermediate' ? 'intermediate' : run.mode ?? null, startedAt: iso(run.created), branch: run.branch ?? null, target: run.target ?? null, tree: r.tree,
        status: st.status, since: st.since, reason: st.reason, waitingFor: st.waitingFor ?? [],
        step: { key: batch && !ASK.includes(phase) ? 'batch' : phase, task: !batch && !planning && (TASK_STEPS.includes(phase) || (phase === 'ask-plan' && run.plansReady)) ? run.task ?? null : null },
        tasks, pre, post, questions: this.questions(r, st),
        cost: { spentM, priceM: range ? range.map(Number) : null, priceBasis: range ? (range === p?.design ? 'design' : 'estimate') : null, forecastM: spentM == null || over ? null : naiveForecast(spentM, run)?.forecastM ?? null, byRole },
        eta, feed: this.feed(r, st, marks, now),
      },
    };
  }

  // Newest sign of life of a run: run.json, the files of the run, its current task and batch dirs, its machine events.
  lastActivity(r, now) {
    const { run, root } = r;
    let t = Math.max(ms(run.updated), mtime(join(root, 'run.json')), ms(asList(this.ev.byRun.get(run.run)).at(-1)?.ts));
    if (now - t <= ABANDONED_MS) return t;
    for (const d of [root, taskDir(root, run.task ?? 1), join(root, 'batch')]) for (const f of readdir(d)) t = Math.max(t, mtime(join(d, f)));
    return t;
  }

  stallWithin(id, now) {
    if (!this.stallSeen.has(id)) this.stallSeen.set(id, now);
    return now - this.stallSeen.get(id) <= STALL_EXIT_MS;
  }

  // Question titles while the run waits for answers (ask-plan, ask): `### Q-n <title>` from the asking file, without ids.
  questions(r, st) {
    if (st.status !== 'waiting-user' || !['ask-plan', 'ask'].includes(r.run.phase)) return [];
    return this.qCache(r);
  }
  qCache(r) {
    const key = `q:${r.root}`;
    const stamp = `${mtime(join(r.root, 'run.json'))}|${mtime(join(r.root, 'answers.md'))}`;
    const c = this.cache.get(key);
    if (c?.stamp === stamp) return c.v;
    let v = [];
    try {
      const q = this.asked(r);
      if (q) v = questionInfo(q.file, q.ids).questions.map((x) => String(x).replace(/^Q-[\w-]+\s*[:.\-–—]?\s*/, '').trim() || String(x));
    } catch (e) { this.warn(e); }
    this.cache.set(key, { stamp, v });
    return v;
  }

  // The asking file and its open question ids, read only (computeState may write plan files: never called here).
  // ask-plan: the sprint plan, else the plan of the current task (legacy: the run's brief), questions without an answer
  // in answers.md, plus the price question of the price gate; ask: the newest result of the current task (or the batch
  // round) that reports questions.
  asked(r) {
    const { run, root } = r;
    if (run.phase === 'ask-plan') {
      const answers = join(root, 'answers.md');
      const answered = existsSync(answers) ? answeredIds(read(answers)) : [];
      const price = priceTurn(root, run)?.pending ? [PRICE_Q] : [];
      for (const file of [join(root, 'plan.md'), join(taskDir(root, run.task ?? 1), 'brief.md'), join(root, 'brief.md')]) {
        const open = asList(this.header(file)?.questions).filter((q) => !answered.includes(q));
        if (open.length) return { file, ids: file.endsWith('plan.md') ? [...open, ...price] : open };
      }
      return price.length ? { file: join(root, 'plan.md'), ids: price } : null;
    }
    const n = Number(run.count) || run.tasks?.length || 1;
    const dir = isLegacy(run) ? root : this.inBatch(run, n) ? join(root, 'batch') : taskDir(root, run.task ?? 1);
    const rounds = readdir(dir).map((f) => /^result-(\d+)\.md$/.exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => b - a);
    for (const k of rounds) {
      const h = this.header(join(dir, `result-${k}.md`));
      if (h && !h.errors && asList(h.questions).length) return { file: join(dir, `result-${k}.md`), ids: asList(h.questions) };
    }
    return null;
  }

  // Feed: important milestones (machine events, run files) and, under the driver, tool calls of its agents (newest first).
  feed(r, st, marks, now) {
    const { run } = r;
    const items = [];
    const ev = (at, who, key, params = {}, important = true) => { const a = iso(at); if (a) items.push({ at: a, who, kind: 'event', text: '', key, params, important }); };
    for (const e of asList(this.ev.byRun.get(run.run))) {
      const d = e.detail ?? {};
      if (e.type === 'question-waiting') ev(e.ts, ASK_WHO[d.step] ?? 'script', 'question-waiting', { task: e.task ?? null, n: asList(d.questions ?? d.files).length || null });
      else if (e.type === 'command-red') ev(e.ts, 'script', 'tests-red', { task: d.batch ? null : e.task ?? null, red: asList(d.commands).length || null, n: asList(d.commands).length });
      else if (e.type === 'task-end') ev(e.ts, 'script', 'task-committed', { task: e.task === 'batch' ? null : e.task ?? null, commit: d.commit ? String(d.commit).slice(0, 7) : null });
      else if (e.type === 'stall') ev(e.ts, 'script', 'stall', { kind: d.kind ?? null });
      else if (e.type === 'price-alert') ev(e.ts, 'script', 'price-alert', { spentM: e.costM ?? null, upperM: d.upperM ?? null });
      else if (e.type === 'merge-wait') ev(e.ts, 'script', 'merge-wait', {});
      else if (e.type === 'sprint-end') ev(e.ts, 'script', d.status === 'stopped' ? 'stopped' : 'merged', { commit: d.commit ? String(d.commit).slice(0, 7) : null });
      else if (e.type === 'mode-switch') ev(e.ts, 'script', 'mode-switch', {});
      else if (e.type === 'uat-waiting') ev(e.ts, 'script', 'uat-waiting', {});
      else if (['drive-start', 'drive-stop'].includes(e.type)) ev(e.ts, 'script', e.type === 'drive-start' ? 'driver-start' : 'driver-stop', {}, false);
    }
    // Red tests come from the machine log (each red round); from tests.md only when the log has none for the task.
    const redLogged = new Set(items.filter((x) => x.key === 'tests-red').map((x) => x.params.task));
    for (const m of marks) if (!(m.key === 'tests-red' && redLogged.has(m.params.task))) ev(m.at, m.who, m.key, m.params);
    if (['squashed', 'left'].includes(run.finish?.status) && !items.some((x) => x.key === 'merged')) ev(run.finish.at, 'script', 'merged', {});
    if (['stall', 'hang'].includes(st.status) && !items.some((x) => x.key === 'stall' && ms(x.at) >= ms(st.since) - 60e3)) ev(st.since, 'script', 'stall', {});
    const act = readActive(r.root);
    if (act?.cmd === 'finish' && act.start) ev(act.start, 'script', 'finish-start', {});
    // Tool calls of the driver's agents (drive.json children) and their subagents; files seen earlier keep their items.
    const files = this.feedFiles.get(run.run) ?? new Map();
    for (const c of Object.values(st.drive?.children ?? {})) {
      const main = this.tr.locate(c?.session, { now, every: AGENT_SCAN_MS });
      if (!main) continue;
      files.set(main, { who: ROLE_WHO[roleKey(c.agent)] ?? (roleKey(c.agent) || 'executor'), main: true });
      for (const s of this.tr.subagents(main, { now, every: AGENT_SCAN_MS })) files.set(s.file, { who: ROLE_WHO[roleKey(s.type)] ?? 'explorer', main: false });
    }
    this.feedFiles.set(run.run, files);
    for (const [file, x] of files) {
      for (const t of this.tr.scan(file, x.main).tools.slice(-FEED_MAX)) items.push({ at: iso(t.at), who: x.who, kind: t.kind, text: t.kind === 'run' || t.kind === 'search' ? t.raw : this.rel(t.raw, r.tree), key: null, params: null, important: false });
    }
    items.sort((a, b) => ms(b.at) - ms(a.at));
    const seen = [];
    return items.filter((x) => {
      const dup = x.kind === 'event' && seen.some((y) => y.key === x.key && y.params?.task === x.params?.task && Math.abs(ms(y.at) - ms(x.at)) < 5e3);
      if (x.kind === 'event') seen.push(x);
      return !dup;
    }).slice(0, FEED_MAX);
  }

  // Repo-relative path (run tree, else main tree), forward slashes; outside both only the last two segments.
  rel(p, tree) {
    if (!p) return '';
    const abs = isAbsolute(p) ? p : resolve(tree, p);
    for (const base of [tree, this.main]) {
      const x = relative(base, abs);
      if (x && !x.startsWith('..') && !isAbsolute(x)) return fwd(x);
    }
    return fwd(abs).split('/').filter(Boolean).slice(-2).join('/');
  }

  memory() {
    if (this.s.language === 'en' || !this.s.translate) return {};
    this.memFile ??= memoryFile(this.main, this.s.language);
    return this.cached(this.memFile, loadMemory) ?? {};
  }

  build(now = Date.now()) {
    this.events();
    const mem = this.memory();
    const runs = [];
    let busy = false;
    for (const r of this.discover(now)) {
      try {
        const x = this.runSnap(r, now, mem);
        if (!x) continue;
        runs.push(x.snap);
        busy ||= x.busy;
        if (!['stall', 'hang'].includes(x.snap.status)) this.stallSeen.delete(r.run.run);
      } catch (e) { this.warn(e); }
    }
    this.busy = busy;
    try { this.translate(runs, mem, now); } catch (e) { this.warn(e); }
    return { v: 1, writtenAt: new Date(now).toISOString(), intervalSec: this.intervalSec, writer: 'alive', language: this.s.language, runs };
  }

  write(snap) {
    mkdirSync(this.dir, { recursive: true });
    writeFileAtomic(this.file, `window.__dwmtLive = ${JSON.stringify(snap)};\n`);
    return fwd(this.file);
  }

  // Task titles missing in the view's translation memory: once per run (one retry after a failure) to the cheap model in a
  // detached process (`dwmt live --translate <request>`), which merges the answers into the memory; never waited for.
  translate(runs, mem, now) {
    if (this.s.language === 'en' || !this.s.translate) return;
    const stateFile = join(this.viewDir, 'live-translate.json');
    let state = null;
    for (const x of runs) {
      const missing = [...new Set(x.tasks.map((t) => t.title).filter((t) => t && !mem[sha1(t)]))];
      if (!missing.length) continue;
      state ??= (() => { try { return JSON.parse(read(stateFile)); } catch { return {}; } })();
      const rec = state[x.run] ?? { tries: 0 };
      const req = join(this.viewDir, `live-translate-${x.run}.json`);
      // One try at a time (the child removes its request when done); a request left by a child that never ran: 10 min.
      if (rec.tries >= 2 || (existsSync(req) && now - ms(rec.at) < 10 * 60e3)) continue;
      mkdirSync(this.viewDir, { recursive: true });
      writeFileSync(req, JSON.stringify({ language: this.s.language, model: this.s.model, timeoutS: this.s.translateTimeoutS, strings: missing.slice(0, 150) }));
      const env = { ...process.env };
      delete env.CLAUDE_CODE_SESSION_ID;
      const p = spawnDetached(process.execPath, [DWMT, 'live', '--translate', req], { cwd: this.main, env });
      state[x.run] = { tries: rec.tries + 1, at: new Date(now).toISOString(), pid: p?.pid ?? null };
      writeFileAtomic(stateFile, `${JSON.stringify(state)}\n`);
    }
  }
}

// ---------- translation of task titles (the detached child) ----------

const titlesPrompt = (lang, obj) => [
  `Translate the values of the JSON object below from English into the language with code "${lang}".`,
  'They are short task titles of a software sprint, read by the product owner.',
  'Plain product language, about as short as the source. Keep identifiers unchanged: ids, file paths, code, product and library names.',
  'Answer with one JSON object only, no other text, with exactly the same keys and one translated string per key.',
  '', JSON.stringify(obj, null, 0),
].join('\n');

export function translateTitles(main, file) {
  try {
    const req = JSON.parse(read(file));
    const strings = asList(req.strings).filter((s) => typeof s === 'string' && s.trim()).slice(0, 150);
    if (!strings.length || !req.language || req.language === 'en') return { ok: true, translated: 0 };
    const obj = Object.fromEntries(strings.map((s, i) => [`t${i + 1}`, s]));
    const r = cheapClaude(main, loadConfig(main), titlesPrompt(req.language, obj), { model: req.model ?? 'haiku', timeoutMs: (Number(req.timeoutS) || 120) * 1e3 });
    if (!r.ok) return { ok: false, error: r.error };
    const ans = answerJson(r.text);
    const got = {};
    strings.forEach((s, i) => { const v = ans[`t${i + 1}`]; if (typeof v === 'string' && v.trim()) got[sha1(s)] = v.replace(/\s+/g, ' ').trim(); });
    if (Object.keys(got).length) {
      const mf = memoryFile(main, req.language);
      mkdirSync(dirname(mf), { recursive: true });
      writeFileAtomic(mf, `${JSON.stringify({ ...loadMemory(mf), ...got }, null, 1)}\n`);
    }
    return { ok: true, translated: Object.keys(got).length };
  } catch (e) { return { ok: false, error: String(e.message).split(/\r?\n/)[0] }; } finally { try { rmSync(file, { force: true }); } catch { /* best effort */ } }
}

// ---------- the loop ----------

// A page built before a dwmt update (a view template newer than index.html) may not load live.js at all (report from a
// project, 2026-10-16): the writer rebuilds it from the current product data once at start, 0 tokens. Never throws.
// The page checked is the one refreshView writes (`pageFile`: the published page, else `.dwmt/product/view/index.html`;
// D-5, K2), so an old page under .dwmt/ left by the default move (D-8) is no trigger.
const VIEW_TEMPLATES = join(ROOT, 'templates', 'view');
export function rebuildStalePage(main) {
  try {
    const cfg = loadConfig(main);
    const pc = productConfig(main, cfg);
    const c = { top: main, cfg, pc, P: productPaths(main, pc) };
    const page = pageFile(c);
    if (!existsSync(page)) return false;
    const tpl = Math.max(...readdirSync(VIEW_TEMPLATES).map((f) => statSync(join(VIEW_TEMPLATES, f)).mtimeMs));
    if (statSync(page).mtimeMs >= tpl) return false;
    refreshView(c);
    return true;
  } catch { return false; }
}

// One writer per project: lock `<view dir>/live.lock` {pid, pidStart, start} (`wx`; a dead holder is taken over); another
// live writer holds it → exit at once. Every interval: snapshot → live.js. Two polls in a row without a run at work (or
// stalled for less than 10 min) and without a live driver → final snapshot with `writer: "ended"`, lock removed, exit.
// Exit race: a `dwmt state` that saved a work step between the last poll and the lock removal saw a live writer and
// started none; so after the removal one more look, and with work found the lock again (`wx`, a new writer that took it
// meanwhile wins) and on. `afterRelease`: test hook, called right after the removal.
export async function liveLoop(main, { interval = null, maxPolls = Infinity, transcripts = null, afterRelease = null } = {}) {
  const w = new LiveWriter(main, { intervalSec: interval, transcripts });
  const lockFile = join(w.viewDir, LOCK_FILE);
  mkdirSync(w.viewDir, { recursive: true });
  const lk = acquireLockFile(lockFile);
  if (!lk.ok) return { ok: true, exited: 'lock held', pid: lk.held?.pid ?? null };
  rebuildStalePage(main);
  const mine = () => readLockFile(lockFile)?.pid === process.pid;
  let stop = false;
  let wake = null;
  const onSignal = () => { stop = true; wake?.(); };
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) { try { process.on(s, onSignal); } catch { /* not on this OS */ } }
  let polls = 0;
  let idle = 0;
  let resumed = 0;
  let reason = 'signal';
  try {
    for (;;) {
      if (!mine()) { reason = 'lock lost'; return { ok: true, exited: reason, polls }; }
      let snap = null;
      try { snap = w.build(); } catch (e) { w.warn(e); w.busy = false; }
      polls++;
      idle = w.busy ? 0 : idle + 1;
      const end = stop || idle >= IDLE_POLLS || polls >= maxPolls || !existsSync(w.main);
      if (snap) { try { w.write(end ? { ...snap, writer: 'ended' } : snap); } catch (e) { w.warn(e); } }
      if (end) {
        reason = stop ? 'signal' : idle >= IDLE_POLLS ? 'idle' : polls >= maxPolls ? 'polls' : 'main tree gone';
        if (reason !== 'idle') break;
        if (mine()) rmSync(lockFile, { force: true });
        try { afterRelease?.(); } catch { /* test hook */ }
        let work = false;
        try { w.build(); work = w.busy; } catch (e) { w.warn(e); }
        if (!work || !acquireLockFile(lockFile).ok) break;
        idle = 0;
        resumed++;
        continue;
      }
      await new Promise((res) => { const t = setTimeout(res, w.intervalSec * 1e3); wake = () => { clearTimeout(t); res(); }; });
      wake = null;
    }
    return { ok: true, exited: reason, polls, resumed, warnings: w.warnings };
  } finally {
    if (mine()) rmSync(lockFile, { force: true });
    for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) { try { process.off(s, onSignal); } catch { /* not on this OS */ } }
  }
}

// `dwmt live` (loop), `dwmt live --once [--out <dir>]` (one snapshot, printed), `dwmt live --translate <request>` (child).
export async function liveMain(top, opts = {}) {
  const main = contextHome(top);
  if (typeof opts.translate === 'string') return translateTitles(main, opts.translate);
  const interval = Number(opts.interval) > 0 ? Number(opts.interval) : null;
  if (opts.once) {
    const w = new LiveWriter(main, { out: typeof opts.out === 'string' ? opts.out : null, intervalSec: interval });
    const snap = w.build();
    return { ok: true, file: w.write(snap), busy: w.busy, warnings: w.warnings, ...snap };
  }
  return liveLoop(main, { interval, maxPolls: Number(opts.polls) > 0 ? Number(opts.polls) : Infinity });
}
