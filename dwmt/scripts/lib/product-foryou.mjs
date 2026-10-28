// dwmt D4: the decision-maker's `## For you` section of sprint files (spec warstwy produktowej §3.5): which sprints lack it
// (`product for-you [--missing]`) and drafts for them by a cheap model (`product for-you --draft`), one `claude -p` call
// per batch of ≤ 8 sprints, no tools. Drafts go through the sprint file writer (format and budget checks); nothing is
// committed here (the PO commits). `cheapClaude` is the spawn helper for other cheap-model text jobs (view translation).
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { asList } from './util.mjs';
import { leanPlugins } from './sessions.mjs';
import { clearGitMemo } from './git.mjs';
import {
  FOR_YOU, loadRoadmap, loadIndex, loadItems, specFile, archiveSpecFile, readSpecAt, writeSpecAt, setSection, specSections,
  parseForYou, renderForYou, checkForYou, humanState, withLock, logChange,
} from './product-store.mjs';

const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
export const DRAFT_BATCH = 8;

// One `claude -p` call without tools: prompt on stdin (batches exceed the Windows command line), JSON result. No session
// file (`--no-session-persistence`), user settings only (`--setting-sources user`: no project or local settings, hooks
// or project memory files), no MCP servers.
// → {ok, text, error, usage: {tokens, usd}, session}. `DWMT_CLAUDE` (tests) replaces the binary with a node script.
export function cheapClaude(top, cfg, prompt, { model = 'haiku', timeoutMs = 180e3 } = {}) {
  const off = cfg.launch?.lean !== false ? leanPlugins(top) : {};
  const args = ['-p', '--output-format', 'json', '--model', model, '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--setting-sources', 'user',
    ...(Object.keys(off).length ? ['--settings', JSON.stringify({ enabledPlugins: off })] : [])];
  const [bin, argv] = process.env.DWMT_CLAUDE ? [process.execPath, [process.env.DWMT_CLAUDE, ...args]] : ['claude', args];
  const r = spawnSync(bin, argv, { cwd: top, input: prompt, encoding: 'utf8', maxBuffer: 16 << 20, windowsHide: true, timeout: timeoutMs });
  clearGitMemo(); // the agent may have run git
  let res = null;
  try { res = JSON.parse(r.stdout); } catch { /* no JSON */ }
  const u = res?.usage ?? {};
  const usage = { tokens: ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'].reduce((a, k) => a + (Number(u[k]) || 0), 0), usd: Number(res?.total_cost_usd) || 0 };
  if (r.error?.code === 'ETIMEDOUT' || (r.signal && r.status === null)) return { ok: false, error: `timeout after ${Math.round(timeoutMs / 1000)} s`, usage };
  if (r.error || r.status !== 0 || !res || res.is_error) return { ok: false, error: cut(r.error?.message ?? res?.result ?? r.stderr ?? `exit ${r.status}`, 300) || `exit ${r.status}`, usage };
  return { ok: true, text: String(res.result ?? ''), usage, session: res.session_id ?? null };
}

// The JSON object in a model answer (code fence or prose around it tolerated).
export function answerJson(text) {
  const t = String(text ?? '').replace(/```(?:json)?/gi, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no JSON object in the answer');
  return JSON.parse(t.slice(a, b + 1));
}

// Sprints the user sees on the page (open lines To do, In progress, Awaiting review; archived with UAT pending).
function candidates(c) {
  const { P } = c;
  const open = loadRoadmap(P).filter((l) => ['todo', 'inprogress', 'review'].includes(humanState(l))).map((l) => ({ id: l.id, state: l.state, goal: l.goal, file: specFile(P, l.id), archived: false }));
  const arch = loadIndex(P).filter((x) => x.merged !== 'dropped').map((x) => {
    let s = null;
    try { s = readSpecAt(archiveSpecFile(P, x.id)); } catch { /* no header */ }
    return s && humanState({ archived: true, h: s.h }) === 'review' ? { id: x.id, state: 'awaiting review', goal: x.goal, file: s.file, archived: true } : null;
  }).filter(Boolean);
  return [...open, ...arch];
}
const hasForYou = (file) => { try { return !!parseForYou(readSpecAt(file)?.body); } catch { return false; } };

export function forYouList(c, { missing = false } = {}) {
  const all = candidates(c).map((x) => ({ ...x, has: existsSync(x.file) && hasForYou(x.file) }));
  const miss = all.filter((x) => !x.has);
  const rows = (missing ? miss : all).map((x) => `${x.id} · ${x.state}${x.archived ? ' (archive)' : ''} · ${x.goal}${missing ? '' : ` · for you: ${x.has ? 'yes' : 'missing'}`}`);
  const model = c.pc.view?.model ?? 'haiku';
  const head = `for you: ${miss.length} of ${all.length} sprints missing${miss.length ? ` (draft: product for-you --draft, ${model}, ${Math.ceil(miss.length / DRAFT_BATCH)} call(s), then product commit)` : ''}`;
  return [head, ...rows].join('\n');
}

// Sprint text for the drafting prompt: the body without agent-only noise (header, ids-only and path sections).
const NOISE = /^(for you|open questions|refs|decisions|mockups|.*\(expanded\))$/i;
function draftSource(c, x, s) {
  const { open, archived } = loadItems(c.P);
  const sec = specSections(s.body);
  const items = asList(s.h.items).map((r) => [...open, ...archived].find((i) => i.id === r)).filter(Boolean).map((i) => `- ${i.title}`);
  return [`### ${x.id}`, `Roadmap goal: ${x.goal}`, ...Object.entries(sec).filter(([k, v]) => !NOISE.test(k) && v.trim()).map(([k, v]) => `${k}:\n${String(v).slice(0, 1500)}`),
    ...(items.length ? ['Backlog items:', ...items] : [])].join('\n').slice(0, 3000);
}
const draftPrompt = (lang, parts) => [
  `For each sprint below write a short section for the product's decision-maker, in the language with code "${lang}".`,
  'Plain words, no identifiers (B-n, AC-n, PD-n, E-n, sprint ids, file paths, class or function names): say what the user sees and can do.',
  'Answer with one JSON object only, no other text: {"<sprint id>": {"title": "...", "why": "...", "changes": ["..."], "notIncluded": ["..."], "check": ["..."]}}, one key per sprint id below, ids exactly as given.',
  'title: short title, at most 90 characters. why: 1-3 sentences, what the user gets. changes: visible changes. notIncluded: what this sprint does not do. check: steps the user does to check it at review. title and why are required; a list may be empty. Keep each sprint short: at most 1200 characters in all, at most 6 lines per list, one short sentence per line (a longer answer is rejected).',
  '', '## Sprints', '', ...parts,
].join('\n');

export function forYouDraft(c, { ids = null, lang = null, force = false } = {}) {
  const { P, top, cfg, pc } = c;
  const view = pc.view ?? {};
  const model = view.model ?? 'haiku';
  const language = lang ?? cfg.language ?? 'en';
  const failed = [];
  const skipped = [];
  let targets;
  if (ids) {
    const all = candidates(c);
    const lines = loadRoadmap(P);
    targets = ids.map((id) => all.find((x) => x.id === id) ?? (lines.some((l) => l.id === id) ? { id, state: lines.find((l) => l.id === id).state, goal: lines.find((l) => l.id === id).goal, file: specFile(P, id), archived: false } : existsSync(archiveSpecFile(P, id)) ? { id, state: 'closed', goal: loadIndex(P).find((x) => x.id === id)?.goal ?? id, file: archiveSpecFile(P, id), archived: true } : null) ?? { id, missing: true });
    for (const x of targets.filter((t) => t.missing)) failed.push({ id: x.id, error: 'no sprint in the roadmap or archive' });
    targets = targets.filter((t) => !t.missing);
    if (!force) { for (const x of targets.filter((t) => existsSync(t.file) && hasForYou(t.file))) skipped.push(x.id); targets = targets.filter((t) => !skipped.includes(t.id)); }
  } else targets = candidates(c).filter((x) => !(existsSync(x.file) && hasForYou(x.file)));
  const ready = [];
  for (const x of targets) {
    try { const s = readSpecAt(x.file); if (!s) throw new Error('no sprint file (topic)'); ready.push({ ...x, src: draftSource(c, x, s) }); } catch (e) { failed.push({ id: x.id, error: e.message }); }
  }
  const written = [];
  const usage = { calls: 0, tokens: 0, usd: 0 };
  for (let i = 0; i < ready.length; i += DRAFT_BATCH) {
    const batch = ready.slice(i, i + DRAFT_BATCH);
    const r = cheapClaude(top, cfg, draftPrompt(language, batch.map((x) => `${x.src}\n`)), { model, timeoutMs: (view.draftTimeoutS ?? 180) * 1e3 });
    usage.calls++; usage.tokens += r.usage.tokens; usage.usd += r.usage.usd;
    let ans = null;
    if (r.ok) { try { ans = answerJson(r.text); } catch (e) { r.error = `bad answer: ${e.message}`; } }
    for (const x of batch) {
      if (!ans) { failed.push({ id: x.id, error: r.error }); continue; }
      const f = ans[x.id];
      if (!f || typeof f !== 'object') { failed.push({ id: x.id, error: 'no entry in the answer' }); continue; }
      const text = renderForYou(f);
      const v = checkForYou(`## ${FOR_YOU}\n${text}\n`);
      if (v.errors.length) { failed.push({ id: x.id, error: v.errors.join('; ') }); continue; }
      try {
        withLock(P, () => {
          const s = readSpecAt(x.file);
          writeSpecAt(x.file, s.h, setSection(s.body, FOR_YOU, text));
          logChange(P, `${x.id} spec ${FOR_YOU} (draft${x.archived ? ', archive' : ''})`, { kind: 'spec' });
        });
        written.push(x.id);
      } catch (e) { failed.push({ id: x.id, error: e.message }); }
    }
  }
  const costHint = usage.calls ? `${usage.calls} call(s), ${(usage.tokens / 1e6).toFixed(3)} M tokens${usage.usd ? `, $${usage.usd.toFixed(3)}` : ''} (${model})` : 'no calls';
  return { ok: !!written.length || !failed.length, written, failed, ...(skipped.length ? { skipped, hint: 'already have For you: --force redrafts' } : {}), costHint, language, ...(written.length ? { next: 'product commit' } : {}) };
}
