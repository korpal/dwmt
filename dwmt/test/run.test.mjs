import './tmp-root.mjs';
// Przebieg na tymczasowym repo: setup, preflight, init, import-plan, state, verify, review-input, commit, finish.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

import { SCRIPT, DWMT_HOME, repo, gitIn, cli, header, plan, runFile, put, prepared } from './helpers.mjs';

test('setup: config domyślny, sześciu agentów (architekt, eksplorator, kontrola celu), check, nieznana rola, zachowanie CRLF', () => {
  const d = repo();
  const s = cli(d, 'setup');
  assert.equal(s.json.wroteConfig, true);
  assert.deepEqual(s.json.written.sort(), ['dwmt-architect', 'dwmt-checker', 'dwmt-executor', 'dwmt-executor-high', 'dwmt-explorer', 'dwmt-reviewer', 'dwmt-reviewer-high']);
  assert.deepEqual(s.json.removed, []);
  assert.match(readFileSync(join(d, '.claude', 'agents', 'dwmt-architect.md'), 'utf8'), /^effort: xhigh$/m);
  const cfg = JSON.parse(readFileSync(join(d, '.claude', 'dwmt.json'), 'utf8'));
  assert.deepEqual(cfg.verify.full, ['npm test']);
  const high = readFileSync(join(d, '.claude', 'agents', 'dwmt-executor-high.md'), 'utf8');
  assert.match(high, /^name: dwmt-executor-high$/m);
  assert.match(high, /^effort: high$/m);
  assert.match(high, /^maxTurns: 100$/m, 'D2: wykonawca krótszymi odcinkami');
  assert.match(readFileSync(join(d, '.claude', 'agents', 'dwmt-reviewer.md'), 'utf8'), /^maxTurns: 200$/m);
  assert.match(readFileSync(join(d, '.claude', 'agents', 'dwmt-reviewer.md'), 'utf8'), /^effort: xhigh$/m);
  assert.equal(cli(d, 'setup', '--check').json.ok, true);

  const rev = join(d, '.claude', 'agents', 'dwmt-reviewer.md');
  writeFileSync(rev, readFileSync(rev, 'utf8').replace(/\n/g, '\r\n'));
  assert.equal(cli(d, 'setup', '--check').json.ok, true, 'porównanie po normalizacji EOL');
  cfg.roles = { reviewer: { effort: 'high' } };
  writeFileSync(join(d, '.claude', 'dwmt.json'), JSON.stringify(cfg));
  assert.deepEqual(cli(d, 'setup', '--check').json.stale, ['dwmt-architect', 'dwmt-explorer', 'dwmt-executor', 'dwmt-executor-high', 'dwmt-reviewer', 'dwmt-reviewer-high', 'dwmt-checker'], 'hash configu jest w każdym agencie');
  cli(d, 'setup');
  const after = readFileSync(rev, 'utf8');
  assert.ok(after.includes('\r\neffort: high\r\n'), 'CRLF zachowany');

  cfg.roles = { tester: { effort: 'low' } };
  writeFileSync(join(d, '.claude', 'dwmt.json'), JSON.stringify(cfg));
  const bad = cli(d, 'setup');
  assert.equal(bad.code, 1);
  assert.match(bad.json.error, /nieznana rola w configu: tester/);
});

test('preflight: brak agentów blokuje; init na master tworzy gałąź i exclude', () => {
  const d = repo();
  const pf = cli(d, 'preflight', '--slug', 'Koszt dostawy');
  assert.equal(pf.json.ok, false);
  assert.match(pf.json.blockers[0], /setup i zrestartuj/);
  assert.match(pf.json.run, /^\d{4}-\d{2}-\d{2}-koszt-dostawy$/);
  const run = pf.json.run;
  const i = cli(d, 'init', '--run', run);
  assert.equal(i.json.branch, `dwmt/${run}`);
  assert.match(readFileSync(join(d, '.git', 'info', 'exclude'), 'utf8'), /^\.dwmt\/$/m);
  const rj = JSON.parse(readFileSync(runFile(d, run, 'run.json'), 'utf8'));
  assert.deepEqual(rj.session_ids, ['sess-1']);
  assert.equal(cli(d, 'init', '--run', run).json.existing, true);
  assert.equal(gitIn(d)('status', '--porcelain'), '', '.dwmt nie brudzi drzewa');
});

test('import-plan: walidacja nagłówka i sekcji ryzyk (bez wymogu linii Continue)', () => {
  const d = repo();
  cli(d, 'setup');
  const run = cli(d, 'preflight', '--slug', 'x').json.run;
  cli(d, 'init', '--run', run);
  const f = join(d, '..', 'zly-plan.md');
  writeFileSync(f, `${header({ schema: 'dwmt/brief@1', run, goal: 'g', mode: 'auto' })}# plan\n`);
  const r = cli(d, 'import-plan', f, '--run', run);
  assert.equal(r.json.ok, false);
  assert.ok(r.json.errors.some((e) => /mode=auto/.test(e)));
  assert.equal(cli(d, 'state', run).json.next, 'plan');
  writeFileSync(f, `${header({ schema: 'dwmt/brief@1', run, goal: 'g', mode: 'single', acceptance: [], scope: [], verify: [], risks: ['R-1', 'R-2'] })}# plan

## Risks
### R-1 [huge] x
- Method: test
`);
  const r2 = cli(d, 'import-plan', f, '--run', run);
  assert.equal(r2.json.ok, false);
  assert.ok(r2.json.errors.some((e) => /R-1: waga \[huge\]/.test(e)), r2.out);
  assert.ok(r2.json.errors.some((e) => /brak sekcji R-2/.test(e)), r2.out);
});

test('single: pełny przebieg z rundą fix, wznowieniem i squashem do jednego commita', () => {
  const d = repo();
  const run = prepared(d);
  const g = gitIn(d);
  const before = Number(g('rev-list', '--count', 'master'));

  let st = cli(d, 'state', run).json;
  assert.equal(st.next, 'implement');
  assert.equal(st.agent, 'dwmt-executor');
  assert.match(st.prompt, /brief\.md/);
  st = cli(d, 'state', run).json;
  assert.equal(st.next, 'continue', 'przerwany wykonawca: kontynuacja');

  writeFileSync(join(d, 'b.txt'), 'b\n');
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'DONE' });
  assert.equal(cli(d, 'state', run).json.next, 'verify');
  const v = cli(d, 'verify', run).json;
  assert.equal(v.result, 'pass');
  const ri = cli(d, 'review-input', run).json;
  assert.deepEqual(ri.passes, ['correctness', 'pragmatism']);
  assert.ok(readFileSync(runFile(d, run, 'diff.patch'), 'utf8').includes('+++ b/b.txt'), 'nieśledzony plik w diffie');
  const input = readFileSync(runFile(d, run, 'review-input.md'), 'utf8');
  assert.match(input, /### D-1 prosto/);
  assert.match(input, /## Pass 1: correctness/);
  assert.match(input, /The script runs the full suite \(`npm test`\) at finish/);
  st = cli(d, 'state', run).json;
  assert.equal(st.next, 'review');
  assert.equal(st.agent, 'dwmt-reviewer');

  put(d, run, 'review-1.md', { schema: 'dwmt/review@1', round: 1, passes: ['correctness', 'pragmatism'], verdict: 'FIX', counts: { blocker: 1 }, fix: ['F-1'], defer: ['F-2'], drop: [] },
    '## correctness\n### F-1 [blocker] zła treść\n`b.txt:1`\n### F-2 [minor] styl\nx\n');
  st = cli(d, 'state', run).json;
  assert.equal(st.next, 'fix');
  assert.equal(st.round, 2);
  assert.equal(st.agent, 'dwmt-executor-high');
  assert.match(st.prompt, /review-1\.md/);

  writeFileSync(join(d, 'b.txt'), 'B\n');
  put(d, run, 'result-2.md', { schema: 'dwmt/result@1', status: 'DONE', fixed: [{ id: 'F-1', redTest: 't' }], notReproduced: [] });
  cli(d, 'verify', run);
  const ri2 = cli(d, 'review-input', run).json;
  assert.deepEqual(ri2.passes, ['recheck']);
  const input2 = readFileSync(runFile(d, run, 'review-input.md'), 'utf8');
  assert.match(input2, /### F-1 \[blocker\] zła treść/);
  assert.ok(!/F-2 \[minor\]/.test(input2), 'tylko uwagi z listy fix');
  assert.match(readFileSync(runFile(d, run, 'fix-delta.patch'), 'utf8'), /-b\n\+B/);

  put(d, run, 'review-2.md', { schema: 'dwmt/review@1', round: 2, passes: ['recheck'], verdict: 'PASS', fix: [], acceptance: ['AC-1 met'] });
  // kt (D-13): round 2 carried its command, so the changed tree gets one closing whole verify before the commit.
  st = cli(d, 'state', run).json;
  assert.deepEqual([st.next, st.closing], ['verify', true], JSON.stringify(st));
  const vc = cli(d, 'verify', run).json;
  assert.deepEqual([vc.ok, vc.closing], [true, true], JSON.stringify(vc));
  assert.match(readFileSync(runFile(d, run, 'tests.md'), 'utf8'), /^closing: true$/m);
  assert.equal(cli(d, 'state', run).json.next, 'commit');
  assert.equal(cli(d, 'commit', run).json.ok, true);
  assert.equal(cli(d, 'state', run).json.next, 'finish');

  const fin = cli(d, 'finish', run);
  assert.equal(fin.json.status, 'squashed', fin.out);
  assert.equal(g('branch', '--show-current'), 'master');
  assert.equal(Number(g('rev-list', '--count', 'master')), before + 1, 'dokładnie jeden commit na master');
  assert.match(g('log', '-1', '--format=%B', 'master'), /dwmt-run: /);
  const rep = readFileSync(runFile(d, run, 'final-report.md'), 'utf8');
  assert.match(rep, /^status: "PASS"$/m);
  assert.match(rep, /^acceptance: \["AC-1 met"\]$/m);
  assert.match(rep, /session sess-1/);
  assert.equal(cli(d, 'state', run).json.next, 'done');
  assert.equal(cli(d, 'finish', run, '--cleanup').json.deleted, `dwmt/${run}`);
});

test('inline: bez wykonawcy; po maxRounds pytanie, extend i commit --accept', () => {
  const d = repo();
  const run = prepared(d, 'c', 'inline');
  let st = cli(d, 'state', run).json;
  assert.equal(st.next, 'implement');
  assert.equal(st.agent, null);
  writeFileSync(join(d, 'c.txt'), 'c\n');
  cli(d, 'verify', run);
  assert.equal(cli(d, 'state', run).json.next, 'verify', 'review-input jeszcze nie powstało');
  cli(d, 'review-input', run);
  assert.equal(cli(d, 'state', run).json.next, 'review');
  put(d, run, 'review-1.md', { schema: 'dwmt/review@1', round: 1, passes: [], verdict: 'FIX', fix: ['F-1'] }, '### F-1 [major] x\n');
  assert.equal(cli(d, 'state', run).json.next, 'fix');
  cli(d, 'verify', run);
  cli(d, 'review-input', run);
  put(d, run, 'review-2.md', { schema: 'dwmt/review@1', round: 2, passes: ['recheck'], verdict: 'FIX', fix: ['F-1'] }, '### F-1 [major] x\n');
  st = cli(d, 'state', run).json;
  assert.equal(st.next, 'ask-rounds');
  assert.equal(cli(d, 'extend', run).json.maxRounds, 3);
  assert.equal(cli(d, 'state', run).json.next, 'fix');
  cli(d, 'extend', run);
  const rj = JSON.parse(readFileSync(runFile(d, run, 'run.json'), 'utf8'));
  rj.tasks[0].maxRounds = 2;
  writeFileSync(runFile(d, run, 'run.json'), JSON.stringify(rj));
  assert.equal(cli(d, 'commit', run).code, 1, 'bez --accept nie wolno');
  assert.equal(cli(d, 'commit', run, '--accept').json.ok, true);
  assert.equal(cli(d, 'state', run).json.next, 'finish');
  const fin = cli(d, 'finish', run).json;
  assert.equal(fin.status, 'squashed');
  assert.match(readFileSync(runFile(d, run, 'final-report.md'), 'utf8'), /^status: "ACCEPTED"$/m);
});

test('BLOCKED: pytanie, unblock, kontynuacja', () => {
  const d = repo();
  const run = prepared(d, 'q');
  cli(d, 'state', run);
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'BLOCKED', questions: ['Q-1'] }, '### Q-1 Który format?\nA czy B\n');
  const st = cli(d, 'state', run).json;
  assert.equal(st.next, 'ask');
  assert.deepEqual(st.questions, ['Q-1']);
  assert.match(cli(d, 'section', runFile(d, run, 'result-1.md'), 'Q-1').out, /Który format/);
  assert.equal(cli(d, 'unblock', run).json.ok, true);
  assert.ok(existsSync(runFile(d, run, 'result-1.blocked-1.md')));
  assert.equal(cli(d, 'state', run).json.next, 'continue');
});

test('finish: worktree sprintu, brudne drzewo docelowe daje merge-wait, potem squash przez git -C bez ponownej suity', () => {
  const main = repo();
  const g = gitIn(main);
  cli(main, 'setup');
  g('add', '-A');
  g('commit', '-q', '-m', 'dwmt setup');
  const wt = join(main, '..', `${main.split(/[\\/]/).pop()}-wt`);
  g('worktree', 'add', '-q', '-b', 'sprint', wt);
  const run = cli(wt, 'preflight', '--slug', 'w').json.run;
  const i = cli(wt, 'init', '--run', run).json;
  assert.equal(i.branch, 'sprint');
  assert.equal(i.created, false);
  cli(wt, 'import-plan', plan(wt, run, 'inline'), '--run', run);
  writeFileSync(join(wt, 'w.txt'), 'w\n');
  cli(wt, 'verify', run);
  cli(wt, 'review-input', run);
  put(wt, run, 'review-1.md', { schema: 'dwmt/review@1', round: 1, passes: [], verdict: 'PASS', fix: [] });
  cli(wt, 'commit', run);
  // v2.6: zmiana w pliku śledzonym i nieśledzony plik tam, gdzie squash dodaje w.txt, dają merge-wait (bez squasha);
  // nieśledzony plik, którego squash nie dotyka, nie blokuje.
  writeFileSync(join(main, 'brud.txt'), 'x');
  writeFileSync(join(main, 'a.txt'), 'brud\n');
  writeFileSync(join(main, 'w.txt'), 'moje\n');
  const dirtyTarget = cli(wt, 'finish', run).json;
  assert.equal(dirtyTarget.status, 'merge-wait', JSON.stringify(dirtyTarget));
  assert.equal(dirtyTarget.reason, 'target-dirty');
  assert.deepEqual(dirtyTarget.files, ['a.txt', 'w.txt']);
  assert.ok(existsSync(join(main, '.dwmt', 'runs', run, 'final-report.md')), 'merge-wait też kopiuje przebieg do głównego drzewa');
  const st = cli(wt, 'state', run).json;
  assert.equal(st.next, 'finish', 'merge-wait to stan przejściowy');
  assert.match(st.hint, /merge-wait \(target-dirty\)/);

  g('checkout', '--', 'a.txt');
  rmSync(join(main, 'w.txt'));
  const sq = cli(wt, 'finish', run).json;
  assert.equal(sq.status, 'squashed', JSON.stringify(sq));
  assert.equal(sq.reused, true, 'cel bez zmian: squash bez ponownej pełnej suity');
  assert.equal(sq.cleanup.now, false, 'gałąź trzyma worktree sprintu: bez pytania o usunięcie');
  const wtFwd = wt.replace(/\\/g, '/');
  assert.equal(sq.cleanup.at.toLowerCase(), wtFwd.toLowerCase());
  // F (noc 2026-10-05): komenda na później to sprzątanie przez skrypt z głównego drzewa, nie gołe `git worktree remove`.
  assert.equal(sq.cleanup.after.length, 1);
  assert.match(sq.cleanup.after[0], new RegExp(`finish ${run} --cleanup$`));
  assert.ok(sq.cleanup.after[0].toLowerCase().startsWith(`cd "${main.replace(/\\/g, '/')}"`.toLowerCase()), sq.cleanup.after[0]);
  assert.match(sq.hint, /cleanup\.after/);
  assert.ok(existsSync(join(main, 'brud.txt')));
  assert.match(g('log', '-1', '--format=%s', 'master'), /Dodaj b\.txt/);
  assert.ok(existsSync(join(main, 'w.txt')));
  assert.ok(existsSync(join(main, '.dwmt', 'runs', run, 'final-report.md')), 'raport skopiowany do głównego drzewa');
  assert.equal(JSON.parse(readFileSync(join(main, '.dwmt', 'runs', run, 'run.json'), 'utf8')).finish?.status, 'squashed', 'kopia run.json po zapisie finish');
  assert.equal(g('rev-parse', 'sprint'), g('rev-parse', 'master'), 'gałąź sprintu przesunięta na commit squasha');
  assert.equal(cli(wt, 'finish', run).json.already, true, 'ponowny finish nic nie robi');
  assert.match(cli(wt, 'finish', run, '--cleanup').json.error, /jest wybrana .*finish \S+ --cleanup$/);

  const run2 = cli(wt, 'preflight', '--slug', 'w2').json.run;
  cli(wt, 'init', '--run', run2);
  const rj2 = JSON.parse(readFileSync(runFile(wt, run2, 'run.json'), 'utf8'));
  assert.equal(rj2.tasks[0].baseline, g('rev-parse', 'master'), 'drugi przebieg nie obejmuje pracy pierwszego');
});

test('finish: zmiana bez różnicy względem celu, commit na złej gałęzi, brak gałęzi docelowej', () => {
  const d = repo();
  const g = gitIn(d);
  const run = prepared(d, 'e', 'inline');
  cli(d, 'verify', run);
  cli(d, 'review-input', run);
  put(d, run, 'review-1.md', { schema: 'dwmt/review@1', round: 1, passes: [], verdict: 'PASS', fix: [] });
  g('switch', '-q', 'master');
  const wrong = cli(d, 'commit', run);
  assert.equal(wrong.code, 1);
  assert.match(wrong.json.error, /nie dwmt\//);
  g('switch', '-q', `dwmt/${run}`);
  assert.equal(cli(d, 'commit', run).json.empty, true);
  const fin = cli(d, 'finish', run).json;
  assert.equal(fin.status, 'squashed');
  assert.equal(fin.commit, null);
  assert.equal(g('branch', '--show-current'), 'master');

  const cfg = JSON.parse(readFileSync(join(d, '.claude', 'dwmt.json'), 'utf8'));
  cfg.git.target = 'develop';
  writeFileSync(join(d, '.claude', 'dwmt.json'), JSON.stringify(cfg));
  const pf = cli(d, 'preflight', '--slug', 'x').json;
  assert.ok(pf.blockers.some((b) => /develop nie istnieje/.test(b)));
  assert.equal(cli(d, 'init', '--run', pf.run).code, 1);
  assert.equal(g('branch', '--show-current'), 'master', 'init nie zostawia bezpańskiej gałęzi');
});

test('finish: konflikt rebase jest przerywany i raportowany', () => {
  const d = repo();
  const g = gitIn(d);
  const run = prepared(d, 'k', 'inline');
  writeFileSync(join(d, 'a.txt'), 'gałąź\n');
  cli(d, 'verify', run);
  cli(d, 'review-input', run);
  put(d, run, 'review-1.md', { schema: 'dwmt/review@1', round: 1, passes: [], verdict: 'PASS', fix: [] });
  cli(d, 'commit', run);
  g('switch', '-q', 'master');
  writeFileSync(join(d, 'a.txt'), 'master\n');
  g('commit', '-q', '-am', 'równolegle');
  g('switch', '-q', `dwmt/${run}`);
  const r = cli(d, 'finish', run).json;
  assert.equal(r.status, 'conflict');
  assert.deepEqual(r.files, ['a.txt']);
  assert.equal(g('status', '--porcelain'), '', 'rebase przerwany, drzewo czyste');
  assert.equal(cli(d, 'state', run).json.next, 'finish');
});

test('verify: czerwona komenda daje ogon błędu w tests.md', () => {
  const d = repo();
  const run = prepared(d, 'v', 'inline');
  const f = join(d, '..', `${run}-red.md`);
  writeFileSync(f, readFileSync(runFile(d, run, 'brief.md'), 'utf8').replace('"node -e 0"', '"node -e \\"console.log(1);process.exit(3)\\""'));
  cli(d, 'import-plan', f, '--run', run);
  const v = cli(d, 'verify', run).json;
  assert.equal(v.result, 'fail');
  const t = readFileSync(runFile(d, run, 'tests.md'), 'utf8');
  assert.match(t, /\(exit 3\)/);
  assert.match(t, /```text\n1\n```/);
});

function toCommit(d, run, file) {
  writeFileSync(join(d, file), 'x\n');
  cli(d, 'verify', run);
  cli(d, 'review-input', run);
  put(d, run, 'review-1.md', { schema: 'dwmt/review@1', round: 1, passes: [], verdict: 'PASS', fix: [], acceptance: ['AC-1 met'] });
  assert.equal(cli(d, 'commit', run).json.ok, true);
}

function redSuite(d) {
  const tag = basename(d);
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude', 'dwmt.json'), JSON.stringify({
    verify: {
      targeted: ['node -e 0'],
      full: [`node -e "process.exit(require('fs').existsSync('../${tag}-red')?1:0)"`, `node -e "require('fs').appendFileSync('../${tag}-log','x')"`],
    },
    git: { target: 'master' },
  }));
  return { red: join(d, '..', `${tag}-red`), log: join(d, '..', `${tag}-log`) };
}

test('verify: komendy briefu plus targeted z configu, bez powtórzeń', async () => {
  const { targetedCommands } = await import(pathToFileURL(SCRIPT).href);
  assert.deepEqual(targetedCommands(['a', 'b'], ['b', 'c']), ['a', 'b', 'c']);
  assert.deepEqual(targetedCommands([], 'c'), ['c']);
  assert.deepEqual(targetedCommands(undefined, null), []);
});

test('finish: po czerwieni powtarza tylko czerwone komendy; --accept-red kończy squashem', () => {
  const d = repo();
  const { red, log } = redSuite(d);
  const run = prepared(d, 'r', 'inline');
  toCommit(d, run, 'r.txt');
  writeFileSync(red, '1');
  const r1 = cli(d, 'finish', run).json;
  assert.equal(r1.status, 'red');
  assert.equal(readFileSync(log, 'utf8'), 'x', 'pierwszy finish: pełna suita');
  const r2 = cli(d, 'finish', run).json;
  assert.equal(r2.status, 'red');
  assert.equal(r2.rerun.length, 1, 'powtórka tylko czerwonej komendy');
  assert.equal(readFileSync(log, 'utf8'), 'x', 'zielona komenda nie biegnie drugi raz');
  rmSync(red, { force: true });
  const r3 = cli(d, 'finish', run, '--accept-red').json;
  assert.equal(r3.status, 'squashed', JSON.stringify(r3));
  const rep = readFileSync(runFile(d, run, 'final-report.md'), 'utf8');
  assert.match(rep, /acceptedRed/, 'bez zmian w kodzie --accept-red bierze ostatni wynik, nie uruchamia suity');
});

// K2 R-1, R-2 (D-9): odłożona uwaga major zatrzymuje finish przed rebase'em (bez squasha), aż użytkownik ją przyjmie.
function deferMajor(d, run, file) {
  writeFileSync(join(d, file), 'x\n');
  cli(d, 'verify', run);
  cli(d, 'review-input', run);
  writeFileSync(runFile(d, run, 'review-1.md'), `${header({ schema: 'dwmt/review@1', round: 1, passes: ['pragmatism'], verdict: 'PASS', fix: [], defer: ['F-1'], drop: [], acceptance: ['AC-1 met'] })}### F-1 [major] Cleanup removes the parent dir\n\n## pragmatism\n- F-1: defer — outside the brief\n`);
  assert.equal(cli(d, 'commit', run).json.ok, true);
}

test('finish: odłożona uwaga major zatrzymuje przed rebase, --accept-deferred zapisuje przyjęcie i kończy squashem', () => {
  const d = repo();
  const g = gitIn(d);
  const run = prepared(d, 'dg', 'inline');
  deferMajor(d, run, 'dg.txt');
  const before = g('rev-parse', 'master');
  const r1 = cli(d, 'finish', run);
  assert.equal(r1.json.status, 'deferred-major', r1.out);
  assert.equal(r1.json.ok, false);
  assert.equal(r1.json.majors.length, 1);
  assert.match(r1.json.majors[0], /^T-1\/F-1 \[major\] Cleanup removes the parent dir/);
  assert.match(r1.json.hint, new RegExp(`dwmt finish ${run} --accept-deferred`));
  assert.equal(g('rev-parse', 'master'), before, 'bez squasha na gałęzi docelowej');
  assert.equal(existsSync(runFile(d, run, 'tests-full.md')), false, 'bez pełnej suity');
  const st = cli(d, 'state', run).json;
  assert.equal(st.next, 'finish');
  assert.match(st.hint, /--accept-deferred/);
  const ev = readFileSync(join(DWMT_HOME, 'events.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.run === run);
  assert.ok(ev.some((e) => e.type === 'question-waiting' && e.detail?.reason === 'deferred-major'), 'zdarzenie: pytanie czeka');
  assert.equal(cli(d, 'finish', run).json.status, 'deferred-major', 'bez flagi nadal stoi');
  const r2 = cli(d, 'finish', run, '--accept-deferred').json;
  assert.equal(r2.status, 'squashed', JSON.stringify(r2));
  const rj = JSON.parse(readFileSync(runFile(d, run, 'run.json'), 'utf8'));
  assert.deepEqual(rj.deferredAccepted.ids, ['T-1/F-1']);
  const today = rj.deferredAccepted.at.slice(0, 10);
  const rep = readFileSync(runFile(d, run, 'final-report.md'), 'utf8');
  assert.ok(rep.includes(`\n  - T-1/F-1 [major] Cleanup removes the parent dir (accepted by the user ${today})\n`), rep);
  assert.match(rep, /^acceptedDeferred: \["T-1\/F-1"\]$/m);
});

// K2 R-5: przyjęcie przeżywa czerwoną suitę; po naprawie finish bez flagi nie staje ponownie.
test('finish: --accept-deferred przy czerwonej suicie daje red, a kolejny finish bez flagi kończy squashem', () => {
  const d = repo();
  const { red } = redSuite(d);
  const run = prepared(d, 'dr', 'inline');
  deferMajor(d, run, 'dr.txt');
  writeFileSync(red, '1');
  assert.equal(cli(d, 'finish', run).json.status, 'deferred-major');
  assert.equal(cli(d, 'finish', run, '--accept-deferred').json.status, 'red');
  rmSync(red, { force: true });
  const r = cli(d, 'finish', run).json;
  assert.equal(r.status, 'squashed', JSON.stringify(r));
});

// Batch T-2/F-2: "leave unmerged to fix them" has an exit. After a fix committed on the run branch,
// `--fixed-deferred` closes the listed majors as fixed by the user (not accepted, no longer deferred).
test('finish: --fixed-deferred po commicie poprawki zamyka uwagi major jako poprawione przez użytkownika, nie przyjęte', () => {
  const d = repo();
  const g = gitIn(d);
  const run = prepared(d, 'df', 'inline');
  deferMajor(d, run, 'df.txt');
  const before = g('rev-parse', 'master');
  const r1 = cli(d, 'finish', run).json;
  assert.equal(r1.status, 'deferred-major');
  assert.match(r1.hint, new RegExp(`dwmt finish ${run} --fixed-deferred`));
  const r2 = cli(d, 'finish', run, '--fixed-deferred').json;
  assert.equal(r2.ok, false, 'bez commita poprawki: odmowa');
  assert.match(r2.error, /no commit on the run branch since the stop/);
  assert.equal(g('rev-parse', 'master'), before);
  writeFileSync(join(d, 'df.txt'), 'fixed\n');
  g('commit', '-qam', 'fix T-1/F-1 by hand');
  const r3 = cli(d, 'finish', run, '--fixed-deferred').json;
  assert.equal(r3.status, 'squashed', JSON.stringify(r3));
  const rj = JSON.parse(readFileSync(runFile(d, run, 'run.json'), 'utf8'));
  assert.deepEqual(rj.deferredFixed.ids, ['T-1/F-1']);
  assert.equal(rj.deferredAccepted, undefined);
  const today = rj.deferredFixed.at.slice(0, 10);
  const rep = readFileSync(runFile(d, run, 'final-report.md'), 'utf8');
  assert.ok(rep.includes('\n- Deferred findings: 0, of which 0 major.\n'), rep);
  assert.ok(rep.includes(`\n- Fixed by you after the reviews (not re-reviewed): T-1/F-1 [major] Cleanup removes the parent dir (${today}).\n`), rep);
  assert.doesNotMatch(rep, /accepted by the user/);
  assert.doesNotMatch(rep, /^## Deferred findings$/m);
  assert.match(rep, /^fixedDeferred: \["T-1\/F-1"\]$/m);
  assert.match(rep, /^deferred: \[\]$/m);
});

test('finish: po czerwieni i ręcznym scaleniu zamyka przebieg i pozwala na cleanup', () => {
  const d = repo();
  const g = gitIn(d);
  const { red } = redSuite(d);
  const run = prepared(d, 'm', 'inline');
  toCommit(d, run, 'm.txt');
  writeFileSync(red, '1');
  assert.equal(cli(d, 'finish', run).json.status, 'red');
  g('switch', '-q', 'master');
  g('merge', '-q', '--squash', `dwmt/${run}`);
  g('commit', '-q', '-m', 'ręczny squash');
  const fin = cli(d, 'finish', run).json;
  assert.equal(fin.status, 'squashed', JSON.stringify(fin));
  assert.equal(fin.manual, true);
  assert.ok(existsSync(runFile(d, run, 'final-report.md')));
  assert.equal(cli(d, 'state', run).json.next, 'done');
  assert.equal(cli(d, 'finish', run, '--cleanup').json.deleted, `dwmt/${run}`);
  rmSync(red, { force: true });
});

test('preflight: nieznane git.rebase blokuje', () => {
  const d = repo();
  const g = gitIn(d);
  cli(d, 'setup');
  const cfgFile = join(d, '.claude', 'dwmt.json');
  const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
  cfg.git.rebase = 'always';
  writeFileSync(cfgFile, JSON.stringify(cfg));
  g('add', '-A');
  g('commit', '-q', '-m', 'dwmt setup');
  const pf = cli(d, 'preflight', '--slug', 'a').json;
  assert.equal(pf.ok, false);
  assert.ok(pf.blockers.some((b) => /git.rebase = always/.test(b)));
  assert.equal(pf.autoApprove, undefined);
});
