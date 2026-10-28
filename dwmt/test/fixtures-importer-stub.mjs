// Atrapa `claude -p --agent dwmt-importer` (DWMT_CLAUDE): czyta kawałki z pliku wejścia z promptu i pisze rekordy
// deterministycznie według `kind` kawałka; licznik wywołań w pliku STUB_COUNT.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
// `node --test` uruchamia też pliki z test/: bez `-p` atrapa nic nie robi.
if (!args.includes('-p')) process.exit(0);
const prompt = args[args.indexOf('-p') + 1] ?? '';
const input = /Input: (\S+)/.exec(prompt)[1];
const output = /output lines to (\S+) with Write/.exec(prompt)[1];
if (process.env.STUB_COUNT) appendFileSync(process.env.STUB_COUNT, 'x\n');
if (process.env.STUB_ARGS) writeFileSync(process.env.STUB_ARGS, JSON.stringify(args));
const chunks = readFileSync(input, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// STUB_FAIL (regex): paczka z pasującym kawałkiem kończy się błędem po częściowym zapisie wyniku (pierwsza linia).
if (process.env.STUB_FAIL && chunks.some((c) => new RegExp(process.env.STUB_FAIL).test(c.text))) {
  writeFileSync(output, `${JSON.stringify({ chunk: chunks[0].chunk, kind: 'decision', title: 'partial', area: 'x', decision: 'partial' })}\n`);
  console.log(JSON.stringify({ type: 'result', is_error: true, result: 'stub failure', session_id: 'stub-import' }));
  process.exit(1);
}
const out = [];
const first = (t) => t.split('\n').map((l) => l.replace(/^#+\s*|^[-*]\s+|^\|\s*/g, '').trim()).find(Boolean) ?? 'x';
for (const c of chunks) {
  const t = first(c.text);
  if (c.kind === 'item') {
    const alias = /^(?:\*\*)?([A-Z][A-Za-z0-9]*-?\d+)\b/.exec(t)?.[1] ?? c.meta?.id ?? null;
    const anchors = [...c.text.matchAll(/`([\w./-]+\.\w+)`/g)].map((m) => m[1]);
    out.push({ chunk: c.chunk, kind: 'item', type: c.type ?? 'idea', title: t.replace(/\*\*/g, '').slice(0, 80), ...(alias ? { alias } : {}), ...(anchors.length ? { anchors } : {}), ...(/unsure/i.test(c.text) ? { review: 'unsure mapping' } : {}) });
  } else if (c.kind === 'decision') out.push({ chunk: c.chunk, kind: 'decision', title: t.slice(0, 80), area: 'general', decision: t });
  else if (c.kind === 'roadmap') {
    for (const m of c.text.matchAll(/^[-*\d.)\s]*\s*(pm-\d+)(?:\s*\(after ([\w, -]+)\))?:\s*(.+)$/gm)) out.push({ chunk: c.chunk, kind: 'roadmap', id: m[1], goal: m[3].trim(), after: m[2] ? m[2].split(',').map((x) => x.trim()) : [] });
  } else if (c.kind === 'sprint') {
    const id = c.meta?.id ?? /\b(pm-\d+)\b/i.exec(c.text)?.[1]?.toLowerCase();
    if (id) out.push({ chunk: c.chunk, kind: 'sprint', id, goal: (c.meta?.title ?? t).slice(0, 80), after: c.meta?.after ?? [], notes: c.text.split('\n').slice(1).join(' ').trim().slice(0, 200) });
  } else if (c.kind === 'done') {
    const id = c.meta?.id ?? /\b(pm-\d+)\b/i.exec(c.text)?.[1]?.toLowerCase();
    if (id) out.push({ chunk: c.chunk, kind: 'done', id, goal: (c.meta?.title ?? t).slice(0, 80) });
  }
}
writeFileSync(output, out.map((o) => JSON.stringify(o)).join('\n') + (out.length ? '\n' : ''));
console.log(JSON.stringify({ type: 'result', is_error: false, result: `${out.length}`, session_id: 'stub-import' }));
