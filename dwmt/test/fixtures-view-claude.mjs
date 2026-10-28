// Stub of a tool-less `claude -p` (DWMT_CLAUDE) for the view translations (`product view --translate`, `product commit`):
// reads the prompt from stdin, takes the JSON object on its last line and answers by STUB_MODE: good (every value
// prefixed with "PL "), bad (no JSON), partial (first key missing), slow (sleeps past the timeout).
// STUB_LOG: one JSON line {args, prompt} per call.
import { readFileSync, appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
// `node --test` may load files from test/: without `-p` the stub does nothing.
if (!args.includes('-p')) process.exit(0);
const prompt = readFileSync(0, 'utf8');
if (process.env.STUB_LOG) appendFileSync(process.env.STUB_LOG, `${JSON.stringify({ args, prompt })}\n`);
const mode = process.env.STUB_MODE ?? 'good';
if (mode === 'slow') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8000);
const usage = { input_tokens: 2000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 500 };
const reply = (result) => console.log(JSON.stringify({ type: 'result', is_error: false, result, session_id: 'stub-view', usage, total_cost_usd: 0.001 }));
if (mode === 'bad') { reply('Here you go: translations below.'); process.exit(0); }
const src = JSON.parse(prompt.trim().split('\n').at(-1));
const keys = Object.keys(src).filter((_, i) => mode !== 'partial' || i > 0);
reply(`\`\`\`json\n${JSON.stringify(Object.fromEntries(keys.map((k) => [k, `PL ${src[k]}`])))}\n\`\`\``);
