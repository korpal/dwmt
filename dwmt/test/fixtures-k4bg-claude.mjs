// K4 T-5: fake `claude` (DWMT_CLAUDE) for driver agents as background sessions. Answers `--bg` (prints
// `backgrounded · bg-N · <name>`, does the agent's work, writes the session transcript under DWMT_TRANSCRIPTS), `agents
// --json` (rows from FAKE_STATE; a waiting or slow session ends after a few polls), `stop`, `rm` and the hidden `-p`
// fallback. Every call goes to FAKE_LOG (JSONL). Switches: FAKE_BG_FAIL (start exits 1), FAKE_BG_WAIT_AGENT (status
// `waiting` for 2 polls), FAKE_BG_TURNS_AGENT + FAKE_BG_TURNS (first such start: that many calls, no end of turn),
// FAKE_BG_HANG_AGENT (busy for good), FAKE_BG_LIMIT_AGENT (subscription limit in the transcript, then busy for good),
// K5: FAKE_BG_APIERR_AGENT (first such start: one call, then an API error line without an end of turn, session idle),
// FAKE_BG_SILENT_AGENT (every such start: idle session without any assistant call).
import { writeFileSync, readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const a = process.argv.slice(2);
if (!a.length || !process.env.FAKE_LOG) process.exit(0);
const val = (f) => (a.includes(f) ? a[a.indexOf(f) + 1] : null);
const log = process.env.FAKE_LOG;
const stateFile = process.env.FAKE_STATE;
const readState = () => { try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return { n: 0, rows: {} }; } };
const saveState = (s) => writeFileSync(stateFile, JSON.stringify(s));
const note = (o) => appendFileSync(log, `${JSON.stringify(o)}\n`);
const now = () => new Date().toISOString();
const proj = join(process.env.DWMT_TRANSCRIPTS, 'p');
const line = (f, o) => { mkdirSync(proj, { recursive: true }); appendFileSync(join(proj, `${f}.jsonl`), `${JSON.stringify({ timestamp: now(), ...o })}\n`); };
const call = (sid, i, text) => line(sid, { type: 'assistant', requestId: `r-${sid}-${i}-${Date.now()}`, message: { id: `m-${sid}-${i}`, usage: { input_tokens: 100000, output_tokens: 1000 }, content: text ? [{ type: 'text', text }] : [{ type: 'tool_use', name: 'Bash', input: {} }] } });
const endTurn = (sid) => line(sid, { type: 'system', subtype: 'turn_duration', durationMs: 10 });

// The agent's work (pattern: the inline fake of v3drive.test.mjs): files from the paths in the prompt; returns the text.
function work(agent, prompt) {
  const path = (label) => { const m = new RegExp(`${label}: ([^ ]+?)\\.( |$)`).exec(prompt); return m ? m[1] : null; };
  const put = (f, text) => { if (!f) return; mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); };
  const head = (o) => `---\n${Object.entries(o).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n`;
  const k = Number(/tasks\/(\d+)\//.exec(prompt)?.[1] ?? 0);
  if (agent.startsWith('dwmt-executor')) {
    const code = { 1: ['src/billing/discount.ts', 'export class Discount {}\n'], 2: ['src/summary/view.ts', 'export const view = () => "-10%";\n'], 3: ['src/export/csv.ts', 'export const csv = () => "10";\n'] }[k];
    if (code) put(code[0], code[1]);
    put(path('Result'), head({ schema: 'dwmt/result@1', status: 'DONE', laterNotes: [] }));
    return 'Result written.';
  }
  if (agent === 'dwmt-reviewer') {
    const round = Number(/review-(\d+)\.md/.exec(path('Output') ?? '')?.[1] ?? 1);
    put(path('Output'), head({ schema: 'dwmt/review@1', round, passes: ['correctness'], verdict: 'PASS', fix: [], defer: [], drop: [], acceptance: [`AC-${k} met`], risks: ['R-1 proven'] }));
    return 'PASS';
  }
  if (agent === 'dwmt-checker') {
    put(path('Output'), '---\nschema: dwmt/goal-check@1\nitems:\n  - {id: I-1, element: "discount", status: delivered, task: T-1, evidence: "T-1/report.md"}\ngaps: 0\n---\n');
    return 'Goal checked.';
  }
  if (agent === 'dwmt-architect') return 'Plans checked.\nREPLAN: unchanged T-2; cause: discovery';
  return 'done';
}
const is = (v, agent) => !!v && agent.startsWith(v);

if (a[0] === '--bg') {
  const name = val('-n');
  const prompt = a[3];
  const resume = val('--resume');
  const agent = val('--agent') ?? (resume ? 'dwmt-architect' : '?');
  if (process.env.FAKE_BG_FAIL) { note({ cmd: 'bg-fail', agent, name }); console.error('Workspace not trusted. Run `claude` in this directory once.'); process.exit(1); }
  const s = readState();
  s.n += 1;
  const id = `bg-${s.n}`;
  const sid = `${id}-0000-sess`;
  note({ cmd: 'bg', id, agent, name, resume, prompt: prompt.slice(0, 200), settings: val('--settings'), sessionIdFlag: val('--session-id'), maxTurnsFlag: val('--max-turns'), promptAt: a.indexOf(prompt) });
  line(sid, { type: 'agent-setting', agentSetting: agent });
  line(sid, { type: 'user', message: { content: prompt } });
  const row = { id, sessionId: sid, name, kind: 'background', status: 'busy', polls: 0 };
  const firstTurns = is(process.env.FAKE_BG_TURNS_AGENT, agent) && !s.turnsDone;
  if (firstTurns) {
    s.turnsDone = true;
    for (let i = 1; i <= Number(process.env.FAKE_BG_TURNS || 5); i++) call(sid, i, null);
    row.mode = 'hang';
  } else if (is(process.env.FAKE_BG_LIMIT_AGENT, agent)) {
    // Batch T-5/F-9: the subscription limit (T-S12 shape) in the transcript, the session keeps waiting (no end of turn).
    call(sid, 1, null);
    line(sid, { type: 'assistant', requestId: `r-${sid}-limit`, error: 'rate_limit', isApiErrorMessage: true, quotaLimits: { resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'five_hour' }, message: { id: `m-${sid}-limit`, content: [{ type: 'text', text: "You've hit your limit · resets 3am" }] } });
    row.mode = 'hang';
  } else if (is(process.env.FAKE_BG_APIERR_AGENT, agent) && !s.apiErrDone) {
    s.apiErrDone = true;
    call(sid, 1, null);
    line(sid, { type: 'assistant', requestId: `r-${sid}-err`, error: 'unknown', isApiErrorMessage: true, message: { id: `m-${sid}-err`, content: [{ type: 'text', text: 'API Error: 529 Overloaded' }] } });
    row.status = 'idle';
  } else if (is(process.env.FAKE_BG_SILENT_AGENT, agent)) row.status = 'idle';
  else if (is(process.env.FAKE_BG_HANG_AGENT, agent)) row.mode = 'hang';
  else {
    const text = work(agent, prompt);
    call(sid, 1, null);
    if (is(process.env.FAKE_BG_WAIT_AGENT, agent)) { row.mode = 'wait'; row.text = text; row.status = 'waiting'; } else { call(sid, 2, text); endTurn(sid); row.status = 'idle'; }
  }
  s.rows[id] = row;
  saveState(s);
  console.log(`backgrounded · ${id} · ${name}\n  claude attach ${id}    open in this terminal`);
  process.exit(0);
}
if (a[0] === 'agents') {
  const s = readState();
  for (const r of Object.values(s.rows)) {
    if (r.stopped) continue;
    r.polls += 1;
    if (r.mode === 'wait' && r.polls > 2) { call(r.sessionId, 2, r.text); endTurn(r.sessionId); r.status = 'idle'; r.mode = null; }
  }
  saveState(s);
  console.log(JSON.stringify(Object.values(s.rows).map((r) => ({ id: r.id, sessionId: r.sessionId, name: r.name, kind: r.kind, status: r.status, pid: 1 }))));
  process.exit(0);
}
if (a[0] === 'stop' || a[0] === 'rm') {
  const s = readState();
  const id = a[1];
  note({ cmd: a[0], id });
  if (s.rows[id]) { if (a[0] === 'rm') delete s.rows[id]; else { s.rows[id].stopped = true; s.rows[id].status = 'idle'; } }
  saveState(s);
  console.log(`${a[0] === 'rm' ? 'removed' : 'stopped'} ${id}`);
  process.exit(0);
}
if (a.includes('-p')) {
  const prompt = val('-p');
  const agent = val('--agent') ?? (val('--resume') ? 'dwmt-architect' : '?');
  const sid = val('--session-id') ?? val('--resume') ?? 'p-0000';
  note({ cmd: 'p', agent, sid });
  const result = work(agent, prompt);
  console.log(JSON.stringify({ type: 'result', is_error: false, result, session_id: sid, total_cost_usd: 0.01 }));
  process.exit(0);
}
note({ cmd: 'other', args: a });
