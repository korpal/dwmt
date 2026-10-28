// dwmt: sesje agentów: koszt i limit z transkryptów, `sessions-add`, `launch`, wtyczki lean.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { transcriptFiles } from '../watch.mjs';
import { ROOT, fwd, read, asList } from './util.mjs';
import { trimOutput } from './text.mjs';
import { stripJsonComments, loadConfig } from './config.mjs';
import { runDir, sessionId, driverCall, loadRun, saveRun, isLegacy } from './run.mjs';
import { spawnDetached } from './platform.mjs';

// The watcher is no session of the run: without the caller's session id (loadRun would register it).
const watcherEnv = () => { const e = { ...process.env }; delete e.CLAUDE_CODE_SESSION_ID; return e; };
import { worktreeFor, clearGitMemo } from './git.mjs';

// Limit abonamentu (T-S12): ostatni wpis assistant z `error: rate_limit` i `resetsAt` (epoch s) w przyszłości.
export function transcriptLimit(file, now = Date.now()) {
  let last = null;
  for (const line of read(file).split(/\r?\n/)) {
    if (!line) continue;
    try { const d = JSON.parse(line); if (d?.type === 'assistant') last = d; } catch { /* urwana linia */ }
  }
  if (last?.error !== 'rate_limit') return null;
  const at = Number(last.quotaLimits?.resetsAt) * 1000;
  return at > now ? { resetsAt: new Date(at).toISOString(), type: last.quotaLimits?.rateLimitType ?? null } : null;
}

// Agent tej sesji, uruchomiony po ostatnim kroku (stepAt), zwrócił tekst limitu jako wynik: krok do powtórzenia.
// Pod sterownikiem agenci to osobne sesje `claude -p` z `session_ids` przebiegu: ich główne transkrypty.
export function agentLimit(run, root = process.env.DWMT_TRANSCRIPTS || join(homedir(), '.claude', 'projects')) {
  const sid = sessionId();
  if (!sid || !run.stepAt || !existsSync(root)) return null;
  const since = Date.parse(run.stepAt);
  if (driverCall()) {
    for (const f of transcriptFiles(run.session_ids, root)) {
      if (statSync(f).mtimeMs < since) continue;
      const l = transcriptLimit(f);
      if (l) return l;
    }
    return null;
  }
  for (const proj of readdirSync(root)) {
    const subs = join(root, proj, sid, 'subagents');
    if (!existsSync(subs)) continue;
    for (const f of readdirSync(subs).filter((x) => /^agent-.*\.jsonl$/.test(x))) {
      if (statSync(join(subs, f)).mtimeMs < since) continue;
      const l = transcriptLimit(join(subs, f));
      if (l) return l;
    }
  }
  return null;
}

// Koszt z transkryptów Claude Code (format nieudokumentowany, jak w dawnym skrypcie analizy transkryptów): mln tokenów
// ekwiwalentu inputu, wagi Opus: input 1, zapis cache 5 min 1,25, 1 h 2, odczyt 0,05, output 5; wywołania po requestId.
export const COST_W = { inp: 1, cw5: 1.25, cw1: 2, cr: 0.05, out: 5 };
// `win` ({from, to}, ISO): tylko wywołania z tego okna (sesja /dwmt:uat liczona od biletu do zapisu wyniku).
// `seen` wspólne dla łańcucha sesji (kontynuacja kopiuje wcześniejsze wpisy z tymi samymi requestId).
function transcriptCalls(file, main, win = null, seen = new Map()) {
  const before = seen.size;
  for (const line of read(file).split(/\r?\n/)) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const u = d?.message?.usage;
    const rid = d?.requestId || d?.message?.id;
    if (d?.type !== 'assistant' || (main && d.isSidechain) || !u || seen.has(rid)) continue;
    if (win && (!d.timestamp || d.timestamp < win.from || d.timestamp > win.to)) continue;
    const cc = u.cache_creation || {};
    seen.set(rid, { inp: u.input_tokens || 0, cw5: cc.ephemeral_5m_input_tokens || 0, cw1: cc.ephemeral_1h_input_tokens || 0, cr: u.cache_read_input_tokens || 0, out: u.output_tokens || 0 });
  }
  return [...seen.values()].slice(before);
}
// Przegląd 2026-10-04: rola sesji `claude -p --agent` sterownika z wpisu `agent-setting` (bez niego: orkiestrator) i następna
// sesja łańcucha z wpisu `continued-in` (sesja PO sprintu poprawek przeszła do nowego pliku; okno `callers` widziało 3 min).
function transcriptMeta(file) {
  const text = read(file);
  const role = /"type":"agent-setting","agentSetting":"([^"]+)"/.exec(text.slice(0, 4000))?.[1] ?? null;
  const next = [...text.matchAll(/"continuedInSessionId":"([\w-]+)"/g)].map((m) => m[1]);
  return { role, next };
}
const callsCost = (cs) => cs.reduce((a, c) => a + Object.entries(COST_W).reduce((b, [k, w]) => b + w * c[k], 0), 0);
const round2 = (x) => Math.round(x / 1e4) / 100;
export function sessionsCost(ids, root = process.env.DWMT_TRANSCRIPTS || join(homedir(), '.claude', 'projects'), win = null) {
  if (!existsSync(root)) return null;
  const projects = readdirSync(root).map((p) => join(root, p));
  const by = { orchestrator: 0 };
  let found = 0;
  const done = new Set();
  for (const id0 of asList(ids)) {
    const seen = new Map();
    let role = null;
    for (let id = id0; id && !done.has(id);) {
      done.add(id);
      const proj = projects.find((p) => existsSync(join(p, `${id}.jsonl`)));
      if (!proj) break;
      if (id === id0) found++;
      const file = join(proj, `${id}.jsonl`);
      const meta = transcriptMeta(file);
      role ??= meta.role ?? 'orchestrator';
      by[role] = (by[role] || 0) + callsCost(transcriptCalls(file, true, win, seen));
      const subs = join(proj, id, 'subagents');
      for (const f of existsSync(subs) ? readdirSync(subs).filter((x) => /^agent-.*\.jsonl$/.test(x)) : []) {
        let type = '?';
        try { type = JSON.parse(read(join(subs, f.replace(/\.jsonl$/, '.meta.json')))).agentType || '?'; } catch { /* brak meta */ }
        by[type] = (by[type] || 0) + callsCost(transcriptCalls(join(subs, f), false, win));
      }
      id = meta.next.find((x) => !done.has(x)) ?? null;
    }
  }
  if (!found) return null;
  const total = Object.values(by).reduce((a, b) => a + b, 0);
  return { total: round2(total), byRole: Object.fromEntries(Object.entries(by).filter(([, v]) => v > 0).map(([k, v]) => [k, round2(v)])), sessions: found };
}

// Przegląd 2026-10-09 (W-6): koszt sesji wywołującej (PO w trybie A) według tur, nie okna czasu. Okno {from, to} z
// `run.callers` kończyło się przy raporcie na `Date.now()`, więc jedna sesja PO prowadząca dwa przebiegi liczyła się w obu
// (sprint 12: 1,2 mln wobec ok. 0,25 własnych), a sesja kontynuowana trafiała do okna dopiero przy pierwszej komendzie
// zapisującej (phase-5: brak 16:17–06:08, ok. 0,4 mln). Reguła (deterministyczna): tura = od wiadomości użytkownika (nie
// wyniku narzędzia) do następnej; wywołanie API tury należy do przebiegu wspomnianego w wywołaniu narzędzia tej tury
// (identyfikator przebiegu w poleceniu, ścieżce, opisie): ostatniego wspomnianego przed nim, a przed pierwszą wzmianką
// do pierwszej; wzmianka kilku przebiegów naraz dzieli koszt po równo; tura bez wzmianki nie należy do żadnego.
// Tylko wywołania w życiu przebiegu (`win`: od `created` do końca `finish`, gdy już był): tura po scaleniu (PO wraca do
// raportu, UAT) nie jest kosztem sprintu.
// `events`: [{t, kind: 'prompt'|'mention'|'call', runs?, cost?}] w kolejności czasu. Wynik: mln (bez zaokrąglenia).
export function attributeCaller(events, runId, win = null) {
  let total = 0;
  let turn = [];
  const flush = () => {
    const ms = turn.filter((e) => e.kind === 'mention');
    if (ms.length) {
      let cur = ms[0];
      for (const e of turn) {
        if (e.kind === 'mention') cur = e;
        else if (e.kind === 'call' && cur.runs.includes(runId) && (!win?.from || e.t >= win.from) && (!win?.to || e.t <= win.to)) total += e.cost / cur.runs.length;
      }
    }
    turn = [];
  };
  for (const e of [...events].sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))) {
    if (e.kind === 'prompt') flush();
    turn.push(e);
  }
  flush();
  return total;
}

// Wzmianki przebiegów w tekście wywołania narzędzia: znane identyfikatory (katalogi przebiegów, gałęzie) z granicą słowa
// (`…-sp-12` nie trafia w `…-sp-12-2`).
export function mentionedRuns(text, known) {
  const s = String(text);
  return known.filter((id) => s.includes(id) && new RegExp(`(?<![\\w.-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-]|\\.\\w)`).test(s));
}

// Zdarzenia sesji wywołującej (łańcuch `continued-in`, podagenci) dla attributeCaller.
// `seen` i `done` wspólne dla wszystkich sesji wywołujących przebiegu: sesja kontynuowana kopiuje wpisy poprzedniej
// (phase-5: 0b413e91 z kopią 24fbf8fd), więc wywołanie liczy się raz.
function callerEvents(id0, known, projects, seen = new Set(), done = new Set()) {
  const out = [];
  for (let id = id0; id && !done.has(id);) {
    done.add(id);
    const proj = projects.find((p) => existsSync(join(p, `${id}.jsonl`)));
    if (!proj) break;
    const file = join(proj, `${id}.jsonl`);
    for (const line of read(file).split(/\r?\n/)) {
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      // Wpisy meta (treść skilla, przypomnienia) i streszczenie po kompakcji to nie wiadomości użytkownika.
      if (!d?.timestamp || d.isSidechain || d.isMeta || d.isCompactSummary) continue;
      const c = d.message?.content;
      if (d.type === 'user') {
        if (!(Array.isArray(c) && c.some((b) => b?.type === 'tool_result'))) out.push({ t: d.timestamp, kind: 'prompt' });
        continue;
      }
      if (d.type !== 'assistant') continue;
      for (const b of Array.isArray(c) ? c : []) {
        if (b?.type !== 'tool_use') continue;
        const runs = mentionedRuns(JSON.stringify(b.input ?? {}), known);
        if (runs.length) out.push({ t: d.timestamp, kind: 'mention', runs });
      }
      const u = d.message?.usage;
      const rid = d.requestId || d.message?.id;
      if (!u || seen.has(rid)) continue;
      seen.add(rid);
      out.push({ t: d.timestamp, kind: 'call', cost: callsCost(usageOf([u])) });
    }
    const subs = join(proj, id, 'subagents');
    for (const f of existsSync(subs) ? readdirSync(subs).filter((x) => /^agent-.*\.jsonl$/.test(x)) : []) {
      for (const line of read(join(subs, f)).split(/\r?\n/)) {
        let d;
        try { d = JSON.parse(line); } catch { continue; }
        const u = d?.message?.usage;
        const rid = d?.requestId || d?.message?.id;
        if (d?.type !== 'assistant' || !u || !d.timestamp || seen.has(rid)) continue;
        seen.add(rid);
        out.push({ t: d.timestamp, kind: 'call', cost: callsCost(usageOf([u])) });
      }
    }
    id = transcriptMeta(file).next.find((x) => !done.has(x)) ?? null;
  }
  return out;
}
const usageOf = (us) => us.map((u) => { const cc = u.cache_creation || {}; return { inp: u.input_tokens || 0, cw5: cc.ephemeral_5m_input_tokens || 0, cw1: cc.ephemeral_1h_input_tokens || 0, cr: u.cache_read_input_tokens || 0, out: u.output_tokens || 0 }; });

// Koszt sesji wywołujących przebiegu `runId` (mln, zaokrąglony) albo null bez transkryptów. `known`: identyfikatory
// przebiegów projektu (z `runId`).
export function callerCost(ids, runId, known, win = null, root = process.env.DWMT_TRANSCRIPTS || join(homedir(), '.claude', 'projects')) {
  if (!existsSync(root)) return null;
  const projects = readdirSync(root).map((p) => join(root, p));
  const all = [...new Set([runId, ...asList(known)])];
  const seen = new Set();
  const done = new Set();
  const events = [];
  let found = 0;
  for (const id of asList(ids)) {
    if (!projects.some((p) => existsSync(join(p, `${id}.jsonl`)))) continue;
    found++;
    events.push(...callerEvents(id, all, projects, seen, done));
  }
  return found ? round2(attributeCaller(events, runId, win)) : null;
}

// D4 (cena eksploratora, spec warstwy produktowej §4.11 pkt 4): koszt każdego subagenta danego typu osobno (mln) w sesjach
// przebiegu (pod sterownikiem eksploratorzy są subagentami sesji architekta, która też jest w `session_ids`).
export function agentCosts(ids, type, root = process.env.DWMT_TRANSCRIPTS || join(homedir(), '.claude', 'projects')) {
  if (!existsSync(root)) return [];
  const projects = readdirSync(root).map((p) => join(root, p));
  const out = [];
  for (const id of asList(ids)) {
    const proj = projects.find((p) => existsSync(join(p, `${id}.jsonl`)));
    if (!proj) continue;
    const subs = join(proj, id, 'subagents');
    for (const f of existsSync(subs) ? readdirSync(subs).filter((x) => /^agent-.*\.jsonl$/.test(x)) : []) {
      let t = '?';
      try { t = JSON.parse(read(join(subs, f.replace(/\.jsonl$/, '.meta.json')))).agentType || '?'; } catch { /* brak meta */ }
      if (t === type) out.push(round2(callsCost(transcriptCalls(join(subs, f), false))));
    }
  }
  return out.filter((x) => x > 0);
}

// v3 (sterownik, `drive.mjs`): sesje agentów `claude -p` do `session_ids` przebiegu i bieżącego zadania, żeby koszt
// w raporcie i kopia odpowiedzi eksploratorów (`explore/`) widziały ich transkrypty.
export function cmdSessionsAdd(top, id, sids) {
  const run = loadRun(top, id);
  const t = isLegacy(run) ? null : run.tasks.find((x) => x.k === run.task);
  const added = [];
  for (const s of sids.filter((x) => /^[\w-]+$/.test(x))) {
    if (!run.session_ids.includes(s)) { run.session_ids.push(s); added.push(s); }
    if (t && !t.sessions.includes(s)) t.sessions.push(s);
  }
  saveRun(top, run);
  return { ok: true, added };
}

// v2.9 (§5.10): sesja uruchomiona przez `launch` zatrzymuje sesje `--bg` wcześniejszych zadań tego przebiegu (`claude stop`,
// rozmowa zostaje do `claude attach`). Tylko sesje z `launches` (utworzone przez dwmt): sesji użytkownika ani supervisora
// skrypt nie zatrzymuje. Best effort: wynik komendy nie blokuje stanu, identyfikator trafia do `run.stoppedSessions`.
export function stopEarlierSessions(run) {
  const me = sessionId();
  const launches = asList(run.launches).map((l) => String(l.id ?? '')).filter(Boolean);
  const at = launches.findIndex((id) => me?.startsWith(id));
  if (!me || at < 0) return [];
  const done = new Set(asList(run.stoppedSessions));
  // Tylko poprzedniczki (wcześniejsze uruchomienia): późniejsza sesja może jeszcze pracować.
  const ids = [...new Set(launches.slice(0, at))].filter((id) => !done.has(id));
  if (!ids.length) return [];
  const [bin, pre] = process.env.DWMT_CLAUDE ? [process.execPath, [process.env.DWMT_CLAUDE]] : ['claude', []];
  for (const id of ids) spawnSync(bin, [...pre, 'stop', id], { encoding: 'utf8', timeout: 30e3, windowsHide: true });
  run.stoppedSessions = [...done, ...ids];
  return ids;
}

// v2.9: wtyczki inne niż dwmt wyłączone w sesji następczyni (`launch.lean`, domyślnie tak). Sonda `claude -p` w projekcie testowym: start
// 40,0k → 36,9k tokenów (inne wtyczki i MCP); większy zysk to pamięć (bez 2 procesów Playwright MCP) i brak hooków innych wtyczek.
export function leanPlugins(top) {
  const files = [join(process.env.DWMT_CLAUDE_HOME || join(homedir(), '.claude'), 'settings.json'), join(top, '.claude', 'settings.json'), join(top, '.claude', 'settings.local.json')];
  const names = new Set();
  for (const f of files) {
    try { for (const [k, v] of Object.entries(JSON.parse(stripJsonComments(read(f))).enabledPlugins ?? {})) if (v) names.add(k); } catch { /* brak pliku */ }
  }
  return Object.fromEntries([...names].filter((n) => !/^dwmt(@|$)/.test(n)).map((n) => [n, false]));
}

// v2.10: nazwa sesji czytelna na telefonie: `dwmt <przebieg bez daty, ≤ 24 znaki> · T-k/N`.
export function sessionName(run) {
  const id = String(run.sprint ?? run.run).replace(/^\d{4}-\d{2}-\d{2}-/, '');
  const short = id.length > 24 ? `${id.slice(0, 23)}…` : id;
  const k = isLegacy(run) ? null : run.task;
  return `dwmt ${short}${k ? ` · T-${k}${run.count ? `/${run.count}` : ''}` : ''}`;
}

// T-OOM1 (docs/capabilities.md): przy braku pamięci Claude Code zatrzymuje polecenia `run_in_background` bezczynnej sesji
// (przestoje w dwóch projektach testowych). Decyzja 2026-10-04: sesje `launch` startują z wyłącznikiem, w `--settings` i w środowisku procesu.
export const LAUNCH_ENV = { CLAUDE_CODE_DISABLE_NOTIFICATION_PRESENCE_CHECK: '1', CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP: '1' };

// Sesja następczyni po zadaniu (§5.10): `claude --bg` w tym samym drzewie, bez shella; id ze stdout.
// v2.10 (sonda T-RC1): przy `remoteControlAtStartup: true` sesja `--bg` sama łączy się z Remote Control.
// K5 D-8: `attempt` (2 = the launch watcher's one relaunch) goes to the launch record and to the watcher started after a
// successful launch (`dwmt launch-watch`, detached; `DWMT_LAUNCH_WATCH=off` is the test seam).
export function cmdLaunch(top0, id, { attempt = 1 } = {}) {
  // Recenzja N-4: przebieg z `init --worktree` ma katalog w swoim worktree; `launch` z głównego drzewa go tam znajduje.
  const wt = !existsSync(join(runDir(top0, id), 'run.json')) && /^[\w.-]+$/.test(id) ? worktreeFor(top0, `${loadConfig(top0).git.branchPrefix}${id}`) : null;
  const top = wt ?? top0;
  const run = loadRun(top, id);
  const cfg = loadConfig(top);
  const name = sessionName(run);
  const lean = cfg.launch?.lean !== false;
  const off = lean ? leanPlugins(top) : {};
  // T-4 (D-9): znacznik sesji przebiegu dla strażnika `guard-destructive`, w `--settings` i w środowisku procesu.
  const env = { ...LAUNCH_ENV, DWMT_RUN: id };
  const settings = { worktree: { bgIsolation: 'none' }, env, ...(Object.keys(off).length ? { enabledPlugins: off } : {}) };
  const pm = cfg.launch?.permissionMode;
  // v2.9: bez serwerów MCP (dwmt ich nie używa; Playwright MCP z wtyczek to 2 procesy node na sesję).
  const args = ['--bg', '-n', name, '--model', cfg.model, '--effort', 'high', '--plugin-dir', fwd(ROOT), ...(pm ? ['--permission-mode', pm] : []), ...(lean ? ['--strict-mcp-config'] : []), `/dwmt:execute ${id}`, '--settings', JSON.stringify(settings)];
  const [bin, argv] = process.env.DWMT_CLAUDE ? [process.execPath, [process.env.DWMT_CLAUDE, ...args]] : ['claude', args];
  const r = spawnSync(bin, argv, { cwd: top, encoding: 'utf8', timeout: 120e3, env: { ...process.env, ...env }, windowsHide: true });
  clearGitMemo();
  // Sesja w tle ma kolory: `claude --bg` barwi id kodami ANSI (sprint 11: 3 z 4 id w `launches`).
  const out = [r.stdout, r.stderr, r.error?.message].filter(Boolean).join('\n').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const m = /backgrounded\s*·\s*(\S+)\s*·/.exec(out);
  if (!m) return { ok: false, error: `claude --bg bez identyfikatora sesji (exit ${r.status ?? '?'})`, output: trimOutput(out, 5).lines, hint: 'awaryjnie: /clear i /dwmt:execute <run>' };
  const fresh = JSON.parse(read(join(runDir(top, id), 'run.json')));
  const launched = { id: m[1], at: new Date().toISOString(), task: fresh.task, ...(attempt > 1 ? { attempt } : {}) };
  fresh.launches = [...asList(fresh.launches), launched];
  if (fresh.handoff) fresh.handoff.launched = launched;
  saveRun(top, fresh);
  const watch = process.env.DWMT_LAUNCH_WATCH === 'off' ? null : spawnDetached(process.execPath, [join(ROOT, 'scripts', 'dwmt.mjs'), 'launch-watch', id, m[1], '--attempt', String(attempt)], { cwd: top, env: watcherEnv() });
  return { ok: true, id: m[1], name, attach: `claude attach ${m[1]}`, ...(wt ? { worktree: wt } : {}), ...(watch ? { watcher: true } : {}) };
}

// D4 (spec warstwy produktowej §9, P narzutu szacowania): koszt (mln) pierwszego wywołania API agenta danego typu po
// chwili `at` (ISO) w sesjach przebiegu: subagenci z meta `agentType` oraz sesje `claude -p --agent` sterownika, których
// pierwszy prompt jest promptem architekta (zawiera `Explorer type: dwmt-explorer`). null = brak takiego wywołania.
// `before` (ISO, recenzja N-4): wywołanie późniejsze niż koniec tury ceny (np. replan) nie jest jej kosztem.
export function firstAgentCallAfter(ids, type, at, root = process.env.DWMT_TRANSCRIPTS || join(homedir(), '.claude', 'projects'), before = null) {
  if (!existsSync(root)) return null;
  const projects = readdirSync(root).map((p) => join(root, p));
  let best = null;
  const scan = (file) => {
    for (const line of read(file).split(/\r?\n/)) {
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      const u = d?.message?.usage;
      if (d?.type !== 'assistant' || !u || !d.timestamp || d.timestamp <= at) continue;
      if (before && d.timestamp > before) break;
      if (!best || d.timestamp < best.at) {
        const cc = u.cache_creation || {};
        best = { at: d.timestamp, cost: callsCost([{ inp: u.input_tokens || 0, cw5: cc.ephemeral_5m_input_tokens || 0, cw1: cc.ephemeral_1h_input_tokens || 0, cr: u.cache_read_input_tokens || 0, out: u.output_tokens || 0 }]) };
      }
      break;
    }
  };
  const firstUser = (file) => {
    for (const line of read(file).split(/\r?\n/)) {
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      if (d?.type !== 'user') continue;
      const c = d.message?.content;
      return typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
    }
    return '';
  };
  for (const id of asList(ids)) {
    const proj = projects.find((p) => existsSync(join(p, `${id}.jsonl`)));
    if (!proj) continue;
    if (type === 'dwmt-architect' && /Explorer type: dwmt-explorer/.test(firstUser(join(proj, `${id}.jsonl`)))) scan(join(proj, `${id}.jsonl`));
    const subs = join(proj, id, 'subagents');
    for (const f of existsSync(subs) ? readdirSync(subs).filter((x) => /^agent-.*\.jsonl$/.test(x)) : []) {
      let t = '?';
      try { t = JSON.parse(read(join(subs, f.replace(/\.jsonl$/, '.meta.json')))).agentType || '?'; } catch { /* brak meta */ }
      if (t === type) scan(join(subs, f));
    }
  }
  return best ? round2(best.cost) : null;
}

// D4 (spec warstwy produktowej §5.1, koszt szacunku): koszt (mln) subagentów sesji `ids`, których pierwszy prompt zawiera
// `needle` (np. ścieżkę `result.md` szacunku). null = brak transkryptu albo takiego subagenta.
export function subagentCostByPrompt(ids, needle, root = process.env.DWMT_TRANSCRIPTS || join(homedir(), '.claude', 'projects')) {
  if (!existsSync(root) || !needle) return null;
  const projects = readdirSync(root).map((p) => join(root, p));
  let total = 0;
  let found = 0;
  for (const id of asList(ids)) {
    const proj = projects.find((p) => existsSync(join(p, `${id}.jsonl`)));
    if (!proj) continue;
    const subs = join(proj, id, 'subagents');
    for (const f of existsSync(subs) ? readdirSync(subs).filter((x) => /^agent-.*\.jsonl$/.test(x)) : []) {
      const file = join(subs, f);
      let first = '';
      for (const line of read(file).split(/\r?\n/)) {
        let d;
        try { d = JSON.parse(line); } catch { continue; }
        if (d?.type !== 'user') continue;
        const c = d.message?.content;
        first = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
        break;
      }
      if (!first.replace(/\\/g, '/').includes(needle.replace(/\\/g, '/'))) continue;
      total += callsCost(transcriptCalls(file, false));
      found++;
    }
  }
  return found ? round2(total) : null;
}
