import './tmp-root.mjs';
// Przegląd pm-16-ui (2026-10-05): dobór trybu (wielkość z tego sprintu, uwagi z recenzji osobno, eksploratorzy według
// obszaru), czas życia cache ról roboczych sterownika, czerwień znana z wcześniejszych zadań.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { repo, header, runFile } from './helpers.mjs';

// ---------- 1. dobór trybu ----------

test('start-check: pliki analogii (dawne duże sprinty) nie wybierają trybu; bez szacunku decyduje zbiór roboczy', async () => {
  const { pr, productRepo, write, fakeRun } = await import('./product-helpers.mjs');
  const d = productRepo(repo);
  write(d, 'src/mid/a.ts', 'x'.repeat(400000));
  spawnSync('git', ['add', '-A'], { cwd: d }); spawnSync('git', ['commit', '-q', '-m', 'code'], { cwd: d });
  fakeRun(d, 'big', { files: Array.from({ length: 70 }, (_, i) => `src/mid/f${i}.ts`), cost: 15 });
  pr(d, 'item', 'add', '--type', 'feature', '--title', 'Mid feature');
  const r = pr(d, 'start-check', '--item', 'B-1', '--globs', 'src/mid/**').json;
  assert.deepEqual(r.analog.files, [70, 70]);
  assert.equal(r.recommend, 'intermediate', JSON.stringify(r));
  assert.match(r.basis, /^size: working set \d/);
});

function reviewSource(d, run, body) {
  const dir = join(d, '.dwmt', 'runs', run, 'tasks', '1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'review-1.md'), `${header({ schema: 'dwmt/review@1', round: 1, verdict: 'FIX' })}\n${body}`);
}

test('start-check: uwagi z recenzji z szeroką kotwicą — wielkość z plików wskazanych w treści uwag (direct do progu)', async () => {
  const { pr, productRepo, write } = await import('./product-helpers.mjs');
  const d = productRepo(repo);
  write(d, 'src/e2e/big.ts', 'x'.repeat(400000));
  spawnSync('git', ['add', '-A'], { cwd: d }); spawnSync('git', ['commit', '-q', '-m', 'code'], { cwd: d });
  reviewSource(d, 'old', '### F-1 [minor] Ids are reused\n- Evidence: `src/e2e/state.ts:12` and `src/e2e/batches.ts:40`; not `backend/.../X.java`\n\n### F-2 [minor] No file name\n- Evidence: `src/e2e/batches.ts:88` and `state.ts:30` (same file as above), see src/e2e/package.json and `node_modules/ajv/dist/x.js`\n');
  for (const [t, f] of [['Ids are reused', 'F-1'], ['No file name', 'F-2']]) {
    pr(d, 'item', 'add', '--type', 'remark', '--title', t);
  }
  const fs = (id, f) => {
    const p = join(d, 'docs', 'product', 'backlog.jsonl');
    const rows = readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    rows.find((x) => x.id === id).src = `review:old/T-1/${f}`;
    rows.find((x) => x.id === id).anchors = ['src/e2e/**'];
    writeFileSync(p, `${rows.map((x) => JSON.stringify(x)).join('\n')}\n`);
  };
  fs('B-1', 'F-1'); fs('B-2', 'F-2');
  const r = pr(d, 'start-check', '--item', 'B-1,B-2', '--globs', 'src/e2e/**').json;
  assert.equal(r.small, false);
  assert.deepEqual([r.recommend, r.pinnedFiles], ['direct', 3], JSON.stringify(r));
  assert.match(r.basis, /size: 3 pinned files/);
});

test('touch: uwagi z recenzji nie jadą przy okazji (separate), inne zakotwiczone tak; start-check sprintu też je wskazuje', async () => {
  const { pr, productRepo, write } = await import('./product-helpers.mjs');
  const d = productRepo(repo);
  write(d, 'src/ui/view.ts', 'x'.repeat(4000));
  write(d, 'src/e2e/state.ts', 'x'.repeat(4000));
  spawnSync('git', ['add', '-A'], { cwd: d }); spawnSync('git', ['commit', '-q', '-m', 'code'], { cwd: d });
  reviewSource(d, 'old', '### F-1 [minor] Ids are reused\n- Evidence: `src/e2e/state.ts:12`\n');
  pr(d, 'item', 'add', '--type', 'feature', '--title', 'Drag files');
  pr(d, 'item', 'add', '--type', 'remark', '--title', 'Ids are reused');
  pr(d, 'item', 'add', '--type', 'debt', '--title', 'Suppressed lint in view');
  const p = join(d, 'docs', 'product', 'backlog.jsonl');
  const rows = readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  Object.assign(rows.find((x) => x.id === 'B-2'), { src: 'review:old/T-1/F-1', anchors: ['src/e2e/**'], triage: 'touch', state: 'open' });
  Object.assign(rows.find((x) => x.id === 'B-3'), { anchors: ['src/ui/view.ts'], triage: 'touch', state: 'open' });
  writeFileSync(p, `${rows.map((x) => JSON.stringify(x)).join('\n')}\n`);
  assert.equal(pr(d, 'roadmap', 'add', 's1', '--goal', 'Drag files').code, 0);
  assert.equal(pr(d, 'spec', 'new', 's1', '--items', 'B-1').code, 0);
  const t = pr(d, 'touch', 's1', '--globs', 'src/ui/**,src/e2e/**').json;
  assert.equal(t.added.length, 1, JSON.stringify(t));
  assert.match(t.added[0], /B-3/);
  assert.deepEqual(t.separate, { items: ['B-2'], files: 1, recommend: 'direct' });
  // Uwaga dopisana do touch wcześniej (przed tą zmianą): start-check sprintu ją wskazuje.
  assert.equal(pr(d, 'spec', 'set', 's1', 'touch', '+B-2').code, 0);
  const r = pr(d, 'start-check', '--spec', 's1', '--globs', 'src/ui/**,src/e2e/**').json;
  assert.deepEqual(r.separate, { items: ['B-2'], files: 1, recommend: 'direct' });
});

test('tryb pośredni: architekt ma eksploratorów według obszaru (nie według trybu); sterownik nie odbiera mu Agent', async () => {
  const { repo28, start, cliAs } = await import('./fixtures28.mjs');
  const { d } = repo28();
  const run = start(d, 'i1', '--mode', 'intermediate');
  const st = cliAs(d, 'sess-1', 'state', run).json;
  assert.equal(st.agent, 'dwmt-architect', JSON.stringify(st));
  assert.match(st.prompt, /Explorer type: dwmt-explorer/);
  assert.match(st.prompt, /Self-read limit: 30k tokens per area/);
  assert.match(st.prompt, /Mode: intermediate: the sprint is exactly one task \(T-1\), reviewed once at the end; explorers only by the area rule, never because of the mode/);
  assert.match(readFileSync(join(d, '.claude', 'agents', 'dwmt-architect.md'), 'utf8'), /whatever the number of tasks and whatever the mode/);
});

// ---------- 2. czas życia cache ----------

test('sterownik: role robocze z cache 5 min, architekt bez zmiany (czeka na użytkownika); własne ustawienie środowiska wygrywa', async () => {
  const { agentEnv, agentArgs } = await import('../scripts/drive.mjs');
  const cfg = { drive: { workerCacheTtl: '5m' } };
  const base = { CLAUDE_CODE_SESSION_ID: 'po', PATH: 'x' };
  for (const a of ['dwmt-executor', 'dwmt-executor-high', 'dwmt-reviewer', 'dwmt-ui-verifier', 'dwmt-checker']) {
    const e = agentEnv(base, cfg, a);
    assert.equal(e.CLAUDE_CODE_PROMPT_CACHE_TTL, '5m', a);
    assert.equal(e.CLAUDE_CODE_SESSION_ID, undefined);
  }
  assert.equal(agentEnv(base, cfg, 'dwmt-architect').CLAUDE_CODE_PROMPT_CACHE_TTL, undefined);
  assert.equal(agentEnv({ ...base, CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }, cfg, 'dwmt-reviewer').CLAUDE_CODE_PROMPT_CACHE_TTL, '1h');
  assert.equal(agentEnv(base, { drive: { workerCacheTtl: null } }, 'dwmt-reviewer').CLAUDE_CODE_PROMPT_CACHE_TTL, undefined);
  assert.equal(base.CLAUDE_CODE_SESSION_ID, 'po', 'środowisko sterownika nietknięte');
  // T-4 (R-3): agent sterownika niesie znacznik przebiegu dla strażnika; środowisko bazowe bez niego.
  const marked = { PATH: 'x' };
  assert.equal(agentEnv(marked, cfg, 'dwmt-executor', 'r-1').DWMT_RUN, 'r-1');
  assert.equal(agentEnv(marked, cfg, 'dwmt-architect', 'r-1').DWMT_RUN, 'r-1');
  assert.equal(marked.DWMT_RUN, undefined);
  assert.ok(!agentArgs({ cfg: { model: 'opus' }, agent: 'dwmt-architect', prompt: 'p' }).includes('--disallowedTools'));
});

test('config: domyślny drive.workerCacheTtl = 5m', async () => {
  const { loadConfig } = await import('../scripts/lib/config.mjs');
  const d = repo();
  assert.equal(loadConfig(d).drive.workerCacheTtl, '5m');
});

// ---------- 3. czerwień znana z wcześniejszych zadań ----------

test('czerwień znana: twierdzenie zatwierdzonego T-1 przechodzi do T-2 (prompt, verify bez naprawy, wejście recenzji)', async () => {
  const { repo28, start, writePlans, cliAs, T1, T2, review } = await import('./fixtures28.mjs');
  const red = 'node -e "process.exit(1)"';
  const claim = `\`${red}\`: red on the base commit already (stale spec locator)`;
  const { d } = repo28({ verify: { full: ['node -e 0'], targeted: null } });
  const run = start(d, 'kr');
  writePlans(d, run, { t1: T1(run, { verify: ['node -e 0', red] }), t2: T2(run, { verify: ['node -e "2"', red] }) });
  assert.equal(cliAs(d, 'sess-1', 'state', run).json.next, 'implement');
  writeFileSync(join(d, 'src', 'billing', 'discount.ts'), 'export class Discount {}\n');
  writeFileSync(runFile(d, run, 'result-1.md', 1), header({ schema: 'dwmt/result@1', status: 'DONE', unrelatedRed: [claim] }));
  assert.deepEqual(cliAs(d, 'sess-1', 'verify', run).json.expectedRed, [red]);
  assert.equal(cliAs(d, 'sess-1', 'review-input', run).json.ok, true);
  writeFileSync(runFile(d, run, 'review-1.md', 1), review(1, {}));
  assert.equal(cliAs(d, 'sess-1', 'commit', run).json.next, 'handoff');

  const st = cliAs(d, 'sess-2', 'state', run).json;
  assert.deepEqual([st.task, st.next], [2, 'implement'], JSON.stringify(st));
  assert.match(st.prompt, /Known red from earlier tasks of this sprint \(their reviews accepted it as not caused by their change\): T-1: `node -e "process\.exit\(1\)"`: red on the base commit already/);
  writeFileSync(join(d, 'src', 'summary', 'view.ts'), 'export const view = 2;\n');
  writeFileSync(runFile(d, run, 'result-1.md', 2), header({ schema: 'dwmt/result@1', status: 'DONE' }));
  const v = cliAs(d, 'sess-2', 'verify', run).json;
  assert.deepEqual([v.result, v.repair, v.expectedRed], ['fail', undefined, [red]], JSON.stringify(v));
  assert.equal(cliAs(d, 'sess-2', 'review-input', run).json.ok, true);
  const ri = readFileSync(runFile(d, run, 'review-input.md', 2), 'utf8');
  assert.match(ri, /## Red tests known from earlier tasks \(accepted by their reviews\)\n\n- T-1: `node -e "process\.exit\(1\)"`: red on the base commit already/);
  assert.ok(!/attributes to other causes/.test(ri), 'bez powtórki tej samej czerwieni jako twierdzenia wykonawcy');
});

test('czerwień znana: zadanie bez commitu (niezatwierdzone) nie przekazuje swoich twierdzeń', async () => {
  const { knownRed, knownRedPrompt, knownRedSection } = await import('../scripts/lib/known-red.mjs');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'dwmt-kr-'));
  for (const k of [1, 2]) {
    mkdirSync(join(root, 'tasks', String(k)), { recursive: true });
    writeFileSync(join(root, 'tasks', String(k), 'result-1.md'), header({ schema: 'dwmt/result@1', status: 'DONE', unrelatedRed: [`cmd${k}: old red`] }));
  }
  writeFileSync(join(root, 'tasks', '1', 'repair-1.md'), header({ schema: 'dwmt/result@1', status: 'DONE', unrelatedRed: ['cmd1: old red', 'cmd9: other'] }));
  const run = { tasks: [{ k: 1, commit: 'abc' }, { k: 2 }, { k: 3, commit: 'def' }] };
  assert.deepEqual(knownRed(root, run), [{ k: 1, claim: 'cmd1: old red' }, { k: 1, claim: 'cmd9: other' }]);
  assert.deepEqual(knownRed(root, run, 1), []);
  assert.equal(knownRedPrompt([]), '');
  assert.deepEqual(knownRedSection([]), []);
});

// ---------- raport końcowy po rundzie zbiorczej ----------

test('raport: kryterium i ryzyko po partii — status z recenzji partii albo „po partii”, gdy partia rozwiązała wszystkie wymienione F-n', async () => {
  const { batchStatuses } = await import('../scripts/lib/report.mjs');
  const mk = (k, acceptance, riskStatus) => ({ k, acceptance, risks: Object.keys(riskStatus).map((id) => ({ id })), riskStatus });
  const data = [
    mk(2, ['AC-3 met', 'AC-6 partial: strip covers the field (F-8)'], { 'R-1': 'R-1 proven', 'R-8': 'R-8 unproven: the strip covers the field (F-8 open)' }),
    mk(4, ['AC-8 (B-176) partial: the test passes without the format (F-1)', 'AC-9 not met: guard missing (F-2, F-3)'], { 'R-2': 'R-2 unproven for the date-time case (F-1)', 'R-1': 'R-1 unproven (F-9)' }),
  ];
  batchStatuses(data, {
    resolved: new Set(['T-2/F-8', 'T-4/F-1', 'T-4/F-2']),
    reviews: [{ acceptance: ['AC-6 met (screen part: strip above the composer)'], risks: ['T-2/R-8 proven', 'R-1 unproven'] }],
    many: true,
  });
  assert.deepEqual(data[0].acceptance, ['AC-3 met', 'AC-6 met (screen part: strip above the composer) (fix batch review)']);
  assert.equal(data[0].riskStatus['R-8'], 'R-8 proven (fix batch review)');
  assert.equal(data[0].riskStatus['R-1'], 'R-1 proven', 'spełnione zostają');
  assert.deepEqual(data[1].acceptance, ['AC-8 (B-176) met after the fix batch (F-1 resolved)', 'AC-9 not met: guard missing (F-2, F-3)'], 'F-3 nierozwiązana: bez zmiany');
  assert.equal(data[1].riskStatus['R-2'], 'R-2 proven after the fix batch (F-1 resolved)');
  assert.equal(data[1].riskStatus['R-1'], 'R-1 unproven (F-9)', 'ryzyko bez przedrostka w recenzji partii nie dotyczy zadań przy wielu zadaniach');
});
