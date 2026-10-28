import './tmp-root.mjs';
// dwmt v3 (N-2: na masterze, włączany `drive.enabled`): sterownik `drive.mjs` zamiast orkiestratora LLM. Fałszywy
// `claude -p` (DWMT_CLAUDE) gra agentów: wykonawca pisze kod i wynik, recenzent PASS, kontrola celu, architekt odpowiada
// na replan; na życzenie ginie bez wyniku, milczy (bez pliku wyjścia), zwraca błąd limitu albo śpi. Fikstury z fixtures28.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdtempSync, mkdirSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { agentArgs, parseReplan, roleOf, agentOutcome } from '../scripts/drive.mjs';
import { DEFAULTS } from '../scripts/dwmt.mjs';
import { assess, writeDriveLock, readDriveMem, waitDriver, markActive, killTree } from '../scripts/watch.mjs';
import { emit, readEventsFrom, eventsFile } from '../scripts/events.mjs';
import { DWMT_HOME, runFile, gitIn, SCRIPT } from './helpers.mjs';
import { NO_TRANSCRIPTS, RUN, PLAN, T1, T2, T3, repo28, start, writePlans, cliAs } from './fixtures28.mjs';

const DRIVE = fileURLToPath(new URL('../scripts/drive.mjs', import.meta.url));

// Fałszywy `claude`: rola z `--agent` (przy `--resume` architekt), ścieżki z promptu; log wywołań w JSONL.
const FAKE = `import { writeFileSync, readFileSync, appendFileSync, mkdirSync, existsSync, fstatSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
const a = process.argv.slice(2);
const val = (f) => (a.includes(f) ? a[a.indexOf(f) + 1] : null);
const prompt = val('-p');
const agent = val('--agent') ?? (val('--resume') ? 'dwmt-architect' : '?');
const log = process.env.FAKE_LOG;
const prev = existsSync(log) ? readFileSync(log, 'utf8').split('\\n').filter(Boolean) : [];
const n = prev.length + 1;
// Recenzja N-2: identyfikator sesji od sterownika, wtyczki (--settings), stdin (zamknięty = urządzenie znakowe).
const sid = val('--session-id');
appendFileSync(log, JSON.stringify({ agent, model: val('--model'), effort: val('--effort'), resume: val('--resume'), sid, settings: val('--settings'), stdin: fstatSync(0).isCharacterDevice() ? 'null' : 'pipe', pm: val('--permission-mode'), strict: a.includes('--strict-mcp-config'), badHeader: /does not parse/.test(prompt), prompt: prompt.slice(0, 120) }) + '\\n');
const session = sid ?? val('--resume') ?? 'fake-' + n + '-0000';
// Architekt: kopia FAKE_ARCH_DIR/<i>/ (i = numer jego wywołania) do katalogu repo.
if (agent === 'dwmt-architect' && process.env.FAKE_ARCH_DIR) {
  const i = prev.filter((l) => JSON.parse(l).agent === 'dwmt-architect').length + 1;
  if (existsSync(join(process.env.FAKE_ARCH_DIR, String(i)))) cpSync(join(process.env.FAKE_ARCH_DIR, String(i)), '.', { recursive: true });
}
const path = (label) => { const m = new RegExp(label + ': ([^ ]+?)\\\\.( |$)').exec(prompt); return m ? m[1] : null; };
const role = (v) => !!v && agent.startsWith(v);
const put = (f, text) => { if (role(process.env.FAKE_SILENT_AGENT)) return; mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); };
const head = (o) => '---\\n' + Object.entries(o).map(([k, v]) => k + ': ' + JSON.stringify(v)).join('\\n') + '\\n---\\n';
const k = Number(/tasks\\/(\\d+)\\//.exec(prompt)?.[1] ?? 0);
const notes = JSON.parse(process.env.FAKE_NOTES || '{}');
let result = 'done';
// N-2: śmierć dziecka (proces kończy się bez wyniku), błąd z limitem, długi agent (sterownik zabity w trakcie).
if (role(process.env.FAKE_SLEEP_AGENT)) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_SLEEP_MS || 60000)));
if (role(process.env.FAKE_LIMIT_OK_AGENT)) { console.log(JSON.stringify({ type: 'result', is_error: false, result: 'Claude usage limit reached', session_id: 'lim-0000' })); process.exit(0); }
if (role(process.env.FAKE_DIE_AGENT)) process.kill(process.pid, 'SIGKILL');
if (role(process.env.FAKE_ERROR_AGENT)) { console.log(JSON.stringify({ type: 'result', is_error: true, result: 'Claude usage limit reached', session_id: 'lim-0000' })); process.exit(1); }
if (agent.startsWith('dwmt-executor')) {
  const code = { 1: ['src/billing/discount.ts', 'export class Discount {}\\n'], 2: ['src/summary/view.ts', 'export const view = () => "-10%";\\n'], 3: ['src/export/csv.ts', 'export const csv = () => "10";\\n'] }[k];
  put(code[0], code[1]);
  const fixRound = /Result: [^ ]*result-2\\.md/.test(prompt);
  put(path('Result'), head({ schema: 'dwmt/result@1', status: 'DONE', laterNotes: notes[k] ?? [], ...(fixRound ? { fixed: [{ id: 'F-1', redTest: 'view shows -10%' }] } : {}) }));
  // Przegląd pm-5: nagłówek wyniku, który się nie parsuje, za każdym razem. Od K3 D-8 nieznana sekwencja (\\s) zostaje
  // dosłownie i się parsuje; nie parsuje się niezaescapowany cudzysłów w środku napisu.
  if (role(process.env.FAKE_BAD_HEADER_AGENT)) put(path('Result'), '---\\nschema: dwmt/result@1\\nstatus: DONE\\nassumptions: ["A-1 split on "words" with spaces"]\\n---\\n');
} else if (agent === 'dwmt-reviewer') {
  const round = Number(/review-(\\d+)\\.md/.exec(path('Output'))?.[1] ?? 1);
  const fixIt = String(process.env.FAKE_FIX_TASK) === String(k) && round === 1;
  const body = fixIt ? '### F-1 [blocker] The summary shows the raw fraction\\n- Evidence: \`src/summary/view.ts:1\`\\n- Impact: wrong value shown\\n- Test: 0.1 → "-10%"\\n\\n' : '';
  const recheck = /recheck/.test(readFileSync(path('Input'), 'utf8'));
  put(path('Output'), head({ schema: 'dwmt/review@1', round, passes: recheck ? ['recheck'] : ['correctness'], verdict: fixIt ? 'FIX' : 'PASS', fix: fixIt ? ['F-1'] : [], defer: [], drop: [], acceptance: ['AC-' + k + ' met'], risks: ['R-1 proven'], ...(recheck ? { resolved: ['F-1'] } : {}) }) + body);
} else if (agent === 'dwmt-checker') {
  put(path('Output'), '---\\nschema: dwmt/goal-check@1\\nitems:\\n  - {id: I-1, element: "discount", status: delivered, task: T-1, evidence: "T-1/report.md"}\\ngaps: 0\\n---\\n');
} else if (agent === 'dwmt-architect') {
  result = 'Plans checked.\\nREPLAN: unchanged T-2; cause: discovery';
}
console.log(JSON.stringify({ type: 'result', is_error: false, result, session_id: session, total_cost_usd: 0.01 }));
`;

// Ustawienia użytkownika testów (`launch.lean`): włączona obca wtyczka i dwmt.
const CLAUDE_HOME = mkdtempSync(join(tmpdir(), 'dwmt-ch-'));
writeFileSync(join(CLAUDE_HOME, 'settings.json'), JSON.stringify({ enabledPlugins: { 'other@market': true, 'dwmt@local': true } }));

// `plans: null`: bez planów (planuje architekt).
function setup(slug, notes = {}, extraEnv = {}, { cfg = {}, files = {}, plans = () => ({}) } = {}) {
  const { d } = repo28(cfg, files);
  const run = start(d, slug);
  if (plans) writePlans(d, run, plans(run));
  const dir = mkdtempSync(join(tmpdir(), 'dwmt-drv-'));
  const fake = join(dir, 'claude.mjs');
  writeFileSync(fake, FAKE);
  const log = join(dir, 'calls.jsonl');
  const env = { ...process.env, DWMT_CLAUDE: fake, FAKE_LOG: log, FAKE_NOTES: JSON.stringify(notes), DWMT_HOME, DWMT_TRANSCRIPTS: NO_TRANSCRIPTS, DWMT_DRIVE_QUIET: '1', DWMT_CLAUDE_HOME: CLAUDE_HOME, ...extraEnv };
  delete env.CLAUDE_CODE_SESSION_ID;
  const drive = () => {
    const r = spawnSync(process.execPath, [DRIVE, run], { cwd: d, encoding: 'utf8', env });
    return { code: r.status, out: JSON.parse(r.stdout.trim().split(/\r?\n/).pop()), err: r.stderr };
  };
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  // N-2: `dwmt wait` (jedna linia JSON) i `drive.mjs --detach` z tym samym środowiskiem.
  const wait = () => {
    const r = spawnSync(process.execPath, [SCRIPT, 'wait', run, '--interval', '0.1'], { cwd: d, encoding: 'utf8', env });
    return { code: r.status, lines: r.stdout.trim().split(/\r?\n/).filter(Boolean), err: r.stderr };
  };
  const detach = () => JSON.parse(spawnSync(process.execPath, [DRIVE, run, '--detach'], { cwd: d, encoding: 'utf8', env }).stdout.trim().split(/\r?\n/).pop());
  return { d, run, drive, calls, wait, detach, env, root: join(d, '.dwmt', 'runs', run) };
}

// Zdarzenia przebiegu z dziennika testów (DWMT_HOME).
const runEvents = (run) => (existsSync(join(DWMT_HOME, 'events.jsonl')) ? readFileSync(join(DWMT_HOME, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.run === run) : []);
const lastStop = (run) => runEvents(run).filter((e) => e.type === 'drive-stop').at(-1);

test('drive: argumenty agenta (model i effort roli, plugin, bez MCP, resume), linia REPLAN', () => {
  const cfg = { model: 'opus', roles: { executor: { effort: 'medium' }, 'executor-high': { from: 'executor', effort: 'high' }, explorer: { model: 'opus', effort: 'medium' } }, launch: { permissionMode: 'auto' } };
  // Przegląd 2026-10-09 (W-1): limit tur roli (jak frontmatter: domyślnie 100) idzie flagą `--max-turns`.
  assert.deepEqual(roleOf(cfg, 'dwmt-executor-high'), { model: 'opus', effort: 'high', maxTurns: 100 });
  const mt = agentArgs({ cfg: { ...cfg, roles: { ...cfg.roles, reviewer: { effort: 'xhigh', maxTurns: 200 } } }, agent: 'dwmt-reviewer', prompt: 'x' });
  assert.deepEqual(mt.slice(mt.indexOf('--max-turns'), mt.indexOf('--max-turns') + 2), ['--max-turns', '200']);
  const a = agentArgs({ cfg, agent: 'dwmt-executor', prompt: 'Round 1.' });
  assert.deepEqual(a.slice(0, 4), ['-p', 'Round 1.', '--output-format', 'json']);
  assert.ok(a.includes('--strict-mcp-config') && a.includes('--plugin-dir'));
  assert.deepEqual(a.slice(a.indexOf('--agent'), a.indexOf('--agent') + 2), ['--agent', 'dwmt-executor']);
  assert.deepEqual(a.slice(-4), ['--model', 'opus', '--effort', 'medium']);
  const r = agentArgs({ cfg, agent: 'dwmt-architect', prompt: 'x', resume: 'abc', sessionId: 'u-1' });
  assert.ok(r.includes('--resume') && !r.includes('--agent') && !r.includes('--session-id'));
  // Recenzja N-2: świeży agent z nadaną sesją; wtyczki wyłączone jak w `launch` (launch.lean).
  const f = agentArgs({ cfg, agent: 'dwmt-executor', prompt: 'x', sessionId: 'u-1', plugins: { 'other@m': false } });
  assert.deepEqual(f.slice(f.indexOf('--session-id'), f.indexOf('--session-id') + 2), ['--session-id', 'u-1']);
  assert.deepEqual(JSON.parse(f[f.indexOf('--settings') + 1]), { enabledPlugins: { 'other@m': false } });
  assert.ok(!agentArgs({ cfg, agent: 'dwmt-executor', prompt: 'x' }).includes('--settings'));
  assert.deepEqual(parseReplan('ok\nREPLAN: changed T-2, T-3; cause: plan'), { result: 'changed', cause: 'plan' });
  assert.equal(parseReplan('no line'), null);
});

test('drive: sprint 3 zadań od planu do squasha bez orkiestratora LLM (verify, review-input, commit, kontrola celu, finish)', () => {
  const { d, run, drive, calls, wait, root } = setup('drv');
  const r = drive();
  assert.equal(r.code, 0, JSON.stringify(r));
  assert.equal(r.out.status, 'done');
  const cs = calls();
  assert.deepEqual(cs.map((c) => c.agent), ['dwmt-executor', 'dwmt-reviewer', 'dwmt-executor', 'dwmt-reviewer', 'dwmt-executor', 'dwmt-reviewer', 'dwmt-checker']);
  const ex = cs.find((c) => c.agent === 'dwmt-executor');
  assert.deepEqual([ex.model, ex.effort, ex.pm, ex.strict], ['opus', 'medium', 'auto', true]);
  assert.equal(cs.find((c) => c.agent === 'dwmt-reviewer').effort, 'xhigh');
  // Recenzja N-2: stdin zamknięty (bez 3 s czekania), wtyczki inne niż dwmt wyłączone (`launch.lean`), sesja nadana.
  assert.ok(cs.every((c) => c.stdin === 'null'), JSON.stringify(cs.map((c) => c.stdin)));
  assert.deepEqual(JSON.parse(ex.settings), { enabledPlugins: { 'other@market': false } });
  assert.match(ex.sid, /^[0-9a-f-]{36}$/);
  const rj = RUN(d, run);
  assert.equal(new Set(cs.map((c) => c.sid)).size, 7);
  assert.ok(cs.every((c) => rj.session_ids.includes(c.sid)), 'sesje agentów w run.json');
  assert.ok(existsSync(runFile(d, run, 'final-report.md')));
  assert.match(gitIn(d)('log', '--oneline', '-1', 'master'), /Discount on the invoice/);
  assert.match(readFileSync(join(d, '.dwmt', 'runs', run, 'drive.log'), 'utf8'), /STOP done/);
  // N-2: dziennik zdarzeń v2.10 (drive-start z pid, drive-stop ze statusem i kosztem), drive.json, blokada zdjęta.
  const evs = runEvents(run);
  assert.equal(evs[0].type, 'drive-start');
  assert.ok(Number.isInteger(evs[0].detail.pid));
  assert.equal(evs.filter((e) => e.type === 'task-start').length, 3);
  assert.deepEqual([evs.at(-1).type, evs.at(-1).detail.status], ['drive-stop', 'done']);
  assert.ok(evs.at(-1).detail.costUsdTotal > 0);
  assert.equal(evs.at(-1).detail.finish, undefined, 'wynik finish tylko w drive.json');
  const mem = readDriveMem(root);
  assert.equal(mem.stopped.status, 'done');
  assert.deepEqual(mem.children, {});
  assert.ok(!existsSync(join(root, 'drive.lock')));
  // `wait` po końcu sterownika: od razu jedna linia z jego statusem.
  const w = wait();
  assert.equal(w.lines.length, 1, JSON.stringify(w));
  const wl = JSON.parse(w.lines[0]);
  assert.equal(wl.status, 'done');
  // Recenzja N-2: wynik `finish` w linii (sesja nie powtarza `finish`; `cleanup`, `report` do kroku `done`).
  assert.equal(wl.finish?.status, 'squashed', JSON.stringify(wl));
  assert.ok(wl.finish.cleanup && wl.finish.report, JSON.stringify(wl.finish));
});

test('drive: uwaga [plan] → replan świeżym architektem i replan-done z linii REPLAN; pytania otwarte zatrzymują (exit 10)', () => {
  const note = '[plan] `src/summary/view.ts#view`: the discount is a fraction, the plan assumed percent';
  const { d, run, drive, calls } = setup('drr', { 1: [note] });
  const r = drive();
  assert.equal(r.out.status, 'done', JSON.stringify(r));
  const cs = calls();
  const arch = cs.filter((c) => c.agent === 'dwmt-architect');
  assert.equal(arch.length, 1);
  assert.equal(arch[0].resume, null, 'replan przed T-2: świeży architekt');
  assert.match(arch[0].prompt, /^Replan from T-2\./);
  assert.deepEqual(RUN(d, run).tasks[1].drift.map((x) => x.result), ['unchanged']);

  // Plan z otwartym pytaniem: sterownik nie zgaduje, zatrzymuje się dla użytkownika.
  const { d: d2, run: run2, drive: drive2 } = setup('drq');
  const f = runFile(d2, run2, 'plan.md');
  writeFileSync(f, readFileSync(f, 'utf8').replace('questions: []', 'questions: ["Q-1"]').replace('## Tasks', '### Q-1 Discount cap\n- Why I ask: money\n- Options: A; B\n\n## Tasks'));
  const r2 = drive2();
  assert.equal(r2.code, 10, JSON.stringify(r2));
  assert.deepEqual([r2.out.status], ['waiting-user']);
  assert.match(r2.out.reason, /ask-plan/);
});

test('drive: blocker w recenzji T-2 → fixer dwmt-executor-high (effort high) → verify → recheck PASS → dalej do końca', () => {
  const { d, run, drive, calls } = setup('drf', {}, { FAKE_FIX_TASK: '2' });
  const r = drive();
  assert.equal(r.out.status, 'done', JSON.stringify(r));
  const cs = calls();
  assert.deepEqual(cs.map((c) => c.agent), ['dwmt-executor', 'dwmt-reviewer', 'dwmt-executor', 'dwmt-reviewer', 'dwmt-executor-high', 'dwmt-reviewer', 'dwmt-executor', 'dwmt-reviewer', 'dwmt-checker']);
  assert.equal(cs[4].effort, 'high');
  assert.match(cs[4].prompt, /^Round 2\./);
  assert.equal(RUN(d, run).tasks[1].commit?.length > 0, true);
});

test('drive: drugi sterownik na tym samym przebiegu nie rusza (blokada z pid)', () => {
  const { d, run, drive } = setup('drl');
  writeFileSync(join(d, '.dwmt', 'runs', run, 'drive.lock'), String(process.pid));
  const r = drive();
  assert.equal(r.out.status, 'stopped');
  assert.match(r.out.reason, /sterownik już działa/);
});

// ---------- N-2: przełącznik, śmierć dziecka, `wait`, `drive.hold` ----------

test('N-2: drive.enabled domyślnie true (K4); pod szwem DWMT_DRIVE_DEFAULT=off state bez `drive` (ścieżka v2.10); true → `drive: true`', () => {
  assert.equal(DEFAULTS.drive.enabled, true);
  assert.equal(process.env.DWMT_DRIVE_DEFAULT, 'off');
  const { d } = repo28();
  const run = start(d, 'dof');
  writePlans(d, run);
  const st = cliAs(d, 'sess-1', 'state', run).json;
  assert.equal(st.next, 'implement');
  assert.equal('drive' in st, false);
  const { d: d2 } = repo28({ drive: { enabled: true } });
  const run2 = start(d2, 'don');
  writePlans(d2, run2);
  assert.equal(cliAs(d2, 'sess-1', 'state', run2).json.drive, true);
  // Tryb inline (model pisze kod sam) zostaje bez sterownika także przy drive.enabled.
  const run3 = start(d2, 'din', '--mode', 'inline');
  const st3 = cliAs(d2, 'sess-1', 'state', run3).json;
  assert.equal(st3.mode, 'inline', JSON.stringify(st3));
  assert.equal('drive' in st3, false);
});

test('N-2: agentOutcome: koniec bez JSON = śmierć, is_error = błąd, limit czasu, brak claude', () => {
  assert.equal(agentOutcome({ code: 0, out: '{"result":"ok","session_id":"s1","is_error":false}' }).ok, true);
  const dead = agentOutcome({ code: null, signal: 'SIGKILL', out: '' });
  assert.deepEqual([dead.ok, dead.cause], [false, 'dead']);
  assert.match(dead.error, /bez wyniku.*SIGKILL/);
  assert.equal(agentOutcome({ code: 1, out: 'partial text' }).cause, 'dead');
  assert.equal(agentOutcome({ code: 1, out: '{"is_error":true,"result":"limit"}' }).cause, 'error');
  assert.equal(agentOutcome({ code: null, timedOut: true, timeoutMin: 5 }).cause, 'timeout');
  assert.equal(agentOutcome({ spawnError: 'ENOENT' }).cause, 'spawn');
});

test('N-2: agent ginie bez wyniku (prawdziwy proces zabity) → stop z przyczyną child-dead, zdarzenie, bez ponowienia', () => {
  const s0 = setup('dda', {}, { FAKE_DIE_AGENT: 'dwmt-executor' });
  const { run, drive, calls, root } = s0;
  const r = drive();
  assert.equal(r.code, 1, JSON.stringify(r));
  assert.deepEqual([r.out.status, r.out.cause, r.out.child?.name], ['stopped', 'child-dead', 'dwmt-executor']);
  assert.match(r.out.reason, /T-1 r1 implement: agent dwmt-executor zakończył się bez wyniku/);
  assert.equal(calls().length, 1, 'bez ponowienia');
  // Recenzja N-2: sesja agenta zapisana w przebiegu przed startem (koszt i przyrost także po śmierci bez wyniku).
  assert.ok(calls()[0].sid && RUN(s0.d, run).session_ids.includes(calls()[0].sid), JSON.stringify(calls()[0]));
  const ev = lastStop(run);
  assert.deepEqual([ev.detail.status, ev.detail.cause], ['stopped', 'child-dead']);
  assert.deepEqual(readDriveMem(root).children, {});
  assert.ok(!existsSync(join(root, 'drive.lock')));
});

test('N-2: agent kończy pracę bez pliku wyjścia → stop no-output; błąd z limitem w transkrypcie → stop limit z resetsAt', () => {
  const s = setup('dno', {}, { FAKE_SILENT_AGENT: 'dwmt-reviewer' });
  const r = s.drive();
  assert.deepEqual([r.out.status, r.out.cause], ['stopped', 'no-output'], JSON.stringify(r));
  assert.match(r.out.reason, /dwmt-reviewer zakończył się bez zapisania wyniku/);
  assert.deepEqual(s.calls().map((c) => c.agent), ['dwmt-executor', 'dwmt-reviewer']);

  const tr = mkdtempSync(join(tmpdir(), 'dwmt-tr-lim-'));
  mkdirSync(join(tr, 'proj'));
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  writeFileSync(join(tr, 'proj', 'lim-0000.jsonl'), `${JSON.stringify({ type: 'assistant', error: 'rate_limit', quotaLimits: { resetsAt, rateLimitType: 'five_hour' } })}\n`);
  const l = setup('dli', {}, { FAKE_ERROR_AGENT: 'dwmt-executor', DWMT_TRANSCRIPTS: tr });
  const r2 = l.drive();
  assert.deepEqual([r2.out.status, r2.out.cause, r2.out.resetsAt], ['stopped', 'limit', new Date(resetsAt * 1000).toISOString()], JSON.stringify(r2));
  assert.equal(lastStop(l.run).detail.resetsAt, r2.out.resetsAt);
});

test('przegląd pm-5: wynik z nagłówkiem, który się nie parsuje — drugi agent dostaje błąd w prompcie; ten sam błąd po nim → stop no-progress', () => {
  const s = setup('dbad', {}, { FAKE_BAD_HEADER_AGENT: 'dwmt-executor' });
  const r = s.drive();
  assert.deepEqual([r.out.status, r.out.cause], ['stopped', 'no-progress'], JSON.stringify(r));
  assert.match(r.out.reason, /nie poprawił nagłówka \S*result-1\.md \(.*nieczytelna wartość YAML: \["A-1 split on "words"/);
  assert.deepEqual(s.calls().map((c) => [c.agent, c.badHeader]), [['dwmt-executor', false], ['dwmt-executor', true]]);
});

test('N-2: komenda dwmt zabita w trakcie (verify, jak brak pamięci) → stop child-dead z nazwą komendy', () => {
  // Polecenie verify zabija proces `dwmt verify` (PID z active.json), jak system przy braku pamięci.
  const killer = "import { readdirSync, readFileSync } from 'node:fs';\nfor (const r of readdirSync('.dwmt/runs')) { try { process.kill(JSON.parse(readFileSync('.dwmt/runs/' + r + '/active.json', 'utf8')).pid, 'SIGKILL'); } catch {} }\n";
  const { drive, calls, root } = setup('dkv', {}, {}, { files: { 'killer.mjs': killer }, plans: (run) => ({ t1: T1(run, { verify: ['node killer.mjs'] }) }) });
  const r = drive();
  assert.deepEqual([r.out.status, r.out.cause, r.out.child?.name], ['stopped', 'child-dead', 'dwmt verify'], JSON.stringify(r));
  assert.match(r.out.reason, /`dwmt verify` zakończyła się bez wyniku/);
  assert.deepEqual(calls().map((c) => c.agent), ['dwmt-executor']);
  assert.equal(readDriveMem(root).stopped.cause, 'child-dead');
});

test('N-2: drive.hold → status hold przed pierwszym agentem zadania, bez agentów', () => {
  const { run, drive, calls, root } = setup('dho');
  writeFileSync(join(root, 'drive.hold'), '');
  const r = drive();
  assert.equal(r.out.status, 'hold', JSON.stringify(r));
  assert.equal(r.code, 3, 'hold ma własny kod wyjścia');
  assert.equal(calls().length, 0);
  assert.equal(lastStop(run).detail.status, 'hold');
});

test('recenzja S3 (2): drive.hold widzi `state` → wstrzymane zadanie bez task-start (licznik nocy, R2); po zdjęciu jeden task-start na zadanie', () => {
  const { run, drive, calls, root } = setup('dhs');
  writeFileSync(join(root, 'drive.hold'), 'R4 night limit\n');
  const r = drive();
  assert.equal(r.out.status, 'hold', JSON.stringify(r));
  assert.equal(calls().length, 0);
  assert.deepEqual(runEvents(run).filter((e) => e.type === 'task-start').length, 0, 'zadanie wstrzymane nie zaczęło się');
  // Drugi start na tym samym pliku: dalej hold i dalej bez zdarzenia.
  assert.equal(drive().out.status, 'hold');
  assert.equal(runEvents(run).filter((e) => e.type === 'task-start').length, 0);
  rmSync(join(root, 'drive.hold'));
  const done = drive();
  assert.equal(done.out.status, 'done', JSON.stringify(done));
  const starts = runEvents(run).filter((e) => e.type === 'task-start').map((e) => e.task);
  assert.deepEqual(starts, [...new Set(starts)], 'każde zadanie raz');
  assert.equal(starts[0], 1);
});

test('N-2: wait: brak sterownika → not-running; --detach + wait → waiting-user przy pytaniu planu', () => {
  const s = setup('dwn');
  const w = s.wait();
  assert.equal(w.lines.length, 1, JSON.stringify(w));
  assert.equal(JSON.parse(w.lines[0]).status, 'not-running');

  const q = setup('dwq');
  const f = runFile(q.d, q.run, 'plan.md');
  writeFileSync(f, readFileSync(f, 'utf8').replace('questions: []', 'questions: ["Q-1"]').replace('## Tasks', '### Q-1 Discount cap\n- Why I ask: money\n- Options: A; B\n\n## Tasks'));
  const dt = q.detach();
  assert.equal(dt.ok, true, JSON.stringify(dt));
  const w2 = q.wait();
  assert.equal(w2.lines.length, 1, JSON.stringify(w2));
  const o = JSON.parse(w2.lines[0]);
  assert.equal(o.status, 'waiting-user');
  assert.match(o.reason, /ask-plan/);
});

test('N-2: wait: sterownik zabity w trakcie agenta (bez drive-stop) → dead i zdarzenie stall driver-dead; assess: żywy sterownik = praca', async () => {
  const s = setup('dwd', {}, { FAKE_SLEEP_AGENT: 'dwmt-executor' });
  const dt = s.detach();
  assert.equal(dt.ok, true, JSON.stringify(dt));
  // Agent (prawdziwy proces) pracuje: PID w drive.json.children.
  let child = null;
  for (let i = 0; i < 100 && !child; i++) {
    child = Object.keys(readDriveMem(s.root)?.children ?? {})[0] ?? null;
    if (!child) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(child, 'agent w children');
  // Żywy sterownik: `watch`/supervisor (assess) widzi pracę także bez przyrostu plików.
  const a = assess({ root: s.root, run: RUN(s.d, s.run), now: Date.now() + 3 * 3600e3, transcripts: tmpdir() });
  assert.equal(a.state, 'working');
  assert.match(a.who, /driver pid/);
  const waiter = spawn(process.execPath, [SCRIPT, 'wait', s.run, '--interval', '0.2'], { cwd: s.d, env: s.env });
  let out = '';
  waiter.stdout.on('data', (x) => { out += x; });
  const ended = new Promise((r) => waiter.on('close', r));
  await new Promise((r) => setTimeout(r, 500));
  process.kill(dt.pid, 'SIGKILL');
  try { process.kill(Number(child), 'SIGKILL'); } catch { /* już nie żyje */ }
  const timer = setTimeout(() => waiter.kill(), 30e3);
  await ended;
  clearTimeout(timer);
  const lines = out.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, out);
  const o = JSON.parse(lines[0]);
  assert.equal(o.status, 'dead');
  assert.match(o.reason, new RegExp(`driver \\(pid ${dt.pid}\\)`));
  const stall = runEvents(s.run).filter((e) => e.type === 'stall').at(-1);
  assert.deepEqual([stall.detail.kind, stall.detail.pid], ['driver-dead', dt.pid]);
  assert.equal(runEvents(s.run).filter((e) => e.type === 'drive-stop').length, 0);
});

test('N-2: readEventsFrom: przyrost od przesunięcia, filtr przebiegu, rotacja od początku; assess bez sterownika = przestój', () => {
  const prev = process.env.DWMT_HOME;
  process.env.DWMT_HOME = mkdtempSync(join(tmpdir(), 'dwmt-ev-'));
  try {
    emit({ type: 'drive-start', project: 'C:/p', run: 'a', detail: { pid: 1 } });
    emit({ type: 'drive-start', project: 'C:/p', run: 'b', detail: { pid: 2 } });
    const r1 = readEventsFrom(0, { run: 'a' });
    assert.deepEqual(r1.events.map((e) => e.detail.pid), [1]);
    emit({ type: 'drive-stop', project: 'C:/p', run: 'a', detail: { status: 'done' } });
    const r2 = readEventsFrom(r1.offset, { run: 'a' });
    assert.deepEqual(r2.events.map((e) => e.type), ['drive-stop']);
    assert.equal(readEventsFrom(r2.offset).events.length, 0);
    writeFileSync(eventsFile(), `${JSON.stringify({ type: 'stall', run: 'a' })}\n`);
    assert.deepEqual(readEventsFrom(r2.offset, { run: 'a' }).events.map((e) => e.type), ['stall']);
  } finally { if (prev === undefined) delete process.env.DWMT_HOME; else process.env.DWMT_HOME = prev; }
  const root = mkdtempSync(join(tmpdir(), 'dwmt-drl-'));
  const run = { run: 'r-d', task: 1, phase: 'implement', session_ids: [] };
  writeFileSync(join(root, 'run.json'), JSON.stringify(run));
  const later = Date.now() + 3 * 3600e3;
  assert.equal(assess({ root, run, now: later, transcripts: tmpdir() }).state, 'stall');
  writeDriveLock(root);
  assert.equal(assess({ root, run, now: later, transcripts: tmpdir() }).state, 'working');
});

test('N-2: wait: komenda pod żywym sterownikiem bez przyrostu ponad hangMin → hang (jedna linia, zdarzenie stall hang)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dwmt-wh-'));
  const run = { run: 'r-h', task: 1, phase: 'verify', session_ids: [] };
  writeFileSync(join(root, 'run.json'), JSON.stringify(run));
  writeFileSync(join(root, 'drive.json'), JSON.stringify({ startedAt: new Date(Date.now() - 1000).toISOString(), pid: process.pid }));
  writeDriveLock(root);
  markActive(root, 'verify');
  const out = [];
  const prev = process.env.DWMT_HOME;
  process.env.DWMT_HOME = mkdtempSync(join(tmpdir(), 'dwmt-evh-'));
  try {
    const quiet = waitDriver({ root, runId: 'r-h', project: 'C:/p', load: () => run, watch: { hangMin: 90 }, maxPolls: 1, write: (l) => out.push(l) });
    assert.equal(quiet.status, 'waiting', 'świeża komenda: dalej czeka');
    const o = waitDriver({ root, runId: 'r-h', project: 'C:/p', load: () => run, watch: { hangMin: -1 }, maxPolls: 1, write: (l) => out.push(l) });
    assert.equal(o.status, 'hang');
    assert.equal(out.length, 1);
    assert.match(JSON.parse(out[0]).reason, /verify.*hang suspected/);
    assert.equal(readEventsFrom(0, { run: 'r-h' }).events.at(-1).detail.kind, 'hang');
  } finally { if (prev === undefined) delete process.env.DWMT_HOME; else process.env.DWMT_HOME = prev; }
});

// ---------- recenzja N-2 (2026-10-04) ----------

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const withQuestion = (text) => text.replace('questions: []', 'questions: ["Q-1"]').replace('## Tasks', '### Q-1 Discount cap\n- Why I ask: money\n- Options: A; B\n\n## Tasks');

test('recenzja N-2 (1): odpowiedzi po ask-plan wracają do tego samego architekta (--resume), także po `state` sesji zatrzymania', () => {
  const arch = mkdtempSync(join(tmpdir(), 'dwmt-arch-'));
  const s = setup('dar', {}, { FAKE_ARCH_DIR: arch }, { plans: null, cfg: { drive: { enabled: true } } });
  const put = (i, f, text) => { const p = join(arch, String(i), '.dwmt', 'runs', s.run, f); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); };
  // Architekt 1: plan z pytaniem i plany zadań; architekt 2 (odpowiedzi): plan bez pytań.
  put(1, 'plan.md', withQuestion(PLAN(s.run)));
  for (const [k, t] of [[1, T1], [2, T2], [3, T3]]) put(1, `tasks/${k}/brief.md`, t(s.run));
  put(2, 'plan.md', PLAN(s.run));
  const r1 = s.drive();
  assert.deepEqual([r1.code, r1.out.status], [10, 'waiting-user'], JSON.stringify(r1));
  assert.match(r1.out.reason, /ask-plan/);
  // Sesja zatrzymania zapisuje odpowiedź i woła `state` (dawniej przejmowała architekta, więc sterownik startował świeżego).
  writeFileSync(join(s.root, 'answers.md'), '### Q-1 Discount cap\nA\n');
  const st = cliAs(s.d, 'sess-stop', 'state', s.run).json;
  assert.deepEqual([st.next, st.agent, st.drive], ['plan', 'dwmt-architect', true], JSON.stringify(st));
  const r2 = s.drive();
  const arch2 = s.calls().filter((c) => c.agent === 'dwmt-architect');
  assert.equal(arch2.length, 2, JSON.stringify(s.calls()));
  assert.ok(arch2[0].sid && arch2[1].resume === arch2[0].sid, JSON.stringify(arch2));
  assert.equal(r2.out.status, 'done', JSON.stringify(r2));
});

test('recenzja N-2 (2): nowe `wait` po „czekaj dalej” nie zgłasza hang od razu; `dwmt stop` zatrzymuje zawieszoną komendę', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dwmt-wh2-'));
  const run = { run: 'r-h2', task: 1, phase: 'verify', session_ids: [] };
  writeFileSync(join(root, 'run.json'), JSON.stringify(run));
  writeFileSync(join(root, 'drive.json'), JSON.stringify({ startedAt: new Date(Date.now() - 4 * 3600e3).toISOString(), pid: process.pid }));
  writeDriveLock(root);
  markActive(root, 'verify');
  const old = new Date(Date.now() - 3 * 3600e3);
  utimesSync(join(root, 'active.json'), old, old);
  const prev = process.env.DWMT_HOME;
  process.env.DWMT_HOME = mkdtempSync(join(tmpdir(), 'dwmt-evh2-'));
  try {
    const out = [];
    const o = waitDriver({ root, runId: 'r-h2', project: 'C:/p', load: () => run, watch: { hangMin: 90 }, maxPolls: 1, write: (l) => out.push(l) });
    assert.equal(o.status, 'waiting', JSON.stringify(o));
    assert.equal(out.length, 0);
  } finally { if (prev === undefined) delete process.env.DWMT_HOME; else process.env.DWMT_HOME = prev; }

  const s = setup('dst');
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  const closed = new Promise((r) => sleeper.on('close', r));
  writeFileSync(join(s.root, 'active.json'), JSON.stringify({ cmd: 'verify', pid: sleeper.pid, start: new Date().toISOString() }));
  const stop = () => JSON.parse(spawnSync(process.execPath, [SCRIPT, 'stop', s.run], { cwd: s.d, encoding: 'utf8', env: s.env }).stdout);
  const r = stop();
  assert.deepEqual([r.ok, r.cmd, r.pid], [true, 'verify', sleeper.pid], JSON.stringify(r));
  await Promise.race([closed, pause(15e3)]);
  assert.ok(sleeper.exitCode !== null || sleeper.signalCode !== null, 'komenda zatrzymana');
  assert.equal(stop().ok, false);
});

test('recenzja N-2 (4): tekst limitu jako zwykły wynik (is_error: false) → stop limit; `state` sterownika widzi limit w transkrypcie agenta', () => {
  const tr = mkdtempSync(join(tmpdir(), 'dwmt-tr-lim2-'));
  mkdirSync(join(tr, 'proj'));
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const f = join(tr, 'proj', 'lim-0000.jsonl');
  writeFileSync(f, `${JSON.stringify({ type: 'assistant', error: 'rate_limit', quotaLimits: { resetsAt, rateLimitType: 'five_hour' } })}\n`);
  const l = setup('dlo', {}, { FAKE_LIMIT_OK_AGENT: 'dwmt-executor', DWMT_TRANSCRIPTS: tr });
  const r = l.drive();
  assert.deepEqual([r.out.status, r.out.cause, r.out.resetsAt], ['stopped', 'limit', new Date(resetsAt * 1000).toISOString()], JSON.stringify(r));
  // Sterownik zabity przed sprawdzeniem: następny `state` (identyfikator `drive-…`) daje `limit` z głównych transkryptów agentów.
  const now = new Date();
  utimesSync(f, now, now);
  const st = JSON.parse(spawnSync(process.execPath, [SCRIPT, 'state', l.run], { cwd: l.d, encoding: 'utf8', env: { ...l.env, CLAUDE_CODE_SESSION_ID: `drive-${l.run}-T1` } }).stdout);
  assert.equal(st.limit?.resetsAt, r.out.resetsAt, JSON.stringify(st));
});

test('recenzja N-2 (5): --detach bez startu sterownika → ok: false z końcem drive.out; `wait` nie odtwarza starego zatrzymania', () => {
  const q = setup('dwf');
  const f = runFile(q.d, q.run, 'plan.md');
  writeFileSync(f, withQuestion(readFileSync(f, 'utf8')));
  assert.equal(q.drive().out.status, 'waiting-user');
  // Zepsuty config: sterownik ginie przed blokadą.
  const cfgFile = join(q.d, '.claude', 'dwmt.json');
  const good = readFileSync(cfgFile, 'utf8');
  writeFileSync(cfgFile, '{bad');
  const dt = q.detach();
  writeFileSync(cfgFile, good);
  assert.equal(dt.ok, false, JSON.stringify(dt));
  assert.match(dt.error, /sterownik nie wystartował: .*JSON/);
  const w = q.wait();
  assert.equal(w.lines.length, 1, JSON.stringify(w));
  const o = JSON.parse(w.lines[0]);
  assert.equal(o.status, 'stopped', JSON.stringify(o));
  assert.match(o.reason, /nie wystartował/);
});

test('recenzja N-2 (6): trzy sterowniki naraz przy martwej blokadzie (PID użyty ponownie) → rusza jeden', async () => {
  const s = setup('dcc', {}, { FAKE_SLEEP_AGENT: 'dwmt-executor', FAKE_SLEEP_MS: '30000' });
  writeFileSync(join(s.root, 'drive.lock'), JSON.stringify({ pid: process.pid, pidStart: '2000-01-01T00:00:00.000Z' }));
  const ps = [0, 1, 2].map(() => spawn(process.execPath, [DRIVE, s.run], { cwd: s.d, env: s.env }));
  const outs = ['', '', ''];
  const exited = [];
  ps.forEach((p, i) => { p.stdout.on('data', (x) => { outs[i] += x; }); p.on('close', () => exited.push(i)); });
  for (let t = 0; t < 200 && exited.length < 2; t++) await pause(100);
  // The surviving driver reaches its executor ~1.5 s after the others stop on a loaded machine (red on base with a fixed
  // 500 ms): wait for the first executor call, then 500 ms more so a second one would show.
  for (let t = 0; t < 200 && !s.calls().some((c) => c.agent === 'dwmt-executor'); t++) await pause(100);
  await pause(500);
  const execs = s.calls().filter((c) => c.agent === 'dwmt-executor').length;
  ps.forEach((p, i) => { if (!exited.includes(i)) killTree(p.pid); });
  assert.equal(exited.length, 2, outs.join(' || '));
  for (const i of exited) assert.match(JSON.parse(outs[i].trim().split(/\r?\n/).pop()).reason, /sterownik już działa/);
  assert.equal(execs, 1);
});

test('recenzja N-2 (9): żywe dzieci poprzedniego sterownika giną na starcie nowego', async () => {
  const s = setup('dch');
  writeFileSync(join(s.root, 'drive.hold'), '');
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  const closed = new Promise((r) => sleeper.on('close', r));
  writeFileSync(join(s.root, 'drive.json'), JSON.stringify({ agents: {}, steps: 0, cost: 0, children: { [sleeper.pid]: { kind: 'agent', agent: 'dwmt-executor', start: new Date().toISOString() } } }));
  const r = s.drive();
  assert.equal(r.out.status, 'hold', JSON.stringify(r));
  await Promise.race([closed, pause(15e3)]);
  assert.ok(sleeper.exitCode !== null || sleeper.signalCode !== null, 'dziecko zatrzymane');
  assert.deepEqual(readDriveMem(s.root).children, {});
  assert.match(readFileSync(join(s.root, 'drive.log'), 'utf8'), new RegExp(`dziecko poprzedniego sterownika zatrzymane: pid ${sleeper.pid}`));
});

test('D4 (§6.4 pkt 6): bramka ceny pod sterownikiem (próg askAboveM): Q-price zatrzymuje na ask-plan (exit 10); continue → do końca bez architekta; stop → stopped price', () => {
  const files = (run) => ({ plan: PLAN(run).replace('questions: []\n', 'questions: []\nfiles: [3, 8]\n') });
  const s = setup('dpg', {}, {}, { cfg: { drive: { enabled: true }, run: { priceGate: { askAboveM: 0.5 } } }, plans: files });
  const r1 = s.drive();
  assert.deepEqual([r1.code, r1.out.status], [10, 'waiting-user'], JSON.stringify(r1));
  assert.match(r1.out.reason, /ask-plan.*Q-price/);
  writeFileSync(join(s.root, 'answers.md'), '### Q-price\ncontinue\n');
  const r2 = s.drive();
  assert.equal(r2.out.status, 'done', JSON.stringify(r2));
  assert.equal(s.calls().filter((c) => c.agent === 'dwmt-architect').length, 0, 'odpowiedź continue bez tury architekta');
  assert.equal(RUN(s.d, s.run).price.gate, 'asked');

  const t = setup('dps', {}, {}, { cfg: { drive: { enabled: true }, run: { priceGate: { askAboveM: 0.5 } } }, plans: files });
  assert.equal(t.drive().code, 10);
  writeFileSync(join(t.root, 'answers.md'), '### Q-price\nstop\n');
  const r3 = t.drive();
  assert.deepEqual([r3.out.status, r3.out.cause], ['stopped', 'price'], JSON.stringify(r3));
  assert.equal(t.calls().length, 0, 'żadnego agenta');
});

test('sprint poprawek: szkielet drive.json z --detach (sam detachedAt, steps/cost null) → architekt z kluczem sesji nie wywraca pętli', () => {
  const note = '[plan] `src/summary/view.ts#view`: the discount is a fraction, the plan assumed percent';
  const { run, drive, calls, root } = setup('ddk', { 1: [note] });
  writeFileSync(join(root, 'drive.json'), JSON.stringify({ detachedAt: new Date().toISOString(), children: {}, steps: null, cost: null }));
  const r = drive();
  assert.equal(r.out.status, 'done', JSON.stringify(r));
  assert.equal(calls().filter((c) => c.agent === 'dwmt-architect').length, 1);
  const mem = JSON.parse(readFileSync(join(root, 'drive.json'), 'utf8'));
  assert.ok(mem.agents.architect, JSON.stringify(mem.agents));
  assert.ok(Number.isFinite(mem.steps) && mem.steps > 0 && Number.isFinite(mem.cost), JSON.stringify(mem));
  assert.ok(run);
});

test('tryb A: wait --progress podaje punkty kontrolne (start i koniec zadań) po kolei, potem koniec; drive-mode off wyłącza sterownik w state', () => {
  const s = setup('dpg', {}, {}, { cfg: { drive: { enabled: true } } });
  const r = s.drive();
  assert.equal(r.out.status, 'done', JSON.stringify(r));
  const env = s.env;
  const wait = (...extra) => {
    const o = spawnSync(process.execPath, [SCRIPT, 'wait', s.run, '--interval', '0.1', '--progress', ...extra], { cwd: s.d, encoding: 'utf8', env });
    return JSON.parse(o.stdout.trim().split(/\r?\n/).pop());
  };
  const seen = [];
  let w = wait();
  // Bez `--after`: pokazane punkty pamięta progress.json przebiegu.
  for (let i = 0; i < 20 && w.status === 'progress'; i++) { seen.push(w.reason); w = wait(); }
  assert.equal(w.status, 'done', JSON.stringify(w));
  assert.deepEqual(seen.map((x) => x.replace(/: .*$/, '').replace(/ · .*$/, '')), ['▸ T-1/3 started', '▸ T-1/3 PASS', '▸ T-2/3 started', '▸ T-2/3 PASS', '▸ T-3/3 started', '▸ T-3/3 PASS']);
  const st = spawnSync(process.execPath, [SCRIPT, 'drive-mode', s.run, 'off'], { cwd: s.d, encoding: 'utf8', env });
  assert.equal(JSON.parse(st.stdout).ok, true, st.stdout);
  assert.equal(RUN(s.d, s.run).drive, false);
  // Sterownik (np. z pętli supervisora) nie rusza przebiegu prowadzonego przez sesję.
  const again = s.drive();
  assert.deepEqual([again.out.status, again.out.cause], ['stopped', 'drive-off'], JSON.stringify(again));
});

