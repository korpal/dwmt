import './tmp-root.mjs';
// dwmt v2.10 po niezależnej recenzji: `watch` w tle (nie Monitor), przyrost przy biegnącej komendzie bez głównego
// transkryptu, kolejka to praca, porty w dzierżawie, bezpieczne `delete`, odczyt w trakcie zapisu, PID użyty ponownie,
// zgoda na usunięcie w turze pytań, `kept` → ACCEPTED, reguła `verify`, netstat po polsku, dziennik (koszt, rotacja).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { verifyCommandErrors, deleteErrors, deletePathError } from '../scripts/dwmt.mjs';
import { emit, readEvents, eventsFile } from '../scripts/events.mjs';
import { assess, watchLoop, markActive, readActive, processAlive, withActive } from '../scripts/watch.mjs';
import { portBusy, netstatListenPid, portPid, tickets } from '../scripts/machine.mjs';
import { header, runFile, DWMT_HOME, SCRIPT, gitIn, asRules } from './helpers.mjs';
import { cliAs, PLAN, T1, repo28, start, writePlans, review, hdr, NO_TRANSCRIPTS } from './fixtures28.mjs';

const state = (d, sid, run) => cliAs(d, sid, 'state', run).json;
const fwd = (p) => String(p).replace(/\\/g, '/');
const old = (f, min = 600) => { const t = new Date(Date.now() - min * 60e3); utimesSync(f, t, t); };
const until = async (fn, ms = 20e3) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 100)); } };
const withHome = (fn) => {
  const prev = process.env.DWMT_HOME;
  process.env.DWMT_HOME = DWMT_HOME;
  try { return fn(); } finally { if (prev === undefined) delete process.env.DWMT_HOME; else process.env.DWMT_HOME = prev; }
};
const T1DEL = (run, files = ['src/billing/invoice.test.ts']) => T1(run).replace('verify: ', `delete: ${JSON.stringify(files)}\nverify: `);
const skill = (n) => readFileSync(new URL(`../skills/${n}/SKILL.md`, import.meta.url), 'utf8');

function watchRun(phase, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dwmt-wb-'));
  const run = { run: 'r-wb', task: 1, phase, session_ids: ['sess-x'], ...extra };
  writeFileSync(join(root, 'run.json'), JSON.stringify(run));
  return { root, run };
}

// ---------- 1, 6, 13: verify zabite → CLI `watch` w tle wypisuje jedną linię i kończy ----------

test('watch e2e: prawdziwe `dwmt verify` z wolną komendą zabite → `dwmt watch` (CLI) wypisuje linię przestoju i kończy; skill uruchamia watch w tle', async () => {
  const { d } = repo28({ verify: { full: ['node -e 0'], targeted: null } });
  const pidFile = join(d, '..', `${d.split(/[\\/]/).pop()}-slow.pid`);
  writeFileSync(join(d, 'slow.js'), `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 120000);\n`);
  gitIn(d)('add', '-A');
  gitIn(d)('commit', '-q', '-m', 'slow');
  const run = start(d, 'kill');
  writePlans(d, run, { t1: T1(run, { verify: ['node slow.js'] }) });
  assert.equal(state(d, 'sess-1', run).next, 'implement');
  writeFileSync(runFile(d, run, 'result-1.md', 1), header({ schema: 'dwmt/result@1', status: 'DONE' }));
  const v = spawn(process.execPath, [SCRIPT, 'verify', run], { cwd: d, stdio: 'ignore', env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'sess-1', DWMT_HOME } });
  const act = join(d, '.dwmt', 'runs', run, 'active.json');
  let slowPid = null;
  try {
    await until(() => existsSync(pidFile) && existsSync(act));
    slowPid = Number(readFileSync(pidFile, 'utf8'));
    const rec = JSON.parse(readFileSync(act, 'utf8'));
    assert.equal(rec.pid, v.pid);
    assert.ok(Math.abs(Date.parse(rec.pidStart) - Date.now()) < 120e3, 'rekord ma czas startu procesu (PID użyty ponownie)');
    v.kill('SIGKILL');
    await until(() => !processAlive(v.pid));
  } finally { if (slowPid) try { process.kill(slowPid); } catch { /* już nie żyje */ } }
  const w = spawnSync(process.execPath, [SCRIPT, 'watch', run, '--interval', '1'], { cwd: d, encoding: 'utf8', timeout: 60e3, env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'sess-1', DWMT_HOME } });
  assert.equal(w.status, 0, w.stderr);
  const lines = w.stdout.trim().split(/\r?\n/);
  assert.equal(lines.length, 1, w.stdout);
  assert.match(lines[0], new RegExp(`^dwmt ${run}: \`verify\` stopped without a result \\(pid ${v.pid} is gone`));
  assert.ok(withHome(() => readEvents({ run })).some((e) => e.type === 'stall' && e.detail.kind === 'dead'));
  // Skill: watch w tle (Monitor kończy po 5–30 min i nikt go nie wznawia); po zawieszeniu pytanie przed ponowieniem.
  const exe = skill('execute');
  assert.doesNotMatch(exe, /Monitor/);
  assert.match(exe, /run `dwmt watch <run>` in the background too \(no timeout\)/);
  assert.match(exe, /"stopped without a result": run `state` and repeat the step\. "hang suspected": ask the user before repeating it\./);
});

test('watch: martwy rekord sprzed startu obserwacji alarmuje dopiero przy drugim odczycie; verify/finish czyszczą martwy rekord; PID użyty ponownie = martwy', async () => {
  const { root, run } = watchRun('verify');
  const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  writeFileSync(join(root, 'active.json'), JSON.stringify({ cmd: 'verify', pid: Number(dead.stdout.trim()), start: new Date(Date.now() - 5000).toISOString() }));
  const lines = [];
  const r = withHome(() => watchLoop({ load: () => run, root, runId: 'r-wb-grace', project: 'p', interval: 0, maxPolls: 3, write: (s) => lines.push(s) }));
  assert.deepEqual([r.state, r.reason, r.polls, lines.length], ['stall', 'dead', 2, 1]);
  // withActive: martwy rekord bez końca znika, nowy rekord ma pidStart.
  const rec = withActive(root, 'verify', () => readActive(root));
  assert.deepEqual([rec.pid, !!rec.pidStart, rec.end], [process.pid, true, undefined]);
  // Żywy proces z innym czasem startu to nie ta komenda.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  try {
    await until(() => processAlive(child.pid));
    assert.equal(processAlive(child.pid, '2000-01-01T00:00:00.000Z'), false, 'PID użyty ponownie');
    assert.equal(processAlive(child.pid, new Date().toISOString()), true);
  } finally { child.kill(); }
});

// ---------- 2: przyrost przy biegnącej komendzie, kolejka maszyny ----------

test('watch: przy żywej komendzie rosnący główny transkrypt orkiestratora nie maskuje zawieszenia; transkrypt agenta tak; czekanie w kolejce to praca', () => {
  const { root, run } = watchRun('verify');
  const tr = mkdtempSync(join(tmpdir(), 'dwmt-trb-'));
  mkdirSync(join(tr, 'proj'), { recursive: true });
  writeFileSync(join(tr, 'proj', 'sess-x.jsonl'), '{}\n'); // orkiestrator pisze właśnie teraz
  markActive(root, 'verify');
  old(join(root, 'active.json'), 200);
  old(join(root, 'run.json'), 200);
  const none = () => [];
  const h = assess({ root, run, transcripts: tr, queue: none });
  assert.equal(h.state, 'hang', JSON.stringify(h));
  mkdirSync(join(tr, 'proj', 'sess-x', 'subagents'), { recursive: true });
  writeFileSync(join(tr, 'proj', 'sess-x', 'subagents', 'agent-a.jsonl'), '{}\n');
  assert.equal(assess({ root, run, transcripts: tr, queue: none }).state, 'working', 'agent pisze');
  rmSync(join(tr, 'proj', 'sess-x'), { recursive: true });

  // Prawdziwy bilet kolejki maszyny tego przebiegu i tego procesu, czekający (bez `start`) od 3 h.
  withHome(() => {
    const dir = join(DWMT_HOME, 'locks', 'heavy');
    mkdirSync(dir, { recursive: true });
    const q = new Date(Date.now() - 180 * 60e3).toISOString();
    const f = join(dir, `${String(Date.now()).padStart(15, '0')}-${String(process.pid).padStart(7, '0')}-0.json`);
    writeFileSync(f, JSON.stringify({ pid: process.pid, queued: q, seen: q, who: 'x verify r1', cmd: 'npm run e2e', run: 'r-wb' }));
    try {
      const a = assess({ root, run, transcripts: tr });
      assert.equal(a.state, 'working', JSON.stringify(a));
      assert.match(a.who, /waiting in the machine queue/);
      // Ten sam bilet, ale już właściciel (start 3 h temu): bez przyrostu to zawieszenie.
      writeFileSync(f, JSON.stringify({ pid: process.pid, queued: q, seen: q, start: q, who: 'x', cmd: 'npm run e2e', run: 'r-wb' }));
      assert.equal(assess({ root, run, transcripts: tr }).state, 'hang');
    } finally { rmSync(f, { force: true }); }
  });
});

// ---------- 3: porty w dzierżawie kolejki ----------

test('ports: ten sam port u innego projektu w kolejce maszyny → verify czeka w kolejce i biegnie po zwolnieniu (nie env)', async () => {
  const port = await new Promise((res) => {
    const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
  const hold = mkdtempSync(join(tmpdir(), 'dwmt-hold-'));
  const holder = join(hold, 'holder.js');
  const stop = join(hold, 'stop');
  // A-3: the port stays held up to 15 s, long enough for verify to queue under load; the test ends the holder as soon as
  // verify waits in the machine queue, so it does not wait out the window.
  writeFileSync(holder, `const fs=require('fs');const s=require('net').createServer().listen(${port},'127.0.0.1');const end=()=>{clearInterval(i);clearTimeout(t);s.close();};const i=setInterval(()=>{if(fs.existsSync(${JSON.stringify(stop)}))end();},50);const t=setTimeout(end,15000);\n`);
  const { d } = repo28({ verify: { full: ['node -e 0'], targeted: null, heavy: 'e2e', ports: [{ for: 'e2e', ports: [port] }] } });
  const run = start(d, 'pq');
  writePlans(d, run, { t1: T1(run, { verify: ['node -e "1" e2e'] }) });
  assert.equal(state(d, 'sess-1', run).next, 'implement');
  writeFileSync(runFile(d, run, 'result-1.md', 1), header({ schema: 'dwmt/result@1', status: 'DONE' }));
  const other = spawn(process.execPath, [SCRIPT, 'heavy', '--', `node "${fwd(holder)}"`], { cwd: d, stdio: 'ignore', env: { ...process.env, DWMT_HOME } });
  try {
    await until(() => portBusy(port));
    const c = spawn(process.execPath, [SCRIPT, 'verify', run], { cwd: d, env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'sess-1', DWMT_HOME, DWMT_TRANSCRIPTS: NO_TRANSCRIPTS } });
    let out = '';
    c.stdout.on('data', (b) => { out += b; });
    const exited = new Promise((res) => c.on('exit', res));
    await until(() => withHome(() => tickets('heavy').length) >= 2);
    writeFileSync(stop, '');
    await exited;
    const v = JSON.parse(out);
    assert.equal(v.result, 'pass', JSON.stringify(v));
    assert.match(String(v.queue), /w kolejce maszyny/);
  } finally { writeFileSync(stop, ''); other.kill(); }
});

// ---------- 4: bezpieczne `delete` ----------

test('delete: walidacja odrzuca ., .., \\, katalogi, .git i .dwmt; skrypt usuwa tylko śledzony plik w drzewie', () => {
  assert.deepEqual(deleteErrors({ delete: ['docs/a.md', 'src/b.ts'] }), []);
  for (const bad of ['.', '..\\x', 'a\\..\\..\\x', 'src/', 'a//b', './a.md', '.git/config', '.dwmt/runs/x/run.json', '\\x', 'C:x']) {
    assert.equal(deleteErrors({ delete: [bad] }).length, 1, bad);
  }
  const { d } = repo28();
  mkdirSync(join(d, 'tmp'), { recursive: true });
  writeFileSync(join(d, 'tmp', 'untracked.txt'), 'x\n');
  assert.equal(deletePathError(d, 'src/billing/invoice.test.ts'), null);
  assert.match(deletePathError(d, 'src/billing'), /nie jest plikiem/);
  assert.match(deletePathError(d, 'tmp/untracked.txt'), /nie jest śledzony/);
  assert.match(deletePathError(d, '.'), /pełną ścieżką/);
  assert.match(deletePathError(d, '..\\x'), /nie jest ścieżką od katalogu głównego/);
  assert.equal(deletePathError(d, 'src/none.ts'), null, 'brak pliku: nic do usunięcia');
});

// ---------- 8: zgoda w turze pytań; plik dopisany później bez pytania → kept, ACCEPTED ----------

test('delete: pliki z nagłówka planu sprintu idą do zgody w turze pytań architekta (ask-plan z delete), bez osobnej tury ask-delete', () => {
  const { d } = repo28({ deletes: { ask: true } });
  const run = start(d, 'askdel');
  const plan = PLAN(run).replace('questions: []', 'questions: ["Q-1"]\ndelete: ["src/billing/invoice.test.ts"]');
  writeFileSync(runFile(d, run, 'plan.md'), `${plan}\n## Questions\n### Q-1 Limit\n- Why I ask: x\n`);
  const st = state(d, 'sess-1', run);
  assert.deepEqual([st.next, st.questions, st.delete], ['ask-plan', ['Q-1'], ['src/billing/invoice.test.ts']], JSON.stringify(st));
  assert.deepEqual(cliAs(d, 'sess-1', 'delete-consent', run, '--yes').json.approved, ['src/billing/invoice.test.ts']);
  writePlans(d, run, { t1: T1DEL(run) });
  const st2 = state(d, 'sess-1', run);
  assert.equal(st2.next, 'implement', 'zgoda już jest: bez ask-delete');
  assert.deepEqual(st2.deleted, ['src/billing/invoice.test.ts']);
  assert.equal(existsSync(join(d, 'src', 'billing', 'invoice.test.ts')), false);
  // Prompty: architekt wypisuje pliki w planie przed pytaniami, plan inline pyta razem z pytaniami.
  assert.match(readFileSync(new URL('../templates/agents/dwmt-architect.md', import.meta.url), 'utf8'), /files the sprint removes whole go by then into the plan header `delete` \(the user consents in the same turn\)/);
  assert.match(skill('execute'), /With `delete` in the output: in the same AskUserQuestion call/);
  assert.match(skill('run'), /Files the task removes whole: list them in the brief header `delete` and do not ask .*only with `"deletes": \{"ask": true\}` in `\.claude\/dwmt\.json` ask for consent in the same call\./);
});

test('delete: plik dopisany do planu po pytaniach (replan) i nigdy niezapytany zostaje przy commicie (kept) i zadanie jest ACCEPTED', () => {
  const { d } = repo28();
  const run = start(d, 'late');
  writePlans(d, run);
  assert.equal(state(d, 'sess-1', run).next, 'implement');
  writeFileSync(runFile(d, run, 'brief.md', 1), T1DEL(run)); // jak replan po starcie zadania
  writeFileSync(join(d, 'src', 'billing', 'discount.ts'), 'export class Discount {}\n');
  writeFileSync(runFile(d, run, 'result-1.md', 1), header({ schema: 'dwmt/result@1', status: 'DONE' }));
  assert.equal(cliAs(d, 'sess-1', 'verify', run).json.ok, true);
  cliAs(d, 'sess-1', 'review-input', run);
  writeFileSync(runFile(d, run, 'review-1.md', 1), review(1));
  assert.equal(state(d, 'sess-1', run).next, 'commit');
  assert.equal(cliAs(d, 'sess-1', 'commit', run).json.ok, true);
  assert.equal(existsSync(join(d, 'src', 'billing', 'invoice.test.ts')), true);
  const rep = hdr(runFile(d, run, 'report.md', 1));
  assert.deepEqual([rep.status, rep.kept], ['ACCEPTED', ['src/billing/invoice.test.ts']]);
  const end = withHome(() => readEvents({ run })).find((e) => e.type === 'task-end');
  assert.equal(end.verdict, 'ACCEPTED');

  // Replan przed kolejną rundą (`continue`): plik dopisany później dostaje osobne jedno pytanie.
  const { d: d2 } = repo28({ deletes: { ask: true } });
  const run2 = start(d2, 'cont');
  writePlans(d2, run2);
  assert.equal(state(d2, 'sess-1', run2).next, 'implement');
  writeFileSync(runFile(d2, run2, 'brief.md', 1), T1DEL(run2));
  writeFileSync(runFile(d2, run2, 'result-1.md', 1), header({ schema: 'dwmt/result@1', status: 'PARTIAL' }));
  const st = state(d2, 'sess-1', run2);
  assert.deepEqual([st.next, st.files], ['ask-delete', ['T-1 src/billing/invoice.test.ts']], JSON.stringify(st));
  cliAs(d2, 'sess-1', 'delete-consent', run2, '--yes');
  assert.equal(state(d2, 'sess-1', run2).next, 'continue');
  assert.equal(existsSync(join(d2, 'src', 'billing', 'invoice.test.ts')), false);
});

// ---------- 5, 12: odczyt w trakcie zapisu, błędy watch na stderr, identyfikator przed active.json ----------

test('watch: run.json w trakcie zapisu to pominięty odczyt (bez linii na stdout); CLI watch i verify ze złym przebiegiem bez JSON na stdout i bez katalogów', () => {
  const { root, run } = watchRun('implement');
  let n = 0;
  const lines = [];
  const load = () => { if (n++ === 0) throw new SyntaxError('Unexpected end of JSON input'); return { ...run, phase: 'ask' }; };
  const r = watchLoop({ load, root, runId: 'r-wb-mid', project: 'p', interval: 0, maxPolls: 3, write: (s) => lines.push(s) });
  assert.deepEqual([r.state, r.polls, lines.length], ['waiting', 2, 0]);

  const { d } = repo28();
  const w = spawnSync(process.execPath, [SCRIPT, 'watch', 'nope'], { cwd: d, encoding: 'utf8', env: { ...process.env, DWMT_HOME } });
  assert.equal(w.stdout, '', 'stdout watch tylko na linię przestoju');
  assert.match(w.stderr, /brak przebiegu nope/);
  assert.equal(w.status, 1);
  assert.equal(cliAs(d, 'sess-1', 'verify', 'nope').json.ok, false);
  assert.equal(existsSync(join(d, '.dwmt', 'runs', 'nope')), false, 'literówka nie tworzy katalogu');
  assert.equal(cliAs(d, 'sess-1', 'finish', '..').json.ok, false);
  assert.equal(existsSync(join(d, '.dwmt', 'active.json')), false);
});

// ---------- 9: reguła verify ----------

test('verify: $ w apostrofach (awk, sed) to tekst; %VAR% (cmd) to zmienna', () => {
  assert.deepEqual(verifyCommandErrors({ verify: ["awk '{print $NF}' out.txt", "sed -n '$p' log.txt"] }), []);
  assert.equal(verifyCommandErrors({ verify: ['echo %API_URL%', "echo '$HOME' $HOME"] }).length, 2);
});

// ---------- 10: netstat po polsku ----------

test('ports: nasłuch z netstat po adresie obcym :0 (słowo LISTENING bywa przetłumaczone); PID właściciela na Windows', async () => {
  const pl = '  TCP    0.0.0.0:5173           0.0.0.0:0              NASŁUCHIWANIE   4242\r\n  TCP    127.0.0.1:5173         127.0.0.1:60000        USTANOWIONO     99\r\n  TCP    [::]:5174              [::]:0                 NASŁUCHIWANIE   4343\r\n';
  assert.equal(netstatListenPid(pl, 5173), 4242);
  assert.equal(netstatListenPid(pl, 5174), 4343);
  assert.equal(netstatListenPid(pl, 60000), null);
  if (process.platform !== 'win32') return;
  const srv = spawn(process.execPath, ['-e', "const s=require('net').createServer().listen(0,'127.0.0.1',()=>process.stdout.write(String(s.address().port)))"], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const port = await new Promise((res) => srv.stdout.once('data', (b) => res(Number(String(b).trim()))));
    assert.equal(portPid(port), srv.pid);
  } finally { srv.kill(); }
});

// ---------- 11: dziennik: koszt zadania, rotacja pod blokadą ----------

test('events: rotacja pod blokadą (drugi proces nie przenosi pliku); martwa blokada znika; task-end z costM z transkryptów zadania', () => {
  const home = mkdtempSync(join(tmpdir(), 'dwmt-evb-'));
  const prev = process.env.DWMT_HOME;
  process.env.DWMT_HOME = home;
  try {
    emit({ type: 'stall', project: 'p', run: 'r1' });
    mkdirSync(`${eventsFile()}.lock`);
    emit({ type: 'stall', project: 'p', run: 'r1' }, { maxBytes: 10 });
    assert.equal(existsSync(`${eventsFile()}.1`), false, 'inny proces rotuje: bez drugiego przeniesienia');
    assert.equal(readEvents().length, 2);
    const t = new Date(Date.now() - 60e3);
    utimesSync(`${eventsFile()}.lock`, t, t);
    emit({ type: 'stall', project: 'p', run: 'r1' }, { maxBytes: 10 });
    emit({ type: 'stall', project: 'p', run: 'r1' }, { maxBytes: 10 });
    assert.equal(existsSync(`${eventsFile()}.1`), true, 'martwa blokada usunięta, rotacja');
  } finally { if (prev === undefined) delete process.env.DWMT_HOME; else process.env.DWMT_HOME = prev; }

  const tr = mkdtempSync(join(tmpdir(), 'dwmt-trc-'));
  const { d } = repo28();
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: 'sess-c', DWMT_HOME, DWMT_TRANSCRIPTS: tr };
  const c = (...a) => JSON.parse(spawnSync(process.execPath, [SCRIPT, ...a], { cwd: d, encoding: 'utf8', env }).stdout);
  const run = c('preflight', '--slug', 'cost').run;
  assert.equal(c('init', '--run', run, '--mode', 'single').ok, true);
  asRules(d, run, '2.10'); // K4 (D-14): fikstury planów zadań w kształcie sprzed 2.11
  writeFileSync(runFile(d, run, 'task.md'), 'Discount.\n');
  writePlans(d, run);
  assert.equal(c('state', run).next, 'implement');
  writeFileSync(join(d, 'src', 'billing', 'discount.ts'), 'export class Discount {}\n');
  writeFileSync(runFile(d, run, 'result-1.md', 1), header({ schema: 'dwmt/result@1', status: 'DONE' }));
  c('verify', run);
  c('review-input', run);
  writeFileSync(runFile(d, run, 'review-1.md', 1), review(1));
  mkdirSync(join(tr, 'proj'), { recursive: true });
  const before = { type: 'assistant', requestId: 'r0', timestamp: '2000-01-01T00:00:00.000Z', message: { usage: { input_tokens: 9e6, output_tokens: 0 } } };
  const during = { type: 'assistant', requestId: 'r1', timestamp: new Date().toISOString(), message: { usage: { input_tokens: 1e6, output_tokens: 0 } } };
  writeFileSync(join(tr, 'proj', 'sess-c.jsonl'), `${JSON.stringify(before)}\n${JSON.stringify(during)}\n`);
  assert.equal(c('commit', run).ok, true);
  const end = withHome(() => readEvents({ run })).find((e) => e.type === 'task-end');
  assert.equal(end.costM, 1, 'koszt od startu zadania (bez planowania wcześniej w sesji)');
});
