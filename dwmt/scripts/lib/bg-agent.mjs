// K4 T-5 (D-3, D-10, D-30, D-31): driver agent as a Claude background session (`claude --bg`), visible in `claude agents`
// and open with `claude attach <id>`. Probe 2026-10-23, CLI 2.1.309 (docs/capabilities.md T-BG1): `--bg` accepts `--agent`,
// `--plugin-dir`, `--permission-mode`, `--strict-mcp-config`, `--settings`; it ignores `--session-id` (the session id is the
// daemon's) and does not enforce `--max-turns`; the final answer is the last assistant text of the transcript (`state.json`
// `output.result` is a summary written by another model); the end of a turn is `system/turn_duration` in the transcript and
// `status: idle` in `claude agents --json`; `claude stop` + `claude rm` remove the session from the list.
// Outcome: the shape of `drive.mjs#agentOutcome` ({ok, code, result, sessionId, costUsd, cause, error}); `costUsd` is null,
// the step's cost in millions comes from the transcript (`sessionsCost`).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sessionName, LAUNCH_ENV } from './sessions.mjs';

const fwd = (p) => String(p).replace(/\\/g, '/');
const stripAnsi = (s) => String(s ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const transcriptsRoot = (env) => env.DWMT_TRANSCRIPTS || join(homedir(), '.claude', 'projects');

// `claude` or the test fake (`DWMT_CLAUDE`, a node script).
export function claudeBin(env = process.env) {
  return env.DWMT_CLAUDE ? [process.execPath, [env.DWMT_CLAUDE]] : ['claude', []];
}

const ROLE_PL = { 'dwmt-architect': 'architekt', 'dwmt-reviewer': 'recenzent', 'dwmt-checker': 'kontrola celu', 'dwmt-ui-verifier': 'weryfikator UI' };
// D-31: `dwmt <sprint or run without date> · T-k rN · <step> · <role>`; batch round `batch rN`, goal check and finish
// repair `—`. Role in Polish for `language: pl`, otherwise the agent name without `dwmt-`.
export function bgName({ run, task = null, round = null, step, agent, batch = false, lang = 'en' }) {
  const base = sessionName({ ...run, task: null });
  const r = `r${round ?? 1}`;
  const where = step === 'goal-check' || step === 'finish-repair' ? '—' : batch ? `batch ${r}` : task != null ? `T-${task} ${r}` : '—';
  // Role variants (`dwmt-reviewer-high` of `review.docsOnlyRole`, `dwmt-executor-high`) take the base role's name.
  const base0 = Object.keys(ROLE_PL).find((k) => agent === k || String(agent).startsWith(`${k}-`));
  const pl = step === 'finish-repair' ? 'naprawa przy finish' : base0 ? ROLE_PL[base0] : String(agent).startsWith('dwmt-executor') ? 'wykonawca' : null;
  const role = lang === 'pl' && pl ? pl : String(agent).replace(/^dwmt-/, '');
  return `${base} · ${where} · ${step} · ${role}`;
}

// Arguments of `claude --bg` (pattern: sessions.mjs#cmdLaunch): prompt right after the name, before multi-value options
// (T-S1 fact 4); `--settings` with `worktree.bgIsolation: none`, the env the agent needs (the parent env does not reach a
// background session, T-S1 fact 2) and the plugins switched off as in `launch.lean`. No `--session-id`, no `--max-turns`
// (ignored by `--bg`, probe T-BG1): the adapter enforces the turn limit.
export function bgArgs({ name, prompt, agent, resume = null, root, model, effort, permissionMode = null, plugins = {}, env = {}, deny = [] }) {
  const settings = { worktree: { bgIsolation: 'none' }, env: { ...LAUNCH_ENV, ...env }, ...(Object.keys(plugins ?? {}).length ? { enabledPlugins: plugins } : {}) };
  return ['--bg', '-n', name, prompt, '--plugin-dir', fwd(root), '--strict-mcp-config', ...(permissionMode ? ['--permission-mode', permissionMode] : []),
    ...(resume ? ['--resume', resume] : ['--agent', agent]), '--settings', JSON.stringify(settings), '--model', model, '--effort', effort,
    ...(deny.length ? ['--disallowedTools', deny.join(',')] : [])];
}

// Start: `backgrounded · <id> · <name>` on stdout. Failure (exit ≠ 0, no id, untrusted workspace) → {ok: false, error}.
export function startBg(args, { cwd, env = process.env } = {}) {
  const [bin, pre] = claudeBin(env);
  const r = spawnSync(bin, [...pre, ...args], { cwd, env, encoding: 'utf8', timeout: 120e3, windowsHide: true });
  const out = stripAnsi([r.stdout, r.stderr, r.error?.message].filter(Boolean).join('\n'));
  const m = /backgrounded\s*·\s*(\S+)\s*·/.exec(out);
  if (!m) return { ok: false, error: `exit ${r.status ?? '-'}${out.trim() ? `: ${out.trim().split(/\r?\n/)[0].slice(0, 200)}` : ''}` };
  return { ok: true, id: m[1] };
}

function runAsync(args, { cwd, env, timeout = 60e3 }) {
  const [bin, pre] = claudeBin(env);
  return new Promise((done) => {
    let out = '';
    let p;
    try { p = spawn(bin, [...pre, ...args], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { done({ code: null, out: '', error: e.message }); return; }
    const t = setTimeout(() => { try { p.kill(); } catch { /* already gone */ } }, timeout);
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', (e) => { clearTimeout(t); done({ code: null, out, error: e.message }); });
    p.on('close', (code) => { clearTimeout(t); done({ code, out: stripAnsi(out) }); });
  });
}

// Rows of `claude agents --json` (null when the command fails: the poll does not count as „gone”).
export async function listBg({ cwd, env = process.env } = {}) {
  const r = await runAsync(['agents', '--json'], { cwd, env, timeout: 60e3 });
  if (r.code !== 0) return null;
  try { const j = JSON.parse(r.out); return Array.isArray(j) ? j : null; } catch { return null; }
}
export const rowOf = (rows, id) => rows?.find((a) => String(a.id ?? '') === id || String(a.sessionId ?? '').startsWith(id)) ?? null;

export function transcriptFile(sessionId, root) {
  if (!sessionId || !existsSync(root)) return null;
  for (const p of readdirSync(root)) { const f = join(root, p, `${sessionId}.jsonl`); if (existsSync(f)) return f; }
  return null;
}

// This step's part of the main transcript (lines from `since` on; with `--resume` the file holds earlier turns too):
// assistant API calls, the last assistant text, the end of the turn, an API error.
export function readTurn(file, since) {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const calls = new Set();
  let last = null;
  let lastText = '';
  let ended = false;
  let lastId = null;
  let lastTool = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.timestamp && d.timestamp < since) continue;
    if (d.type === 'assistant' && !d.isSidechain) {
      const id = d.requestId || d.message?.id || calls.size;
      calls.add(id);
      if (id !== lastId) { lastId = id; lastTool = false; }
      last = d;
      ended = false;
      const content = Array.isArray(d.message?.content) ? d.message.content : [];
      if (d.message?.stop_reason === 'tool_use' || content.some((c) => c.type === 'tool_use')) lastTool = true;
      const t = content.filter((c) => c.type === 'text').map((c) => c.text).join('');
      if (t) lastText = t;
    } else if (d.type === 'system' && d.subtype === 'turn_duration') ended = true;
  }
  return { calls: calls.size, result: lastText, ended, apiError: last?.isApiErrorMessage || last?.error ? String(last.error ?? 'api error') : null, lastTool, limit: last?.error === 'rate_limit' };
}

// Batch T-5/F-3: the limit is reached like `claude -p --max-turns N`: N calls whose last one asked for a tool (call N+1 would
// follow), or more than N calls. A final answer as call N waits for `turn_duration` (or the timeout).
export const turnLimitReached = (turn, maxTurns) => !!(maxTurns && turn && (turn.calls > maxTurns || (turn.calls >= maxTurns && turn.lastTool)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// K5 D-7, D-8: the verdict on a background session at one poll, shared by the driver (`waitBg`) and the launch watcher.
// `turn`: readTurn since the step start (null = no transcript yet); `row`: its `claude agents --json` row (null = not
// listed); `gone`: the session counts as gone from the list (the caller's missing-poll rule); `elapsedMin` since the
// step start. → 'error' (an API error other than the subscription limit is the last assistant line and the session is
// not busy), 'dead' (gone before the end of its turn), 'no-start' (no assistant call after `firstStepMin` and the session
// is neither busy nor waiting for the user: a busy session may still be thinking, plan A-2) or 'working'.
export function sessionVerdict({ turn = null, row = null, gone = false, elapsedMin = 0, firstStepMin = 5 } = {}) {
  const busy = row?.status === 'busy';
  if (turn?.apiError && !turn.limit && !busy) return 'error';
  if (gone && !turn?.ended) return 'dead';
  if ((!turn || !turn.calls) && !busy && row?.status !== 'waiting' && elapsedMin > firstStepMin) return 'no-start';
  return 'working';
}

// Waits for the end of the agent's turn. `maxTurns`: at that many assistant calls without the end of the turn the adapter
// stops the session (`cause: max-turns`, as `error_max_turns` of `claude -p`); `timeoutMin`: `cause: timeout`; the
// session gone from the list before the end of the turn: `cause: dead`; K5 D-7 (`sessionVerdict`): an API error with the
// session not busy: `cause: error`; no assistant call after `firstStepMin` with the session not busy: `cause: no-start`.
// `onSession(id)` once the session id is known, `onWaiting(row)` once per approval wait (`status: waiting`).
export async function waitBg(id, { cwd, env = process.env, since = new Date().toISOString(), maxTurns = null, timeoutMin = 240, firstStepMin = 5, pollMs = 3000, onSession = null, onWaiting = null } = {}) {
  const root = transcriptsRoot(env);
  const t0 = Date.now();
  let sessionId = null;
  let seen = false;
  let missing = 0;
  let waiting = false;
  let turn = null;
  const out = (o) => ({ code: o.ok ? 0 : null, result: turn?.result ?? '', sessionId, costUsd: null, ...o });
  for (;;) {
    const rows = await listBg({ cwd, env });
    const row = rowOf(rows, id);
    if (row) { seen = true; missing = 0; } else if (rows) missing++;
    if (!sessionId && row?.sessionId) { sessionId = row.sessionId; onSession?.(sessionId); }
    const f = transcriptFile(sessionId, root);
    turn = f ? readTurn(f, since) : turn;
    if (turn?.ended && !turn.apiError && (!row || row.status !== 'busy')) return out({ ok: true, cause: null, error: null });
    // Batch T-5/F-9: the subscription limit (T-S12: last assistant line `error: rate_limit`) ends the step at once, whether
    // or not the session ends its turn (a background session may wait for the reset); the driver's `limitStop` reads it.
    if (turn?.limit) {
      await stopBg(id, { cwd, env });
      return out({ ok: false, cause: 'error', error: `rate_limit${turn.result ? `: ${turn.result.slice(0, 300)}` : ''}` });
    }
    if (row?.status === 'waiting') { if (!waiting) { waiting = true; onWaiting?.(row); } } else waiting = false;
    if (turnLimitReached(turn, maxTurns)) {
      await stopBg(id, { cwd, env });
      return out({ ok: false, cause: 'max-turns', error: `limit tur (${maxTurns}, licznik sterownika)` });
    }
    if (Date.now() - t0 > timeoutMin * 60e3) {
      await stopBg(id, { cwd, env });
      return out({ ok: false, cause: 'timeout', error: `limit czasu agenta ${timeoutMin} min (drive.agentTimeoutMin)` });
    }
    const verdict = sessionVerdict({ turn, row, gone: (seen && missing >= 2) || (!seen && missing >= 10), elapsedMin: (Date.now() - t0) / 60e3, firstStepMin });
    if (verdict === 'error') {
      if (row) await stopBg(id, { cwd, env });
      return out({ ok: false, cause: 'error', error: `${turn.apiError}${turn.result ? `: ${turn.result.slice(0, 300)}` : ''}` });
    }
    if (verdict === 'no-start') {
      await stopBg(id, { cwd, env });
      return out({ ok: false, cause: 'no-start', error: `sesja w tle ${id} bez pierwszego kroku po ${firstStepMin} min (drive.firstStepMin)` });
    }
    if (verdict === 'dead') return out({ ok: false, cause: 'dead', error: `sesja w tle ${id} zniknęła z claude agents bez końca tury` });
    await sleep(pollMs);
  }
}

export function stopBg(id, { cwd, env = process.env } = {}) { return runAsync(['stop', id], { cwd, env, timeout: 30e3 }); }

// After the step, a timeout or a dead driver: `claude stop` and `claude rm` (the list does not grow; the transcript stays).
export async function closeBg(id, { cwd, env = process.env } = {}) {
  const s = await stopBg(id, { cwd, env });
  const r = await runAsync(['rm', id], { cwd, env, timeout: 30e3 });
  return { stopped: s.code === 0, removed: r.code === 0 };
}
