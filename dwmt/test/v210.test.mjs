import './tmp-root.mjs';
// dwmt v2.10 (N-1): dziennik zdarzeń maszyny, alarm przestoju według życia (`watch`), usuwanie plików za zgodą (`delete`,
// `ask-delete`, `delete-consent`), katalog roboczy wykonawców, zajęte porty, reguła komend `verify`, recenzent `high` dla
// zmian bez kodu, nazwy sesji, poprawka wpisu UAT. Fikstury syntetyczne z fixtures28.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, existsSync, utimesSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { parseYaml, splitHeader, parseTasks, sessionName, verifyCommandErrors, deleteErrors, isDocsOnly, busyPortText, renderAgents, loadConfig } from '../scripts/dwmt.mjs';
import { validateTaskPlans } from '../scripts/plan.mjs';
import { emit, readEvents, eventsFile } from '../scripts/events.mjs';
import { assess, watchLoop, markActive, endActive, readActive, processAlive, stallLine } from '../scripts/watch.mjs';
import { busyPorts, portBusy } from '../scripts/machine.mjs';
import { header, runFile, DWMT_HOME, repo, gitIn } from './helpers.mjs';
import { cliAs, RUN, PLAN, T1, T2, repo28, start, writePlans, review, hdr } from './fixtures28.mjs';

const state = (d, sid, run) => cliAs(d, sid, 'state', run).json;
const planObj = (text) => ({ text, h: parseYaml(splitHeader(text).yaml) });
const deadPid = () => { const r = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }); return Number(r.stdout.trim()); };
const old = (f, min = 600) => { const t = new Date(Date.now() - min * 60e3); utimesSync(f, t, t); };
const withHome = (fn) => {
  const prev = process.env.DWMT_HOME;
  process.env.DWMT_HOME = DWMT_HOME;
  try { return fn(); } finally { if (prev === undefined) delete process.env.DWMT_HOME; else process.env.DWMT_HOME = prev; }
};
const eventsOf = (run) => withHome(() => readEvents({ run }));

// ---------- dziennik zdarzeń ----------

test('events: linia JSON z projektem, przebiegiem i sesją; rotacja po rozmiarze; wyłączenie; błąd zapisu nie rzuca', () => {
  const home = mkdtempSync(join(tmpdir(), 'dwmt-ev-'));
  const prev = { h: process.env.DWMT_HOME, s: process.env.CLAUDE_CODE_SESSION_ID };
  process.env.DWMT_HOME = home;
  process.env.CLAUDE_CODE_SESSION_ID = 'sess-ev';
  try {
    const e = emit({ type: 'task-start', project: 'D:/x/proj', run: 'r1', task: 2, detail: { mode: 'single' }, costM: null });
    assert.deepEqual([e.type, e.project, e.run, e.session, e.task, 'costM' in e], ['task-start', { name: 'proj', root: 'D:/x/proj' }, 'r1', 'sess-ev', 2, false]);
    assert.equal(readEvents({ run: 'r1' }).length, 1);
    // Rotacja: plik większy niż limit przechodzi do .1, nowy zaczyna od jednej linii.
    emit({ type: 'stall', project: 'D:/x/proj', run: 'r1' }, { maxBytes: 10 });
    assert.ok(existsSync(`${eventsFile()}.1`));
    assert.equal(readEvents().length, 1);
    writeFileSync(join(home, 'machine.json'), JSON.stringify({ events: false }));
    assert.equal(emit({ type: 'stall', project: 'p', run: 'r1' }), null, 'events: false wyłącza dziennik');
    writeFileSync(join(home, 'machine.json'), '{}');
    process.env.DWMT_EVENTS = '0';
    assert.equal(emit({ type: 'stall', project: 'p', run: 'r1' }), null, 'DWMT_EVENTS=0 wyłącza');
    delete process.env.DWMT_EVENTS;
    process.env.DWMT_HOME = join(home, 'machine.json', 'nie-katalog');
    assert.equal(emit({ type: 'stall', project: 'p', run: 'r1' }), null, 'zapis niemożliwy: null bez wyjątku');
  } finally {
    process.env.DWMT_HOME = prev.h ?? '';
    if (prev.h === undefined) delete process.env.DWMT_HOME;
    if (prev.s === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = prev.s;
  }
});

test('events w przebiegu: task-start raz, command-red z komendami, question-waiting raz przy wejściu w pytanie', () => {
  const red = 'node -e "process.exit(1)"';
  const { d } = repo28({ verify: { full: ['node -e 0'], targeted: null } });
  const run = start(d, 'ev');
  writePlans(d, run, { t1: T1(run, { verify: ['node -e 0', red] }) });
  assert.equal(state(d, 'sess-1', run).next, 'implement');
  state(d, 'sess-1', run);
  writeFileSync(runFile(d, run, 'result-1.md', 1), header({ schema: 'dwmt/result@1', status: 'DONE' }));
  assert.equal(cliAs(d, 'sess-1', 'verify', run).json.result, 'fail');
  const ev = eventsOf(run);
  assert.equal(ev.filter((e) => e.type === 'task-start').length, 1, 'start zadania raz mimo dwóch state');
  const s = ev.find((e) => e.type === 'task-start');
  assert.deepEqual([s.task, s.session, s.project.name], [1, 'sess-1', d.split(/[\\/]/).pop()]);
  const r = ev.find((e) => e.type === 'command-red');
  assert.deepEqual([r.detail.kind, r.detail.commands], ['targeted', [red]]);
});

// ---------- usuwanie plików za zgodą (B) ----------

const T1DEL = (run, extra = {}) => T1(run, extra).replace('verify: ', 'delete: ["src/billing/invoice.test.ts"]\nverify: ');

test('delete: ask-delete raz przed implementacją, zgoda → skrypt usuwa plik na starcie zadania, commit i raport z deleted', () => {
  const { d } = repo28({ deletes: { ask: true } });
  const run = start(d, 'del');
  writePlans(d, run, { t1: T1DEL(run) });
  const st = state(d, 'sess-1', run);
  assert.equal(st.next, 'ask-delete', JSON.stringify(st));
  assert.deepEqual(st.files, ['T-1 src/billing/invoice.test.ts']);
  assert.equal(state(d, 'sess-1', run).next, 'ask-delete');
  assert.equal(eventsOf(run).filter((e) => e.type === 'question-waiting').length, 1, 'pytanie czeka: jedno zdarzenie');
  assert.equal(cliAs(d, 'sess-1', 'delete-consent', run).json.ok, false, 'bez --yes/--no błąd');
  assert.deepEqual(cliAs(d, 'sess-1', 'delete-consent', run, '--yes').json.approved, ['src/billing/invoice.test.ts']);
  const st2 = state(d, 'sess-1', run);
  assert.equal(st2.next, 'implement');
  assert.deepEqual(st2.deleted, ['src/billing/invoice.test.ts']);
  assert.equal(existsSync(join(d, 'src', 'billing', 'invoice.test.ts')), false);
  // Wykonawca zostawia pomocnika w katalogu roboczym; commit go nie bierze i opróżnia katalog.
  mkdirSync(join(d, '.dwmt', 'scratch'), { recursive: true });
  writeFileSync(join(d, '.dwmt', 'scratch', 'probe.mjs'), '// helper\n');
  writeFileSync(join(d, 'src', 'billing', 'discount.ts'), 'export class Discount {}\n');
  writeFileSync(runFile(d, run, 'result-1.md', 1), header({ schema: 'dwmt/result@1', status: 'DONE' }));
  assert.equal(cliAs(d, 'sess-1', 'verify', run).json.ok, true);
  assert.equal(cliAs(d, 'sess-1', 'review-input', run).json.ok, true);
  writeFileSync(runFile(d, run, 'review-1.md', 1), review(1));
  assert.equal(state(d, 'sess-1', run).next, 'commit');
  const c = cliAs(d, 'sess-1', 'commit', run).json;
  assert.equal(c.ok, true, JSON.stringify(c));
  const g = gitIn(d);
  assert.match(g('show', '--name-status', '--format=', 'HEAD'), /^D\tsrc\/billing\/invoice\.test\.ts$/m);
  assert.doesNotMatch(g('show', '--name-status', '--format=', 'HEAD'), /scratch/);
  assert.equal(existsSync(join(d, '.dwmt', 'scratch')), false, 'katalog roboczy opróżniony');
  assert.deepEqual(hdr(runFile(d, run, 'report.md', 1)).deleted, ['src/billing/invoice.test.ts']);
  const end = eventsOf(run).find((e) => e.type === 'task-end');
  assert.deepEqual([end.task, end.verdict, end.detail.deleted], [1, 'PASS', ['src/billing/invoice.test.ts']]);
});

test('delete: domyślnie bez pytania (decyzja 2026-10-21) — zgoda zapisana sama, plik usunięty na starcie zadania', () => {
  const { d } = repo28();
  const run = start(d, 'auto');
  writePlans(d, run, { t1: T1DEL(run) });
  const st = state(d, 'sess-1', run);
  assert.equal(st.next, 'implement', JSON.stringify(st));
  assert.deepEqual(st.deleted, ['src/billing/invoice.test.ts']);
  assert.equal(existsSync(join(d, 'src', 'billing', 'invoice.test.ts')), false);
  const del = RUN(d, run).deletions;
  assert.deepEqual([del.auto, del.approved], [true, ['src/billing/invoice.test.ts']]);
  assert.equal(eventsOf(run).filter((e) => e.type === 'question-waiting').length, 0, 'bez pytania');
});

test('delete: bez zgody plik zostaje, kryterium niespełnione w raporcie zadania; przebieg 2.9 bez bramki', () => {
  const { d } = repo28({ deletes: { ask: true } });
  const run = start(d, 'keep');
  writePlans(d, run, { t1: T1DEL(run) });
  assert.equal(state(d, 'sess-1', run).next, 'ask-delete');
  assert.deepEqual(cliAs(d, 'sess-1', 'delete-consent', run, '--no').json.declined, ['src/billing/invoice.test.ts']);
  assert.equal(state(d, 'sess-1', run).next, 'implement');
  assert.equal(existsSync(join(d, 'src', 'billing', 'invoice.test.ts')), true);
  assert.deepEqual(RUN(d, run).tasks[0].kept, ['src/billing/invoice.test.ts']);
  writeFileSync(join(d, 'src', 'billing', 'discount.ts'), 'export class Discount {}\n');
  writeFileSync(runFile(d, run, 'result-1.md', 1), header({ schema: 'dwmt/result@1', status: 'DONE' }));
  cliAs(d, 'sess-1', 'verify', run);
  cliAs(d, 'sess-1', 'review-input', run);
  writeFileSync(runFile(d, run, 'review-1.md', 1), review(1));
  assert.equal(cliAs(d, 'sess-1', 'commit', run).json.ok, true);
  const rep = hdr(runFile(d, run, 'report.md', 1));
  assert.ok(rep.acceptance.some((a) => /^delete not met: kept without the user's consent: src\/billing\/invoice\.test\.ts$/.test(a)), JSON.stringify(rep.acceptance));
  assert.deepEqual(rep.kept, ['src/billing/invoice.test.ts']);

  const { d: d2 } = repo28();
  const run2 = start(d2, 'old');
  const rj = RUN(d2, run2);
  rj.rules = '2.9';
  writeFileSync(runFile(d2, run2, 'run.json'), JSON.stringify(rj));
  writePlans(d2, run2, { t1: T1DEL(run2) });
  assert.equal(state(d2, 'sess-1', run2).next, 'implement', 'przebieg 2.9 kończy się regułami 2.9');
  assert.equal(existsSync(join(d2, 'src', 'billing', 'invoice.test.ts')), true);
});

test('walidacja 2.10: komendy verify bez $( ), backticków i $VAR; delete pełne ścieżki z bazy; [remove] całego pliku wymaga delete', () => {
  assert.deepEqual(verifyCommandErrors({ verify: ['npm test', 'node scripts/api-check.mjs', 'awk \'{print $1}\' a', 'grep -q "x$" f'] }), []);
  const errs = verifyCommandErrors({ verify: ['test "$(curl -s x)" = ok', 'echo `date`', 'curl $API_URL/health', 'echo ${HOME}'] });
  assert.equal(errs.length, 4, errs.join('\n'));
  assert.ok(errs.every((e) => /put complex logic into a script in the repo/.test(e)));
  assert.deepEqual(deleteErrors({ delete: ['docs/a.md'] }), []);
  assert.equal(deleteErrors({ delete: ['docs/*.md', '/etc/x', '../x', 'C:/x'] }).length, 4);

  const { d } = repo28();
  const run = start(d, 'val');
  const root = join(d, '.dwmt', 'runs', run);
  const t1 = T1(run, { verify: ['node -e 0', 'test "$(node -v)"'], changes: ['[new value object] `Discount` in `src/billing/discount.ts` — holds it; pattern: `src/shared/money.ts#Money`', '[remove] `src/billing/invoice.test.ts` — replaced by the new test'] })
    .replace('verify: ', 'delete: ["src/billing/nope.ts"]\nverify: ');
  writePlans(d, run, { t1 });
  const full = { ...planObj(PLAN(run)), tasks: parseTasks(PLAN(run)), file: runFile(d, run, 'plan.md') };
  const cfg = loadConfig(d);
  const e = validateTaskPlans({ top: d, root, plan: full, cfg, run: RUN(d, run) }).errors.filter((x) => x.startsWith('T-1:')).join('\n');
  assert.match(e, /verify: „test "\$\(node -v\)"” uses \$\( … \)/);
  assert.match(e, /\[remove\] src\/billing\/invoice\.test\.ts usuwa cały plik: wpisz go do nagłówka delete/);
  assert.match(e, /delete: src\/billing\/nope\.ts nie istnieje w bazie zadania/);
  const e29 = validateTaskPlans({ top: d, root, plan: full, cfg, run: { ...RUN(d, run), rules: '2.9' } }).errors.filter((x) => x.startsWith('T-1:')).join('\n');
  assert.doesNotMatch(e29, /uses \$\(|usuwa cały plik/, 'przebieg 2.9: bez nowych reguł');
});

// ---------- recenzent high dla zmian bez kodu (12c) ----------

test('review-input: zmiana tylko w dokumentach → dwmt-reviewer-high (state też); kod → dwmt-reviewer; docsOnlyRole null wyłącza', () => {
  assert.equal(isDocsOnly(['README.md', 'docs/a/b.md', 'notes.txt'], ['**/*.md', '**/*.txt']), true);
  assert.equal(isDocsOnly(['docs/a.md', 'src/a.ts'], ['**/*.md']), false);
  assert.equal(isDocsOnly([], ['**/*.md']), false);
  const agents = renderAgents(loadConfig(repo()));
  const high = agents.find((a) => a.name === 'dwmt-reviewer-high');
  assert.ok(high, 'setup generuje wariant recenzenta');
  assert.match(high.text, /^effort: high$/m);
  assert.match(agents.find((a) => a.name === 'dwmt-reviewer').text, /^effort: xhigh$/m);

  const flow = (cfg, files) => {
    const { d } = repo28(cfg);
    const run = start(d, 'docs');
    writePlans(d, run);
    assert.equal(state(d, 'sess-1', run).next, 'implement');
    for (const [f, t] of Object.entries(files)) { mkdirSync(join(d, f, '..'), { recursive: true }); writeFileSync(join(d, f), t); }
    writeFileSync(runFile(d, run, 'result-1.md', 1), header({ schema: 'dwmt/result@1', status: 'DONE' }));
    assert.equal(cliAs(d, 'sess-1', 'verify', run).json.ok, true);
    const ri = cliAs(d, 'sess-1', 'review-input', run).json;
    return { ri, st: state(d, 'sess-1', run) };
  };
  const docs = flow({}, { 'docs/billing.md': '# Billing\n' });
  assert.equal(docs.ri.agent, 'dwmt-reviewer-high');
  assert.deepEqual([docs.st.next, docs.st.agent], ['review', 'dwmt-reviewer-high']);
  const code = flow({}, { 'docs/billing.md': '# Billing\n', 'src/billing/discount.ts': 'export class Discount {}\n' });
  assert.equal(code.ri.agent, undefined);
  assert.equal(code.st.agent, 'dwmt-reviewer');
  const off = flow({ review: { docsOnlyRole: null } }, { 'docs/billing.md': '# Billing\n' });
  assert.equal(off.st.agent, 'dwmt-reviewer');
});

test('kr1 review-input: an unreported code file outside the task scope joins the reviewer and lens choice', () => {
  // R-2 (D-7, D-17): a docs file in T-1's scope plus an unreported code file in T-2's scope (outside T-1's).
  const { d } = repo28({ review: { lensGlobs: { data: ['src/summary/**'] } } });
  const run = start(d, 'outside');
  writePlans(d, run);
  assert.equal(state(d, 'sess-1', run).next, 'implement');
  const files = { 'src/billing/notes.md': '# Notes\n', 'src/summary/total.ts': 'export const total = () => 0;\n' };
  for (const [f, t] of Object.entries(files)) { mkdirSync(join(d, f, '..'), { recursive: true }); writeFileSync(join(d, f), t); }
  writeFileSync(runFile(d, run, 'result-1.md', 1), header({ schema: 'dwmt/result@1', status: 'DONE' }));
  assert.equal(cliAs(d, 'sess-1', 'verify', run).json.ok, true);
  const ri = cliAs(d, 'sess-1', 'review-input', run).json;
  assert.equal(ri.ok, true, JSON.stringify(ri));
  assert.equal(ri.agent, undefined, 'not the docs-only reviewer');
  assert.equal(state(d, 'sess-1', run).agent, 'dwmt-reviewer');
  const input = readFileSync(runFile(d, run, 'review-input.md', 1), 'utf8');
  const h = parseYaml(splitHeader(input).yaml);
  assert.ok(h.passes.includes('data'), `the outside file triggers its lens: ${JSON.stringify(h.passes)}`);
  assert.deepEqual(ri.passes, h.passes);
  const changed = input.replace(/\r\n/g, '\n').split('## Changed files\n\n')[1].split('\n\n')[0].split('\n');
  assert.deepEqual(changed, ['- src/billing/notes.md']);
  assert.match(input, /^Changed outside the task scope and not reported by the executor \(names only, not in the diff; read the file to review it\): `src\/summary\/total\.ts`\.$/m);
  assert.equal(ri.files, 1, 'size and units stay on content files');
});

// ---------- zajęte porty (C) ----------

test('ports: zajęty port → busyPorts z PID właściciela; wolny i niepasujący `for` pomijane; verify zwraca env', async () => {
  const srv = spawn(process.execPath, ['-e', "const s=require('net').createServer().listen(0,'127.0.0.1',()=>process.stdout.write(String(s.address().port)))"], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const port = await new Promise((res) => srv.stdout.once('data', (b) => res(Number(String(b).trim()))));
    assert.equal(portBusy(port), true);
    const busy = busyPorts(['npm run e2e'], [{ for: 'e2e', ports: [port] }]);
    assert.equal(busy.length, 1);
    assert.equal(busy[0].port, port);
    if (busy[0].pid != null) assert.equal(busy[0].pid, srv.pid, 'PID właściciela (gdy narzędzie systemu jest dostępne)');
    assert.deepEqual(busyPorts(['npm test'], [{ for: 'e2e', ports: [port] }]), [], 'komenda spoza `for`');
    assert.match(busyPortText({ port, pid: 7, cmd: 'node vite' }, 'pl'), /^Port \d+ jest zajęty przez inny proces \(pid 7: node vite\).*Potrzeba: /);
    assert.match(busyPortText({ port }, 'en'), /^Port \d+ is taken by another process, so .* Needed: /);

    const { d } = repo28({ verify: { full: ['node -e 0'], targeted: null, ports: [{ for: 'node', ports: [port] }] } });
    const run = start(d, 'port');
    writePlans(d, run);
    assert.equal(state(d, 'sess-1', run).next, 'implement');
    writeFileSync(runFile(d, run, 'result-1.md', 1), header({ schema: 'dwmt/result@1', status: 'DONE' }));
    const v = cliAs(d, 'sess-1', 'verify', run).json;
    assert.equal(v.result, 'env', JSON.stringify(v));
    assert.match(v.env.join('\n'), new RegExp(`Port ${port} is taken`));
    assert.equal(existsSync(runFile(d, run, 'tests.md', 1)), false, 'nic nie uruchomione');
    assert.ok(eventsOf(run).some((e) => e.type === 'question-waiting' && e.detail.reason === 'env'));
  } finally { srv.kill(); }
  assert.equal(busyPorts(['x'], [{ ports: [1] }], { busy: () => false }).length, 0, 'wolny port');
});

// ---------- alarm przestoju (watch) ----------

function watchRun(phase, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dwmt-w-'));
  const run = { run: 'r-w', task: 1, phase, session_ids: ['no-such-session'], ...extra };
  writeFileSync(join(root, 'run.json'), JSON.stringify(run));
  return { root, run };
}

test('watch: martwy PID komendy bez końca = przestój; żywy = praca; zakończona po starcie obserwacji = koniec; zawieszenie po hangMin', () => {
  const { root, run } = watchRun('verify');
  writeFileSync(join(root, 'active.json'), JSON.stringify({ cmd: 'verify', pid: deadPid(), start: new Date().toISOString() }));
  const a = assess({ root, run, transcripts: tmpdir() });
  assert.deepEqual([a.state, a.reason, a.cmd], ['stall', 'dead', 'verify']);
  assert.match(stallLine(a, 'r-w', 'pl'), /`verify` przestało działać bez wyniku.*Potrzeba: /);
  assert.match(stallLine(a, 'r-w', 'en'), /stopped without a result.*Needed: /);

  writeFileSync(join(root, 'active.json'), JSON.stringify({ cmd: 'verify', pid: process.pid, start: new Date().toISOString() }));
  assert.equal(assess({ root, run, transcripts: tmpdir() }).state, 'working');
  old(join(root, 'active.json'), 200);
  old(join(root, 'run.json'), 200);
  const h = assess({ root, run, transcripts: tmpdir() });
  assert.equal(h.state, 'hang', JSON.stringify(h));
  assert.match(stallLine(h, 'r-w'), /hang suspected/);
  assert.equal(assess({ root, run, transcripts: tmpdir(), watch: { hangMin: 500 } }).state, 'working', 'hangMin z configu');

  const t0 = Date.now() - 1000;
  writeFileSync(join(root, 'active.json'), JSON.stringify({ cmd: 'verify', pid: deadPid(), start: new Date(t0).toISOString(), end: new Date().toISOString() }));
  assert.equal(assess({ root, run, since: t0 - 1000, transcripts: tmpdir() }).state, 'ended', 'normalny koniec: bez alarmu');
  // markActive/endActive tego procesu.
  markActive(root, 'finish');
  assert.equal(readActive(root).pid, process.pid);
  endActive(root, 'pass');
  assert.deepEqual([readActive(root).cmd, readActive(root).result, !!readActive(root).end], ['finish', 'pass', true]);
  assert.equal(processAlive(process.pid), true);
  assert.equal(processAlive(deadPid()), false);
});

test('watch: krok pracy bez procesu i przyrostu = przestój (zdarzenie stall, jedna linia); pytanie i koniec to nie przestój; przyrost transkryptu żyje', () => {
  const { root, run } = watchRun('implement');
  old(join(root, 'run.json'), 120);
  const tr = mkdtempSync(join(tmpdir(), 'dwmt-tr-'));
  assert.deepEqual([assess({ root, run, transcripts: tr }).state, assess({ root, run, transcripts: tr }).reason], ['stall', 'idle']);
  mkdirSync(join(tr, 'proj', 'sess-x', 'subagents'), { recursive: true });
  writeFileSync(join(tr, 'proj', 'sess-x', 'subagents', 'agent-a.jsonl'), '{}\n');
  assert.equal(assess({ root, run: { ...run, session_ids: ['sess-x'] }, transcripts: tr }).state, 'working', 'agent pisze transkrypt');
  assert.equal(assess({ root, run: { ...run, phase: 'ask' }, transcripts: tr }).state, 'waiting');
  assert.equal(assess({ root, run: { ...run, phase: 'finish', finish: { status: 'red' } }, transcripts: tr }).state, 'waiting');
  const dm = assess({ root, run: { ...run, phase: 'finish', finish: { status: 'deferred-major' } }, transcripts: tr });
  assert.deepEqual([dm.state, dm.reason], ['waiting', 'deferred-major'], 'bramka odłożonych uwag major czeka na użytkownika');
  assert.equal(assess({ root, run: { ...run, finish: { status: 'squashed' } }, transcripts: tr }).state, 'done');

  const lines = [];
  const prev = process.env.DWMT_TRANSCRIPTS;
  process.env.DWMT_TRANSCRIPTS = tr;
  try {
    const r = withHome(() => watchLoop({ load: () => run, root, runId: 'r-w-loop', project: 'D:/x/proj', lang: 'en', interval: 0, maxPolls: 3, write: (s) => lines.push(s) }));
    assert.equal(r.state, 'stall');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^dwmt r-w-loop: step `implement` has stood for \d+ min with nobody doing it.*Needed: /);
    const ev = eventsOf('r-w-loop');
    assert.deepEqual([ev.length, ev[0].type, ev[0].detail.kind], [1, 'stall', 'idle']);
    const quiet = withHome(() => watchLoop({ load: () => ({ ...run, phase: 'ask-plan' }), root, runId: 'r-w-q', project: 'p', interval: 0, maxPolls: 2, write: (s) => lines.push(s) }));
    assert.deepEqual([quiet.state, lines.length], ['waiting', 1], 'czekanie na użytkownika bez linii');
  } finally { if (prev === undefined) delete process.env.DWMT_TRANSCRIPTS; else process.env.DWMT_TRANSCRIPTS = prev; }
});

test('watch CLI: --once daje ocenę JSON; verify przez CLI zapisuje active.json z końcem', () => {
  const { d } = repo28();
  const run = start(d, 'wcli');
  writePlans(d, run);
  assert.equal(state(d, 'sess-1', run).next, 'implement');
  writeFileSync(runFile(d, run, 'result-1.md', 1), header({ schema: 'dwmt/result@1', status: 'DONE' }));
  assert.equal(cliAs(d, 'sess-1', 'verify', run).json.ok, true);
  const act = JSON.parse(readFileSync(join(d, '.dwmt', 'runs', run, 'active.json'), 'utf8'));
  assert.deepEqual([act.cmd, typeof act.pid, !!act.end, act.result], ['verify', 'number', true, 'pass']);
  const once = cliAs(d, 'sess-1', 'watch', run, '--once').json;
  assert.equal(once.state, 'working', JSON.stringify(once));
  assert.equal(RUN(d, run).session_ids.length, 1, 'watch nie dopisuje sesji do run.json');
});

// ---------- nazwy sesji, UAT ----------

test('sessionName: przebieg bez daty, skrócony, T-k/N', () => {
  assert.equal(sessionName({ run: '2026-10-03-sprint-pm-10', tasks: [], task: 3, count: 5 }), 'dwmt sprint-pm-10 · T-3/5');
  assert.equal(sessionName({ run: '2026-10-03-x', sprint: 'S-12', tasks: [], task: 1 }), 'dwmt S-12 · T-1');
  assert.equal(sessionName({ run: '2026-10-03-bardzo-dluga-nazwa-przebiegu-sprintu', tasks: [], task: 2, count: 2 }), 'dwmt bardzo-dluga-nazwa-prze… · T-2/2');
});

test('uat record: odłożone uwagi zaakceptowane zaraz po wyniku tej sesji poprawiają ostatni wpis (bez nowego wpisu)', () => {
  const d = repo();
  const dir = join(d, '.dwmt', 'runs', 'r1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ schema: 'dwmt/run@1', run: 'r1', sprint: 'S9', target: 'master', created: '2026-10-01T00:00:00Z', finish: { status: 'squashed', commit: null, at: '2026-10-01T01:00:00Z' } }));
  writeFileSync(join(dir, 'final-report.md'), `${header({ schema: 'dwmt/final-report@1', run: 'r1', status: 'PASS', goal: 'x', rounds: 1, tests: {}, sessions: [], uat: 'pending', deferred: ['T-1/F-1', 'T-1/F-2'] })}# r\n`);
  assert.equal(cliAs(d, 'sess-u', 'uat', 'start', 'S9').json.ok, true);
  const res = join(d, '..', 'uat-r1.json');
  writeFileSync(res, JSON.stringify({ result: 'positive', findings: [], deferredAccepted: [] }));
  assert.equal(cliAs(d, 'sess-u', 'uat', 'record', 'S9', res).json.ok, true);
  writeFileSync(res, JSON.stringify({ result: 'positive', findings: [], deferredAccepted: ['T-1/F-2'] }));
  const r2 = cliAs(d, 'sess-u', 'uat', 'record', 'S9', res).json;
  assert.equal(r2.ok, true, JSON.stringify(r2));
  const u = hdr(join(dir, 'uat.md'));
  assert.equal(u.entries.length, 1);
  assert.deepEqual(u.deferredAccepted, ['T-1/F-2']);
  assert.match(readFileSync(join(dir, 'uat.md'), 'utf8'), /accepted without a fix \(added\): T-1\/F-2/);
  assert.ok(eventsOf('r1').some((e) => e.type === 'uat-recorded' && e.verdict === 'positive'));
  assert.deepEqual(eventsOf('r1').filter((e) => e.type === 'uat-recorded').map((e) => !!e.detail.merged), [false, true], 'dopisanie uwag do wpisu też jest zdarzeniem');
  // Inna sesja albo wynik z defektem: zwykła ścieżka (bilet wymagany).
  writeFileSync(res, JSON.stringify({ result: 'positive', findings: [], deferredAccepted: ['T-1/F-1'] }));
  assert.equal(cliAs(d, 'sess-other', 'uat', 'record', 'S9', res).json.ok, false, 'inna sesja bez biletu');
});

test('Z10 v2.10: architekt ≤ 30 linii z nowymi regułami; skille execute/run/uat mają jedną regułę push i komunikatów', () => {
  const root = new URL('..', import.meta.url);
  const arch = readFileSync(new URL('templates/agents/dwmt-architect.md', root), 'utf8');
  assert.match(arch, /only when writing them needs code facts you lack/);
  assert.match(arch, /Merge tasks of the same kind in the same area/);
  assert.match(arch, /header `delete`/);
  const exe = readFileSync(new URL('templates/agents/dwmt-executor.md', root), 'utf8');
  assert.match(exe, /\.dwmt\/scratch\//);
  assert.match(exe, /Batch independent reads, greps and edits of different files into one turn/, 'linia batchingu bez zmian (decyzja E)');
  for (const s of ['execute', 'run', 'uat']) {
    const t = readFileSync(new URL(`skills/${s}/SKILL.md`, root), 'utf8');
    assert.equal(t.split(String.fromCharCode(10)).filter((l) => /PushNotification/.test(l)).length, 1, `${s}: jedna reguła push`);
    assert.match(t, /one what you need from them \("nothing" when nothing\)/);
  }
  assert.match(readFileSync(new URL('skills/uat/SKILL.md', root), 'utf8'), /Never run tests, E2E/);
  assert.match(readFileSync(new URL('skills/execute/SKILL.md', root), 'utf8'), /dwmt watch <run>/);
});

test('watch: bez --follow koniec, gdy krok się zmienił, a komenda nie biegnie (watch przy verify nie zostaje w tle); z --follow obserwuje dalej', () => {
  const { root, run } = watchRun('verify');
  const phases = ['verify', 'review', 'review'];
  let n = 0;
  const load = () => ({ ...run, phase: phases[Math.min(n++, phases.length - 1)] });
  const r = watchLoop({ load, root, runId: 'r-w-ph', project: 'p', interval: 0, maxPolls: 3, write: () => {} });
  assert.deepEqual([r.state, r.reason, r.polls], ['ended', 'phase-changed', 2]);
  n = 0;
  const f = watchLoop({ load, root, runId: 'r-w-ph', project: 'p', interval: 0, maxPolls: 3, follow: true, write: () => {} });
  assert.deepEqual([f.state, f.polls], ['working', 3]);
});
