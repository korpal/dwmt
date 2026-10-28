// K5 D-8, D-9: a watcher for a session started by `dwmt launch` (pattern: bg-agent.mjs#waitBg). `cmdLaunch` starts it as a
// detached node process (`dwmt launch-watch <run> <id> [--attempt n]`); it polls `claude agents --json` and the session's
// transcript with `sessionVerdict` until the session waits for the user, ends its turn without an API error, hits the
// subscription limit or outlives `drive.agentTimeoutMin`. A failed session (error, no-start, dead) is relaunched once
// through `cmdLaunch` (attempt 2, its own watcher); at attempt 2 the watcher records `run.sessionFailure`, marks the run
// stopped through the status file (runs with a sprint) and sends one desktop notification.
import { join } from 'node:path';
import { homedir } from 'node:os';
import { listBg, readTurn, sessionVerdict, stopBg, rowOf, transcriptFile } from './bg-agent.mjs';
import { cmdLaunch } from './sessions.mjs';
import { loadConfig } from './config.mjs';
import { loadRun, saveRun, writeStatus, runEvent } from './run.mjs';
import { notify } from './platform.mjs';
import { asList } from './util.mjs';
import { SESSION_FAILURES } from '../watch.mjs';

export { SESSION_FAILURES };

const CAUSE = { error: 'agent-error', dead: 'child-dead', 'no-start': 'no-start' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One notification line for a session-failure stop (D-9): the sprint, the cause and how to resume.
export const failureLine = (run, cause) => `dwmt ${run?.sprint ?? run?.run ?? ''}: ${cause} — /dwmt:execute ${run?.run ?? ''}`;

// The desktop notification of a session-failure stop (D-9) → true when sent. Batch F-4: a run under the supervisor (its
// drivers and launches carry `DWMT_SUPERVISED`, supervise.mjs#childEnv) leaves it to the supervisor, which queues toasts in
// quiet hours and resumes infra stops (child-dead) by itself; `notified` stays false, so its `stopItem` toasts.
export function notifyFailure(run, cause, env = process.env) {
  if (env?.DWMT_SUPERVISED) return false;
  try { return !!notify(failureLine(run, cause)); } catch { return false; }
}

// → {ok, result: waiting|ended|limit|timeout|relaunched|failed, attempt, cause?, id?}. `launch` is the test seam of cmdLaunch.
export async function watchLaunch(top, id, bgId, { attempt = 1, env = process.env, pollMs = null, launch = cmdLaunch } = {}) {
  const cfg = loadConfig(top);
  const run0 = loadRun(top, id, { register: false });
  const since = asList(run0.launches).find((l) => l.id === bgId)?.at ?? new Date().toISOString();
  const t0 = Date.parse(since) || Date.now();
  const firstStepMin = cfg.drive?.firstStepMin ?? 5;
  const timeoutMin = cfg.drive?.agentTimeoutMin ?? 240;
  const every = pollMs ?? (Number(env.DWMT_BG_POLL_MS) || 10e3);
  const root = env.DWMT_TRANSCRIPTS || join(homedir(), '.claude', 'projects');
  let seen = false;
  let missing = 0;
  let sessionId = null;
  let turn = null;
  for (;;) {
    const rows = await listBg({ cwd: top, env });
    const row = rowOf(rows, bgId);
    if (row) { seen = true; missing = 0; } else if (rows) missing++;
    if (!sessionId && row?.sessionId) sessionId = row.sessionId;
    const f = transcriptFile(sessionId, root);
    turn = f ? readTurn(f, since) : turn;
    if (row?.status === 'waiting') return { ok: true, result: 'waiting', attempt };
    if (turn?.limit) return { ok: true, result: 'limit', attempt };
    if (turn?.ended && !turn.apiError && row?.status !== 'busy') return { ok: true, result: 'ended', attempt };
    const elapsedMin = (Date.now() - t0) / 60e3;
    const verdict = sessionVerdict({ turn, row, gone: (seen && missing >= 2) || (!seen && missing >= 10), elapsedMin, firstStepMin });
    if (verdict !== 'working') {
      const error = verdict === 'error' ? `${turn.apiError}${turn.result ? `: ${turn.result.slice(0, 200)}` : ''}`
        : verdict === 'no-start' ? `sesja ${bgId} bez pierwszego kroku po ${firstStepMin} min (drive.firstStepMin)`
          : `sesja ${bgId} zniknęła z claude agents bez końca tury`;
      if (row) await stopBg(bgId, { cwd: top, env });
      return failed(top, id, { attempt, cause: CAUSE[verdict], error, launch, env });
    }
    if (elapsedMin > timeoutMin) return { ok: true, result: 'timeout', attempt };
    await sleep(every);
  }
}

function failed(top, id, { attempt, cause, error, launch, env = process.env }) {
  if (attempt < 2) {
    const r = launch(top, id, { attempt: attempt + 1 });
    if (r?.ok) return { ok: true, result: 'relaunched', attempt, cause, id: r.id };
    error = `${error}; ponowny start: ${r?.error ?? 'nieudany'}`;
  }
  const run = loadRun(top, id, { register: false });
  const notified = notifyFailure(run, cause, env);
  // `at` after the notification, right before saveRun: run.json growth past `at` reads as a resumed run (watch.mjs#sessionStall).
  run.sessionFailure = { at: new Date().toISOString(), cause, error, attempts: attempt, notified };
  saveRun(top, run);
  try { writeStatus(top, run, 'stopped', { reason: `${cause}: ${error}`, notified }); } catch { /* status best effort */ }
  runEvent(top, run, 'session-failure', { detail: run.sessionFailure });
  return { ok: true, result: 'failed', attempt, cause, error, notified };
}
