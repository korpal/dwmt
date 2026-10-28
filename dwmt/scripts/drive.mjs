#!/usr/bin/env node
// dwmt v3 (sterownik; projekt: docs/dwmt-v3-plan.md, na masterze od N-2): orkiestrator jako skrypt, włączany
// `drive.enabled: true` w `.claude/dwmt.json` (domyślnie false: projekt działa jak v2.10).
// Pętla robi to, co skill `execute`: `state`, agent z promptem ze stanu, `verify`, `review-input`, `commit`, `finish`.
// Agent rusza jako osobna sesja `claude -p --agent <typ>` z modelem i effortem roli (sonda 2026-10-03: `--agent` bierze
// model z frontmattera, effort tylko z flagi), wynik to JSON z `session_id`. Architekt po przerwie na odpowiedzi wraca
// przez `--resume` (jak SendMessage), przy replanie zadania k > 1 jest świeży (jak w nowej sesji orkiestratora).
// Pytania do użytkownika, decyzje (czerwona suita, konflikt, środowisko) i limit abonamentu zatrzymują pętlę ze statusem
// `waiting-user` albo `stopped`; użytkownik odpowiada w `/dwmt:execute <run>`, a skill uruchamia sterownik ponownie.
// sprinty 6+7: orkiestratory LLM 3,67 mln (12%) i 12 sesji `--bg` po ok. 0,85 GB RAM; sterownik to jeden proces node.
// N-2: dziennik zdarzeń v2.10 (`drive-start`, `drive-stop` z `status`, `reason`, `cause`), blokada `drive.lock`
// {pid, pidStart}, dzieci (agenci) z PID w `drive.json`. Śmierć dziecka (agent albo komenda dwmt bez wyniku, agent bez
// swojego pliku wyjścia, architekt bez postępu) zatrzymuje sterownik z powodem, bez ponawiania (decyzja użytkownika A).
// `drive.hold` (supervisor R4): przed pierwszym agentem nowego zadania sterownik kończy się statusem `hold` (kod 3); plik
// sprawdza `dwmt state` (`st.held`), więc wstrzymane zadanie nie emituje `task-start` (recenzja S3).
// S3: pod supervisorem (`run.sprint`) krok `planned` kończy sterownik statusem `planned` (kod 4), bez pytania użytkownika.
// Recenzja N-2: blokada wyłączna (`wx`); świeży agent dostaje `--session-id` zapisany w przebiegu przed startem (koszt
// i przyrost widać także po jego śmierci); dzieci poprzedniego sterownika giną na starcie; agenci bez innych wtyczek
// (`launch.lean`) i bez stdin; limit sprawdzany przy każdym wyniku agenta; wynik `finish` w `drive.json.stopped.finish`.
// Przegląd 2026-10-09: `--max-turns` z roli, limit tur wykonawcy = zwykłe zatrzymanie i `continue` (W-1); jedna naprawa przy
// `finish` z czerwienią albo konfliktem (W-2, `lib/finish-repair.mjs`); alarm ceny po krokach z agentem (W-3).
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, appendFileSync, mkdirSync, rmSync, openSync, statSync, closeSync, readSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig, runDir, topOf, runEvent, transcriptLimit, leanPlugins } from './dwmt.mjs';
import { ARCHITECT } from './plan.mjs';
import { processAlive, transcriptFiles, readDriveLock, acquireDriveLock, killTree, readDriveMem, writeDriveMem } from './watch.mjs';
import { writeFileAtomic } from './lib/util.mjs';
import { isRepairable } from './lib/finish-repair.mjs';
import { runTop, runHome } from './lib/run.mjs';
import { ensureLive } from './lib/live.mjs';
import { sessionsCost } from './lib/sessions.mjs';
import { bgName, bgArgs, startBg, waitBg, closeBg } from './lib/bg-agent.mjs';
import { SESSION_FAILURES, notifyFailure } from './lib/launch-watch.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DWMT = join(ROOT, 'scripts', 'dwmt.mjs');
const fwd = (p) => String(p).replace(/\\/g, '/');
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const mtime = (f) => { try { return statSync(f).mtimeMs; } catch { return 0; } };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const AGENT_STEPS = ['plan', 'replan', 'implement', 'fix', 'continue', 'repair', 'batch', 'goal-check'];
const USER_STEPS = ['ask-plan', 'ask', 'ask-rounds', 'ask-delete', 'planned'];
// Przegląd 2026-10-09 (W-1): kroki wykonawcy, po których limit tur to zwykłe zatrzymanie (świeży wykonawca kontynuuje).
const EXECUTOR_STEPS = ['implement', 'fix', 'continue', 'repair', 'batch'];
const MAX_STEPS = 400;

// Komenda dwmt zakończona bez wyniku JSON (zabita z zewnątrz, np. brak pamięci): koniec pętli z powodem.
class ChildDead extends Error {
  constructor(child) { super(child.reason); this.child = child; }
}

// Model, effort i limit tur roli z configu (jak renderAgents): `dwmt-executor-high` → rola `executor-high` (from executor).
// Przegląd 2026-10-09 (W-1): `maxTurns` z frontmattera nie działa w sesji `claude -p --agent` (wykonawca sprint V: 369
// wywołań, 8,95 mln), więc sterownik podaje go flagą; wartość ta sama co we frontmatterze (renderAgents: domyślnie 100).
export function roleOf(cfg, agent) {
  const role = String(agent).replace(/^dwmt-/, '');
  const r = cfg.roles?.[role];
  if (!r) return { model: cfg.model, effort: 'high' };
  const base = r.from ? cfg.roles[r.from] ?? {} : r;
  return { model: r.model || base.model || cfg.model, effort: r.effort ?? base.effort ?? 'high', maxTurns: r.maxTurns ?? base.maxTurns ?? 100 };
}

// Argumenty `claude -p` dla agenta: świeży (`--agent`, `--session-id` nadany przez sterownik) albo wznowiony (`--resume`);
// zawsze plugin (hooki), bez MCP; `plugins`: wtyczki wyłączone jak w sesji `launch` (`launch.lean`, v2.9).
// `deny`: narzędzia odebrane agentowi (od przeglądu sprintu 16 (UI) sterownik nie odbiera architektowi Agent: eksploratorzy według obszaru).
// `--max-turns` (ukryta flaga, sonda 2026-10-09): limit tur roli także dla wznowionego architekta.
export function agentArgs({ cfg, agent, prompt, resume = null, sessionId = null, plugins = {}, deny = [] }) {
  const { model, effort, maxTurns } = roleOf(cfg, agent);
  const pm = cfg.drive?.permissionMode ?? cfg.launch?.permissionMode ?? 'auto';
  return ['-p', prompt, '--output-format', 'json', '--plugin-dir', fwd(ROOT), '--strict-mcp-config', ...(deny.length ? ['--disallowedTools', deny.join(',')] : []),
    ...(pm ? ['--permission-mode', pm] : []), ...(resume ? ['--resume', resume] : ['--agent', agent, ...(sessionId ? ['--session-id', sessionId] : [])]),
    ...(Object.keys(plugins ?? {}).length ? ['--settings', JSON.stringify({ enabledPlugins: plugins })] : []),
    ...(maxTurns ? ['--max-turns', String(maxTurns)] : []), '--model', model, '--effort', effort];
}

// Środowisko procesu agenta: bez identyfikatora sesji sterownika (agent dostaje własną sesję) i z czasem życia cache.
// Przegląd sprintu 16 (UI): `claude -p` pisze cache na 1 h (zapis 2× zamiast 1,25×), czyli 4,3 z 12,4 mln sprintu. Role robocze
// (wykonawcy, recenzenci, weryfikator UI, kontrola celu) wołają model co kilka sekund, dłuższe przerwy to rzadkie długie
// testy: `drive.workerCacheTtl` (domyślnie 5m). Architekt zostaje przy domyślnym 1 h: czeka na odpowiedzi użytkownika
// i wraca z `--resume`. Orkiestratorów (sesja PO, supervisor) sterownik nie uruchamia, więc ich to nie dotyczy.
export function agentEnv(base, cfg, agent, run = null) {
  const env = { ...base };
  delete env.CLAUDE_CODE_SESSION_ID;
  // T-4 (D-9): znacznik sesji przebiegu dla strażnika `guard-destructive`.
  if (run) env.DWMT_RUN = run;
  const ttl = cfg.drive?.workerCacheTtl;
  if (agent !== ARCHITECT && ttl && !env.CLAUDE_CODE_PROMPT_CACHE_TTL) env.CLAUDE_CODE_PROMPT_CACHE_TTL = ttl;
  return env;
}

// Ostatnia linia `REPLAN: changed|unchanged <T-ids>; cause: <klasa>` z odpowiedzi architekta.
export function parseReplan(text) {
  const m = [...String(text ?? '').matchAll(/REPLAN:\s*(changed|unchanged)\b[^;\n]*;\s*cause:\s*(plan|discovery|target)\b/gi)].pop();
  return m ? { result: m[1].toLowerCase(), cause: m[2].toLowerCase() } : null;
}

// Wynik procesu agenta: `ok`, albo przyczyna `dead` (koniec bez wyniku JSON: zabity, awaria), `max-turns` (limit tur:
// `subtype: error_max_turns`, `terminal_reason: max_turns`), `error` (`is_error`, np. limit abonamentu), `timeout`
// (`drive.agentTimeoutMin`), `spawn` (brak `claude`).
export function agentOutcome({ code, signal = null, out = '', err = '', timedOut = false, spawnError = null, timeoutMin = null }) {
  if (spawnError) return { ok: false, cause: 'spawn', error: `nie można uruchomić agenta: ${spawnError}` };
  let j = null;
  try { j = JSON.parse(String(out).trim().split(/\r?\n/).pop()); } catch { /* bez JSON */ }
  const base = { code, result: j?.result ?? '', sessionId: j?.session_id ?? null, costUsd: j?.total_cost_usd ?? null };
  if (timedOut) return { ...base, ok: false, cause: 'timeout', error: `limit czasu agenta ${timeoutMin} min (drive.agentTimeoutMin)` };
  if (!j || typeof j !== 'object') {
    return { ...base, ok: false, cause: 'dead', error: `proces zakończył się bez wyniku (exit ${code ?? '-'}${signal ? `, ${signal}` : ''})${err ? `: ${String(err).trim().slice(0, 200)}` : ''}` };
  }
  if (j.subtype === 'error_max_turns' || j.terminal_reason === 'max_turns') return { ...base, ok: false, cause: 'max-turns', error: 'limit tur (--max-turns)' };
  if (code !== 0 || j.is_error) return { ...base, ok: false, cause: 'error', error: String(j.result || err || out).trim().slice(0, 400) };
  return { ...base, ok: true, cause: null, error: null };
}

export class Driver {
  constructor(top, id, { log = null, env = process.env } = {}) {
    this.top = fwd(top);
    this.id = id;
    this.env = env;
    this.root = runDir(this.top, id);
    this.cfg = loadConfig(this.top);
    this.stateFile = join(this.root, 'drive.json');
    this.logFile = log ?? join(this.root, 'drive.log');
    try { this.mem = JSON.parse(readFileSync(this.stateFile, 'utf8')); } catch { this.mem = {}; }
    this.normMem();
    this.prevArch = null;
    this.prevInvalid = null;
    this.invalidRuns = 0;
    this.lastFinish = null;
    this.plugins = this.cfg.launch?.lean !== false ? leanPlugins(this.top) : {};
  }

  // Pola pamięci zawsze obecne. `--detach` zapisuje szkielet `drive.json` (sam `detachedAt`) przed startem sterownika, więc
  // odczyt pliku nie może zastępować wartości domyślnych (2026-10-04: `mem.agents` undefined po architekcie;
  // `steps`/`cost` jako NaN → null w pliku).
  normMem() {
    const d = { agents: {}, steps: 0, cost: 0, children: {}, cuts: {} };
    for (const [k, v] of Object.entries(d)) if (this.mem[k] == null || (typeof v === 'number' && !Number.isFinite(this.mem[k]))) this.mem[k] = v;
  }

  log(line) {
    const s = `${new Date().toISOString()} ${line}`;
    appendFileSync(this.logFile, `${s}\n`);
    if (!this.env.DWMT_DRIVE_QUIET) console.log(s);
  }

  // Zapis atomowy: sterownik zabity w trakcie zapisu nie zostawia uciętego drive.json (czyta go `dwmt wait` i następny start);
  // Windows: ponowienia przy EPERM, gdy `dwmt wait` akurat czyta plik (jak run.json).
  save() {
    writeFileAtomic(this.stateFile, `${JSON.stringify(this.mem, null, 2)}\n`);
  }

  run() { return JSON.parse(readFileSync(join(this.root, 'run.json'), 'utf8')); }

  event(type, detail) {
    try { runEvent(this.top, this.run(), type, { detail }); } catch { /* dziennik nigdy nie psuje pętli */ }
  }

  // Identyfikator „sesji” wywołań skryptu: jeden na zadanie, więc architekt jest świeży przy replanie zadania k > 1
  // (`architectFresh`), a `handoff` po commicie znika w następnej iteracji (zadanie k+1 ma inny identyfikator).
  sid() { return `drive-${this.id}-T${this.run().task ?? 1}`; }

  // Komenda dwmt; brak wyniku JSON = komenda zginęła (`ChildDead`), a błąd z wynikiem `{ok: false}` to zwykły wynik.
  dwmt(...args) {
    const r = spawnSync(process.execPath, [DWMT, ...args], { cwd: this.top, encoding: 'utf8', env: { ...this.env, CLAUDE_CODE_SESSION_ID: this.sid() }, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    try { return JSON.parse(r.stdout); } catch {
      const why = `exit ${r.status ?? '-'}${r.signal ? `, ${r.signal}` : ''}${r.error ? `, ${r.error.message}` : ''}`;
      throw new ChildDead({ kind: 'command', name: `dwmt ${args[0]}`, cause: 'dead', reason: `komenda \`dwmt ${args[0]}\` zakończyła się bez wyniku (${why})${r.stderr ? `: ${r.stderr.trim().slice(0, 200)}` : ''}` });
    }
  }

  // K4 T-5 (D-3, D-29): agent jako sesja Claude w tle (`claude --bg`, widać ją w `claude agents`), a przy
  // `drive.agentSessions: "headless"` albo nieudanym starcie w tle (linia w drive.log) ukryty `claude -p`. Ten sam kształt
  // wyniku w obu trybach (D-30). `meta`: etykieta i miejsce w sprincie do nazwy sesji (D-31).
  async agent(agent, prompt, resume = null, sessionId = null, meta = {}) {
    if (this.cfg.drive?.agentSessions !== 'headless') {
      const r = await this.agentBg(agent, prompt, resume, meta);
      if (r) return r;
    }
    if (sessionId) this.dwmt('sessions-add', this.id, sessionId);
    return this.agentHeadless(agent, prompt, resume, sessionId);
  }

  // D-10, D-30: start jak `launch` (nazwa z miejsca w sprincie, env w `--settings`), koniec tury i wynik z transkryptu,
  // limit tur i czasu pilnuje sterownik (`claude stop`), po kroku `claude stop` + `claude rm`. null = start w tle nieudany.
  async agentBg(agent, prompt, resume, meta) {
    const label = meta.label ?? agent;
    const { model, effort, maxTurns } = roleOf(this.cfg, agent);
    const env = agentEnv(this.env, this.cfg, agent, this.id);
    // Środowisko rodzica nie dociera do sesji w tle (T-S1): zmienne dwmt i czas życia cache idą w `--settings` `env`.
    const pass = Object.fromEntries(Object.entries(env).filter(([k]) => /^DWMT_/.test(k) || k === 'CLAUDE_CODE_PROMPT_CACHE_TTL'));
    let name = agent;
    try { name = bgName({ run: this.run(), task: meta.task ?? null, round: meta.round ?? null, step: meta.step ?? 'agent', batch: !!meta.batch, agent, lang: this.cfg.language }); } catch { /* run.json w zapisie */ }
    const pm = this.cfg.drive?.permissionMode ?? this.cfg.launch?.permissionMode ?? 'auto';
    const since = new Date().toISOString();
    const s = startBg(bgArgs({ name, prompt, agent, resume, root: ROOT, model, effort, permissionMode: pm, plugins: this.plugins, env: pass }), { cwd: this.top, env });
    if (!s.ok) { this.log(`${label}: background start failed (${s.error}); ${agent} runs hidden (claude -p)`); return null; }
    const key = `bg:${s.id}`;
    this.mem.children[key] = { kind: 'bg', id: s.id, agent, name, start: since, session: resume };
    this.save();
    this.log(`${label}: ${agent} w tle: ${name} (claude attach ${s.id})`);
    const timeoutMin = this.cfg.drive?.agentTimeoutMin ?? 240;
    const firstStepMin = this.cfg.drive?.firstStepMin ?? 5;
    const pollMs = Number(this.env.DWMT_BG_POLL_MS) || 3000;
    let r;
    try {
      r = await waitBg(s.id, {
        cwd: this.top, env, since, maxTurns, timeoutMin, firstStepMin, pollMs,
        onSession: (sid) => {
          if (this.mem.children[key]) this.mem.children[key].session = sid;
          this.save();
          try { this.dwmt('sessions-add', this.id, sid); } catch { /* koszt w raporcie: best effort */ }
        },
        onWaiting: () => {
          this.log(`${label}: ${agent} czeka na zgodę albo odpowiedź: claude attach ${s.id}`);
          this.event('agent-waiting', { agent, id: s.id, name, attach: `claude attach ${s.id}` });
        },
      });
    } finally {
      await closeBg(s.id, { cwd: this.top, env });
      delete this.mem.children[key];
      this.save();
    }
    return { ...r, registered: true, bg: true };
  }

  // Agent jako osobny proces `claude -p`; wynik JSON (`result`, `session_id`, `total_cost_usd`, `is_error`). PID dziecka
  // w `drive.json.children` na czas pracy (supervisor i człowiek widzą, kto pracuje).
  agentHeadless(agent, prompt, resume = null, sessionId = null) {
    const args = agentArgs({ cfg: this.cfg, agent, prompt, resume, sessionId, plugins: this.plugins });
    const [bin, argv] = this.env.DWMT_CLAUDE ? [process.execPath, [this.env.DWMT_CLAUDE, ...args]] : ['claude', args];
    const timeoutMin = this.cfg.drive?.agentTimeoutMin ?? 240;
    return new Promise((done) => {
      // Agent dostaje własną sesję: identyfikator sesji, z której uruchomiono sterownik, nie przechodzi do niego.
      const env = agentEnv(this.env, this.cfg, agent, this.id);
      let out = '';
      let err = '';
      let timedOut = false;
      let finished = false;
      // stdin zamknięty: `claude -p` z otwartym potokiem czeka ok. 3 s na wejście.
      const p = spawn(bin, argv, { cwd: this.top, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const end = (o) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (p.pid) delete this.mem.children[p.pid];
        done(agentOutcome({ ...o, out, err, timedOut, timeoutMin }));
      };
      const timer = setTimeout(() => { timedOut = true; killTree(p.pid); }, timeoutMin * 60e3);
      if (p.pid) { this.mem.children[p.pid] = { kind: 'agent', agent, start: new Date().toISOString(), session: sessionId ?? resume }; this.save(); }
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', (e) => end({ code: null, spawnError: e.message }));
      p.on('close', (code, signal) => end({ code, signal }));
    });
  }

  // Limit abonamentu z transkryptu agenta (T-S12: `error: rate_limit`, `quotaLimits.resetsAt`), gdy go widać.
  agentLimit(sessionId) {
    if (!sessionId) return null;
    for (const f of transcriptFiles([sessionId], this.env.DWMT_TRANSCRIPTS || undefined)) {
      try { const l = transcriptLimit(f); if (l) return l; } catch { /* transkrypt w zapisie */ }
    }
    return null;
  }

  // Limit abonamentu sprawdzany przy każdym wyniku agenta (także `is_error: false`: tekst limitu jako wynik), przed
  // sprawdzeniem pliku wyjścia i linii REPLAN.
  limitStop(label, r) {
    const limit = this.agentLimit(r.sessionId);
    return limit ? this.stop('stopped', `${label}: limit abonamentu do ${limit.resetsAt}`, { cause: 'limit', resetsAt: limit.resetsAt }) : null;
  }

  // K5 D-7: only a background step, only error (not the subscription limit), no-start or dead.
  relaunchable(r) {
    if (!r?.bg || r.ok || !['error', 'no-start', 'dead'].includes(r.cause)) return false;
    if (r.cause === 'error' && /^rate_limit/.test(String(r.error ?? ''))) return false;
    return !this.agentLimit(r.sessionId);
  }

  failAgent(label, agent, r) {
    const what = { dead: 'zakończył się bez wyniku', 'no-start': 'nie zaczął pracy', timeout: 'przekroczył limit czasu', spawn: 'nie wystartował', error: 'zwrócił błąd', 'max-turns': 'doszedł do limitu tur' }[r.cause] ?? 'bez wyniku';
    return this.stop('stopped', `${label}: agent ${agent} ${what}: ${r.error}`, { cause: r.cause === 'error' ? 'agent-error' : r.cause === 'dead' ? 'child-dead' : r.cause, child: { kind: 'agent', name: agent } });
  }

  // W-1: wykonawca zatrzymany limitem tur to zwykłe zatrzymanie: `state` daje `continue` (świeży wykonawca od progress.md
  // i diff.patch), a naprawa (`repair`) idzie jeszcze raz. Bez pliku wyniku, więc bez sprawdzenia `noOutput`. Bezpiecznik:
  // `drive.maxTurnRestarts` kolejnych świeżych odcinków tej samej rundy (domyślnie 5), potem zatrzymanie dla użytkownika.
  turnsCut(label, st, agent) {
    const key = `${st.batch ? 'batch' : `T-${st.task}`}/r${st.round ?? 1}`;
    // Recenzja poprawek: licznik w drive.json (przeżywa ponowny start sterownika w tej samej rundzie).
    const n = (this.mem.cuts[key] ?? 0) + 1;
    this.mem.cuts[key] = n;
    this.save();
    const max = this.cfg.drive?.maxTurnRestarts ?? 5;
    const turns = roleOf(this.cfg, agent).maxTurns;
    if (n > max) return this.stop('stopped', `${label}: ${agent} ${n}. raz doszedł do limitu ${turns} tur w tej rundzie (drive.maxTurnRestarts ${max})`, { cause: 'max-turns', child: { kind: 'agent', name: agent } });
    this.log(`${label}: ${agent} doszedł do limitu ${turns} tur → świeży wykonawca kontynuuje od progress.md (${n}/${max})`);
    return null;
  }

  async step(st) {
    const label = `T-${st.task ?? '?'}${st.round ? ` r${st.round}` : ''} ${st.next}`;
    if (st.limit) return this.stop('stopped', `limit abonamentu do ${st.limit.resetsAt}`, { cause: 'limit', resetsAt: st.limit.resetsAt });
    // S3 (spec supervisora §4.4 R3): pod supervisorem (`--sprint`) `planned` znaczy „czekaj na zależności”, nie „pytaj
    // użytkownika”: koniec ze statusem `planned` (kod 4); po scaleniu zależności pętla uruchamia sterownik ponownie.
    if (st.next === 'planned' && this.run().sprint) { this.prevArch = null; return this.stop('planned', `${label}: ${st.hint ?? 'plan gotowy; czeka na zależności'}`, { waitingFor: asList(st.waitingFor) }); }
    if (USER_STEPS.includes(st.next)) { this.prevArch = null; return this.stop('waiting-user', `${label}: ${st.hint ?? 'decyzja użytkownika'} (${asList(st.questions ?? st.files).join(', ') || st.file || ''})`); }
    if (AGENT_STEPS.includes(st.next)) {
      if (!st.agent) return this.stop('waiting-user', `${label} bez agenta (inline albo brak planu): ${st.hint ?? ''}`);
      if (st.held) return this.stop('hold', `${label}: wstrzymane przed zadaniem (drive.hold)`);
      // Architekt, po którym stan daje ten sam krok z tym samym promptem: bez postępu (zapętlenie zamiast ponawiania).
      // Także poprawka planu przez wykonawcę trybu direct (`plan` bez architekta): ten sam krok drugi raz = bez postępu.
      const sig = st.agent === ARCHITECT || st.next === 'plan' ? JSON.stringify([st.next, st.task, st.key, st.prompt]) : null;
      if (sig && sig === this.prevArch) return this.stop('stopped', `${label}: ${st.agent} skończył bez postępu (stan daje ten sam krok)`, { cause: 'no-progress', child: { kind: 'agent', name: st.agent } });
      // Przegląd 2026-10-05 (sprint 5 T-2): wynik z nagłówkiem, który się nie parsuje. Agent dostaje błąd w prompcie; ten sam
      // błąd po nim albo trzeci niepoprawny wynik z rzędu to brak postępu (było: sześć sesji naprawy z tym samym poleceniem).
      const bad = st.invalid ? JSON.stringify([st.next, st.task, st.invalid.file, st.invalid.errors]) : null;
      if (bad && (bad === this.prevInvalid || this.invalidRuns >= 2)) {
        return this.stop('stopped', `${label}: ${st.agent} nie poprawił nagłówka ${st.invalid.file} (${asList(st.invalid.errors).join('; ')})`, { cause: 'no-progress', child: { kind: 'agent', name: st.agent } });
      }
      const before = st.output && !sig ? mtime(st.output) : null;
      const resume = st.key && !st.fresh ? this.mem.agents[st.key] ?? null : null;
      const r = await this.agentStep(label, st.agent, st.prompt, resume, { task: st.task, round: st.round, step: st.next, batch: !!st.batch });
      const lim = this.limitStop(label, r);
      if (lim) return lim;
      const cut = r.cause === 'max-turns' && EXECUTOR_STEPS.includes(st.next);
      if (!r.ok && !cut) return this.failAgent(label, st.agent, r);
      this.prevArch = sig;
      this.prevInvalid = bad;
      this.invalidRuns = bad ? this.invalidRuns + 1 : 0;
      if (st.key) this.mem.agents[st.key] = r.sessionId;
      if (cut) return this.turnsCut(label, st, st.agent);
      if (before != null && mtime(st.output) <= before) return this.noOutput(label, st.agent, st.output);
      if (st.next === 'replan') {
        const rp = parseReplan(r.result);
        if (!rp) return this.stop('waiting-user', `${label}: odpowiedź architekta bez linii REPLAN (sprawdź plany w /dwmt:execute)`);
        const d = this.dwmt('replan-done', this.id, String(st.from), '--result', rp.result, '--cause', rp.cause);
        this.log(`${label}: replan-done ${rp.result} ${rp.cause} → ${d.ok === false ? `błąd: ${d.hint ?? d.error}` : 'ok'}`);
      }
      return null;
    }
    this.prevArch = null;
    this.prevInvalid = null;
    this.invalidRuns = 0;
    switch (st.next) {
      case 'verify': {
        const v = this.dwmt('verify', this.id);
        this.log(`${label}: verify ${v.result ?? v.status ?? 'błąd'}${v.closing ? ' (closing)' : ''}${v.repair ? ' (naprawa)' : ''}${v.expectedRed ? ' (czerwień zapowiedziana)' : ''}`);
        if (v.status === 'conflict') return this.stop('waiting-user', `${label}: konflikt rebase (${asList(v.files).join(', ')})`);
        if (v.result === 'env') return this.stop('waiting-user', `${label}: środowisko niegotowe: ${asList(v.env).join('; ')}`);
        // kt (D-13): after the closing verify state decides (commit, repair or ask-rounds); no review-input.
        if (v.result === 'plan' || v.repair || v.closing) return null;
        if (v.ok === false && !v.result) return this.stop('stopped', `${label}: ${v.error ?? 'verify bez wyniku'}`);
        const ri = this.dwmt('review-input', this.id);
        if (ri.ok === false) return this.stop('stopped', `${label}: review-input: ${ri.error ?? ri.hint}`);
        return null;
      }
      case 'review': {
        const units = asList(st.units);
        const list = units.length ? units.map((u) => ({ label: `${label} ${u.unit}`, agent: u.agent, prompt: u.prompt, output: u.output, step: `review ${u.unit}` })) : [{ label, agent: st.agent, prompt: st.prompt, output: st.output, step: 'review' }];
        const before = list.map((u) => (u.output ? mtime(u.output) : null));
        const rs = await Promise.all(list.map((u) => this.agentStep(u.label, u.agent, u.prompt, null, { task: st.task, round: st.round, step: u.step, batch: !!st.batch })));
        for (let i = 0; i < rs.length; i++) { const lim = this.limitStop(list[i].label, rs[i]); if (lim) return lim; }
        const bad = rs.findIndex((r) => !r.ok);
        if (bad >= 0) return this.failAgent(list[bad].label, list[bad].agent, rs[bad]);
        const silent = list.findIndex((u, i) => before[i] != null && mtime(u.output) <= before[i]);
        return silent >= 0 ? this.noOutput(list[silent].label, list[silent].agent, list[silent].output) : null;
      }
      case 'commit': {
        const c = this.dwmt('commit', this.id);
        this.log(`${label}: commit ${c.ok === false ? `błąd: ${c.hint ?? c.error}` : c.commit ?? 'ok'}`);
        return c.ok === false ? this.stop('stopped', `${label}: commit: ${c.hint ?? c.error}`) : null;
      }
      case 'handoff': return null; // sterownik nie ma kontekstu do odświeżenia: następna iteracja to zadanie k+1
      case 'finish': {
        // Recenzja poprawek: naprawa przerwana śmiercią sterownika (rebase w toku albo zmiany w drzewie) → sprzątanie i stop.
        if (this.run().finishRepair?.result === 'started') {
          const rec = this.dwmt('finish-repair', this.id, '--recover');
          return this.stop('waiting-user', `${label}: repair interrupted: ${rec.reason ?? rec.error}`, { cause: 'repair-interrupted' });
        }
        const f = this.dwmt('finish', this.id);
        this.log(`${label}: finish ${f.status ?? f.error}`);
        // Wynik `finish` dla sesji (`wait`): przy zatrzymaniu nie powtarza `finish`, przy `done` ma `cleanup`, `uat`, `deferred`.
        this.lastFinish = f;
        if (['squashed', 'left'].includes(f.status)) return null;
        // W-2 (przegląd 2026-10-09): czerwień albo konflikt przy finish → jedna naprawa świeżym wykonawcą, potem finish znowu.
        if (isRepairable(this.run(), f) && this.cfg.drive?.finishRepair !== false) {
          const rep = await this.finishRepair(label, f);
          if (rep === null || typeof rep === 'object') return rep;
          return this.stop('waiting-user', `${label}: finish ${f.status}; naprawa przy finish: ${rep}`, {}, { finish: f });
        }
        return this.stop('waiting-user', `${label}: finish ${f.status ?? 'błąd'}: ${f.hint ?? f.error ?? ''}`, {}, { finish: f });
      }
      // D4 (spec warstwy produktowej §6.4 pkt 5): użytkownik zatrzymał sprint na pytaniu o cenę.
      case 'stopped': return this.stop('stopped', `${label}: ${st.hint ?? st.reason ?? 'przebieg zatrzymany'}`, { cause: st.reason ?? 'stopped' });
      case 'done': return this.stop('done', `przebieg zakończony; raport: ${fwd(join(this.root, 'final-report.md'))}`, {}, this.lastFinish ? { finish: this.lastFinish } : {});
      default: return this.stop('waiting-user', `${label}: krok bez obsługi w sterowniku (${st.hint ?? ''})`);
    }
  }

  // W-2: przygotowanie (`finish-repair`), agent, zakończenie (`--done`, zawsze: konflikt bez wyniku agenta wraca sprzed
  // rebase). null = ponów finish; tekst = powód zatrzymania dla użytkownika; obiekt = zatrzymanie limitem abonamentu.
  async finishRepair(label, f) {
    let p = this.dwmt('finish-repair', this.id);
    this.log(`${label}: naprawa przy finish (${f.status}) ${p.ok === false ? `niemożliwa: ${p.error}` : p.done ? 'zbędna: rebase bez konfliktu' : `start: ${asList(p.files ?? p.failed).join(', ')}`}`);
    if (p.ok === false) return p.error;
    if (p.done) return null;
    // Recenzja poprawek: kolejne postoje rebase (konflikt w następnym commicie gałęzi) idą do tego samego agenta (`--resume`).
    let resume = null;
    for (let n = 1; ; n++) {
      const tag = `${label} repair${n > 1 ? ` ${n}` : ''}`;
      const r = await this.agentStep(tag, p.agent, p.prompt, resume, { step: 'finish-repair' });
      // Limit abonamentu najpierw: próba nie przepada (rebase cofnięty, zmiany w schowku), po odnowieniu zaczyna się od nowa.
      const limit = this.agentLimit(r.sessionId);
      if (limit) {
        const rec = this.dwmt('finish-repair', this.id, '--recover', '--resumable');
        return this.stop('stopped', `${tag}: limit abonamentu do ${limit.resetsAt}; ${rec.reason ?? rec.error}`, { cause: 'limit', resetsAt: limit.resetsAt });
      }
      const d = this.dwmt('finish-repair', this.id, '--done', ...(r.sessionId ? ['--session', r.sessionId] : []), ...(r.ok ? [] : ['--failed']));
      this.log(`${tag}: naprawa przy finish → ${d.result ?? d.error}${d.again ? ` (${d.again.join(', ')})` : ''}`);
      if (d.ok === false) return d.error;
      if (d.next) { p = d.next; resume = r.sessionId ?? null; continue; }
      return d.retry ? null : `${d.result}${r.ok ? '' : ` (agent: ${r.cause} ${r.error ?? ''})`}`;
    }
  }

  noOutput(label, agent, output) {
    return this.stop('stopped', `${label}: agent ${agent} zakończył się bez zapisania wyniku (${fwd(output)})`, { cause: 'no-output', child: { kind: 'agent', name: agent } });
  }

  // W-3 (przegląd 2026-10-09): po kroku z agentem koszt przebiegu wobec górnej ceny; raz zdarzenie `price-alert` (push
  // w sesji PO i u supervisora), nigdy pauza. Błąd liczenia kosztu nie zatrzymuje pętli.
  priceCheck() {
    this.agentRan = false;
    try {
      const a = this.dwmt('price-alert', this.id);
      if (a.alert) this.log(`alarm ceny: koszt ${a.priceAlert.costM} mln > górna cena ${a.priceAlert.upperM} mln${a.priceAlert.forecastM != null ? `, prognoza ~${a.priceAlert.forecastM} mln (${a.priceAlert.done}/${a.priceAlert.tasks} zadań)` : ''}; sprint idzie dalej`);
    } catch { /* koszt best effort */ }
  }

  // `where`: miejsce w sprincie do nazwy sesji w tle (D-31): {task, round, step, batch}.
  async agentStep(label, agent, prompt, resume = null, where = {}) {
    this.agentRan = true;
    this.log(`${label}: ${agent}${resume ? ' (wznowiony)' : ''} start`);
    // Świeży agent `claude -p`: identyfikator sesji nadany i zapisany w przebiegu przed startem (koszt i przyrost
    // transkryptu widać także wtedy, gdy agent zginie bez wyniku); sesja w tle ma własny identyfikator (`--session-id`
    // ignorowany, sonda T-BG1), zapisany zaraz po starcie.
    const sid = resume ? null : randomUUID();
    const from = new Date().toISOString();
    let r = await this.agent(agent, prompt, resume, sid, { ...where, label });
    // K5 D-7: a background step that failed on an API error (not the subscription limit), without a first step or with a
    // vanished session starts once more with the same arguments (a fresh session or the same `--resume`); a second
    // failure goes the usual way (failAgent). Headless `claude -p`, timeouts and turn limits keep their handling.
    if (this.relaunchable(r)) {
      const delay = Number(this.cfg.drive?.relaunchDelaySec ?? 30);
      this.log(`${label}: ${agent} ${r.cause}: ${r.error} → ponowny start za ${delay} s (jeden raz)`);
      this.event('agent-relaunch', { label, agent, cause: r.cause, error: r.error ?? null });
      if (delay > 0) await new Promise((ok) => setTimeout(ok, delay * 1000));
      r = await this.agent(agent, prompt, resume, resume ? null : randomUUID(), { ...where, label });
    }
    if (r.sessionId && r.sessionId !== sid && !r.registered) { try { this.dwmt('sessions-add', this.id, r.sessionId); } catch { /* koszt w raporcie: best effort */ } }
    if (r.costUsd != null) this.mem.cost = Math.round((this.mem.cost + r.costUsd) * 100) / 100;
    // D-30: w tle bez `total_cost_usd`; koszt kroku w mln z transkryptu (wagi jak raport przebiegu), tylko w oknie tego
    // kroku: wznowiona sesja (`--resume`, naprawa przy finish 2+) ma w transkrypcie wcześniejsze tury (paczka T-5/F-5).
    let mln = null;
    if (r.costUsd == null && r.sessionId) { try { mln = sessionsCost([r.sessionId], this.env.DWMT_TRANSCRIPTS || undefined, { from, to: new Date().toISOString() })?.total ?? null; } catch { /* best effort */ } }
    delete r.registered;
    delete r.bg;
    this.log(`${label}: ${agent} ${r.ok ? 'ok' : `${r.cause}: ${r.error}`}${r.sessionId ? ` (sesja ${r.sessionId.slice(0, 8)}${mln != null ? `, ${mln} mln` : ''})` : ''}`);
    this.save();
    return r;
  }

  // Koniec pętli: zapis w `drive.json` (przed zdjęciem blokady, więc `dwmt wait` go widzi) i zdarzenie `drive-stop`.
  // `more` (wynik `finish`) tylko w `drive.json` i wyniku, nie w dzienniku zdarzeń. `costUsdTotal`: suma przebiegu ze
  // wszystkich startów sterownika.
  stop(status, reason, extra = {}, more = {}) {
    // Recenzja poprawek: alarm ceny także wtedy, gdy krok z agentem kończy się zatrzymaniem (przed zdarzeniem końca).
    if (this.agentRan) this.priceCheck();
    this.log(`STOP ${status}: ${reason}`);
    // K5 D-9: a stop caused by a session failure notifies the desktop by itself (the supervisor then skips its own toast).
    // Batch F-4: not under the supervisor (notifyFailure), which keeps quiet hours and resumes infra stops itself.
    if (SESSION_FAILURES.includes(extra.cause)) {
      let run = { run: this.id };
      try { run = this.run(); } catch { /* run.json w zapisie */ }
      if (notifyFailure(run, extra.cause, this.env)) extra = { ...extra, notified: true };
    }
    this.mem.stopped = { status, reason, at: new Date().toISOString(), ...extra, ...more };
    this.save();
    this.event('drive-stop', { status, reason, ...extra, costUsdTotal: this.mem.cost });
    return { status, reason, ...extra, ...more };
  }

  // Dzieci poprzedniego sterownika (zabitego bez sprzątania) z `drive.json.children`: żywe giną przed nową pracą.
  // K4 T-5 (R-2): sesje w tle poprzedniego sterownika: `claude stop` + `claude rm` (lista `claude agents` nie rośnie).
  async reapChildren() {
    for (const [pid, c] of Object.entries(this.mem.children ?? {})) {
      if (c?.kind === 'bg') {
        const r = await closeBg(c.id, { cwd: this.top, env: this.env });
        this.log(`sesja w tle poprzedniego sterownika zamknięta: ${c.id} ${c.name ?? c.agent ?? ''}${r.removed ? '' : ' (claude rm bez potwierdzenia)'}`);
        continue;
      }
      if (processAlive(Number(pid), c.start ?? null)) { killTree(Number(pid)); this.log(`dziecko poprzedniego sterownika zatrzymane: pid ${pid} ${c.agent ?? c.kind ?? ''}`); }
    }
    this.mem.children = {};
  }

  async loop(max = MAX_STEPS) {
    const lk = acquireDriveLock(this.root);
    if (!lk.ok) return { status: 'stopped', reason: `sterownik już działa (pid ${lk.held?.pid ?? '?'})`, running: true };
    // Pamięć na nowo po blokadzie (`--detach` dopisał `detachedAt` po konstruktorze).
    try { this.mem = { ...this.mem, ...JSON.parse(readFileSync(this.stateFile, 'utf8')) }; } catch { /* pierwszy start */ }
    this.normMem();
    this.mem.pid = process.pid;
    this.mem.startedAt = new Date().toISOString();
    delete this.mem.stopped;
    await this.reapChildren();
    this.save();
    this.event('drive-start', { pid: process.pid });
    // Live sprint view: its writer starts with the driver (detached, best effort).
    try { ensureLive(this.top, { home: runHome(this.run(), this.top), cfg: this.cfg }); } catch { /* never stops the driver */ }
    try {
      // Tryb A (recenzja): `drive-mode off` = przebieg prowadzi sesja; sterownik (np. z pętli supervisora) nie rusza.
      if (this.run().drive === false) return this.stop('stopped', 'drive-mode off: przebieg prowadzi sesja (dwmt drive-mode <run> on)', { cause: 'drive-off' });
      for (let i = 0; i < max; i++) {
        const st = this.dwmt('state', this.id);
        if (st.ok === false && !st.next) return this.stop('stopped', `state: ${st.error}`);
        if (st.modeSwitch) this.log(`tryb: ${st.modeSwitch}`);
        this.mem.steps++;
        const out = await this.step(st);
        if (out) return out;
        if (this.agentRan) this.priceCheck();
      }
      return this.stop('stopped', `limit ${max} kroków`);
    } catch (e) {
      if (e instanceof ChildDead) return this.stop('stopped', e.child.reason, { cause: 'child-dead', child: { kind: e.child.kind, name: e.child.name } });
      return this.stop('stopped', `błąd sterownika: ${e.message}`, { cause: 'driver-error' });
    } finally {
      if (readDriveLock(this.root)?.pid === process.pid) rmSync(join(this.root, 'drive.lock'), { force: true });
    }
  }
}

// `node drive.mjs <run> [--detach]`: z `--detach` proces w tle (log w drive.log, wyjście w drive.out); czeka, aż sterownik
// założy blokadę (albo skończy), wypisuje pid i kończy. Działający sterownik tego przebiegu: `running: true`, nic nowego.
// Koniec pliku od bajtu `from` (ostatnie 400 znaków w jednej linii).
function readTail(file, from) {
  try {
    const size = statSync(file).size;
    const start = Math.max(from, size - 4000);
    const buf = Buffer.alloc(Math.max(0, size - start));
    const fd = openSync(file, 'r');
    try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
    return buf.toString('utf8').trim().split(/\r?\n/).join(' | ').slice(-400);
  } catch { return ''; }
}

async function main(argv) {
  const id = argv.find((a) => !a.startsWith('--'));
  if (!id) throw new Error('użycie: drive.mjs <run> [--detach]');
  const top = runTop(topOf(), id);
  if (argv.includes('--detach')) {
    const root = runDir(top, id);
    if (!existsSync(join(root, 'run.json'))) throw new Error(`brak przebiegu ${id}`);
    const log = fwd(join(root, 'drive.log'));
    const held = readDriveLock(root);
    if (held && processAlive(held.pid, held.pidStart ?? null)) return { ok: true, pid: held.pid, running: true, log };
    mkdirSync(root, { recursive: true });
    // `detachedAt`: `dwmt wait` pomija zatrzymania sprzed tej chwili (sterownik, który nie wystartował, nie odtwarza starego).
    const at = new Date().toISOString();
    writeDriveMem(root, { ...(readDriveMem(root) ?? {}), detachedAt: at });
    const outFile = join(root, 'drive.out');
    const from = existsSync(outFile) ? statSync(outFile).size : 0;
    const fd = openSync(outFile, 'a');
    const p = spawn(process.execPath, [fileURLToPath(import.meta.url), id], { cwd: top, detached: true, stdio: ['ignore', fd, fd], windowsHide: true, env: { ...process.env, DWMT_DRIVE_QUIET: '1' } });
    p.unref();
    const started = () => readDriveMem(root)?.pid === p.pid && readDriveLock(root)?.pid === p.pid;
    for (let i = 0; i < 200 && !started() && processAlive(p.pid); i++) sleep(100);
    const mem = readDriveMem(root);
    if (mem?.pid === p.pid && Date.parse(mem.startedAt) >= Date.parse(at)) return { ok: true, pid: p.pid, log };
    // Bez startu: zatrzymanie z końcem drive.out w drive.json (sesja dostaje je z `wait` jak każde inne `stopped`).
    const reason = `sterownik nie wystartował: ${readTail(outFile, from) || `exit bez wyniku (pid ${p.pid})`}`;
    if (!processAlive(p.pid)) writeDriveMem(root, { ...(mem ?? {}), stopped: { status: 'stopped', reason, cause: 'start-failed', at: new Date().toISOString() } });
    return { ok: false, pid: p.pid, error: reason, log };
  }
  const r = await new Driver(top, id).loop();
  return { ok: r.status === 'done', ...r };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then((r) => { console.log(JSON.stringify(r)); process.exitCode = r.ok ? 0 : r.status === 'waiting-user' ? 10 : r.status === 'hold' ? 3 : r.status === 'planned' ? 4 : 1; })
    .catch((e) => { console.log(JSON.stringify({ ok: false, error: e.message })); process.exitCode = 1; });
}
