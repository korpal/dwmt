import './tmp-root.mjs';
// Przegląd 2026-10-04 (sprint poprawek, sprint 9): koszty ról pod sterownikiem i łańcuch sesji, `state` sesji obserwatora pod
// sterownikiem, przedział ceny p25–p75, pola `item set` jako opcje, sprzątanie worktree przebiegu z sesji spoza niego.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { sessionsCost } from '../scripts/dwmt.mjs';
import { mPerFile, priceRange } from '../scripts/lib/price.mjs';
import { repo, prepared, runFile, SCRIPT, DWMT_HOME } from './helpers.mjs';

const line = (u, rid, extra = {}) => JSON.stringify({ type: 'assistant', requestId: rid, timestamp: '2026-10-04T10:00:00.000Z', message: { usage: u }, ...extra });

test('sessionsCost: rola sesji `claude -p --agent` z agent-setting; kontynuacja sesji liczona raz (continued-in)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dwmt-tr-'));
  mkdirSync(join(root, 'proj'), { recursive: true });
  writeFileSync(join(root, 'proj', 'exec.jsonl'), [JSON.stringify({ type: 'agent-setting', agentSetting: 'dwmt-executor', sessionId: 'exec' }), line({ input_tokens: 1e6 }, 'e1')].join('\n'));
  writeFileSync(join(root, 'proj', 'po-1.jsonl'), [line({ input_tokens: 1e6 }, 'p1'), JSON.stringify({ type: 'continued-in', continuedInSessionId: 'po-2' })].join('\n'));
  // Kontynuacja kopiuje wcześniejsze wpisy (ten sam requestId) i dopisuje nowe.
  writeFileSync(join(root, 'proj', 'po-2.jsonl'), [line({ input_tokens: 1e6 }, 'p1'), line({ input_tokens: 5e5 }, 'p2')].join('\n'));
  assert.deepEqual(sessionsCost(['exec'], root), { total: 1, byRole: { 'dwmt-executor': 1 }, sessions: 1 });
  assert.deepEqual(sessionsCost(['po-1'], root), { total: 1.5, byRole: { orchestrator: 1.5 }, sessions: 1 });
  assert.deepEqual(sessionsCost(['po-1', 'po-2'], root).total, 1.5, 'sesja z łańcucha podana też wprost nie liczy się drugi raz');
});

test('cena: przedział z p25–p75 kosztu na plik, nie z samej mediany', () => {
  const runs = [0.1, 0.13, 0.14, 0.18, 0.45].map((m, i) => ({ run: `r${i}`, mode: 'single', mPerFile: m }));
  const k = mPerFile(runs, 'single', null);
  // Przegląd 2026-10-09 (W-4): × (1 + udział rundy zbiorczej); bez danych o partii 0,15.
  assert.deepEqual([k.m, k.lo, k.hi, k.basis], [0.14, 0.13, 0.18, 'single n=5; batch +15% default']);
  assert.deepEqual(priceRange([30, 38], k), [4.5, 7.9]);
  const d = mPerFile([], 'single', null);
  assert.equal(d.lo, d.m);
});

function dwmt(d, sid, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: d, encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: sid, DWMT_HOME } });
  return JSON.parse(r.stdout);
}

test('state pod sterownikiem: sesja-obserwator nie zapisuje startu rundy; sterownik zapisuje (bez fałszywego „continue”)', () => {
  const d = repo();
  const run = prepared(d);
  const cfgFile = join(d, '.claude', 'dwmt.json');
  writeFileSync(cfgFile, readFileSync(cfgFile, 'utf8').replace('{', '{\n  "drive": { "enabled": true },'));
  const started = () => JSON.parse(readFileSync(runFile(d, run, 'run.json'), 'utf8')).tasks[0].started;
  const po = dwmt(d, 'sess-po', 'state', run);
  assert.deepEqual([po.next, po.drive], ['implement', true]);
  assert.deepEqual(started(), {});
  const drv = dwmt(d, `drive-${run}-T1`, 'state', run);
  assert.equal(drv.next, 'implement', 'po obserwatorze sterownik startuje świeżego wykonawcę');
  assert.ok(started()['1']);
  assert.equal(dwmt(d, `drive-${run}-T1`, 'state', run).next, 'continue', 'przerwany wykonawca sterownika: kontynuacja jak dotąd');
});

test('item set: pola jako opcje (--anchors, --touch) i podpowiedź składni bez pól', () => {
  const d = repo();
  const P = (sid, ...a) => dwmt(d, sid, 'product', ...a);
  assert.equal(P('sess-1', 'init', '--goal', 'Cel').ok, true);
  const add = P('sess-1', 'item', 'add', '--type', 'debt', '--title', 'Rename helper');
  assert.equal(add.ok, true, JSON.stringify(add));
  const id = 'B-1';
  const r = P('sess-1', 'item', 'set', id, '--touch', 'src/**');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(readFileSync(join(d, 'docs', 'product', 'backlog.jsonl'), 'utf8'), /"anchors":\["src\/\*\*"\]/);
  assert.match(P('sess-1', 'item', 'set', id).error, /item set <B-n> <pole> <wartość>.*pola: title/);
  assert.match(P('sess-1', 'spec', 'set', '--help').error, /^spec new <id>/);
});

test('finish --cleanup z sesji spoza worktree przebiegu: pełna kopia katalogu przebiegu, usunięty worktree i gałąź', () => {
  const d = repo();
  const g = (...a) => spawnSync('git', a, { cwd: d, encoding: 'utf8' });
  writeFileSync(join(d, '.gitignore'), '.dwmt/\n');
  g('add', '.gitignore');
  g('commit', '-q', '-m', 'ignore');
  const wt = join(d, '..', `${d.split(/[\\/]/).pop()}-wt`);
  assert.equal(g('worktree', 'add', '-q', '-b', 'dwmt/r1', wt).status, 0);
  const root = join(wt, '.dwmt', 'runs', 'r1');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'drive.log'), 'log\n');
  const mainCopy = join(d, '.dwmt', 'runs', 'r1');
  mkdirSync(mainCopy, { recursive: true });
  const rj = { schema: 'dwmt/run@1', run: 'r1', rules: '2.10', mode: 'single', branch: 'dwmt/r1', target: 'master', mainTree: d.replace(/\\/g, '/'), task: 1, count: 1, tasks: [], session_ids: [], finish: { status: 'squashed', commit: 'abc' } };
  writeFileSync(join(root, 'run.json'), JSON.stringify(rj));
  writeFileSync(join(mainCopy, 'run.json'), JSON.stringify({ ...rj, archiveOf: wt }));
  const r = dwmt(d, 'sess-po', 'finish', 'r1', '--cleanup');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(existsSync(wt), false);
  assert.equal(readFileSync(join(mainCopy, 'drive.log'), 'utf8'), 'log\n');
  assert.equal(g('branch', '--list', 'dwmt/r1').stdout.trim(), '');
});
