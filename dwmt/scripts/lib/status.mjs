// dwmt: status dla supervisora, aktywne przebiegi, `watch` i `wait`.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { watchLoop, assess, waitDriver, driverAlive } from '../watch.mjs';
import { read, samePath, printJson } from './util.mjs';
import { loadConfig } from './config.mjs';
import { loadRun, saveRun, runHome, writeStatus, checkedRunDir } from './run.mjs';
import { computeState } from './state.mjs';

// Status ręczny (§5.10): np. `stopped` z powodem; pętla czyta go jak automatyczne.
export function cmdStatus(top, id, state, opts) {
  const run = loadRun(top, id);
  if (!run.sprint) return { ok: false, error: 'status tylko dla przebiegu z --sprint (supervisor)' };
  const STATES = ['planning', 'waiting-user', 'planned', 'running', 'handoff', 'merge-wait', 'done', 'stopped'];
  if (!STATES.includes(state)) throw new Error(`stan ${state}, dozwolone: ${STATES.join('|')}`);
  return { ok: true, file: writeStatus(top, run, state, typeof opts.reason === 'string' ? { reason: opts.reason } : {}) };
}

export function activeRuns(top) {
  const base = join(top, '.dwmt', 'runs');
  if (!existsSync(base)) return [];
  const cfg = loadConfig(top);
  return readdirSync(base).flatMap((id) => {
    try {
      const run = JSON.parse(read(join(base, id, 'run.json')));
      if (['squashed', 'left'].includes(run.finish?.status)) return [];
      // Kopia przebiegu z worktree (v2.6: `archiveOf`; starsze kopie: sam raport bez zadania i briefu) to archiwum.
      if (run.archiveOf && !samePath(run.archiveOf, top)) return [];
      if (existsSync(join(base, id, 'final-report.md')) && !['task.md', 'brief.md', 'tasks'].some((f) => existsSync(join(base, id, f)))) return [];
      return [{ id, next: computeState(join(base, id), run, cfg).next }];
    } catch { return []; }
  });
}

// v2.10: `dwmt watch <run>` pod narzędziem Monitor: cisza, póki ktoś pracuje; przy przestoju albo zawieszeniu jedna linia
// dla człowieka i zdarzenie `stall`. `--once`: jedna ocena jako JSON (diagnostyka). Nie zmienia run.json.
export function cmdWatch(top, id, opts) {
  const root = checkedRunDir(top, id);
  const cfg = loadConfig(top);
  const load = () => JSON.parse(read(join(root, 'run.json')));
  // run.json w trakcie zapisu: kilka prób, zanim błąd.
  let run;
  for (let i = 0; !run; i++) {
    try { run = load(); } catch (e) { if (i >= 9) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); }
  }
  if (opts.once) return printJson(assess({ root, run, watch: cfg.watch }));
  watchLoop({
    load, root, runId: id, project: runHome(run, top), watch: cfg.watch, lang: cfg.language,
    interval: opts.interval ? Number(opts.interval) : null, maxPolls: opts.polls ? Number(opts.polls) : Infinity, follow: !!opts.follow,
  });
  return undefined;
}

// N-2: `dwmt wait <run>` w tle (bez limitu czasu): czeka na sterownik i wypisuje jedną linię JSON `{status, reason}`,
// gdy przebieg potrzebuje sesji (zatrzymanie sterownika, jego śmierć bez zdarzenia końca, zawieszenie komendy).
export function cmdWait(top, id, opts) {
  const root = checkedRunDir(top, id);
  const cfg = loadConfig(top);
  const load = () => JSON.parse(read(join(root, 'run.json')));
  waitDriver({
    root, runId: id, project: runHome(load(), top), load, watch: cfg.watch, lang: cfg.language,
    interval: opts.interval ? Number(opts.interval) : null, maxPolls: opts.polls ? Number(opts.polls) : Infinity,
    progress: !!opts.progress, after: typeof opts.after === 'string' ? opts.after : null,
  });
  return undefined;
}

// Tryb A: `drive-mode <run> on|off`. `off`: `state` nie daje `drive`, sesja prowadzi pętlę sama (np. po błędzie sterownika).
export function cmdDriveMode(top, id, mode) {
  const root = checkedRunDir(top, id);
  if (!['on', 'off'].includes(mode)) throw new Error('drive-mode <run> on|off');
  if (mode === 'off' && driverAlive(root)) return { ok: false, error: 'sterownik tego przebiegu działa: najpierw jego koniec (dwmt wait)' };
  const run = loadRun(top, id);
  if (mode === 'off') run.drive = false; else delete run.drive;
  saveRun(top, run);
  return { ok: true, drive: mode };
}

// Tryb A: ostatnie linie `drive.log` (pytanie „status?” w sesji, która czeka na sterownik).
export function cmdDriveLog(top, id, opts) {
  const root = checkedRunDir(top, id);
  const f = join(root, 'drive.log');
  const n = Math.min(Math.max(Number(opts.lines) || 5, 1), 30);
  const lines = existsSync(f) ? readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).slice(-n) : [];
  return { ok: true, running: !!driverAlive(root), lines };
}
