import './tmp-root.mjs';
// S3 (spec supervisora v1.0 §3–§4): pętla supervisora na sterowniku. Scenariusze pętli na symulowanych plikach statusu,
// liniach dziennika zdarzeń, `drive.lock`/`drive.json` i fałszywych operacjach (sterownik, sesje, powiadomienia): reguły
// R1–R5, limit abonamentu, śmierć sterownika, hold/resume, odpowiedź (sesja zatrzymania), raport/zamknięcie, jedna pętla,
// warstwa wyłączalna (bez zlecenia jak d4-1). E2E: `supervise order` + `run --once` z prawdziwym `init --worktree --sprint`
// i fałszywym `drive.mjs` (DWMT_DRIVE). Bez wywołań modelu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { repo, gitIn, SCRIPT, DWMT_HOME, cli, plan, put } from './helpers.mjs';
import { repo28, start, writePlans, RUN } from './fixtures28.mjs';
import { pr } from './product-helpers.mjs';
import { emit } from '../scripts/events.mjs';
import { tick, areasIntersect, inQuiet, runLoop, needsLoop, realOps, supConfig } from '../scripts/supervise.mjs';
import { readSup, ensureLoop, loopLockFile, SUPERVISE } from '../scripts/lib/supervisor-loop.mjs';

const PLATFORM_LOG = join(mkdtempSync(join(tmpdir(), 'dwmt-plat-')), 'platform.jsonl');
const NO_TR = mkdtempSync(join(tmpdir(), 'dwmt-tr-s3-'));
Object.assign(process.env, { DWMT_HOME, DWMT_PLATFORM_LOG: PLATFORM_LOG, DWMT_SUPERVISE_NOSPAWN: '1', DWMT_TRANSCRIPTS: NO_TR });
const ENV = { ...process.env, DWMT_HOME, DWMT_PLATFORM_LOG: PLATFORM_LOG, DWMT_SUPERVISE_NOSPAWN: '1', DWMT_TRANSCRIPTS: NO_TR };
delete ENV.CLAUDE_CODE_SESSION_ID;
const fwd = (p) => String(p).replace(/\\/g, '/');
const MIN = 60e3;

// Fałszywy `drive.mjs` (DWMT_DRIVE): od razu `done` (drive.json, plik statusu, zdarzenie sprint-end) i log wywołania.
function fakeDrive() {
  const fake = join(mkdtempSync(join(tmpdir(), 'dwmt-fdrv-')), 'drive.mjs');
  writeFileSync(fake, `import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const run = process.argv[2];
const root = join(process.cwd(), '.dwmt', 'runs', run);
const rj = JSON.parse(readFileSync(join(root, 'run.json'), 'utf8'));
const at = new Date().toISOString();
const home = rj.homeTree ?? rj.mainTree;
writeFileSync(join(root, 'drive.json'), JSON.stringify({ pid: process.pid, startedAt: at, stopped: { status: 'done', reason: 'fake', at } }));
mkdirSync(join(home, '.dwmt', 'supervisor', 'status'), { recursive: true });
writeFileSync(join(home, '.dwmt', 'supervisor', 'status', rj.sprint + '.json'), JSON.stringify({ schema: 'dwmt/status@1', sprint: rj.sprint, run, state: 'done', result: 'PASS', cost: 1.5, uat: 'n/a', events: [] }));
appendFileSync(join(process.env.DWMT_HOME, 'events.jsonl'), JSON.stringify({ ts: at, type: 'sprint-end', project: { name: 'x', root: home }, run, costM: 1.5 }) + '\\n');
appendFileSync(join(process.env.DWMT_HOME, 'fake-drive.log'), JSON.stringify({ run, cwd: process.cwd(), detach: process.argv.includes('--detach'), sprint: rj.sprint, mode: rj.mode }) + '\\n');
console.log(JSON.stringify({ ok: true, pid: process.pid }));
`);
  return fake;
}

function sv(d, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, 'supervise', ...args], { cwd: d, encoding: 'utf8', env: ENV });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* tekst */ }
  return { code: r.status, json, out: r.stdout + r.stderr };
}

// Projekt z fałszywymi operacjami pętli: pozycje zlecenia z plików (`--file`), sterownik = rekord `drive.lock`/`drive.json`.
function world({ cfg = {}, files = ['a', 'b'], after = 'none', presence = null, extra = [] } = {}) {
  const main = repo();
  mkdirSync(join(main, '.claude'), { recursive: true });
  writeFileSync(join(main, '.claude', 'dwmt.json'), JSON.stringify({ drive: { enabled: true }, git: { target: 'master' }, ...cfg }));
  gitIn(main)('add', '-A');
  gitIn(main)('commit', '-q', '-m', 'cfg');
  const alive = new Set();
  const calls = [];
  let pid = 700000 + Math.floor(Math.random() * 9000) * 10;
  const w = { main, calls, alive, mergeOk: false };
  w.ops = {
    alive: (p) => alive.has(Number(p)),
    prepare(m, it, mode) {
      calls.push(['prepare', it.id, mode, it.run ?? null]);
      const hook = w.onPrepare?.(m, it);
      if (hook) return hook;
      const root = join(m, '.dwmt', 'runs', `r-${it.id}`);
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'run.json'), JSON.stringify({ run: `r-${it.id}`, sprint: it.id, session_ids: [] }));
      return { ok: true, run: `r-${it.id}`, worktree: fwd(m), root: fwd(root), warnings: w.prepWarnings ?? [], ...(w.prepNotice ? { notice: w.prepNotice } : {}) };
    },
    startDriver(it) {
      const p = ++pid;
      alive.add(p);
      calls.push(['drive', it.id, existsSync(join(it.root, 'drive.hold'))]);
      writeFileSync(join(it.root, 'drive.lock'), JSON.stringify({ pid: p }));
      writeFileSync(join(it.root, 'drive.json'), JSON.stringify({ pid: p, startedAt: it.driveAt }));
      return { ok: true, pid: p };
    },
    launch(m, it) { const id = `sess-${calls.length}`; calls.push(['launch', it.id, id]); return { ok: true, id, attach: `claude attach ${id}` }; },
    stopSession(id) { calls.push(['stop-session', id]); return true; },
    push(m, text) { calls.push(['push', text]); return `push-${calls.length}`; },
    notify(text) { calls.push(['notify', text]); return true; },
    mergeCleared: () => w.mergeOk,
    probe: () => { calls.push(['probe']); return w.probeResult ?? { ok: true }; },
    quiet: () => !!w.quietNow,
  };
  w.tick = (dt = 0) => tick(main, { ops: w.ops, now: Date.now() + dt });
  w.sup = () => readSup(main);
  w.item = (id) => readSup(main).items.find((x) => x.id === id);
  w.root = (id) => join(main, '.dwmt', 'runs', `r-${id}`);
  w.status = (id, obj) => { mkdirSync(join(main, '.dwmt', 'supervisor', 'status'), { recursive: true }); writeFileSync(join(main, '.dwmt', 'supervisor', 'status', `${id}.json`), JSON.stringify({ schema: 'dwmt/status@1', sprint: id, run: `r-${id}`, at: new Date().toISOString(), events: [], ...obj })); };
  w.uat = (id, events) => writeFileSync(join(main, '.dwmt', 'supervisor', 'status', `${id}.uat.json`), JSON.stringify({ sprint: id, events }));
  // Sterownik kończy się zdarzeniem i zapisem zatrzymania (jak `Driver.stop`), blokada zdjęta.
  w.stop = (id, status, extra = {}) => {
    const mem = JSON.parse(readFileSync(join(w.root(id), 'drive.json'), 'utf8'));
    alive.delete(Number(mem.pid));
    rmSync(join(w.root(id), 'drive.lock'), { force: true });
    mem.stopped = { status, reason: extra.reason ?? status, at: new Date(Date.parse(mem.startedAt) + 1000).toISOString(), ...extra };
    writeFileSync(join(w.root(id), 'drive.json'), JSON.stringify(mem));
    emit({ type: 'drive-stop', project: main, run: `r-${id}`, detail: { status, ...extra } });
  };
  // Śmierć procesu sterownika bez zdarzenia końca (blokada zostaje z martwym pid).
  w.die = (id) => { const mem = JSON.parse(readFileSync(join(w.root(id), 'drive.json'), 'utf8')); alive.delete(Number(mem.pid)); };
  w.event = (type, id, extra = {}) => emit({ type, project: main, run: `r-${id}`, ...extra });
  w.has = (kind, id) => calls.filter((c) => c[0] === kind && (id == null || c[1] === id));
  w.log = () => readFileSync(join(main, '.dwmt', 'supervisor', 'log.md'), 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'dwmt-sp-'));
  for (const f of files) writeFileSync(join(dir, `${f}.md`), `Sprint ${f}: do ${f}.\n`);
  const paths = files.map((f) => join(dir, `${f}.md`));
  const o = sv(main, 'order', '--file', ...paths, ...(after === 'none' ? ['--after'] : after ? ['--after', ...after] : []), ...(presence ? ['--presence', presence] : []), ...extra);
  assert.equal(o.json?.ok, true, o.out);
  return w;
}

test('S3 warstwa wyłączalna: bez zlecenia brak pętli, plików i autostartu (jak d4-1); supervisor.enabled false blokuje order', async () => {
  const d = repo();
  assert.match(sv(d, 'status').out, /no order/);
  assert.equal(sv(d, 'status', '--json').json.order, null);
  const t = tick(d);
  assert.deepEqual([t.exit, t.reason], [true, 'no order']);
  const r = await runLoop(d, { once: true });
  assert.equal(r.ok, true);
  assert.equal(ensureLoop(d).running, false);
  assert.ok(!existsSync(join(d, '.dwmt', 'supervisor')), 'żadnych plików supervisora bez zlecenia');
  assert.equal(sv(d, 'hold', 'all').json.error, 'brak zlecenia (supervise order)');
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude', 'dwmt.json'), JSON.stringify({ supervisor: { enabled: false } }));
  writeFileSync(join(d, '..', 'x-off.md'), 'x\n');
  const o = sv(d, 'order', '--file', join(d, '..', 'x-off.md'));
  assert.equal(o.code, 1);
  assert.match(o.json.error, /supervisor\.enabled: false/);
  assert.ok(!existsSync(join(d, '.dwmt', 'supervisor')));
});

test('S3 start: komunikat init o sterowniku domyślnym (K4, D-27) trafia raz do log.md', () => {
  const w = world({ presence: 'away' });
  w.prepNotice = 'Sterownik jest teraz domyślnie włączony: test';
  w.tick();
  assert.equal(w.item('a').state, 'running');
  assert.equal(w.log().split('\n').filter((l) => l.includes('domyślnie włączony')).length, 1);
  assert.match(w.log(), /a \[start\] Sterownik jest teraz domyślnie włączony/);
});

test('S3 start: pozycja bez zależności startuje sterownik; druga czeka (jeden sprint w projekcie przy away); zapis w log.md i zdarzenie supervisor', () => {
  const w = world({ presence: 'away' });
  const t = w.tick();
  assert.deepEqual(w.has('prepare').map((c) => [c[1], c[2]]), [['a', 'single']], '`auto` pod sterownikiem = single');
  assert.equal(w.item('a').state, 'running');
  assert.deepEqual([w.item('b').state, w.item('b').wait.rule], ['queued', 'R2']);
  assert.ok(t.working);
  assert.match(w.log(), /a \[start\]/);
  const evs = readFileSync(join(DWMT_HOME, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'supervisor' && e.run === 'r-a');
  assert.ok(evs.length >= 1);
  assert.ok(existsSync(join(w.main, '.dwmt', 'supervisor', 'input', 'a.md')), 'wejście orkiestratora');
  // `done` → następna pozycja startuje; push i powiadomienie na koniec sprintu.
  w.status('a', { state: 'done', result: 'PASS', cost: 4.2, uat: 'n/a' });
  w.stop('a', 'done');
  w.tick();
  assert.equal(w.item('a').state, 'done');
  assert.equal(w.item('b').state, 'running');
  assert.equal(w.has('push').length, 1);
});

test('S3 R1: otwarte pytanie „może dotyczyć b” wstrzymuje b; przy here pytanie P-1 i powiadomienie; answer start → b startuje (R2: tylko planowanie)', () => {
  const w = world({ presence: 'away' });
  w.tick();
  w.status('a', { state: 'waiting-user', stage: 'planning', questions: ['Q-1 Discount cap'], affects: ['b'], scope: ['src/a/**'] });
  w.stop('a', 'waiting-user', { reason: 'T-1 ask-plan' });
  assert.equal(sv(w.main, 'set', 'presence', 'here').json.ok, true);
  w.tick();
  assert.equal(w.item('a').state, 'waiting-user');
  assert.equal(w.has('launch', 'a').length, 1, 'sesja zatrzymania dla a');
  assert.deepEqual([w.item('b').state, w.item('b').wait.rule], ['queued', 'R1']);
  const s = w.sup();
  assert.equal(s.pending.length, 1);
  assert.equal(s.pending[0].kind, 'R1');
  assert.ok(w.has('notify').some((c) => /P-1/.test(c[1])));
  // Drugi odczyt: bez drugiej sesji zatrzymania i bez drugiego pytania.
  w.tick();
  assert.equal(w.has('launch', 'a').length, 1);
  assert.equal(w.sup().pending.length, 1);
  const a = sv(w.main, 'answer', 'P-1', 'start');
  assert.equal(a.json.ok, true, a.out);
  w.tick();
  assert.equal(w.item('b').state, 'running');
  assert.equal(w.item('b').planOnly, true);
  assert.deepEqual(w.has('drive', 'b')[0], ['drive', 'b', true], 'b z drive.hold: implementacja czeka na zwolnienie');
});

test('S3 R1: pytanie bez „może dotyczyć” (Q-price, affects none) nie wstrzymuje innej pozycji; przy away bez pytania zarządczego', () => {
  const w = world({ presence: 'away' });
  w.tick();
  w.status('a', { state: 'waiting-user', stage: 'planning', questions: ['Q-price Price of the design'], affects: [] });
  w.stop('a', 'waiting-user');
  w.tick();
  assert.equal(w.item('b').state, 'running', 'R2: a czeka w planowaniu → b startuje');
  assert.equal(w.sup().pending.length, 0);
});

test('S3 R2: czekający w implementacji blokuje projekt; w planowaniu → start „tylko planowanie”, zwolnienie przy rozłącznych obszarach', () => {
  const w = world({ presence: 'away' });
  w.tick();
  w.event('task-start', 'a', { task: 1 });
  w.status('a', { state: 'waiting-user', stage: 'implementation', questions: ['red suite'], affects: 'none', scope: ['src/a/**'] });
  w.stop('a', 'waiting-user');
  w.tick();
  assert.deepEqual([w.item('b').state, w.item('b').wait.rule], ['queued', 'R2']);

  const v = world({ presence: 'away' });
  v.tick();
  v.status('a', { state: 'waiting-user', stage: 'planning', questions: ['Q-1'], affects: [], scope: ['src/a/**'] });
  v.stop('a', 'waiting-user');
  v.tick();
  assert.equal(v.item('b').planRule, 'R2');
  // b po planowaniu staje na drive.hold; obszary przecinają się z a → dalej hold.
  v.status('b', { state: 'running', step: 'implement', scope: ['src/a/x/**'] });
  v.stop('b', 'hold');
  v.tick();
  assert.equal(v.item('b').state, 'hold');
  assert.ok(existsSync(join(v.root('b'), 'drive.hold')));
  // Rozłączne obszary → hold zdjęty, sterownik b ponownie.
  v.status('b', { state: 'running', step: 'implement', scope: ['src/b/**'] });
  v.tick();
  assert.equal(v.item('b').state, 'running');
  assert.ok(!existsSync(join(v.root('b'), 'drive.hold')));
  assert.equal(v.has('drive', 'b').length, 2);
  assert.equal(areasIntersect({ scope: ['src/a/**'] }, { scope: ['src/b/**'] }), false);
  assert.equal(areasIntersect({ scope: ['src/**'] }, { scope: ['src/b/c.ts'] }), true);
  assert.equal(areasIntersect({ scope: [] }, { scope: ['x'] }), true, 'brak danych = wątpliwość');
  assert.equal(areasIntersect({ scope: ['a'], shared: ['api/openapi.yaml'] }, { scope: ['b'], shared: ['api/openapi.yaml'] }, ['api/openapi.yaml']), true);
});

test('S3 R3: przy here zależny sprint zaczyna planowanie, gdy poprzedni jest w finish; `planned` → wznowienie po scaleniu; przy away czeka', () => {
  const w = world({ after: null });
  w.tick();
  assert.deepEqual(w.item('b').after, ['a']);
  assert.equal(w.item('b').wait.rule, 'after');
  w.status('a', { state: 'running', step: 'finish' });
  w.tick();
  assert.deepEqual([w.item('b').state, w.item('b').planRule], ['running', 'R3']);
  w.status('b', { state: 'planned', waitingFor: ['a'], scope: ['src/b/**'] });
  w.stop('b', 'planned', { waitingFor: ['a'] });
  w.tick();
  assert.equal(w.item('b').state, 'planned');
  assert.equal(w.has('drive', 'b').length, 1, 'bez wznowienia przed scaleniem a');
  w.status('a', { state: 'done', result: 'PASS', cost: 3, uat: 'n/a' });
  w.stop('a', 'done');
  w.tick();
  assert.equal(w.item('a').state, 'done');
  assert.equal(w.item('b').state, 'running');
  assert.deepEqual(w.has('drive', 'b')[1], ['drive', 'b', false], 'wyjście z planned bez drive.hold');

  const v = world({ after: null, presence: 'away' });
  v.tick();
  v.status('a', { state: 'running', step: 'finish' });
  v.tick();
  assert.deepEqual([v.item('b').state, v.item('b').wait.rule], ['queued', 'after']);
});

test('S3 R4: limit nocy z task-start (drive.hold, nowe pozycje czekają); here zeruje licznik i zdejmuje hold; budżet → pytanie i continue', () => {
  const w = world({ presence: 'away' });
  assert.equal(sv(w.main, 'set', 'night-limit', '1').json.ok, true);
  w.tick();
  w.event('task-start', 'a', { task: 1 });
  w.tick();
  assert.equal(w.sup().night.count, 1);
  assert.ok(existsSync(join(w.root('a'), 'drive.hold')), 'limit nocy: drive.hold przy działającym sterowniku');
  w.stop('a', 'hold');
  w.tick();
  assert.equal(w.item('a').state, 'hold');
  w.status('x', {});
  assert.equal(sv(w.main, 'set', 'presence', 'here').json.ok, true);
  w.tick();
  assert.equal(w.sup().night.count, 0);
  assert.equal(w.item('a').state, 'running');
  assert.ok(!existsSync(join(w.root('a'), 'drive.hold')));

  // Typowy koszt bez danych z configu (5 mln): start a mieści się w budżecie; po a (6 mln) typowy = mediana = 6.
  const b = world({ files: ['a', 'b', 'c'], presence: 'away', extra: ['--budget', '10'], cfg: { supervisor: { typicalCostM: 5 } } });
  b.tick();
  assert.equal(b.item('a').state, 'running');
  b.event('sprint-end', 'a', { costM: 6 });
  b.status('a', { state: 'done', result: 'PASS', cost: 6, uat: 'n/a' });
  b.stop('a', 'done');
  assert.equal(sv(b.main, 'set', 'presence', 'here').json.ok, true);
  b.tick();
  assert.equal(b.item('a').costM, 6);
  assert.deepEqual([b.item('b').state, b.item('b').wait.rule], ['queued', 'R4'], 'wydane 6 + typowy 6 > 10');
  const p = b.sup().pending.find((x) => x.kind === 'budget');
  assert.ok(p);
  assert.equal(sv(b.main, 'answer', p.id, 'continue').json.ok, true);
  b.tick();
  assert.equal(b.item('b').state, 'running');
});

test('S3 R5: zależny od bramki UAT czeka na wynik; defekt major → sprint poprawek przed resztą; zmiana wymagań → pytanie; startuj mimo to', () => {
  const w = world({ after: null, extra: ['--uat-gate'] });
  const sup = w.sup();
  sup.items[0].uatGate = true;
  writeFileSync(join(w.main, '.dwmt', 'supervisor', 'supervisor.json'), JSON.stringify(sup));
  w.tick();
  w.status('a', { state: 'done', result: 'PASS', cost: 2, uat: 'n/a' });
  w.stop('a', 'done');
  w.tick();
  assert.deepEqual([w.item('b').state, w.item('b').wait.rule], ['queued', 'R5']);
  assert.match(w.item('b').wait.text, /UAT a/);
  assert.ok(sv(w.main, 'status').out.includes('UAT pending'));
  w.uat('a', [{ seq: 1, type: 'uat', result: 'defects', counts: { major: 1 }, requirementChanges: 0, fixSprint: { defects: ['U-1'] } }]);
  w.tick();
  const ids = w.sup().items.map((x) => x.id);
  assert.deepEqual(ids, ['a', 'a-fix', 'b'], 'sprint poprawek przed kolejnymi pozycjami');
  assert.equal(w.item('a-fix').state, 'running');
  assert.match(readFileSync(join(w.main, '.dwmt', 'supervisor', 'input', 'a-fix.md'), 'utf8'), /source: "a"/);
  assert.equal(w.item('b').wait.rule, 'R5');
  w.status('a-fix', { state: 'done', result: 'PASS', cost: 1, uat: 'n/a' });
  w.stop('a-fix', 'done');
  w.tick();
  assert.equal(w.item('b').state, 'running');
  w.tick();
  assert.equal(w.sup().items.filter((x) => x.src === 'fix').length, 1, 'zdarzenie UAT obsłużone raz (seq)');

  const v = world({ after: null });
  const s2 = v.sup();
  s2.items[0].uatGate = true;
  writeFileSync(join(v.main, '.dwmt', 'supervisor', 'supervisor.json'), JSON.stringify(s2));
  v.tick();
  v.status('a', { state: 'done', result: 'PASS', cost: 2, uat: 'pending' });
  v.stop('a', 'done');
  v.tick();
  v.uat('a', [{ seq: 1, type: 'uat', result: 'positive', counts: {}, requirementChanges: 2, fixSprint: null }]);
  v.tick();
  const p = v.sup().pending.find((x) => x.kind === 'R5');
  assert.ok(p, JSON.stringify(v.sup().pending));
  assert.equal(v.item('b').state, 'queued');
  assert.equal(sv(v.main, 'answer', p.id, 'start').json.ok, true);
  v.tick();
  assert.equal(v.item('b').state, 'running');
});

test('S3 limit abonamentu: stop z resetsAt → status limit, wznowienie po odnowieniu z marginesem; bez resetsAt 60 min i jedna próba', () => {
  const w = world({ files: ['a'] });
  w.tick();
  const resetsAt = new Date(Date.now() + 30 * MIN).toISOString();
  w.stop('a', 'stopped', { cause: 'limit', resetsAt });
  w.tick();
  assert.equal(w.item('a').state, 'limit');
  assert.equal(JSON.parse(readFileSync(join(w.main, '.dwmt', 'supervisor', 'status', 'a.json'), 'utf8')).state, 'limit');
  w.tick(31 * MIN);
  assert.equal(w.has('drive', 'a').length, 1, 'przed końcem marginesu bez wznowienia');
  w.tick(33 * MIN);
  assert.equal(w.has('drive', 'a').length, 2);
  assert.equal(w.item('a').state, 'running');

  const v = world({ files: ['a'] });
  v.tick();
  v.stop('a', 'stopped', { cause: 'limit' });
  v.tick();
  assert.equal(v.item('a').state, 'limit');
  v.tick(61 * MIN);
  assert.equal(v.has('drive', 'a').length, 2);
  v.stop('a', 'stopped', { cause: 'limit' });
  v.tick(62 * MIN);
  assert.equal(v.item('a').state, 'stopped');
  assert.match(v.item('a').reason, /limit/);
});

test('S3 śmierć dziecka (stopped z powodem) → pozycja zatrzymana ze zdarzeniem, bez ponawiania (decyzja A); zależne czekają', () => {
  const w = world({ after: null, presence: 'away' });
  w.tick();
  w.stop('a', 'stopped', { cause: 'child-dead', reason: 'T-1 verify: komenda zakończyła się bez wyniku' });
  w.tick();
  w.tick();
  assert.equal(w.item('a').state, 'stopped');
  assert.equal(w.has('drive', 'a').length, 1, 'bez ponowienia');
  assert.equal(w.item('b').state, 'queued');
  assert.ok(w.has('notify').some((c) => /a: zatrzymany/.test(c[1])));
  const evs = readFileSync(join(DWMT_HOME, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(evs.some((e) => e.type === 'supervisor' && e.run === 'r-a' && e.detail.rule === 'stop' && e.detail.cause === 'child-dead'));
  // resume <id> to decyzja użytkownika: jedno ponowne uruchomienie.
  assert.equal(sv(w.main, 'resume', 'a').json.ok, true);
  w.tick();
  assert.equal(w.has('drive', 'a').length, 2);
});

test('S3 śmierć sterownika bez drive-stop: przestój po stallGraceMin → zdarzenie stall i jedno wznowienie; drugi raz → stop, przy away push', () => {
  const w = world({ files: ['a'], presence: 'away' });
  w.tick();
  w.die('a');
  w.tick(1 * MIN);
  assert.equal(w.has('drive', 'a').length, 1, 'w oknie łaski bez decyzji');
  w.tick(10 * MIN);
  assert.equal(w.has('drive', 'a').length, 2, 'jedno wznowienie');
  assert.equal(w.item('a').stallRestarts, 1);
  w.die('a');
  w.tick(20 * MIN);
  assert.equal(w.item('a').state, 'stopped');
  assert.equal(w.has('drive', 'a').length, 2);
  // Recenzja S3 (7): push już przy pierwszej śmierci sterownika przy away (z informacją o wznowieniu), drugi przy zatrzymaniu.
  assert.deepEqual(w.has('push').map((c) => /wznowienie 1\/1/.test(c[1])), [true, false], 'push przy każdej śmierci sterownika w nocy');
  const stalls = readFileSync(join(DWMT_HOME, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'stall' && e.run === 'r-a');
  assert.equal(stalls.length, 2);
  assert.equal(stalls[0].detail.kind, 'driver-dead');
});

test('S3 hold/resume: hold <id> zakłada drive.hold, sterownik staje na hold i czeka; resume → wznowienie; hold all → koniec pętli bez pracy', () => {
  const w = world({ files: ['a'] });
  w.tick();
  assert.equal(sv(w.main, 'hold', 'a').json.ok, true);
  assert.ok(existsSync(join(w.root('a'), 'drive.hold')));
  w.stop('a', 'hold');
  w.tick();
  w.tick();
  assert.equal(w.item('a').state, 'hold');
  assert.equal(w.has('drive', 'a').length, 1);
  assert.equal(sv(w.main, 'resume', 'a').json.ok, true);
  w.tick();
  assert.equal(w.item('a').state, 'running');
  assert.equal(w.has('drive', 'a').length, 2);
  assert.equal(sv(w.main, 'hold', 'all').json.ok, true);
  w.stop('a', 'hold');
  const t = w.tick();
  assert.deepEqual([t.exit, t.reason], [true, 'order held']);
  assert.match(sv(w.main, 'status').out, /order held/);
});

test('S3 odpowiedź: waiting-user → jedna sesja zatrzymania `/dwmt:execute` (attach w statusie); po odpowiedzi sesja uruchamia sterownik → pętla zamyka sesję', () => {
  const w = world({ files: ['a'] });
  w.tick();
  w.status('a', { state: 'waiting-user', stage: 'planning', questions: ['Q-1 Discount cap'], affects: [] });
  w.stop('a', 'waiting-user', { reason: 'T-1 ask-plan: decyzja użytkownika' });
  w.tick();
  const [launch] = w.has('launch', 'a');
  assert.ok(launch);
  const st = sv(w.main, 'status', '--json').json;
  assert.equal(st.items[0].attach, `claude attach ${launch[2]}`);
  assert.deepEqual(st.items[0].questions, ['Q-1 Discount cap']);
  assert.ok(w.has('notify').some((c) => c[1].includes(`claude attach ${launch[2]}`)));
  w.tick();
  assert.equal(w.has('launch', 'a').length, 1);
  // Sesja zatrzymania: odpowiedź do architekta przez --resume robi sterownik; tu sesja tylko uruchamia go ponownie.
  w.ops.startDriver(w.item('a'));
  w.tick();
  assert.equal(w.item('a').state, 'running');
  assert.deepEqual(w.has('stop-session').map((c) => c[1]), [launch[2]], 'sesja zatrzymania zamknięta (claude stop)');
});

test('S3 report i close: raport z sprintami i decyzjami (≤ 30 linii); close → bez nowych pozycji, koniec pętli po ostatnim sterowniku, autostart wyrejestrowany', () => {
  const w = world({ presence: 'away' });
  w.tick();
  const r = sv(w.main, 'report');
  assert.equal(r.code, 0);
  assert.match(r.out, /# Order report/);
  assert.match(r.out, /file: .*report\.md/);
  assert.ok(r.out.trim().split('\n').length <= 31);
  assert.equal(sv(w.main, 'close').json.ok, true);
  let t = w.tick();
  assert.equal(t.exit, false, 'a jeszcze pracuje');
  assert.equal(w.item('b').state, 'queued');
  w.status('a', { state: 'done', result: 'PASS', cost: 1, uat: 'n/a' });
  w.stop('a', 'done');
  t = w.tick();
  // Recenzja S3 (6): sesja push końca sprintu żyje do 3 min: pętla czeka, potem ją zamyka i kończy się.
  assert.deepEqual([t.exit, t.reason], [false, 'notifications pending (order closed)']);
  t = w.tick(4 * MIN);
  assert.deepEqual([t.exit, t.reason, t.unregister], [true, 'order closed', true]);
  assert.equal(w.has('stop-session').length, 1, 'sesja push zamknięta przed końcem pętli');
  assert.equal(w.has('prepare', 'b').length, 0);
  const plat = readFileSync(PLATFORM_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.fn === 'autostart' && fwd(x.root) === fwd(w.main));
  assert.deepEqual(plat.map((x) => x.on), [false], 'autostart domyślnie wyłączony (do S4); close zawsze próbuje wyrejestrować');
});

test('S3 merge-wait: zatrzymanie finish z merge-wait → bez sesji zatrzymania; po ustąpieniu przyczyny sterownik ponownie (finish)', () => {
  const w = world({ files: ['a'] });
  w.tick();
  w.status('a', { state: 'merge-wait', reason: 'uat' });
  w.stop('a', 'waiting-user', { reason: 'finish merge-wait' });
  w.tick();
  assert.equal(w.item('a').state, 'merge-wait');
  assert.equal(w.has('launch').length, 0);
  w.mergeOk = true;
  w.tick();
  assert.equal(w.has('drive', 'a').length, 2);
});

test('S3 dwa sprinty: `size` → drugi sprint zaraz za pierwszym (first: plan), `decision` → tylko log (wejście PO)', () => {
  const w = world({ files: ['a', 'z'] });
  w.tick();
  w.status('a', { state: 'running', step: 'implement', events: [{ seq: 1, type: 'two-sprints', text: 'size: export part', plan: '/x/plan.md' }, { seq: 2, type: 'two-sprints', text: 'decision: pricing model' }] });
  w.tick();
  assert.deepEqual(w.sup().items.map((x) => x.id), ['a', 'a-2', 'z']);
  assert.deepEqual(w.item('a-2').after, ['a']);
  assert.match(readFileSync(join(w.main, '.dwmt', 'supervisor', 'input', 'a-2.md'), 'utf8'), /first: "\/x\/plan\.md"/);
  assert.match(w.log(), /decision/);
  w.tick();
  assert.equal(w.sup().items.length, 3, 'zdarzenia raz (seq)');
});

test('S3 jedna pętla: druga `supervise run` przy żywej blokadzie loop.lock nie rusza; ensureLoop widzi żywą pętlę; godziny ciszy', async () => {
  const w = world({ files: ['a'] });
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
  try {
    mkdirSync(join(w.main, '.dwmt', 'supervisor'), { recursive: true });
    writeFileSync(loopLockFile(w.main), JSON.stringify({ pid: child.pid }));
    const r = sv(w.main, 'run', '--once');
    assert.equal(r.json.running, true, r.out);
    assert.equal(r.json.pid, child.pid);
    assert.deepEqual(ensureLoop(w.main), { running: true, pid: child.pid });
    assert.equal(w.has('prepare').length, 0);
  } finally { child.kill(); }
  // Martwy właściciel: blokada przejęta, jeden odczyt.
  await new Promise((r) => { setTimeout(r, 300); });
  const r2 = await runLoop(w.main, { once: true, ops: w.ops });
  assert.equal(r2.ok, true);
  assert.ok(!r2.running);
  assert.equal(w.item('a').state, 'running');
  assert.ok(!existsSync(loopLockFile(w.main)), 'blokada zdjęta po końcu');
  assert.equal(inQuiet('22:00-07:00', new Date(2026, 0, 1, 23, 0).getTime()), true);
  assert.equal(inQuiet('22:00-07:00', new Date(2026, 0, 1, 12, 0).getTime()), false);
  assert.equal(inQuiet(null), false);
});

test('S3 E2E: order --file + run --once: prawdziwy init --worktree --sprint (główne drzewo bez zmian) i sterownik przez DWMT_DRIVE; koniec zakresu', () => {
  const { d } = repo28({ drive: { enabled: true } });
  const fake = fakeDrive();
  writeFileSync(join(d, '..', 'feat-x.md'), 'Discount on the invoice.\n');
  const env = { ...ENV, DWMT_DRIVE: fake };
  const run = (...a) => { const r = spawnSync(process.execPath, [SCRIPT, 'supervise', ...a], { cwd: d, encoding: 'utf8', env }); try { return JSON.parse(r.stdout); } catch { return { out: r.stdout + r.stderr }; } };
  const o = run('order', '--file', join(d, '..', 'feat-x.md'), '--presence', 'away');
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.deepEqual(o.added, ['feat-x']);
  const r1 = run('run', '--once');
  assert.equal(r1.ok, true, JSON.stringify(r1));
  const log = readFileSync(join(DWMT_HOME, 'fake-drive.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.sprint === 'feat-x').at(-1);
  assert.ok(log, 'sterownik uruchomiony');
  assert.equal(log.detach, true);
  assert.equal(log.mode, 'single');
  assert.match(fwd(log.cwd), /\.claude\/worktrees\//, 'sterownik w worktree sprintu');
  assert.equal(gitIn(d)('branch', '--show-current'), 'master', 'główne drzewo bez zmian');
  const r2 = run('run', '--once');
  assert.equal(r2.reason, 'scope done', JSON.stringify(r2));
  const st = run('status', '--json');
  assert.equal(st.order, 'finished');
  assert.deepEqual([st.items[0].state, st.items[0].costM], ['done', 1.5]);
});

test('S3 E2E --spec: tylko sprint ready/ordered; wejście z product sprint (spec, tryb intermediate, est start → --estimate); brief: supervisor on z linią zlecenia', () => {
  const { d } = repo28({ drive: { enabled: true }, product: {} });
  const g = gitIn(d);
  assert.equal(pr(d, 'init', '--goal', 'Pilot').code, 0);
  assert.equal(pr(d, 'item', 'add', '--type', 'bug', '--title', 'Date picker shows UTC', '--sev', 'major', '--anchors', 'src/date.ts').code, 0);
  const b = pr(d, 'spec', 'bugfix', 'B-1', '--mode', 'intermediate');
  assert.equal(b.code, 0, b.out);
  assert.equal(pr(d, 'spec', 'set', b.json.id, 'est', 'start:[2,4]').code, 0);
  assert.equal(pr(d, 'roadmap', 'add', 'topic-x', '--goal', 'Later topic').code, 0);
  g('add', '-A'); g('commit', '-q', '-m', 'product');
  const env = { ...ENV, DWMT_DRIVE: fakeDrive() };
  const run = (...a) => { const r = spawnSync(process.execPath, [SCRIPT, 'supervise', ...a], { cwd: d, encoding: 'utf8', env }); try { return JSON.parse(r.stdout); } catch { return { out: r.stdout + r.stderr }; } };
  const bad = run('order', '--spec', 'docs/product/sprints/topic-x.md');
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /topic-x/);
  assert.ok(!existsSync(join(d, '.dwmt', 'supervisor', 'supervisor.json')), 'odmowa bez zlecenia');
  const o = run('order', '--spec', `docs/product/sprints/${b.json.id}.md`, '--presence', 'away');
  assert.equal(o.ok, true, JSON.stringify(o));
  const input = readFileSync(join(d, '.dwmt', 'supervisor', 'input', `${b.json.id}.md`), 'utf8');
  assert.match(input, new RegExp(`spec: "${b.json.id}"`));
  assert.match(input, /Date picker shows UTC/, 'treść z product sprint');
  const brief = pr(d, 'brief').out;
  assert.match(brief, /supervisor: on · order: queued /, brief);
  assert.equal(run('run', '--once').ok, true);
  // kf2 (D-11): the order already stores the roadmap's list, so the first tick logs no dependency change.
  assert.doesNotMatch(readFileSync(join(d, '.dwmt', 'supervisor', 'log.md'), 'utf8'), /\[roadmap\] zależności/);
  const sup = JSON.parse(readFileSync(join(d, '.dwmt', 'supervisor', 'supervisor.json'), 'utf8'));
  const it = sup.items[0];
  assert.deepEqual([it.mode, it.estimate], ['intermediate', [2, 4]]);
  const rj = JSON.parse(readFileSync(join(it.root, 'run.json'), 'utf8'));
  assert.deepEqual([rj.spec, rj.sprint, rj.mode, rj.modeLabel, rj.estimate?.tokensM], [b.json.id, b.json.id, 'single', 'intermediate', [2, 4]]);
});

test('S3 sterownik pod --sprint: krok planned kończy się statusem planned (kod 4), bez pytania użytkownika (R3)', () => {
  const { d } = repo28({ drive: { enabled: true } });
  const runId = start(d, 'pl');
  writePlans(d, runId);
  const f = join(d, '.dwmt', 'runs', runId, 'run.json');
  const rj = JSON.parse(readFileSync(f, 'utf8'));
  Object.assign(rj, { sprint: 'pl', after: ['dep'], order: ['dep', 'pl'] });
  writeFileSync(f, JSON.stringify(rj, null, 2));
  mkdirSync(join(d, '.dwmt', 'supervisor', 'status'), { recursive: true });
  writeFileSync(join(d, '.dwmt', 'supervisor', 'status', 'dep.json'), JSON.stringify({ sprint: 'dep', state: 'running' }));
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/drive.mjs', import.meta.url)), runId], { cwd: d, encoding: 'utf8', env: { ...ENV, DWMT_CLAUDE: 'brak-agenta', DWMT_DRIVE_QUIET: '1' } });
  assert.equal(r.status, 4, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
  assert.deepEqual([out.status, out.waitingFor], ['planned', ['dep']]);
  assert.equal(JSON.parse(readFileSync(join(d, '.dwmt', 'supervisor', 'status', 'pl.json'), 'utf8')).state, 'planned');
  assert.equal(RUN(d, runId).sprint, 'pl');
});

test('S3 pętla w tle: ensureLoop uruchamia odłączony proces `supervise run` (jeden), który prowadzi zlecenie do końca zakresu i zdejmuje blokadę', async () => {
  const { d } = repo28({ drive: { enabled: true }, supervisor: { intervalSec: 0.2, keepAwake: false } });
  writeFileSync(join(d, '..', 'bg-x.md'), 'Background sprint.\n');
  const env = { ...ENV, DWMT_DRIVE: fakeDrive() };
  delete env.DWMT_SUPERVISE_NOSPAWN;
  const o = spawnSync(process.execPath, [SCRIPT, 'supervise', 'order', '--file', join(d, '..', 'bg-x.md')], { cwd: d, encoding: 'utf8', env: ENV });
  assert.equal(JSON.parse(o.stdout).ok, true, o.stdout);
  const first = ensureLoop(d, { env });
  assert.equal(first.started, true, JSON.stringify(first));
  const second = ensureLoop(d, { env });
  assert.equal(second.running, true);
  for (let i = 0; i < 150 && readSup(d)?.finished !== true; i++) await new Promise((r) => { setTimeout(r, 200); });
  assert.equal(readSup(d).finished, true, readFileSync(join(d, '.dwmt', 'supervisor', 'loop.out'), 'utf8'));
  for (let i = 0; i < 50 && existsSync(loopLockFile(d)); i++) await new Promise((r) => { setTimeout(r, 100); });
  assert.ok(!existsSync(loopLockFile(d)), 'pętla skończyła się i zdjęła blokadę');
  assert.equal(readSup(d).items[0].state, 'done');
});

test('S3 ścieżka sesji (drive.enabled false): start sesją orkiestratora, handoff → jedna nowa sesja, limit → nowa sesja po odnowieniu, bez powtórek przy starym statusie', () => {
  const w = world({ files: ['a'], cfg: { drive: { enabled: false } } });
  w.tick();
  assert.deepEqual(w.has('prepare').map((c) => c[2]), ['auto'], 'bez sterownika tryb wybiera model');
  assert.equal(w.item('a').path, 'session');
  assert.equal(w.has('launch', 'a').length, 1);
  w.status('a', { state: 'handoff', task: 1, at: new Date(Date.now() + 1000).toISOString() });
  w.tick(2000);
  assert.equal(w.has('launch', 'a').length, 2, 'nowa sesja po zadaniu');
  w.tick(3000);
  assert.equal(w.has('launch', 'a').length, 2, 'stary status handoff nie uruchamia drugiej');
  const resetsAt = new Date(Date.now() + 20 * MIN).toISOString();
  w.status('a', { state: 'running', step: 'implement', limit: { resetsAt }, at: new Date(Date.now() + 4000).toISOString() });
  w.tick(5000);
  assert.equal(w.item('a').state, 'limit');
  w.tick(10 * MIN);
  assert.equal(w.has('launch', 'a').length, 2);
  w.tick(23 * MIN);
  assert.equal(w.has('launch', 'a').length, 3, 'po odnowieniu limitu');
  w.tick(24 * MIN);
  assert.equal(w.has('launch', 'a').length, 3, 'stary status z limitem nie wraca');
});

// ---------- recenzja S3: poprawki po niezależnej recenzji (kolejność jak w prawdziwym przebiegu) ----------

test('recenzja S3 (1): trzy pozycje przy here: zwolniony start „tylko planowanie” nie wraca do drive.hold; następny czeka na niego, nie odwrotnie', () => {
  const w = world({ files: ['a', 'b', 'c'], presence: 'here' });
  w.tick();
  assert.deepEqual(['a', 'b', 'c'].map((x) => w.item(x).state), ['running', 'running', 'queued']);
  assert.equal(w.item('b').planRule, 'R3');
  assert.equal(w.item('c').wait.rule, 'machine', 'maxActiveSprints 2: a i b');
  // b kończy planowanie i staje na drive.hold (a implementuje).
  w.status('b', { state: 'running', step: 'implement', scope: ['src/b/**'] });
  w.stop('b', 'hold');
  w.tick();
  assert.equal(w.item('b').state, 'hold');
  // a scalony → b zwolniony (sterownik bez drive.hold), c rusza „tylko planowanie” za b.
  w.status('a', { state: 'done', result: 'PASS', cost: 3, uat: 'n/a' });
  w.stop('a', 'done');
  w.tick();
  assert.deepEqual([w.item('b').state, w.item('b').planOnly], ['running', false]);
  assert.deepEqual(w.has('drive', 'b').at(-1), ['drive', 'b', false]);
  assert.deepEqual([w.item('c').state, w.item('c').planOnly], ['running', true]);
  assert.match(w.log(), /b \[R3\] start „tylko planowanie” zwolniony/);
  // b zaczyna zadanie (task-start ze `state`): ruszenie c nie zakłada mu drive.hold z powrotem.
  w.event('task-start', 'b', { task: 1 });
  w.status('b', { state: 'running', step: 'implement', task: 1, scope: ['src/b/**'] });
  w.tick();
  assert.ok(!existsSync(join(w.root('b'), 'drive.hold')), 'zwolniony sprint w implementacji bez drive.hold');
  // c po planowaniu czeka na b; b nie czeka na c.
  w.status('c', { state: 'running', step: 'implement', scope: ['src/c/**'] });
  w.stop('c', 'hold');
  w.tick();
  w.tick();
  assert.deepEqual([w.item('b').state, w.item('c').state], ['running', 'hold']);
  w.status('b', { state: 'done', result: 'PASS', cost: 2, uat: 'n/a' });
  w.stop('b', 'done');
  w.tick();
  assert.deepEqual([w.item('c').state, w.item('c').planOnly], ['running', false]);
  assert.deepEqual(w.has('drive', 'c').at(-1), ['drive', 'c', false]);
});

test('recenzja S3 (3): czekanie na odnowienie limitu trzyma maszynę w czuwaniu (wznowienie o resetsAt)', () => {
  const w = world({ files: ['a'] });
  w.tick();
  w.stop('a', 'stopped', { cause: 'limit', resetsAt: new Date(Date.now() + 30 * MIN).toISOString() });
  const t = w.tick();
  assert.deepEqual([w.item('a').state, t.working], ['limit', true]);
});

// Proces pętli, który ginie w środku efektu (jak zabity albo wyłączony komputer): fałszywe operacje w osobnym procesie.
async function crashChild([supUrl, main, where, log]) {
  const { appendFileSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tick } = await import(supUrl);
  const note = (x) => appendFileSync(log, `${JSON.stringify(x)}\n`);
  const ops = {
    alive: () => false,
    prepare(m, it, mode, reserve) {
      note(['prepare', it.id, it.run ?? null]);
      if (typeof reserve === 'function') reserve(`r-${it.id}`);
      if (where === 'prepare') process.exit(9);
      const root = join(m, '.dwmt', 'runs', `r-${it.id}`);
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'run.json'), JSON.stringify({ run: `r-${it.id}`, sprint: it.id, session_ids: [] }));
      return { ok: true, run: `r-${it.id}`, worktree: m.replace(/\\/g, '/'), root: root.replace(/\\/g, '/') };
    },
    startDriver() { note(['drive']); process.exit(9); },
    launch: () => ({ ok: false }),
    stopSession: () => true,
    push: () => null,
    notify: () => true,
    mergeCleared: () => false,
    quiet: () => false,
  };
  tick(main, { ops });
}

test('recenzja S3 (4): pętla ginie w środku ticku → następny tick kończy start tej samej pozycji na tym samym przebiegu, bez drugiego przygotowania', () => {
  for (const where of ['driver', 'prepare']) {
    const w = world({ files: ['a'] });
    const log = join(mkdtempSync(join(tmpdir(), 'dwmt-crash-')), 'calls.jsonl');
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `(${crashChild})(${JSON.stringify([pathToFileURL(SUPERVISE).href, w.main, where, log])})`], { env: ENV, encoding: 'utf8' });
    assert.equal(r.status, 9, `${where}: ${r.stderr}`);
    assert.deepEqual([w.item('a').state, w.item('a').run, w.item('a').act?.kind], ['starting', 'r-a', where], `${where}: zamiar i przebieg zapisane przed efektem`);
    w.tick();
    if (where === 'driver') assert.equal(w.has('prepare').length, 0, 'bez drugiego przygotowania (drugi worktree)');
    else assert.deepEqual(w.has('prepare').map((c) => c[3]), ['r-a'], 'powtórzone przygotowanie na zarezerwowanym przebiegu');
    assert.equal(w.has('drive', 'a').length, 1);
    assert.equal(w.item('a').state, 'running');
    assert.equal(w.item('a').act, undefined);
    assert.match(w.log(), new RegExp(`a \\[act\\] efekt ${where === 'driver' ? 'driver' : 'prepare'} z .* powtórzenie`));
  }
});

test('recenzja S3 (4): błąd ticku nie zabija pętli: wpis [error] w log.md, następny odczyt działa', async () => {
  const w = world({ files: ['a'] });
  let n = 0;
  const ops = { ...w.ops, quiet: () => { if (!n++) throw new Error('boom'); return false; } };
  const r = await runLoop(w.main, { ops, maxTicks: 2, interval: 0 });
  assert.equal(r.ok, true);
  assert.match(w.log(), /\[error\] odczyt pętli nieudany \(1\/10\): boom/);
  assert.equal(w.item('a').state, 'running');
});

test('recenzja S3 (5): autostart (supervisor.autostart: true): zadanie bez okna, na baterii, bez limitu czasu; stały plik startowy znajduje wtyczkę; close wyrejestrowuje i sprząta', () => {
  const w = world({ files: ['a'], cfg: { supervisor: { autostart: true } } });
  const plat = () => readFileSync(PLATFORM_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.fn === 'autostart' && fwd(x.root) === fwd(w.main));
  const on = plat()[0];
  assert.equal(on?.on, true);
  assert.ok(existsSync(on.shim), 'plik startowy w ~/.dwmt/supervisors');
  assert.ok(fwd(on.shim).startsWith(fwd(join(DWMT_HOME, 'supervisors'))));
  if (process.platform === 'win32') {
    assert.match(on.ps, /New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
    assert.match(on.ps, /wscript\.exe/);
    assert.match(on.ps, /-Settings \$s/);
    const vbs = on.shim.replace(/\.mjs$/, '.vbs');
    assert.match(readFileSync(vbs, 'utf16le'), /, 0, False/, 'okno ukryte');
  }
  // Plik startowy z katalogu projektu: znajduje supervise.mjs wtyczki i działa jak komenda.
  const r = spawnSync(process.execPath, [on.shim, 'status', '--json'], { cwd: w.main, env: ENV, encoding: 'utf8' });
  assert.equal(JSON.parse(r.stdout.trim().split(/\r?\n/).pop()).items[0].id, 'a', r.stdout + r.stderr);
  assert.equal(sv(w.main, 'close').json.ok, true);
  assert.equal(plat().at(-1).on, false);
  assert.ok(!existsSync(on.shim), 'pliki startowe usunięte przy close');
});

test('recenzja S3 (6): koniec zakresu w godzinach ciszy: pętla czeka na koniec ciszy, doręcza kolejkę i push, zamyka sesję push, potem się kończy', () => {
  const w = world({ files: ['a'] });
  w.tick();
  w.quietNow = true;
  w.status('a', { state: 'done', result: 'PASS', cost: 2, uat: 'n/a' });
  w.stop('a', 'done');
  let t = w.tick();
  assert.equal(w.item('a').state, 'done');
  assert.deepEqual([t.exit, w.has('notify').length, w.sup().notifyQueue.length], [false, 0, 2]);
  assert.equal(needsLoop(w.sup()), true, 'brief albo uat wznowi pętlę dla kolejki');
  w.quietNow = false;
  t = w.tick(MIN);
  assert.deepEqual([t.exit, w.has('notify').length, w.has('push').length], [false, 2, 1], 'sesja push jeszcze żyje');
  t = w.tick(5 * MIN);
  assert.deepEqual([t.exit, t.reason], [true, 'scope done']);
  assert.equal(w.has('stop-session').length, 1);
});

test('recenzja S3 (7): przy away pozycja zatrzymana z powodem (potrzebny użytkownik) daje push', () => {
  const w = world({ files: ['a'], presence: 'away' });
  w.tick();
  w.stop('a', 'stopped', { cause: 'no-output', reason: 'T-1 implement: agent bez pliku wyniku' });
  w.tick();
  assert.equal(w.item('a').state, 'stopped');
  assert.equal(w.has('push').length, 1);
  assert.match(w.has('push')[0][1], /a: zatrzymany/);
});

test('recenzja S3 (8): zależność spoza zlecenia: nieznana albo niescalona → odmowa bez zlecenia; scalona (status done) → przyjęta', () => {
  const main = repo();
  const f = join(mkdtempSync(join(tmpdir(), 'dwmt-dep-')), 'b.md');
  writeFileSync(f, 'Sprint b.\n');
  let o = sv(main, 'order', '--file', f, '--after', 'x');
  assert.equal(o.json.ok, false, o.out);
  assert.match(o.json.errors[0], /b: zależność x spoza zlecenia nieznana/);
  assert.ok(!existsSync(join(main, '.dwmt', 'supervisor', 'supervisor.json')), 'odmowa bez zlecenia');
  const st = (state) => { mkdirSync(join(main, '.dwmt', 'supervisor', 'status'), { recursive: true }); writeFileSync(join(main, '.dwmt', 'supervisor', 'status', 'x.json'), JSON.stringify({ sprint: 'x', state })); };
  st('running');
  o = sv(main, 'order', '--file', f, '--after', 'x');
  assert.match(o.json.errors?.[0] ?? '', /ma stan running, nie done/, o.out);
  st('done');
  o = sv(main, 'order', '--file', f, '--after', 'x');
  assert.equal(o.json.ok, true, o.out);
});

test('recenzja S3 (9): drugie zatrzymanie waiting-user, zanim pętla zobaczy sterownik żywy: poprzednia sesja zatrzymania zamknięta przed nową', () => {
  const w = world({ files: ['a'] });
  w.tick();
  w.status('a', { state: 'waiting-user', stage: 'planning', questions: ['Q-1 Discount cap'], affects: [] });
  w.stop('a', 'waiting-user', { reason: 'T-1 ask-plan' });
  w.tick();
  const [first] = w.has('launch', 'a');
  // Sesja zatrzymania uruchamia sterownik po odpowiedzi; ten staje znowu na pytaniu przed następnym odczytem pętli.
  w.ops.startDriver({ ...w.item('a'), driveAt: new Date(Date.now() + 5000).toISOString() });
  w.status('a', { state: 'waiting-user', stage: 'planning', questions: ['Q-2 Rounding'], affects: [] });
  w.stop('a', 'waiting-user', { reason: 'T-1 ask-plan (Q-2)' });
  w.tick(10e3);
  const launches = w.has('launch', 'a');
  assert.equal(launches.length, 2);
  const iStop = w.calls.findIndex((c) => c[0] === 'stop-session' && c[1] === first[2]);
  assert.ok(iStop >= 0 && iStop < w.calls.indexOf(launches[1]), 'poprzednia sesja zamknięta przed nową');
  assert.equal(w.item('a').stopSession.id, launches[1][2]);
});

test('recenzja S3 (10): rotacja dziennika między odczytami: task-start z końca starego pliku policzony (limit nocy); preflight ostrzega bez dziennika', () => {
  const w = world({ files: ['a'], presence: 'away' });
  w.tick();
  w.event('task-start', 'a', { task: 1 });
  const prev = process.env.DWMT_EVENTS_MAX;
  process.env.DWMT_EVENTS_MAX = '1';
  try { w.event('task-end', 'a', { task: 1, costM: 0.5 }); } finally { if (prev === undefined) delete process.env.DWMT_EVENTS_MAX; else process.env.DWMT_EVENTS_MAX = prev; }
  assert.ok(existsSync(join(DWMT_HOME, 'events.jsonl.1')), 'rotacja między odczytami');
  w.tick();
  assert.equal(w.sup().night.count, 1, 'task-start sprzed rotacji policzony');
  assert.equal(w.item('a').taskCostM, 0.5, 'zdarzenie z nowego pliku');
  const d = repo();
  const f = join(mkdtempSync(join(tmpdir(), 'dwmt-ev0-')), 'e.md');
  writeFileSync(f, 'Sprint e.\n');
  const r = spawnSync(process.execPath, [SCRIPT, 'supervise', 'order', '--file', f], { cwd: d, encoding: 'utf8', env: { ...ENV, DWMT_EVENTS: '0' } });
  assert.ok(JSON.parse(r.stdout).warnings.some((x) => /dziennik zdarzeń wyłączony/.test(x)), r.stdout);
});

test('recenzja S3 (11): commit katalogu produktu na celu w czasie merge-wait (intake przy UAT) nie unieważnia zielonej pełnej suity', () => {
  const main = repo();
  const g = gitIn(main);
  cli(main, 'setup');
  mkdirSync(join(main, 'docs', 'product'), { recursive: true });
  writeFileSync(join(main, 'docs', 'product', 'notes.md'), '# Notes\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'dwmt setup');
  const wt = join(main, '..', `${basename(main)}-wt`);
  g('worktree', 'add', '-q', '-b', 'sprint', wt);
  const run = cli(wt, 'preflight', '--slug', 'w').json.run;
  cli(wt, 'init', '--run', run);
  cli(wt, 'import-plan', plan(wt, run, 'inline'), '--run', run);
  writeFileSync(join(wt, 'w.txt'), 'w\n');
  cli(wt, 'verify', run);
  cli(wt, 'review-input', run);
  put(wt, run, 'review-1.md', { schema: 'dwmt/review@1', round: 1, passes: [], verdict: 'PASS', fix: [] });
  cli(wt, 'commit', run);
  writeFileSync(join(main, 'a.txt'), 'brud\n');
  const mw = cli(wt, 'finish', run).json;
  assert.equal(mw.status, 'merge-wait', JSON.stringify(mw));
  g('checkout', '--', 'a.txt');
  // `uat record` → `product intake` commituje katalog produktu na gałęzi docelowej, zanim sprint dokończy finish.
  writeFileSync(join(main, 'docs', 'product', 'notes.md'), '# Notes\n- UAT of an earlier sprint recorded\n');
  g('add', 'docs/product');
  g('commit', '-q', '-m', 'product: intake UAT');
  const sq = cli(wt, 'finish', run).json;
  assert.equal(sq.status, 'squashed', JSON.stringify(sq));
  assert.equal(sq.reused, true, 'cel przesunięty tylko w katalogu produktu: bez ponownej pełnej suity');
});

test('recenzja S3 (13): ścieżka sesji dostaje R3 (zależność w finish, here); maszyna: wpis rejestru z obcym startem procesu się nie liczy, sterownik spoza zlecenia tak', () => {
  const w = world({ after: null, presence: 'here', cfg: { drive: { enabled: false } } });
  w.tick();
  assert.equal(w.has('launch', 'a').length, 1);
  w.status('a', { state: 'running', step: 'finish', at: new Date(Date.now() + 1000).toISOString() });
  w.tick(2000);
  assert.equal(w.has('launch', 'b').length, 1, 'R3 na ścieżce sesji: planowanie przed scaleniem a');
  assert.deepEqual([w.item('b').planRule, w.item('b').planOnly], ['R3', false], 'sesja sama staje na planned (after w wejściu)');

  const kids = [0, 1].map(() => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }));
  const reg = join(DWMT_HOME, 'supervisors');
  const files = [];
  try {
    mkdirSync(reg, { recursive: true });
    // Pętle innych projektów, których pid po restarcie dostał inny proces (inny start procesu): bez zajętych miejsc.
    kids.forEach((k, i) => { const f = join(reg, `stale-review-${i}.json`); files.push(f); writeFileSync(f, JSON.stringify({ root: `C:/other-${i}`, pid: k.pid, pidStart: '2000-01-01T00:00:00.000Z', active: 1 })); });
    const v = world({ files: ['a'], presence: 'away' });
    v.tick();
    assert.equal(v.item('a').state, 'running', 'rejestr z obcym startem procesu nie zajmuje maszyny');
    // Dwa sterowniki tego projektu spoza zlecenia (np. sprinty PO): maszyna pełna (maxActiveSprints 2).
    const u = world({ files: ['a'], presence: 'away' });
    kids.forEach((k, i) => { const root = join(u.main, '.dwmt', 'runs', `manual-${i}`); mkdirSync(root, { recursive: true }); writeFileSync(join(root, 'drive.lock'), JSON.stringify({ pid: k.pid })); });
    u.tick();
    assert.deepEqual([u.item('a').state, u.item('a').wait?.rule], ['queued', 'machine']);
  } finally {
    for (const k of kids) k.kill();
    for (const f of files) rmSync(f, { force: true });
  }
});

test('recenzja S3 (12): efekty ticku bez blokady stanu: komenda PO w trakcie przygotowania przechodzi, a jej zmiana zostaje', () => {
  const w = world({ files: ['a'] });
  const prep = w.ops.prepare;
  let during = null;
  w.ops.prepare = (m, it, mode, reserve) => {
    during = existsSync(join(m, '.dwmt', 'supervisor', 'state.lock')) ? 'locked' : sv(m, 'set', 'night-limit', '5').json?.ok;
    return prep(m, it, mode, reserve);
  };
  w.tick();
  assert.equal(during, true);
  assert.equal(w.sup().nightLimit, 5, 'zmiana komendy z czasu efektu nie nadpisana zapisem ticku');
  assert.equal(w.item('a').state, 'running');
});

test('recenzja S3 (14): sesja push chuda: tylko ustawienia użytkownika, bez MCP, obce wtyczki wyłączone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwmt-push-'));
  const fake = join(dir, 'claude.mjs');
  writeFileSync(fake, "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.FAKE_ARGS, JSON.stringify(process.argv.slice(2)));\nconsole.log('backgrounded · push-1 · dwmt push');\n");
  const home = mkdtempSync(join(tmpdir(), 'dwmt-ch-push-'));
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ enabledPlugins: { 'other@market': true, 'dwmt@local': true } }));
  const keep = { DWMT_CLAUDE: process.env.DWMT_CLAUDE, FAKE_ARGS: process.env.FAKE_ARGS, DWMT_CLAUDE_HOME: process.env.DWMT_CLAUDE_HOME };
  Object.assign(process.env, { DWMT_CLAUDE: fake, FAKE_ARGS: join(dir, 'args.json'), DWMT_CLAUDE_HOME: home });
  try {
    const id = realOps.push(repo(), 'dwmt a: sprint scalony', supConfig({}));
    assert.equal(id, 'push-1');
  } finally { for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  const a = JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8'));
  assert.deepEqual(a.slice(a.indexOf('--setting-sources'), a.indexOf('--setting-sources') + 2), ['--setting-sources', 'user']);
  assert.ok(a.includes('--strict-mcp-config'));
  assert.deepEqual(JSON.parse(a[a.indexOf('--settings') + 1]).enabledPlugins, { 'other@market': false });
  assert.deepEqual(a.slice(a.indexOf('--model'), a.indexOf('--model') + 4), ['--model', 'haiku', '--effort', 'low']);
});

// ---------- przegląd 2026-10-09 ----------

test('przegląd 2026-10-09 (W-7): order --sequential: następna pozycja zależy od poprzedniej i nie planuje z wyprzedzeniem (bez R3), rusza po scaleniu', () => {
  const w = world({ after: null, extra: ['--sequential'] });
  w.tick();
  assert.deepEqual([w.item('b').after, w.item('b').seq], [['a'], true]);
  w.status('a', { state: 'running', step: 'finish' });
  w.tick();
  assert.deepEqual([w.item('b').state, w.item('b').wait.rule], ['queued', 'after'], 'przy here i a w finish: bez R3');
  w.status('a', { state: 'done', result: 'PASS', cost: 3, uat: 'n/a' });
  w.stop('a', 'done');
  w.tick();
  assert.equal(w.item('b').state, 'running');
  assert.equal(w.has('prepare', 'b').length, 1);
});

test('przegląd 2026-10-09 (W-3): zdarzenie price-alert → jedno powiadomienie (pulpit i telefon), sprint bez zatrzymania', () => {
  const w = world({ presence: 'away' });
  w.tick();
  w.event('price-alert', 'a', { costM: 30, detail: { upperM: 25, forecastM: 52 } });
  w.tick();
  w.tick();
  const n = w.has('notify').filter((c) => /koszt 30 mln przekroczył górną cenę 25 mln, prognoza ok\. 52 mln/.test(c[1]));
  assert.equal(n.length, 1);
  assert.equal(w.has('push').filter((c) => /górną cenę/.test(c[1])).length, 1);
  assert.equal(w.item('a').state, 'running');
});

// ---------- zgłoszenie z 2026-10-15 ----------

const LOAD_ERR = (f, name) => `komenda \`dwmt state\` zakończyła się bez wyniku (exit 1): file:///D:/x/scripts/${f}:17\nimport { alive, ${name} } from '../machine.mjs';\nSyntaxError: The requested module '../machine.mjs' does not provide an export named '${name}'`;

test('2026-10-15 F2: błąd ładowania dwmt wstrzymuje zlecenie jednym powiadomieniem, pozycje wracają do stanu sprzed efektu, po udanym sprawdzeniu pętla wznawia sama', () => {
  const w = world({ presence: 'away' });
  const down = () => w.has('notify').filter((c) => /narzędzie albo środowisko nie działa/.test(c[1])).length;
  // Przygotowanie (preflight) z błędem ładowania: pozycja wraca do kolejki, bez `stopped`.
  w.onPrepare = () => ({ ok: false, error: `preflight: ${LOAD_ERR('product.mjs', 'translateInBackground')}` });
  w.tick();
  assert.equal(w.item('a').state, 'queued');
  assert.ok(w.sup().infra, 'zlecenie czeka na środowisko');
  assert.equal(down(), 1);
  w.tick(MIN);
  assert.equal(w.has('prepare').length, 1, 'bez kolejnych prób przed sprawdzeniem');
  assert.equal(w.has('probe').length, 0);
  w.probeResult = { ok: false, error: 'SyntaxError: still broken' };
  w.tick(6 * MIN);
  assert.equal(w.has('probe').length, 1);
  assert.ok(w.sup().infra);
  w.onPrepare = null;
  w.probeResult = { ok: true };
  w.tick(12 * MIN);
  assert.equal(w.sup().infra, undefined);
  w.tick(13 * MIN);
  assert.equal(w.item('a').state, 'running');
  // Sterownik zatrzymany błędem ładowania modułu (`child-dead` z `dwmt state`): `resume`, nie `stopped`; b nie rusza.
  w.stop('a', 'stopped', { cause: 'child-dead', reason: LOAD_ERR('lib/product-view.mjs', 'heldLeases') });
  w.tick(14 * MIN);
  assert.equal(w.item('a').state, 'resume');
  assert.equal(w.item('a').reason, null);
  assert.equal(w.has('prepare', 'b').length, 0, 'b czeka, aż środowisko wróci');
  assert.equal(down(), 2, 'nowy błąd: jedno powiadomienie');
  assert.match(sv(w.main, 'status').out, /waiting for the environment: SyntaxError.*heldLeases' \(D:\/x\/scripts\/lib\/product-view\.mjs:17\)/);
  w.tick(20 * MIN);
  w.tick(21 * MIN);
  assert.equal(w.has('drive', 'a').length, 2, 'sterownik a wznowiony bez polecenia użytkownika');
  assert.equal(w.has('notify').filter((c) => /narzędzie znowu działa/.test(c[1])).length, 2);
  assert.match(w.log(), /\[infra\] środowisko działa/);
  // Zwykły błąd sterownika dalej zatrzymuje pozycję.
  w.stop('a', 'stopped', { cause: 'child-dead', reason: 'komenda `dwmt verify` zakończyła się bez wyniku (exit 1): boom' });
  w.tick(22 * MIN);
  assert.equal(w.item('a').state, 'stopped');
});

test('2026-10-15 F4: pytanie R1 zamyka się samo, gdy czekająca pozycja ruszy dalej', () => {
  const w = world({ presence: 'away' });
  w.tick();
  w.status('a', { state: 'waiting-user', stage: 'planning', questions: ['Q-1 Old PDF generator'], affects: ['b'], scope: ['src/a/**'] });
  w.stop('a', 'waiting-user', { reason: 'T-1 ask-plan' });
  assert.equal(sv(w.main, 'set', 'presence', 'here').json.ok, true);
  w.tick();
  assert.equal(w.sup().pending.filter((p) => !p.answer).length, 1);
  // Odpowiedź w sesji zatrzymania: sterownik a znowu żyje, plik statusu bez pytań.
  w.status('a', { state: 'running', stage: 'planning', affects: [] });
  w.ops.startDriver({ id: 'a', root: w.root('a'), driveAt: new Date().toISOString() });
  w.tick(MIN);
  const p = w.sup().pending[0];
  assert.equal(p.answer, 'obsolete');
  assert.match(w.log(), /pytanie P-1 nieaktualne/);
  assert.match(readFileSync(join(w.main, '.dwmt', 'supervisor', 'pending.md'), 'utf8'), /none/);
  assert.equal(sv(w.main, 'status', '--json').json.pending.length, 0);
});

test('2026-10-15 F6: supervise status pokazuje każdą niezakończoną pozycję (było: 15 pierwszych), zakończone w jednej linii', () => {
  const files = Array.from({ length: 17 }, (_, i) => `s${i + 1}`);
  const w = world({ presence: 'away', files });
  w.tick();
  w.status('s1', { state: 'done', result: 'PASS', cost: 1, uat: 'n/a' });
  w.stop('s1', 'done');
  w.tick();
  const out = sv(w.main, 'status').out;
  assert.match(out, /^- s17 queued/m);
  assert.match(out, /^- done: s1$/m);
  assert.doesNotMatch(out, /^- s1 done/m);
});

test('2026-10-15 F7a: hold all w czasie przygotowania pozycji wstrzymuje jej start; resume all ją uruchamia', () => {
  const w = world({ presence: 'away' });
  w.onPrepare = (m) => { assert.equal(sv(m, 'hold', 'all').json.ok, true); return null; };
  w.tick();
  assert.equal(w.item('a').state, 'resume');
  assert.equal(w.has('drive').length, 0, 'sterownik nie rusza po wstrzymaniu');
  assert.match(w.log(), /a \[hold\] przygotowana, start wstrzymany \(hold\)/);
  w.onPrepare = null;
  assert.equal(sv(w.main, 'resume', 'all').json.ok, true);
  w.tick(MIN);
  assert.equal(w.has('drive', 'a').length, 1);
  assert.equal(w.item('a').state, 'running');
});

test('2026-10-15 F7b: przestój przy zamkniętym zleceniu nie nazywa się „ponownym”', () => {
  const w = world({ presence: 'away' });
  w.tick();
  assert.equal(sv(w.main, 'close').json.ok, true);
  w.die('a');
  w.tick(10 * MIN);
  assert.equal(w.item('a').state, 'stopped');
  assert.match(w.log(), /przestój przy zamkniętym zleceniu, pozycja zatrzymana/);
  assert.doesNotMatch(w.log(), /ponowny przestój/);
});

test('2026-10-15 F8: to samo ostrzeżenie preflight (inna liczba commitów) raz na zlecenie', () => {
  const w = world({ presence: 'away' });
  w.prepWarnings = ['master wyprzedza origin/master o 144 commitów, a worktree.baseRef ≠ head'];
  w.tick();
  w.status('a', { state: 'done', result: 'PASS', cost: 1, uat: 'n/a' });
  w.stop('a', 'done');
  w.prepWarnings = ['master wyprzedza origin/master o 239 commitów, a worktree.baseRef ≠ head'];
  w.tick();
  assert.equal(w.item('b').state, 'running');
  assert.equal((w.log().match(/\[preflight\]/g) ?? []).length, 1);
});

test('2026-10-15 F2: prawdziwe sprawdzenie środowiska importuje dwmt, drive i supervise bez uruchamiania komend', () => {
  assert.deepEqual(realOps.probe(), { ok: true });
});

test('2026-10-16 pkt 8: dwa gotowe plany „tylko planowanie” nie czekają na siebie; zwolnienie pierwszej w kolejności, druga po jej scaleniu', () => {
  const f = join(DWMT_HOME, 'machine.json');
  const old = existsSync(f) ? readFileSync(f, 'utf8') : null;
  writeFileSync(f, JSON.stringify({ ...JSON.parse(old ?? '{}'), maxActiveSprints: 3 }));
  try {
    for (const shared of [false, true]) {
      const w = world({ files: ['a', 'b', 'c'], presence: 'here' });
      const put = (id, fields) => { const sup = w.sup(); Object.assign(sup.items.find((x) => x.id === id), fields); writeFileSync(join(w.main, '.dwmt', 'supervisor', 'supervisor.json'), JSON.stringify(sup)); };
      // Dwa niezwolnione starty „tylko planowanie” naraz (w projekcie testowym: wskrzeszona po przestoju pozycja z `planOnly` sprzed dni).
      w.tick();
      put('b', { planOnly: false });
      w.tick();
      put('b', { planOnly: true });
      assert.deepEqual(['a', 'b', 'c'].map((x) => [w.item(x).state, w.item(x).planOnly]), [['running', false], ['running', true], ['running', true]]);
      // b i c kończą planowanie i stają na drive.hold (status jak w projekcie testowym: running/implement, bez etapu).
      for (const x of ['b', 'c']) { w.status(x, { state: 'running', step: 'implement', scope: [shared ? 'src/x/**' : `src/${x}/**`] }); w.stop(x, 'hold'); }
      w.tick();
      assert.deepEqual([w.item('b').state, w.item('c').state], ['hold', 'hold']);
      w.status('a', { state: 'done', result: 'PASS', cost: 3, uat: 'n/a' });
      w.stop('a', 'done');
      w.tick();
      assert.deepEqual(['b', 'c'].map((x) => [w.item(x).state, w.item(x).planOnly]), [['running', false], ['hold', true]], `obszary wspólne: ${shared}`);
      assert.deepEqual(w.has('drive', 'b').at(-1), ['drive', 'b', false]);
      w.tick();
      assert.equal(w.item('c').state, 'hold', 'c czeka na zwolnioną b');
      w.status('b', { state: 'done', result: 'PASS', cost: 2, uat: 'n/a' });
      w.stop('b', 'done');
      w.tick();
      assert.deepEqual([w.item('c').state, w.item('c').planOnly], ['running', false]);
      assert.deepEqual(w.has('drive', 'c').at(-1), ['drive', 'c', false]);
    }
  } finally {
    if (old == null) rmSync(f, { force: true }); else writeFileSync(f, old);
  }
});

// ---------- zgłoszenie z 2026-10-16, pkt 9–12 ----------

const putItem = (w, id, fields) => { const sup = w.sup(); Object.assign(sup.items.find((x) => x.id === id), fields); writeFileSync(join(w.main, '.dwmt', 'supervisor', 'supervisor.json'), JSON.stringify(sup)); };

test('2026-10-16 pkt 12: sterownik uznaje zależność za scaloną tak jak pętla: pozycja zlecenia done bez pliku statusu (scalona poza zleceniem) → bez planned', () => {
  const { d } = repo28({ drive: { enabled: true } });
  const runId = start(d, 'pl');
  writePlans(d, runId);
  const f = join(d, '.dwmt', 'runs', runId, 'run.json');
  const rj = JSON.parse(readFileSync(f, 'utf8'));
  Object.assign(rj, { sprint: 'pl', after: ['dep'], order: ['dep', 'pl'] });
  writeFileSync(f, JSON.stringify(rj, null, 2));
  mkdirSync(join(d, '.dwmt', 'supervisor', 'status'), { recursive: true });
  // Jak w projekcie testowym: pozycja zlecenia `done` („merged outside this order”), bez przebiegu i bez `status/dep.json`.
  writeFileSync(join(d, '.dwmt', 'supervisor', 'supervisor.json'), JSON.stringify({ schema: 'dwmt/supervisor@1', items: [{ id: 'dep', state: 'done', reason: 'merged outside this order' }, { id: 'pl', state: 'running', run: runId }], pending: [], notified: [] }));
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/drive.mjs', import.meta.url)), runId], { cwd: d, encoding: 'utf8', timeout: 120e3, env: { ...ENV, DWMT_CLAUDE: 'brak-agenta', DWMT_DRIVE_QUIET: '1' } });
  const out = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
  assert.notEqual(out.status, 'planned', r.stdout + r.stderr);
  assert.equal(out.waitingFor, undefined);
});

test('2026-10-16 pkt 12: planned z tym samym waitingFor po starcie „zależności scalone” → bez ponownego startu, dopóki stan zależności się nie zmieni', () => {
  const w = world({ files: ['a', 'b'], after: null, presence: 'away' });
  putItem(w, 'a', { state: 'done', reason: 'merged outside this order' });
  w.tick();
  assert.equal(w.item('b').state, 'running');
  // Sterownik widzi zależność inaczej niż pętla (tu: fałszywy sterownik) i kończy na planned.
  for (let n = 0; n < 3; n++) { w.stop('b', 'planned', { waitingFor: ['a'] }); w.tick(n * MIN); }
  assert.equal(w.has('drive', 'b').length, 1, `bez pętli startów: ${w.log()}`);
  assert.equal(w.item('b').state, 'planned');
  assert.match(w.log(), /b \[after\] czeka: sterownik czeka na scalenie a/);
  assert.equal(w.has('notify').filter((c) => /b: sterownik czeka na scalenie a/.test(c[1])).length, 1, 'jedno powiadomienie');
  // Zmiana stanu zależności (plik statusu) → jedna próba.
  w.status('a', { state: 'done', result: 'PASS' });
  w.tick(5 * MIN);
  assert.equal(w.has('drive', 'b').length, 2);
  w.stop('b', 'planned', { waitingFor: ['a'] });
  w.tick(6 * MIN);
  assert.equal(w.has('drive', 'b').length, 2);
  // supervise resume b: decyzja użytkownika, jeszcze jedna próba.
  assert.equal(sv(w.main, 'resume', 'b').json.ok, true);
  w.tick(7 * MIN);
  assert.equal(w.has('drive', 'b').length, 3);
});

test('2026-10-16 pkt 11: wynik UAT poprzedniego przebiegu sprintu nie wyzwala poprawek nowego; sprint poprawek czyta UAT przebiegu, który go wyzwolił', () => {
  const w = world({ files: ['a'], presence: 'away' });
  w.tick();
  w.status('a', { state: 'running' });
  // UAT z 10-10 dla starego przebiegu tego sprintu (w projekcie testowym: 2026-10-09-pm-8), zapisany przed nowym przebiegiem.
  w.uat('a', [{ seq: 1, at: '2026-10-10T10:10:32.815Z', type: 'uat', result: 'defects', counts: { major: 1 }, requirementChanges: 1, fixSprint: { uat: `${fwd(w.main)}/.dwmt/runs/r-old/uat.md`, defects: ['U-1'] } }]);
  w.status('a', { state: 'done', result: 'PASS', cost: 1, uat: 'n/a' });
  w.stop('a', 'done');
  w.tick();
  assert.equal(w.item('a').state, 'done');
  assert.equal(w.item('a').fixItem, undefined, w.log());
  assert.equal(w.item('a').uatDone, undefined);
  assert.equal(w.sup().items.length, 1);
  assert.match(w.log(), /a \[UAT\] wynik UAT innego przebiegu \(r-old\) pominięty/);
  // UAT tego przebiegu → sprint poprawek z przebiegiem źródłowym w pliku wejścia.
  w.uat('a', [{ seq: 1, at: '2026-10-10T10:10:32.815Z', type: 'uat', result: 'defects', run: 'r-old', counts: { major: 1 } }, { seq: 2, at: new Date().toISOString(), type: 'uat', result: 'defects', run: 'r-a', counts: { major: 1 }, fixSprint: { uat: `${fwd(w.main)}/.dwmt/runs/r-a/uat.md`, defects: ['U-1'] } }]);
  w.tick();
  const fix = w.item('a-fix');
  assert.ok(fix, w.log());
  assert.equal(fix.sourceRun, 'r-a');
  assert.match(readFileSync(join(w.main, '.dwmt', 'supervisor', 'input', 'a-fix.md'), 'utf8'), /sourceRun: "?r-a"?/);
});

test('2026-10-16 pkt 11: init sprintu poprawek bierze uat.md przebiegu źródłowego, nie najnowszego przebiegu sprintu', async () => {
  const { sourceUat } = await import('../scripts/uat.mjs');
  const main = repo();
  const mk = (run, created, uat) => {
    const dir = join(main, '.dwmt', 'runs', run);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ run, sprint: 's', created, finish: { status: 'squashed' } }));
    if (uat) writeFileSync(join(dir, 'uat.md'), '---\nschema: dwmt/uat@1\n---\n');
  };
  mk('2026-10-09-s', '2026-10-09T10:00:00Z', true);
  mk('2026-10-10-s', '2026-10-10T10:00:00Z', false);
  assert.equal(fwd(sourceUat(main, 's', '2026-10-09-s')), fwd(join(main, '.dwmt', 'runs', '2026-10-09-s', 'uat.md')));
  assert.throws(() => sourceUat(main, 's'), /2026-10-10-s\/uat\.md/);
});

test('2026-10-16 pkt 10: sprint zamknięty w roadmapie: bez startu i bez wznowienia (także po przestoju), jedno powiadomienie', async () => {
  const { appendIndex, paths } = await import('../scripts/lib/product-store.mjs');
  const { productConfig } = await import('../scripts/lib/product-config.mjs');
  const { loadConfig } = await import('../scripts/lib/config.mjs');
  const w = world({ files: ['a', 'b'], presence: 'away', cfg: { product: {} } });
  assert.equal(pr(w.main, 'init', '--goal', 'Pilot').code, 0);
  const P = paths(w.main, productConfig(w.main, loadConfig(w.main)));
  appendIndex(P, [{ id: 'b', goal: 'Old sprint', merged: '2026-10-10', run: 'r-b-old', files: null, tokensM: null }]);
  w.tick();
  assert.equal(w.item('a').state, 'running');
  assert.equal(w.has('prepare', 'b').length, 0, 'zamknięty sprint nie startuje');
  assert.equal(w.item('b').state, 'stopped');
  assert.match(w.item('b').reason, /roadmap/);
  // Pozycja z przebiegiem (w projekcie testowym: pm-8 wskrzeszony po przestoju): wznowienie po przestoju też nie rusza.
  putItem(w, 'b', { state: 'running', run: 'r-b', root: fwd(w.root('b')), worktree: fwd(w.main), path: 'driver', driveAt: new Date(Date.now() - 20 * MIN).toISOString(), reason: null });
  mkdirSync(w.root('b'), { recursive: true });
  writeFileSync(join(w.root('b'), 'run.json'), JSON.stringify({ run: 'r-b', sprint: 'b', session_ids: [] }));
  writeFileSync(join(w.root('b'), 'drive.json'), JSON.stringify({ pid: 9036, startedAt: new Date(Date.now() - 20 * MIN).toISOString() }));
  w.tick(10 * MIN);
  assert.equal(w.has('drive', 'b').length, 0, w.log());
  assert.equal(w.item('b').state, 'stopped');
  assert.equal(sv(w.main, 'resume', 'b').json.ok, true);
  w.tick(11 * MIN);
  assert.equal(w.has('drive', 'b').length, 0);
  assert.equal(w.has('notify').filter((c) => /b: sprint zamknięty w roadmapie/.test(c[1])).length, 1, 'jedno powiadomienie');
});

test('2026-10-16 pkt 9: powód zatrzymania znika po starcie nowego sterownika i przy done', () => {
  const w = world({ files: ['a'], presence: 'away' });
  w.tick();
  // Stary powód przestoju przy pozycji, która znowu pracuje (nowy sterownik żyje).
  putItem(w, 'a', { state: 'stopped', reason: 'stall: sterownik (pid 9036) przestał działać bez zdarzenia końca' });
  w.tick();
  assert.equal(w.item('a').state, 'running');
  let s = sv(w.main, 'status', '--json').json;
  assert.equal(s.items.find((x) => x.id === 'a').reason, undefined, JSON.stringify(s.items));
  // Done z powodem sprzed (dane z projektu testowego: pm-12-2-fix done — stall: …): status bez powodu.
  w.status('a', { state: 'done', result: 'PASS', cost: 1, uat: 'pending' });
  putItem(w, 'a', { reason: 'stall: sterownik (pid 21896) przestał działać bez zdarzenia końca' });
  w.stop('a', 'done');
  w.tick();
  s = sv(w.main, 'status', '--json').json;
  assert.equal(s.items.find((x) => x.id === 'a').state, 'done');
  assert.equal(w.item('a').reason, null);
  assert.equal(s.items.find((x) => x.id === 'a').reason, undefined);
  assert.doesNotMatch(sv(w.main, 'status').out, /stall:/);
});

test('2026-10-16 drobne: preflight --worktree (worktree dwmt od HEAD) bez ostrzeżenia o origin i worktree.baseRef', () => {
  const d = repo();
  const bare = mkdtempSync(join(tmpdir(), 'dwmt-origin-'));
  spawnSync('git', ['clone', '-q', '--bare', d, bare]);
  const g = gitIn(d);
  g('remote', 'add', 'origin', bare);
  g('fetch', '-q', 'origin');
  writeFileSync(join(d, 'b.txt'), 'x\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'ahead');
  const pf = (...a) => JSON.parse(spawnSync(process.execPath, [SCRIPT, 'preflight', '--slug', 'x', ...a], { cwd: d, encoding: 'utf8', env: ENV }).stdout);
  assert.ok(pf().warnings.some((x) => /wyprzedza origin/.test(x)), 'bez --worktree ostrzeżenie zostaje');
  assert.ok(!pf('--worktree').warnings.some((x) => /wyprzedza origin/.test(x)));
});

// ---------- kf2: zależności, priorytet startu i wycofanie z bieżącej roadmapy ----------

async function kf2World(opts) {
  const { renderRoadmap } = await import('../scripts/lib/product-store.mjs');
  const w = world({ presence: 'away', cfg: { product: {} }, ...opts });
  assert.equal(pr(w.main, 'init', '--goal', 'Pilot').code, 0);
  w.rows = (rows) => writeFileSync(join(w.main, 'docs', 'product', 'roadmap.md'), renderRoadmap(rows.map(([id, state = 'ready', after = []]) => ({ id, state, goal: `Goal ${id}`, after, detail: state === 'topic' ? 'none' : `sprints/${id}.md`, alias: null, current: false }))));
  w.notifies = (re) => w.has('notify').filter((c) => re.test(c[1]));
  return w;
}
const inputOf = (w, id) => readFileSync(join(w.main, '.dwmt', 'supervisor', 'input', `${id}.md`), 'utf8');
const bodyOf = (t) => t.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/, '');

test('kf2 roadmap order: the sprint the roadmap now puts first starts, the other waits for it; input rewritten, body kept', async () => {
  const w = await kf2World({ files: ['a', 'b'], after: null });
  putItem(w, 'a', { src: 'spec' });
  putItem(w, 'b', { src: 'spec' });
  const body = bodyOf(inputOf(w, 'a'));
  w.rows([['b'], ['a', 'ready', ['b']]]);
  w.tick();
  assert.equal(w.has('prepare', 'b').length, 1, w.log());
  assert.equal(w.has('prepare', 'a').length, 0);
  assert.deepEqual([w.item('a').wait?.rule, w.item('a').wait?.text], ['after', 'czeka na scalenie: b']);
  assert.deepEqual([w.item('a').after, w.item('b').after], [['b'], []]);
  assert.match(w.log(), /a \[roadmap\] zależności: brak → b/);
  assert.match(inputOf(w, 'a'), /^after:\s*\[\s*"?b"?\s*\]/m);
  assert.equal(bodyOf(inputOf(w, 'a')), body);
});

test('kf2 sequential: --sequential waits for the nearest order item above in the current roadmap (B-16)', async () => {
  const w = await kf2World({ files: ['a', 'b', 'c'], after: null });
  putItem(w, 'a', { src: 'spec' });
  putItem(w, 'b', { src: 'spec', seq: true });
  putItem(w, 'c', { src: 'spec', seq: true });
  w.rows([['a'], ['c'], ['b']]);
  w.tick();
  assert.deepEqual([w.item('c').after, w.item('b').after], [['a'], ['c']]);
});

test('kf2 withdrawal: a sprint moved back to todo does not start, one notification, starts by itself once ordered again', async () => {
  const w = await kf2World({ files: ['a', 'b'] });
  putItem(w, 'a', { src: 'spec' });
  putItem(w, 'b', { src: 'spec' });
  w.rows([['a'], ['b', 'todo']]);
  w.tick();
  w.tick();
  assert.equal(w.item('b').wait?.rule, 'roadmap');
  assert.match(w.item('b').wait.text, /todo/);
  assert.equal(w.has('prepare', 'b').length, 0);
  assert.equal(w.notifies(/b cofnięty w planie/).length, 1);
  w.rows([['a'], ['b', 'ordered']]);
  w.tick();
  assert.notEqual(w.item('b').wait?.rule, 'roadmap');
});

test('kf2 coding run: a dependency change after the first task started does not stop the sprint; one notification', async () => {
  const w = await kf2World({ files: ['a', 'b'] });
  putItem(w, 'a', { src: 'spec' });
  putItem(w, 'b', { src: 'spec' });
  w.rows([['a'], ['b']]);
  w.tick();
  assert.equal(w.item('a').state, 'running');
  w.event('task-start', 'a', { task: 1 });
  w.rows([['a', 'ready', ['b']], ['b']]);
  w.tick();
  w.tick();
  assert.equal(w.notifies(/a: plan zmienił zależności/).length, 1, w.log());
  assert.ok(!['stopped', 'queued'].includes(w.item('a').state), w.item('a').state);
  assert.deepEqual(w.item('a').after, ['b']);
});

test('kf2 outside dep: a roadmap dependency outside the order means waiting with a reason and one notification', async () => {
  const w = await kf2World({ files: ['a'] });
  putItem(w, 'a', { src: 'spec' });
  w.rows([['x', 'todo'], ['a', 'ready', ['x']]]);
  w.tick();
  w.tick();
  assert.equal(w.item('a').wait?.rule, 'after');
  assert.match(w.item('a').wait.text, /x \(spoza zlecenia\)/);
  assert.equal(w.has('prepare', 'a').length, 0);
  assert.equal(w.notifies(/spoza zlecenia/).length, 1);
});

test('kf2 file items: --file items keep the stored dependencies and list position', async () => {
  const w = await kf2World({ files: ['a', 'b'], after: null });
  w.rows([['b'], ['a', 'ready', ['b']]]);
  w.tick();
  assert.deepEqual([w.item('a').after, w.item('b').after], [[], ['a']]);
  assert.equal(w.has('prepare', 'a').length, 1);
  assert.equal(w.has('prepare', 'b').length, 0);
  assert.doesNotMatch(w.log(), /\[roadmap\] zależności/);
});

test('kf2 coding run outside dep: a dependency outside the order for a coding sprint gives one notification, not a false wait (review F-1)', async () => {
  const w = await kf2World({ files: ['a', 'b'] });
  putItem(w, 'a', { src: 'spec' });
  putItem(w, 'b', { src: 'spec' });
  w.rows([['a'], ['b']]);
  w.tick();
  assert.equal(w.item('a').state, 'running');
  w.event('task-start', 'a', { task: 1 });
  w.rows([['x', 'todo'], ['a', 'ready', ['x']], ['b']]);
  w.tick();
  w.tick();
  assert.equal(w.notifies(/^a: /).length, 1, JSON.stringify(w.has('notify')));
  assert.equal(w.notifies(/a: plan zmienił zależności na x/).length, 1);
  assert.ok(!['stopped', 'queued'].includes(w.item('a').state), w.item('a').state);
});

test('kf2 withdrawn previous: a sprint of a --sequential order withdrawn in the plan names the sprints waiting for it (review F-3)', async () => {
  const w = await kf2World({ files: ['k3', 'kt'] });
  putItem(w, 'k3', { src: 'spec' });
  putItem(w, 'kt', { src: 'spec', seq: true });
  w.rows([['k3', 'todo'], ['kt']]);
  w.tick();
  w.tick();
  assert.equal(w.item('k3').wait?.rule, 'roadmap');
  assert.deepEqual(w.item('kt').after, ['k3']);
  assert.deepEqual([w.item('kt').wait?.rule, w.item('kt').wait?.text], ['after', 'czeka na scalenie: k3 (cofnięty w planie)']);
  const n = w.notifies(/k3 cofnięty w planie/);
  assert.equal(n.length, 1, JSON.stringify(w.has('notify')));
  assert.match(n[0][1], /czekają na niego: kt/);
  // Ponownie zlecony: powód kt wraca do zwykłego czekania na scalenie.
  w.rows([['k3', 'ordered'], ['kt']]);
  w.tick();
  assert.equal(w.item('kt').wait?.text, 'czeka na scalenie: k3');
});

test('kf2 planned outside dep: a planned item that gets a dependency outside the order says so in its wait reason (review F-6)', async () => {
  const w = await kf2World({ files: ['a', 'b'] });
  putItem(w, 'a', { src: 'spec' });
  putItem(w, 'b', { src: 'spec' });
  w.rows([['a'], ['b']]);
  w.tick();
  assert.equal(w.item('a').state, 'running');
  w.rows([['b'], ['a', 'ready', ['b']]]);
  w.status('a', { state: 'planned', waitingFor: ['b'] });
  w.stop('a', 'planned', { waitingFor: ['b'] });
  w.tick();
  assert.equal(w.item('a').state, 'planned');
  w.rows([['x', 'todo'], ['b'], ['a', 'ready', ['b', 'x']]]);
  w.tick();
  assert.deepEqual([w.item('a').wait?.rule, w.item('a').wait?.text], ['after', 'czeka na scalenie: b, x (spoza zlecenia)']);
});

test('kf2 fix sprint first: a sprint moved up in the roadmap does not start before the fix sprint of a merged one (review F-2)', async () => {
  const w = await kf2World({ files: ['y', 'a'] });
  putItem(w, 'y', { src: 'spec' });
  putItem(w, 'a', { src: 'spec' });
  w.rows([['y'], ['a']]);
  w.tick();
  assert.equal(w.has('prepare', 'y').length, 1, w.log());
  w.rows([['a'], ['y']]);
  w.tick();
  assert.equal(w.has('prepare', 'a').length, 0);
  // y merges (its line stays `done` while it waits for UAT) and its UAT brings a fix sprint in the same tick.
  w.rows([['a'], ['y', 'done']]);
  w.status('y', { state: 'done', result: 'PASS', cost: 1, uat: 'n/a' });
  w.stop('y', 'done');
  w.uat('y', [{ seq: 1, at: new Date().toISOString(), type: 'uat', result: 'defects', run: 'r-y', counts: { major: 1 }, requirementChanges: 0, fixSprint: { defects: ['U-1'] } }]);
  w.tick();
  assert.deepEqual(w.sup().items.map((x) => x.id), ['y', 'y-fix', 'a']);
  assert.equal(w.has('prepare', 'y-fix').length, 1, w.log());
  assert.equal(w.has('prepare', 'a').length, 0);
});
