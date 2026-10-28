import './tmp-root.mjs';
// K4 T-5 (D-3, D-10, D-29, D-30, D-31): driver agents as Claude background sessions (`claude --bg`), visible in
// `claude agents`. The fake `claude` (fixtures-k4bg-claude.mjs) answers `--bg`, `agents --json`, `stop`, `rm` and `-p`.
import { DWMT_HOME, runFile } from './helpers.mjs';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../scripts/dwmt.mjs';
import { bgName, bgArgs, startBg, waitBg, closeBg, readTurn, sessionVerdict } from '../scripts/lib/bg-agent.mjs';
import { RUN, repo28, start, writePlans } from './fixtures28.mjs';
import { Driver } from '../scripts/drive.mjs';

// D-29: this file tests the background default; the helpers' seam keeps it hidden for the other driver tests.
delete process.env.DWMT_AGENT_SESSIONS;
const DRIVE = fileURLToPath(new URL('../scripts/drive.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures-k4bg-claude.mjs', import.meta.url));
const CLAUDE_HOME = mkdtempSync(join(tmpdir(), 'dwmt-ch-'));
writeFileSync(join(CLAUDE_HOME, 'settings.json'), JSON.stringify({ enabledPlugins: { 'other@market': true } }));

function fakeEnv(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dwmt-bg-'));
  const env = { ...process.env, DWMT_CLAUDE: FAKE, FAKE_LOG: join(dir, 'calls.jsonl'), FAKE_STATE: join(dir, 'state.json'), DWMT_TRANSCRIPTS: join(dir, 'tr'), DWMT_HOME, DWMT_DRIVE_QUIET: '1', DWMT_CLAUDE_HOME: CLAUDE_HOME, DWMT_BG_POLL_MS: '30', ...extra };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.DWMT_AGENT_SESSIONS;
  const calls = () => (existsSync(env.FAKE_LOG) ? readFileSync(env.FAKE_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { env, calls, dir };
}

function setup(slug, { cfg = {}, env: extra = {} } = {}) {
  const { d } = repo28({ language: 'pl', ...cfg });
  const run = start(d, slug);
  writePlans(d, run, {});
  const f = fakeEnv(extra);
  const root = join(d, '.dwmt', 'runs', run);
  // Async: the sprint cases run concurrently (each is a whole driver run of about 50 s).
  const drive = () => new Promise((done) => {
    const p = spawn(process.execPath, [DRIVE, run], { cwd: d, env: f.env, windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (x) => { out += x; });
    p.stderr.on('data', (x) => { err += x; });
    p.on('close', (code) => done({ code, out: JSON.parse(out.trim().split(/\r?\n/).pop()), err }));
  });
  const driveLog = () => readFileSync(join(root, 'drive.log'), 'utf8');
  return { d, run, root, drive, driveLog, ...f };
}
const events = (run) => (existsSync(join(DWMT_HOME, 'events.jsonl')) ? readFileSync(join(DWMT_HOME, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.run === run) : []);
// R-2: every started session is stopped and removed.
function closedAll(cs) {
  const ids = cs.filter((c) => c.cmd === 'bg').map((c) => c.id);
  for (const id of ids) {
    assert.ok(cs.some((c) => c.cmd === 'stop' && c.id === id), `stop ${id}`);
    assert.ok(cs.some((c) => c.cmd === 'rm' && c.id === id), `rm ${id}`);
  }
  return ids;
}

test('k4-bg: drive.agentSessions domyślnie background; DWMT_AGENT_SESSIONS zastępuje domyślne, ustawienie projektu wygrywa', () => {
  const { d } = repo28();
  const saved = process.env.DWMT_AGENT_SESSIONS;
  try {
    delete process.env.DWMT_AGENT_SESSIONS;
    assert.equal(loadConfig(d).drive.agentSessions, 'background');
    process.env.DWMT_AGENT_SESSIONS = 'headless';
    assert.equal(loadConfig(d).drive.agentSessions, 'headless');
    const { d: d2 } = repo28({ drive: { agentSessions: 'background' } });
    assert.equal(loadConfig(d2).drive.agentSessions, 'background');
  } finally { if (saved === undefined) delete process.env.DWMT_AGENT_SESSIONS; else process.env.DWMT_AGENT_SESSIONS = saved; }
});

test('k4-bg: bgName (D-31) i bgArgs (prompt przed opcjami, env w --settings, bez --session-id i --max-turns)', () => {
  const run = { run: '2026-10-23-k5', task: 2, count: 4 };
  assert.equal(bgName({ run, task: 2, round: 1, step: 'implement', agent: 'dwmt-executor', lang: 'pl' }), 'dwmt k5 · T-2 r1 · implement · wykonawca');
  assert.equal(bgName({ run, task: 2, round: 2, step: 'fix', agent: 'dwmt-executor-high', lang: 'pl' }), 'dwmt k5 · T-2 r2 · fix · wykonawca');
  assert.equal(bgName({ run, task: 2, round: 1, step: 'review', agent: 'dwmt-reviewer', lang: 'en' }), 'dwmt k5 · T-2 r1 · review · reviewer');
  // Batch T-5/F-2: the docs-only reviewer (`review.docsOnlyRole: reviewer-high`) is a reviewer in Polish too.
  assert.equal(bgName({ run, task: 2, round: 1, step: 'review', agent: 'dwmt-reviewer-high', lang: 'pl' }), 'dwmt k5 · T-2 r1 · review · recenzent');
  assert.equal(bgName({ run, task: 2, round: 1, step: 'review', agent: 'dwmt-reviewer-high', lang: 'en' }), 'dwmt k5 · T-2 r1 · review · reviewer-high');
  assert.equal(bgName({ run: { ...run, sprint: '2026-10-23-k5' }, task: 3, round: 2, step: 'batch', batch: true, agent: 'dwmt-executor', lang: 'pl' }), 'dwmt k5 · batch r2 · batch · wykonawca');
  assert.equal(bgName({ run, task: 4, step: 'goal-check', agent: 'dwmt-checker', lang: 'pl' }), 'dwmt k5 · — · goal-check · kontrola celu');
  assert.equal(bgName({ run, step: 'finish-repair', agent: 'dwmt-executor-high', lang: 'pl' }), 'dwmt k5 · — · finish-repair · naprawa przy finish');
  assert.equal(bgName({ run, task: 1, step: 'plan', agent: 'dwmt-architect', lang: 'pl' }), 'dwmt k5 · T-1 r1 · plan · architekt');
  assert.equal(bgName({ run, task: 1, step: 'implement', agent: 'dwmt-ui-verifier', lang: 'pl' }), 'dwmt k5 · T-1 r1 · implement · weryfikator UI');
  const a = bgArgs({ name: 'n', prompt: 'Round 1.', agent: 'dwmt-executor', root: 'C:\\x\\dwmt', model: 'opus', effort: 'medium', permissionMode: 'auto', plugins: { 'o@m': false }, env: { DWMT_RUN: 'r1' } });
  assert.deepEqual(a.slice(0, 4), ['--bg', '-n', 'n', 'Round 1.']);
  assert.ok(!a.includes('--session-id') && !a.includes('--max-turns') && !a.includes('-p'));
  assert.deepEqual(a.slice(a.indexOf('--agent'), a.indexOf('--agent') + 2), ['--agent', 'dwmt-executor']);
  const s = JSON.parse(a[a.indexOf('--settings') + 1]);
  assert.deepEqual([s.worktree.bgIsolation, s.env.DWMT_RUN, s.env.CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP, s.enabledPlugins], ['none', 'r1', '1', { 'o@m': false }]);
  assert.equal(a[a.indexOf('--plugin-dir') + 1], 'C:/x/dwmt');
  const r = bgArgs({ name: 'n', prompt: 'x', agent: 'dwmt-architect', resume: 'abc', root: '/r', model: 'opus', effort: 'high' });
  assert.ok(r.includes('--resume') && !r.includes('--agent'));
});

test('k4-bg: R-1 adapter: wynik to ostatni tekst agenta z transkryptu, sesja z claude agents, close = stop + rm', async () => {
  const { env, calls } = fakeEnv();
  const s = startBg(bgArgs({ name: 'dwmt t · T-1 r1 · replan · architekt', prompt: 'Replan from T-2.', agent: 'dwmt-architect', root: '/r', model: 'opus', effort: 'high' }), { cwd: process.cwd(), env });
  assert.deepEqual(s, { ok: true, id: 'bg-1' });
  let seen = null;
  const r = await waitBg(s.id, { cwd: process.cwd(), env, since: new Date(Date.now() - 1000).toISOString(), maxTurns: 10, timeoutMin: 1, pollMs: 20, onSession: (x) => { seen = x; } });
  assert.deepEqual([r.ok, r.cause, r.sessionId, r.costUsd, r.code], [true, null, 'bg-1-0000-sess', null, 0]);
  assert.match(r.result, /REPLAN: unchanged T-2; cause: discovery/);
  assert.equal(seen, 'bg-1-0000-sess');
  assert.deepEqual(await closeBg(s.id, { cwd: process.cwd(), env }), { stopped: true, removed: true });
  assert.deepEqual(calls().filter((c) => c.cmd !== 'bg').map((c) => c.cmd), ['stop', 'rm']);
  // R-3: start failure is a result, not an exception.
  const f = startBg(['--bg', '-n', 'x', 'y'], { cwd: process.cwd(), env: { ...env, FAKE_BG_FAIL: '1' } });
  assert.equal(f.ok, false);
  assert.match(f.error, /exit 1: Workspace not trusted/);
});

test('k4-bg: R-1 wznowiona sesja (--resume): krok liczy tury i odpowiedź tylko od swojego startu', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'dwmt-rt-')), 's.jsonl');
  const L = (ts, o) => JSON.stringify({ timestamp: ts, ...o });
  const asst = (ts, id, text) => L(ts, { type: 'assistant', requestId: id, message: { content: text ? [{ type: 'text', text }] : [{ type: 'tool_use' }] } });
  const end = (ts) => L(ts, { type: 'system', subtype: 'turn_duration' });
  writeFileSync(f, [asst('2026-10-23T10:00:00Z', 'a', 'OLD ANSWER'), end('2026-10-23T10:00:01Z'), asst('2026-10-23T11:00:00Z', 'b', null), asst('2026-10-23T11:00:01Z', 'b', null)].join('\n'));
  assert.deepEqual(readTurn(f, '2026-10-23T10:30:00Z'), { calls: 1, result: '', ended: false, apiError: null, lastTool: true, limit: false });
  writeFileSync(f, [readFileSync(f, 'utf8'), asst('2026-10-23T11:00:02Z', 'c', 'NEW ANSWER'), end('2026-10-23T11:00:03Z')].join('\n'));
  assert.deepEqual(readTurn(f, '2026-10-23T10:30:00Z'), { calls: 2, result: 'NEW ANSWER', ended: true, apiError: null, lastTool: false, limit: false });
});

test('k4-bg: batch T-5/F-3 an agent whose last allowed call is its final answer is not cut at the turn limit before turn_duration', async () => {
  const { env, calls } = fakeEnv();
  const sid = 's-9';
  writeFileSync(env.FAKE_STATE, JSON.stringify({ n: 9, rows: { 'bg-9': { id: 'bg-9', sessionId: sid, name: 'x', kind: 'background', status: 'idle', polls: 0 } } }));
  const proj = join(env.DWMT_TRANSCRIPTS, 'p');
  mkdirSync(proj, { recursive: true });
  const f = join(proj, `${sid}.jsonl`);
  const L = (o) => JSON.stringify({ timestamp: new Date().toISOString(), ...o });
  writeFileSync(f, `${[L({ type: 'assistant', requestId: 'a', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }), L({ type: 'assistant', requestId: 'b', message: { content: [{ type: 'text', text: 'FINAL ANSWER' }] } })].join('\n')}\n`);
  // The end of the turn is written only after a few polls have seen the limit's call count.
  setTimeout(() => appendFileSync(f, `${L({ type: 'system', subtype: 'turn_duration' })}\n`), 400);
  const r = await waitBg('bg-9', { cwd: process.cwd(), env, since: new Date(Date.now() - 60e3).toISOString(), maxTurns: 2, timeoutMin: 1, pollMs: 20 });
  assert.deepEqual([r.ok, r.cause, r.result], [true, null, 'FINAL ANSWER'], JSON.stringify(r));
  assert.equal(calls().filter((c) => c.cmd === 'stop').length, 0, 'no claude stop for an agent that finished');
});

test('k4-bg: batch T-5/F-5 drive.log cost of a resumed session step counts only this step, not the earlier turns', async () => {
  const { d } = repo28({ language: 'pl' });
  const run = start(d, 'bgc');
  const { env } = fakeEnv();
  const proj = join(env.DWMT_TRANSCRIPTS, 'p');
  mkdirSync(proj, { recursive: true });
  const f = join(proj, 's-arch.jsonl');
  const call = (ts, i) => JSON.stringify({ timestamp: ts, type: 'assistant', requestId: `r-${i}`, message: { id: `m-${i}`, usage: { input_tokens: 100000, output_tokens: 1000 }, content: [{ type: 'text', text: 'x' }] } });
  const old = Date.now() - 3600e3;
  writeFileSync(f, `${[0, 1, 2, 3, 4].map((i) => call(new Date(old + i * 1000).toISOString(), `old-${i}`)).join('\n')}\n`);
  const drv = new Driver(d, run, { env });
  drv.dwmt = () => ({});
  drv.agent = async () => {
    appendFileSync(f, `${[0, 1].map((i) => call(new Date().toISOString(), `new-${i}`)).join('\n')}\n`);
    return { ok: true, code: 0, result: 'done', sessionId: 's-arch', costUsd: null, cause: null, error: null };
  };
  await drv.agentStep('T-1 r1 plan', 'dwmt-architect', 'Answers are in answers.md.', 's-arch', { task: 1, round: 1, step: 'plan' });
  const log = readFileSync(join(d, '.dwmt', 'runs', run, 'drive.log'), 'utf8');
  assert.match(log, /T-1 r1 plan: dwmt-architect ok \(sesja s-arch, 0\.21 mln\)/, log);
});

describe('k4-bg: sprint w tle (sterownik)', { concurrency: true }, () => {
  test('k4-bg: R-1, R-2 sprint w tle do końca: nazwy w claude agents, koszt w mln z transkryptu, każda sesja stop + rm, sesje w run.json', async () => {
    const s = setup('bgs');
    const r = await s.drive();
    assert.equal(r.out.status, 'done', JSON.stringify(r));
    const cs = s.calls();
    const bg = cs.filter((c) => c.cmd === 'bg');
    assert.deepEqual(bg.map((c) => c.agent), ['dwmt-executor', 'dwmt-reviewer', 'dwmt-executor', 'dwmt-reviewer', 'dwmt-executor', 'dwmt-reviewer', 'dwmt-checker']);
    assert.ok(!cs.some((c) => c.cmd === 'p'), 'bez ukrytego -p');
    assert.equal(bg[0].name, 'dwmt bgs · T-1 r1 · implement · wykonawca');
    assert.equal(bg[1].name, 'dwmt bgs · T-1 r1 · review · recenzent');
    assert.equal(bg.at(-1).name, 'dwmt bgs · — · goal-check · kontrola celu');
    assert.ok(bg.every((c) => c.promptAt === 3 && c.sessionIdFlag === null && c.maxTurnsFlag === null), JSON.stringify(bg[0]));
    const set = JSON.parse(bg[0].settings);
    assert.deepEqual([set.worktree.bgIsolation, set.env.DWMT_RUN, set.env.CLAUDE_CODE_PROMPT_CACHE_TTL, set.enabledPlugins], ['none', s.run, '5m', { 'other@market': false }]);
    const ids = closedAll(cs);
    assert.equal(ids.length, 7);
    // D-30: costUsd null; cost of the step in millions from its transcript (100k in + 1k out per call ×2 = 0.21 mln).
    assert.match(s.driveLog(), /T-1 r1 implement: dwmt-executor ok \(sesja bg-1-000, 0\.21 mln\)/);
    assert.match(s.driveLog(), /T-1 r1 implement: dwmt-executor w tle: dwmt bgs · T-1 r1 · implement · wykonawca \(claude attach bg-1\)/);
    const rj = RUN(s.d, s.run);
    assert.ok(ids.every((id) => rj.session_ids.includes(`${id}-0000-sess`)), JSON.stringify(rj.session_ids));
    assert.deepEqual(JSON.parse(readFileSync(join(s.root, 'drive.json'), 'utf8')).children, {});
    assert.ok(existsSync(runFile(s.d, s.run, 'final-report.md')));
  });

  test('k4-bg: R-1 limit tur wykonawcy w tle: sterownik liczy tury, claude stop, cause max-turns → świeży wykonawca (continue)', async () => {
    const s = setup('bgt', { cfg: { roles: { executor: { maxTurns: 3 } } }, env: { FAKE_BG_TURNS_AGENT: 'dwmt-executor', FAKE_BG_TURNS: '5' } });
    const r = await s.drive();
    assert.equal(r.out.status, 'done', JSON.stringify(r));
    const cs = s.calls();
    const i = cs.findIndex((c) => c.cmd === 'stop' && c.id === 'bg-1');
    assert.ok(i > 0 && i < cs.findIndex((c) => c.cmd === 'bg' && c.id === 'bg-2'), 'stop przed następnym agentem');
    assert.match(s.driveLog(), /T-1 r1 implement: dwmt-executor max-turns: limit tur \(3, licznik sterownika\)/);
    assert.match(s.driveLog(), /T-1 r1 implement: dwmt-executor doszedł do limitu 3 tur → świeży wykonawca kontynuuje od progress\.md \(1\/5\)/);
    const second = cs.find((c) => c.cmd === 'bg' && c.id === 'bg-2');
    assert.equal(second.agent, 'dwmt-executor');
    assert.match(second.prompt, /Continue interrupted work/);
    closedAll(cs);
  });

  test('k4-bg: batch T-5/F-9 limit abonamentu w sesji w tle: koniec kroku od razu (bez czekania na limit czasu), stop z resetsAt, stop + rm', async () => {
    const s = setup('bgl', { cfg: { drive: { agentTimeoutMin: 0.5 } }, env: { FAKE_BG_LIMIT_AGENT: 'dwmt-executor' } });
    const r = await s.drive();
    assert.deepEqual([r.out.status, r.out.cause], ['stopped', 'limit'], JSON.stringify(r.out));
    assert.ok(Date.parse(r.out.resetsAt) > Date.now(), JSON.stringify(r.out));
    const log = s.driveLog();
    assert.match(log, /T-1 r1 implement: limit abonamentu do /);
    assert.doesNotMatch(log, /limit czasu agenta/, 'the step ends on the limit, not on drive.agentTimeoutMin');
    // From the background start to the stop: the poll sees the limit at once, far below agentTimeoutMin (30 s).
    const at = (re) => Date.parse(log.split('\n').find((l) => re.test(l))?.split(' ')[0]);
    const ms = at(/T-1 r1 implement: dwmt-executor w tle:/) && at(/STOP stopped: T-1 r1 implement: limit abonamentu/) - at(/T-1 r1 implement: dwmt-executor w tle:/);
    assert.ok(ms >= 0 && ms < 20e3, `${ms} ms\n${log}`);
    const cs = s.calls();
    assert.equal(cs.filter((c) => c.cmd === 'bg').length, 1);
    closedAll(cs);
  });

  test('k4-bg: R-2 limit czasu w tle: stop + rm, cause timeout; R-2 sesje w tle martwego sterownika giną przy następnym starcie', async () => {
    const s = setup('bgh', { cfg: { drive: { agentTimeoutMin: 0.01 } }, env: { FAKE_BG_HANG_AGENT: 'dwmt-executor' } });
    const r = await s.drive();
    assert.deepEqual([r.out.status, r.out.cause], ['stopped', 'timeout'], JSON.stringify(r.out));
    assert.deepEqual(closedAll(s.calls()), ['bg-1']);
    assert.deepEqual(JSON.parse(readFileSync(join(s.root, 'drive.json'), 'utf8')).children, {});

    // A driver killed mid-step leaves a `bg` child in drive.json: the next start stops and removes it before new work.
    const t = setup('bgr');
    const mem = join(t.root, 'drive.json');
    writeFileSync(mem, JSON.stringify({ children: { 'bg:bg-old': { kind: 'bg', id: 'bg-old', agent: 'dwmt-executor', name: 'dwmt bgr · T-1 r1 · implement · wykonawca', start: new Date().toISOString() } } }));
    writeFileSync(t.env.FAKE_STATE, JSON.stringify({ n: 0, rows: { 'bg-old': { id: 'bg-old', sessionId: 'bg-old-s', name: 'old', kind: 'background', status: 'busy', polls: 0, mode: 'hang' } } }));
    const r2 = await t.drive();
    assert.equal(r2.out.status, 'done', JSON.stringify(r2));
    const cs = t.calls();
    assert.deepEqual(cs.slice(0, 2).map((c) => [c.cmd, c.id]), [['stop', 'bg-old'], ['rm', 'bg-old']]);
    assert.match(t.driveLog(), /sesja w tle poprzedniego sterownika zamknięta: bg-old dwmt bgr · T-1 r1 · implement · wykonawca/);
  });

  test('k4-bg: R-3 nieudany start w tle → ten sam agent ukryty (claude -p), krok kończy się, linia w drive.log', async () => {
    const s = setup('bgf', { env: { FAKE_BG_FAIL: '1' } });
    const r = await s.drive();
    assert.equal(r.out.status, 'done', JSON.stringify(r));
    const cs = s.calls();
    assert.deepEqual(cs.filter((c) => c.cmd === 'p').map((c) => c.agent), ['dwmt-executor', 'dwmt-reviewer', 'dwmt-executor', 'dwmt-reviewer', 'dwmt-executor', 'dwmt-reviewer', 'dwmt-checker']);
    assert.equal(cs.filter((c) => c.cmd === 'bg-fail').length, 7);
    const lines = s.driveLog().split('\n').filter((l) => /background start failed/.test(l));
    assert.equal(lines.length, 7);
    assert.match(lines[0], /T-1 r1 implement: background start failed \(exit 1: Workspace not trusted.*\); dwmt-executor runs hidden \(claude -p\)/);
    // Hidden fallback keeps the driver-given session id (cost visible even if the agent dies).
    assert.ok(cs.filter((c) => c.cmd === 'p').every((c) => RUN(s.d, s.run).session_ids.includes(c.sid)));
  });

  test('k4-bg: R-5 drive.agentSessions headless: tylko claude -p, bez claude --bg', async () => {
    const s = setup('bgx', { cfg: { drive: { agentSessions: 'headless' } } });
    const r = await s.drive();
    assert.equal(r.out.status, 'done', JSON.stringify(r));
    const cs = s.calls();
    assert.equal(cs.filter((c) => c.cmd === 'p').length, 7);
    assert.ok(!cs.some((c) => ['bg', 'bg-fail', 'stop', 'rm'].includes(c.cmd)));
  });

  test('k4-bg: R-6 agent w tle czeka na zgodę: jedna linia drive.log i jedno zdarzenie agent-waiting z claude attach', async () => {
    const s = setup('bgw', { env: { FAKE_BG_WAIT_AGENT: 'dwmt-checker' } });
    const r = await s.drive();
    assert.equal(r.out.status, 'done', JSON.stringify(r));
    const id = s.calls().find((c) => c.cmd === 'bg' && c.agent === 'dwmt-checker').id;
    const lines = s.driveLog().split('\n').filter((l) => l.includes(`claude attach ${id}`) && /czeka/.test(l));
    assert.equal(lines.length, 1, s.driveLog());
    assert.match(lines[0], /dwmt-checker czeka na zgodę albo odpowiedź: claude attach bg-7/);
    const ev = events(s.run).filter((e) => e.type === 'agent-waiting');
    assert.equal(ev.length, 1);
    assert.deepEqual([ev[0].detail.attach, ev[0].detail.agent, ev[0].detail.name], [`claude attach ${id}`, 'dwmt-checker', 'dwmt bgw · — · goal-check · kontrola celu']);
  });
});

// K5 D-7: the session verdict shared by the driver and the launch watcher.
test('k4-bg: K5 sessionVerdict: idle without calls past firstStepMin is no-start; busy or waiting never; API error not busy is error', () => {
  assert.equal(sessionVerdict({ turn: null, row: { status: 'idle' }, elapsedMin: 0.03, firstStepMin: 0.02 }), 'no-start');
  assert.equal(sessionVerdict({ turn: { calls: 0 }, row: { status: 'idle' }, elapsedMin: 0.01, firstStepMin: 0.02 }), 'working');
  // R-1: a busy session thinking before its first line is never a failed start.
  assert.equal(sessionVerdict({ turn: null, row: { status: 'busy' }, elapsedMin: 99, firstStepMin: 0.02 }), 'working');
  assert.equal(sessionVerdict({ turn: null, row: { status: 'waiting' }, elapsedMin: 99, firstStepMin: 0.02 }), 'working');
  assert.equal(sessionVerdict({ turn: { calls: 2, apiError: 'unknown', limit: false }, row: { status: 'idle' } }), 'error');
  assert.equal(sessionVerdict({ turn: { calls: 2, apiError: 'unknown', limit: false }, row: { status: 'busy' } }), 'working');
  // R-2: the subscription limit is never an error to relaunch.
  assert.equal(sessionVerdict({ turn: { calls: 2, apiError: 'rate_limit', limit: true }, row: { status: 'idle' } }), 'working');
  assert.equal(sessionVerdict({ turn: { calls: 1, ended: false }, row: null, gone: true }), 'dead');
});

test('k4-bg: K5 R-1 a busy session with no line past firstStepMin is not failed as no-start (only the time limit ends it)', async () => {
  const { env, calls } = fakeEnv();
  writeFileSync(env.FAKE_STATE, JSON.stringify({ n: 3, rows: { 'bg-3': { id: 'bg-3', sessionId: 's-3', name: 'x', kind: 'background', status: 'busy', polls: 0 } } }));
  const r = await waitBg('bg-3', { cwd: process.cwd(), env, firstStepMin: 0.002, timeoutMin: 0.01, pollMs: 20 });
  assert.equal(r.cause, 'timeout', JSON.stringify(r));
  assert.equal(calls().filter((c) => c.cmd === 'stop').length, 1);
});

describe('k4-bg: K5 relaunch of a failed background step (driver)', { concurrency: true }, () => {
  test('k4-bg: K5 R-2 an API error ends the step at once and the step starts exactly once more; the sprint ends done', async () => {
    const s = setup('bga', { cfg: { drive: { relaunchDelaySec: 0 } }, env: { FAKE_BG_APIERR_AGENT: 'dwmt-executor' } });
    const r = await s.drive();
    assert.equal(r.out.status, 'done', JSON.stringify(r.out));
    const bg = s.calls().filter((c) => c.cmd === 'bg');
    assert.deepEqual(bg.slice(0, 2).map((c) => [c.agent, c.name]), [['dwmt-executor', 'dwmt bga · T-1 r1 · implement · wykonawca'], ['dwmt-executor', 'dwmt bga · T-1 r1 · implement · wykonawca']]);
    assert.equal(bg.filter((c) => c.agent === 'dwmt-executor').length, 4, 'three tasks plus one relaunch');
    assert.match(s.driveLog(), /T-1 r1 implement: dwmt-executor error: unknown: API Error: 529 Overloaded → ponowny start za 0 s \(jeden raz\)/);
    const ev = events(s.run).filter((e) => e.type === 'agent-relaunch');
    assert.deepEqual(ev.map((e) => [e.detail.label, e.detail.agent, e.detail.cause]), [['T-1 r1 implement', 'dwmt-executor', 'error']]);
    closedAll(s.calls());
  });

  test('k4-bg: K5 a session without a first step twice stops the run (no-start) with one desktop notification', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dwmt-pl-'));
    const plog = join(dir, 'platform.jsonl');
    const s = setup('bgn', { cfg: { drive: { relaunchDelaySec: 0, firstStepMin: 0.005 } }, env: { FAKE_BG_SILENT_AGENT: 'dwmt-executor', DWMT_PLATFORM_LOG: plog } });
    const r = await s.drive();
    assert.deepEqual([r.out.status, r.out.cause, r.out.notified], ['stopped', 'no-start', true], JSON.stringify(r.out));
    assert.equal(s.calls().filter((c) => c.cmd === 'bg').length, 2);
    const notes = readFileSync(plog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.fn === 'notify');
    assert.equal(notes.length, 1);
    assert.match(notes[0].text, new RegExp(`no-start — /dwmt:execute ${s.run}`));
    const stop = JSON.parse(readFileSync(join(s.root, 'drive.json'), 'utf8')).stopped;
    assert.deepEqual([stop.cause, stop.notified], ['no-start', true]);
    assert.match(stop.reason, /agent dwmt-executor nie zaczął pracy/);
    assert.equal(events(s.run).filter((e) => e.type === 'drive-stop').at(-1).detail.notified, true);
    closedAll(s.calls());
  });

  test('k4-bg: batch F-4 a supervised driver leaves the notification of a session-failure stop to the supervisor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dwmt-pl-'));
    const plog = join(dir, 'platform.jsonl');
    const s = setup('bgq', { cfg: { drive: { relaunchDelaySec: 0, firstStepMin: 0.005 } }, env: { FAKE_BG_SILENT_AGENT: 'dwmt-executor', DWMT_PLATFORM_LOG: plog, DWMT_SUPERVISED: '1' } });
    const r = await s.drive();
    assert.deepEqual([r.out.status, r.out.cause, r.out.notified], ['stopped', 'no-start', undefined], JSON.stringify(r.out));
    const notes = existsSync(plog) ? readFileSync(plog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.fn === 'notify') : [];
    assert.equal(notes.length, 0, 'no direct toast: the supervisor queues it in quiet hours or resumes the item');
    assert.equal(JSON.parse(readFileSync(join(s.root, 'drive.json'), 'utf8')).stopped.notified, undefined);
    closedAll(s.calls());
  });
});
