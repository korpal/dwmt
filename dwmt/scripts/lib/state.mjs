// dwmt: maszyna stanów przebiegu (`state`), rundy, runda zbiorcza, `replan-done`, `extend`, `unblock`.
import { writeFileSync, existsSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ARCHITECT, is27, is29, is210, infoNotesFor, autofixPlans, pathsFor, artifactsLang, topOfRoot, architectPlanState, taskGate, replanState,
  planIssueCause, handledIds, currentCauses, recordReplan, validateFrom, goalCheckState, copyExplore,
} from '../plan.mjs';
import {
  batchPending, batchCtx, splitReviews, ensureBatch, writeBatchFile, findingSection, resolveIds, itemMax, closedIds, remainingItems, planIssueOnly,
  batchOn, syncBatchItems,
} from '../batch.mjs';
import { fwd, read, asList } from './util.mjs';
import { withHeader, tryHeader, section } from './headers.mjs';
import { globToRegExp } from './text.mjs';
import { idOf, maxFinding, mergeReviews } from './risks.mjs';
import { gitRaw, git, dirty } from './git.mjs';
import { loadConfig } from './config.mjs';
import { runDir, taskDir, sessionId, driverCall, loadRun, saveRun, isLegacy, taskCtx, sprintCount, writeStatus, runEvent, foreignTree, runHome } from './run.mjs';
import { unmergedDeps, firstTaskStarted, runDepsNow } from './deps.mjs';
import { pendingDeletes, deleteLabel, removeFiles } from './deletes.mjs';
import { tryBrief, planState, tryTaskBrief, planInfo, TPL, planEnv, v26, sprintPlanState, taskPlanState, overIntermediate, intermediateLimit } from './plan-state.mjs';
import { agentLimit, stopEarlierSessions } from './sessions.mjs';
import { shellName } from './verify.mjs';
import { diffRun, nextAssumption, archivePartial, snapshotTree, oneSource, executorBlock } from './review.mjs';
import { closingDecision } from './verify-select.mjs';
import { directPrompt, ensureDirectBrief } from './direct.mjs';
import { knownRed, knownRedPrompt } from './known-red.mjs';
import { reviewTexts, sprintCoverage } from './report.mjs';
import { archive } from './finish.mjs';
import { PRICE_Q, priceGateStep, priceNote } from './price-gate.mjs';
import { ensureLive } from './live.mjs';
import { recordScriptFindings, checksReturned } from './script-checks.mjs';

// K4 (D-23): zdanie promptu naprawy, gdy verify rundy odesłało trafienia kontroli skryptu.
const CHECKS_SENTENCE = ' Script checks: read `## Script checks` in tests.md; revert each change it lists, or for a file outside the scope declare it in `outOfScopeChanges` with the reason; never weaken or skip tests.';

export function unblock(dir, round) {
  const f = join(dir, `result-${round}.md`);
  const h = tryHeader(f);
  if (h?.status !== 'BLOCKED' && !(h?.status === 'PARTIAL' && asksUser(h))) return false;
  let n = 1;
  while (existsSync(join(dir, `result-${round}.blocked-${n}.md`))) n++;
  renameSync(f, join(dir, `result-${round}.blocked-${n}.md`));
  return true;
}

// Przegląd 2026-10-05 (poprawki-recenzji-e2e): PARTIAL z pytaniami do użytkownika to pytanie, nie kontynuacja (dwie
// sesje `continue` bez odpowiedzi, zanim wykonawca sam skończył BLOCKED).
const asksUser = (h) => asList(h?.questions).length > 0;
// Przegląd 2026-10-05 (sprint 5 T-2): nagłówek wyniku, który się nie parsuje, wraca do agenta z błędem w prompcie (wcześniej
// był tylko w `hint`, więc sześć kolejnych sesji naprawy dostało to samo polecenie). `invalid` widzi sterownik: ten sam
// błąd po kolejnym agencie to brak postępu.
const headerFix = (file, h) => (h?.errors ? ` The header of ${file} does not parse (${h.errors.join('; ')}): rewrite it as valid YAML (inside double quotes a backslash starts an escape, so quote text with backslashes in single quotes); if the work is already done, change only the header.` : '');
const invalidOf = (file, h) => (h?.errors ? { invalid: { file, errors: h.errors } } : {});

const mtimeMs = (f) => (existsSync(f) ? statSync(f).mtimeMs : 0);

export function computeState(root, run, cfg) {
  const st = computeState0(root, run, cfg);
  // v2.10 (B): pliki z `delete` planów, o które jeszcze nie pytano. W turze pytań (`ask-plan`) zgoda idzie w tym samym
  // AskUserQuestion (`delete`); osobne jedno pytanie (`ask-delete`) tylko dla plików dopisanych później (plany zadań, replan).
  if (!['ask-plan', 'implement', 'continue', 'fix'].includes(st.next) || st.batch || isLegacy(run) || !is210(run)) return st;
  const pending = pendingDeletes(root, run);
  if (!pending.length) return st;
  // Decyzja użytkownika 2026-10-21: bez pytań o usunięcie (`deletes.ask: false`, domyślnie). Skrypt usuwa tylko pliki
  // śledzone przez git (`deletePathError`), więc da się je odzyskać; raport i `t.deleted` je wymieniają.
  if (cfg?.deletes?.ask === false) {
    const d = run.deletions ?? { asked: [], approved: [], declined: [] };
    const files = pending.map((x) => x.file);
    run.deletions = { ...d, asked: [...new Set([...asList(d.asked), ...files])], approved: [...new Set([...asList(d.approved), ...files])], auto: true, at: new Date().toISOString() };
    return { ...st, autoDeleteConsent: pending.map(deleteLabel) };
  }
  if (st.next === 'ask-plan') return { ...st, delete: pending.map(deleteLabel), hint: `${st.hint}; w tym samym AskUserQuestion pytanie o usunięcie plików z delete, potem delete-consent --yes|--no` };
  return {
    ...st, next: 'ask-delete', agent: null, prompt: null, output: null, files: pending.map(deleteLabel),
    hint: 'jedno pytanie: usunąć te pliki (skrypt usuwa je na starcie ich zadania) czy zostawić (kryterium niespełnione); potem delete-consent --yes|--no',
  };
}

function computeState0(root, run, cfg) {
  // D4 (§6.4 pkt 5): przebieg zatrzymany na pytaniu o cenę zostaje zatrzymany (gałąź dla użytkownika).
  if (run.stopped && !isLegacy(run)) {
    return { run: run.run, mode: run.mode, round: 1, agent: null, prompt: null, output: null, task: run.task, next: 'stopped', reason: run.stopped.reason, hint: `przebieg zatrzymany (${run.stopped.reason}); gałąź ${run.branch} zostaje` };
  }
  if (isLegacy(run)) {
    const brief = tryBrief(join(root, 'brief.md'), cfg);
    const base = { run: run.run, mode: brief?.mode ?? run.mode, round: 1, agent: null, prompt: null, output: null };
    return planState(root, run, cfg, brief, base) ?? roundState(run, cfg, taskCtx(root, run), base, brief);
  }
  // E: plan zadania trybu direct z task.md, gdy wejście tekstowe dostało task.md dopiero po `init`.
  if (run.mode === 'direct') ensureDirectBrief(root, run);
  const ctx = taskCtx(root, run);
  const base = { run: run.run, mode: run.mode, round: 1, agent: null, prompt: null, output: null, task: ctx.k, tasks: ctx.n, dir: fwd(ctx.dir), ...(run.sprint ? { sprint: run.sprint } : {}) };
  if (is27(run)) return state27(root, run, cfg, base, ctx);
  if (ctx.k === 1) {
    const planning = sprintPlanState(root, run, cfg, base);
    if (planning) return planning;
    // §5.10: plan gotowy, a sprinty z `after` jeszcze nie scalone; orkiestrator kończy, pętla wznowi.
    if (asList(run.after).length && !run.afterDone) {
      const waiting = unmergedDeps(runHome(run, topOfRoot(root)), run.after);
      if (waiting.length) return { ...base, next: 'planned', waitingFor: waiting, hint: `plan gotowy; implementacja czeka na scalenie: ${waiting.join(', ')}` };
    }
    const briefFile = join(ctx.dir, 'brief.md');
    if (run.refresh && !(mtimeMs(briefFile) > Date.parse(run.refresh.at))) {
      return {
        ...base, next: 'plan', agent: ARCHITECT, key: 'planner-T1', output: fwd(briefFile), hint: 'cel zmienił pliki z zakresu zadania 1 od planowania: odświeżenie briefu',
        prompt: v26(`Refresh the brief of task 1: since planning, the target branch changed files in its scope: ${run.refresh.files.slice(0, 20).join(', ')}${run.refresh.files.length > 20 ? ' …' : ''}. Read their current code and update the brief (entry map, excerpts, verify, risks); keep the plan's criteria and decisions. Plan: ${fwd(join(root, 'plan.md'))}. Brief: ${fwd(briefFile)}. Template: ${TPL('brief.md')}. ${planEnv(cfg)}`),
      };
    }
  }
  // §5.10: po commicie zadania k < N ta sama sesja kończy; każda inna prowadzi zadanie k+1.
  if (run.handoff?.session && run.handoff.session === sessionId()) {
    return { ...base, task: run.handoff.task, next: 'handoff', commit: run.handoff.commit ?? null, hint: `T-${run.handoff.task} zacommitowane; zadanie T-${ctx.k} w nowej sesji` };
  }
  if (ctx.k > 1) {
    const tp = taskPlanState(root, run, cfg, base, ctx);
    if (tp) return tp;
  }
  const brief = tryTaskBrief(root, run, ctx, cfg);
  return roundState(run, cfg, ctx, { ...base, mode: brief.mode ?? run.mode }, brief);
}

// v2.7 (§5.2, §5.9, §5.10): architekt pisze plany wszystkich zadań, dopóki planowanie nie jest gotowe (`plansReady`);
// potem plany sprawdza tylko `replan`, a przed wykonawcą zadania k skrypt szuka rozjazdu. Planisty zadania nie ma.
function state27(root, run, cfg, base, ctx) {
  const top = topOfRoot(root);
  // kf2 (D-6, D-9): przed pierwszym zadaniem zależności z bieżącego zlecenia (pozycja `run.sprint`), potem żadnych.
  const home = runHome(run, top);
  const deps = ctx.k === 1 && !firstTaskStarted(run) ? runDepsNow(home, run).after : [];
  const waiting = deps.length ? unmergedDeps(home, deps) : [];
  // D-14: nowa niescalona zależność po wyjściu z `planned`, a przed pierwszym zadaniem (także gdy świeży architekt pisze
  // plany zadań): znów `planned`; `again` każe cmdState skasować `afterDone`, więc kolejne wyjście dogoni cel jeszcze raz.
  if (run.afterDone && waiting.length) {
    return { ...base, next: 'planned', waitingFor: waiting, again: true, hint: `plan gotowy; implementacja znów czeka na scalenie: ${waiting.join(', ')}` };
  }
  // Bez planu sprintu (import, inline) plan zadania 1 sprawdzamy zawsze, jak w v2.6 (po zamrożeniu bez kotwic).
  if (!run.plansReady || !existsSync(join(root, 'plan.md'))) {
    const planning = architectPlanState({ top, root, run, cfg, base });
    if (planning) return planning;
  }
  // §5.10: plan sprintu gotowy, sprinty z `after` jeszcze nie scalone; bez oczekujących `leave` każe wyjść z `planned`.
  if (deps.length && !run.afterDone) {
    return { ...base, next: 'planned', waitingFor: waiting, ...(waiting.length ? { hint: `plan gotowy; implementacja czeka na scalenie: ${waiting.join(', ')}` } : { leave: true }) };
  }
  if (run.handoff?.session && run.handoff.session === sessionId()) {
    return { ...base, task: run.handoff.task, next: 'handoff', commit: run.handoff.commit ?? null, hint: `T-${run.handoff.task} zacommitowane; zadanie T-${ctx.k} w nowej sesji` };
  }
  const gate = taskGate({ top, root, run, cfg, base, ctx });
  if (gate) return gate;
  const brief = tryTaskBrief(root, run, ctx, cfg);
  // Trybu nie wyprowadzamy z nagłówka, który się nie wczytał (bez `mode` runda szłaby jak inline).
  if (!brief || (brief.errors && !brief.mode)) return { ...base, next: 'plan', hint: `plan T-${ctx.k} niepoprawny: ${asList(brief?.errors).join('; ') || 'brak pliku'}` };
  return roundState(run, cfg, ctx, { ...base, mode: brief.mode ?? run.mode }, brief);
}

// Koniec sprintu: jeden finish po ostatnim zadaniu (merge-wait wraca tu, aż squash wejdzie); w v2.7 przed nim kontrola celu.
function sprintEnd(run, st, cfg, ctx) {
  const f = run.finish;
  if (['squashed', 'left'].includes(f?.status)) return { ...st, next: 'done', hint: `zakończono: ${f.status}` };
  if (is27(run) && !ctx.legacy) {
    // v2.8 (§5.9 „Koniec sprintu”): runda zbiorcza przed kontrolą celu.
    // Przegląd a6: przed jej startem pozycje jeszcze raz, bo znana czerwień ostatniego zadania (po jego commicie) i w
    // pliku testu zmienianym przez sprint też jest pozycją (`known-red`), nawet gdy recenzje nie dały żadnej innej.
    if (!run.batch?.baseline && batchOn(ctx.root, run, cfg)) syncBatchItems(topOfRoot(ctx.root), ctx.root, run, cfg);
    if (batchPending(ctx.root, run, cfg)) {
      const b = batchState(run, cfg, ctx.root, st);
      if (b) return b;
    }
    const gc = goalCheckState({ root: ctx.root, run, cfg, st, finalAc: () => { const c = sprintCoverage(ctx.root, run); return c.acPrompt ?? c.acceptance; } });
    if (gc) return gc;
  }
  const hint = !f ? 'rebase, pełna suita, squash'
    : f.status === 'merge-wait' ? `merge-wait (${f.reason}) od ${f.since}: ponów finish, gdy przyczyna ustąpi (squash bez pełnej suity, jeśli cel się nie zmienił)`
      : f.status === 'deferred-major' && f.hint ? f.hint
        : `poprzedni finish: ${f.status}`;
  return { ...st, next: 'finish', hint };
}

// v2.8 (§5.6): recenzja z podziałem ma `now` (poprawki teraz); puste `now` kończy rundy zadania jak PASS.
export const reviewPassed = (h) => h?.verdict === 'PASS' || (Array.isArray(h?.now) && !h.now.length);
export const fixNow = (h) => (Array.isArray(h?.now) ? h.now : asList(h?.fix));

// Bieżąca runda zadania z plików recenzji (jak w roundState), bez przeliczania stanu.
function roundOf(dir) {
  let R = 0;
  while (existsSync(join(dir, `review-${R + 1}.md`))) R++;
  if (!R) return 1;
  const last = tryHeader(join(dir, `review-${R}.md`));
  return !last || last.errors || reviewPassed(last) ? R : R + 1;
}

// kt (D-13): before the commit, the whole verify list once more when the tree changed since its last whole run.
// `repairFile`: prefix of the round's repair result (`repair-`), `repairStep`: the round's repair step builder.
function closingGate(t, round, dir, top, st, repairStep, repairFile) {
  if (!t.whole) return null;
  const rep = tryHeader(join(dir, `${repairFile}${round}.md`));
  const decision = closingDecision({
    record: t.whole, cur: snapshotTree(top), accepted: !!t.accepted, repairPending: !rep || !!rep.errors, closingRuns: t.closingRuns?.[round] ?? 0,
  });
  if (decision === 'commit') return null;
  if (decision === 'verify') {
    return { ...st, next: 'verify', closing: true, hint: 'zamykające verify całej listy przed commitem (drzewo zmieniło się od ostatniego pełnego verify): verify, potem state, bez review-input' };
  }
  // Batch F-1: the verify after this repair is closing too (whole list, no carry). Inline mode writes no repair file, so
  // only that verify, which books no second repair, ends the repair: green → commit, red → ask-rounds, never a loop.
  if (decision === 'repair') {
    const s = repairStep();
    return { ...s, closing: true, hint: `${s.hint} (zamykające verify: po naprawie znowu cała lista)` };
  }
  const many = (t.closingRuns?.[round] ?? 0) >= 3;
  return {
    ...st, round, next: 'ask-rounds', closingRed: true,
    hint: many ? 'zamykające verify: drzewo zmienia się przy każdym verify (3 próby): commit --accept (commit bez kolejnego pełnego verify) | stop'
      : 'zamykające verify całej listy nadal czerwone po naprawie rundy: commit --accept (akceptacja z czerwienią) | stop',
  };
}

// Maszyna rundy zadania (§5.3–§5.6) na katalogu i stanie zadania; legacy: katalog i stan przebiegu.
function roundState(run, cfg, ctx, base, brief) {
  const { dir, t } = ctx;
  // Pole `output` (dla orkiestratora) zostaje pełną ścieżką; prompt agenta v2.8 ma ścieżki względne i katalog główny raz (E).
  const p = (n) => fwd(join(dir, n));
  const { rel, root: repo0 } = pathsFor(run, topOfRoot(ctx.root));
  // v2.8 (D): język artefaktów nazwany w prompcie (szablony agentów idą za promptem; przebieg 2.7 bez tej linii).
  const repo = `${repo0}${artifactsLang(run)}`;
  const q = (n) => rel(join(dir, n));
  const has = (n) => existsSync(join(dir, n));
  // K4 (D-20): na końcu promptu wykonawcy zadania tekst decyzji i kontraktów sprintu, które nazywa jego plan (przebieg 2.11 z planem sprintu).
  const sprintBlock = () => (!ctx.legacy && oneSource(run, ctx.root) && has('brief.md') ? executorBlock(ctx.root, ctx.k, read(join(dir, 'brief.md'))) : '');
  // E (noc 2026-10-05): direct = rundy jak single, ale wykonawca `high` od rundy 1 i bez architekta (eskalacja zamiast replanu).
  const direct = brief.mode === 'direct';
  const single = brief.mode === 'single' || direct;
  let R = 0;
  while (has(`review-${R + 1}.md`)) R++;
  let round = 1;
  let lastReview = null;
  if (R > 0) {
    lastReview = tryHeader(join(dir, `review-${R}.md`));
    // Batch F-2: an accepted task runs no further round, so its closing verify belongs to round R.
    round = !lastReview || lastReview.errors || reviewPassed(lastReview) || t.accepted ? R : R + 1;
  }
  const st = { ...base, round };
  const reviewDone = lastReview && !lastReview.errors;
  // D2: the round's one repair of red targeted tests; kt: also after a red closing verify. Agent in single and direct.
  const repairStep = () => {
    if (!single) return { ...st, next: 'repair', hint: 'inline: popraw sam czerwone testy z tests.md (bez osłabiania testów), potem verify' };
    const agentR = round > 1 || direct ? 'dwmt-executor-high' : 'dwmt-executor';
    const knownR = ctx.legacy ? '' : knownRedPrompt(knownRed(ctx.root, run, ctx.k));
    const repair = tryHeader(join(dir, `repair-${round}.md`));
    return {
      ...st, next: 'repair', agent: agentR, output: p(`repair-${round}.md`), ...invalidOf(q(`repair-${round}.md`), repair),
      prompt: `Round ${round}, repair: the targeted tests in ${q('tests.md')} are red. Make them green without weakening or skipping tests. A red this change did not cause: leave it and list it in \`unrelatedRed\` in the result header with the reason.${checksReturned(t, round) ? CHECKS_SENTENCE : ''}${headerFix(q(`repair-${round}.md`), repair)} ${repo}Brief: ${q('brief.md')}. Progress (append only): ${q('progress.md')}. Result: ${q(`repair-${round}.md`)}. The script runs \`verify\` in ${shellName(cfg)}. New assumptions start at A-${nextAssumption(dir)}.${knownR}${sprintBlock()}`,
      hint: repair?.errors ? `wynik naprawy niepoprawny: ${repair.errors.join('; ')}` : 'czerwone testy celowane: jedna naprawa przed recenzją',
    };
  };
  if (reviewDone && (reviewPassed(lastReview) || t.accepted)) {
    if (!t.commit) {
      const gate = ctx.legacy ? null : closingGate(t, round, dir, topOfRoot(ctx.root), st, repairStep, 'repair-');
      if (gate) return gate;
      const batched = lastReview.verdict !== 'PASS' && !t.accepted ? ` (do rundy zbiorczej: ${asList(lastReview.batch).map(idOf).join(', ')})` : '';
      return { ...st, next: 'commit', hint: t.accepted ? 'zaakceptowano z uwagami: commit --accept' : `PASS: commit${ctx.n > 1 ? ` zadania T-${ctx.k}` : ''}${batched}` };
    }
    return sprintEnd(run, st, cfg, ctx);
  }
  if (reviewDone && lastReview.verdict === 'FIX' && R >= (t.maxRounds ?? cfg.review.maxRounds)) {
    return { ...st, round: R, next: 'ask-rounds', hint: `po ${R} rundach nadal FIX (${fixNow(lastReview).join(', ')}): extend (kolejna runda) | commit --accept | stop` };
  }
  const fixMode = round > 1;
  const result = `result-${round}.md`;
  const agent = single ? (fixMode || direct ? 'dwmt-executor-high' : 'dwmt-executor') : null;
  const nextA = `New assumptions start at A-${nextAssumption(dir)}.`;
  // v2.9: uwagi-fakty wcześniejszych zadań zakotwiczone w planie tego zadania (zamiast replanu przez architekta).
  let notes = '';
  if (!ctx.legacy && !fixMode && is29(run)) {
    try {
      const list = infoNotesFor({ top: topOfRoot(ctx.root), root: ctx.root, run, k: ctx.k });
      if (list.length) notes = ` Notes from earlier tasks on code in your plan (facts found after planning; the code is the truth, the plan still holds unless you report planIssue): ${list.slice(0, 15).map((x, i) => `(${i + 1}) ${x}`).join(' ')}${list.length > 15 ? ` (+${list.length - 15} more in the earlier reports)` : ''}`;
    } catch { /* bez uwag */ }
  }
  // Przegląd sprintu 16 (UI): czerwień znana z zatwierdzonych wcześniej zadań (wykonawca jej nie bada).
  const known = ctx.legacy ? '' : knownRedPrompt(knownRed(ctx.root, run, ctx.k));
  const common = `${repo}Brief: ${q('brief.md')}. Progress (append only): ${q('progress.md')}. Result: ${q(result)}. The script runs \`verify\` in ${shellName(cfg)}. ${nextA}${notes}${known}`;
  // v2.8: recenzja z podziałem (`now`): fixer zadania poprawia tylko listę `now`, reszta czeka na rundę zbiorczą.
  const prevReview = fixMode ? tryHeader(join(dir, `review-${round - 1}.md`)) : null;
  const list = Array.isArray(prevReview?.now) ? 'now' : 'fix';
  // K4 (D-24): S-n kontroli skryptu na tej liście nazwane wprost (to nie uwagi recenzenta; cofnąć zmianę albo podać powód).
  const scriptFix = asList(prevReview?.scriptFindings).map(String).filter((x) => fixNow(prevReview).map((y) => idOf(String(y))).includes(x));
  const scriptPart = scriptFix.length ? ` Script check findings on that list: ${scriptFix.join(', ')} (revert the change, or for a file outside the scope declare it in \`outOfScopeChanges\` with the reason; never weaken or skip tests).` : '';
  const fixPart = fixMode ? ` Fix mode: fix the items on the ${list} list in the header of ${q(`review-${round - 1}.md`)}; diff: ${q('diff.patch')}.${scriptPart}`
    : direct ? directPrompt(rel(join(ctx.root, 'task.md'))) : '';
  if (single) {
    const res = tryHeader(join(dir, result));
    if (!res || res.errors) {
      const cont = !!t.started?.[round];
      // v2.7 (§5.8): po `replan-done` z planIssue świeży wykonawca kontynuuje z poprawionym planem zadania.
      const replanned = is27(run) && asList(t.drift).some((x) => x.kind === 'planIssue' && x.round === round);
      return {
        ...st, next: cont ? 'continue' : fixMode ? 'fix' : 'implement', agent, output: p(result), ...invalidOf(q(result), res),
        prompt: `Round ${round}.${cont ? ' Continue interrupted work: start from progress.md and diff.patch.' : ''}${cont && replanned ? ' The task plan was corrected after your BLOCKED report (planIssue): read it again before you continue.' : ''}${headerFix(q(result), res)} ${common}${fixPart}${sprintBlock()}`,
        hint: res?.errors ? `wynik niepoprawny: ${res.errors.join('; ')}` : null,
      };
    }
    if (res.status === 'PARTIAL' && !asksUser(res)) return { ...st, next: 'continue', agent, output: p(result), prompt: `Round ${round}. Continue work that ended PARTIAL: start from progress.md and diff.patch. ${common}${fixPart}${sprintBlock()}` };
    if (res.status === 'BLOCKED' || res.status === 'PARTIAL') {
      // E: bez architekta; eskalacja (albo planIssue) to pytanie do użytkownika: te pozycje trybem z architektem.
      if (direct && (res.escalate || res.planIssue)) {
        return {
          ...st, next: 'ask', questions: res.questions || [], escalate: String(res.escalate ?? res.planIssue), file: p(result),
          hint: `tryb bez planu: wykonawca eskaluje (${String(res.escalate ?? res.planIssue).slice(0, 200)}); zaproponuj nowy przebieg tych pozycji trybem z architektem (intermediate albo single); ten przebieg zostaw (wykonawca nic nie zmienił)`,
        };
      }
      // v2.7 (§5.8): plan błędny wraca do architekta (`replan`), także gdy wykonawca ma przy tym pytania.
      if (is27(run) && !ctx.legacy && res.planIssue) {
        const cause = planIssueCause(ctx, round, res);
        if (!handledIds(run).has(cause.id)) {
          t.replan = { at: new Date().toISOString(), from: ctx.k, causes: [cause] };
          return replanState({ root: ctx.root, run, cfg, base: st, k: ctx.k, causes: [cause] });
        }
      }
      return { ...st, next: 'ask', questions: res.questions || [], planIssue: res.planIssue ?? null, file: p(result), hint: 'section <plik> Q-n; po decyzji dopisz D-n do briefu i uruchom unblock' };
    }
    // D2: czerwone testy celowane raz wracają do wykonawcy tej rundy, zanim zobaczy je recenzja.
    const repair = tryHeader(join(dir, `repair-${round}.md`));
    if (t.repairs?.[round] && t.verified < round && (!repair || repair.errors)) return repairStep();
  } else if (t.verified < round) {
    if (t.repairs?.[round]) return repairStep();
    return { ...st, next: fixMode ? 'fix' : 'implement', hint: fixMode ? `inline: popraw sam uwagi fix z review-${round - 1}.md, potem verify` : 'inline: implementuj sam według briefu, potem verify' };
  }
  if (t.verified < round || t.reviewInput < round) return { ...st, next: 'verify', hint: 'verify, potem review-input' };
  const units = t.units?.[round];
  if (units?.length > 1) {
    const out = (u) => `review-${round}-${u.id}.md`;
    const pending = units.filter((u) => { const h = tryHeader(join(dir, out(u))); return !h || h.errors; });
    return {
      ...st, next: 'review', agent: t.reviewAgent?.[round] ?? 'dwmt-reviewer', hint: `${units.length} jednostek recenzji, mogą działać równolegle; po wszystkich state scala je w review-${round}.md`,
      units: pending.map((u) => ({ unit: u.name, agent: u.agent ?? 'dwmt-reviewer', output: p(out(u)), prompt: `${repo}Input: ${q(`review-input-${u.id}.md`)}. Output: ${q(out(u))}.` })),
    };
  }
  // v2.10: recenzent zmiany bez kodu (`reviewer-high`), gdy tak zdecydował review-input tej rundy.
  return { ...st, next: 'review', agent: t.reviewAgent?.[round] ?? 'dwmt-reviewer', output: p(`review-${round}.md`), prompt: `${repo}Input: ${q('review-input.md')}. Output: ${q(`review-${round}.md`)}.` };
}

// v2.8 (§5.9 „Koniec sprintu”): runda zbiorcza po commicie ostatniego zadania, przed kontrolą celu. Świeży
// `dwmt-executor-high` poprawia wszystkie pozycje, verify (suma komend zadań pozycji), recheck, commit; null = zacommitowana.
function batchState(run, cfg, root, base) {
  const top = topOfRoot(root);
  ensureBatch(run, cfg);
  const b = batchCtx(root, run);
  const { dir, t } = b;
  if (!existsSync(join(dir, 'batch.md'))) writeBatchFile(top, root, run);
  const p = (n) => fwd(join(dir, n));
  const { rel, root: repo0 } = pathsFor(run, top);
  const repo = `${repo0}${artifactsLang(run)}`;
  const q = (n) => rel(join(dir, n));
  let R = 0;
  while (existsSync(join(dir, `review-${R + 1}.md`))) R++;
  let round = 1;
  let last = null;
  const max = t.maxRounds ?? cfg.review.maxRounds;
  if (R > 0) {
    last = tryHeader(join(dir, `review-${R}.md`));
    // Batch F-2: accepted, or FIX at the round limit: no further round runs, so the closing verify belongs to round R.
    round = !last || last.errors || last.verdict === 'PASS' || t.accepted || R >= max ? R : R + 1;
  }
  const st = { ...base, batch: true, dir: fwd(dir), round, items: t.items.length };
  const done = last && !last.errors;
  // The batch round's one repair of red tests; kt: also after a red closing verify.
  function batchRepairStep() {
    const repair = tryHeader(join(dir, `repair-${round}.md`));
    return {
      ...st, next: 'repair', agent: 'dwmt-executor-high', output: p(`repair-${round}.md`), ...invalidOf(q(`repair-${round}.md`), repair),
      prompt: `Batch round ${round}, repair: the targeted tests in ${q('tests.md')} are red. Make them green without weakening or skipping tests. A red this change did not cause: leave it and list it in \`unrelatedRed\` in the result header with the reason.${checksReturned(t, round) ? CHECKS_SENTENCE : ''}${headerFix(q(`repair-${round}.md`), repair)} ${repo}Batch: ${q('batch.md')}. Progress (append only): ${q('progress.md')}. Result: ${q(`repair-${round}.md`)}. The script runs \`verify\` in ${shellName(cfg)}.${knownRedPrompt(knownRed(root, run))}`,
      hint: repair?.errors ? `wynik naprawy niepoprawny: ${repair.errors.join('; ')}` : 'czerwone testy celowane: jedna naprawa przed recenzją',
    };
  }
  const result = `result-${round}.md`;
  const res = tryHeader(join(dir, result));
  // Bieżący BLOCKED z planIssue bez pytań zamyka pozycje już tutaj (bez skutków ubocznych: archiwizację robi cmdState).
  const closing = planIssueOnly(res) ? round : null;
  const closed = closedIds(root, run, closing);
  if (done && (last.verdict === 'PASS' || t.accepted || R >= max)) {
    // Otwarte pozycje po ostatniej rundzie zostają w raporcie jako odłożone; otwarty blocker: pytanie jak w zadaniu.
    const blockers = last.verdict === 'PASS' || t.accepted ? [] : resolveIds(last.fix, t.items).ids.filter((id) => !closed.includes(id) && findingSeverity(dir, id) === 'blocker');
    if (blockers.length) return { ...st, round: R, next: 'ask-rounds', hint: `runda zbiorcza: po ${R} rundach otwarty blocker (${blockers.join(', ')}): extend | commit --accept | stop` };
    const gate = t.commit ? null : closingGate(t, round, dir, top, st, batchRepairStep, 'repair-');
    if (gate) return gate;
    if (!t.commit) return { ...st, next: 'commit', hint: last.verdict === 'PASS' ? 'runda zbiorcza PASS: commit' : `runda zbiorcza: otwarte pozycje zostają odłożone (${asList(last.fix).join(', ')}): commit` };
    return null;
  }
  const agent = 'dwmt-executor-high';
  const known = knownRedPrompt(knownRed(root, run));
  const common = `${repo}Batch: ${q('batch.md')}. Progress (append only): ${q('progress.md')}. Result: ${q(result)}. The script runs \`verify\` in ${shellName(cfg)}.${known}`;
  // Pozycje zamknięte przez skrypt (planIssue bez pytań) fixer pomija; zostają otwarte w raporcie z powodem.
  const closedNote = closed.length ? ` Closed by the script after a planIssue, leave them (they stay open): ${closed.join(', ')}.` : '';
  const fixPart = round === 1
    ? ` Fix mode: fix every item of the batch; read the plan of an item's task for context. List \`fixed\` and \`notReproduced\` by the items' T-k/F-n (or T-k/KR-n) ids.${closedNote}`
    : ` Fix mode: fix the items on the fix list in the header of ${q(`review-${round - 1}.md`)}; diff: ${q('diff.patch')}. List \`fixed\` and \`notReproduced\` by their ids.${closedNote}`;
  if (!res || res.errors) {
    const cont = !!t.started?.[round];
    // Po BLOCKED z pytaniami orkiestrator dopisał decyzje D-n do batch.md (`## Decisions`): kontynuacja ma je przeczytać.
    const answered = cont && readdirSync(dir).some((f) => new RegExp(`^result-${round}\\.blocked-\\d+\\.md$`).test(f) && asList(tryHeader(join(dir, f))?.questions).length);
    return {
      ...st, next: cont ? 'continue' : 'batch', agent, output: p(result), ...invalidOf(q(result), res),
      prompt: `Batch round ${round}.${cont ? ' Continue interrupted work: start from progress.md and diff.patch.' : ''}${answered ? ' Your BLOCKED report was answered: read the decisions under ## Decisions in batch.md before you continue.' : ''}${headerFix(q(result), res)} ${common}${fixPart}`,
      hint: res?.errors ? `wynik niepoprawny: ${res.errors.join('; ')}` : `runda zbiorcza: ${t.items.length} pozycji`,
    };
  }
  if (res.status === 'PARTIAL' && !asksUser(res)) return { ...st, next: 'continue', agent, output: p(result), prompt: `Batch round ${round}. Continue work that ended PARTIAL: start from progress.md and diff.patch. ${common}${fixPart}` };
  if (res.status === 'BLOCKED' || res.status === 'PARTIAL') {
    // W rundzie zbiorczej nie ma replanu. planIssue bez pytań: skrypt zamyka pozycje, których dotyczy (wymienione w nim,
    // inaczej wszystkie niepoprawione), jako otwarte z powodem; fixer kontynuuje resztę, a bez reszty wynik pisze skrypt.
    // Stan odpowiada już zamkniętym pozycjom; `pendingClose` każe cmdState zarchiwizować wynik BLOCKED (i bez reszty
    // pozycji zapisać wynik rundy za fixera). Zamknięcie wynika z pliku `result-N.blocked-M.md`, więc odczyt go nie gubi.
    if (closing != null) {
      const fixed = resolveIds(asList(res.fixed), t.items).ids;
      if (remainingItems(root, run, closed).length) {
        return { ...st, next: 'continue', agent, output: p(result), pendingClose: { round }, prompt: `Batch round ${round}. Continue interrupted work: start from progress.md and diff.patch. ${common}${fixPart}` };
      }
      return { ...st, next: 'verify', pendingClose: { round, done: true, fixed, ids: closed }, hint: 'runda zbiorcza: wszystkie pozycje zamknięte po planIssue; skrypt zapisał wynik rundy, dalej verify i recheck przyrostu' };
    }
    return { ...st, next: 'ask', questions: res.questions || [], planIssue: res.planIssue ?? null, file: p(result), hint: 'section <plik> Q-n; po decyzji dopisz `### D-n` pod `## Decisions` w batch.md i uruchom unblock' };
  }
  const repair = tryHeader(join(dir, `repair-${round}.md`));
  if (t.repairs?.[round] && t.verified < round && (!repair || repair.errors)) return batchRepairStep();
  if (t.verified < round || t.reviewInput < round) return { ...st, next: 'verify', hint: 'runda zbiorcza: verify, potem review-input' };
  const units = t.units?.[round];
  if (units?.length > 1) {
    const out = (u) => `review-${round}-${u.id}.md`;
    const pending = units.filter((u) => { const h = tryHeader(join(dir, out(u))); return !h || h.errors; });
    return {
      ...st, next: 'review', agent: 'dwmt-reviewer', hint: `runda zbiorcza: ${units.length} jednostki recenzji; po wszystkich state scala je w review-${round}.md`,
      units: pending.map((u) => ({ unit: u.name, agent: u.agent ?? 'dwmt-reviewer', output: p(out(u)), prompt: `${repo}Input: ${q(`review-input-${u.id}.md`)}. Output: ${q(out(u))}.` })),
    };
  }
  return { ...st, next: 'review', agent: 'dwmt-reviewer', output: p(`review-${round}.md`), prompt: `${repo}Input: ${q('review-input.md')}. Output: ${q(`review-${round}.md`)}.` };
}

// Waga uwagi rundy zbiorczej: nagłówek `### <id> [waga]` w recenzjach rundy (od najnowszej), potem w batch.md.
function findingSeverity(dir, id) {
  const texts = [...reviewTexts(dir).reverse(), ...(existsSync(join(dir, 'batch.md')) ? [read(join(dir, 'batch.md'))] : [])];
  for (const text of texts) {
    const sec = findingSection(text, id);
    const m = sec && /\[(blocker|major|minor)\]/i.exec(sec.split(/\r?\n/)[0]);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

function mergeUnits({ dir, t, batch }) {
  for (const [round, units] of Object.entries(t.units || {})) {
    if (!units || units.length < 2 || existsSync(join(dir, `review-${round}.md`))) continue;
    const files = units.map((u) => join(dir, `review-${round}-${u.id}.md`));
    if (!files.every((f) => { const h = tryHeader(f); return h && !h.errors; })) continue;
    // Recheck (D2): uwagi poprzedniej rundy zachowują identyfikatory, nowe numerowane dalej.
    const prev = join(dir, `review-${Number(round) - 1}.md`);
    const base0 = Number(round) > 1 && existsSync(prev) ? maxFinding(read(prev)) : 0;
    // Runda zbiorcza: gołe `F-n` do numeru najwyższej pozycji to pozycje (nowe uwagi numerowane od niego dalej).
    const base = batch ? Math.max(base0, itemMax(t.items)) : base0;
    writeFileSync(join(dir, `review-${round}.md`), mergeReviews(units.map((u, i) => ({ name: u.name, text: read(files[i]) })), base));
  }
}

// Gałąź bez własnych commitów dogania cel po scaleniu zależności (§5.10).
function catchUp(top, run) {
  const own = Number(git(['rev-list', '--count', `${run.target}..HEAD`], { cwd: top }));
  if (!own && !dirty(top).length && git(['branch', '--show-current'], { cwd: top }) === run.branch
    && gitRaw(['merge', '--ff-only', '-q', run.target], { cwd: top }).status === 0) {
    run.tasks[0].baseline = git(['merge-base', run.target, 'HEAD'], { cwd: top });
  }
}

// v2.7: po wyjściu z `planned` plany zadań pisze świeży architekt na kodzie po scaleniu (brak planów), a gotowe plany
// sprawdza kontrola rozjazdu z przyczyną `target` od zadania 1; kopie explore/ z plikami zmienionymi przez cel są nieaktualne.
function leavePlanned27(top, run, root) {
  run.afterDone = new Date().toISOString();
  catchUp(top, run);
  const mb = git(['merge-base', run.target, 'HEAD'], { cwd: top });
  const files = run.planBase && run.planBase !== mb ? git(['diff', '--name-only', '--no-renames', run.planBase, mb], { cwd: top }).split(/\r?\n/).filter(Boolean) : [];
  run.exploreStale = [...new Set([...asList(run.exploreStale), ...files])];
  run.architect = null;
  const n = asList(planInfo(root, run)?.h?.tasks).length;
  const all = n > 0 && Array.from({ length: n }, (_, i) => i + 1).every((k) => existsSync(join(taskDir(root, k), 'brief.md')));
  if (all) run.targetCheck = { from: run.planBase, at: run.afterDone };
  else { run.afterChanged = files.slice(0, 50); run.planBase = mb; }
  try { copyExplore(root, run, { force: true }); } catch { /* kopia explore/ jest best effort */ }
}

// Wyjście z `planned` (§5.10): gałąź bez własnych commitów dogania cel; zmienione pliki z zakresu zadania 1 → odświeżenie briefu.
function leavePlanned(top, run, root) {
  run.afterDone = new Date().toISOString();
  catchUp(top, run);
  if (!run.planBase) return;
  const scope = asList(tryHeader(join(taskDir(root, 1), 'brief.md'))?.scope);
  const files = git(['diff', '--name-only', run.planBase, run.target], { cwd: top }).split(/\r?\n/).filter(Boolean)
    .filter((f) => scope.some((g) => globToRegExp(g).test(f)));
  if (files.length) run.refresh = { at: new Date().toISOString(), files };
}

// Pytania dla statusu: tytuły `### Q-n` i linie `Affects` (sprinty zlecenia, `none`, `uncertain`).
export function questionInfo(file, ids) {
  const text = file && existsSync(file) ? read(file) : '';
  // D4: `Q-price` nie ma sekcji w pliku i dotyczy tylko tego sprintu (§6.4 pkt 6: R1 nie wstrzymuje pracy niezależnej).
  const qs = asList(ids).map((id) => (id === PRICE_Q ? `${PRICE_Q} Price of the design\n- Affects: none` : section(text, id) || id));
  const titles = qs.map((s) => s.split(/\r?\n/)[0].replace(/^#+\s*/, ''));
  const aff = qs.map((s) => /^\s*[-*]?\s*\**Affects\**:\s*(.*)$/im.exec(s)?.[1]?.trim() ?? 'uncertain');
  const affects = aff.some((a) => /uncertain|niepewn/i.test(a)) ? 'uncertain'
    : [...new Set(aff.flatMap((a) => a.split(/[\s,;]+/)).filter((a) => a && !/^(none|brak)$/i.test(a)))];
  return { questions: titles, affects };
}

// Status dla supervisora z kroku `state` (tylko przebiegi z --sprint).
function stateStatus(top, run, root, st, event) {
  if (!run.sprint) return;
  const t1 = run.tasks[0];
  const stage = run.task > 1 || t1.verified || Object.keys(t1.started).length || existsSync(join(taskDir(root, 1), 'result-1.md')) ? 'implementation' : 'planning';
  const head = planInfo(root)?.h ?? tryHeader(join(taskDir(root, 1), 'brief.md')) ?? {};
  const area = { scope: asList(head.scope), shared: asList(head.shared) };
  const n = st.next;
  const f = run.finish;
  let state = 'running';
  // S3 (§4.6): `running` niesie obszary (zakres i pliki wspólne z planu) dla R2 w pętli supervisora.
  let fields = { step: n, round: st.round, ...area };
  const v27 = is27(run);
  if (n === 'plan') { state = 'planning'; fields = { stage: v27 ? 'plan' : st.key && st.key !== 'planner' ? st.key : 'sprint' }; }
  else if (n === 'replan') { state = 'planning'; fields = { stage: `replan T-${st.from}`, causes: st.causes }; }
  else if (n === 'ask-delete') { state = 'waiting-user'; fields = { questions: asList(st.files), affects: 'none', stage, reason: 'delete' }; }
  else if (['ask-plan', 'ask', 'ask-rounds'].includes(n)) {
    state = 'waiting-user';
    // v2.7 (§5.2): druga paczka pytań (runda „pod plan”) jest jawnie oznaczona w statusie.
    const round2 = v27 && n === 'ask-plan' && Number(planInfo(root)?.h?.questionsRound) === 2 && fwd(st.file).endsWith('/plan.md');
    fields = { ...(n === 'ask-rounds' ? { questions: [st.hint], affects: 'none' } : questionInfo(st.file, st.questions)), stage, ...area, ...(round2 ? { questionsRound: 2 } : {}) };
  } else if (n === 'planned') { state = 'planned'; fields = { scope: area.scope, waitingFor: st.waitingFor }; }
  else if (n === 'handoff') { state = 'handoff'; fields = { task: st.task, commit: st.commit }; }
  else if (n === 'stopped') { state = 'stopped'; fields = { reason: st.reason }; }
  // K2 (D-9): stop na odłożonych uwagach major czeka na użytkownika (jak ask-rounds), nie `running`.
  else if (n === 'finish' && f?.status === 'deferred-major') { state = 'waiting-user'; fields = { questions: [st.hint], affects: 'none', stage, reason: 'deferred-major' }; }
  else if (n === 'finish' && f?.status === 'merge-wait') { state = 'merge-wait'; fields = { reason: f.reason, files: f.files, since: f.since, base: f.base }; }
  else if (n === 'done') { state = 'done'; fields = { result: f?.result ?? null, cost: f?.cost ?? null, uat: f?.uat ?? null, ...(v27 ? { gaps: f?.gaps ?? null } : {}) }; }
  // v2.8: runda zbiorcza to krok `batch` stanu `running` (bieżący krok rundy w `batchStep`).
  else if (st.batch) fields = { step: 'batch', batchStep: n, round: st.round, ...area };
  writeStatus(top, run, state, { ...fields, ...(st.limit ? { limit: st.limit } : {}) }, event);
}

// K5 D-11: `--peek` reads without side effects: no caller registration, no merge, autofix, session stop, status, event
// or live writer; only computeState on run.json as it is.
export function cmdState(top, id, opts = {}) {
  if (opts.peek) {
    const run = loadRun(top, id, { register: false });
    return { ...computeState(runDir(top, id), run, loadConfig(top)), peek: true };
  }
  const run = loadRun(top, id);
  const root = runDir(top, id);
  const cfg = loadConfig(top);
  const legacy = isLegacy(run);
  // Przekazanie (§5.10) obowiązuje tylko sesję, która zacommitowała zadanie; w każdej innej znika.
  if (!legacy && run.handoff && !(run.handoff.session && run.handoff.session === sessionId())) run.handoff = null;
  mergeUnits(taskCtx(root, run));
  // v2.8 (§5.6): po scaleniu recenzji zadania podział listy `fix` na `now` i `batch` (skrypt, 0 tokenów).
  if (!legacy) splitReviews(top, root, run, cfg, taskCtx(root, run));
  if (!legacy && run.batch?.items) mergeUnits(batchCtx(root, run));
  // K4 (D-24): S-n kontroli skryptu rundy zbiorczej do jej recenzji (po scaleniu jednostek, przed odczytem listy `fix`).
  if (!legacy && run.batch?.items) recordScriptFindings(join(root, 'batch'), run.batch);
  const v27 = !legacy && is27(run);
  // v2.7 (§5.2): odpowiedzi eksploratorów z transkryptów do explore/ przy każdym wywołaniu (best effort, idempotentnie).
  if (v27) try { copyExplore(root, run); } catch { /* format transkryptów jest nieudokumentowany */ }
  // v2.9: autopoprawki planów zadań (C-n i D-n z planu sprintu, jednoznaczne skróty ścieżek) przed walidacją w computeState.
  const autofixed = v27 ? autofixPlans({ top, root, run, cfg }) : [];
  // v2.9: sesje `--bg` wcześniejszych zadań tego przebiegu kończą się w nowej (sprinty 6+7: 7 bezczynnych sesji po ok. 0,85 GB).
  const stopped = legacy ? [] : stopEarlierSessions(run);
  // W-4 (przegląd 2026-10-09): tryb pośredni, w którym architekt przy szacunku ponad próg podzielił sprint na zadania, staje
  // się `single` przed ceną (cena i raport według trybu faktycznego); raz, z zapisem w `run.modeSwitch` i linią dla sterownika.
  const switched = v27 ? switchFromIntermediate(top, root, run) : null;
  // D4 (spec warstwy produktowej §6.4): cena projektu przy pierwszej poprawnej walidacji planu i odpowiedź na Q-price.
  const unpriced = !run.price;
  if (v27) priceGateStep({ top, root, run, cfg, plan: planInfo(root, run) });
  let st = computeState(root, run, cfg);
  // Recenzja N-4: cena bez pytania (w granicy szacunku albo freestyle bez pytań architekta) raz do zdania kroku.
  const note = unpriced && run.price ? priceNote(run) : null;
  if (note) st.priceNote = note;
  if (switched) st.modeSwitch = switched;
  if (autofixed.length) st.autofixed = autofixed.map((f) => `T-${f.k}: ${f.fixes.join('; ')}`);
  if (stopped.length) st.stoppedSessions = stopped;
  // v3: sesja orkiestratora w trybie sterownika tylko uruchamia `drive.mjs` i obsługuje jego zatrzymania; `inline` (model
  // pisze kod sam) zostaje bez sterownika.
  if (v27 && st.leave) {
    leavePlanned27(top, run, root);
    st = computeState(root, run, cfg);
  } else if (!legacy && !v27 && asList(run.after).length && !run.afterDone && !['plan', 'ask-plan', 'planned'].includes(st.next)) {
    leavePlanned(top, run, root);
    st = computeState(root, run, cfg);
  }
  // D-14: zależność dodana przed pierwszym zadaniem; wyjście z `planned` przejdzie przez leavePlanned27 jeszcze raz.
  if (v27 && st.again) delete run.afterDone;
  delete st.leave;
  delete st.again;
  // Tryb A: `dwmt drive-mode <run> off` (run.drive = false) — sesja dokańcza przebieg sama, bez sterownika.
  if (cfg.drive?.enabled && run.drive !== false && !legacy && (st.mode ?? run.mode) !== 'inline') st.drive = true;
  // Recenzja S3 (supervisor R4, R2/R3): `drive.hold` sprawdza `state`, nie sterownik po przejściu. Zadanie wstrzymane nie
  // zaczyna się: bez `task-start` (licznik nocy, etap planowania w R2), czasu startu i usunięć; sterownik kończy się na
  // `st.held` (ta sama obserwacja pliku, więc bez wyścigu z pętlą, która zakłada albo zdejmuje plik).
  if (driverCall() && st.next === 'implement' && !st.batch && (st.round ?? 1) === 1 && existsSync(join(root, 'drive.hold'))) st.held = true;
  const { dir, t } = taskCtx(root, run);
  // Krok rundy zbiorczej działa na jej katalogu i stanie (`run.batch`), nie na ostatnim zadaniu.
  const cur = st.batch ? batchCtx(root, run) : taskCtx(root, run);
  // v2.8: BLOCKED z planIssue bez pytań w rundzie zbiorczej: archiwizacja wyniku (zamknięcie pozycji wynika z tego pliku)
  // i, bez pozostałych pozycji, wynik rundy za fixera; tylko tutaj, bo state zapisuje run.json (computeState jest bez skutków).
  if (st.pendingClose) {
    const pc = st.pendingClose;
    delete st.pendingClose;
    unblock(cur.dir, pc.round);
    if (pc.done) writeFileSync(join(cur.dir, `result-${pc.round}.md`), withHeader({ schema: 'dwmt/result@1', status: 'DONE', fixed: pc.fixed, notReproduced: [] }, `\n## Reasons\n- Written by the script: every item is closed after a planIssue (${pc.ids.join(', ')}).\n`));
  }
  const now = new Date().toISOString();
  let event = null;
  if (v27) {
    // Zamrożenie planów (§5.9): po wyjściu z planowania plany sprawdza tylko `replan`; `planBase` = bieżący merge-base,
    // chyba że czeka przyczyna `target` po wyjściu z `planned` (przesunie go `replan-done`).
    if (!run.plansReady && !['plan', 'ask-plan', 'planned', 'stopped'].includes(st.next)) {
      run.plansReady = now;
      if (st.next !== 'replan') { run.planBase = git(['merge-base', run.target, 'HEAD'], { cwd: top }); delete run.targetCheck; }
    }
    // Identyfikator architekta działa tylko w sesji, która go uruchomiła (`fresh` w kolejnych stanach). Pod sterownikiem
    // architekta uruchamia tylko sterownik: `state` sesji zatrzymania nie przejmuje go (odpowiedzi wracają przez `--resume`).
    if (st.agent === ARCHITECT && (!st.drive || driverCall())) run.architect = { session: sessionId(), at: now };
  }
  if (!legacy) {
    if (run.count == null && !['plan', 'ask-plan', 'stopped'].includes(st.next)) run.count = sprintCount(root, run);
    if (run.count != null) st.tasks = run.count;
    if (!t.title && existsSync(join(dir, 'brief.md')) && !['plan', 'ask-plan', 'stopped'].includes(st.next)) {
      t.title = planInfo(root)?.tasks.find((x) => x.k === t.k)?.title || tryHeader(join(dir, 'brief.md'))?.goal || null;
    }
    // Wyjątek „to dwa sprinty” (§5.9): raz w wyniku, kopia planu w głównym drzewie, zdarzenie dla pętli.
    const plan = planInfo(root);
    if (plan && !plan.errors.length && plan.h.second && !asList(plan.h.questions).length && !run.secondNoted) {
      run.secondNoted = now;
      st.second = plan.h.second;
      const copy = archive(top, run, ['plan.md']);
      event = { type: 'two-sprints', text: plan.h.second, plan: copy ? fwd(join(copy, 'plan.md')) : fwd(plan.file) };
    }
  }
  const limit = agentLimit(run);
  if (limit) st.limit = limit;
  // Przegląd 2026-10-04: pod sterownikiem agentów uruchamia tylko on; `state` z sesji (PO wznawiająca przebieg)
  // tylko patrzy. Wcześniej zapisywał `started`, a sterownik dawał potem świeżemu wykonawcy „kontynuuj przerwaną pracę”.
  else if (!st.held && (!st.drive || driverCall())) {
    if (st.next === 'continue' && existsSync(join(cur.dir, st.batch ? 'batch.md' : 'brief.md'))) diffRun(top, run, cur, st.round);
    if (st.next === 'continue') archivePartial(cur.dir, st.round);
    if (['implement', 'fix', 'batch'].includes(st.next) && st.agent) cur.t.started = { ...cur.t.started, [st.round]: now };
    // D2: komendy verify z planu; wykonawca może potem poprawić ich formę, a recenzent i raport widzą różnicę.
    if (st.next === 'implement' && !t.verifyPlanned) t.verifyPlanned = asList(tryHeader(join(dir, 'brief.md'))?.verify);
    if (st.agent || st.units?.length) run.stepAt = now;
    // v2.10 (B): na starcie zadania skrypt usuwa jego pliki z `delete` za zgodą użytkownika; bez zgody zostają (`kept`).
    if (!legacy && is210(run) && ['implement', 'continue', 'fix'].includes(st.next) && !st.batch) {
      const mine = asList(tryHeader(join(dir, 'brief.md'))?.delete).map(String);
      const approved = new Set(asList(run.deletions?.approved));
      const declined = new Set(asList(run.deletions?.declined));
      const { removed, refused } = removeFiles(top, mine.filter((f) => approved.has(f)));
      if (removed.length) { t.deleted = [...new Set([...asList(t.deleted), ...removed])]; st.deleted = removed; }
      const kept = mine.filter((f) => declined.has(f) || refused.includes(f));
      if (kept.length) t.kept = kept;
    }
  }
  // D4 (§6.4 pkt 5): „stop” na pytaniu o cenę: przebieg zatrzymany z powodem (raz), gałąź zostaje.
  if (st.next === 'stopped' && !run.stopped) {
    run.stopped = { reason: st.reason, at: now };
    runEvent(top, run, 'sprint-end', { verdict: 'stopped', detail: { status: 'stopped', reason: st.reason } });
  }
  // v2.10: zdarzenia dziennika maszyny (start zadania raz, pytanie czeka przy wejściu w krok pytania).
  if (!legacy) {
    if (st.next === 'implement' && !st.batch && !t.startEvent && !st.held) {
      t.startEvent = now;
      runEvent(top, run, 'task-start', { task: t.k, detail: { mode: st.mode ?? run.mode, title: t.title ?? null, tasks: st.tasks ?? null } });
    }
    if (['ask-plan', 'ask', 'ask-rounds', 'ask-delete'].includes(st.next) && run.phase !== st.next) {
      runEvent(top, run, 'question-waiting', { detail: { step: st.next, ...(st.questions ? { questions: st.questions } : {}), ...(st.files ? { files: st.files } : {}), ...(st.delete ? { delete: st.delete } : {}) } });
    }
  }
  run.phase = st.next;
  saveRun(top, run);
  if (!legacy) stateStatus(top, run, root, st, event);
  // Tryb A (recenzja): sesja w głównym drzewie, przebieg w worktree — kroki sesji (git, poprawki, agenci) idą tam.
  if (foreignTree(top)) st.tree = fwd(top);
  // Live sprint view: the writer of the product page's live.js starts on demand (detached, best effort, a few ms).
  ensureLive(top, { home: runHome(run, top), cfg });
  return st;
}

function switchFromIntermediate(top, root, run) {
  if (run.modeLabel !== 'intermediate' || run.plansReady) return null;
  const plan = planInfo(root, run);
  const n = Math.max(asList(plan?.h?.tasks).length, plan?.tasks?.length ?? 0);
  if (!plan || plan.h.errors || plan.errors.length || n < 2 || !overIntermediate(run, plan.h)) return null;
  const reason = `architect estimate ${plan.h.files.join('-')} files > ${intermediateLimit(run)} (intermediate limit), ${n} tasks`;
  run.modeSwitch = { from: 'intermediate', to: 'single', at: new Date().toISOString(), files: plan.h.files, tasks: n, reason };
  delete run.modeLabel;
  runEvent(top, run, 'mode-switch', { detail: run.modeSwitch });
  return `intermediate → single: ${reason}`;
}

export function cmdExtend(top, id) {
  const run = loadRun(top, id);
  const root = runDir(top, id);
  const cfg = loadConfig(top);
  const { t } = !isLegacy(run) && computeState(root, run, cfg).batch ? batchCtx(root, run) : taskCtx(root, run);
  t.maxRounds = (t.maxRounds ?? cfg.review.maxRounds) + 1;
  saveRun(top, run);
  return { ok: true, maxRounds: t.maxRounds };
}

// v2.7 (§5.8, §5.9): po odpowiedzi architekta na `replan` zapisuje obsłużone przyczyny w `tasks[k].drift`, więc
// odpowiedź „plan aktualny” nie wraca w pętli. Plany od k muszą przejść walidację (błędy: bez zapisu, `state` odsyła je
// temu samemu architektowi). Przy zmianie celu przesuwa `planBase`, przy `planIssue` zdejmuje blokadę zadania.
export function cmdReplanDone(top, id, kArg, opts) {
  const run = loadRun(top, id);
  const root = runDir(top, id);
  const cfg = loadConfig(top);
  if (!is27(run) || isLegacy(run)) throw new Error('replan-done tylko w przebiegu v2.7 (rules: 2.7 w run.json)');
  const k = Number(kArg);
  if (!Number.isInteger(k) || k !== run.task) throw new Error(`zadanie ${kArg}: replan-done dotyczy bieżącego zadania T-${run.task}`);
  if (!['changed', 'unchanged'].includes(opts.result)) throw new Error('podaj --result changed|unchanged');
  if (opts.cause === true) throw new Error('--cause wymaga wartości: plan|discovery|target');
  if (opts.cause !== undefined && !['plan', 'discovery', 'target'].includes(opts.cause)) throw new Error(`--cause ${opts.cause}, dozwolone: plan|discovery|target`);
  const ctx = taskCtx(root, run, k);
  // Bez trwającej fazy replan (t.replan ustawia state) nie ma czego zapisać: pomyłkowe wywołanie nie może oznaczyć przyczyn.
  if (!ctx.t.replan) return { ok: false, task: k, hint: `T-${k} nie ma trwającego replan: najpierw state (zwraca replan, gdy jest rozjazd)` };
  // Przyczyny, które wywołały replan (state zapisał je w t.replan): architekt mógł już usunąć ich ślad w planie.
  const triggered = asList(ctx.t.replan?.causes);
  // v2.9: najpierw autopoprawki (sam nagłówek C-n i D-n z planu sprintu jest poprawny), inaczej replan wracałby drugi raz.
  autofixPlans({ top, root, run, cfg });
  const v = validateFrom({ top, root, run, cfg, from: k });
  const errors = [...v.errors, ...v.missing.map((j) => `brak planu T-${j}`)];
  if (errors.length) return { ok: false, task: k, errors: errors.slice(0, 10), hint: 'plany od T-k niepoprawne: state odsyła błędy temu samemu architektowi' };
  const round = roundOf(ctx.dir);
  const done = handledIds(run);
  const causes = [...triggered, ...currentCauses({ top, root, run, cfg, ctx, round })]
    .filter((c, i, all) => !done.has(c.id) && all.findIndex((x) => x.id === c.id) === i);
  const rec = recordReplan({ top, run, ctx, causes, result: opts.result, cause: opts.cause });
  const unblocked = rec.planIssue ? unblock(ctx.dir, rec.planIssue.round ?? round) : false;
  saveRun(top, run);
  return {
    ok: true, task: k, result: opts.result, cause: rec.cause, handled: rec.handled, ...(rec.planBase ? { planBase: rec.planBase } : {}),
    ...(unblocked ? { unblocked: true } : {}), ...(v.questions.length ? { questions: v.questions.map((j) => `T-${j}`) } : {}),
    hint: v.questions.length ? 'plany mają otwarte pytania: state (ask-plan)' : unblocked ? 'state: świeży wykonawca kontynuuje z poprawionym planem' : 'state',
  };
}

export function cmdUnblock(top, id) {
  const run = loadRun(top, id);
  const root = runDir(top, id);
  const st = computeState(root, run, loadConfig(top));
  return { ok: unblock((st.batch ? batchCtx(root, run) : taskCtx(root, run)).dir, st.round) };
}
