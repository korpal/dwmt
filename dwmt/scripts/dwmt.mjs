#!/usr/bin/env node
// dwmt: mechanika przebiegu (stan, testy, diff, git). Specyfikacja: specyfikacja-dwmt.md §5–§8.
// Wyjście każdej komendy: JSON (≤ 20 linii) albo tekst sekcji. Błąd: {"ok": false, "error": …} i kod 1.
// Windows (capabilities.md T13): parsery \r?\n, komendy weryfikacji jednym stringiem z shell: true,
// git bez shella z tablicą argumentów, JAVA_TOOL_OPTIONS z UTF-8, filtr szumu LF/CRLF.
// Ten plik: CLI (parsowanie argumentów i `switch` komend); mechanika w scripts/lib/*.mjs. Nazwy eksportowane wcześniej
// stąd (hooki, uat.mjs, plan.mjs, batch.mjs, drive.mjs, testy) zostają dostępne przez re-eksport.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { heavyMain, status as queueStatus, machineConfig, home as machineHome } from './machine.mjs';
import { withActive, stopCommand } from './watch.mjs';
import { uatMain, uatSummary } from './uat.mjs';
import { fwd, read, printJson } from './lib/util.mjs';
import { cmdSetup, cmdPreflight, cmdInit, cmdImportPlan } from './lib/setup.mjs';
import { readHeader, validateHeader, section } from './lib/headers.mjs';
import { namedSection } from './lib/risks.mjs';
import { topOf, enableGitMemo } from './lib/git.mjs';
import { checkedRunDir, runTop } from './lib/run.mjs';
import { cmdDeleteConsent } from './lib/deletes.mjs';
import { cmdState, cmdExtend, cmdReplanDone, cmdUnblock } from './lib/state.mjs';
import { cmdSessionsAdd, cmdLaunch } from './lib/sessions.mjs';
import { watchLaunch } from './lib/launch-watch.mjs';
import { cmdVerify } from './lib/verify.mjs';
import { cmdDiff, cmdReviewInput } from './lib/review.mjs';
import { cmdCommit } from './lib/commit.mjs';
import { cmdFinish } from './lib/finish.mjs';
import { cmdFinishRepair } from './lib/finish-repair.mjs';
import { cmdPriceAlert } from './lib/price-alert.mjs';
import { cmdStatus, cmdWatch, cmdWait, cmdDriveMode, cmdDriveLog } from './lib/status.mjs';
import { productMain, parseOpts } from './product.mjs';
import { cmdPrice } from './lib/price.mjs';
import { liveMain } from './lib/live.mjs';

export { ROOT } from './lib/util.mjs';
export { TEMPLATE_VERSION, configHash, renderAgents, checkAgents, slugify } from './lib/setup.mjs';
export { splitHeader, parseFlow, parseYaml, emitYaml, withHeader, readHeader, validateHeader, normalizeLists, tryHeader, section } from './lib/headers.mjs';
export { globToRegExp, LENSES, pickLenses, trimOutput } from './lib/text.mjs';
export {
  WEIGHTS, METHODS, parseRisks, verifyCommandErrors, deleteErrors, briefErrors, answeredIds, namedSection, acIds, parseTasks, uatScenario, uatNone,
  planErrors, planUnits, splitPatch, maxFinding, unitFindings, worstById, mergeReviews,
} from './lib/risks.mjs';
export { git, topOf, worktreeFor } from './lib/git.mjs';
export { DEFAULTS, REBASE, stripJsonComments, aliasRoles, loadConfig } from './lib/config.mjs';
export { runDir, taskDir, loadRun, isLegacy, newTask, taskCtx, sprintCount, allTasks, mainTreeOf, runHome, contextHome, writeStatus, runEvent } from './lib/run.mjs';
export { planDeletes, pendingDeletes, deletePathError } from './lib/deletes.mjs';
export { computeState, reviewPassed, fixNow } from './lib/state.mjs';
export { tryTaskBrief, planInfo, questionState, planEnv, sprintExtras } from './lib/plan-state.mjs';
export { transcriptLimit, sessionsCost, stopEarlierSessions, leanPlugins, sessionName } from './lib/sessions.mjs';
export { uiRisks, collectShots, matchShot } from './lib/ui.mjs';
export { shellName, runCommand, verifyCommands, envProblems, envCheck, busyPortText, targetedCommands, redClaimMatches, redClaimCmd } from './lib/verify.mjs';
export { snapshotTree, sweepChecks, isDocsOnly, reviewerFor, bullets, resultFiles, reportedPaths, diffParts } from './lib/review.mjs';
export { deferredEntries, isMet } from './lib/report.mjs';
export { mergeKey, archive, cleanupOf } from './lib/finish.mjs';
export { activeRuns } from './lib/status.mjs';

// ---------- CLI ----------

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') && ['run', 'slug', 'mode', 'input', 'sprint', 'reason', 'result', 'cause', 'interval', 'polls', 'item', 'estimate', 'after', 'lines', 'target', 'out', 'translate', 'attempt'].includes(k)) opts[k] = argv[++i];
      else opts[k] = true;
    } else pos.push(a);
  }
  return { pos, opts };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  // Kolejka maszyny działa także poza repo (ręczne komendy użytkownika).
  if (cmd === 'heavy') { process.exitCode = heavyMain(rest); return; }
  if (cmd === 'queue') return printJson({ ok: true, home: fwd(machineHome()), heavySlots: machineConfig().heavySlots, ...queueStatus() });
  const { pos, opts } = parseArgs(rest);
  // Short CLI process: read-only git lookups are remembered (kt, D-11); long-running loops keep asking git.
  if (!['watch', 'wait', 'live', 'supervise', 'launch-watch'].includes(cmd)) enableGitMemo();
  const top0 = topOf();
  // Tryb A: komendy przebiegu z głównego drzewa trafiają do worktree przebiegu (`init --worktree`).
  const RUN_CMDS = ['state', 'verify', 'diff', 'review-input', 'commit', 'finish', 'delete-consent', 'watch', 'wait', 'stop', 'extend', 'unblock', 'replan-done', 'sessions-add', 'status', 'drive-mode', 'drive-log', 'launch-watch'];
  const top = RUN_CMDS.includes(cmd) && pos[0] ? runTop(top0, pos[0]) : top0;
  const need = (v, what) => { if (!v) throw new Error(`brak argumentu: ${what}`); return v; };
  switch (cmd) {
    case 'setup': return printJson(cmdSetup(top, opts));
    case 'preflight': return printJson(cmdPreflight(top, opts));
    case 'init': return printJson(cmdInit(top, opts));
    case 'import-plan': return printJson(cmdImportPlan(top, pos[0], opts));
    case 'header': {
      const h = readHeader(need(pos[0], 'plik'));
      if (opts.check) { const errors = validateHeader(h); return printJson({ ok: !errors.length, errors }); }
      return printJson(h);
    }
    case 'section': {
      // Identyfikator (Q-n, F-n) albo dokładny tytuł sekcji (UAT w raporcie: dłuższy limit linii).
      const text = read(need(pos[0], 'plik'));
      const named = /^[A-Z]+-\d+$/.test(need(pos[1], 'ID')) ? null : namedSection(text, pos[1]);
      const s = named ?? section(text, pos[1]);
      if (s === null) throw new Error(`brak sekcji ${pos[1]}`);
      return console.log(s.split('\n').slice(0, named ? 150 : 60).join('\n'));
    }
    case 'state': return printJson(cmdState(top, need(pos[0], 'run'), opts));
    // v2.10: verify i finish zapisują PID w `active.json` przebiegu (dla `dwmt watch`).
    case 'verify': return printJson(withActive(checkedRunDir(top, need(pos[0], 'run')), 'verify', () => cmdVerify(top, pos[0], opts)));
    case 'diff': return printJson(cmdDiff(top, need(pos[0], 'run')));
    case 'review-input': return printJson(cmdReviewInput(top, need(pos[0], 'run')));
    case 'commit': return printJson(cmdCommit(top, need(pos[0], 'run'), opts));
    case 'finish': return printJson(withActive(checkedRunDir(top, need(pos[0], 'run')), 'finish', () => cmdFinish(top, pos[0], opts)));
    case 'finish-repair': return printJson(cmdFinishRepair(top, need(pos[0], 'run'), opts));
    case 'price-alert': return printJson(cmdPriceAlert(top, need(pos[0], 'run')));
    case 'delete-consent': return printJson(cmdDeleteConsent(top, need(pos[0], 'run'), opts));
    case 'watch': return cmdWatch(top, need(pos[0], 'run'), opts);
    case 'wait': return cmdWait(top, need(pos[0], 'run'), opts);
    case 'stop': return printJson(stopCommand(checkedRunDir(top, need(pos[0], 'run'))));
    case 'extend': return printJson(cmdExtend(top, need(pos[0], 'run')));
    case 'unblock': return printJson(cmdUnblock(top, need(pos[0], 'run')));
    case 'replan-done': return printJson(cmdReplanDone(top, need(pos[0], 'run'), need(pos[1], 'k'), opts));
    case 'sessions-add': return printJson(cmdSessionsAdd(top, need(pos[0], 'run'), pos.slice(1)));
    case 'launch': return printJson(cmdLaunch(top, need(pos[0], 'run')));
    // K5 D-8: the detached watcher of a launched session (started by `launch`).
    case 'launch-watch': return watchLaunch(top, need(pos[0], 'run'), need(pos[1], 'id'), { attempt: Number(opts.attempt) || 1 }).then(printJson)
      .catch((e) => { printJson({ ok: false, error: e.message }); process.exitCode = 1; });
    case 'drive-mode': return printJson(cmdDriveMode(top, need(pos[0], 'run'), need(pos[1], 'on|off')));
    case 'drive-log': return printJson(cmdDriveLog(top, need(pos[0], 'run'), opts));
    case 'status': return printJson(cmdStatus(top, need(pos[0], 'run'), need(pos[1], 'stan'), opts));
    case 'uat': return printJson(uatMain(top, pos, opts));
    case 'uat-summary': return printJson(uatSummary(top, opts));
    // D4: warstwa produktowa (spec warstwy produktowej §7) i cena projektu (§6.4 pkt 3, działa także bez warstwy).
    case 'product': return productMain(top, rest);
    case 'price': return printJson(cmdPrice(top, parseOpts(rest).opts));
    // S3 (spec supervisora §4.9): komendy supervisora dla PO; pętla `supervise run` to proces w tle.
    case 'supervise': return import('./supervise.mjs').then((m) => m.superviseMain(top, rest)).then((r) => {
      if (typeof r === 'string') console.log(r); else printJson(r);
      if (r && r.ok === false) process.exitCode = 1;
    }).catch((e) => { printJson({ ok: false, error: e.message }); process.exitCode = 1; });
    // Live sprint view (product page): writer loop, one snapshot (`--once [--out dir]`), title translation (child).
    case 'live': return liveMain(top, opts).then((r) => { printJson(r); if (r && r.ok === false) process.exitCode = 1; })
      .catch((e) => { printJson({ ok: false, error: e.message }); process.exitCode = 1; });
    default:
      throw new Error('komendy: heavy [--shell s] -- <komenda> | queue | setup [--check] [--target branch] | preflight --slug s | init --run id [--mode auto|inline|direct|intermediate|single] [--input plik] [--sprint id] [--item B-1,B-2] [--estimate min,max] [--force] | import-plan <plik> --run id | header <plik> [--check] | section <plik> <ID> | state [--peek]|verify [--full]|diff|review-input|commit [--accept]|finish [--accept-red [--reason t]|--cleanup]|extend|unblock|launch <run> | launch-watch <run> <id> [--attempt n] | finish-repair <run> [--done [--session id] [--failed]] | price-alert <run> | delete-consent <run> --yes|--no | watch <run> [--interval s] [--once] [--follow] | wait <run> [--interval s] [--progress [--after ts]] | stop <run> | drive-mode <run> on|off | drive-log <run> [--lines n] | sessions-add <run> <sesja…> | replan-done <run> <k> --result changed|unchanged [--cause plan|discovery|target] | status <run> <stan> [--reason t] | uat list [--all]|start <id…>|record <id…> <plik.json> [--late]|release | uat-summary | product <komenda> | price --files <min,max> [--mode m] | supervise order|status|set|hold|resume|answer|report|close|run | live [--once [--out dir]] [--interval s]');
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { main(process.argv.slice(2)); }
  catch (e) {
    // `watch` pisze na stdout tylko linię przestoju (jej wyjście czyta orkiestrator); błąd idzie na stderr.
    if (process.argv[2] === 'watch') process.stderr.write(`dwmt watch: ${e.message}\n`);
    else printJson({ ok: false, error: e.message });
    process.exitCode = 1;
  }
}
