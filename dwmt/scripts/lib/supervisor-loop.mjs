// dwmt S3: lekkie wejście do pętli supervisora dla `product brief`, `uat record` i komend: ścieżki, życie pętli, start pętli
// w tle (odłączony proces, jeden na projekt) i jedna linia stanu zlecenia. Bez importów mechaniki przebiegu (bez cykli).
import { existsSync, readFileSync, mkdirSync, openSync, closeSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, fwd } from './util.mjs';
import { readLockFile, processAlive } from '../watch.mjs';

export const SUPERVISE = join(ROOT, 'scripts', 'supervise.mjs');
export const supDir = (main) => join(main, '.dwmt', 'supervisor');
export const supFile = (main) => join(supDir(main), 'supervisor.json');
export const loopLockFile = (main) => join(supDir(main), 'loop.lock');

export function readSup(main) {
  try { return JSON.parse(readFileSync(supFile(main), 'utf8')); } catch { return null; }
}

// Żywa pętla (rekord `loop.lock`) albo null.
export function loopAlive(main, aliveFn = processAlive) {
  const l = readLockFile(loopLockFile(main));
  return l && aliveFn(l.pid, l.pidStart ?? null) ? l : null;
}

// Zlecenie, które potrzebuje pętli: otwarte, nie wstrzymane w całości i nie zakończone.
// Recenzja S3 (6): także zlecenie z niedostarczonym powiadomieniem (kolejka godzin ciszy) albo żywą sesją push.
export const needsLoop = (sup) => !!sup && ((!sup.finished && !(sup.closed && !sup.items?.some((x) => x.act || ['running', 'starting'].includes(x.state))) && !sup.held) || !!sup.notifyQueue?.length || !!sup.pushSessions?.length);

// Nowe zdarzenie UAT (`status/<id>.uat.json`, `seq` ponad obsłużony) po końcu zakresu: pętla potrzebna (sprint poprawek).
function newUat(main, sup) {
  try {
    const dir = join(supDir(main), 'status');
    return readdirSync(dir).filter((f) => f.endsWith('.uat.json')).some((f) => {
      const id = f.slice(0, -'.uat.json'.length);
      const evs = JSON.parse(readFileSync(join(dir, f), 'utf8')).events ?? [];
      return sup.items?.some((x) => x.id === id) && evs.some((e) => (e.seq ?? 0) > (sup.seqs?.uat?.[id] ?? 0));
    });
  } catch { return false; }
}

// Start pętli w tle (S9: tylko przy zleceniu, które jej potrzebuje). Proces odłączony, bez okna, wyjście do `loop.out`;
// przeżywa sesję, która go uruchomiła. Druga pętla nie rusza (blokada `loop.lock` w samej pętli).
export function ensureLoop(main, { env = process.env } = {}) {
  const sup = readSup(main);
  if (!needsLoop(sup) && !(sup && !sup.closed && !sup.held && newUat(main, sup))) return { running: false, reason: sup ? 'order needs no loop' : 'no order' };
  const held = loopAlive(main);
  if (held) return { running: true, pid: held.pid };
  if (env.DWMT_SUPERVISE_NOSPAWN === '1') return { running: false, reason: 'spawn disabled (DWMT_SUPERVISE_NOSPAWN)' };
  mkdirSync(supDir(main), { recursive: true });
  const fd = openSync(join(supDir(main), 'loop.out'), 'a');
  const e = { ...env };
  delete e.CLAUDE_CODE_SESSION_ID;
  try {
    const p = spawn(process.execPath, [SUPERVISE, 'run'], { cwd: main, detached: true, stdio: ['ignore', fd, fd], windowsHide: true, env: e });
    p.unref();
    return { running: true, started: true, pid: p.pid };
  } finally { closeSync(fd); }
}

// Jedna linia dla `product brief` (≤ ok. 200 znaków): pozycje według stanu, pytania zarządcze, sesje do `attach`.
export function briefLine(main) {
  const sup = readSup(main);
  if (!sup || sup.finished) return null;
  const by = {};
  for (const it of sup.items ?? []) (by[it.state] ??= []).push(it.id);
  const attach = (sup.items ?? []).filter((x) => x.stopSession?.id && x.state === 'waiting-user').map((x) => `${x.id}: claude attach ${x.stopSession.id}`);
  const pend = (sup.pending ?? []).filter((p) => !p.answer).map((p) => p.id);
  const parts = Object.entries(by).map(([s, ids]) => `${s} ${ids.join(',')}`);
  return `order${sup.closed ? ' (closed)' : sup.held ? ' (held)' : ''}: ${parts.join('; ') || 'empty'}${sup.infra ? `; waiting for the environment: ${sup.infra.text}` : ''}${pend.length ? `; pending ${pend.join(',')} (supervise status)` : ''}${attach.length ? `; ${attach.join('; ')}` : ''}${loopAlive(main) ? '' : '; loop not running'}`.slice(0, 300);
}

// Sprinty w toku, które potrzebują użytkownika (`brief`, widok produktu; zgłoszenie z 2026-10-15): pozycja zlecenia
// zatrzymana przez sterownik (linia roadmapy zostaje `running`, bo przebieg i worktree są) albo pytanie sprintu.
export function haltsOf(main) {
  const out = {};
  const dir = join(supDir(main), 'status');
  let files = [];
  try { files = readdirSync(dir).filter((x) => /^[^.]+\.json$/.test(x)); } catch { /* bez statusów */ }
  for (const f of files) {
    try {
      const s = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (s.state === 'waiting-user') out[s.sprint ?? f.slice(0, -5)] = { kind: 'waiting', reason: (Array.isArray(s.questions) ? s.questions[0] : null) ?? null };
    } catch { /* zapis w toku */ }
  }
  for (const it of readSup(main)?.items ?? []) if (it.state === 'stopped') out[it.id] = { kind: 'stopped', reason: String(it.reason ?? '').split(/\r?\n/)[0].slice(0, 140) };
  return out;
}

export const supPath = (main, f) => fwd(join(supDir(main), f));
export const hasOrder = (main) => existsSync(supFile(main));
