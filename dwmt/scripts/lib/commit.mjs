// dwmt: commit zadania i rundy zbiorczej.
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { is210, entityText } from '../plan.mjs';
import { splitReviews, batchItemResults, writeBatchReport } from '../batch.mjs';
import { asList, read } from './util.mjs';
import { tryHeader } from './headers.mjs';
import { gitRaw, git } from './git.mjs';
import { loadConfig } from './config.mjs';
import { runDir, taskDir, sessionId, loadRun, saveRun, newTask, taskCtx, sprintCount, writeStatus, runEvent } from './run.mjs';
import { removeFiles, emptyScratch } from './deletes.mjs';
import { computeState } from './state.mjs';
import { sessionsCost } from './sessions.mjs';
import { writeTaskReport } from './report.mjs';
import { snapshotTree } from './review.mjs';

// ---------- commit, finish ----------

export function commitMessage(brief, id, extra = []) {
  return [brief.goal || id, '', ...(brief.acceptance || []).map((a) => `- ${a}`), ...extra, '', `dwmt-run: ${id}`, ''].join('\n');
}
export function commitWith(cwd, msg, extra = []) {
  const f = join(tmpdir(), `dwmt-msg-${process.pid}-${Date.now()}.txt`);
  writeFileSync(f, msg);
  try { git(['commit', '-q', ...extra, '-F', f], { cwd }); } finally { rmSync(f, { force: true }); }
  return git(['rev-parse', 'HEAD'], { cwd });
}

// Commit zadania (§5.9): `T-k <tytuł>`, AC zadania i stopka `dwmt-run: <run> T-k` (po niej finish odnajduje commity po rebase).
// K4 (C-1): wpis `AC-n` albo `AC-n (part: …)` dostaje zdanie kryterium z planu sprintu (entityText); wpis z tekstem jak jest.
function taskMessage(run, ctx, brief) {
  const title = ctx.t.title || brief.goal || run.run;
  const file = (n) => (existsSync(n) ? read(n) : null);
  let src = null;
  const line = (a) => {
    const entry = String(a);
    const id = entry.split(/\s/)[0];
    const rest = entry.slice(id.length).trim();
    if (!/^AC-\d+$/.test(id) || (rest && !/^\(part:/i.test(rest))) return `- ${entry}`;
    src ??= { planText: file(join(ctx.root, 'plan.md')), briefText: file(join(ctx.dir, 'brief.md')) };
    const e = entityText(src, id);
    return `- ${e?.text ? `${id} ${e.text}` : entry}`;
  };
  return [`T-${ctx.k} ${title}`, '', ...asList(brief.acceptance).map(line), '', `dwmt-run: ${run.run} T-${ctx.k}`, ''].join('\n');
}

// kt (D-13): `--accept` on a tree no whole verify has seen runs the closing verify first (state gives it); after it the
// commit goes through even when red. After 3 closing verifies of the round (the tree keeps changing) it commits at once.
function closingRedirect(top, run, t, round) {
  if (!t.whole || (t.closingRuns?.[round] ?? 0) >= 3 || t.whole.tree === snapshotTree(top)) return null;
  saveRun(top, run);
  return { ok: false, accepted: true, next: 'verify', closing: true, hint: 'akceptacja zapisana; drzewo zmieniło się od ostatniego pełnego verify: state (zamykające verify), potem commit' };
}

export function cmdCommit(top, id, opts) {
  const run = loadRun(top, id);
  const root = runDir(top, id);
  const cfg = loadConfig(top);
  const ctx = taskCtx(root, run);
  const { t } = ctx;
  if (!ctx.legacy) splitReviews(top, root, run, cfg, ctx);
  const st = computeState(root, run, cfg);
  if (st.batch) return commitBatch(top, run, cfg, root, st, opts);
  if (opts.accept && st.next === 'ask-rounds') {
    t.accepted = true;
    const closing = ctx.legacy ? null : closingRedirect(top, run, t, st.round);
    if (closing) return closing;
  } else if (st.next !== 'commit') throw new Error(`stan ${st.next}: commit dopiero po PASS (albo --accept przy ask-rounds)`);
  const current = git(['branch', '--show-current'], { cwd: top });
  if (current !== run.branch) throw new Error(`bieżąca gałąź to ${current || 'detached HEAD'}, a nie ${run.branch}: przełącz się (git switch ${run.branch}) i ponów commit`);
  const brief = tryHeader(join(ctx.dir, 'brief.md')) || {};
  // v2.10 (B): pliki z `delete` za zgodą, których jeszcze nie ma usuniętych (np. przywrócone w trakcie), i katalog roboczy wykonawców.
  // Plik bez zgody (odmowa, nigdy niezapytany, np. dopisany przy replanie) albo odrzucony przez sprawdzenie ścieżki zostaje (`kept`).
  if (!ctx.legacy && is210(run)) {
    const mine = asList(brief.delete).map(String);
    const approved = new Set(asList(run.deletions?.approved));
    const { removed, refused } = removeFiles(top, mine.filter((f) => approved.has(f)));
    if (removed.length) t.deleted = [...new Set([...asList(t.deleted), ...removed])];
    const kept = mine.filter((f) => !approved.has(f) || refused.includes(f));
    if (kept.length) t.kept = kept; else delete t.kept;
  }
  emptyScratch(top);
  git(['add', '-A'], { cwd: top });
  const staged = gitRaw(['diff', '--cached', '--quiet'], { cwd: top }).status === 1;
  const msg = ctx.legacy ? commitMessage(brief, id) : taskMessage(run, ctx, brief);
  if (staged) t.commit = commitWith(top, msg);
  else if (ctx.legacy) t.commit = git(['rev-parse', 'HEAD'], { cwd: top });
  else {
    // git.rebase: review zacommitował już pracę rundy 1 jako „dwmt wip”: ten commit staje się commitem zadania.
    // Commit zadania zawsze niesie stopkę `dwmt-run: <run> T-k`, bo po niej finish i rebase odnajdują zadania.
    const wip = git(['log', '-1', '--format=%s'], { cwd: top }).startsWith(`dwmt wip: ${run.run} T-${ctx.k} `) && t.baseline !== git(['rev-parse', 'HEAD'], { cwd: top });
    t.commit = commitWith(top, msg, wip ? ['--amend'] : ['--allow-empty']);
  }
  const out = { ok: true, commit: t.commit.slice(0, 10), empty: !staged, branch: run.branch };
  if (!ctx.legacy) {
    const n = run.count ?? sprintCount(root, run);
    run.count = n;
    Object.assign(out, { task: ctx.k, tasks: n, report: writeTaskReport(run, ctx) });
    // §5.10: zadanie k < N kończy sesję; następne zadanie ma punkt odniesienia diffu na tym commicie.
    if (ctx.k < n) {
      run.task = ctx.k + 1;
      run.tasks.push({ ...newTask(ctx.k + 1, t.commit, cfg), sessions: [] });
      mkdirSync(taskDir(root, ctx.k + 1), { recursive: true });
      run.handoff = { task: ctx.k, commit: t.commit.slice(0, 10), session: sessionId(), at: new Date().toISOString() };
      out.next = 'handoff';
    }
  }
  saveRun(top, run);
  if (out.next === 'handoff') writeStatus(top, run, 'handoff', { task: ctx.k, commit: out.commit });
  // costM: transkrypty sesji zadania od jego startu (bez planowania w tej samej sesji); null bez transkryptów.
  const spent = !ctx.legacy && t.startEvent ? sessionsCost(t.sessions, undefined, { from: t.startEvent, to: new Date().toISOString() }) : null;
  runEvent(top, run, 'task-end', { task: ctx.k, verdict: t.accepted || asList(t.kept).length ? 'ACCEPTED' : 'PASS', costM: spent?.total ?? null, detail: { commit: out.commit, ...(asList(t.deleted).length ? { deleted: t.deleted } : {}), ...(asList(t.kept).length ? { kept: t.kept } : {}) } });
  return out;
}

// v2.8: commit rundy zbiorczej na gałęzi sprintu (stopka `dwmt-run: <run> batch`) i batch/report.md.
function commitBatch(top, run, cfg, root, st, opts) {
  const b = run.batch;
  if (opts.accept && st.next === 'ask-rounds') {
    b.accepted = true;
    const closing = closingRedirect(top, run, b, st.round);
    if (closing) return { ...closing, batch: true };
  } else if (st.next !== 'commit') throw new Error(`runda zbiorcza w stanie ${st.next}: commit dopiero po recenzji (albo --accept przy ask-rounds)`);
  const current = git(['branch', '--show-current'], { cwd: top });
  if (current !== run.branch) throw new Error(`bieżąca gałąź to ${current || 'detached HEAD'}, a nie ${run.branch}: przełącz się (git switch ${run.branch}) i ponów commit`);
  emptyScratch(top);
  git(['add', '-A'], { cwd: top });
  const staged = gitRaw(['diff', '--cached', '--quiet'], { cwd: top }).status === 1;
  const items = batchItemResults(root, run);
  const msg = [`Fix batch: ${items.length} review finding(s)`, '', ...items.map((x) => `- ${x.id} ${x.title} (${x.result})`), '', `dwmt-run: ${run.run} batch`, ''].join('\n');
  b.commit = commitWith(top, msg, staged ? [] : ['--allow-empty']);
  b.committedAt = new Date().toISOString();
  const report = writeBatchReport(top, root, run, cfg);
  saveRun(top, run);
  const spent = b.at ? sessionsCost(run.session_ids, undefined, { from: b.at, to: b.committedAt }) : null;
  runEvent(top, run, 'task-end', { task: 'batch', verdict: b.accepted ? 'ACCEPTED' : 'PASS', costM: spent?.total ?? null, detail: { commit: b.commit.slice(0, 10), items: items.length } });
  return { ok: true, batch: true, commit: b.commit.slice(0, 10), empty: !staged, branch: run.branch, report, open: items.filter((x) => x.result === 'open').map((x) => x.id) };
}
