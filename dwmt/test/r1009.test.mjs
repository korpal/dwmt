import './tmp-root.mjs';
// Przegląd 2026-10-09 (docs/przeglad-2026-10-09.md, W-1…W-8): limit tur wykonawcy, jedna naprawa przy finish, alarm ceny,
// cena z rundą zbiorczą i przejście trybu, testy jednostkowe w zadaniu, raporty i koszt sesji wywołującej, sesja PO,
// uczciwość wykonawcy. Sterownik z atrapą `claude` (fixtures-r1009-claude.mjs), reszta przez CLI i funkcje.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { agentArgs, agentOutcome } from '../scripts/drive.mjs';
import { withFindings, qualifiedMet, pendingUat } from '../scripts/lib/report.mjs';
import { worstById } from '../scripts/lib/risks.mjs';
import { attributeCaller, mentionedRuns, callerCost } from '../scripts/lib/sessions.mjs';
import { mPerFile, priceRange, batchShare } from '../scripts/lib/price.mjs';
import { cmdPriceAlert, naiveForecast, upperPrice } from '../scripts/lib/price-alert.mjs';
import { roadmapErrors } from '../scripts/lib/product-store.mjs';
import { progressLine } from '../scripts/watch.mjs';
import { goalCheckState, unitVerifyErrors } from '../scripts/plan.mjs';
import { DWMT_HOME, runFile, gitIn, SCRIPT, repo, header } from './helpers.mjs';
import { NO_TRANSCRIPTS, RUN, PLAN, T2, repo28, start, writePlans, cliAs, hdr, execute } from './fixtures28.mjs';
import { pr, dw, productRepo, write } from './product-helpers.mjs';

process.env.DWMT_HOME = DWMT_HOME;
const DRIVE = fileURLToPath(new URL('../scripts/drive.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures-r1009-claude.mjs', import.meta.url));
const CLAUDE_HOME = mkdtempSync(join(tmpdir(), 'dwmt-ch1009-'));
writeFileSync(join(CLAUDE_HOME, 'settings.json'), '{}');
const events = (run) => (existsSync(join(DWMT_HOME, 'events.jsonl')) ? readFileSync(join(DWMT_HOME, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.run === run) : []);

// Sprint trzech zadań z planami (fixtures28) prowadzony przez sterownik z atrapą agentów.
function driven(slug, { cfg = {}, files = {}, env = {}, init = [], plans = () => ({}) } = {}) {
  const { d } = repo28(cfg, files);
  const run = start(d, slug, ...init);
  writePlans(d, run, plans(run));
  const dir = mkdtempSync(join(tmpdir(), 'dwmt-r1009-'));
  const log = join(dir, 'calls.jsonl');
  const e = { ...process.env, DWMT_CLAUDE: FAKE, FAKE_LOG: log, DWMT_HOME, DWMT_TRANSCRIPTS: NO_TRANSCRIPTS, DWMT_DRIVE_QUIET: '1', DWMT_CLAUDE_HOME: CLAUDE_HOME, ...env };
  delete e.CLAUDE_CODE_SESSION_ID;
  const drive = () => {
    const r = spawnSync(process.execPath, [DRIVE, run], { cwd: d, encoding: 'utf8', env: e });
    return { code: r.status, out: JSON.parse(r.stdout.trim().split(/\r?\n/).pop()), err: r.stderr };
  };
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const driveLog = () => readFileSync(join(d, '.dwmt', 'runs', run, 'drive.log'), 'utf8');
  return { d, run, drive, calls, driveLog, env: e, root: join(d, '.dwmt', 'runs', run) };
}
const reportHead = (d, run) => hdr(runFile(d, run, 'final-report.md'));

// ---------- W-1: limit tur wykonawcy ----------

test('W-1: agentOutcome rozpoznaje limit tur (error_max_turns), argumenty mają --max-turns z roli', () => {
  const o = agentOutcome({ code: 1, out: JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, terminal_reason: 'max_turns', session_id: 's1' }) });
  assert.deepEqual([o.ok, o.cause, o.sessionId], [false, 'max-turns', 's1']);
  assert.equal(agentOutcome({ code: 1, out: '{"is_error":true,"result":"x"}' }).cause, 'error');
  const cfg = { model: 'opus', roles: { executor: { effort: 'medium', maxTurns: 100 }, 'executor-high': { from: 'executor', effort: 'high' }, checker: { effort: 'medium', maxTurns: 40 } } };
  const a = agentArgs({ cfg, agent: 'dwmt-executor-high', prompt: 'x' });
  assert.deepEqual(a.slice(a.indexOf('--max-turns'), a.indexOf('--max-turns') + 2), ['--max-turns', '100'], 'executor-high dziedziczy maxTurns wykonawcy');
  const r = agentArgs({ cfg, agent: 'dwmt-checker', prompt: 'x', resume: 'abc' });
  assert.deepEqual(r.slice(r.indexOf('--max-turns'), r.indexOf('--max-turns') + 2), ['--max-turns', '40']);
});

test('W-1: wykonawca zatrzymany limitem tur → świeży wykonawca kontynuuje (continue), sprint do końca; linia w drive.log', () => {
  const s = driven('mt', { env: { FAKE_MAXTURNS: '1' } });
  const r = s.drive();
  assert.equal(r.out.status, 'done', JSON.stringify(r));
  const cs = s.calls();
  assert.ok(cs.every((c) => c.maxTurns), 'każdy agent dostaje --max-turns');
  assert.equal(cs.find((c) => c.agent === 'dwmt-executor').maxTurns, '100');
  assert.equal(cs.find((c) => c.agent === 'dwmt-reviewer').maxTurns, '200');
  assert.equal(cs.find((c) => c.agent === 'dwmt-checker').maxTurns, '40');
  const t1 = cs.filter((c) => c.agent.startsWith('dwmt-executor') && c.k === 1);
  assert.equal(t1.length, 2);
  assert.match(t1[1].prompt, /Continue interrupted work: start from progress\.md and diff\.patch/);
  assert.match(s.driveLog(), /T-1 r1 implement: dwmt-executor doszedł do limitu 100 tur → świeży wykonawca kontynuuje od progress\.md \(1\/5\)/);
  assert.ok(!events(s.run).some((e) => e.type === 'drive-stop' && e.detail?.status !== 'done'), 'bez zatrzymania po drodze');
  // Recenzja poprawek: licznik odcinków per runda w drive.json (przeżywa ponowny start sterownika).
  assert.equal(JSON.parse(readFileSync(join(s.root, 'drive.json'), 'utf8')).cuts['T-1/r1'], 1);
});

test('W-1: bezpiecznik drive.maxTurnRestarts: kolejny limit tur w tej samej rundzie zatrzymuje sterownik (cause max-turns)', () => {
  const tr = mkdtempSync(join(tmpdir(), 'dwmt-tr1009-'));
  const s = driven('mt2', { cfg: { drive: { maxTurnRestarts: 1 } }, init: ['--estimate', '0.5,1.5'], env: { FAKE_MAXTURNS: '5', FAKE_TR: tr, DWMT_TRANSCRIPTS: tr } });
  const r = s.drive();
  assert.deepEqual([r.out.status, r.out.cause], ['stopped', 'max-turns'], JSON.stringify(r.out));
  assert.equal(s.calls().filter((c) => c.agent.startsWith('dwmt-executor')).length, 2);
  // Recenzja poprawek (9): alarm ceny także po kroku, który kończy się zatrzymaniem, przed zdarzeniem końca.
  const ev = events(s.run);
  const ai = ev.findIndex((e) => e.type === 'price-alert');
  assert.ok(ai >= 0 && ai < ev.findIndex((e) => e.type === 'drive-stop'), JSON.stringify(ev.map((e) => e.type)));
});

// ---------- W-2: jedna naprawa przy finish ----------

const CHECK = "import { existsSync } from 'node:fs';\nprocess.exit(existsSync('fixed.txt') ? 0 : 1);\n";
const humanT2 = (run) => T2(run).replace('- Method: test 150 is rejected (AC-2)', '- Method: human check that the summary shows -10% (AC-2)');

test('W-2: czerwona pełna suita → jedna naprawa świeżym wykonawcą, commit poprawki, finish ponawia czerwone komendy; raport: finishRepair i odstępstwo (W-6: met pending UAT)', () => {
  const s = driven('rep', { cfg: { verify: { full: ['node check.mjs'], targeted: ['node -e 0'] } }, files: { 'check.mjs': CHECK }, plans: (run) => ({ t2: humanT2(run) }) });
  const r = s.drive();
  assert.equal(r.out.status, 'done', JSON.stringify(r));
  const rep = s.calls().filter((c) => /^Finish repair/.test(c.prompt));
  assert.equal(rep.length, 1);
  assert.equal(rep[0].agent, 'dwmt-executor-high');
  assert.match(rep[0].prompt, /the full suite is red: `node check\.mjs`.*never weaken, skip or delete a test/);
  const rj = RUN(s.d, s.run);
  assert.deepEqual([rj.finish.status, rj.finishRepair.kind, rj.finishRepair.result], ['squashed', 'red', 'committed']);
  assert.deepEqual(rj.fullVerify.rerun, ['node check.mjs'], 'po naprawie tylko czerwona komenda');
  assert.ok(existsSync(join(s.d, 'fixed.txt')), 'poprawka weszła w squash');
  const h = reportHead(s.d, s.run);
  assert.deepEqual([h.finishRepair.kind, h.finishRepair.result], ['red', 'committed']);
  assert.deepEqual(h.finishRepair.changes, ['fixed.txt: the marker the full suite check needs']);
  assert.ok(h.deviations.some((x) => /^finish repair \(red full suite: node check\.mjs\) → committed: fixed\.txt: .*; review this change$/.test(x)), JSON.stringify(h.deviations));
  assert.match(s.driveLog(), /naprawa przy finish \(red\) start: node check\.mjs[\s\S]*naprawa przy finish → committed/);
  // W-6: kryterium dowodzone tylko ryzykiem human → met pending UAT, lista UAT, uat pending.
  assert.ok(h.coverage.some((c) => /^AC-2 met pending UAT \(UAT: R-1\)/.test(c)), JSON.stringify(h.coverage));
  assert.equal(h.uat, 'pending');
  assert.match(readFileSync(runFile(s.d, s.run, 'final-report.md'), 'utf8'), /- Criterion only you can confirm: AC-2 summary shows the discount \(met pending UAT/);
  assert.equal(h.status, 'PASS', 'pending UAT nie obniża wyniku');
});

test('W-2: naprawa BLOCKED → stop dla użytkownika; drugie uruchomienie sterownika nie powtarza naprawy (jedna próba na przebieg)', () => {
  const s = driven('rep2', { cfg: { verify: { full: ['node check.mjs'], targeted: ['node -e 0'] } }, files: { 'check.mjs': CHECK }, env: { FAKE_REPAIR_BLOCKED: '1' } });
  const r = s.drive();
  assert.equal(r.out.status, 'waiting-user', JSON.stringify(r.out));
  assert.match(r.out.reason, /finish red; naprawa przy finish: blocked/);
  assert.equal(RUN(s.d, s.run).finishRepair.result, 'blocked');
  const again = s.drive();
  assert.equal(again.out.status, 'waiting-user');
  assert.equal(s.calls().filter((c) => /^Finish repair/.test(c.prompt)).length, 1);
  assert.equal(cliAs(s.d, 'sess-1', 'finish-repair', s.run).json.ok, false, 'finish-repair drugi raz: odmowa');
});

test('W-2: konflikt rebase przy finish → agent rozwiązuje znaczniki, skrypt kończy rebase (bez -X ours/theirs), finish scala; odstępstwo w raporcie', () => {
  const s = driven('cfl', { env: { FAKE_CONFLICT: '1' } });
  const r = s.drive();
  assert.equal(r.out.status, 'done', JSON.stringify(r));
  const rep = s.calls().filter((c) => /^Finish repair/.test(c.prompt));
  assert.equal(rep.length, 1);
  assert.match(rep[0].prompt, /stopped on conflicts in: src\/billing\/discount\.ts\. The rebase is in progress/);
  const rj = RUN(s.d, s.run);
  assert.deepEqual([rj.finish.status, rj.finishRepair.kind, rj.finishRepair.result], ['squashed', 'conflict', 'resolved']);
  assert.deepEqual(rj.finishRepair.files, ['src/billing/discount.ts']);
  const g = gitIn(s.d);
  assert.equal(g('show', 'master:src/billing/discount.ts'), 'export class Discount { constructor(percent) { this.percent = percent; } }\nexport const sprintDiscount = true;');
  assert.ok(reportHead(s.d, s.run).deviations.some((x) => /^finish repair \(rebase conflict in src\/billing\/discount\.ts\) → resolved/.test(x)));
});

test('poprawki recenzji: konflikt w dwóch commitach gałęzi → dwa postoje rebase w jednej próbie, drugi u tego samego agenta (resume); scalenie', () => {
  const s = driven('cfl2', { env: { FAKE_CONFLICT: '1', FAKE_CONFLICT2: '1' } });
  const r = s.drive();
  assert.equal(r.out.status, 'done', JSON.stringify(r));
  const rep = s.calls().filter((c) => /^Finish repair/.test(c.prompt));
  assert.equal(rep.length, 2);
  assert.match(rep[1].prompt, /conflicts in: src\/summary\/view\.ts\. The rebase is in progress and these files hold conflict markers\. This is stop 2/);
  assert.ok(rep[1].resume, 'drugi postój: ta sama sesja agenta');
  const rj = RUN(s.d, s.run);
  assert.deepEqual([rj.finish.status, rj.finishRepair.result, rj.finishRepair.stops], ['squashed', 'resolved', 2]);
  assert.deepEqual(rj.finishRepair.files, ['src/billing/discount.ts', 'src/summary/view.ts']);
  assert.equal(gitIn(s.d)('show', 'master:src/summary/view.ts'), 'export const view = () => "-10% (both)";');
  assert.ok(existsSync(join(s.root, 'finish', 'repair-1.md')), 'wynik pierwszego postoju zachowany');
});

test('poprawki recenzji: rozwiązanie równe celowi (commit pusty po rozwiązaniu) → rebase kończy się bez błędu, scalenie', () => {
  const s = driven('cfl3', { env: { FAKE_CONFLICT: '1', FAKE_RESOLVE_TARGET: '1' } });
  const r = s.drive();
  assert.equal(r.out.status, 'done', JSON.stringify(r));
  assert.equal(RUN(s.d, s.run).finishRepair.result, 'resolved');
});

test('poprawki recenzji: sterownik zginął w trakcie naprawy (rebase w toku) → następny start cofa rebase i staje z „repair interrupted”, bez nowej próby', () => {
  const s = driven('die', { env: { FAKE_CONFLICT: '1', FAKE_REPAIR_DIE: '1' } });
  spawnSync(process.execPath, [DRIVE, s.run], { cwd: s.d, encoding: 'utf8', env: s.env });
  assert.ok(existsSync(join(s.d, '.git', 'rebase-merge')), 'rebase został w toku');
  assert.equal(RUN(s.d, s.run).finishRepair.result, 'started');
  delete s.env.FAKE_REPAIR_DIE;
  const r = s.drive();
  assert.deepEqual([r.out.status, r.out.cause], ['waiting-user', 'repair-interrupted'], JSON.stringify(r.out));
  assert.match(r.out.reason, /repair interrupted: the finish repair \(conflict\) was interrupted; rebase onto master undone; no new attempt/);
  assert.ok(!existsSync(join(s.d, '.git', 'rebase-merge')));
  assert.equal(gitIn(s.d)('branch', '--show-current'), `dwmt/${s.run}`);
  assert.equal(RUN(s.d, s.run).finishRepair.result, 'interrupted');
  assert.equal(s.calls().filter((c) => /^Finish repair/.test(c.prompt)).length, 1);
});

test('poprawki recenzji: limit abonamentu w trakcie naprawy → zmiany w schowku, próba nie przepada; po odnowieniu nowa próba z informacją o schowku', () => {
  const tr = mkdtempSync(join(tmpdir(), 'dwmt-tr1009-'));
  const s = driven('lim', { cfg: { verify: { full: ['node check.mjs'], targeted: ['node -e 0'] } }, files: { 'check.mjs': CHECK }, env: { FAKE_TR: tr, DWMT_TRANSCRIPTS: tr, FAKE_REPAIR_LIMIT: '1' } });
  const r = s.drive();
  assert.deepEqual([r.out.status, r.out.cause], ['stopped', 'limit'], JSON.stringify(r.out));
  let rj = RUN(s.d, s.run);
  assert.equal(rj.finishRepair, undefined, 'próba nie zużyta');
  assert.match(rj.finishRepairInterrupted[0].stash, /^dwmt finish-repair /);
  assert.equal(gitIn(s.d)('status', '--porcelain'), '', 'drzewo czyste');
  assert.match(gitIn(s.d)('stash', 'list'), /dwmt finish-repair/);
  // Po odnowieniu limitu (transkrypt bez błędu limitu) sterownik rusza od finish i naprawia od nowa.
  for (const f of readdirSync(join(tr, 'p'))) if (readFileSync(join(tr, 'p', f), 'utf8').includes('rate_limit')) writeFileSync(join(tr, 'p', f), '');
  delete s.env.FAKE_REPAIR_LIMIT;
  const r2 = s.drive();
  assert.equal(r2.out.status, 'done', JSON.stringify(r2));
  rj = RUN(s.d, s.run);
  assert.equal(rj.finishRepair.result, 'committed');
  const rep = s.calls().filter((c) => /^Finish repair/.test(c.prompt));
  assert.equal(rep.length, 2);
  assert.match(rep[1].prompt, /An earlier attempt was interrupted; its changes are in the git stash "dwmt finish-repair /);
});

test('poprawki recenzji: nowy plik, którego wynik naprawy nie nazywa (wyjście testu), idzie do nazwanego schowka git, nie do commita; finish scala; raport go wymienia', () => {
  const s = driven('stray', { cfg: { verify: { full: ['node check.mjs'], targeted: ['node -e 0'] } }, files: { 'check.mjs': CHECK }, env: { FAKE_STRAY: '1' } });
  const r = s.drive();
  assert.equal(r.out.status, 'done', JSON.stringify(r.out));
  const rj = RUN(s.d, s.run);
  assert.deepEqual([rj.finish.status, rj.finishRepair.result, rj.finishRepair.untracked], ['squashed', 'committed', ['stray.out']]);
  const g = gitIn(s.d);
  assert.ok(existsSync(join(s.d, 'fixed.txt')));
  assert.ok(!existsSync(join(s.d, 'stray.out')), 'poza drzewem');
  assert.throws(() => g('show', 'master:stray.out'), 'nie w scaleniu');
  assert.match(g('stash', 'list'), new RegExp(`dwmt finish-repair ${s.run} untracked`));
  assert.match(g('show', '--name-only', '--format=', 'stash@{0}^3'), /^stray\.out$/m, 'plik do odzyskania ze schowka');
  const h = reportHead(s.d, s.run);
  assert.deepEqual(h.finishRepair.untracked, ['stray.out']);
  assert.ok(h.deviations.some((x) => x.includes(`untracked → stash "dwmt finish-repair ${s.run} untracked": stray.out`)), JSON.stringify(h.deviations));
});

test('W-2: finish-repair bez czerwieni ani konfliktu → odmowa z powodem', () => {
  const { d } = repo28();
  const run = start(d, 'nofin');
  const o = cliAs(d, 'sess-1', 'finish-repair', run).json;
  assert.equal(o.ok, false);
  assert.match(o.error, /tylko po finish red albo conflict/);
});

// ---------- W-3: alarm ceny ----------

test('W-3: koszt ponad górną cenę → raz zdarzenie price-alert (prognoza), run.priceAlert, linia wait --progress z push; sprint idzie dalej', () => {
  const tr = mkdtempSync(join(tmpdir(), 'dwmt-tr1009-'));
  const s = driven('alarm', { init: ['--estimate', '0.5,1.5'], env: { FAKE_TR: tr, DWMT_TRANSCRIPTS: tr } });
  const r = s.drive();
  assert.equal(r.out.status, 'done', JSON.stringify(r));
  const al = events(s.run).filter((e) => e.type === 'price-alert');
  assert.equal(al.length, 1, 'raz');
  assert.deepEqual([al[0].costM, al[0].detail.upperM, al[0].detail.basis], [2, 1.5, 'estimate']);
  const pa = RUN(s.d, s.run).priceAlert;
  assert.deepEqual([pa.costM, pa.upperM], [2, 1.5]);
  assert.deepEqual(reportHead(s.d, s.run).priceAlert.upperM, 1.5);
  assert.match(s.driveLog(), /alarm ceny: koszt 2 mln > górna cena 1\.5 mln; sprint idzie dalej/);
  const lines = [];
  for (let i = 0; i < 12; i++) {
    const o = spawnSync(process.execPath, [SCRIPT, 'wait', s.run, '--interval', '0.1', '--progress'], { cwd: s.d, encoding: 'utf8', env: s.env });
    const w = JSON.parse(o.stdout.trim().split(/\r?\n/).pop());
    if (w.status !== 'progress') break;
    lines.push(w);
  }
  const p = lines.find((w) => w.push);
  assert.ok(p, JSON.stringify(lines));
  assert.match(p.reason, /^⚠ sprint cost 2 M passed the upper price 1\.5 M; the sprint goes on$/);
});

test('W-3: cmdPriceAlert: górna cena projektu (design), prognoza po zadaniach, raz; linia postępu po polsku', () => {
  const { d } = repo28();
  const run = start(d, 'pa');
  const f = runFile(d, run, 'run.json');
  const rj = JSON.parse(readFileSync(f, 'utf8'));
  rj.price = { design: [3, 10], estimate: [5, 20] };
  rj.tasks[0].commit = 'abc';
  rj.count = 4;
  writeFileSync(f, JSON.stringify(rj));
  assert.deepEqual(upperPrice(rj), { upperM: 10, basis: 'design' });
  assert.deepEqual(naiveForecast(12, rj), { forecastM: 48, done: 1, tasks: 4 });
  assert.equal(cmdPriceAlert(d, run, { costFn: () => ({ total: 9 }) }).alert, undefined, 'poniżej ceny: bez alarmu');
  const a = cmdPriceAlert(d, run, { costFn: () => ({ total: 12 }) });
  assert.deepEqual([a.alert, a.priceAlert.forecastM], [true, 48]);
  assert.equal(cmdPriceAlert(d, run, { costFn: () => ({ total: 20 }) }).already, true);
  const e = events(run).find((x) => x.type === 'price-alert');
  assert.equal(progressLine(e, 4, 'pl'), '⚠ koszt sprintu 12 mln przekroczył górną cenę 10 mln, prognoza ok. 48 mln (po 1/4 zadaniach); sprint idzie dalej');
});

// ---------- W-4: cena z rundą zbiorczą, przejście trybu, nowy obszar ----------

test('W-4: udział rundy zbiorczej z historii (mediana, inaczej 0,15) w cenie; koszt na plik z historii bez partii', () => {
  const runs = [[10, 2, 50], [20, 4, 100], [30, 3, 100], [8, null, 40]].map(([c, b, f], i) => ({ run: `r${i}`, mode: 'single', costM: c, batchM: b, files: f, mPerFile: c / f, mPerFileTasks: (c - (b ?? 0)) / f }));
  assert.deepEqual(batchShare(runs), { share: 0.2, basis: 'batch +20% n=3' });
  const k = mPerFile(runs, 'single', null);
  assert.equal(k.share, 0.2);
  assert.match(k.basis, /^single n=4; batch \+20% n=3$/);
  assert.deepEqual([k.lo, k.hi], [0.16, 0.22]);
  assert.deepEqual(priceRange([10, 20], k), [1.9, 5.3]);
  assert.deepEqual(batchShare([]), { share: 0.15, basis: 'batch +15% default' });
  assert.deepEqual(priceRange([10, 10], mPerFile([], 'single', null)), [2.3, 2.3]);
});

test('W-4: tryb pośredni: szacunek architekta ponad próg plików i podział na zadania → przebieg single (modeSwitch, bez modeLabel); poniżej progu dalej jedno zadanie', () => {
  const { d } = repo28();
  const run = start(d, 'sw', '--mode', 'intermediate');
  assert.equal(RUN(d, run).intermediateMaxFiles, 60);
  const withFiles = (files) => PLAN(run).replace('\ntasks:', `\nfiles: ${JSON.stringify(files)}\ntasks:`);
  writePlans(d, run, { plan: withFiles([10, 20]) });
  let st = cliAs(d, 'sess-1', 'state', run).json;
  assert.equal(st.next, 'plan');
  assert.match(st.prompt, /mode intermediate: the sprint is exactly one task \(T-1\).*when your files estimate exceeds 60, keep the tasks/);
  writePlans(d, run, { plan: withFiles([80, 130]) });
  st = cliAs(d, 'sess-1', 'state', run).json;
  assert.notEqual(st.next, 'plan', JSON.stringify(st));
  assert.equal(st.modeSwitch, 'intermediate → single: architect estimate 80-130 files > 60 (intermediate limit), 3 tasks');
  const rj = RUN(d, run);
  assert.equal(rj.modeLabel, undefined);
  assert.deepEqual([rj.mode, rj.modeSwitch.from, rj.modeSwitch.to], ['single', 'intermediate', 'single']);
  assert.equal(cliAs(d, 'sess-1', 'state', run).json.modeSwitch, undefined, 'raz');
  assert.ok(events(run).some((e) => e.type === 'mode-switch'));
});

test('W-4: start-check pamięta nowy obszar sprintu: bez pustego globu nadal new-area (nie intermediate), dopóki obszar nie ma plików', () => {
  const d = productRepo(repo);
  write(d, 'src/mid/a.ts', 'x'.repeat(400000));
  gitIn(d)('add', '-A'); gitIn(d)('commit', '-q', '-m', 'code');
  assert.equal(pr(d, 'roadmap', 'add', 'pm-n', '--goal', 'New area').json.ok, true);
  assert.equal(pr(d, 'spec', 'new', 'pm-n').json.ok, true);
  let c = pr(d, 'start-check', '--spec', 'pm-n', '--globs', 'src/mid/**,src/new/**').json;
  assert.deepEqual([c.risks, c.recommend], [['new-area'], 'single']);
  c = pr(d, 'start-check', '--spec', 'pm-n', '--globs', 'src/mid/**').json;
  assert.deepEqual([c.risks, c.recommend, c.emptyGlobs], [['new-area'], 'single', ['src/new/**']], 'zapamiętany glob nowego obszaru');
  write(d, 'src/new/b.ts', 'export const b = 1;\n');
  gitIn(d)('add', '-A'); gitIn(d)('commit', '-q', '-m', 'area');
  c = pr(d, 'start-check', '--spec', 'pm-n', '--globs', 'src/mid/**').json;
  assert.deepEqual(c.risks, [], 'obszar ma już pliki');
});

// ---------- W-5: testy jednostkowe obszaru w zadaniu ----------

test('W-5: verify.unit: plan zadania zmieniającego obszar bez jego komendy testów → błąd walidacji ze składnią; z komendą przechodzi; bez configu reguła w prompcie architekta', () => {
  const bad = repo28({ verify: { full: ['node -e 0'], targeted: ['node -e 0'], unit: [{ glob: 'src/billing/**', cmd: 'npm run unit --' }] } });
  const run = start(bad.d, 'u1');
  let st = cliAs(bad.d, 'sess-1', 'state', run).json;
  assert.match(st.prompt, /Unit tests by area: a task that changes `src\/billing\/\*\*` runs `npm run unit -- <its test files or pattern>` in its verify/);
  writePlans(bad.d, run);
  st = cliAs(bad.d, 'sess-1', 'state', run).json;
  assert.equal(st.next, 'plan');
  assert.match(st.prompt, /T-1: verify: zadanie zmienia src\/billing\/discount\.ts \(\+1\), a żadna komenda nie uruchamia testów jednostkowych tego obszaru: dodaj `npm run unit -- <pliki albo wzorzec testów>`/);
  assert.doesNotMatch(st.prompt, /T-2: verify: zadanie zmienia/, 'T-2 nie dotyka obszaru');
  const ok = repo28({ verify: { full: ['node -e 0'], targeted: ['node -e 0'], unit: [{ glob: 'src/billing/**', cmd: 'node -e "1"' }] } });
  const run2 = start(ok.d, 'u2');
  writePlans(ok.d, run2);
  assert.equal(cliAs(ok.d, 'sess-1', 'state', run2).json.next, 'implement');
  const none = repo28();
  const run3 = start(none.d, 'u3');
  assert.match(cliAs(none.d, 'sess-1', 'state', run3).json.prompt, /A task that changes source files runs, in its verify, the unit tests of every stack it touches/);
  assert.deepEqual(unitVerifyErrors({ verify: ['npm run unit -- a.test.ts'] }, ['src/billing/a.ts'], { verify: { unit: [{ glob: 'src/billing/**', cmd: 'npm run unit --' }] } }), []);
});

// ---------- W-6: raporty i koszt ----------

test('W-6: scalenie jednostek: gołe met wygrywa z met z zastrzeżeniem, pending UAT zostaje, partial jak dotąd', () => {
  assert.deepEqual(worstById([['AC-7 met in the backend (lock needs CLOSED)'], ['AC-7 met']]), ['AC-7 met']);
  assert.deepEqual(worstById([['AC-7 met'], ['AC-7 met in the backend']]), ['AC-7 met']);
  assert.deepEqual(worstById([['AC-3 met'], ['AC-3 met pending UAT (R-2)']]), ['AC-3 met pending UAT (R-2)']);
  assert.deepEqual(worstById([['AC-1 met'], ['AC-1 partial: x']]), ['AC-1 partial: x']);
  assert.deepEqual(worstById([['AC-2 met (F-2 resolved)'], ['AC-2 met in unit b']]), ['AC-2 met (F-2 resolved)']);
});

test('W-6: status bez powodu dostaje F-n z tabeli recenzji; met; z zastrzeżeniem po średniku → partial; tylko ryzyko human → met pending UAT', () => {
  const review = '| AC-4 | partial — the invoice steps are never reached (F-9); totals can be lost (F-10) |\n- Impact: AC-4 fails (F-3)\n';
  assert.equal(withFindings('AC-4 partial', review), 'AC-4 partial (F-9, F-10)');
  assert.equal(withFindings('AC-4 partial: missing invoice', review), 'AC-4 partial: missing invoice', 'z powodem bez zmian');
  assert.equal(withFindings('AC-5 met', review), 'AC-5 met');
  assert.equal(qualifiedMet('AC-7 (totals, tax lines) met; Discount row below the fold, not decided by the screens'), 'AC-7 partial: (totals, tax lines) met; Discount row below the fold, not decided by the screens');
  assert.equal(qualifiedMet('AC-9 met (w granicy D-17; krawędzie F-3)'), 'AC-9 met (w granicy D-17; krawędzie F-3)');
  assert.equal(qualifiedMet('AC-1 met: green; both screens met'), 'AC-1 met: green; both screens met');
  // Recenzja poprawek: linie w kształcie statusów z recenzji — obniża tylko zastrzeżenie ograniczające bez dowodów po `met:`.
  const keep = [
    'AC-7 (part) met: the invoice builder and the credit-note wrapper throw TaxRateError on a bad rate, pinned by src/billing/tax.test.ts:120-148; rates.ts now loads under Node ESM (rates.ts:3); the 422 TAX_RATE_INVALID response is unchanged since round 1',
    "AC-6 met: one 'Export' button in the toolbar; the menu holds the format field with ↓ (off when empty), 'or', 'Download CSV' and 'Send by e-mail'; no second toolbar",
    "AC-1 (part) met for the paid-invoice state: line numbers, 'Total', 'Tax summary', 'Download', footer 'Paid · Bank transfer' with date; discount, credit note, reminder and draft not on this screen",
    'AC-8 met: the four invoice-export* screenshots come from green billing-e2e; red verify e2e are from causes outside the diff (unchanged from round 1)',
    'AC-9 met (gap: a discount applied to an invoice cancelled meanwhile is never reversed, F-4)',
  ];
  for (const x of keep) assert.equal(qualifiedMet(x), x);
  assert.equal(qualifiedMet('AC-4 met in the backend; e2e never reached the step (F-2)'), 'AC-4 partial: met in the backend; e2e never reached the step (F-2)');
  assert.equal(qualifiedMet('AC-2 met; both screens updated'), 'AC-2 met; both screens updated', 'reszta bez ograniczenia');
  const human = { id: 'R-2', method: 'human', text: '### R-2 [high] Invoice totals readable on print (AC-3)\n- Method: human' };
  const tst = { id: 'R-1', method: 'test', text: '### R-1 ranking (AC-3)\n- Method: test' };
  assert.equal(pendingUat('AC-3 met', [human]), 'AC-3 met pending UAT (UAT: R-2)');
  assert.equal(pendingUat('AC-3 met', [human, tst]), 'AC-3 met', 'jest też dowód testem');
  assert.equal(pendingUat('AC-3 partial', [human]), 'AC-3 partial');
});

test('W-6: koszt sesji wywołującej według tur: wzmianka przebiegu w turze, podział przy dwóch, kopie sesji kontynuowanej raz, okno życia przebiegu', () => {
  const root = mkdtempSync(join(tmpdir(), 'dwmt-callers-'));
  mkdirSync(join(root, 'p'), { recursive: true });
  const A = '2026-10-01-a';
  const B = '2026-10-01-b';
  const user = (t, text) => ({ type: 'user', timestamp: t, message: { role: 'user', content: text } });
  const result = (t) => ({ type: 'user', timestamp: t, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } });
  const call = (t, rid, m, cmd = null) => ({ type: 'assistant', timestamp: t, requestId: rid, message: { usage: { input_tokens: m * 1e6 }, content: cmd ? [{ type: 'tool_use', name: 'Bash', input: { command: cmd } }] : [{ type: 'text', text: 'ok' }] } });
  const l1 = [
    user('2026-10-01T10:00:00Z', 'start'), call('2026-10-01T10:01:00Z', 'r1', 1, `dwmt state ${A}`), result('2026-10-01T10:02:00Z'), call('2026-10-01T10:03:00Z', 'r2', 1),
    user('2026-10-01T11:00:00Z', 'other'), call('2026-10-01T11:01:00Z', 'r3', 2, `dwmt state ${B}`),
    user('2026-10-01T12:00:00Z', 'both'), call('2026-10-01T12:01:00Z', 'r4', 2, `dwmt wait ${A}; dwmt wait ${B}`),
    user('2026-10-01T12:30:00Z', 'chat'), call('2026-10-01T12:31:00Z', 'r6', 5),
  ];
  writeFileSync(join(root, 'p', 'po-1.jsonl'), [...l1, { type: 'system', continuedInSessionId: 'po-2' }].map((x) => JSON.stringify(x)).join('\n'));
  const l2 = [l1[0], l1[1], user('2026-10-01T13:00:00Z', 'finish'), call('2026-10-01T13:01:00Z', 'r5', 1, `node dwmt.mjs finish ${A}`)];
  writeFileSync(join(root, 'p', 'po-2.jsonl'), l2.map((x) => JSON.stringify(x)).join('\n'));
  const known = [A, B, '2026-10-01-a-2'];
  assert.deepEqual(mentionedRuns(`dwmt state ${A}-2`, known), ['2026-10-01-a-2'], 'przedrostek innego przebiegu to nie wzmianka');
  assert.equal(callerCost(['po-1', 'po-2'], A, known, null, root), 4, 'r1+r2 (tura A), połowa r4, r5; r1 z kopii raz; tura bez wzmianki (r6) poza');
  assert.equal(callerCost(['po-1', 'po-2'], B, known, null, root), 3);
  assert.equal(callerCost(['po-1'], A, known, { from: '2026-10-01T09:00:00Z', to: '2026-10-01T12:20:00Z' }, root), 3, 'po końcu przebiegu nic');
  assert.equal(attributeCaller([{ t: '1', kind: 'call', cost: 1 }, { t: '2', kind: 'mention', runs: [A] }], A), 1, 'wywołanie przed pierwszą wzmianką tury należy do niej');
});

test('W-6: kontrola celu: stan końcowy kryteriów i sprint następczy (second) w prompcie', () => {
  const top = mkdtempSync(join(tmpdir(), 'dwmt-gc-'));
  const root = join(top, '.dwmt', 'runs', 'r1');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'plan.md'), `${header({ schema: 'dwmt/plan@1', run: 'r1', goal: 'g', acceptance: ['AC-1 a'], tasks: ['T-1'], second: 'size: factory templates move to the follow-up sprint (D-14)', questions: [] })}# g\n`);
  const st = goalCheckState({ root, run: { run: 'r1', rules: '2.10', tasks: [] }, cfg: { language: 'pl', verify: { full: [] } }, st: {}, finalAc: () => ['AC-1 met (fix batch review)', 'AC-2 partial'] });
  assert.equal(st.next, 'goal-check');
  assert.match(st.prompt, /Final state of the sprint criteria after the fix batch \(it supersedes the statuses in the task reports\): AC-1 met \(fix batch review\); AC-2 partial\./);
  assert.match(st.prompt, /planned follow-up sprint \(second: size: factory templates move to the follow-up sprint \(D-14\)\): an input element it moves there is `out` with the reason "planned follow-up sprint", not a gap\./);
});

// ---------- W-7: sesja PO ----------

test('W-7: setup dopisuje wyłącznik T-OOM1 do env w .claude/settings.json (scalenie), --check go zgłasza; brief w sesji bez niego mówi o restarcie', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(node:*)'] }, env: { FOO: '1' } }));
  const s = dw(d, ['setup']).json;
  assert.deepEqual(s.sessionEnv.wrote, ['CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP']);
  const j = JSON.parse(readFileSync(join(d, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(j, { permissions: { allow: ['Bash(node:*)'] }, env: { FOO: '1', CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP: '1' } });
  assert.equal(dw(d, ['setup']).json.sessionEnv.wrote, undefined, 'drugi raz bez zapisu');
  assert.equal(dw(d, ['setup', '--check']).json.sessionEnv.ok, true);
  // Recenzja poprawek: settings.json z komentarzem nie jest przepisywany; wynik podaje linię do dopisania.
  const c = repo();
  mkdirSync(join(c, '.claude'), { recursive: true });
  const withComment = '{\n  // moje\n  "permissions": {}\n}\n';
  writeFileSync(join(c, '.claude', 'settings.json'), withComment);
  const sc = dw(c, ['setup']).json;
  assert.equal(sc.sessionEnv.ok, false);
  assert.match(sc.sessionEnv.error, /nie jest czystym JSON.*"CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP": "1"/);
  assert.equal(readFileSync(join(c, '.claude', 'settings.json'), 'utf8'), withComment);
  // Recenzja poprawek (W-5): pełna suita z runnerem testów jednostkowych bez verify.unit → ostrzeżenie setup --check.
  writeFileSync(join(c, '.claude', 'dwmt.json'), JSON.stringify({ verify: { full: ['mvn test', 'npm --prefix frontend run test'] } }));
  assert.ok(dw(c, ['setup', '--check']).json.warnings.some((w) => /^verify\.unit pusty, a verify\.full uruchamia testy jednostkowe \(npm --prefix frontend run test\)/.test(w)));
  writeFileSync(join(c, '.claude', 'dwmt.json'), JSON.stringify({ verify: { full: ['npm --prefix frontend run test'], unit: [{ glob: 'frontend/src/**', cmd: 'npm --prefix frontend run test --' }] } }));
  assert.equal(dw(c, ['setup', '--check']).json.warnings, undefined);
  const p = productRepo(repo);
  assert.match(dw(p, ['product', 'brief'], { CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP: '' }).out, /^context: this session started without CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1/m);
  assert.doesNotMatch(dw(p, ['product', 'brief'], { CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP: '1' }).out, /BG_SHELL_PRESSURE_REAP/);
});

test('W-7: sprint poprawek z uwag: spec fix (bug i remark, kind bugfix, gotowy), kind fix = bugfix, ready --direct → ready-check bez flagi ok, naprawa linii topic', () => {
  const d = productRepo(repo);
  pr(d, 'item', 'add', '--type', 'remark', '--title', 'Wrong message on a locked rename');
  pr(d, 'item', 'add', '--type', 'bug', '--title', 'Preview stays blank');
  pr(d, 'item', 'add', '--type', 'feature', '--title', 'New screen');
  assert.match(pr(d, 'spec', 'fix', 'B-1', 'B-3').json.error, /B-3: typ feature, sprint poprawek bierze bug\|remark/);
  const f = pr(d, 'spec', 'fix', 'B-1', 'B-2', '--id', 'fix-r', '--goal', 'Review remarks').json;
  assert.equal(f.ok, true, JSON.stringify(f));
  assert.match(f.line, /^fix-r · ready · Review remarks/);
  const sp = pr(d, 'sprint', 'fix-r', '--json').json;
  assert.equal(sp.header.kind, 'bugfix');
  // K5 D-19: one criterion, item ids only (titles stay in the backlog).
  assert.match(sp.body, /Resolve the 2 listed items: B-1, B-2\./);
  assert.match(sp.body, /- AC-1 Each listed item is resolved: a bug no longer happens/);
  // The file has ids only; `product sprint` expands the titles.
  assert.doesNotMatch(sp.body.split('## Items (expanded)')[0], /AC-2|Wrong message on a locked rename/);
  assert.match(sp.body, /## Items \(expanded\)\n- B-1 remark .*Wrong message on a locked rename/);
  assert.equal(pr(d, 'ready-check', 'fix-r').json.ok, true);
  assert.equal(pr(d, 'roadmap', 'add', 'pm-x', '--goal', 'Something').json.ok, true);
  assert.equal(pr(d, 'spec', 'new', 'pm-x', '--kind', 'fix').json.ok, true);
  assert.equal(pr(d, 'sprint', 'pm-x', '--json').json.header.kind, 'bugfix');
  // ready --direct z ceną startu: ready-check bez flagi daje ten sam wynik.
  write(d, 'body.md', '## Goal\nSomething\n\n## Acceptance\n- AC-1 works\n\n## Out of scope\n- nothing\n');
  assert.equal(pr(d, 'spec', 'set', 'pm-x', 'est', 'start:[1,2]', '--file', join(d, 'body.md')).json.ok, true);
  assert.match(pr(d, 'ready-check', 'pm-x').json.errors.join(';'), /product ready-check pm-x --direct/);
  assert.equal(pr(d, 'ready', 'pm-x', '--direct').json.ok, true);
  assert.equal(pr(d, 'ready-check', 'pm-x').json.ok, true);
  // Plik sprintu bez linii (poprzednia próba): spec new naprawia linię topic.
  assert.equal(pr(d, 'roadmap', 'add', 'pm-y', '--goal', 'Other').json.ok, true);
  write(d, 'docs/product/sprints/pm-y.md', `${header({ schema: 'dwmt/sprint-spec@1', id: 'pm-y', kind: 'feature', items: [], touch: [], refs: [], uatGate: false, ui: false, mode: 'auto', est: null, ready: null, run: null, actual: null })}## Goal\nOther\n`);
  const n = pr(d, 'spec', 'new', 'pm-y').json;
  assert.deepEqual([n.ok, n.repaired], [true, true], JSON.stringify(n));
  assert.match(pr(d, 'sprint', 'pm-y').out, /^pm-y · notes · Other · after: \[\] · detail: sprints\/pm-y\.md/);
  assert.match(pr(d, 'roadmap', 'set', 'pm-y', 'detail', 'x').json.error, /detail ustawia skrypt/);
});

test('W-7: limit roadmapy 2 KB: komunikat ze składnią i najdłuższymi celami (limit bez zmian)', () => {
  const lines = Array.from({ length: 20 }, (_, i) => ({ id: `s-${i}`, state: 'topic', goal: `${'g'.repeat(80)}${i}`, after: [], detail: 'none', alias: null, current: false }));
  const e = roadmapErrors(lines, []).find((x) => x.startsWith('roadmap.md'));
  assert.match(e, /> 2048 B \(o \d+ B za dużo\): skróć cele `product roadmap set <id> goal "<krótko>"` \(najdłuższe: s-10 \(82 zn\.\)/);
  assert.match(e, /`product roadmap drop <id>`/);
});

// ---------- W-8: uczciwość wykonawcy ----------

test('W-8: wejście recenzji wymienia zmiany poza planem zgłoszone przez wykonawcę; szablony: wykonawca i perspektywa correctness', () => {
  const { d } = repo28();
  const run = start(d, 'hon');
  writePlans(d, run);
  assert.equal(cliAs(d, 'sess-1', 'state', run).json.next, 'implement');
  execute(d, 'sess-1', run, 1, 1, { 'src/billing/discount.ts': 'export class Discount {}\n' }, { outOfScopeChanges: ['src/billing/invoice.ts#invoice: message shortened to pass the length test'] });
  const input = readFileSync(runFile(d, run, 'review-input.md'), 'utf8');
  assert.match(input, /## Changes the executor reports outside the plan\n\n- src\/billing\/invoice\.ts#invoice: message shortened to pass the length test\n/);
  const ex = readFileSync(fileURLToPath(new URL('../templates/agents/dwmt-executor.md', import.meta.url)), 'utf8');
  assert.match(ex, /Changing behaviour or content \(a prompt, rule, message, limit\) only to make a test pass is a deviation/);
  const lens = readFileSync(fileURLToPath(new URL('../templates/lenses/correctness.md', import.meta.url)), 'utf8');
  assert.match(lens, /made only so a test passes, that the brief does not ask for and the executor did not report .*: a major finding/);
  assert.match(lens, /`AC-n met pending UAT`/);
});
