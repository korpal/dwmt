// dwmt: jedna naprawa przy `finish` (przegląd 2026-10-09, W-2, decyzja użytkownika). Noce stawały na czerwieni pełnej
// suity albo konflikcie rebase, które naprawiała jedna linia (sprint V 5 h: pin migracji; sprint M 6 h: konflikt w rejestrze
// makiet „zostaw obie strony”). Sterownik po `finish` z `red` albo `conflict` uruchamia raz świeżego `dwmt-executor-high`:
// `finish-repair <run>` przygotowuje (konflikt: rebase zostaje w toku ze znacznikami w plikach) i daje prompt, a
// `finish-repair <run> --done` po agencie: konflikt → `rebase --continue`; rebase staje osobno na każdym commicie gałęzi
// (rejestry wspólne zmienia kilka zadań), więc każdy kolejny postój z konfliktem wraca do tego samego agenta (do
// `MAX_STOPS` postojów w jednej próbie); commit pusty po rozwiązaniu → `rebase --skip` (w raporcie). Czerwień → commit
// poprawki na gałęzi przebiegu. Potem zwykły `finish` (konflikt: rebase już zrobiony, pełna suita; czerwień: tylko czerwone
// komendy). Nigdy więcej niż jedna dokończona próba na przebieg (`run.finishRepair`); raport końcowy wymienia ją jako
// odstępstwo do przejrzenia z kosztem. Konflikt rozwiązuje tylko agent, nigdy `-X ours/theirs`.
// Recenzja poprawek: próba przerwana (sterownik zginął w trakcie) → `--recover`: rebase cofnięty, zmiany w schowku git
// z nazwą przebiegu, wynik `interrupted`; przerwana limitem abonamentu (`--recover --resumable`) nie zużywa próby.
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { pathsFor, artifactsLang } from '../plan.mjs';
import { fwd, read, asList } from './util.mjs';
import { tryHeader } from './headers.mjs';
import { gitRaw, git, dirty } from './git.mjs';
import { loadConfig } from './config.mjs';
import { runDir, loadRun, saveRun, runEvent } from './run.mjs';
import { commitWith } from './commit.mjs';
import { shellName } from './verify.mjs';

export const REPAIR_AGENT = 'dwmt-executor-high';
export const MAX_STOPS = 5;
// Znaczniki konfliktu z etykietą (sam `=======` bywa podkreśleniem nagłówka w markdown).
const MARKERS = /^(<{7}|>{7})(?: |$)/m;
const unmerged = (top) => git(['diff', '--name-only', '--diff-filter=U'], { cwd: top }).split(/\r?\n/).filter(Boolean);
const rebasing = (top) => {
  const gd = git(['rev-parse', '--git-dir'], { cwd: top });
  const abs = /^([a-z]:|\/)/i.test(gd) ? gd : join(top, gd);
  return existsSync(join(abs, 'rebase-merge')) || existsSync(join(abs, 'rebase-apply'));
};
const untracked = (top) => git(['ls-files', '--others', '--exclude-standard'], { cwd: top }).split(/\r?\n/).filter(Boolean);
// Ścieżka z wpisu zmiany wykonawcy („<path>: co i dlaczego”, czasem `path#Symbol`).
const changePath = (x) => String(x).split(/:\s/)[0].split('#')[0].trim();

function paths(run, top) {
  const root = runDir(top, run.run);
  const { rel, root: repo0 } = pathsFor(run, top);
  mkdirSync(join(root, 'finish'), { recursive: true });
  return { root, rel, repo: `${repo0}${artifactsLang(run)}`, output: join(root, 'finish', 'repair.md'), progress: join(root, 'finish', 'progress.md') };
}

const REPORT = 'List every change in `outOfScopeChanges` as "<path>: what and why"; status DONE when fixed, BLOCKED with the reason when the fix would weaken a test or change behaviour outside the failure.';
function conflictPrompt(run, cfg, top, files, n) {
  const { rel, repo, output, progress } = paths(run, top);
  const again = n > 1 ? ` This is stop ${n}: the rebase went on and stopped again on the next commit of the branch; rewrite the result file for this stop.` : '';
  return `Finish repair (one attempt). Rebasing the sprint branch onto ${run.target} stopped on conflicts in: ${files.join(', ')}. The rebase is in progress and these files hold conflict markers.${again} Resolve each conflict so both sides' intent holds (the target's change and the sprint's), remove every marker, and change nothing beyond the merge; never take one side wholesale. Then run the targeted tests of the resolved files (the script runs \`verify\` in ${shellName(cfg)}). ${REPORT} ${repo}Progress (append only): ${rel(progress)}. Result (schema dwmt/result@1): ${rel(output)}. Never change git state; the script does it.`;
}
// Wcześniejsza próba przerwana limitem: jej zmiany w schowku git (agent może je obejrzeć `git stash show -p`).
const earlier = (run) => {
  const s = asList(run.finishRepairInterrupted).map((x) => x.stash).filter(Boolean).pop();
  return s ? ` An earlier attempt was interrupted; its changes are in the git stash "${s}" (read them with \`git stash list\` and \`git stash show -p\`; never apply or drop it).` : '';
};

// Przygotowanie: prompt dla agenta albo powód, dla którego naprawy nie ma.
export function cmdFinishRepair(top, id, opts = {}) {
  if (opts.done) return repairDone(top, id, opts);
  if (opts.recover) return repairRecover(top, id, opts);
  const run = loadRun(top, id);
  const cfg = loadConfig(top);
  const kind = run.finish?.status;
  if (!['red', 'conflict'].includes(kind)) return { ok: false, error: `finish-repair tylko po finish red albo conflict (jest ${kind ?? 'brak finish'})` };
  if (run.finishRepair) return { ok: false, error: 'naprawa przy finish już była (jedna próba na przebieg)', finishRepair: run.finishRepair };
  const { rel, root, repo, output, progress } = paths(run, top);
  const at = new Date().toISOString();
  if (kind === 'conflict') {
    const rb = gitRaw(['rebase', run.target], { cwd: top });
    if (rb.status === 0) {
      run.finishRepair = { kind, at, result: 'clean-rebase', files: [] };
      saveRun(top, run);
      return { ok: true, done: true, kind, hint: 'rebase przeszedł bez konfliktu: finish' };
    }
    const files = unmerged(top);
    if (!files.length) {
      gitRaw(['rebase', '--abort'], { cwd: top });
      return { ok: false, error: `rebase ${run.target} nie przeszedł, ale bez plików w konflikcie: ${(rb.stderr || rb.stdout).trim().slice(0, 200)}` };
    }
    run.finishRepair = { kind, at, result: 'started', files, current: files, stops: 1, changes: [], skipped: [] };
    saveRun(top, run);
    runEvent(top, run, 'finish-repair', { detail: { kind, files } });
    return { ok: true, kind, agent: REPAIR_AGENT, output: fwd(output), files, prompt: `${conflictPrompt(run, cfg, top, files, 1)}${earlier(run)}` };
  }
  const failed = asList(run.fullVerify?.failed);
  run.finishRepair = { kind, at, result: 'started', failed, changes: [] };
  saveRun(top, run);
  runEvent(top, run, 'finish-repair', { detail: { kind, failed } });
  return {
    ok: true, kind, agent: REPAIR_AGENT, output: fwd(output), failed,
    prompt: `Finish repair (one attempt). After the rebase onto ${run.target} the full suite is red: ${failed.map((c) => `\`${c}\``).join(', ') || 'see the output'}. Output: ${rel(join(root, 'tests-full.md'))}. Fix the cause, never weaken, skip or delete a test, and change no behaviour outside the failure. Run only the failing tests (the script runs \`verify\` in ${shellName(cfg)}; never the whole suite). ${REPORT}${earlier(run)} ${repo}Progress (append only): ${rel(progress)}. Result (schema dwmt/result@1): ${rel(output)}. Never change git state; the script does it.`,
  };
}

// Po agencie: wynik naprawy (`retry: true` = sterownik ponawia `finish`; `next` = następny postój rebase dla tego samego
// agenta). `--failed` (agent bez wyniku): konflikt wraca do stanu sprzed rebase, poprawki czerwieni zostają w drzewie.
function repairDone(top, id, opts) {
  const run = loadRun(top, id);
  const cfg = loadConfig(top);
  const { output } = paths(run, top);
  const fr = run.finishRepair;
  if (!fr || fr.result !== 'started') return { ok: false, error: 'brak trwającej naprawy przy finish (finish-repair <run>)' };
  if (opts.session && opts.session !== true) fr.session = String(opts.session);
  const res = tryHeader(output);
  fr.status = res && !res.errors ? res.status ?? null : null;
  const mine = res && !res.errors ? asList(res.outOfScopeChanges).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : [];
  fr.changes = [...new Set([...asList(fr.changes), ...mine])];
  const end = (result, extra = {}) => {
    Object.assign(fr, { result, endedAt: new Date().toISOString(), ...extra });
    delete fr.current;
    saveRun(top, run);
    runEvent(top, run, 'finish-repair', { detail: { kind: fr.kind, result } });
    return { ok: true, kind: fr.kind, result, retry: ['resolved', 'committed'].includes(result), ...extra };
  };
  const failed = opts.failed === true || !res || res.errors || fr.status === 'BLOCKED';
  if (fr.kind === 'conflict') {
    if (!rebasing(top)) return end('failed', { reason: 'rebase nie jest w toku' });
    const cur = asList(fr.current ?? fr.files);
    const left = cur.filter((f) => existsSync(join(top, f)) && MARKERS.test(read(join(top, f))));
    if (failed || left.length) {
      gitRaw(['rebase', '--abort'], { cwd: top });
      return end(failed ? 'failed' : 'markers', left.length ? { markers: left } : {});
    }
    // Tylko pliki z konfliktu i zmiany plików śledzonych: wyjścia testów spoza .gitignore nie wchodzą do commitów.
    git(['add', '-A', '--', ...cur], { cwd: top });
    git(['add', '-u'], { cwd: top });
    let c = gitRaw(['-c', 'core.editor=true', 'rebase', '--continue'], { cwd: top, env: { GIT_EDITOR: 'true' } });
    for (let guard = 0; guard < 100; guard++) {
      if (!rebasing(top)) return c.status === 0 ? end('resolved') : end('failed', { reason: (c.stderr || c.stdout).trim().slice(0, 200) });
      const again = unmerged(top);
      if (again.length) {
        if (fr.stops >= MAX_STOPS) {
          gitRaw(['rebase', '--abort'], { cwd: top });
          return end('conflict-again', { again, reason: `${MAX_STOPS} postojów rebase z konfliktem w jednej próbie` });
        }
        fr.stops += 1;
        fr.files = [...new Set([...asList(fr.files), ...again])];
        fr.current = again;
        if (existsSync(output)) renameSync(output, output.replace(/\.md$/, `-${fr.stops - 1}.md`));
        saveRun(top, run);
        runEvent(top, run, 'finish-repair', { detail: { kind: fr.kind, stop: fr.stops, files: again } });
        return { ok: true, kind: fr.kind, result: 'next-stop', stop: fr.stops, again, next: { agent: REPAIR_AGENT, output: fwd(output), prompt: conflictPrompt(run, cfg, top, again, fr.stops) } };
      }
      // Commit pusty po rozwiązaniu (zmiana celu już zawiera zmianę sprintu): pominięty i odnotowany.
      if (gitRaw(['diff', '--cached', '--quiet'], { cwd: top }).status === 0) {
        const subject = gitRaw(['log', '-1', '--format=%s', 'REBASE_HEAD'], { cwd: top }).stdout.trim();
        fr.skipped = [...asList(fr.skipped), subject || '?'];
        c = gitRaw(['-c', 'core.editor=true', 'rebase', '--skip'], { cwd: top, env: { GIT_EDITOR: 'true' } });
        continue;
      }
      gitRaw(['rebase', '--abort'], { cwd: top });
      return end('failed', { reason: (c.stderr || c.stdout).trim().slice(0, 200) });
    }
    gitRaw(['rebase', '--abort'], { cwd: top });
    return end('failed', { reason: 'rebase bez końca' });
  }
  if (failed) return end(fr.status === 'BLOCKED' ? 'blocked' : 'failed', dirty(top).length ? { leftover: dirty(top).slice(0, 20) } : {});
  // Zmiany plików śledzonych i nowe pliki nazwane w wyniku. Inne nowe pliki (wyjścia testów) nie idą do commita ani nie
  // zatrzymują finish: schowek git z nazwą przebiegu (do odzyskania, nic nie jest usuwane) i lista w raporcie.
  git(['add', '-u'], { cwd: top });
  const named = new Set(fr.changes.map(changePath));
  const fresh = untracked(top);
  const add = fresh.filter((f) => named.has(f));
  if (add.length) git(['add', '--', ...add], { cwd: top });
  const stray = fresh.filter((f) => !named.has(f));
  const staged = gitRaw(['diff', '--cached', '--quiet'], { cwd: top }).status !== 0;
  const commit = staged ? commitWith(top, `dwmt: naprawa przy finish (${fr.failed.join('; ').slice(0, 120)})\n\n${fr.changes.map((x) => `- ${x}`).join('\n')}\n\ndwmt-run: ${run.run} finish-repair\n`) : null;
  let stash = null;
  if (stray.length) {
    stash = `dwmt finish-repair ${run.run} untracked`;
    git(['stash', 'push', '-u', '-m', stash, '--', ...stray], { cwd: top });
  }
  const extra = stray.length ? { untracked: stray.slice(0, 20), untrackedStash: stash } : {};
  return commit ? end('committed', { commit: commit.slice(0, 10), ...extra }) : end('no-change', extra);
}

// Próba przerwana: rebase cofnięty, zmiany w schowku git z nazwą przebiegu. `--resumable` (limit abonamentu): próba nie
// przepada (zapis w `finishRepairInterrupted`, następny `finish` z czerwienią albo konfliktem zaczyna ją od nowa).
function repairRecover(top, id, opts) {
  const run = loadRun(top, id);
  const fr = run.finishRepair;
  if (!fr || fr.result !== 'started') return { ok: true, none: true };
  const undone = [];
  if (rebasing(top)) { gitRaw(['rebase', '--abort'], { cwd: top }); undone.push(`rebase onto ${run.target} undone`); }
  let stash = null;
  if (dirty(top).length) {
    stash = `dwmt finish-repair ${run.run} ${new Date().toISOString()}`;
    git(['stash', 'push', '-u', '-m', stash], { cwd: top });
    undone.push(`its changes are in the git stash "${stash}"`);
  }
  const resumable = !!opts.resumable;
  const rec = { ...fr, result: 'interrupted', endedAt: new Date().toISOString(), ...(stash ? { stash } : {}) };
  if (resumable) { run.finishRepairInterrupted = [...asList(run.finishRepairInterrupted), rec]; delete run.finishRepair; } else run.finishRepair = rec;
  saveRun(top, run);
  runEvent(top, run, 'finish-repair', { detail: { kind: fr.kind, result: 'interrupted', resumable } });
  return { ok: true, result: 'interrupted', resumable, ...(stash ? { stash } : {}), reason: `the finish repair (${fr.kind}) was interrupted${undone.length ? `; ${undone.join('; ')}` : ''}${resumable ? '; it starts again at the next finish' : '; no new attempt'}` };
}

// Raport końcowy: pole `finishRepair` i linia odstępstwa (zawsze do przejrzenia), koszt sesji agenta.
export function finishRepairReport(run, costOf) {
  const fr = run.finishRepair;
  if (!fr) return null;
  const cost = fr.session ? costOf([fr.session])?.total ?? null : null;
  const what = fr.kind === 'conflict' ? `rebase conflict in ${asList(fr.files).join(', ')}` : `red full suite: ${asList(fr.failed).join(', ')}`;
  const skipped = asList(fr.skipped).length ? `; commits empty after resolution, skipped: ${fr.skipped.join('; ')}` : '';
  const stashed = asList(fr.untracked).length ? `; untracked → stash "${fr.untrackedStash}": ${fr.untracked.join(', ')}` : '';
  return {
    header: { kind: fr.kind, result: fr.result, ...(fr.stops > 1 ? { stops: fr.stops } : {}), ...(fr.commit ? { commit: fr.commit } : {}), changes: asList(fr.changes), ...(asList(fr.skipped).length ? { skipped: fr.skipped } : {}), ...(asList(fr.untracked).length ? { untracked: fr.untracked, untrackedStash: fr.untrackedStash } : {}), ...(cost != null ? { costM: cost } : {}) },
    line: `finish repair (${what}) → ${fr.result}${fr.changes?.length ? `: ${fr.changes.join('; ')}` : ''}${skipped}${stashed}; review this change`,
  };
}

export const isRepairable = (run, f) => ['red', 'conflict'].includes(f?.status) && !run.finishRepair && !run.stopped;
