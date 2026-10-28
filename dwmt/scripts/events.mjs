// dwmt v2.10: dziennik zdarzeń maszyny `~/.dwmt/events.jsonl` (DWMT_HOME w testach), jedna linia JSON na zdarzenie:
// {ts, type, project: {name, root}, run, session, task?, verdict?, costM?, detail?}. Piszą go skrypty w punktach, które już
// istnieją (stan, verify, commit, finish, uat, watch); czyta go człowiek, supervisor i sterownik (0 tokenów).
// Zapis nigdy nie psuje wywołującego (błędy połknięte). Rotacja po rozmiarze: plik > maxBytes → `events.jsonl.1`.
// Wyłączenie: `events: false` w ~/.dwmt/machine.json albo DWMT_EVENTS=0.
import { appendFileSync, mkdirSync, statSync, renameSync, readFileSync, existsSync, rmSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { home, machineConfig } from './machine.mjs';
import { canonPath } from './lib/util.mjs';

export const EVENT_TYPES = ['task-start', 'task-end', 'question-waiting', 'command-red', 'stall', 'sprint-end', 'uat-waiting', 'merge-wait', 'uat-recorded', 'drive-start', 'drive-stop', 'supervisor', 'agent-waiting'];
export const EVENTS_MAX_BYTES = 5 * 1024 * 1024;
export const eventsFile = () => join(home(), 'events.jsonl');

export const projectOf = (root) => { const c = canonPath(root); return { name: basename(c), root: c }; };

function enabled() {
  if (process.env.DWMT_EVENTS === '0') return false;
  try { return machineConfig().events !== false; } catch { return true; }
}

// Rotacja pod blokadą (katalog `events.lock`): dwa procesy, które oba widziały duży plik, nie przenoszą go dwa razy (drugi
// rename nadpisałby `.1` świeżym plikiem). Pod blokadą rozmiar sprawdzany jeszcze raz; blokada starsza niż 30 s jest martwa.
function rotate(f, maxBytes) {
  const lock = `${f}.lock`;
  try { mkdirSync(lock); } catch {
    try { if (Date.now() - statSync(lock).mtimeMs > 30e3) rmSync(lock, { recursive: true, force: true }); } catch { /* zwolniona */ }
    return;
  }
  try { if (statSync(f).size > maxBytes) renameSync(f, `${f}.1`); } finally { rmSync(lock, { recursive: true, force: true }); }
}

// Zdarzenie: `type`, `project` (ścieżka głównego drzewa albo {name, root}), `run`; reszta pól opcjonalna. Zwraca zapisaną linię albo null.
export function emit(ev, { maxBytes = Number(process.env.DWMT_EVENTS_MAX) || EVENTS_MAX_BYTES } = {}) {
  try {
    if (!ev?.type || !enabled()) return null;
    const f = eventsFile();
    mkdirSync(home(), { recursive: true });
    try { if (statSync(f).size > maxBytes) rotate(f, maxBytes); } catch { /* brak pliku */ }
    const { type, project, run, ...rest } = ev;
    const line = {
      ts: new Date().toISOString(), type,
      project: typeof project === 'string' ? projectOf(project) : project?.root ? { ...project, root: canonPath(project.root) } : project ?? null,
      run: run ?? null, session: process.env.CLAUDE_CODE_SESSION_ID || null,
      ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && v !== null)),
    };
    appendFileSync(f, `${JSON.stringify(line)}\n`);
    return line;
  } catch { return null; }
}

// Odczyt (testy, watch, sterownik): zdarzenia bieżącego pliku, opcjonalnie tylko przebiegu `run`.
export function readEvents({ run = null } = {}) {
  const f = eventsFile();
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split(/\r?\n/).flatMap((l) => {
    if (!l) return [];
    try { const e = JSON.parse(l); return !run || e.run === run ? [e] : []; } catch { return []; }
  });
}

// Tożsamość pliku dziennika (recenzja S3): skrót pierwszej pełnej linii. Rotacja przenosi plik do `.1` (ta sama pierwsza
// linia) i zaczyna nowy (inna), więc przesunięcie z tożsamością wie, który plik czytało. null: plik pusty albo bez linii.
export function eventsFileId(f = eventsFile()) {
  let fd;
  try {
    fd = openSync(f, 'r');
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const end = buf.subarray(0, n).indexOf(0x0a);
    const head = end > 0 ? buf.subarray(0, end) : n === buf.length ? buf : null;
    return head ? createHash('sha1').update(head).digest('hex').slice(0, 16) : null;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

// Pełne linie pliku od bajtu `from` (filtr przebiegu `run`): {events, offset} (offset za ostatnią pełną linią).
function readRange(f, from, run) {
  let size;
  try { size = statSync(f).size; } catch { return { events: [], offset: 0 }; }
  if (size <= from) return { events: [], offset: Math.min(from, size) };
  const buf = Buffer.alloc(size - from);
  const fd = openSync(f, 'r');
  try { readSync(fd, buf, 0, buf.length, from); } finally { closeSync(fd); }
  const end = buf.lastIndexOf(0x0a);
  if (end < 0) return { events: [], offset: from };
  const events = buf.subarray(0, end).toString('utf8').split(/\r?\n/).flatMap((l) => {
    if (!l) return [];
    try { const e = JSON.parse(l); return !run || e.run === run ? [e] : []; } catch { return []; }
  });
  return { events, offset: from + end + 1 };
}

// Odczyt przyrostowy (`dwmt wait`, pętla supervisora): zdarzenia od przesunięcia w bajtach do ostatniej pełnej linii,
// opcjonalnie tylko przebiegu `run`. Z tożsamością `id` (wynik poprzedniego odczytu): po rotacji reszta starego pliku z
// `.1` od przesunięcia, potem nowy plik od początku (recenzja S3: bez tego zdarzenia między odczytem a rotacją ginęły, a
// nowy plik dłuższy niż stare przesunięcie był czytany od środka). Bez `id` (stary zapis): plik krótszy niż przesunięcie
// → od początku. Wynik: {events, offset, id}.
export function readEventsFrom(offset = 0, { run = null, id = null } = {}) {
  const f = eventsFile();
  const cur = eventsFileId(f);
  let before = [];
  let from = offset;
  if (id && cur !== id) {
    if (eventsFileId(`${f}.1`) === id) before = readRange(`${f}.1`, offset, run).events;
    from = 0;
  } else if (!id) {
    let size = 0;
    try { size = statSync(f).size; } catch { /* brak pliku */ }
    if (size < offset) from = 0;
  }
  const r = readRange(f, from, run);
  return { events: [...before, ...r.events], offset: r.offset, id: cur ?? eventsFileId(f) };
}

// Czy dziennik jest włączony (preflight supervisora: R4 i koszty potrzebują zdarzeń).
export const eventsEnabled = () => enabled();
