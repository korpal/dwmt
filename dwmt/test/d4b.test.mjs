import './tmp-root.mjs';
// D4 etap 1, budujący B: bramka ceny w `run` (B5, spec warstwy produktowej §6.4), zmiany dwmt dla warstwy produktowej
// (B7: init z pliku sprintu i z `--item`, `intermediate`, linie architekta i recenzenta, kopia przebiegu, intake przy
// finish i uat record, merge-wait bez katalogu produktu, rozdział defektów UAT), pliki ekspertów i zasada warstw (P-11).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, utimesSync, readdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { splitHeader, parseYaml } from '../scripts/dwmt.mjs';
import { priceGateStep, priceAnswer, priceReport, estOverheadOf, validFiles, filesErrors } from '../scripts/lib/price-gate.mjs';
import { archive, runIntake, mergeWaitReason } from '../scripts/lib/finish.mjs';
import { parseExpert } from '../scripts/lib/product-ops.mjs';
import { repo, gitIn, runFile, header, prepared, cli, DWMT_HOME } from './helpers.mjs';
import { cliAs, RUN, PLAN, repo28, start, writePlans, execute } from './fixtures28.mjs';
import { pr, write, config, fakeRun } from './product-helpers.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const state = (d, run, sid = 'sess-1') => cliAs(d, sid, 'state', run).json;
const withFiles = (text, files = [3, 8]) => text.replace('questions: []\n', `questions: []\nfiles: ${JSON.stringify(files)}\n`);
const withQ1 = (text) => text.replace('questions: []', 'questions: ["Q-1"]').replace('## Tasks', '## Questions\n### Q-1 Discount cap\n- Why I ask: money\n- Options: A; B\n\n## Tasks');
const answers = (d, run, text) => writeFileSync(runFile(d, run, 'answers.md'), text);
const GATE = { run: { priceGate: true } };
const asArr = (x) => (Array.isArray(x) ? x : []);

// ---------- B5: bramka ceny ----------

test('bramka: sprint oszacowany w granicy 1,5× → bez pytania; cena projektu w run.price (0,2 mln/plik bez warstwy produktowej)', () => {
  const { d } = repo28(GATE);
  const run = start(d, 'g1', '--estimate', '5,10');
  assert.deepEqual([RUN(d, run).priceGate, RUN(d, run).estimate], [true, { tokensM: [5, 10], src: 'start' }]);
  writePlans(d, run, { plan: withFiles(PLAN(run)) });
  const st = state(d, run);
  assert.equal(st.next, 'implement', JSON.stringify(st));
  const p = RUN(d, run).price;
  assert.deepEqual([p.gate, p.files, p.design, p.m, p.limit], ['none', [3, 8], [0.7, 1.8], 0.2, 15]);
  assert.equal(p.basis, 'default (no product layer); batch +15% default');
  assert.deepEqual(priceReport(RUN(d, run)), { estimate: [5, 10], design: [0.7, 1.8], gate: 'none', files: [3, 8] });
});

test('bramka: oszacowany ponad 1,5× → Q-price jako jedyne pytanie tury; continue bez architekta, gate asked, onlyTurn; freestyle bez pytań architekta → bez tury', () => {
  const { d } = repo28(GATE);
  const run = start(d, 'g2', '--estimate', '0.1,0.2');
  writePlans(d, run, { plan: withFiles(PLAN(run)) });
  let st = state(d, run);
  assert.equal(st.next, 'ask-plan', JSON.stringify(st));
  assert.deepEqual(st.questions, ['Q-price']);
  assert.match(st.price.text, /exceeds the sprint's estimate \(price accepted at start\) of 0\.1-0\.2 M tokens by more than 1\.5x/);
  assert.match(st.price.text, /~3-8 files, ~0\.7-1\.8 M tokens \(0\.2 M per file/);
  assert.match(st.price.options[0], /^continue \(Recommended\)/);
  answers(d, run, '### Q-price Price of the design\ncontinue\n');
  st = state(d, run);
  assert.deepEqual([st.next, st.agent], ['implement', 'dwmt-executor'], JSON.stringify(st));
  const p = RUN(d, run).price;
  assert.deepEqual([p.gate, p.answer.kind, p.onlyTurn], ['asked', 'continue', true]);
  assert.equal(priceReport(RUN(d, run)).gate, 'asked');

  // Freestyle (bez szacunku) bez pytań architekta (recenzja N-4, ZAŁOŻENIE §6.4): bramka nie dokłada tury; cena w zdaniu
  // kroku (`priceNote`, raz) i w raporcie.
  const run2 = start(d, 'g3');
  assert.equal(RUN(d, run2).estimate, null);
  writePlans(d, run2, { plan: withFiles(PLAN(run2)) });
  st = state(d, run2);
  assert.deepEqual([st.next, st.agent], ['implement', 'dwmt-executor'], JSON.stringify(st));
  assert.match(st.priceNote, /^Design price: ~3-8 files, ~0\.7-1\.8 M tokens \(0\.2 M\/file, mode single, fix batch \+15%\); no estimate, no question\.$/);
  assert.equal(RUN(d, run2).price.gate, 'info');
  assert.equal(state(d, run2).priceNote, undefined, 'raz');
  assert.deepEqual(priceReport(RUN(d, run2)), { estimate: null, design: [0.7, 1.8], gate: 'none', files: [3, 8] });
});

test('bramka: Q-price razem z pytaniami architekta; stop → stopped z powodem price (raz, zdarzenie), shrink → tekst do architekta', () => {
  const { d } = repo28(GATE);
  const run = start(d, 'g4');
  writePlans(d, run, { plan: withQ1(withFiles(PLAN(run))) });
  let st = state(d, run);
  assert.deepEqual([st.next, st.questions], ['ask-plan', ['Q-1', 'Q-price']], JSON.stringify(st));
  answers(d, run, '### Q-1 Discount cap\nA\n\n### Q-price\nstop\n');
  st = state(d, run);
  assert.deepEqual([st.next, st.reason], ['stopped', 'price'], JSON.stringify(st));
  assert.equal(RUN(d, run).stopped.reason, 'price');
  assert.equal(RUN(d, run).price.onlyTurn, false, 'tura miała też Q-1');
  assert.equal(state(d, run).next, 'stopped', 'stan trwały');
  const evs = readFileSync(join(DWMT_HOME, 'events.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.run === run && e.type === 'sprint-end');
  assert.deepEqual(evs.map((e) => [e.verdict, e.detail.reason]), [['stopped', 'price']], 'jedno zdarzenie');

  const run2 = start(d, 'g5');
  writePlans(d, run2, { plan: withQ1(withFiles(PLAN(run2))) });
  state(d, run2);
  answers(d, run2, '### Q-1 Discount cap\nA\n\n### Q-price\nshrink: leave the export out\n');
  st = state(d, run2);
  assert.deepEqual([st.next, st.agent], ['plan', 'dwmt-architect']);
  assert.match(st.prompt, /Record each as D-n, remove the answered ids from `questions`; the user asked to shrink the scope at the price question \(Q-price\): leave the export out, so plan the smaller scope \(also `files`\), then continue\./);
});

test('bramka: zmniejszenie zakresu jako jedyna tura → architekt poprawia plany; po zapisie planu dalej bez kolejnego pytania', () => {
  const { d } = repo28(GATE);
  const run = start(d, 'g6', '--estimate', '0.1,0.2');
  writePlans(d, run, { plan: withFiles(PLAN(run)) });
  assert.equal(state(d, run).next, 'ask-plan');
  answers(d, run, '### Q-price\n- shrink: only the invoice\n');
  let st = state(d, run);
  assert.deepEqual([st.next, st.agent], ['plan', 'dwmt-architect'], JSON.stringify(st));
  assert.match(st.prompt, /^The user asked to shrink the scope at the price question \(Q-price in [^)]*answers\.md\): only the invoice\. Revise the sprint plan/);
  const f = runFile(d, run, 'plan.md');
  writeFileSync(f, withFiles(PLAN(run), [1, 3]));
  const later = new Date(Date.now() + 5000);
  utimesSync(f, later, later);
  st = state(d, run);
  assert.equal(st.next, 'implement', JSON.stringify(st));
  assert.deepEqual(RUN(d, run).price.design, [0.7, 1.8], 'cena z chwili pytania');
});

test('bramka: brak albo zły files → ostrzeżenie bramki (gate error), nie błąd walidacji planu; validFiles i priceAnswer', () => {
  // Recenzja N-4 (§6.4 pkt 7): brak files nie kosztuje płatnej tury poprawki planu.
  const { d } = repo28(GATE);
  const run = start(d, 'g7');
  writePlans(d, run);
  let st = state(d, run);
  assert.deepEqual([st.next, st.agent], ['implement', 'dwmt-executor'], JSON.stringify(st));
  assert.equal(RUN(d, run).price.gate, 'error');
  assert.match(RUN(d, run).warnings[0], /^bramka ceny: brak files w nagłówku planu.*bez pytania o cenę$/);
  assert.equal(priceReport(RUN(d, run)).gate, 'error');
  const run2 = start(d, 'g7b');
  writePlans(d, run2, { plan: withFiles(PLAN(run2), [9, 2]) });
  st = state(d, run2);
  assert.equal(st.next, 'implement', JSON.stringify(st));
  assert.match(RUN(d, run2).warnings[0], /files w nagłówku planu: oczekiwano \[min, max\]/);
  assert.deepEqual([validFiles([2, 9]), validFiles([2]), validFiles(['a', 3]), validFiles([1.5, 2])], [[2, 9], null, null, null]);
  assert.deepEqual(filesErrors({ files: [0, 0] }), []);
  const dir = mkdtempSync(join(tmpdir(), 'dwmt-pa-'));
  const a = (t) => { writeFileSync(join(dir, 'a.md'), t); return priceAnswer(join(dir, 'a.md')); };
  assert.deepEqual(a('### Q-1 x\nA\n### Q-price\nSTOP\n'), { kind: 'stop', text: '' });
  assert.deepEqual(a('### Q-price Price\n\nshrink: drop CSV\nand PDF\n'), { kind: 'shrink', text: 'drop CSV and PDF' });
  assert.equal(a('### Q-price\nyes go\n').unclear, true);
  assert.equal(a('### Q-1 x\nA\n'), null);
});

test('bramka: błąd skryptu ceny → bez pytania, gate error i ostrzeżenie; inline nigdy nie pyta; run.priceGate false = v2.10', () => {
  // Błąd liczenia (drzewo bez gita): bez pytania, ostrzeżenie w run.warnings.
  const run = { priceGate: true, estimate: null, mode: 'single' };
  const plan = { h: { files: [1, 2], questions: [] }, errors: [] };
  assert.equal(priceGateStep({ top: join(tmpdir(), 'no-such-dir-dwmt'), root: tmpdir(), run, cfg: { review: {} }, plan }), true);
  assert.equal(run.price.gate, 'error');
  assert.match(run.warnings[0], /^bramka ceny: .*bez pytania o cenę$/);
  assert.equal(priceReport(run).gate, 'error');

  // inline: plan zadania bez plan.md → nic nie liczy i nie pyta.
  const d = repo();
  config(d, { run: { priceGate: true }, verify: { full: ['node -e 0'] } });
  gitIn(d)('add', '-A'); gitIn(d)('commit', '-q', '-m', 'cfg');
  const r = prepared(d, 'inl', 'inline');
  assert.equal(cli(d, 'state', r).json.next, 'implement');
  assert.equal(RUN(d, r).price, undefined);

  // Bramka wyłączona (fixtures28 domyślnie): run.json bez pól bramki, plan bez files przechodzi.
  const { d: d2 } = repo28();
  const run2 = start(d2, 'off');
  const rj = RUN(d2, run2);
  for (const k of ['priceGate', 'estimate', 'price', 'spec', 'items', 'modeLabel', 'warnings', 'stopped']) assert.ok(!(k in rj), k);
  writePlans(d2, run2);
  assert.equal(state(d2, run2).next, 'implement');
  assert.ok(!('price' in RUN(d2, run2)));
});

test('warstwy (P-11): bez warstwy produktowej i z bramką wyłączoną prompt architekta i wejście recenzji jak w v3-driver', () => {
  const { d } = repo28();
  const run = start(d, 'lay');
  const st = state(d, run);
  assert.equal(st.agent, 'dwmt-architect');
  assert.doesNotMatch(st.prompt, /Price gate|Product decisions|Sprint file|strategic matter/);
  writePlans(d, run);
  assert.equal(state(d, run).next, 'implement');
  execute(d, 'sess-1', run, 1, 1, { 'src/billing/discount.ts': 'export class Discount {}\n' });
  assert.doesNotMatch(readFileSync(runFile(d, run, 'review-input.md'), 'utf8'), /Backlog items/);
  // Z bramką: jedna linia o files w prompcie architekta.
  const { d: d2 } = repo28(GATE);
  const st2 = state(d2, start(d2, 'lay2'));
  assert.match(st2.prompt, / Price gate: write `files: \[min, max\]` in the plan header together with the questions/);
  assert.doesNotMatch(st2.prompt, /Product decisions/);
});

test('estOverhead: (E + P) / S; bez warstwy i bramki brak pola; P tylko przy turze z samym Q-price', () => {
  assert.equal(estOverheadOf(tmpdir(), { mode: 'single' }, { review: {} }, 10), null);
  const run = { priceGate: true, price: { onlyTurn: false }, session_ids: [] };
  assert.equal(estOverheadOf(tmpdir(), run, { review: {} }, 10), 0);
  assert.equal(estOverheadOf(tmpdir(), run, { review: {} }, null), null);
  const d = repo();
  pr(d, 'init', '--goal', 'g');
  const run2 = { priceGate: true, price: { onlyTurn: true, answer: { at: '2026-01-01T00:00:00Z' } }, session_ids: [] };
  assert.equal(estOverheadOf(d, run2, { review: {} }, 20, () => ({ E: 0.4 })), 0.02);
  assert.equal(run2.price.turnM, 0, 'bez transkryptów P = 0, zapisane dla product overhead');
});

// ---------- B7: init z pliku sprintu i z pozycji ----------

function productSprint() {
  const d = repo();
  config(d, { verify: { full: ['node -e 0'] }, git: { target: 'master' }, product: {} });
  assert.equal(pr(d, 'init', '--goal', 'Pilot: build cost').code, 0);
  assert.equal(pr(d, 'item', 'add', '--type', 'bug', '--title', 'Date picker shows UTC', '--sev', 'major', '--anchors', 'src/date.ts').code, 0);
  assert.equal(pr(d, 'item', 'add', '--type', 'debt', '--title', 'Rename helper').code, 0);
  gitIn(d)('add', '-A'); gitIn(d)('commit', '-q', '-m', 'product');
  return d;
}

test('init z pliku sprintu: task.md z product sprint, run.spec, tryb intermediate → single + modeLabel, est start: → estimate; notes bez --force odmowa', () => {
  const d = productSprint();
  const b = pr(d, 'spec', 'bugfix', 'B-1', '--mode', 'intermediate');
  assert.equal(b.code, 0, b.out);
  assert.equal(pr(d, 'spec', 'set', b.json.id, 'est', 'start:[2,4]').code, 0);
  gitIn(d)('add', '-A'); gitIn(d)('commit', '-q', '-m', 'spec');
  const pf = cli(d, 'preflight', '--slug', 'fix').json;
  const i = cli(d, 'init', '--run', pf.run, '--input', `docs/product/sprints/${b.json.id}.md`).json;
  assert.equal(i.ok, true, JSON.stringify(i));
  assert.deepEqual([i.kind, i.spec, i.mode, i.modeLabel], ['spec', b.json.id, 'single', 'intermediate']);
  const rj = RUN(d, pf.run);
  assert.deepEqual([rj.mode, rj.modeLabel, rj.spec, rj.priceGate, rj.estimate], ['single', 'intermediate', b.json.id, true, { tokensM: [2, 4], src: 'start' }]);
  const task = readFileSync(runFile(d, pf.run, 'task.md'), 'utf8');
  assert.match(task, new RegExp(`^${b.json.id} · ready · Fix B-1`));
  assert.match(task, /## Items \(expanded\)\n- B-1 bug major/);
  assert.match(task, /## Acceptance/);
  // Architekt dostaje linię pliku sprintu i rejestru decyzji.
  const st = cli(d, 'state', pf.run).json;
  assert.match(st.prompt, /Sprint file \(task\.md\): its acceptance criteria, decisions and out of scope bind you/);
  assert.match(st.prompt, /Product decisions: [^ ]*docs\/product\/decisions\.md: before a business question grep it/);
  assert.match(st.prompt, /`second` starting `decision:` or a question; `second` for a sprint too large starts `size:`/);
  gitIn(d)('switch', 'master');

  // Sprint w stanie notes: odmowa bez --force, z --force start.
  assert.equal(pr(d, 'roadmap', 'add', 's2', '--goal', 'Offline sync').code, 0);
  assert.equal(pr(d, 'spec', 'new', 's2', '--items', 'B-2').code, 0);
  gitIn(d)('add', '-A'); gitIn(d)('commit', '-q', '-m', 'notes');
  const pf2 = cli(d, 'preflight', '--slug', 'notes').json;
  const n = cli(d, 'init', '--run', pf2.run, '--input', 'docs/product/sprints/s2.md');
  assert.equal(n.code, 0, n.out);
  assert.deepEqual([n.json.ok, n.json.notReady, n.json.state], [false, true, 'notes']);
  assert.ok(!existsSync(runFile(d, pf2.run, 'run.json')), 'odmowa bez śladów');
  assert.equal(gitIn(d)('branch', '--show-current'), 'master');
  const f = cli(d, 'init', '--run', pf2.run, '--input', 'docs/product/sprints/s2.md', '--force', '--mode', 'single').json;
  assert.deepEqual([f.ok, f.kind, RUN(d, pf2.run).spec, RUN(d, pf2.run).estimate], [true, 'spec', 's2', null]);
});

test('init --item: task.md z pozycji, run.items; --mode intermediate bez pliku sprintu; recenzent dostaje linię backlogu', () => {
  const d = productSprint();
  const pf = cli(d, 'preflight', '--slug', 'items').json;
  const i = cli(d, 'init', '--run', pf.run, '--mode', 'inline', '--item', 'B-1,B-2').json;
  assert.equal(i.ok, true, JSON.stringify(i));
  assert.deepEqual([i.kind, i.items, RUN(d, pf.run).items, RUN(d, pf.run).mode], ['items', ['B-1', 'B-2'], ['B-1', 'B-2'], 'inline']);
  const task = readFileSync(runFile(d, pf.run, 'task.md'), 'utf8');
  assert.match(task, /^# Task: backlog items/);
  assert.match(task, /B-1 bug major/);
  assert.match(task, /Rename helper/);
  const bad = cli(d, 'init', '--run', 'x-run', '--item', 'B-99');
  assert.equal(bad.code, 1);
  gitIn(d)('switch', 'master');

  // Wejście recenzji przebiegu z pozycji: Grep po identyfikatorze w backlogu.
  const pf2 = cli(d, 'preflight', '--slug', 'items2').json;
  assert.equal(cli(d, 'init', '--run', pf2.run, '--mode', 'intermediate', '--item', 'B-2').json.modeLabel, 'intermediate');
  const brief = join(d, '..', `${pf2.run}-brief.md`);
  writeFileSync(brief, `${header({ schema: 'dwmt/brief@1', run: pf2.run, goal: 'Rename', mode: 'inline', acceptance: ['AC-1 renamed'], scope: ['*.txt'], verify: ['node -e 0'], risk: [] })}# Plan\n\n## UAT\nUAT: none.\n`);
  assert.equal(cli(d, 'import-plan', brief, '--run', pf2.run).json.ok, true);
  writeFileSync(join(d, 'b.txt'), 'b\n');
  cli(d, 'verify', pf2.run);
  cli(d, 'review-input', pf2.run);
  assert.match(readFileSync(runFile(d, pf2.run, 'review-input.md'), 'utf8'), /Backlog items \(B-n\) named in the plan: take an item's intent by grepping its id in `docs\/product\/backlog\*\.jsonl`/);
});

// ---------- B7: koniec sprintu ----------

test('finish: intake przy squashu (odpowiedzi na pytania sprintu → kandydaci do rejestru), raport ze spec i price; błąd intake tylko ostrzega', () => {
  const d = productSprint();
  config(d, { verify: { full: ['node -e 0'] }, git: { target: 'master' }, product: {}, run: { priceGate: true } });
  gitIn(d)('add', '-A'); gitIn(d)('commit', '-q', '-m', 'cfg');
  const b = pr(d, 'spec', 'bugfix', 'B-1');
  gitIn(d)('add', '-A'); gitIn(d)('commit', '-q', '-m', 'spec');
  const pf = cli(d, 'preflight', '--slug', 'fin').json;
  const run = pf.run;
  assert.equal(cli(d, 'init', '--run', run, '--mode', 'inline', '--input', `docs/product/sprints/${b.json.id}.md`).json.ok, true);
  const brief = join(d, '..', `${run}-brief.md`);
  writeFileSync(brief, `${header({ schema: 'dwmt/brief@1', run, goal: 'Fix B-1', mode: 'inline', acceptance: ['AC-1 local time'], scope: ['*.txt'], verify: ['node -e 0'], risk: [] })}# Plan\n\n## UAT\nUAT: none.\n`);
  assert.equal(cli(d, 'import-plan', brief, '--run', run).json.ok, true);
  writeFileSync(runFile(d, run, 'answers.md'), '### Q-1 Time zone\nAlways local time for dates shown to clients.\n');
  writeFileSync(join(d, 'c.txt'), 'c\n');
  cli(d, 'verify', run);
  cli(d, 'review-input', run);
  writeFileSync(runFile(d, run, 'review-1.md'), header({ schema: 'dwmt/review@1', round: 1, passes: ['correctness'], verdict: 'PASS', fix: [], defer: ['F-1'], drop: [], acceptance: ['AC-1 met'] }) + '### F-1 [minor] Helper name unclear\n`c.txt:1`\n');
  assert.equal(cli(d, 'commit', run).json.ok, true);
  const fin = cli(d, 'finish', run).json;
  assert.equal(fin.status, 'squashed', JSON.stringify(fin));
  assert.ok(fin.intake && !fin.intake.warning && fin.intake.candidates >= 1, JSON.stringify(fin.intake));
  const rep = parseYaml(splitHeader(readFileSync(runFile(d, run, 'final-report.md'), 'utf8')).yaml);
  assert.equal(rep.spec, b.json.id);
  assert.deepEqual(rep.price, { estimate: null, design: null, gate: 'none' }, 'inline: bez pytania i bez ceny projektu');
  const inbox = pr(d, 'inbox').out;
  assert.match(inbox, /decision/, inbox);
  // N-5: intake commituje sam katalog produktu (tylko jego ścieżki): następny `init` na miejscu nie odmawia.
  writeFileSync(join(d, 'user-notes.txt'), 'cudza zmiana\n');
  assert.equal(gitIn(d)('status', '--porcelain', '--', 'docs/product'), '');
  assert.match(gitIn(d)('log', '-1', '--format=%s'), /^product: intake /);
  assert.ok(!gitIn(d)('show', '--name-only', '--format=', 'HEAD').split('\n').some((f) => !f.startsWith('docs/product/')), 'commit tylko plików produktu');
  const pf2 = cli(d, 'preflight', '--slug', 'next').json;
  const nx = cli(d, 'init', '--run', pf2.run, '--mode', 'inline');
  assert.equal(nx.json.ok, true, nx.out);
  assert.match(gitIn(d)('status', '--porcelain'), /user-notes\.txt/, 'cudza zmiana zostaje niezacommitowana');
  // Błąd intake (zepsuty backlog) nie zatrzymuje końca sprintu: tylko ostrzeżenie.
  writeFileSync(join(d, 'docs', 'product', 'backlog.jsonl'), '{zepsute\n');
  const w = runIntake(d, { run, mainTree: d });
  assert.match(w.warning, /^product intake: /);
});

test('finish: sync przy squashu z UAT do zrobienia: roadmapa done, pozycje done, strona Czeka na przegląd, jeden commit produktu (B-7)', () => {
  const d = productSprint();
  const b = pr(d, 'spec', 'bugfix', 'B-1');
  assert.equal(b.code, 0, b.out);
  const id = b.json.id;
  gitIn(d)('add', '-A'); gitIn(d)('commit', '-q', '-m', 'spec');
  const run = cli(d, 'preflight', '--slug', 'b7').json.run;
  assert.equal(cli(d, 'init', '--run', run, '--mode', 'inline', '--input', `docs/product/sprints/${id}.md`).json.ok, true);
  const brief = join(d, '..', `${run}-brief.md`);
  writeFileSync(brief, `${header({ schema: 'dwmt/brief@1', run, goal: 'Fix B-1', mode: 'inline', acceptance: ['AC-1 local time'], scope: ['*.txt'], verify: ['node -e 0'], risk: [] })}# Plan\n\n## UAT\n1. Open the date picker → the time is local.\n`);
  assert.equal(cli(d, 'import-plan', brief, '--run', run).json.ok, true);
  writeFileSync(join(d, 'c.txt'), 'c\n');
  cli(d, 'verify', run);
  cli(d, 'review-input', run);
  writeFileSync(runFile(d, run, 'review-1.md'), header({ schema: 'dwmt/review@1', round: 1, passes: ['correctness'], verdict: 'PASS', fix: [], defer: ['F-1'], drop: [], acceptance: ['AC-1 met'] }) + '### F-1 [minor] Helper name unclear\n`c.txt:1`\n');
  assert.equal(cli(d, 'commit', run).json.ok, true);
  const fin = cli(d, 'finish', run).json;
  assert.equal(fin.status, 'squashed', JSON.stringify(fin));
  const rep = parseYaml(splitHeader(readFileSync(runFile(d, run, 'final-report.md'), 'utf8')).yaml);
  assert.equal(rep.uat, 'pending');
  assert.ok(fin.intake && !fin.intake.warning, JSON.stringify(fin.intake));
  assert.ok(asArr(fin.intake.synced).some((x) => new RegExp(`^${id} .* → done$`).test(x)), JSON.stringify(fin.intake));
  assert.match(pr(d, 'roadmap').out, new RegExp(`\\| ${id} \\| done \\|`));
  const arch = readFileSync(join(d, 'docs', 'product', 'backlog-archive.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(arch.find((x) => x.id === 'B-1')?.state, 'done', JSON.stringify(arch));
  // Strona opublikowana przy finish pokazuje sprint jako czekający na przegląd.
  const html = readFileSync(join(d, 'docs', 'product', 'roadmap.html'), 'utf8');
  const data = JSON.parse(/<script type="application\/json" id="dwmt-data">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.equal(data.sprints.find((s) => s.id === id)?.human, 'review');
  // Jeden commit produktu niesie roadmapę i stronę; katalog produktu czysty, ręczny sync nic już nie zmienia.
  assert.equal(gitIn(d)('log', '-1', '--format=%s'), `product: intake ${run}`);
  const files = gitIn(d)('show', '--name-only', '--format=', 'HEAD').split('\n');
  assert.ok(files.includes('docs/product/roadmap.md') && files.includes('docs/product/roadmap.html'), files.join(', '));
  assert.equal(gitIn(d)('status', '--porcelain', '--', 'docs/product'), '');
  const s = pr(d, 'sync');
  assert.equal(s.code, 0, s.out);
  assert.ok(!asArr(s.json.changes).some((x) => x.includes(id)), JSON.stringify(s.json));
});

test('finish: intake na końcu sprintu: merge-wait bez sync, sprint bez UAT do archiwum, błąd sync tylko ostrzega (B-7)', () => {
  const d = repo();
  const g = gitIn(d);
  config(d, { product: {}, git: { target: 'master' } });
  assert.equal(pr(d, 'init', '--goal', 'g').code, 0);
  for (const id of ['s-1', 's-2', 's-3']) {
    for (const a of [['roadmap', 'add', id, '--goal', `Goal ${id}`], ['spec', 'new', id]]) { const r = pr(d, ...a); assert.equal(r.code, 0, `${a.join(' ')}: ${r.out} ${r.err}`); }
  }
  g('add', '-A'); g('commit', '-q', '-m', 'product');
  const roadmapFile = join(d, 'docs', 'product', 'roadmap.md');
  const deferred = (id, title) => write(d, `.dwmt/runs/${id}/tasks/1/report.md`, `---\nschema: "dwmt/task-report@1"\n---\n# T-1 x\n\n## Deferred findings\n- F-2 ${title} — cosmetic (src/data/loader.ts:40)\n`);
  // Merge-wait (D-3): pozycje zapisane, bez sync i bez commitu produktu.
  fakeRun(d, 'r-1', { files: ['src/a.ts'], spec: 's-1', uat: 'pending', status: 'merge-wait' });
  deferred('r-1', 'Duplicate query in loader');
  const rm0 = readFileSync(roadmapFile);
  const head0 = g('rev-parse', 'HEAD');
  const w = runIntake(d, { run: 'r-1', mainTree: d, finish: { status: 'merge-wait' } });
  assert.equal(w.items, 1, JSON.stringify(w));
  assert.ok(!('synced' in w), JSON.stringify(w));
  assert.ok(readFileSync(roadmapFile).equals(rm0), 'roadmapa bez zmian w merge-wait');
  assert.equal(g('rev-parse', 'HEAD'), head0);
  g('add', '-A', '--', 'docs/product'); g('commit', '-q', '-m', 'merge-wait items');
  // UAT nie dotyczy (D-2): sprint zamknięty do archiwum w commicie intake.
  fakeRun(d, 'r-3', { files: ['src/c.ts'], spec: 's-3', uat: 'n/a' });
  const n = runIntake(d, { run: 'r-3', mainTree: d, finish: { status: 'squashed' } });
  assert.ok(asArr(n.synced).includes('s-3 closed → archive'), JSON.stringify(n));
  assert.doesNotMatch(readFileSync(roadmapFile, 'utf8'), /\| s-3 \|/);
  assert.ok(existsSync(join(d, 'docs', 'product', 'archive', 's-3.md')));
  assert.equal(g('log', '-1', '--format=%s'), 'product: intake r-3');
  assert.equal(g('status', '--porcelain', '--', 'docs/product'), '');
  // Błąd sync (D-4): tylko ostrzeżenie, nowe pozycje i tak w commicie produktu.
  write(d, 'docs/product/estimates.jsonl', '{broken\n');
  g('add', '-A', '--', 'docs/product'); g('commit', '-q', '-m', 'broken estimates');
  fakeRun(d, 'r-2', { files: ['src/b.ts'], spec: 's-2', uat: 'pending' });
  deferred('r-2', 'Slow export of the client list');
  const e = runIntake(d, { run: 'r-2', mainTree: d, finish: { status: 'squashed' } });
  assert.ok(!e.warning, JSON.stringify(e));
  assert.ok(asArr(e.warnings).some((x) => x.startsWith('sync: ')), JSON.stringify(e));
  assert.equal(e.items, 1, JSON.stringify(e));
  assert.equal(g('log', '-1', '--format=%s'), 'product: intake r-2');
  assert.match(g('show', 'HEAD:docs/product/backlog.jsonl'), /Slow export of the client list/);
});

test('archive: answers.md i goal-check.md w kopii przebiegu; merge-wait pomija zmiany w katalogu produktu', () => {
  const d = repo();
  const g = gitIn(d);
  config(d, { product: {} });
  write(d, 'docs/product/roadmap.md', '# dwmt/roadmap@1\n');
  write(d, 'src/x.ts', 'x\n');
  g('add', '-A'); g('commit', '-q', '-m', 'base');
  const wt = join(mkdtempSync(join(tmpdir(), 'dwmt-wt-')), 'wt');
  g('worktree', 'add', '-q', '-b', 'dwmt/r1', wt);
  const root = join(wt, '.dwmt', 'runs', 'r1');
  mkdirSync(join(root, 'tasks', '1'), { recursive: true });
  for (const f of ['answers.md', 'goal-check.md', 'task.md', 'plan.md']) writeFileSync(join(root, f), `${f}\n`);
  const run = { run: 'r1', mainTree: d, tasks: [{ k: 1 }], session_ids: [], target: 'master', branch: 'dwmt/r1' };
  writeFileSync(join(root, 'run.json'), JSON.stringify(run));
  const dest = archive(wt, run);
  assert.deepEqual(['answers.md', 'goal-check.md'].map((f) => existsSync(join(dest, f))), [true, true]);
  // Zmiana w docs/product w drzewie docelowym nie blokuje squasha; zmiana w kodzie tak.
  write(d, 'docs/product/roadmap.md', '# dwmt/roadmap@1\n* s1 · topic · x · after: [] · detail: none\n');
  assert.equal(mergeWaitReason(wt, run, d), null);
  write(d, 'src/x.ts', 'y\n');
  assert.equal(mergeWaitReason(wt, run, d).reason, 'target-dirty');
  assert.deepEqual(mergeWaitReason(wt, run, d).files, ['src/x.ts']);
});

test('uat record z warstwą produktową: sprint poprawek tylko z blocker/major (minor dołącza), sam minor → triaż; intake --uat; spec jako nazwa', () => {
  const d = repo();
  const g = gitIn(d);
  config(d, { product: {}, git: { target: 'master' } });
  assert.equal(pr(d, 'init', '--goal', 'g').code, 0);
  // AC-7 (R-3): linia roadmapy i plik sprintu pm-1; `uat record` zamyka go (archive/) w jednym commicie produktu.
  assert.equal(pr(d, 'roadmap', 'add', 'pm-1', '--goal', 'First').code, 0);
  assert.equal(pr(d, 'spec', 'new', 'pm-1', '--goal', 'First').code, 0);
  g('add', '-A'); g('commit', '-q', '-m', 'p');
  const mk = (id, spec) => {
    const dir = join(d, '.dwmt', 'runs', id);
    mkdirSync(dir, { recursive: true });
    const commit = g('rev-parse', '--short=10', 'HEAD');
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ schema: 'dwmt/run@1', run: id, spec, target: 'master', mode: 'single', created: new Date().toISOString(), session_ids: [], tasks: [], finish: { status: 'squashed', commit, uat: 'pending' } }));
    writeFileSync(join(dir, 'final-report.md'), `${header({ schema: 'dwmt/final-report@1', run: id, scope: ['src/**'], uat: 'pending' })}# R\n\n## UAT\n1. x\n`);
  };
  mk('r-a', 'pm-1');
  mk('r-b', 'pm-2');
  const res = (findings) => { const f = join(d, '..', `res-${Math.random()}.json`); writeFileSync(f, JSON.stringify({ result: 'defects', findings, deferredAccepted: [] })); return f; };
  const bug = (weight, text) => ({ text, place: 'screen', weight, kind: 'bug', class: 'test' });
  // Sam minor: bez sprintu poprawek, pozycja do triażu.
  assert.match(readFileSync(join(d, 'docs', 'product', 'roadmap.md'), 'utf8'), /\| pm-1 \|/);
  const before = g('rev-parse', 'HEAD');
  const st = cli(d, 'uat', 'start', 'pm-1').json;
  assert.equal(st?.ok, true, JSON.stringify(st));
  let r = cli(d, 'uat', 'record', 'pm-1', res([bug('minor', 'Label typo')])).json;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.fix, []);
  assert.deepEqual(r.intake, ['pm-1: 1 items']);
  const u1 = parseYaml(splitHeader(readFileSync(join(d, '.dwmt', 'runs', 'r-a', 'uat.md'), 'utf8')).yaml);
  assert.deepEqual([u1.sprint, u1.defects[0].fix], ['pm-1', 'triage']);
  // D-11, D-14: sprint zamknięty w roadmapie (linia znika, plik w archive/), jeden nowy commit katalogu produktu, czysto.
  assert.doesNotMatch(readFileSync(join(d, 'docs', 'product', 'roadmap.md'), 'utf8'), /\| pm-1 \|/);
  assert.ok(existsSync(join(d, 'docs', 'product', 'archive', 'pm-1.md')));
  assert.ok(!existsSync(join(d, 'docs', 'product', 'sprints', 'pm-1.md')));
  assert.equal(g('rev-list', '--count', `${before}..HEAD`, '--', 'docs/product'), '1');
  assert.equal(g('rev-list', '--count', `${before}..HEAD`), '1');
  assert.equal(g('status', '--porcelain', '--', 'docs/product'), '');
  // Major + minor: sprint poprawek z obydwoma.
  r = cli(d, 'uat', 'record', 'pm-2', res([bug('major', 'Total wrong'), bug('minor', 'Spacing')]), '--late').json;
  assert.equal(r.fix.length, 1);
  const u2 = parseYaml(splitHeader(readFileSync(join(d, '.dwmt', 'runs', 'r-b', 'uat.md'), 'utf8')).yaml);
  assert.deepEqual(u2.defects.map((x) => x.fix), [null, null]);
  // Sprint poprawek w roadmapie: linia pm-2-fix (ready, bugfix bez est) z obydwoma defektami; przebieg z uat.md dostaje run.spec.
  assert.match(pr(d, 'roadmap').out, /^\| (▶ )?\| pm-2-fix \| ready \| Fix B-\d+, B-\d+: Total wrong/m);
  assert.match(pr(d, 'list', '--sprint', 'pm-2-fix').out, /Total wrong[\s\S]*Spacing|Spacing[\s\S]*Total wrong/);
  const rc = pr(d, 'ready-check', 'pm-2-fix');
  assert.deepEqual([rc.json.ok, rc.json.errors], [true, []], 'bugfix bez wymogu est');
  assert.match(pr(d, 'list', '--state', 'new').out, /Label typo/, 'minor bez sprintu poprawek czeka na triaż');
  // N-5: intake sam commituje katalog produktu (wcześniej ręczny commit przed `init`).
  assert.equal(g('status', '--porcelain'), '', 'intake --uat commituje pliki produktu');
  const fix = cli(d, 'init', '--run', 'fix-r', '--mode', 'single', '--input', join(d, '.dwmt', 'runs', 'r-b', 'uat.md')).json;
  assert.deepEqual([fix.ok, fix.kind, RUN(d, 'fix-r').spec], [true, 'uat', 'pm-2-fix'], JSON.stringify(fix));
});

test('uat record bez warstwy produktowej: każdy defekt do sprintu poprawek (v2.10), bez intake', () => {
  const d = repo();
  const g = gitIn(d);
  const dir = join(d, '.dwmt', 'runs', 'r-c');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ schema: 'dwmt/run@1', run: 'r-c', target: 'master', mode: 'single', created: new Date().toISOString(), session_ids: [], tasks: [], finish: { status: 'squashed', commit: g('rev-parse', 'HEAD'), uat: 'pending' } }));
  writeFileSync(join(dir, 'final-report.md'), `${header({ schema: 'dwmt/final-report@1', run: 'r-c', uat: 'pending' })}# R\n`);
  const f = join(d, '..', 'res-c.json');
  writeFileSync(f, JSON.stringify({ result: 'defects', findings: [{ text: 'x', place: 'p', weight: 'minor', kind: 'bug', class: 'test' }] }));
  const r = cli(d, 'uat', 'record', 'r-c', f, '--late').json;
  assert.equal(r.fix.length, 1);
  assert.ok(!('intake' in r));
});

// ---------- B3: pliki ekspertów ----------

test('eksperci wbudowani: po, architect, ux poprawni (expert@1, ≤ 40 linii); PO i UX bez eksploratorów, architekt z **', () => {
  const dir = join(ROOT, 'experts');
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.md')).sort(), ['architect.md', 'po.md', 'ux.md']);
  const e = Object.fromEntries(['po', 'architect', 'ux'].map((x) => [x, parseExpert(join(dir, `${x}.md`), x)]));
  for (const [k, v] of Object.entries(e)) assert.deepEqual(v.errors, [], `${k}: ${v.errors.join('; ')}`);
  assert.deepEqual([e.po.h.explorers.allowed, e.ux.h.explorers.allowed, e.architect.h.explorers.allowed], [false, false, true]);
  assert.deepEqual(e.architect.h.explorers.areas, ['**']);
  // Generyczność: bez ścieżek lokalnych w plikach ekspertów i skillach warstwy produktowej (nazwy projektów sprawdza eksport).
  const texts = [...Object.values(e).map((v) => v.text), ...['po', 'expert', 'architect', 'ux'].map((s) => readFileSync(join(ROOT, 'skills', s, 'SKILL.md'), 'utf8'))];
  for (const t of texts) assert.doesNotMatch(t, /[A-Za-z]:[\\/]Users[\\/]/i);
});

test('Z10: skill po ≤ 150, expert ≤ 60, skróty drzwi ≤ 5 linii; effort high; drzwi tylko na polecenie użytkownika', () => {
  const body = (s) => { const t = readFileSync(join(ROOT, 'skills', s, 'SKILL.md'), 'utf8'); const sp = splitHeader(t); return { n: sp.body.trim().split(/\r?\n/).length, fm: parseYaml(sp.yaml) }; };
  const lim = { po: 150, expert: 60, architect: 5, ux: 5 };
  for (const [s, max] of Object.entries(lim)) {
    const b = body(s);
    assert.ok(b.n <= max, `${s}: ${b.n} > ${max}`);
    if (s === 'expert') {
      // T-4 (D-1): ekspert startuje narzędziem Skill z drzwi; opis mówi, że otwiera się tylko na polecenie użytkownika.
      assert.equal(b.fm.effort, 'high', s);
      assert.notEqual(b.fm['disable-model-invocation'], true, s);
      assert.match(b.fm.description, /only when the user runs/);
    } else assert.deepEqual([b.fm.effort, b.fm['disable-model-invocation']], ['high', true], s);
  }
  // Skróty startują skill ekspertów narzędziem Skill z dziedziną (bez ścieżki pliku: zmienne podstawia Claude Code).
  for (const s of ['ux', 'architect']) {
    const t = readFileSync(join(ROOT, 'skills', s, 'SKILL.md'), 'utf8');
    assert.match(t, new RegExp(`Start skill \`dwmt:expert\` with the Skill tool, args \`${s} \\$ARGUMENTS\``), s);
    assert.match(parseYaml(splitHeader(t).yaml)['allowed-tools'], /\bSkill\b/, s);
    assert.doesNotMatch(t, /SKILL\.md/, s);
  }
});

test('expert start: niepodstawione ${CLAUDE_SESSION_ID} nie trafia do state.json.sessions', () => {
  const d = repo();
  pr(d, 'init', '--goal', 'g');
  const r = pr(d, 'expert', 'start', 'ux', '--session', '${CLAUDE_SESSION_ID}');
  assert.equal(r.code, 0, r.out);
  const st = JSON.parse(readFileSync(join(d, '.dwmt', 'product', 'state.json'), 'utf8'));
  assert.deepEqual(st.sessions.ux, ['sess-1']);
});

test('transkrypty: koszt subagenta po ścieżce w prompcie (estimate-record bez --cost) i pierwsze wywołanie architekta po chwili (P)', async () => {
  const { subagentCostByPrompt, firstAgentCallAfter } = await import('../scripts/lib/sessions.mjs');
  const root = mkdtempSync(join(tmpdir(), 'dwmt-tr-b-'));
  const proj = join(root, 'proj');
  mkdirSync(join(proj, 's1', 'subagents'), { recursive: true });
  const call = (ts, inp, id) => JSON.stringify({ type: 'assistant', timestamp: ts, requestId: id, message: { usage: { input_tokens: inp, output_tokens: 0 } } });
  writeFileSync(join(proj, 's1.jsonl'), `${JSON.stringify({ type: 'user', message: { content: 'hi' } })}\n`);
  const sub = (name, type, prompt, lines) => {
    writeFileSync(join(proj, 's1', 'subagents', `agent-${name}.jsonl`), [JSON.stringify({ type: 'user', message: { content: prompt } }), ...lines].join('\n'));
    writeFileSync(join(proj, 's1', 'subagents', `agent-${name}.meta.json`), JSON.stringify({ agentType: type }));
  };
  sub('a', 'dwmt-architect', 'Mode: product-estimate. Input: C:\\x\\in.md. Result: C:\\x\\estimate-E-1\\result.md.', [call('2026-01-01T00:00:01Z', 300000, 'r1'), call('2026-01-01T00:00:02Z', 200000, 'r2')]);
  sub('b', 'dwmt-architect', 'Plan the sprint … Explorer type: dwmt-explorer', [call('2026-01-02T00:00:00Z', 100000, 'r3'), call('2026-01-03T00:00:00Z', 900000, 'r4')]);
  assert.equal(subagentCostByPrompt(['s1'], 'C:/x/estimate-E-1/result.md', root), 0.5);
  assert.equal(subagentCostByPrompt(['s1'], 'C:/x/estimate-E-2/result.md', root), null);
  assert.equal(firstAgentCallAfter(['s1'], 'dwmt-architect', '2026-01-02T12:00:00Z', root), 0.9);
  assert.equal(firstAgentCallAfter(['s1'], 'dwmt-architect', '2026-02-01T00:00:00Z', root), null);
});
