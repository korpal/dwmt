import './tmp-root.mjs';
// Recenzja N-4 (warstwa produktowa, etap 1, niezależny przegląd): poprawki 1–15. Każdy test pada na kodzie sprzed poprawek.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { repo, gitIn, runFile } from './helpers.mjs';
import { cliAs, RUN, PLAN, repo28, start, writePlans } from './fixtures28.mjs';
import { pr, prEnv, prAsync, dw, write, config, fakeRun, productRepo } from './product-helpers.mjs';
import { priceReport, priceTurnCost } from '../scripts/lib/price-gate.mjs';
import { withLock } from '../scripts/lib/product-store.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STUB = fileURLToPath(new URL('./fixtures-importer-stub.mjs', import.meta.url));
const fwd = (p) => String(p).replace(/\\/g, '/');
const counter = () => join(mkdtempSync(join(tmpdir(), 'dwmt-stub-')), 'count');
const calls = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0);
const R = (d, f) => readFileSync(join(d, 'docs', 'product', f), 'utf8');
const withFiles = (text, files = [3, 8]) => text.replace('questions: []\n', `questions: []\nfiles: ${JSON.stringify(files)}\n`);

function productProject() {
  const d = repo();
  config(d, { verify: { full: ['node -e 0'] }, git: { target: 'master' }, product: {} });
  assert.equal(pr(d, 'init', '--goal', 'Pilot: build cost').code, 0);
  assert.equal(pr(d, 'item', 'add', '--type', 'bug', '--title', 'Date picker shows UTC', '--sev', 'major', '--alias', 'DP-1').code, 0);
  gitIn(d)('add', '-A'); gitIn(d)('commit', '-q', '-m', 'product');
  return d;
}

// ---------- 1: start sprintu przez PO we własnym worktree ----------

test('1: init --worktree: przebieg w .claude/worktrees/<run>, główne drzewo na master i czyste; launch z głównego drzewa; niezacommitowany produkt → odmowa', () => {
  const d = productProject();
  const b = pr(d, 'spec', 'bugfix', 'B-1');
  assert.equal(b.code, 0, b.out);
  const spec = `docs/product/sprints/${b.json.id}.md`;
  const pf = dw(d, ['preflight', '--slug', 'fix']).json;
  const dirty = dw(d, ['init', '--run', pf.run, '--input', spec, '--worktree']);
  assert.equal(dirty.code, 1, dirty.out);
  assert.match(dirty.json.error, /product commit/);
  assert.equal(gitIn(d)('worktree', 'list').split('\n').length, 1, 'bez worktree');
  // Na miejscu też odmowa: `git add -A` przebiegu wziąłby pliki produktu do commitów sprintu.
  const inPlace = dw(d, ['init', '--run', pf.run, '--input', spec]);
  assert.equal(inPlace.code, 1, inPlace.out);
  assert.match(inPlace.json.error, /product commit/);
  assert.equal(gitIn(d)('branch', '--show-current'), 'master');
  assert.equal(pr(d, 'commit').code, 0);
  write(d, '.claude/settings.local.json', '{"permissions":{"allow":["Bash(node:*)"]}}\n');
  const i = dw(d, ['init', '--run', pf.run, '--input', spec, '--worktree']);
  assert.equal(i.code, 0, i.out);
  assert.equal(i.json.ok, true, i.out);
  const wt = i.json.worktree;
  assert.ok(fwd(wt).toLowerCase().endsWith(`/.claude/worktrees/${pf.run}`.toLowerCase()), wt);
  assert.equal(gitIn(d)('branch', '--show-current'), 'master', 'główne drzewo zostaje na gałęzi docelowej');
  assert.ok(!gitIn(d)('status', '--porcelain').includes('worktrees'), 'katalog worktree poza gitem');
  assert.equal(gitIn(wt)('branch', '--show-current'), `dwmt/${pf.run}`);
  assert.ok(existsSync(join(wt, '.dwmt', 'runs', pf.run, 'run.json')));
  assert.ok(!existsSync(runFile(d, pf.run, 'run.json')));
  assert.ok(existsSync(join(wt, '.claude', 'settings.local.json')), 'pliki lokalne skopiowane');
  assert.match(readFileSync(join(wt, '.dwmt', 'runs', pf.run, 'task.md'), 'utf8'), new RegExp(`^${b.json.id} · ready`));
  // launch z głównego drzewa: sesja w tle w worktree przebiegu.
  const fake = join(d, '..', `${pf.run}-claude.mjs`);
  const cwdOut = join(d, '..', `${pf.run}-cwd.txt`);
  writeFileSync(fake, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(cwdOut)}, process.cwd());\nconsole.log('backgrounded · 7f3a9c · x');\n`);
  const home = mkdtempSync(join(tmpdir(), 'dwmt-ch-'));
  const l = dw(d, ['launch', pf.run], { DWMT_CLAUDE: fake, DWMT_CLAUDE_HOME: home });
  assert.equal(l.json?.ok, true, l.out + l.err);
  assert.equal(fwd(readFileSync(cwdOut, 'utf8')).toLowerCase(), fwd(wt).toLowerCase());
  // Tryb A: komendy przebiegu z głównego drzewa trafiają do worktree (sesja PO prowadzi sprint u siebie).
  const st = dw(d, ['state', pf.run], { CLAUDE_CODE_SESSION_ID: 'po-session' });
  assert.equal(st.code, 0, st.out);
  assert.equal(fwd(st.json.dir).toLowerCase(), fwd(join(wt, '.dwmt', 'runs', pf.run, 'tasks', '1')).toLowerCase());
  assert.equal(fwd(st.json.tree).toLowerCase(), fwd(wt).toLowerCase(), 'state podaje drzewo przebiegu sesji spoza niego');
  // Recenzja: sesja PO nie jest sesją przebiegu (koszt tylko w oknie `callers`).
  const rj = JSON.parse(readFileSync(join(wt, '.dwmt', 'runs', pf.run, 'run.json'), 'utf8'));
  assert.ok(!rj.session_ids.includes('po-session'), JSON.stringify(rj.session_ids));
  assert.ok(rj.callers.some((c) => c.id === 'po-session'), JSON.stringify(rj.callers));
  assert.ok(rj.callers.every((c) => !rj.session_ids.includes(c.id)), 'sesje z głównego drzewa tylko w oknie');
  const off = dw(d, ['drive-mode', pf.run, 'off']);
  assert.equal(off.json?.ok, true, off.out);
  assert.equal(JSON.parse(readFileSync(join(wt, '.dwmt', 'runs', pf.run, 'run.json'), 'utf8')).drive, false);
  assert.equal(dw(d, ['drive-mode', pf.run, 'on']).json?.ok, true);
  assert.equal(JSON.parse(readFileSync(join(wt, '.dwmt', 'runs', pf.run, 'run.json'), 'utf8')).drive, undefined);
  const lg = dw(d, ['drive-log', pf.run]);
  assert.deepEqual([lg.json?.ok, lg.json?.running, lg.json?.lines], [true, false, []], lg.out);
  // Ten sam slug: gałąź zajęta, więc nowy identyfikator.
  assert.notEqual(dw(d, ['preflight', '--slug', 'fix']).json.run, pf.run);
  // Sprint niegotowy: odmowa bez śladów (bez worktree i gałęzi).
  assert.equal(pr(d, 'roadmap', 'add', 's2', '--goal', 'Offline sync').code, 0);
  assert.equal(pr(d, 'spec', 'new', 's2').code, 0);
  assert.equal(pr(d, 'commit').code, 0);
  const pf2 = dw(d, ['preflight', '--slug', 'notes']).json;
  const n = dw(d, ['init', '--run', pf2.run, '--input', 'docs/product/sprints/s2.md', '--worktree']).json;
  assert.deepEqual([n.ok, n.notReady], [false, true]);
  assert.equal(gitIn(d)('worktree', 'list').split('\n').length, 2);
  assert.equal(gitIn(d)('branch', '--list', `dwmt/${pf2.run}`), '');
});

// ---------- 2, 12: paczki importu po skrócie, agent i wtyczki ----------

const DOC = '# Plan\n\n## Appendix\n- A-1 Duplicate query in `src/a.ts`\n- A-2 Slow export\n- A-3 Rename module\n\n## Decisions\n- Export never shows drafts.\n- Prices include VAT.\n';
function importProject(doc = DOC, setup = true) {
  const d = repo();
  write(d, 'docs/PLAN.md', doc);
  write(d, 'src/a.ts', 'export const a = 1;\n');
  config(d, { product: { import: { batch: 2, sources: [{ name: 'main', path: 'docs/PLAN.md', adapter: 'md-sections', rules: [{ name: 'appendix', heading: '> Appendix', kind: 'item', type: 'debt', triage: 'later' }, { name: 'dec', heading: '> Decisions', kind: 'decision' }] }] } } });
  if (setup) assert.equal(dw(d, ['setup']).code, 0);
  gitIn(d)('add', '-A'); gitIn(d)('commit', '-q', '-m', 'project');
  return d;
}

test('2: import po nieudanej paczce: ponowny run kondensuje resztę (pliki paczek po skrócie kawałków), wynik spoza paczki odrzucony', () => {
  const d = importProject();
  const count = counter();
  const first = prEnv(d, { DWMT_CLAUDE: STUB, STUB_COUNT: count, STUB_FAIL: 'A-3' }, 'import', 'run');
  assert.equal(first.json.ok, false, first.out);
  assert.equal(first.json.sources.main.failed.length, 1);
  const dir = join(d, '.dwmt', 'product', 'import', 'main');
  assert.ok(readdirSync(dir).filter((f) => f.startsWith('batch-')).every((f) => /^batch-[0-9a-f]{12}\.(in|out)\.jsonl$/.test(f)), readdirSync(dir).join(' '));
  assert.equal(readdirSync(dir).filter((f) => f.endsWith('.out.jsonl')).length, 2, 'wynik nieudanej paczki usunięty');
  const second = prEnv(d, { DWMT_CLAUDE: STUB, STUB_COUNT: count }, 'import', 'run');
  assert.equal(second.code, 0, second.out);
  assert.equal(second.json.ok, true, second.out);
  const items = R(d, 'backlog.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(items.map((x) => x.alias).sort(), ['A-1', 'A-2', 'A-3']);
  assert.equal((R(d, 'decisions.md').match(/^### PD-\d+/gm) ?? []).length, 2);
  assert.equal(second.json.sources.main.rejected, 0);
});

test('12: import bez agenta dwmt-importer odmawia przed wydatkiem; agent claude -p bez innych wtyczek (launch.lean)', () => {
  const d = importProject(DOC, false);
  const count = counter();
  const no = prEnv(d, { DWMT_CLAUDE: STUB, STUB_COUNT: count }, 'import', 'run');
  assert.equal(no.code, 1, no.out);
  assert.match(no.json.error, /dwmt-importer.*setup/);
  assert.equal(calls(count), 0);
  assert.equal(gitIn(d)('branch', '--show-current'), 'master');
  assert.equal(dw(d, ['setup']).code, 0);
  const home = mkdtempSync(join(tmpdir(), 'dwmt-ch-'));
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ enabledPlugins: { 'other@market': true, 'dwmt@local': true } }));
  const argsOut = join(mkdtempSync(join(tmpdir(), 'dwmt-args-')), 'args.json');
  const ok = prEnv(d, { DWMT_CLAUDE: STUB, STUB_ARGS: argsOut, DWMT_CLAUDE_HOME: home }, 'import', 'run');
  assert.equal(ok.code, 0, ok.out);
  const args = JSON.parse(readFileSync(argsOut, 'utf8'));
  assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]), { enabledPlugins: { 'other@market': false } });
});

// ---------- 3: gotowość przed zleceniem i kolejność kroków PO ----------

test('3: roadmap set ordered tylko ze stanu ready; skill po: cena przyjęta → est, mode, ready --direct, commit, start w worktree', () => {
  const d = productProject();
  assert.equal(pr(d, 'roadmap', 'add', 's1', '--goal', 'Offline sync').code, 0);
  assert.equal(pr(d, 'spec', 'new', 's1').code, 0);
  const no = pr(d, 'roadmap', 'set', 's1', 'state', 'ordered');
  assert.equal(no.code, 1, no.out);
  assert.match(no.json.error, /ordered tylko ze stanu ready.*product ready s1/);
  const b = pr(d, 'spec', 'bugfix', 'B-1').json;
  assert.equal(pr(d, 'roadmap', 'set', b.id, 'state', 'ordered').code, 0);
  const po = readFileSync(join(ROOT, 'skills', 'po', 'SKILL.md'), 'utf8');
  assert.match(po, /after yes `spec set X est start:\[min,max\] mode <mode>`, `ready X --direct`, then execute below/);
  assert.doesNotMatch(po, /`ready-check X --direct`, then start work below/);
  assert.match(po, /`product commit` \(the run commits the whole tree\)/);
  assert.match(po, /`roadmap set <id> state ordered` \(only from `ready`\), then `product commit`/);
  // Tryb A (2026-10-04): jeden sprint w sesji PO (worktree + skill execute), bez `launch`.
  assert.match(po, /\[--estimate <min,max>\] --worktree`, then the `dwmt:execute` skill with `<run>`/);
});

// ---------- 4, 13: bramka ceny ----------

test('4: próg askAboveM pyta także w granicy szacunku; powód w treści pytania', () => {
  const { d } = repo28({ run: { priceGate: { askAboveM: 1 } } });
  const run = start(d, 'th', '--estimate', '5,10');
  writePlans(d, run, { plan: withFiles(PLAN(run)) });
  const st = cliAs(d, 'sess-1', 'state', run).json;
  assert.deepEqual([st.next, st.questions], ['ask-plan', ['Q-price']], JSON.stringify(st));
  assert.match(st.price.text, /^Why I ask: the design is above the project's price threshold of 1 M tokens\. Design: ~3-8 files/);
  assert.deepEqual(RUN(d, run).price.reasons, ['above-threshold']);
});

test('13: raport gate over ponad granicą bez pytania; nieaktualny E-n nie jest granicą; P tylko z wywołania architekta po „zmniejsz zakres”', () => {
  assert.equal(priceReport({ priceGate: true, price: { gate: 'none', estimate: [5, 10], design: [1, 20], limit: 15, files: [5, 100] } }).gate, 'over');
  assert.equal(priceReport({ priceGate: true, price: { gate: 'none', estimate: [5, 10], design: [1, 12], limit: 15, files: [5, 60] } }).gate, 'none');

  // Szacunek stale (zakres zmieniony po szacunku): init bez granicy szacunku i z ostrzeżeniem.
  const d = productProject();
  const b = pr(d, 'spec', 'bugfix', 'B-1').json;
  write(d, '.dwmt/product/estimate-E-1/result.md', `---\nschema: dwmt/estimate-result@1\nentries:\n  - {for: [${b.id}], areas: ["src/**"], files: [2, 4], flags: {newArea: false, contract: false, migration: false, screens: 0}, split: null}\n---\n## Facts\n- x\n`);
  assert.equal(pr(d, 'estimate-record', 'E-1', '--cost', '0.2').code, 0);
  assert.equal(pr(d, 'spec', 'set', b.id, '--section', 'Goal', '--text', 'Fix the date picker and the export dates.').code, 0);
  assert.equal(pr(d, 'commit').code, 0);
  const pf = dw(d, ['preflight', '--slug', 'stale']).json;
  const i = dw(d, ['init', '--run', pf.run, '--input', `docs/product/sprints/${b.id}.md`]).json;
  assert.equal(i.ok, true, JSON.stringify(i));
  assert.equal(RUN(d, pf.run).estimate, null);
  assert.ok(i.warnings.some((w) => /stale/.test(w)), JSON.stringify(i.warnings));

  // P: „dalej” nie wznawia architekta (P = 0, nawet gdy później jest replan); „zmniejsz zakres”: wywołanie w oknie odpowiedzi.
  const root = mkdtempSync(join(tmpdir(), 'dwmt-tr-p-'));
  const proj = join(root, 'proj');
  mkdirSync(join(proj, 's1', 'subagents'), { recursive: true });
  const call = (ts, inp, id) => JSON.stringify({ type: 'assistant', timestamp: ts, requestId: id, message: { usage: { input_tokens: inp, output_tokens: 0 } } });
  writeFileSync(join(proj, 's1.jsonl'), `${JSON.stringify({ type: 'user', message: { content: 'hi' } })}\n`);
  writeFileSync(join(proj, 's1', 'subagents', 'agent-a.jsonl'), [JSON.stringify({ type: 'user', message: { content: 'Plan the sprint' } }), call('2026-01-01T00:00:30Z', 300000, 'r1')].join('\n'));
  writeFileSync(join(proj, 's1', 'subagents', 'agent-a.meta.json'), JSON.stringify({ agentType: 'dwmt-architect' }));
  const old = process.env.DWMT_TRANSCRIPTS;
  process.env.DWMT_TRANSCRIPTS = root;
  try {
    const at = '2026-01-01T00:00:00Z';
    assert.equal(priceTurnCost({ session_ids: ['s1'], price: { onlyTurn: true, answer: { kind: 'continue', at } } }), 0);
    assert.equal(priceTurnCost({ session_ids: ['s1'], price: { onlyTurn: true, answer: { kind: 'shrink', at }, handledAt: '2026-01-01T00:00:10Z' } }), 0, 'późniejszy replan');
    assert.equal(priceTurnCost({ session_ids: ['s1'], price: { onlyTurn: true, answer: { kind: 'shrink', at }, handledAt: '2026-01-01T00:01:00Z' } }), 0.3);
  } finally { if (old === undefined) delete process.env.DWMT_TRANSCRIPTS; else process.env.DWMT_TRANSCRIPTS = old; }
});

// ---------- 6: brief PO i drzwi ekspertów ----------

test('6: expert start po nie zeruje „nowych decyzji z innych drzwi” w briefie PO; własne decyzje PO się tam nie liczą', () => {
  const d = productRepo(repo);
  pr(d, 'brief');
  const ux = pr(d, 'decision', 'add', '--by', 'ux', '--confirmed', 'yes, two steps', '--title', 'Two steps max', '--area', 'ux', '--decision', 'Wizard has two steps');
  assert.equal(ux.code, 0, ux.out);
  assert.equal(pr(d, 'decision', 'add', '--title', 'Export accepted only', '--area', 'export', '--decision', 'Export lists accepted items').code, 0);
  assert.equal(pr(d, 'expert', 'start', 'po', '--session', 's-po').code, 0);
  const b = pr(d, 'brief').out;
  assert.match(b, /new from other doors: PD-1 added \(ux\): Two steps max$/m);
  assert.doesNotMatch(b, /PD-2 added \(po\)/);
  const st = JSON.parse(readFileSync(join(d, '.dwmt', 'product', 'state.json'), 'utf8'));
  assert.ok(st.doorBrief.po && st.lastBrief.po);
});

// ---------- 7: import a przebiegi w toku ----------

test('7: import run odmawia przy przebiegu w toku (--force pozwala); init na gałęzi importu odmawia', () => {
  const d = importProject();
  const count = counter();
  write(d, '.dwmt/runs/r-act/run.json', JSON.stringify({ schema: 'dwmt/run@1', run: 'r-act', finish: null }));
  const no = prEnv(d, { DWMT_CLAUDE: STUB, STUB_COUNT: count }, 'import', 'run');
  assert.equal(no.code, 1, no.out);
  assert.match(no.json.error, /przebiegi w toku: r-act/);
  assert.equal(calls(count), 0);
  assert.equal(gitIn(d)('branch', '--show-current'), 'master');
  const yes = prEnv(d, { DWMT_CLAUDE: STUB, STUB_COUNT: count }, 'import', 'run', '--force');
  assert.equal(yes.code, 0, yes.out);
  assert.equal(gitIn(d)('branch', '--show-current'), 'dwmt/product-import');
  const i = dw(d, ['init', '--run', 'x-run']);
  assert.equal(i.code, 1, i.out);
  assert.match(i.json.error, /gałąź importu produktu: najpierw git switch master/);
});

// ---------- 8, 9: szacunek bez eksploratorów, dziennik promptów ----------

test('8, 9: input.md szacunku zabrania eksploratorów i innych agentów; nowe linie promptów w prompt-log', () => {
  const d = productRepo(repo);
  pr(d, 'item', 'add', '--type', 'feature', '--title', 'Export filter');
  const inp = pr(d, 'estimate-input', 'B-1');
  assert.equal(inp.code, 0, inp.out);
  assert.match(readFileSync(inp.json.input, 'utf8'), /^Start no explorers and no other agent \(no Agent tool\): the price of this estimate assumes none\. Write no plans; write only result\.md\.$/m);
  const log = readFileSync(join(ROOT, 'docs', 'prompt-log.md'), 'utf8');
  for (const s of ['Start no explorers and no other agent', 'The user asked to shrink the scope at the price question', 'so plan the smaller scope (also `files`)', '`priceNote`', 'Mode: product-estimate. Areas from docs', 'sprint-16, phase-3']) assert.ok(log.includes(s), s);
});

// ---------- 10, 11: sync i przebiegi zatrzymane, alias w --item ----------

test('10: sync pomija przebieg zatrzymany: linia nie zostaje running (wraca do ready)', () => {
  const d = productProject();
  const b = pr(d, 'spec', 'bugfix', 'B-1').json;
  const { dir } = fakeRun(d, 'r-stop', { spec: b.id, status: null });
  assert.equal(pr(d, 'sync').code, 0);
  assert.match(R(d, 'roadmap.md'), new RegExp(`\\| ${b.id} \\| running \\|`));
  const rj = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ ...rj, stopped: { reason: 'price', at: '2026-10-04T10:00:00Z' } }));
  assert.equal(pr(d, 'sync').code, 0);
  assert.match(R(d, 'roadmap.md'), new RegExp(`\\| ${b.id} \\| ready \\|`));
  assert.equal(pr(d, 'sync').code, 0);
  assert.match(R(d, 'roadmap.md'), new RegExp(`\\| ${b.id} \\| ready \\|`), 'trwale');
});

test('11: init --item z aliasem zapisuje B-n w run.items (sync zamyka po B-n)', () => {
  const d = productProject();
  const pf = dw(d, ['preflight', '--slug', 'alias']).json;
  const i = dw(d, ['init', '--run', pf.run, '--mode', 'inline', '--item', 'DP-1']).json;
  assert.equal(i.ok, true, JSON.stringify(i));
  assert.deepEqual(RUN(d, pf.run).items, ['B-1']);
});

// ---------- 14: blokada zapisu produktu ----------

test('14: zwolnienie blokady nie usuwa blokady przejętej przez inny proces; martwa blokada przejmowana przez jeden proces naraz', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwmt-lock-'));
  const P = { work: join(dir, 'w'), lock: join(dir, 'w', 'lock') };
  const other = JSON.stringify({ pid: 4242, at: new Date().toISOString(), nonce: 'other' });
  withLock(P, () => writeFileSync(P.lock, other));
  assert.equal(readFileSync(P.lock, 'utf8'), other, 'cudza blokada zostaje');
  rmSync(P.lock);
  assert.equal(withLock(P, () => 7), 7);
  assert.ok(!existsSync(P.lock), 'własna zwolniona');
  // Martwa blokada (proces nie żyje) i cztery równoczesne zapisy: numeracja PD-n bez powtórzeń.
  const d = productRepo(repo);
  write(d, '.dwmt/product/lock', JSON.stringify({ pid: 999999, at: '2026-01-01T00:00:00Z' }));
  const rs = await Promise.all([1, 2, 3, 4].map((n) => prAsync(d, ['decision', 'add', '--title', `T${n}`, '--area', 'x', '--decision', `D${n}`])));
  assert.deepEqual(rs.map((r) => r.code), [0, 0, 0, 0], rs.map((r) => r.out).join('\n'));
  assert.deepEqual(rs.map((r) => r.json.id).sort(), ['PD-1', 'PD-2', 'PD-3', 'PD-4']);
});

// ---------- 15: retire zachowuje CRLF, przykład importera neutralny ----------

test('15: import retire zachowuje CRLF pliku źródłowego; szablon importera bez nazw projektu', () => {
  const d = importProject(DOC.replace(/\n/g, '\r\n'));
  assert.equal(prEnv(d, { DWMT_CLAUDE: STUB }, 'import', 'run').code, 0);
  gitIn(d)('switch', 'master');
  gitIn(d)('merge', '-q', '--no-edit', 'dwmt/product-import');
  const r = prEnv(d, {}, 'import', 'retire', '--source', 'main');
  assert.equal(r.code, 0, r.out);
  const text = readFileSync(join(d, 'docs', 'PLAN.md'), 'utf8');
  assert.match(text, /> Moved to `docs\/product\/`/);
  assert.ok(text.includes('\r\n') && !/[^\r]\n/.test(text), JSON.stringify(text.slice(0, 120)));
  assert.doesNotMatch(readFileSync(join(ROOT, 'templates', 'agents', 'dwmt-importer.md'), 'utf8'), /pm-\d/);
});
