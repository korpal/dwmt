// dwmt: SessionStart (compact, resume, clear). Jedno zdanie o aktywnym przebiegu i komendzie stanu.
import { activeRuns, topOf, ROOT } from '../scripts/dwmt.mjs';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
try {
  const ev = JSON.parse(raw || '{}');
  const runs = activeRuns(topOf(ev.cwd || process.cwd()));
  if (runs.length) {
    const script = `${ROOT.replace(/\\/g, '/')}/scripts/dwmt.mjs`;
    const list = runs.slice(0, 3).map((r) => `${r.id} (next: ${r.next})`).join(', ');
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `dwmt: aktywny przebieg ${list}. Odczyt stanu bez zmian w przebiegu: node "${script}" state <run> --peek; wznowienie: /dwmt:execute <run>.`,
      },
    }));
  }
} catch { /* poza repo git albo bez przebiegów: brak kontekstu */ }
