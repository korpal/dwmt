// Atrapa `claude -p --agent` (DWMT_CLAUDE) do testów przeglądu 2026-10-09: wykonawca (także limit tur i naprawa przy
// finish), recenzent PASS, kontrola celu (opcjonalnie konflikt na celu). Transkrypt sesji z kosztem 1 mln (FAKE_TR).
import { writeFileSync, readFileSync, appendFileSync, mkdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const a = process.argv.slice(2);
// `node --test` uruchamia też pliki z test/: bez `-p` atrapa nic nie robi.
if (!a.includes('-p')) process.exit(0);
const val = (f) => (a.includes(f) ? a[a.indexOf(f) + 1] : null);
const prompt = val('-p') ?? '';
const agent = val('--agent') ?? (val('--resume') ? (/^Finish repair/.test(prompt) ? 'dwmt-executor-high' : 'dwmt-architect') : '?');
const log = process.env.FAKE_LOG;
const prev = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const sid = val('--session-id') ?? `fake-${prev.length + 1}`;
const k = Number(/tasks\/(\d+)\//.exec(prompt)?.[1] ?? 0);
appendFileSync(log, `${JSON.stringify({ agent, k, resume: val('--resume'), maxTurns: val('--max-turns'), prompt: prompt.slice(0, 700) })}\n`);
if (process.env.FAKE_TR) {
  mkdirSync(join(process.env.FAKE_TR, 'p'), { recursive: true });
  writeFileSync(join(process.env.FAKE_TR, 'p', `${sid}.jsonl`), `${JSON.stringify({ type: 'assistant', requestId: `r-${sid}`, timestamp: new Date().toISOString(), message: { usage: { input_tokens: 1e6 } } })}\n`);
}
const out = (o) => { console.log(JSON.stringify({ type: 'result', session_id: sid, total_cost_usd: 0.01, ...o })); };
const path = (label) => { const m = new RegExp(`${label}: ([^ ]+?)\\.( |$)`).exec(prompt); return m ? m[1] : null; };
const put = (f, text) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); };
const head = (o) => `---\n${Object.entries(o).map(([key, v]) => `${key}: ${JSON.stringify(v)}`).join('\n')}\n---\n`;
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

if (agent.startsWith('dwmt-executor') && /^Finish repair/.test(prompt)) {
  const res = /Result \(schema dwmt\/result@1\): ([^ ]+?)\.( |$)/.exec(prompt)[1];
  const files = /conflicts in: (.+?)\. The rebase/.exec(prompt)?.[1]?.split(', ') ?? null;
  // Recenzja poprawek: sterownik ginie w trakcie naprawy (rebase w toku); limit abonamentu w trakcie; wyjście testów poza git.
  if (process.env.FAKE_REPAIR_DIE) { process.kill(process.ppid, 'SIGKILL'); process.exit(1); }
  if (process.env.FAKE_STRAY) put('stray.out', 'test output\n');
  if (process.env.FAKE_REPAIR_LIMIT) {
    put('fixed.txt', 'half\n');
    writeFileSync(join(process.env.FAKE_TR, 'p', `${sid}.jsonl`), `${JSON.stringify({ type: 'assistant', requestId: `r-${sid}`, timestamp: new Date().toISOString(), error: 'rate_limit', quotaLimits: { resetsAt: Math.floor(Date.now() / 1000) + 3600 }, message: { usage: { input_tokens: 10 } } })}\n`);
    out({ is_error: true, result: 'Claude usage limit reached' });
    process.exit(1);
  }
  if (process.env.FAKE_REPAIR_BLOCKED) put(res, head({ schema: 'dwmt/result@1', status: 'BLOCKED', outOfScopeChanges: [] }));
  else if (files) {
    const target = 'export class Discount { constructor(percent) { this.percent = percent; } }\n';
    const merged = { 'src/billing/discount.ts': process.env.FAKE_RESOLVE_TARGET ? target : `${target}export const sprintDiscount = true;\n`, 'src/summary/view.ts': 'export const view = () => "-10% (both)";\n' };
    for (const f of files) put(f, merged[f] ?? `// resolved ${f}\n`);
    put(res, head({ schema: 'dwmt/result@1', status: 'DONE', outOfScopeChanges: files.map((f) => `${f}: kept both sides`) }));
  } else {
    put('fixed.txt', 'fixed\n');
    put(res, head({ schema: 'dwmt/result@1', status: 'DONE', outOfScopeChanges: ['fixed.txt: the marker the full suite check needs'] }));
  }
  out({ is_error: false, result: 'repaired' });
} else if (agent.startsWith('dwmt-executor')) {
  const mine = prev.filter((x) => x.agent.startsWith('dwmt-executor') && x.k === k).length;
  if (mine < Number(process.env.FAKE_MAXTURNS || 0)) {
    // Limit tur (sonda 2026-10-09): bez pliku wyniku, `subtype: error_max_turns`.
    out({ subtype: 'error_max_turns', is_error: true, terminal_reason: 'max_turns', result: '' });
    process.exit(1);
  }
  const code = { 1: ['src/billing/discount.ts', 'export class Discount {}\n'], 2: ['src/summary/view.ts', 'export const view = () => "-10%";\n'], 3: ['src/export/csv.ts', 'export const csv = () => "10";\n'] }[k];
  put(code[0], code[1]);
  put(path('Result'), head({ schema: 'dwmt/result@1', status: 'DONE' }));
  out({ is_error: false, result: 'done' });
} else if (agent === 'dwmt-reviewer') {
  const round = Number(/review-(\d+)\.md/.exec(path('Output'))?.[1] ?? 1);
  put(path('Output'), head({ schema: 'dwmt/review@1', round, passes: ['correctness'], verdict: 'PASS', fix: [], defer: [], drop: [], acceptance: [`AC-${k} met`], risks: ['R-1 proven'] }));
  out({ is_error: false, result: 'PASS' });
} else if (agent === 'dwmt-checker') {
  put(path('Output'), '---\nschema: dwmt/goal-check@1\nitems:\n  - {id: I-1, element: "discount", status: delivered, task: T-1, evidence: "T-1/report.md"}\ngaps: 0\n---\n');
  if (process.env.FAKE_CONFLICT) {
    // Cel dostaje ten sam nowy plik z inną treścią: rebase przy finish stanie na konflikcie add/add.
    const wt = join(mkdtempSync(join(tmpdir(), 'dwmt-cf-')), 'm');
    git('worktree', 'add', '-q', wt, 'master');
    put(join(wt, 'src/billing/discount.ts'), 'export class Discount { constructor(percent) { this.percent = percent; } }\n');
    // Drugi postój rebase: cel zmienia też plik, który zmienia T-2.
    if (process.env.FAKE_CONFLICT2) put(join(wt, 'src/summary/view.ts'), 'export const view = () => "target";\n');
    execFileSync('git', ['add', '-A'], { cwd: wt });
    execFileSync('git', ['commit', '-q', '-m', 'target: discount'], { cwd: wt });
    git('worktree', 'remove', '--force', wt);
    rmSync(dirname(wt), { recursive: true, force: true });
  }
  out({ is_error: false, result: 'checked' });
} else out({ is_error: false, result: 'ok' });
