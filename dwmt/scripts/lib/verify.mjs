// dwmt: weryfikacja (`verify`): komendy, środowisko i porty, rebase do recenzji, czerwień zapowiedziana.
import { writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { heavyLease, busyPorts } from '../machine.mjs';
import { touchActive } from '../watch.mjs';
import { is29 } from '../plan.mjs';
import { batchCtx, splitReviews, batchVerify, batchUiRisks } from '../batch.mjs';
import { fwd, read, asList } from './util.mjs';
import { withHeader, tryHeader } from './headers.mjs';
import { esc, trimOutput, globToRegExp } from './text.mjs';
import { gitRaw, git, dirty, clearGitMemo, sprintChangedFiles } from './git.mjs';
import { productConfig, codeMatcher } from './product-config.mjs';
import { loadConfig } from './config.mjs';
import { runDir, loadRun, saveRun, isLegacy, taskCtx, allTasks, writeStatus, runEvent } from './run.mjs';
import { computeState } from './state.mjs';
import { uiRisks, uiDir, collectShots, prepareUi, writeCompare } from './ui.mjs';
import { commitWith } from './commit.mjs';
import { knownRed, knownRedClaims } from './known-red.mjs';
import { snapshotTree, oneSource } from './review.mjs';
import { runScriptChecks, applyChecks, CHECK_CMD } from './script-checks.mjs';
import { redFiles, selectRuns, mergeResults } from './verify-select.mjs';

// ---------- weryfikacja ----------

export const shellName = (cfg) => cfg?.verify?.shell || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');

export function runCommand(cmd, cwd, shell = null) {
  const env = { ...process.env, JAVA_TOOL_OPTIONS: [process.env.JAVA_TOOL_OPTIONS, '-Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8'].filter(Boolean).join(' ') };
  const t0 = Date.now();
  const opts = { cwd, encoding: 'utf8', env, maxBuffer: 256 << 20, timeout: 60 * 60e3, windowsHide: true };
  const r = shell ? spawnSync(shell, ['-c', `(${cmd}) 2>&1`], opts) : spawnSync(`(${cmd}) 2>&1`, { ...opts, shell: true });
  clearGitMemo(); // the command may have run git
  return { cmd, exit: r.status ?? -1, ms: Date.now() - t0, t0, output: [r.stdout, r.stderr, r.error?.message].filter(Boolean).join('\n') };
}

// Czerwona komenda biegnie drugi raz (verify.rerunRed, D2): zielona za drugim razem jest niestabilna (flaky),
// nie odsyła wykonawcy i nie blokuje finish, ale zostaje w tests.md i raporcie (sprint 3: soczewka pod obciążeniem).
// `guard(cmd, f)`: kolejka maszyny dla komendy ciężkiej (z powtórką w tej samej dzierżawie).
// K5 D-12: the command's program was not found (an environment problem, not red tests): exit 9009 (cmd.exe) or 127 (sh);
// exit -1 with ENOENT (the configured shell is missing); exit 3 with cmd's "path not found" text (English or Polish,
// because cmd is localised). Test runners do not use 9009 or 127 for failing tests (plan A-5).
// `cmd /c <missing>` exits 1, not 9009 (9009 is the ERRORLEVEL inside a batch file): exit 1 counts only when the first
// output line is cmd's own "not recognized" message (English or Polish), so a red test with exit 1 stays red.
const NOT_RECOGNIZED = /is not recognized as an internal or external command|nie jest rozpoznawane jako polecenie wewnętrzne lub zewnętrzne/i;
export function programNotFound({ exit, output = '' } = {}) {
  if (exit === 9009 || exit === 127) return true;
  if (exit === 1 && NOT_RECOGNIZED.test(String(output).split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '')) return true;
  if (exit === -1 && /ENOENT/.test(String(output))) return true;
  return exit === 3 && /cannot find the path specified|nie może odnaleźć określonej ścieżki/i.test(String(output));
}
const notFoundText = (r) => `program not found: ${r.cmd}: ${String(r.output ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.slice(0, 200) ?? `exit ${r.exit}`}`;

export function verifyCommands(cmds, cwd, cfg, onEach = null, guard = (c, f) => f()) {
  const sh = cfg.verify?.shell || null;
  const results = cmds.map((c) => guard(c, () => {
    const r = runCommand(c, cwd, sh);
    onEach?.(r);
    if (r.exit === 0 || cfg.verify?.rerunRed === false || programNotFound(r)) return r;
    const again = runCommand(c, cwd, sh);
    onEach?.(again);
    return again.exit === 0 ? { ...again, ms: r.ms + again.ms, flaky: { exit: r.exit, output: r.output } } : { ...again, ms: r.ms + again.ms };
  }));
  const body = [];
  for (const r of results.filter((x) => x.flaky)) {
    const t = trimOutput(r.flaky.output, 20);
    body.push(`## \`${r.cmd}\` (flaky: exit ${r.flaky.exit}, then 0 on rerun)`, '', '```text', ...(t.dropped ? [`… (${t.dropped} linii wcześniej)`] : []), ...t.lines, '```', '');
  }
  for (const r of results.filter((x) => x.exit !== 0)) {
    const t = trimOutput(r.output);
    body.push(`## \`${r.cmd}\` (exit ${r.exit})`, '', '```text', ...(t.dropped ? [`… (${t.dropped} linii wcześniej)`] : []), ...t.lines, '```', '');
    const { rerunCmd, failedFileRegex, rerunFailedIndividually } = cfg.verify;
    if (rerunFailedIndividually && rerunCmd && failedFileRegex) {
      const files = redFiles(r.output, failedFileRegex, cwd).slice(0, 5);
      for (const f of files) {
        const rr = runCommand(rerunCmd.replace('{file}', `"${f}"`), cwd, sh);
        body.push(`### Powtórka pojedynczo: \`${f}\` (exit ${rr.exit})`, '', '```text', ...trimOutput(rr.output, 20).lines, '```', '');
      }
    }
  }
  const result = !results.length ? 'none' : results.every((r) => r.exit === 0) ? 'pass' : 'fail';
  return { result, results, flaky: results.filter((r) => r.flaky).map((r) => r.cmd), body: body.join('\n') };
}

// Środowisko przed verify (compose wyłączony → wykonawca PARTIAL i wznowienie za 0,31 mln).
// Sprawdzenie z `for` biegnie tylko, gdy któraś komenda pasuje; bez `cmds` (preflight) biegną wszystkie.
export function envProblems(top, cfg, cmds = null) {
  return envCheck(top, cfg, cmds, false).problems;
}

// v2.6 (§5.8): niegotowe sprawdzenie z `up` uruchamia `up` raz na wywołanie i sprawdza ponownie; `envUp` mówi, co ruszyło.
export function envCheck(top, cfg, cmds = null, up = true) {
  const sh = cfg.verify?.shell || null;
  const ok = (c) => runCommand(c.cmd, top, sh).exit === 0;
  const failing = asList(cfg.env?.checks).filter((c) => !cmds || !c.for || cmds.some((x) => new RegExp(c.for).test(x))).filter((c) => !ok(c));
  const envUp = [];
  const problems = [];
  for (const c of failing) {
    if (up && c.up && !envUp.some((u) => u.cmd === c.up)) {
      const r = runCommand(c.up, top, sh);
      envUp.push({ cmd: c.up, exit: r.exit });
      if (ok(c)) continue;
    } else if (up && c.up && ok(c)) continue;
    problems.push(c.hint || `sprawdzenie środowiska nie przeszło: ${c.cmd}`);
  }
  return { problems, envUp };
}

// v2.10: komunikat dla człowieka o zajętym porcie: co się stało i czego potrzeba.
export function busyPortText(b, lang = 'en') {
  const who = b.pid ? ` (pid ${b.pid}${b.cmd ? `: ${String(b.cmd).slice(0, 160)}` : ''})` : '';
  return String(lang).toLowerCase().startsWith('pl')
    ? `Port ${b.port} jest zajęty przez inny proces${who}, więc ciężkie testy nie ruszyły. Potrzeba: zatrzymaj ten proces albo zwolnij port, potem ponów.`
    : `Port ${b.port} is taken by another process${who}, so the heavy tests did not start. Needed: stop that process or free the port, then retry.`;
}

// Komendy briefu plus `verify.targeted` z configu: brief zna zakres zadania, config zna strażników projektu (E3).
export const targetedCommands = (briefVerify, cfgTargeted) => [...new Set([...asList(briefVerify), ...asList(cfgTargeted)])];

// git.rebase = review (D1): przed pierwszą recenzją commit roboczy, rebase na cel i nowy punkt odniesienia diffu,
// żeby testy celowane i recenzja widziały zmianę na aktualnym celu.
// Zadanie k > 1: punktem odniesienia jest commit zadania k−1, który po rebase ma nowy hash (commity zadania liczymy przed).
function rebaseForReview(top, run, ctx) {
  const { t } = ctx;
  const current = git(['branch', '--show-current'], { cwd: top });
  if (current !== run.branch) throw new Error(`bieżąca gałąź to ${current || 'detached HEAD'}, a nie ${run.branch}`);
  if (dirty(top).length) {
    git(['add', '-A'], { cwd: top });
    commitWith(top, `dwmt wip: ${run.run}${ctx.legacy ? '' : ` T-${ctx.k}`} (round 1, before review)\n`);
  }
  const rb = gitRaw(['rebase', run.target], { cwd: top });
  if (rb.status !== 0) {
    const files = git(['diff', '--name-only', '--diff-filter=U'], { cwd: top }).split(/\r?\n/).filter(Boolean);
    gitRaw(['rebase', '--abort'], { cwd: top });
    return { ok: false, status: 'conflict', files, hint: `rozwiąż konflikt: git rebase ${run.target}, potem ponownie verify` };
  }
  if (!ctx.legacy) remapCommits(top, run);
  t.baseline = ctx.k > 1 ? run.tasks.find((x) => x.k === ctx.k - 1).commit : git(['merge-base', run.target, 'HEAD'], { cwd: top });
  t.rebased = git(['rev-parse', 'HEAD'], { cwd: top });
  saveRun(top, run);
  return null;
}

// Commity zadań po rebase: po stopce `dwmt-run: <run> T-k` w opisie.
export function remapCommits(top, run) {
  const log = git(['log', '--format=%H%x1f%B%x1e', `${run.target}..HEAD`], { cwd: top });
  for (const rec of log.split('\x1e')) {
    const [hash, body] = rec.trim().split('\x1f');
    const k = new RegExp(`^dwmt-run: ${esc(run.run)} T-(\\d+)$`, 'm').exec(body ?? '')?.[1];
    const t = k && run.tasks.find((x) => x.k === Number(k));
    if (t && t.commit) t.commit = hash;
    // v2.8: commit rundy zbiorczej ma stopkę `dwmt-run: <run> batch`.
    if (run.batch?.commit && new RegExp(`^dwmt-run: ${esc(run.run)} batch$`, 'm').test(body ?? '')) run.batch.commit = hash;
  }
}


// K5 D-5: the modules of the finish suite. `changed` null = every module (rerun of red commands); otherwise the modules
// whose glob matches a changed file, or all of them when a changed code file (`isCode`) is outside every module.
// Labels: the name, else the globs. → {cmds, ran, skipped, all}.
const moduleLabel = (m) => m?.name ?? asList(m?.glob).join(', ');
export function moduleSuite(modules, changed, isCode = () => false) {
  const list = asList(modules).map((m) => ({ m, res: asList(m?.glob).map((g) => globToRegExp(String(g))) }));
  const inside = (f, x) => x.res.some((r) => r.test(f));
  const outside = changed == null || changed.some((f) => isCode(f) && !list.some((x) => inside(f, x)));
  const ran = outside ? list : list.filter((x) => changed.some((f) => inside(f, x)));
  return { cmds: [...new Set(ran.flatMap((x) => asList(x.m.full)))], ran: ran.map((x) => moduleLabel(x.m)), skipped: list.filter((x) => !ran.includes(x)).map((x) => moduleLabel(x.m)), all: outside };
}
const prevModules = (run) => run.fullVerify?.modules ?? null;
export function cmdVerify(top, id, opts) {
  const run = loadRun(top, id);
  const root = runDir(top, id);
  const cfg = loadConfig(top);
  if (!opts.full && !isLegacy(run)) splitReviews(top, root, run, cfg, taskCtx(root, run));
  // v2.8: w rundzie zbiorczej verify działa na jej katalogu i stanie (bez rebase rundy 1 i bez planu zadania).
  const inBatch = !opts.full && !isLegacy(run) && !!computeState(root, run, cfg).batch;
  const ctx = inBatch ? batchCtx(root, run) : taskCtx(root, run);
  const { t } = ctx;
  const dir = opts.full ? root : ctx.dir;
  // kt (D-13): the closing verify runs the whole list once more before the commit (no rebase, no selection).
  const closing = !opts.full && !ctx.legacy && computeState(root, run, cfg).closing === true;
  // Zepsuty nagłówek planu zadania dawał verify bez komend na zielono: najpierw state (architekt poprawia plan).
  const planHead = opts.full || inBatch ? null : tryHeader(join(dir, 'brief.md'));
  if (!opts.full && !inBatch && (!planHead || (planHead.errors && !Array.isArray(planHead.verify)))) {
    return { ok: false, result: 'plan', errors: asList(planHead?.errors ?? ['brak brief.md']).slice(0, 5), hint: 'nagłówek planu zadania niepoprawny: uruchom state (poprawka planu), potem verify' };
  }
  if (!opts.full && !inBatch && !closing && cfg.git.rebase === 'review' && computeState(root, run, cfg).round === 1) {
    const conflict = rebaseForReview(top, run, ctx);
    if (conflict) return conflict;
  }
  // Pełna suita bez `verify.full` w configu: komendy briefów wszystkich zadań. Runda zbiorcza: suma bieżących komend
  // zadań, do których należą pozycje (bez powtórzeń, w kolejności zadań).
  const brief = opts.full
    ? { verify: [...new Set(allTasks(root, run).flatMap((c) => asList(tryHeader(join(c.dir, 'brief.md'))?.verify)))] }
    : inBatch ? { verify: batchVerify(root, run) } : tryHeader(join(dir, 'brief.md')) || {};
  const round = computeState(root, run, cfg).round;
  const risksUi = opts.full || !cfg.ui ? [] : inBatch ? batchUiRisks(root, run, uiRisks)
    : existsSync(join(dir, 'brief.md')) ? uiRisks(read(join(dir, 'brief.md'))) : [];
  const shotsDir = join(uiDir(dir), `r${round}`);
  if (risksUi.length) rmSync(shotsDir, { recursive: true, force: true });
  const shotsRoot = risksUi.length ? resolve(top, cfg.ui.shots) : null;
  const e2e = opts.full ? e2eChangedCommand(top, run, cfg) : null;
  // K5 D-5: with `verify.modules` the full suite is `verify.full` (cross-module and contract tests, no fallback to the
  // task plans) plus the modules the sprint changed; a rerun of red commands (`only`) picks from every module.
  const modules = opts.full && asList(cfg.verify.modules).length
    ? (opts.only ? moduleSuite(cfg.verify.modules, null) : moduleSuite(cfg.verify.modules, sprintChangedFiles(top, run, { deleted: true }), codeMatcher(cfg, productConfig(top, cfg))))
    : null;
  const all = opts.full
    ? [...new Set([...(modules ? asList(cfg.verify.full) : asList(cfg.verify.full).length ? asList(cfg.verify.full) : asList(brief.verify)), ...(modules?.cmds ?? []), ...(e2e ? [e2e.cmd] : [])])]
    : targetedCommands(brief.verify, cfg.verify.targeted);
  let cmds = opts.only ? all.filter((c) => opts.only.includes(c)) : all;
  // Recenzja nocy 2026-10-05: komenda e2e niesie listę plików, więc po zmianie plików e2e jej tekst nie pasuje do `failed`
  // poprzedniego finish. Biegnie znowu, gdy była czerwona albo się zmieniła; pusta lista powtórki = cała pełna suita.
  if (opts.full && opts.only) {
    const prevE2e = run.fullVerify?.e2eCmd ?? null;
    if (e2e && !cmds.includes(e2e.cmd) && (prevE2e !== e2e.cmd || opts.only.includes(prevE2e))) cmds.push(e2e.cmd);
    if (!cmds.length) cmds = all;
  }
  const { problems: env, envUp } = envCheck(top, cfg, cmds);
  const upOut = envUp.length ? { envUp: envUp.map((u) => `${u.exit} ${u.cmd}`) } : {};
  const envOut = (problems, hint = null) => {
    if (!opts.full && !ctx.legacy) writeStatus(top, run, 'waiting-user', { questions: problems, affects: 'none', stage: 'implementation', reason: 'env' });
    if (!opts.full) runEvent(top, run, 'question-waiting', { detail: { step: 'verify', reason: 'env', env: problems } });
    return { ok: false, result: 'env', env: problems, ...upOut, hint: hint ?? 'środowisko nie jest gotowe: pokaż env użytkownikowi, po przygotowaniu ponów (to nie czerwień testów)' };
  };
  // Kolejka maszyny (S1a): pełna suita w jednej dzierżawie, w rundach tylko komendy z `verify.heavy`.
  const meta = (cmd) => ({ who: `${basename(top)} ${id} ${opts.full ? 'finish' : `verify r${round}`}`, cmd, project: basename(top), run: id });
  const heavy = cfg.verify.heavy ? new RegExp(cfg.verify.heavy) : null;
  // v2.10 (C): porty komend (`verify.ports`) zajęte przez inny proces → `env` z jego PID i linią polecenia. Komenda z kolejki
  // maszyny sprawdza porty dopiero w dzierżawie (ten sam port w dwóch projektach: kolejka je szereguje, nie pytanie).
  const portRules = asList(cfg.verify.ports);
  const busyOf = (cs) => (portRules.length ? busyPorts(cs, portRules).map((b) => busyPortText(b, cfg.language)) : []);
  if (!opts.full) env.push(...busyOf(cmds.filter((c) => !heavy?.test(c))));
  if (env.length) return envOut(env);
  const portBusy = { busy: null };
  const ports = (cs) => { const b = busyOf(cs); if (b.length) { portBusy.busy = b; throw portBusy; } };
  // kt (D-4, D-9): a later verify of the task (or batch round) reruns only red or changed test files and carries green
  // commands; the closing verify and rounds with UI risks run the whole list (D-13).
  const whole = (cs) => ({ selection: cs.map((c) => ({ cmd: c, mode: 'run', runs: [c], files: [] })), changedUnrun: [], runs: cs });
  let sel = null;
  if (!opts.full && !ctx.legacy && t.lastVerify && !closing && !risksUi.length) {
    const cur = snapshotTree(top);
    const d = gitRaw(['diff', '--name-only', '--diff-filter=AMR', t.lastVerify.tree, cur], { cwd: top });
    if (d.status === 0) {
      sel = selectRuns({
        cmds, prev: asList(t.lastVerify.commands), changed: d.stdout.split(/\r?\n/).filter(Boolean),
        testGlob: cfg.verify.testFiles, rerunCmd: cfg.verify.rerunCmd, top: fwd(top),
      });
    }
  }
  sel ??= whole(cmds);
  const queued = [];
  const lease = (cmd, f) => heavyLease(meta(cmd), (l) => { if (l.behind) queued.push({ cmd, waitMs: l.waitMs, behind: l.behind }); return f(); });
  // A: zrzuty komendy e2e pełnej suity do `ui/finish` katalogu przebiegu (kroki UAT odsyłają do nich; worktree znika).
  const finishShots = e2e && cfg.ui?.shots ? resolve(top, cfg.ui.shots) : null;
  const collect0 = shotsRoot ? (r) => collectShots(shotsRoot, r.t0, shotsDir)
    : finishShots ? (r) => { if (r.cmd === e2e.cmd) collectShots(finishShots, r.t0, join(uiDir(root), 'finish')); } : null;
  // v2.10: po każdej komendzie odświeżenie rekordu `active.json` (przyrost dla `dwmt watch`).
  const collect = (r) => { collect0?.(r); touchActive(root, r.cmd); };
  let v;
  try {
    v = opts.full && cmds.length
      ? lease(cmds.join(' && '), () => { ports(cmds); return verifyCommands(cmds, top, cfg, collect); })
      : verifyCommands(sel.runs, top, cfg, collect, (c, f) => (heavy?.test(c) ? { ...lease(c, () => { ports([c]); return f(); }), heavy: true } : f()));
  } catch (e) {
    if (e !== portBusy) throw e;
    return envOut(portBusy.busy);
  }
  // K5 D-12: a missing program is the environment's problem: no repair, the tests file stays as it was.
  const notFound = v.results.filter(programNotFound);
  if (notFound.length) {
    return envOut(notFound.map(notFoundText), 'program not found: install it or prepare the worktree (supervisor.worktreeSetup in .claude/dwmt.json, e.g. a junction to node_modules or a virtualenv), then retry; this is not a red test');
  }
  let merged = null;
  if (!opts.full) {
    const prevBy = new Map(asList(t.lastVerify?.commands).map((c) => [c.cmd, c]));
    merged = mergeResults(sel.selection, v.results, prevBy, cfg.verify.failedFileRegex, fwd(top));
    v.results = merged.entries;
    v.result = !v.results.length ? 'none' : v.results.every((r) => r.exit === 0) ? 'pass' : 'fail';
    v.flaky = v.results.filter((r) => r.flaky).map((r) => r.cmd);
  }
  const queueMs = queued.reduce((a, q) => a + q.waitMs, 0);
  if (queued.length) v.body = [`Kolejka maszyny: ${queued.map((q) => `${Math.round(q.waitMs / 1000)} s za ${q.behind}`).join('; ')}.`, '', v.body].join('\n');
  let ui;
  if (risksUi.length) {
    const pairs = prepareUi(top, dir, cfg, round, risksUi);
    const missing = pairs.filter((x) => !x.shot);
    if (missing.length) {
      // Brak zrzutu to praca wykonawcy (test e2e z `capture`), więc runda jest czerwona.
      v.results.push({ cmd: 'dwmt ui: screenshots', exit: 1, ms: 0 });
      v.result = 'fail';
      v.body += [`## \`dwmt ui: screenshots\` (exit 1)`, '', ...missing.map((x) => `- ${x.id}: no screenshot \`${x.shotName}\` under \`${cfg.ui.shots}\` from this round's commands; an e2e test run by \`verify\` must capture it.`), '', ''].join('\n');
    }
    writeCompare(dir, pairs);
    ui = { pairs: pairs.length, missing: missing.map((x) => `${x.id} ${x.shotName}`), renderErrors: pairs.filter((x) => x.mockupError).map((x) => `${x.id}: ${x.mockupError}`) };
  }
  // K4 (D-7, D-23): kontrole skryptu po kroku wykonawcy (2.11 z planem sprintu, nie verify zamykające): nowe trafienie
  // przy niewykorzystanej naprawie rundy to czerwień pseudo-komendy (jak brak zrzutu), odesłana raz; reszta idzie do recenzji.
  const realFail = v.result === 'fail';
  let checks = null;
  if (!opts.full && !closing && oneSource(run, root) && cfg.scriptChecks?.enabled !== false) {
    checks = applyChecks(t, round, runScriptChecks(top, ctx, cfg));
    if (checks.red) { v.results.push({ cmd: CHECK_CMD, exit: 1, ms: 0 }); v.result = 'fail'; }
    v.body += checks.body;
  }
  const kind = opts.full ? 'full' : 'targeted';
  const file = join(dir, opts.full ? 'tests-full.md' : 'tests.md');
  const header = {
    schema: 'dwmt/tests@1', run: id, round, kind, result: v.result,
    commands: v.results.map(({ cmd, exit, ms, flaky, heavy: h, narrowed, ran, carried }) => ({
      cmd, exit, ms, ...(flaky ? { flaky: true } : {}), ...(h ? { heavy: true } : {}),
      ...(narrowed ? { narrowed } : {}), ...(ran ? { ran } : {}), ...(carried ? { carried: true } : {}),
    })), ...(v.flaky.length ? { flaky: v.flaky } : {}),
    ...(opts.full || v.results.some((r) => r.heavy) ? { queueMs } : {}),
    ...(merged && !ctx.legacy ? { whole: merged.whole } : {}), ...(closing ? { closing: true } : {}), ...(sel.changedUnrun.length ? { changedUnrun: sel.changedUnrun } : {}),
    ...(modules && !opts.only ? { modules: { ran: modules.ran, skipped: modules.skipped } } : {}),
  };
  const modLine = modules && !opts.only ? `Modules: ran ${modules.ran.join('; ') || 'none'}; skipped ${modules.skipped.join('; ') || 'none'}.\n\n` : '';
  writeFileSync(file, withHeader(header, `\n# Testy (${kind}, runda ${round})\n\n${modLine}${v.body || 'Wszystkie komendy zielone.\n'}`));
  // D2: pierwsza czerwień rundy wraca do wykonawcy (state → repair); druga idzie do recenzji.
  let repair = false;
  // v2.9: czerwień, którą plan zapowiada (`expectedRed` planu zadania, np. klient wygenerowany dopiero w późniejszym zadaniu)
  // albo którą wykonawca przypisał innej przyczynie w wyniku rundy (`unrelatedRed`, np. czerwień już na bazie), nie idzie
  // do naprawy: recenzja sprawdza te twierdzenia (sprinty 6+7: 4 naprawy bez zmiany kodu).
  // Przegląd sprintu 16 (UI): także czerwień znana z zatwierdzonych wcześniej zadań (`known-red.mjs`), również w rundzie zbiorczej.
  let expected = null;
  if (!opts.full && v.result === 'fail' && !ctx.legacy && is29(run)) {
    // K4 (D-23): pseudo-komenda kontroli nie pasuje do żadnego twierdzenia (expectedRed, unrelatedRed, znana czerwień).
    const failed = v.results.filter((r) => r.exit !== 0 && r.cmd !== CHECK_CMD).map((r) => r.cmd);
    const res = tryHeader(join(dir, `result-${round}.md`));
    const known = knownRedClaims(knownRed(root, run, inBatch ? Infinity : ctx.k));
    const claims = [...(inBatch ? [] : asList(brief.expectedRed)), ...asList(res?.unrelatedRed), ...known];
    if (failed.length && !checks?.red && failed.every((c) => claims.some((x) => redClaimMatches(x, c)))) expected = failed;
  }
  if (opts.full) {
    const failed = v.results.filter((r) => r.exit !== 0).map((r) => r.cmd);
    const tree = git(['rev-parse', 'HEAD^{tree}'], { cwd: top });
    // K5 D-17: red test files per failed command (the known-red units); D-5: modules run and skipped.
    const red = {};
    if (cfg.verify.failedFileRegex) for (const r of v.results.filter((x) => x.exit !== 0)) { const fs = redFiles(r.output ?? '', cfg.verify.failedFileRegex, fwd(top)); if (fs.length) red[r.cmd] = fs; }
    run.fullVerify = {
      result: v.result, at: new Date().toISOString(), base: opts.base ?? null, tree, failed, ran: v.results.map((r) => r.cmd), ...(Object.keys(red).length ? { red } : {}),
      ...(v.flaky.length ? { flaky: v.flaky } : {}), ...(opts.only ? { rerun: cmds } : {}), ...(e2e ? { e2e: e2e.files, e2eCmd: e2e.cmd } : {}),
      ...(modules && !opts.only ? { modules: { ran: modules.ran, skipped: modules.skipped } } : opts.only && prevModules(run) ? { modules: prevModules(run) } : {}),
    };
  } else if (v.result === 'fail' && !t.repairs?.[round] && !expected && !(closing && t.accepted)) {
    // Batch F-2: a closing red after `commit --accept` books no repair (state commits it, the user accepted).
    t.repairs = { ...t.repairs, [round]: new Date().toISOString() };
    repair = true;
  } else t.verified = Math.max(t.verified, round);
  // kt (D-9, D-13): the last executed verify and the last whole-list run, with the tree after the commands.
  if (merged && !ctx.legacy) {
    const tree = snapshotTree(top);
    const at = new Date().toISOString();
    t.lastVerify = { round, tree, whole: merged.whole, closing, at, commands: v.results.filter((r) => cmds.includes(r.cmd)).map(({ cmd, exit, red }) => ({ cmd, exit, red: asList(red) })) };
    if (merged.whole) t.whole = { tree, round, closing, ok: !realFail || !!expected, repair, at };
    if (closing) t.closingRuns = { ...t.closingRuns, [round]: (t.closingRuns?.[round] ?? 0) + 1 };
  }
  saveRun(top, run);
  if (!opts.full && !ctx.legacy) writeStatus(top, run, 'running', { step: inBatch ? 'batch' : 'verify', ...(inBatch ? { batchStep: 'verify' } : {}), round, result: v.result });
  if (v.result === 'fail') runEvent(top, run, 'command-red', { detail: { kind, round, ...(inBatch ? { batch: true } : {}), commands: v.results.filter((r) => r.exit !== 0).map((r) => r.cmd), ...(expected ? { expected: true } : {}) } });
  return {
    ok: v.result !== 'fail', result: v.result, round, commands: header.commands.map(({ cmd, exit, flaky, carried, narrowed }) => `${exit} ${cmd}${flaky ? ' (flaky)' : ''}${carried ? ' (carried)' : ''}${narrowed ? ` (narrowed: ${narrowed.join(', ')})` : ''}`), file: fwd(file), ui, ...upOut,
    ...(closing ? { closing: true } : {}),
    ...(checks && t.checks?.[round]?.hits.length ? { scriptChecks: t.checks[round].hits.map((h) => `${h.kind}: ${h.file}`) } : {}),
    ...(header.commands.some((c) => c.carried) ? { carried: header.commands.filter((c) => c.carried).length } : {}),
    ...(header.commands.some((c) => c.narrowed) ? { narrowed: header.commands.filter((c) => c.narrowed).length } : {}),
    ...(queueMs ? { queue: `${Math.round(queueMs / 1000)} s w kolejce maszyny` } : {}),
    ...(repair ? { repair: true, hint: 'czerwone testy celowane: state (jedna naprawa przed recenzją), bez review-input' } : {}),
    ...(expected ? { expectedRed: expected, hint: 'czerwień zapowiedziana w planie albo przypisana innej przyczynie: bez naprawy, review-input (recenzja sprawdzi)' } : {}),
  };
}

// A (noc 2026-10-05): komenda e2e plików dodanych albo zmienionych przez sprint (`verify.e2eChanged`), null bez nich.
// Zakres: od merge-base z gałęzią docelową (po rebase przy finish to sama praca sprintu), bez plików usuniętych.
export function e2eChangedFiles(top, run, cfg) {
  const e = cfg.verify?.e2eChanged;
  if (!e?.glob || !e?.cmd) return [];
  const re = globToRegExp(e.glob);
  return sprintChangedFiles(top, run).filter((f) => re.test(f));
}
export function e2eChangedCommand(top, run, cfg) {
  const files = e2eChangedFiles(top, run, cfg);
  if (!files.length) return null;
  const strip = cfg.verify.e2eChanged.strip ?? '';
  const rel = files.map((f) => (strip && f.startsWith(strip) ? f.slice(strip.length) : f));
  return { files, cmd: String(cfg.verify.e2eChanged.cmd).replace('{files}', rel.join(' ')) };
}

// v2.9: wpis `expectedRed` / `unrelatedRed` dotyczy czerwonej komendy `cmd`: komenda w backtickach dokładnie, albo wpis
// zaczyna się całą komendą, po której jest koniec, spacja albo dwukropek. Bez przedrostków w drugą stronę (recenzja v2.9:
// wpis o `npx vitest run a.test.ts` nie może pokryć czerwonego `npx vitest run`, a `--grep "Invoices: list"` innego grepu).
export function redClaimMatches(x, cmd) {
  const s = String(typeof x === 'string' ? x : x?.cmd ?? '').trim();
  const tick = /^`([^`]+)`/.exec(s);
  if (tick) return tick[1].trim() === cmd;
  return s.startsWith(cmd) && (s.length === cmd.length || s[cmd.length] === ':');
}

// v2.9: komenda z wpisu `expectedRed` / `unrelatedRed` („<komenda>: <powód>”, komenda może być w backtickach).
export function redClaimCmd(x) {
  const s = String(typeof x === 'string' ? x : x?.cmd ?? JSON.stringify(x)).trim();
  const tick = /^`([^`]+)`/.exec(s);
  return (tick ? tick[1] : s.split(/:\s/)[0]).trim() || null;
}
