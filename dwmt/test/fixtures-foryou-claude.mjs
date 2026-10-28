// Stub of a tool-less `claude -p` (DWMT_CLAUDE) for `product for-you --draft`: reads the prompt from stdin and answers by
// STUB_MODE: good (an entry per sprint id), bad (no JSON), partial (first id missing), noisy (a title over 90 chars for the
// first id), slow (sleeps past the timeout). STUB_LOG: one JSON line {args, prompt} per call.
import { readFileSync, appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
// `node --test` may load files from test/: without `-p` the stub does nothing.
if (!args.includes('-p')) process.exit(0);
const prompt = readFileSync(0, 'utf8');
if (process.env.STUB_LOG) appendFileSync(process.env.STUB_LOG, `${JSON.stringify({ args, prompt })}\n`);
const mode = process.env.STUB_MODE ?? 'good';
if (mode === 'slow') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8000);
const usage = { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 500, output_tokens: 200 };
const reply = (result) => console.log(JSON.stringify({ type: 'result', is_error: false, result, session_id: 'stub-for-you', usage, total_cost_usd: 0.002 }));
if (mode === 'bad') { reply('Sorry, here are the sections: Title: x'); process.exit(0); }
const ids = [...prompt.matchAll(/^### (\S+)$/gm)].map((m) => m[1]);
const entry = (id, i) => ({
  title: mode === 'noisy' && i === 0 ? 'x'.repeat(120) : `Export the list ${id}`,
  why: 'You can download the list of accepted items and send it to the client.',
  changes: ['A download button on the list'], notIncluded: ['Other file formats'], check: ['Open the list and press download'],
});
const ans = Object.fromEntries(ids.filter((_, i) => mode !== 'partial' || i > 0).map((id, i) => [id, entry(id, i)]));
reply(`\`\`\`json\n${JSON.stringify(ans)}\n\`\`\``);
