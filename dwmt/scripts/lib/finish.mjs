// dwmt: `finish` (rebase, squash, scalenie pod blokadą), archiwum przebiegu, sprzątanie gałęzi.
import { writeFileSync, existsSync, mkdirSync, copyFileSync, cpSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { withLease, activeHolds } from '../machine.mjs';
import { is27 } from '../plan.mjs';
import { batchPending } from '../batch.mjs';
import { fwd, asList, samePath, canonPath, ROOT } from './util.mjs';
import { tryHeader } from './headers.mjs';
import { gitRaw, git, dirty, worktreeFor, removeWorktree } from './git.mjs';
import { loadConfig } from './config.mjs';
import { runDir, loadRun, saveRun, isLegacy, sprintCount, allTasks, runHome, writeStatus, runEvent } from './run.mjs';
import { emptyScratch } from './deletes.mjs';
import { planInfo } from './plan-state.mjs';
import { uiDir } from './ui.mjs';
import { remapCommits, cmdVerify } from './verify.mjs';
import { commitMessage, commitWith } from './commit.mjs';
import { writeDeferred, finalReport, openDeferredMajors } from './report.mjs';
import { productConfig } from './product-config.mjs';
import { productRun, productViewRefresh } from '../product.mjs';
import { redUnits, acceptKnownRed, knownRedVerdict, loadKnownRed, dropGreenKnownRed } from './known-red.mjs';
import { paths, loadItems } from './product-store.mjs';
import { findWorkplace, workplaceReady } from './workplace.mjs';

// Blokada scalania na repo (wspólny katalog git, także z worktree) i gałąź docelową: drugi finish czeka,
// a po wejściu robi rebase na świeży cel (§7 specyfikacji supervisora).
export function mergeKey(top, target) {
  // D-15: kanoniczna ścieżka małymi literami na każdej platformie (krótka nazwa 8.3 daje ten sam klucz co dotąd pełna).
  const repo = canonPath(resolve(top, git(['rev-parse', '--git-common-dir'], { cwd: top })));
  return { repo, key: `merge-${createHash('sha256').update(`${repo.toLowerCase()}\n${target}`).digest('hex').slice(0, 12)}` };
}

export function cmdFinish(top, id, opts) {
  const target = loadRun(top, id).target;
  const { repo, key } = mergeKey(top, target);
  let waited = 0;
  const out = withLease(key, { who: `${basename(top)} ${id} finish`, cmd: `merge into ${target}`, project: basename(top), run: id, repo },
    (l) => { waited = l.waitMs; return finishLocked(top, id, opts); },
    { onWait: (ahead) => process.stderr.write(`dwmt: scalanie do ${target} zajęte, czekam za: ${ahead}\n`) });
  // The product view after the intake: with a published page the intake already wrote it in its product commit, under
  // the lease; this is the one refresh after the lease, not committed (with `publish: null` the only write, of the
  // `.dwmt/` page). 0 tokens; a failure is only a warning.
  const view = out?.intake ? productViewRefresh(top) : {};
  return { ...out, ...(waited ? { mergeWaitMs: waited } : {}), ...(view.viewWarning ? { viewWarning: view.viewWarning } : {}) };
}

// Kopia przebiegu w drzewie domowym (§5.7, D-4): statusy, UAT i raporty przeżywają usunięcie worktree sprintu.
export function archive(top, run, only = null) {
  const root = runDir(top, run.run);
  const main = runHome(run, top);
  if (samePath(main, top)) return null;
  const dest = join(main, '.dwmt', 'runs', run.run);
  mkdirSync(dest, { recursive: true });
  // D4 (spec warstwy produktowej §4.5, §6.1): odpowiedzi na pytania sprintu i kontrola celu też w kopii (`intake`, `sync`).
  for (const f of only ?? ['final-report.md', 'plan.md', 'task.md', 'answers.md', 'goal-check.md']) if (existsSync(join(root, f))) copyFileSync(join(root, f), join(dest, f));
  // Kopia run.json wie, gdzie żyje przebieg: hook SessionStart w głównym drzewie nie bierze jej za aktywny przebieg.
  if (!only) writeFileSync(join(dest, 'run.json'), `${JSON.stringify({ ...run, archiveOf: canonPath(top) }, null, 2)}\n`);
  if (!only) {
    for (const c of allTasks(root, run)) {
      const to = c.legacy ? dest : join(dest, 'tasks', String(c.k));
      if (!c.legacy && existsSync(join(c.dir, 'report.md'))) { mkdirSync(to, { recursive: true }); copyFileSync(join(c.dir, 'report.md'), join(to, 'report.md')); }
      if (existsSync(uiDir(c.dir))) cpSync(uiDir(c.dir), join(to, 'ui'), { recursive: true });
    }
    // v2.8: runda zbiorcza (batch.md, wyniki, recenzje, report.md) w kopii przebiegu.
    if (existsSync(join(root, 'batch'))) cpSync(join(root, 'batch'), join(dest, 'batch'), { recursive: true });
  }
  return fwd(dest);
}

// Katalog produktu względem repo (bez `/` na końcu) albo null, gdy warstwy nie ma.
function productDirOf(top) {
  try { const pc = productConfig(top, loadConfig(top)); return pc.present ? fwd(pc.dir).replace(/^\.\//, '').replace(/\/$/, '') : null; } catch { return null; }
}

// D4 (§4.5, P-11): `product intake <run>` przy końcu sprintu; błąd tylko ostrzega. B-7 (D-1, D-3, D-4, D-6): po squashu
// lub leave z `--sync` (roadmapa, pozycje, nagłówek sprintu i strona w tym samym commicie produktu; zmiany w `synced`),
// w merge-wait z `--no-commit` i bez sync; podpowiedź ponowienia powtarza te same flagi.
export function runIntake(top, run) {
  const flags = run.finish?.status === 'merge-wait' ? ['--no-commit'] : ['--sync'];
  try {
    const r = productRun(runHome(run, top), ['intake', run.run, ...flags]);
    if (r?.skipped) return null;
    return { items: asList(r?.items).length, candidates: asList(r?.candidates).length, ...(asList(r?.sync).length ? { synced: r.sync } : {}),
      ...(asList(r?.warnings).length ? { warnings: r.warnings } : {}) };
  } catch (e) { return { warning: `product intake: ${e.message}; rerun: dwmt product intake ${run.run} ${flags.join(' ')}` }; }
}

// K2 (D-4, D-7): warstwa produktowa obecna i włączona (warunek `product intake`, w drzewie, w którym intake działa):
// odłożone uwagi idą do backlogu przez `intake`, nie do pliku odłożonych uwag.
function productActive(top, run) {
  try {
    const main = runHome(run, top);
    const pc = productConfig(main, loadConfig(main));
    return pc.present && pc.enabled && existsSync(pc.abs);
  } catch { return false; }
}

// Kiedy squash nie wchodzi (§5.7 merge-wait): trwa UAT (bilet wstrzymania), drzewo docelowe ma zmiany w plikach śledzonych
// albo nieśledzone pliki tam, gdzie squash dodaje pliki, albo gałąź docelowa nie jest nigdzie wybrana, a finish nie biegnie
// w drzewie domowym przebiegu (D-5, bug 12: tylko tam squash może przełączyć drzewo na cel).
export function mergeWaitReason(top, run, targetDir) {
  const hs = activeHolds(mergeKey(top, run.target).key);
  if (hs.length) return { reason: 'uat', files: [], holds: hs.map((h) => `${h.session}: ${asList(h.sprints).join(', ')} (do ${h.until})`) };
  if (targetDir) {
    // D4 (§12 pkt 3): zmiany w katalogu produktu (zapis PO, `intake`) nie blokują squasha; sprint ich nie dotyka.
    const productDir = productDirOf(top);
    const tracked = git(['status', '--porcelain', '--untracked-files=no'], { cwd: targetDir }).split(/\r?\n/).filter(Boolean).map((l) => l.slice(3))
      .filter((f) => !productDir || !(f === productDir || f.startsWith(`${productDir}/`)));
    const added = git(['diff', '--name-only', '--no-renames', '--diff-filter=A', run.target, run.branch], { cwd: top }).split(/\r?\n/).filter(Boolean)
      .filter((f) => existsSync(join(targetDir, f)));
    if (tracked.length || added.length) return { reason: 'target-dirty', files: [...tracked, ...added].slice(0, 20), targetDir };
    return null;
  }
  const home = runHome(run, top);
  if (!samePath(home, top)) return { reason: 'target-dirty', files: [], detail: `gałąź ${run.target} nie jest wyewidencjonowana w żadnym drzewie, a finish nie biegnie w drzewie domowym ${home}` };
  return null;
}

// K5 D-17: the owner backlog item of an accepted red unit (`product item add`, idempotent through its src). → id or null.
function ownerItem(home, e) {
  const what = String(e.file ?? e.cmd);
  const title = `Red test accepted: ${what.length > 70 ? `…${what.slice(-69)}` : what}`;
  const src = `known-red:${e.key}`;
  const r = productRun(home, ['item', 'add', '--type', 'bug', '--sev', 'minor', '--title', title, '--src', src, ...(e.reason ? ['--note', String(e.reason).slice(0, 280)] : [])]);
  const added = /^B-\d+/.exec(String(asList(r?.added)[0] ?? ''))?.[0] ?? null;
  if (added) return added;
  try {
    const { open, archived } = loadItems(paths(home, productConfig(home, loadConfig(home))));
    return [...open, ...archived].find((x) => x.src === src)?.id ?? null;
  } catch { return null; }
}

// K7 C-3: `{branch, n, cmd}` when the run's workplace is ready to push (every assigned sprint done), else null.
function pushOf(top, run) {
  if (!run.workplace) return null;
  try {
    const home = runHome(run, top);
    const wp = findWorkplace(home, run.workplace);
    const r = wp ? workplaceReady(home, wp) : null;
    return r?.ready ? { branch: r.branch, n: r.n, cmd: r.pushCmd } : null;
  } catch { return null; }
}

function finishLocked(top, id, opts) {
  const run = loadRun(top, id);
  const root = runDir(top, id);
  const cfg = loadConfig(top);
  const legacy = isLegacy(run);
  const now = new Date().toISOString();
  const save = (finish, extra = {}) => {
    run.finish = { ...finish, at: new Date().toISOString() };
    saveRun(top, run);
    const done = ['squashed', 'left'].includes(finish.status);
    if (done || finish.status === 'merge-wait') archive(top, run);
    const intake = done || finish.status === 'merge-wait' ? runIntake(top, run) : null;
    if (intake) extra = { ...extra, intake };
    // K7 C-3: after the intake sync, a squash that completes its workplace says the branch is ready to push.
    const push = finish.status === 'squashed' ? pushOf(top, run) : null;
    if (push) extra = { ...extra, push };
    // v2.10: zdarzenia końca sprintu, UAT czeka, merge-wait i pytania (konflikt, czerwień, środowisko, squash).
    if (done) {
      runEvent(top, run, 'sprint-end', { verdict: finish.result ?? null, costM: finish.cost ?? null, detail: { status: finish.status, commit: finish.commit ?? null, uat: finish.uat ?? null } });
      if (finish.uat === 'pending') runEvent(top, run, 'uat-waiting', { detail: { sprint: run.sprint ?? run.run } });
      emptyScratch(top);
    } else if (finish.status === 'merge-wait') runEvent(top, run, 'merge-wait', { detail: { reason: finish.reason } });
    else runEvent(top, run, 'question-waiting', { detail: { step: 'finish', reason: finish.status } }); // czerwień: command-red z verify
    if (!legacy) {
      if (done) writeStatus(top, run, 'done', { result: finish.result ?? null, cost: finish.cost ?? null, uat: finish.uat ?? null, ...(is27(run) ? { gaps: finish.gaps ?? null } : {}) });
      else if (finish.status === 'merge-wait') writeStatus(top, run, 'merge-wait', { reason: finish.reason, files: finish.files, since: finish.since, base: finish.base });
      else writeStatus(top, run, 'waiting-user', { questions: [extra.hint ?? finish.hint ?? finish.status], affects: 'none', stage: 'implementation', reason: finish.status });
    }
    return { ok: done || finish.status === 'merge-wait', ...finish, ...extra };
  };
  if (opts.cleanup) {
    if (run.finish?.status !== 'squashed') throw new Error('cleanup tylko po squashu');
    const cl = cleanupOf(top, run);
    if (!cl.now) {
      // Przegląd 2026-10-04 (tryb A): worktree przebiegu zostawał po każdym sprincie. Sesja spoza niego (PO w głównym drzewie)
      // usuwa go od razu: najpierw pełna kopia katalogu przebiegu do głównego drzewa (drive.log, testy, recenzje), potem
      // `git worktree remove` bez --force (niezacommitowane zmiany go zatrzymują) i gałąź; dowiązania w worktree (junction
      // node_modules) odpięte przed gitem (F, noc 2026-10-05: git wchodził w junction i opróżniał cel w głównym drzewie).
      let here = null;
      try { here = git(['rev-parse', '--show-toplevel'], { cwd: process.cwd() }); } catch { /* poza repo */ }
      if (!here || samePath(here, cl.at)) return { ok: false, error: `gałąź ${run.branch} jest wybrana w ${cl.at}; po zamknięciu sesji w nim: ${cl.after.join(' && ')}`, cleanup: cl };
      const main = runHome(run, top);
      const dest = join(main, '.dwmt', 'runs', run.run);
      if (!samePath(root, dest)) cpSync(root, dest, { recursive: true });
      archive(top, run);
      const rm = removeWorktree(main, cl.at);
      if (rm.status !== 0) return { ok: false, error: `git worktree remove ${cl.at}: ${(rm.stderr || rm.stdout).trim()}`, archived: fwd(dest), cleanup: cl, ...(rm.unlinked.length ? { unlinked: rm.unlinked } : {}) };
      git(['branch', '-D', run.branch], { cwd: main });
      return { ok: true, deleted: run.branch, worktree: fwd(cl.at), archived: fwd(dest), ...(rm.unlinked.length ? { unlinked: rm.unlinked } : {}) };
    }
    git(['branch', '-D', run.branch], { cwd: top });
    return { ok: true, deleted: run.branch };
  }
  if (['squashed', 'left'].includes(run.finish?.status)) return { ok: true, already: true, ...run.finish };
  const ctxs = allTasks(root, run);
  if (legacy ? !run.commit : run.tasks.length < (run.count ?? sprintCount(root, run)) || ctxs.some((c) => !c.t.commit)) {
    throw new Error(legacy ? 'brak commita przebiegu: najpierw commit' : 'nie wszystkie zadania sprintu są zacommitowane: finish po commicie ostatniego zadania');
  }
  if (!legacy && batchPending(root, run, cfg)) throw new Error('runda zbiorcza nie jest zacommitowana: najpierw state (batch), potem finish');
  // Po nieudanym finish użytkownik mógł scalić ręcznie: cel ma już treść gałęzi przebiegu. Zamknij przebieg bez squasha.
  const exists = (b) => gitRaw(['rev-parse', '--verify', '-q', `refs/heads/${b}`], { cwd: top }).status === 0;
  if (run.finish && exists(run.branch) && exists(run.target) && gitRaw(['diff', '--quiet', run.branch, run.target], { cwd: top }).status === 0) {
    const report = finalReport(top, run, cfg);
    const cleanup = cleanupOf(top, run);
    return save({ status: 'squashed', manual: true, commit: git(['rev-parse', '--short=10', run.target], { cwd: top }), target: run.target, result: report.status, cost: report.cost?.total ?? null, uat: report.uat ?? null, ...(report.gaps != null ? { gaps: report.gaps } : {}) }, {
      report: fwd(join(root, 'final-report.md')), acceptance: report.acceptance, cleanup,
      hint: `${run.target} ma już treść przebiegu (scalenie ręczne); ${cleanupHint(run, cleanup)}`,
    });
  }
  const changed = dirty(top);
  if (changed.length) throw new Error(`drzewo robocze nie jest czyste: ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ` (+${changed.length - 5})` : ''}`);
  if (git(['branch', '--show-current'], { cwd: top }) !== run.branch) throw new Error(`bieżąca gałąź nie jest ${run.branch}`);
  // K2 (D-9): bramka odłożonych uwag major/blocker przed rebase'em (użytkownik nie czeka na pełną suitę). Bez przyjęcia
  // stop `deferred-major` (czeka na użytkownika); `--accept-deferred` zapisuje przyjęcie od razu, więc przeżywa czerwień
  // i merge-wait, a kolejny finish staje tylko na uwagach jeszcze nieprzyjętych.
  // Runda zbiorcza T-2/F-2: `--fixed-deferred` po commicie poprawki na gałęzi przebiegu (od pierwszego zatrzymania,
  // `finish.head`) zamyka wymienione uwagi jako poprawione przez użytkownika: znikają z odłożonych (deferredFindings),
  // raport wymienia je osobno jako niezrecenzowane.
  const majors = openDeferredMajors(top, run, cfg);
  if (majors.length) {
    const head = git(['rev-parse', 'HEAD'], { cwd: top });
    if (opts['fixed-deferred']) {
      if (run.finish?.status !== 'deferred-major' || !run.finish.head) throw new Error('finish --fixed-deferred works only after a deferred-major stop (finish without a flag lists the findings)');
      if (run.finish.head === head) throw new Error(`no commit on the run branch since the stop (${run.finish.head.slice(0, 7)}): commit the fix on ${run.branch} first, then finish --fixed-deferred`);
      run.deferredFixed = { ids: [...asList(run.deferredFixed?.ids), ...majors.map((x) => x.id)], at: now, head };
      saveRun(top, run);
    } else if (opts['accept-deferred']) {
      run.deferredAccepted = { ids: [...asList(run.deferredAccepted?.ids), ...majors.map((x) => x.id)], at: now };
      saveRun(top, run);
    } else {
      const since = run.finish?.status === 'deferred-major' && run.finish.head ? run.finish.head : head;
      return save({ status: 'deferred-major', majors: majors.map((x) => x.text), head: since, hint: `${majors.length} deferred major findings; accept: dwmt finish ${id} --accept-deferred; or fix them, commit on ${run.branch} and run dwmt finish ${id} --fixed-deferred` });
    }
  }
  const rb = cfg.git.rebase === 'none' ? { status: 0 } : gitRaw(['rebase', run.target], { cwd: top });
  if (rb.status !== 0) {
    const files = git(['diff', '--name-only', '--diff-filter=U'], { cwd: top }).split(/\r?\n/).filter(Boolean);
    gitRaw(['rebase', '--abort'], { cwd: top });
    return save({ status: 'conflict', files }, { hint: `rozwiąż konflikt: git rebase ${run.target}, potem ponownie finish` });
  }
  if (legacy) run.commit = git(['rev-parse', 'HEAD'], { cwd: top });
  else remapCommits(top, run);
  saveRun(top, run);
  const base = git(['rev-parse', run.target], { cwd: top });
  const tree = git(['rev-parse', 'HEAD^{tree}'], { cwd: top });
  const prev = run.fullVerify;
  // Ponowny finish po merge-wait: zielona suita na tej samej bazie i tym samym drzewie wystarcza (§5.7).
  // Recenzja S3 (11): baza i drzewo „te same” także wtedy, gdy różnią się tylko katalogiem produktu (commit `intake` przy
  // UAT przesuwa cel w czasie `merge-wait`; pliki produktu nie wchodzą do suity), więc zielona suita zostaje użyta ponownie.
  const pdir = productDirOf(top);
  const alike = (a, b) => {
    if (a === b) return true;
    if (!pdir || !a || !b) return false;
    const d = gitRaw(['diff', '--name-only', a, b], { cwd: top });
    return d.status === 0 && d.stdout.split(/\r?\n/).filter(Boolean).every((f) => f === pdir || f.startsWith(`${pdir}/`));
  };
  const reuse = (prev?.result === 'pass' || !!prev?.accepted) && alike(prev.base, base) && alike(prev.tree, tree);
  // Ponowny finish po czerwieni na tej samej bazie: tylko komendy, które były czerwone (pełny Maven i Vitest to ~25 min).
  const only = prev?.result === 'fail' && alike(prev.base, base) && prev.failed?.length ? prev.failed : null;
  // Przyjęcie czerwieni bez zmian w kodzie od ostatniej suity: nic nie uruchamiaj ponownie (E3: 8 min powtórki tego samego).
  const same = opts['accept-red'] && only && prev.tree === tree;
  const full = reuse ? { result: 'pass', reused: true } : same ? { result: 'fail', file: fwd(join(root, 'tests-full.md')) } : cmdVerify(top, id, { full: true, base, only });
  if (full.result === 'env') return save({ status: 'env' }, { env: full.env, hint: full.hint });
  Object.assign(run, loadRun(top, id));
  // K5 D-17: accepted red lives in the project registry (home tree) with an expiry and an owner item; a later finish
  // continues when every red unit has an unexpired entry, and a unit that passes again loses its entry.
  const home = runHome(run, top);
  const units = full.reused ? [] : redUnits(run.fullVerify);
  if (!full.reused && run.fullVerify) { try { dropGreenKnownRed(home, asList(run.fullVerify.ran), units); } catch { /* registry best effort */ } }
  if (full.result === 'fail' && !full.reused) {
    const brief = (e) => ({ key: e.key, expires: e.expires, item: e.item ?? null });
    if (opts['accept-red']) {
      const product = productActive(top, run);
      const acc = acceptKnownRed(home, units, {
        reason: typeof opts.reason === 'string' ? opts.reason : null, run: id, sprint: run.sprint ?? null, days: cfg.verify?.knownRedDays ?? 7,
        item: product ? (e) => ownerItem(home, e) : () => null,
      });
      run.fullVerify.knownRed = acc.map(brief);
    } else {
      const verdict = knownRedVerdict(loadKnownRed(home), units);
      if (verdict.uncovered.length || verdict.expired.length || !units.length) {
        const exp = verdict.expired.map((e) => `${e.key} (expired ${String(e.expires).slice(0, 10)}${e.item ? `, owner ${e.item}` : ''})`);
        return save({ status: 'red' }, {
          tests: full.file, rerun: only ?? undefined,
          ...(exp.length ? { expired: exp } : {}), ...(verdict.uncovered.length && verdict.covered.length ? { uncovered: verdict.uncovered } : {}),
          hint: `pełna suita czerwona: napraw i ponów finish (powtórzy tylko czerwone komendy) albo, za zgodą użytkownika, finish --accept-red [--reason <tekst>]${exp.length ? `; przyjęta czerwień wygasła: ${exp.join('; ')}` : ''}`,
        });
      }
      run.fullVerify.knownRed = verdict.covered.map(brief);
    }
    run.fullVerify.accepted = run.fullVerify.failed;
  }
  const report = finalReport(top, run, cfg);
  const summary = { result: report.status, cost: report.cost?.total ?? null, uat: report.uat ?? null, ...(report.gaps != null ? { gaps: report.gaps } : {}) };
  const reportOut = { report: fwd(join(root, 'final-report.md')), acceptance: report.acceptance, ...(report.cost ? { cost: report.cost.total } : {}) };
  let status = 'left';
  let commit = null;
  let reason = cfg.git.finish === 'leave' ? 'git.finish = leave' : null;
  let targetDir = worktreeFor(top, run.target);
  if (cfg.git.finish === 'squash') {
    const wait = mergeWaitReason(top, run, targetDir);
    if (wait) {
      const since = run.finish?.status === 'merge-wait' ? run.finish.since : now;
      return save({ status: 'merge-wait', ...wait, since, base, ...summary }, {
        ...reportOut, ...(full.reused ? { reused: true } : {}),
        hint: wait.reason === 'uat'
          ? 'trwa UAT na tej gałęzi docelowej: squash wejdzie po wyniku UAT; ponów finish (bez pełnej suity, jeśli cel się nie zmienił)'
          : `drzewo docelowe nie przyjmie squasha (${wait.detail ?? `zmiany: ${wait.files.join(', ')}`}): po uporządkowaniu ponów finish`,
      });
    }
  }
  // Plik odłożonych uwag: dopiero gdy squash albo leave wchodzi (przy merge-wait inny sprint mógłby dopisać do tego samego pliku).
  // K2 (D-4): z warstwą produktową odłożone uwagi to pozycje backlogu z `intake`, bez pliku.
  const deferred = productActive(top, run) ? null : writeDeferred(top, run, cfg);
  if (deferred) reportOut.deferred = deferred.file;
  if (cfg.git.finish === 'squash') {
    const switched = !targetDir;
    if (switched) { git(['switch', run.target], { cwd: top }); targetDir = top; }
    try {
      git(['merge', '--squash', run.branch], { cwd: targetDir });
      const staged = gitRaw(['diff', '--cached', '--quiet'], { cwd: targetDir }).status === 1;
      const head = legacy ? tryHeader(join(root, 'brief.md')) || {} : planInfo(root)?.h ?? tryHeader(join(ctxs[0].dir, 'brief.md')) ?? {};
      if (staged) commit = commitWith(targetDir, commitMessage(head, id, [`Raport: .dwmt/runs/${id}/final-report.md`]));
      else reason = 'brak zmian względem gałęzi docelowej';
      status = 'squashed';
    } catch (e) {
      gitRaw(['reset', '-q', '--merge'], { cwd: targetDir });
      if (switched) gitRaw(['switch', run.branch], { cwd: top });
      return save({ status: 'squash-failed', error: e.message }, { hint: 'squash nie powstał (np. hook pre-commit); drzewa przywrócone. Usuń przyczynę i ponów finish' });
    }
    // Gałąź przebiegu w innym drzewie (worktree sprintu): przesuń ją na commit squasha, bo drzewa są identyczne.
    // Kolejny przebieg na tej gałęzi ma wtedy bazę za squashem i nie recenzuje ponownie tej pracy.
    if (!switched && commit && gitRaw(['diff', '--quiet', run.branch, run.target], { cwd: top }).status === 0) git(['reset', '-q', '--keep', run.target], { cwd: top });
  }
  const cleanup = status === 'squashed' ? cleanupOf(top, run) : null;
  return save({ status, commit: commit?.slice(0, 10) ?? null, target: run.target, targetDir, ...summary }, {
    ...reportOut, ...(full.reused ? { reused: true } : {}), ...(cleanup ? { cleanup } : {}),
    hint: cleanup ? cleanupHint(run, cleanup) : `gałąź ${run.branch} zostaje${reason ? `: ${reason}` : ''}`,
  });
}

// Usunięcie gałęzi po squashu: od razu tylko wtedy, gdy żadne drzewo jej nie trzyma. Worktree sprintu trzyma ją do końca
// sesji, która w nim działa, więc wtedy są komendy na później (sprint 11: pytanie o usunięcie, a potem błąd „jest wybrana”).
export function cleanupOf(top, run) {
  const at = worktreeFor(top, run.branch);
  if (!at) return { now: true };
  const main = runHome(run, top);
  // F (noc 2026-10-05): zamiast gołego `git worktree remove` (junction node_modules → opróżniony cel) to samo sprzątanie
  // przez skrypt z głównego drzewa: kopia przebiegu, odpięte dowiązania, worktree i gałąź.
  return { now: false, at, after: [`cd "${main}" && node "${fwd(join(ROOT, 'scripts', 'dwmt.mjs'))}" finish ${run.run} --cleanup`] };
}

const cleanupHint = (run, cl) => (cl.now
  ? `zapytaj o usunięcie gałęzi ${run.branch} (finish --cleanup)`
  : `gałąź ${run.branch} jest wybrana w ${cl.at}: podaj użytkownikowi komendy z cleanup.after na po zamknięciu tej sesji`);
