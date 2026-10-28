// Fikstury v2.8 (v28*.test.mjs): sprint z trzema zadaniami (rabat w rozliczeniach, podsumowaniu i eksporcie), syntetyczne.
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseYaml, splitHeader } from '../scripts/dwmt.mjs';
import { SCRIPT, DWMT_HOME, repo, gitIn, header, runFile, fromTemplate, asRules } from './helpers.mjs';

export const NO_TRANSCRIPTS = mkdtempSync(join(tmpdir(), 'dwmt-tr28-'));
export function cliAs(d, sid, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: d, encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: sid, DWMT_HOME, DWMT_TRANSCRIPTS: NO_TRANSCRIPTS } });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* tekst */ }
  return { code: r.status, json, out: r.stdout + r.stderr };
}
export const hdr = (f) => parseYaml(splitHeader(readFileSync(f, 'utf8')).yaml);
export const RUN = (d, run) => JSON.parse(readFileSync(runFile(d, run, 'run.json'), 'utf8'));
export const fwd = (p) => String(p).replace(/\\/g, '/');
export const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- fikstury: sprint z trzema zadaniami ----------

export const FILES = {
  'src/billing/invoice.ts': 'export const invoice = (total) => total;\n',
  'src/billing/invoice.test.ts': '// test\n',
  'src/shared/money.ts': 'export class Money {}\n',
  'src/summary/view.ts': 'export const view = () => "";\n',
  'src/export/csv.ts': 'export const csv = () => "";\n',
};

export const PLAN = (run) => `${header({
  schema: 'dwmt/plan@1', run, goal: 'Discount on the invoice, in the summary and in the export',
  acceptance: ['AC-1 invoice applies the discount', 'AC-2 summary shows the discount', 'AC-3 export has the discount'],
  tasks: ['T-1', 'T-2', 'T-3'], scope: ['src/billing/**', 'src/summary/**', 'src/export/**'], shared: [], decisions: ['D-1'], questions: [],
})}# Discount

## Context
The invoice has no discount.

## Design
Billing owns the discount; the summary and the export read it without their own rules.

## Input coverage
- Discount on the invoice → AC-1
- Summary shows it → AC-2
- Export has it → AC-3

## Decisions
### D-1 Discount as a value
The 0–100 rule belongs to the value.

## Tasks
### T-1 Discount in billing
- Goal: the invoice applies the discount
- Acceptance: AC-1
- Scope: src/billing/**
- Depends: none

### T-2 Discount in the summary
- Goal: the summary shows the discount
- Acceptance: AC-2
- Scope: src/summary/**
- Depends: T-1

### T-3 Discount in the export
- Goal: the export has the discount
- Acceptance: AC-3
- Scope: src/export/**
- Depends: T-1

## UAT
1. Invoice → apply 10% → total drops by 10%.
`;

export const TASK = ({ run, k, goal, ac, scope, readFirst, changes, verify, decisions = ['D-1'], more = '', risks = ['R-1'], riskText = '' }) => `${header({
  schema: 'dwmt/brief@1', run, task: `T-${k}`, goal, mode: 'single', acceptance: [ac], scope, read_first: readFirst, verify, risks, decisions, questions: [],
})}# ${goal}

## Context
Billing in \`src/billing/invoice.ts#invoice\`.

## Changes
${changes.map((c) => `- ${c}`).join('\n')}

## Decisions
### D-1 Discount as a value
The 0–100 rule belongs to the value.
${more}
## Risks
### R-1 [high] The discount never exceeds the total
- Method: test 150 is rejected (${ac.split(' ')[0]})
- Area: billing
${riskText}`;
export const T1 = (run, o = {}) => TASK({
  run, k: 1, goal: 'The invoice applies the discount', ac: 'AC-1 invoice applies the discount', scope: ['src/billing/**'],
  readFirst: ['src/billing/invoice.ts#invoice', 'src/shared/money.ts#Money'], verify: ['node -e "1"', 'node -e 0'],
  changes: ['[new value object] `Discount` in `src/billing/discount.ts` — holds the percent; pattern: `src/shared/money.ts#Money`', '[change] `src/billing/invoice.ts#invoice` — subtracts the discount; test first: 100 with 10 → 90'],
  ...o,
});
export const T2 = (run, o = {}) => TASK({
  run, k: 2, goal: 'The summary shows the discount', ac: 'AC-2 summary shows the discount', scope: ['src/summary/**'],
  readFirst: ['src/billing/discount.ts#Discount', 'src/summary/view.ts#view'], verify: ['node -e "2"'],
  changes: ['[change] `src/summary/view.ts#view` — shows the discount; test first: 10 → "-10%"'],
  ...o,
});
export const T3 = (run, o = {}) => TASK({
  run, k: 3, goal: 'The export has the discount', ac: 'AC-3 export has the discount', scope: ['src/export/**'],
  readFirst: ['src/billing/invoice.ts#invoice', 'src/export/csv.ts#csv'], verify: ['node -e 0', 'node -e "3"'], decisions: ['D-1', 'D-2'],
  changes: ['[change] `src/export/csv.ts#csv` — adds the discount column; test first: 10 → "10"'],
  more: '\n### D-2 [visible] Rabat w eksporcie jako „-10%”\nThe mockup shows the summary that way; the export follows it.\n',
  ...o,
});

// kt (D-16): without cfg and extra the repo is a copy of one per-process build (`setup` writes only inside the repo).
export function repo28(cfg, extra) {
  const none = (o) => o === undefined || (o && typeof o === 'object' && !Object.keys(o).length);
  if (none(cfg) && none(extra)) { const d = fromTemplate('repo28', () => buildRepo28({}, {}).d); return { d, g: gitIn(d) }; }
  return buildRepo28(cfg ?? {}, extra ?? {});
}
function buildRepo28(cfg, extra) {
  const d = repo();
  const g = gitIn(d);
  for (const [f, text] of Object.entries({ ...FILES, ...extra })) { mkdirSync(join(d, f, '..'), { recursive: true }); writeFileSync(join(d, f), text); }
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude', 'dwmt.json'), JSON.stringify({ verify: { full: ['node -e 0'], targeted: ['node -e 0'] }, git: { target: 'master' }, run: { priceGate: false }, ...cfg }));
  assert.equal(cliAs(d, 'sess-1', 'setup').code, 0);
  g('add', '-A');
  g('commit', '-q', '-m', 'start');
  return { d, g };
}
// K4 (D-14): run.json `rules` przypięte do 2.10 (fikstury planów zadań mają kształt sprzed 2.11); ostatni argument
// `{ rules }` wybiera inną wartość (`{ rules: null }` zostawia to, co zapisał init).
export function start(d, slug, ...init) {
  const o = init.length && typeof init[init.length - 1] === 'object' ? init.pop() : {};
  const run = cliAs(d, 'sess-1', 'preflight', '--slug', slug).json.run;
  const i = cliAs(d, 'sess-1', 'init', '--run', run, '--mode', 'single', ...init).json;
  assert.equal(i.ok, true, JSON.stringify(i));
  const R = o.rules === undefined ? '2.10' : o.rules;
  if (R) asRules(d, run, R);
  if (!existsSync(runFile(d, run, 'task.md'))) writeFileSync(runFile(d, run, 'task.md'), 'Discount on the invoice; the summary and the export show it.\n');
  return run;
}
// `o`: zamienniki planów zadań `{ t1, t2, t3 }` (gotowy tekst) albo `plan`.
export function writePlans(d, run, o = {}) {
  writeFileSync(runFile(d, run, 'plan.md'), o.plan ?? PLAN(run));
  for (const [k, t] of [[1, T1], [2, T2], [3, T3]]) {
    mkdirSync(join(runFile(d, run, 'plan.md'), '..', 'tasks', String(k)), { recursive: true });
    writeFileSync(runFile(d, run, 'brief.md', k), o[`t${k}`] ?? t(run));
  }
}
export const batchFile = (d, run, name) => join(d, '.dwmt', 'runs', run, 'batch', name);
export const review = (k, obj, body = '') => `${header({ schema: 'dwmt/review@1', round: 1, passes: ['correctness', 'pragmatism'], verdict: 'PASS', fix: [], defer: [], drop: [], acceptance: [`AC-${k} met`], risks: ['R-1 proven'], ...obj })}${body}`;
export const finding = (id, sev, title, file) => `### ${id} [${sev}] ${title}\n- Evidence: \`${file}\`\n- Impact: wrong total shown\n- Test: 100 with 10 → 90\n\n`;
// Wykonawca, verify, review-input (kroki tej samej rundy).
export function execute(d, sid, run, k, round, files = {}, result = {}) {
  for (const [f, text] of Object.entries(files)) { mkdirSync(join(d, f, '..'), { recursive: true }); writeFileSync(join(d, f), text); }
  const res = k === 'batch' ? join(d, '.dwmt', 'runs', run, 'batch', `result-${round}.md`) : runFile(d, run, `result-${round}.md`, k);
  writeFileSync(res, header({ schema: 'dwmt/result@1', status: 'DONE', ...result }));
  const v = cliAs(d, sid, 'verify', run).json;
  assert.equal(v.ok, true, JSON.stringify(v));
  const ri = cliAs(d, sid, 'review-input', run).json;
  assert.equal(ri.ok, true, JSON.stringify(ri));
  return { v, ri };
}

