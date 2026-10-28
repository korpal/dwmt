#!/usr/bin/env node
// dwmt v2.9 (specyfikacja-dwmt.md §5.9): PostToolUse po Write/Edit planu sprintu albo planu zadania przebiegu.
// Walidacja zaraz po zapisie, z autopoprawkami w pamięci (C-n i D-n z planu sprintu, jednoznaczne skróty ścieżek: zapisze je
// `state`), więc architekt poprawia błąd przy pierwszym planie zadania, a nie po napisaniu wszystkich (sprinty 6+7: 45 błędów
// formatu poprawianych na końcu przy kontekście 600–730k za 1,78 mln). Błędy wracają przez exit 2 (stderr widzi agent).
// Każdy inny plik i każdy błąd samego hooka: wyjście 0 bez komunikatu.
import { readFileSync } from 'node:fs';

let input = null;
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
const file = String(input?.tool_input?.file_path ?? '').replace(/\\/g, '/');
const m = /^(.*)\/\.dwmt\/runs\/([\w.-]+)\/(plan\.md|tasks\/(\d+)\/brief\.md)$/.exec(file);
if (!m) process.exit(0);

const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
let errors = [];
try {
  const { loadRun, loadConfig, planInfo, runDir } = await import('../scripts/dwmt.mjs');
  const { validateTaskPlans, is29 } = await import('../scripts/plan.mjs');
  const top = m[1];
  const run = loadRun(top, m[2]);
  if (!is29(run)) process.exit(0);
  const root = runDir(top, m[2]);
  const plan = planInfo(root, run);
  if (!plan) process.exit(0);
  const t = asList(run.tasks).find((x) => x.k === run.task);
  const from = run.plansReady ? (t?.replan?.from ?? run.task ?? 1) : 1;
  const open = plan.h.errors || asList(plan.h.questions).length;
  const validate = () => validateTaskPlans({ top, root, plan, from, cfg: loadConfig(top), fix: 'memory', run });
  // K5 D-4: UAT reference errors exist once every task plan is written (like the overlap check). They belong to plan.md,
  // so both the write that completes the task plans and a later fix of plan.md show them.
  const uat = (e) => e.startsWith('plan.md: UAT step');
  if (m[3] === 'plan.md') {
    errors = plan.errors.map((e) => `plan.md: ${e}`);
    if (!errors.length && !open) errors = validate().errors.filter(uat);
  } else if (!open) {
    const k = Number(m[4]);
    if (k >= from) errors = validate().errors.filter((e) => e.startsWith(`T-${k}:`) || new RegExp(`\\bT-${k} i T-\\d+|\\bT-\\d+ i T-${k}\\b`).test(e) || uat(e));
  }
} catch { process.exit(0); }

if (errors.length) {
  process.stderr.write(`dwmt plan check after this write (${m[3]}): fix these in this file now; the same pattern in the next plans would repeat them.\n${errors.slice(0, 40).map((e) => `- ${e}`).join('\n')}\n`);
  process.exit(2);
}
process.exit(0);
