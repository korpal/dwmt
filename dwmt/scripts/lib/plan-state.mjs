// dwmt: stan planowania: brief, plan sprintu, plany zadań, pytania, prompty planowania.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ARCHITECT, is27, is28, is210, is212, topOfRoot, sprintPlanErrors, isTaskPlan, taskPlanErrors, headFiles, makeBase } from '../plan.mjs';
import { ROOT, fwd, read, asList } from './util.mjs';
import { tryHeader } from './headers.mjs';
import { briefErrors, answeredIds, acIds, parseTasks, uatScenario, planErrors, parseRisks, uatRefErrors } from './risks.mjs';
import { taskDir, taskCtx } from './run.mjs';
import { shellName } from './verify.mjs';
import { validFiles } from './price-gate.mjs';

// ---------- stan (D-4) ----------

export function tryBrief(file, cfg) {
  const h = tryHeader(file);
  if (!h || h.errors) return h;
  const errors = briefErrors(read(file), h, cfg);
  return errors.length ? { ...h, errors } : h;
}

// Faza planowania (D1): planista pisze brief z pytaniami, orkiestrator pyta i dopisuje odpowiedzi do answers.md.
export function planState(dir, run, cfg, brief, base) {
  const p = (n) => fwd(join(dir, n));
  const has = (n) => existsSync(join(dir, n));
  const inline = (brief?.mode ?? run.mode) === 'inline';
  const planner = !inline && has('task.md');
  const plan = (what, hint) => ({
    ...base, next: 'plan', hint, ...(planner ? {
      agent: ARCHITECT, output: p('brief.md'),
      prompt: v26(`${what} Task: ${p('task.md')}. Brief: ${p('brief.md')}. Template: ${fwd(join(ROOT, 'templates', 'artifacts', 'brief.md'))}. Language: ${cfg.language}. Mode: single. Verify shell: ${shellName(cfg)}.${cfg.ui ? ' UI check: on.' : ''}`),
    } : {}),
  });
  if (!brief) {
    if (planner) return plan('Plan the run: explore, then write the brief.', 'architekt pisze brief (przebieg v2.6)');
    return plan(null, inline ? 'inline: zaplanuj sam i zapisz brief.md według szablonu' : 'brak task.md i brief.md: zapisz zadanie do task.md albo import-plan');
  }
  if (brief.errors) return plan(`Fix the brief: ${brief.errors.join('; ')}.`, `brief.md niepoprawny: ${brief.errors.join('; ')}`);
  const questions = asList(brief.questions);
  if (!questions.length) return null;
  const answered = has('answers.md') ? answeredIds(read(join(dir, 'answers.md'))) : [];
  const open = questions.filter((q) => !answered.includes(q));
  if (open.length) return { ...base, next: 'ask-plan', questions: open, file: p('brief.md'), answers: p('answers.md'), hint: 'section <brief> Q-n → AskUserQuestion → dopisz `### Q-n` z odpowiedzią do answers.md' };
  return plan(
    `Answers: ${p('answers.md')}. Record each as D-n, remove the answered ids from \`questions\` and finish the brief.`,
    planner ? 'odeślij prompt temu samemu architektowi (SendMessage), a bez jego identyfikatora uruchom nowego' : 'inline: wpisz odpowiedzi do briefu jako D-n i usuń questions',
  );
}

// Dodatkowe reguły briefu zadania (v2.6): AC przypisane zadaniu w planie; sprint bez planu ma scenariusz UAT w briefie.
export function taskBriefErrors(root, run, ctx, text, h, cfg) {
  const errors = briefErrors(text, h, cfg, { strictVerify: !ctx.legacy && is210(run) });
  if (ctx.legacy || asList(h.questions).length) return errors;
  const plan = planInfo(root);
  if (plan) {
    const have = asList(h.acceptance).flatMap(acIds);
    for (const ac of plan.tasks.find((x) => x.k === ctx.k)?.ac ?? []) if (!have.includes(ac)) errors.push(`brief T-${ctx.k}: brak ${ac}, które plan przypisuje temu zadaniu (część kryterium dzielonego też)`);
  } else {
    if (uatScenario(text) === null) errors.push('brak sekcji ## UAT (scenariusz UAT albo „UAT: none”)');
    // K5 D-4 (2.12): without a sprint plan the task plan's own UAT steps name its human or ui risks or [human] criteria.
    else if (is212(run)) errors.push(...uatRefErrors(uatScenario(text), { risks: { [ctx.k]: parseRisks(text) }, criteria: asList(h.acceptance), single: ctx.k }));
    // v2.7 bez planu sprintu (import, inline): plan zadania z read_first i ## Changes dostaje też reguły planu zadania
    // (kotwice wobec HEAD i scope), dopóki planowanie nie jest gotowe; potem HEAD zmienia sam wykonawca (zamrożenie, §5.9).
    if (is27(run) && !run.plansReady && isTaskPlan(text, h)) errors.push(...taskPlanErrors({ text, h, k: ctx.k, base: makeBase(headFiles(topOfRoot(root))), v210: is210(run) }).errors);
  }
  return errors;
}

export function tryTaskBrief(root, run, ctx, cfg) {
  const file = join(ctx.dir, 'brief.md');
  const h = tryHeader(file);
  if (!h || h.errors) return h;
  const errors = taskBriefErrors(root, run, ctx, read(file), h, cfg);
  return errors.length ? { ...h, errors } : h;
}

// Plan sprintu z błędami walidacji: w przebiegu v2.7 profil architekta (Depends, Design, Input coverage), inaczej v2.6.
export function planInfo(root, run = null) {
  const file = join(root, 'plan.md');
  if (!existsSync(file)) return null;
  const text = read(file);
  const h = tryHeader(file);
  // D4 (§6.4 pkt 2, 7; recenzja N-4): brak `files` przy bramce ceny to ostrzeżenie bramki (`priceGateStep`), nie błąd planu.
  const errors = h.errors ?? (is27(run) ? sprintPlanErrors(text, h) : planErrors(text, h));
  const tasks = parseTasks(text);
  // D (noc 2026-10-05): tryb pośredni = jedno zadanie na sprint, więc jedna recenzja całości (podział na obszary przy dużym diffie).
  // Przegląd 2026-10-09 (W-4): phase-5 jako jedno zadanie przy szacunku 80–130 plików (wykonawca 350 wywołań). Szacunek
  // architekta (`files`) ponad próg trybu pośredniego pozwala podzielić sprint; przebieg staje się `single` (cmdState).
  if (!h.errors && isIntermediate(run) && !run.plansReady && (asList(h.tasks).length > 1 || tasks.length > 1) && !overIntermediate(run, h)) {
    errors.push(`mode intermediate: the sprint is exactly one task (T-1), so one review covers it; merge the tasks (the executor works in segments), or, when your files estimate exceeds ${intermediateLimit(run)}, keep the tasks with files: [min, max] in the header (the run becomes single)`);
  }
  return { file, text, h, tasks, errors };
}

// Pytania z planu albo briefu: otwarte → ask-plan; odpowiedziane, a jeszcze w nagłówku → ten sam architekt zapisuje je jako D-n.
// `rel`: ścieżka pliku odpowiedzi w prompcie (v2.8: względem katalogu głównego repo, nazwanego dalej w tym samym prompcie).
export function questionState(base, file, h, answers, record, rel = fwd) {
  const questions = asList(h.questions);
  if (!questions.length) return null;
  const answered = existsSync(answers) ? answeredIds(read(answers)) : [];
  const open = questions.filter((q) => !answered.includes(q));
  if (open.length) return { ...base, next: 'ask-plan', questions: open, file: fwd(file), answers: fwd(answers), hint: 'section <file> Q-n → AskUserQuestion → dopisz `### Q-n` z odpowiedzią do pliku answers' };
  return record(`Answers: ${rel(answers)}. Record each as D-n, remove the answered ids from \`questions\``);
}

const isIntermediate = (run) => run?.modeLabel === 'intermediate';
export const intermediateLimit = (run) => Number(run?.intermediateMaxFiles) || 60;
// W-4: górna granica szacunku plików architekta ponad progiem trybu pośredniego.
export const overIntermediate = (run, h) => { const f = validFiles(h?.files); return !!f && f[1] > intermediateLimit(run); };

export const TPL = (n) => fwd(join(ROOT, 'templates', 'artifacts', n));
// v2.8 (D): `language` to już tylko język użytkownika; artefakty i odpowiedzi eksploratorów po angielsku.
export const planEnv = (cfg, run = null) => `${is28(run)
  ? `Artifacts and explorer answers: English; the user's language (questions Q-n, ## UAT steps, [visible] decision titles): ${cfg.language}.`
  : `Language: ${cfg.language}.`} Verify shell: ${shellName(cfg)}.${cfg.ui ? ' UI check: on.' : ''}`;
const SEND = 'odeślij prompt temu samemu architektowi (SendMessage do agenta z tym `key`), a bez jego identyfikatora uruchom nowego';
// Przebieg v2.6 (bez `rules`, §5.9 „Przejście z v2.6”): prompty dawnych planistów idą do architekta, który pisze tylko to, co nazywają.
export const v26 = (prompt) => `v2.6 run: write only what this prompt names. ${prompt}`;

// Kontekst sprintu dla architekta: zlecenie supervisora (Affects, shared), drugi z dwóch sprintów, sprint poprawek.
// `order`: kolejność zlecenia, którą przebieg widzi teraz (v2.7: `runDepsNow`); v2.6 zostaje przy kopii z run.json (D-15).
export function sprintExtras(run, cfg, order = asList(run.order)) {
  const s = [];
  const hot = asList(cfg.supervisor?.hotFiles);
  if (asList(order).length) s.push(` Sprints of the order: ${asList(order).join(', ')}: give each question an \`Affects\` line (sprints it may concern, none or uncertain) and list files shared with other sprints in the header \`shared\`${hot.length ? ` (hot files: ${hot.join(', ')})` : ''}.`);
  if (run.first) s.push(` First plan: ${fwd(run.first)}: this sprint is the second of two; start the exploration from that plan.`);
  if (run.source) s.push(' Fix sprint: task.md lists UAT defects U-n; each is a risk with Method: test whose title names its U-n and whose test reproduces the defect (red before the fix); the UAT scenario re-checks each defect.');
  return s.join('');
}

// Planista sprintu (§5.9): plan.md i brief zadania 1 w jednym agencie; sprint z jednym zadaniem ma tylko brief.
export function sprintPlanState(root, run, cfg, base) {
  const p = (n) => fwd(join(root, n));
  const briefFile = join(taskDir(root, 1), 'brief.md');
  const plan = planInfo(root);
  const brief = tryTaskBrief(root, run, taskCtx(root, run, 1), cfg);
  const inline = (brief?.mode ?? run.mode) === 'inline';
  const planner = !inline && existsSync(join(root, 'task.md'));
  const mk = (what, hint) => ({
    ...base, next: 'plan', hint, ...(planner ? {
      agent: ARCHITECT, key: 'planner', output: plan && !plan.errors.length ? fwd(briefFile) : p('plan.md'),
      prompt: v26(`${what} Task: ${p('task.md')}. Plan: ${p('plan.md')}. Brief of task 1: ${fwd(briefFile)}. Templates: ${TPL('plan.md')}, ${TPL('brief.md')}. Mode: single. ${planEnv(cfg)}${sprintExtras(run, cfg)}`),
    } : {}),
  });
  const record = (what) => (rec) => mk(`${rec} and ${what}.`, planner ? SEND : 'inline: wpisz odpowiedzi do briefu jako D-n i usuń questions');
  if (!plan && !brief) {
    if (planner) return mk("Plan the sprint: explore breadth-first, ask all the sprint's questions at once before planning in depth, then write the plan and the brief of task 1 (a sprint of one task has only the brief).", 'architekt w roli planisty sprintu v2.6: rozpoznanie wszerz, pytania, plan i brief zadania 1');
    return mk(null, inline ? 'inline: zaplanuj sam i zapisz brief zadania 1 według szablonu (z sekcją ## UAT)' : 'brak task.md i briefu: zapisz zadanie do task.md albo import-plan');
  }
  if (plan) {
    if (plan.errors.length) return mk(`Fix the plan: ${plan.errors.join('; ')}.`, `plan.md niepoprawny: ${plan.errors.join('; ')}`);
    const q = questionState(base, plan.file, plan.h, join(root, 'answers.md'), record('finish the plan, then write the brief of task 1'));
    if (q) return q;
    if (!brief) return mk('The plan is complete: write the brief of task 1.', 'plan gotowy: architekt pisze brief zadania 1');
  }
  if (brief.errors) return mk(`Fix the brief of task 1: ${brief.errors.join('; ')}.`, `brief zadania 1 niepoprawny: ${brief.errors.join('; ')}`);
  return questionState(base, briefFile, brief, join(root, 'answers.md'), record('finish the brief of task 1'));
}

// Planista zadania k > 1 (§5.9): świeży agent, plan i raporty poprzednich zadań, aktualny kod zakresu.
export function taskPlanState(root, run, cfg, base, ctx) {
  const briefFile = join(ctx.dir, 'brief.md');
  const answers = join(ctx.dir, 'answers.md');
  const brief = tryTaskBrief(root, run, ctx, cfg);
  const reports = run.tasks.filter((x) => x.k < ctx.k).map((x) => fwd(join(taskDir(root, x.k), 'report.md')));
  const mk = (what, hint) => ({
    ...base, next: 'plan', hint, agent: ARCHITECT, key: `planner-T${ctx.k}`, output: fwd(briefFile),
    prompt: v26(`${what} Plan: ${fwd(join(root, 'plan.md'))}. Sprint answers: ${fwd(join(root, 'answers.md'))}. Reports: ${reports.join(', ')}. Brief: ${fwd(briefFile)}. Template: ${TPL('brief.md')}. Mode: single. ${planEnv(cfg)}`),
  });
  if (!brief) return mk(`Plan task ${ctx.k} (T-${ctx.k}): read the plan, answers and earlier task reports, then the current code of its scope, not the docs; ask only about irreversible matters the plan leaves open.`, `architekt pisze brief T-${ctx.k} (świeży agent, w miejsce planisty zadania v2.6)`);
  if (brief.errors) return mk(`Fix the brief of task ${ctx.k}: ${brief.errors.join('; ')}.`, `brief T-${ctx.k} niepoprawny: ${brief.errors.join('; ')}`);
  return questionState(base, briefFile, brief, answers, (rec) => mk(`${rec} and finish the brief of task ${ctx.k}.`, SEND));
}
