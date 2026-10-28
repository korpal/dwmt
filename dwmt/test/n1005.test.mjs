import './tmp-root.mjs';
// Noc 2026-10-05 (po przeglądzie pm-16): F sprzątanie bez wchodzenia w junction, B intake bez pozycji rozwiązanych w partii,
// A e2e zmienione przez sprint przy finish, D tryb pośredni, E tryb bez planu.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { repo, SCRIPT, DWMT_HOME } from './helpers.mjs';
import { linksIn, removeWorktree } from '../scripts/lib/git.mjs';

function dwmt(d, sid, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: d, encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: sid, DWMT_HOME } });
  try { return JSON.parse(r.stdout); } catch { return { raw: r.stdout, err: r.stderr }; }
}

test('F: removeWorktree odpina junction przed git worktree remove; cel w głównym drzewie zostaje', () => {
  const d = repo();
  const g = (...a) => spawnSync('git', a, { cwd: d, encoding: 'utf8' });
  writeFileSync(join(d, '.gitignore'), 'nm/\n');
  g('add', '.gitignore');
  g('commit', '-q', '-m', 'ignore');
  mkdirSync(join(d, 'nm', 'pkg'), { recursive: true });
  writeFileSync(join(d, 'nm', 'pkg', 'keep.txt'), 'x');
  const wt = join(d, '..', `${d.split(/[\\/]/).pop()}-wtj`);
  assert.equal(g('worktree', 'add', '-q', '-b', 'w', wt).status, 0);
  symlinkSync(join(d, 'nm'), join(wt, 'nm'), 'junction');
  assert.equal(linksIn(wt).length, 1);
  const r = removeWorktree(d, wt);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.unlinked.length, 1);
  assert.equal(existsSync(wt), false);
  assert.equal(readFileSync(join(d, 'nm', 'pkg', 'keep.txt'), 'utf8'), 'x', 'zawartość celu dowiązania nietknięta');
});

test('F: finish --cleanup z głównego drzewa nie opróżnia node_modules przez junction w worktree przebiegu', () => {
  const d = repo();
  const g = (...a) => spawnSync('git', a, { cwd: d, encoding: 'utf8' });
  writeFileSync(join(d, '.gitignore'), '.dwmt/\nnode_modules/\n');
  g('add', '.gitignore');
  g('commit', '-q', '-m', 'ignore');
  mkdirSync(join(d, 'node_modules', 'lib'), { recursive: true });
  writeFileSync(join(d, 'node_modules', 'lib', 'index.js'), '1');
  const wt = join(d, '..', `${d.split(/[\\/]/).pop()}-wtf`);
  assert.equal(g('worktree', 'add', '-q', '-b', 'dwmt/r1', wt).status, 0);
  symlinkSync(join(d, 'node_modules'), join(wt, 'node_modules'), 'junction');
  const root = join(wt, '.dwmt', 'runs', 'r1');
  mkdirSync(root, { recursive: true });
  const rj = { schema: 'dwmt/run@1', run: 'r1', rules: '2.10', mode: 'single', branch: 'dwmt/r1', target: 'master', mainTree: d.replace(/\\/g, '/'), task: 1, count: 1, tasks: [], session_ids: [], finish: { status: 'squashed', commit: 'abc' } };
  writeFileSync(join(root, 'run.json'), JSON.stringify(rj));
  const mainCopy = join(d, '.dwmt', 'runs', 'r1');
  mkdirSync(mainCopy, { recursive: true });
  writeFileSync(join(mainCopy, 'run.json'), JSON.stringify({ ...rj, archiveOf: wt }));
  const r = dwmt(d, 'sess-po', 'finish', 'r1', '--cleanup');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(existsSync(wt), false);
  assert.equal(r.unlinked.length, 1);
  assert.equal(readFileSync(join(d, 'node_modules', 'lib', 'index.js'), 'utf8'), '1');
});

test('F: linksIn nie wchodzi w dowiązania i pomija .git', () => {
  const d = mkdtempSync(join(tmpdir(), 'dwmt-links-'));
  mkdirSync(join(d, 'a', 'b'), { recursive: true });
  mkdirSync(join(d, '.git'), { recursive: true });
  const target = mkdtempSync(join(tmpdir(), 'dwmt-target-'));
  mkdirSync(join(target, 'deep'), { recursive: true });
  symlinkSync(target, join(d, 'a', 'link'), 'junction');
  symlinkSync(target, join(d, '.git', 'ignored'), 'junction');
  assert.deepEqual(linksIn(d).map((p) => p.replace(/\\/g, '/').split('/').slice(-2).join('/')), ['a/link']);
});

test('B: intake pomija uwagi rozwiązane w rundzie zbiorczej (nagłówek raportu końcowego), zostawia nadal odłożone', async () => {
  const { pr, fakeRun, write, productRepo } = await import('./product-helpers.mjs');
  const d = productRepo(repo);
  const { dir } = fakeRun(d, 'r1', { spec: 'pm-1' });
  write(d, '.dwmt/runs/r1/tasks/1/report.md', '---\nschema: "dwmt/task-report@1"\n---\n# T-1 x\n\n## Deferred findings\n- F-2 Fixed later in the batch — cosmetic (src/a.ts:4)\n- F-3 Still deferred — minor (src/b.ts:9)\n');
  writeFileSync(join(dir, 'final-report.md'), `---\nschema: "dwmt/final-report@1"\nrun: "r1"\nmode: "single"\nbatch: {"items":["T-1/F-2 deferred-visible resolved","T-1/F-3 deferred-visible open"],"rounds":1}\ndeferred: ["T-1/F-3"]\ncost: {"total": 2}\n---\n# Report\n`);
  const r = pr(d, 'intake', 'r1');
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.json.items, ['B-1 remark new: Still deferred']);
});

test('A: e2eChangedCommand bierze tylko pliki e2e dodane albo zmienione od merge-base z celem, z przyciętym przedrostkiem', async () => {
  const { e2eChangedCommand } = await import('../scripts/lib/verify.mjs');
  const { finishFacts } = await import('../scripts/plan.mjs');
  const d = repo();
  const g = (...a) => spawnSync('git', a, { cwd: d, encoding: 'utf8' });
  mkdirSync(join(d, 'frontend', 'e2e'), { recursive: true });
  writeFileSync(join(d, 'frontend', 'e2e', 'old.spec.ts'), 'old');
  writeFileSync(join(d, 'frontend', 'e2e', 'gone.spec.ts'), 'gone');
  g('add', '-A'); g('commit', '-q', '-m', 'e2e');
  g('switch', '-q', '-c', 'dwmt/r1');
  writeFileSync(join(d, 'frontend', 'e2e', 'new.spec.ts'), 'new');
  writeFileSync(join(d, 'frontend', 'e2e', 'old.spec.ts'), 'changed');
  writeFileSync(join(d, 'frontend', 'e2e', 'helper.ts'), 'not a spec');
  g('rm', '-q', join('frontend', 'e2e', 'gone.spec.ts'));
  g('add', '-A'); g('commit', '-q', '-m', 'sprint');
  const cfg = { verify: { full: ['npm test'], e2eChanged: { glob: 'frontend/e2e/**/*.spec.ts', cmd: 'npm --prefix frontend run test:e2e -- {files}', strip: 'frontend/' } } };
  const e = e2eChangedCommand(d, { target: 'master' }, cfg);
  assert.deepEqual(e.files.sort(), ['frontend/e2e/new.spec.ts', 'frontend/e2e/old.spec.ts']);
  assert.match(e.cmd, /^npm --prefix frontend run test:e2e -- e2e\/(new|old)\.spec\.ts e2e\/(new|old)\.spec\.ts$/);
  assert.equal(e2eChangedCommand(d, { target: 'master' }, { verify: { full: [] } }), null, 'bez klucza: bez e2e');
  assert.match(finishFacts(cfg), /At finish the script runs only: `npm test`, plus the e2e spec files the sprint adds or changes/);
  assert.match(finishFacts({ verify: { full: ['npm test'] } }), /runs only: `npm test`; any other test runs only if a task's verify runs it/);
});

test('A: finish uruchamia przy pełnej suicie e2e dodane przez sprint (verify.e2eChanged); tests-full.md i fullVerify je mają', async () => {
  const { prepared, cli, put, runFile } = await import('./helpers.mjs');
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  mkdirSync(join(d, 'e2e'), { recursive: true });
  writeFileSync(join(d, 'e2e', 'mark.js'), "require('fs').writeFileSync('e2e-ran.txt', process.argv.slice(2).join(' '));\n");
  writeFileSync(join(d, '.gitignore'), 'e2e-ran.txt\n');
  writeFileSync(join(d, '.claude', 'dwmt.json'), JSON.stringify({ verify: { full: ['node -e 0'], e2eChanged: { glob: 'e2e/**/*.spec.js', cmd: 'node e2e/mark.js {files}', strip: 'e2e/' } } }));
  spawnSync('git', ['add', '-A'], { cwd: d }); spawnSync('git', ['commit', '-q', '-m', 'cfg'], { cwd: d });
  const run = prepared(d, 'e2e', 'single');
  writeFileSync(join(d, 'b.txt'), 'b\n');
  writeFileSync(join(d, 'e2e', 'nowy.spec.js'), '// e2e\n');
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'DONE', acceptance: ['AC-1 met'] });
  assert.equal(cli(d, 'verify', run).json.result, 'pass');
  cli(d, 'review-input', run);
  put(d, run, 'review-1.md', { schema: 'dwmt/review@1', round: 1, passes: ['correctness'], verdict: 'PASS', fix: [], acceptance: ['AC-1 met'] });
  assert.equal(cli(d, 'commit', run).json.ok, true);
  const fin = cli(d, 'finish', run);
  assert.equal(fin.json.status, 'squashed', fin.out);
  assert.equal(readFileSync(join(d, 'e2e-ran.txt'), 'utf8'), 'nowy.spec.js');
  assert.match(readFileSync(runFile(d, run, 'tests-full.md'), 'utf8'), /node e2e\/mark\.js nowy\.spec\.js/);
  assert.deepEqual(JSON.parse(readFileSync(runFile(d, run, 'run.json'), 'utf8')).fullVerify.e2e, ['e2e/nowy.spec.js']);
});

// ---------- E: tryb direct (bez planu) ----------

async function directRepo() {
  const { pr, productRepo } = await import('./product-helpers.mjs');
  const { cli } = await import('./helpers.mjs');
  const d = productRepo(repo);
  const g = (...a) => spawnSync('git', a, { cwd: d, encoding: 'utf8' });
  assert.equal(pr(d, 'item', 'add', '--type', 'remark', '--title', 'History names wrong for alternatives').code, 0);
  assert.equal(pr(d, 'item', 'set', 'B-1', '--touch', 'src/history.ts').code, 0);
  g('add', '-A'); g('commit', '-q', '-m', 'item');
  assert.equal(cli(d, 'setup').code, 0);
  g('add', '-A'); g('commit', '-q', '-m', 'dwmt setup');
  const run = cli(d, 'preflight', '--slug', 'e').json.run;
  const init = cli(d, 'init', '--run', run, '--mode', 'direct', '--item', 'B-1').json;
  assert.equal(init.ok, true, JSON.stringify(init));
  return { d, run, g };
}

test('E: init --mode direct --item pisze plan zadania (bez architekta); runda 1 to wykonawca high z dopiskiem trybu direct', async () => {
  const { cli, runFile } = await import('./helpers.mjs');
  const { d, run } = await directRepo();
  const brief = readFileSync(runFile(d, run, 'brief.md'), 'utf8');
  assert.match(brief, /^mode: "?direct"?$/m);
  assert.match(brief, /AC-1 B-1 done as its backlog entry in task\.md says: History names wrong for alternatives/);
  assert.match(brief, /## UAT\nUAT: none\./);
  const rj = JSON.parse(readFileSync(runFile(d, run, 'run.json'), 'utf8'));
  assert.equal(rj.mode, 'direct');
  const st = cli(d, 'state', run).json;
  assert.deepEqual([st.next, st.agent], ['implement', 'dwmt-executor-high'], JSON.stringify(st));
  assert.match(st.prompt, /No plan \(mode direct\): do the work in \S*task\.md yourself/);
  assert.match(st.prompt, /end BLOCKED with `escalate: <reason>`/);
});

test('E: BLOCKED z escalate (albo planIssue) → pytanie do użytkownika, nie replan architekta', async () => {
  const { cli, put } = await import('./helpers.mjs');
  const { d, run } = await directRepo();
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'BLOCKED', escalate: 'needs a migration of conversation storage' });
  const st = cli(d, 'state', run).json;
  assert.equal(st.next, 'ask', JSON.stringify(st));
  assert.equal(st.agent, null);
  assert.match(st.escalate, /migration/);
  assert.match(st.hint, /tryb bez planu: wykonawca eskaluje/);
});

test('E: pełny przebieg direct — wykonawca dopisuje verify, recenzja bez „zmienionych komend”, squash z trybem direct w raporcie', async () => {
  const { cli, put, runFile } = await import('./helpers.mjs');
  const { d, run, g } = await directRepo();
  const bf = runFile(d, run, 'brief.md');
  writeFileSync(bf, readFileSync(bf, 'utf8').replace('verify: []', 'verify: ["node -e 0"]'));
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src', 'history.ts'), 'export const x = 1;\n');
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'DONE', testsRun: ['node -e 0'] });
  const v = cli(d, 'verify', run).json;
  assert.equal(v.result, 'pass', JSON.stringify(v));
  assert.ok(v.commands.some((c) => /node -e 0/.test(c)));
  cli(d, 'review-input', run);
  const input = readFileSync(runFile(d, run, 'review-input.md'), 'utf8');
  assert.ok(!/Verify commands changed after planning/.test(input), 'direct: komendy dopisane przez wykonawcę to nie zmiana planu');
  assert.match(input, /AC-1 B-1 done as its backlog entry/);
  put(d, run, 'review-1.md', { schema: 'dwmt/review@1', round: 1, passes: ['correctness'], verdict: 'PASS', fix: [], acceptance: ['AC-1 met'] });
  assert.equal(cli(d, 'state', run).json.next, 'commit');
  assert.equal(cli(d, 'commit', run).json.ok, true);
  const fin = cli(d, 'finish', run);
  assert.equal(fin.json.status, 'squashed', fin.out);
  assert.match(readFileSync(runFile(d, run, 'final-report.md'), 'utf8'), /^mode: "direct"$/m);
  assert.equal(g('branch', '--show-current').stdout.trim(), 'master');
});

test('E/D: start-check rekomenduje direct dla zakotwiczonej uwagi, intermediate według liczby plików, single przy flagach ryzyka', async () => {
  const { pr, productRepo, write } = await import('./product-helpers.mjs');
  const d = productRepo(repo);
  write(d, 'src/small/a.ts', 'x'.repeat(4000));
  write(d, 'src/mid/a.ts', 'x'.repeat(400000));
  spawnSync('git', ['add', '-A'], { cwd: d }); spawnSync('git', ['commit', '-q', '-m', 'code'], { cwd: d });
  pr(d, 'item', 'add', '--type', 'remark', '--title', 'Anchored remark');
  pr(d, 'item', 'set', 'B-1', '--touch', 'src/small/a.ts');
  pr(d, 'item', 'add', '--type', 'feature', '--title', 'Mid feature');
  pr(d, 'item', 'add', '--type', 'bug', '--title', 'Bug without anchor');
  assert.equal(pr(d, 'start-check', '--item', 'B-1', '--globs', 'src/small/**').json.recommend, 'direct');
  assert.equal(pr(d, 'start-check', '--item', 'B-3', '--globs', 'src/small/**').json.recommend, 'inline', 'bez kotwicy: inline jak dotąd');
  assert.equal(pr(d, 'start-check', '--item', 'B-2', '--globs', 'src/mid/**').json.recommend, 'intermediate', 'zbiór roboczy 100k ≤ 150k');
  assert.equal(pr(d, 'start-check', '--item', 'B-2', '--globs', 'src/mid/**,src/new/**').json.recommend, 'single', 'nowy obszar');
});

// ---------- D: tryb pośredni (intermediate) ----------

test('D: tryb pośredni — prompt architekta z jednym zadaniem; plan z trzema zadaniami odrzucony', async () => {
  const { repo28, start, writePlans, cliAs, RUN } = await import('./fixtures28.mjs');
  const { d } = repo28();
  const run = start(d, 'i1', '--mode', 'intermediate');
  assert.deepEqual([RUN(d, run).mode, RUN(d, run).modeLabel], ['single', 'intermediate']);
  let st = cliAs(d, 'sess-1', 'state', run).json;
  assert.equal(st.agent, 'dwmt-architect', JSON.stringify(st));
  // Przegląd pm-16-ui: eksploratorzy według obszaru, nie trybu (test w pm16ui.test.mjs).
  assert.match(st.prompt, /Mode: intermediate: the sprint is exactly one task \(T-1\)/);
  assert.match(st.prompt, /At finish the script runs only:/);
  writePlans(d, run);
  st = cliAs(d, 'sess-1', 'state', run).json;
  assert.equal(st.next, 'plan', JSON.stringify(st));
  assert.match(st.prompt, /mode intermediate: the sprint is exactly one task \(T-1\)/);
  // Tryb single: te same plany przechodzą.
  const run2 = start(d, 'i2');
  writePlans(d, run2);
  assert.notEqual(cliAs(d, 'sess-1', 'state', run2).json.next, 'plan');
});

test('F (recenzja): brudny worktree bez --force — nic nie odpięte, git nie wołany, junction zostaje', () => {
  const d = repo();
  const g = (...a) => spawnSync('git', a, { cwd: d, encoding: 'utf8' });
  writeFileSync(join(d, '.gitignore'), 'nm/\n');
  g('add', '.gitignore'); g('commit', '-q', '-m', 'ignore');
  mkdirSync(join(d, 'nm'), { recursive: true });
  writeFileSync(join(d, 'nm', 'keep.txt'), 'x');
  const wt = join(d, '..', `${d.split(/[\\/]/).pop()}-wtd`);
  assert.equal(g('worktree', 'add', '-q', '-b', 'w2', wt).status, 0);
  symlinkSync(join(d, 'nm'), join(wt, 'nm'), 'junction');
  writeFileSync(join(wt, 'brud.txt'), 'niezacommitowane');
  const r = removeWorktree(d, wt);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /niezacommitowane zmiany/);
  assert.deepEqual(r.unlinked, []);
  assert.ok(existsSync(join(wt, 'nm', 'keep.txt')), 'junction worktree nadal działa');
  assert.ok(existsSync(join(d, 'nm', 'keep.txt')));
});

test('E (recenzja): błędny nagłówek planu w trybie direct wraca do wykonawcy high (nie do nieistniejącego architekta)', async () => {
  const { cli, runFile } = await import('./helpers.mjs');
  const { d, run } = await directRepo();
  const bf = runFile(d, run, 'brief.md');
  writeFileSync(bf, readFileSync(bf, 'utf8').replace('verify: []', 'verify: ["node -e $X"]'));
  const st = cli(d, 'state', run).json;
  assert.deepEqual([st.next, st.agent], ['plan', 'dwmt-executor-high'], JSON.stringify(st));
  assert.match(st.prompt, /Mode direct \(no architect\): fix only the task plan/);
});

test('A (recenzja): powtórka czerwonego finish uruchamia e2e, gdy zmieniła się lista plików; pusta lista = cała suita', async () => {
  const { prepared, cli, put, runFile } = await import('./helpers.mjs');
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  mkdirSync(join(d, 'e2e'), { recursive: true });
  writeFileSync(join(d, 'e2e', 'mark.js'), "const fs=require('fs');fs.appendFileSync('e2e-ran.txt', process.argv.slice(2).join(' ')+'\\n');process.exit(fs.existsSync('e2e/red.flag')?1:0);\n");
  writeFileSync(join(d, '.gitignore'), 'e2e-ran.txt\ne2e/red.flag\n');
  writeFileSync(join(d, '.claude', 'dwmt.json'), JSON.stringify({ verify: { full: ['node -e 0'], rerunRed: false, e2eChanged: { glob: 'e2e/**/*.spec.js', cmd: 'node e2e/mark.js {files}', strip: 'e2e/' } } }));
  spawnSync('git', ['add', '-A'], { cwd: d }); spawnSync('git', ['commit', '-q', '-m', 'cfg'], { cwd: d });
  const run = prepared(d, 'e2r', 'single');
  writeFileSync(join(d, 'b.txt'), 'b\n');
  writeFileSync(join(d, 'e2e', 'a.spec.js'), '// a\n');
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'DONE' });
  cli(d, 'verify', run); cli(d, 'review-input', run);
  put(d, run, 'review-1.md', { schema: 'dwmt/review@1', round: 1, passes: ['correctness'], verdict: 'PASS', fix: [], acceptance: ['AC-1 met'] });
  assert.equal(cli(d, 'commit', run).json.ok, true);
  writeFileSync(join(d, 'e2e', 'red.flag'), '1');
  assert.equal(cli(d, 'finish', run).json.status, 'red');
  // Poprawka dodaje spec: tekst komendy e2e się zmienia, a mimo to biegnie w powtórce.
  rmSync(join(d, 'e2e', 'red.flag'));
  spawnSync('git', ['switch', '-q', `dwmt/${run}`], { cwd: d });
  writeFileSync(join(d, 'e2e', 'b.spec.js'), '// b\n');
  spawnSync('git', ['add', '-A'], { cwd: d }); spawnSync('git', ['commit', '-q', '-m', 'fix'], { cwd: d });
  const fin = cli(d, 'finish', run);
  assert.equal(fin.json.status, 'squashed', fin.out);
  const ran = readFileSync(join(d, 'e2e-ran.txt'), 'utf8').trim().split('\n');
  assert.equal(ran.at(-1), 'a.spec.js b.spec.js');
});

test('E: findingSources dokłada do task.md treść uwagi z recenzji źródłowego przebiegu (src review:<run>/T-k/F-n)', async () => {
  const { findingSources } = await import('../scripts/lib/direct.mjs');
  const { findingSection } = await import('../scripts/batch.mjs');
  const m = mkdtempSync(join(tmpdir(), 'dwmt-src-'));
  mkdirSync(join(m, '.dwmt', 'runs', 'r0', 'tasks', '2'), { recursive: true });
  writeFileSync(join(m, '.dwmt', 'runs', 'r0', 'tasks', '2', 'review-1.md'), '---\nschema: dwmt/review@1\n---\n## correctness\n### F-3 [minor] Names wrong\n- Evidence: `a.ts:4`\n### F-4 [minor] Other\nx\n');
  const s = findingSources(m, [{ id: 'B-9', src: 'review:r0/T-2/F-3' }, { id: 'B-10', src: null }], findingSection);
  assert.match(s, /## B-9: review finding F-3 of T-2 in run r0/);
  assert.match(s, /### F-3 \[minor\] Names wrong\n- Evidence: `a\.ts:4`/);
  assert.ok(!/F-4/.test(s));
});
