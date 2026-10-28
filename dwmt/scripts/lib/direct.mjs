// dwmt: tryb `direct` (E, noc 2026-10-05): bardzo mały sprint bez planu. Bez architekta i eksploratorów: skrypt pisze plan
// zadania 1 z wejścia (pozycje backlogu, plik sprintu, tekst zadania), a `dwmt-executor-high` sam decyduje o zmianie, dopisuje
// komendy `verify` do nagłówka planu i eskaluje (`escalate`), gdy praca wychodzi poza mały zakres. Recenzja jak w `single`.
import { existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { read, asList } from './util.mjs';
import { withHeader } from './headers.mjs';
import { taskDir } from './run.mjs';

export const DIRECT = 'direct';
export const isDirect = (x) => (x?.mode ?? x) === DIRECT;

// Próg eskalacji w prompcie wykonawcy (zakres E: do ok. 10 plików kodu, jeden obszar, bez decyzji użytkownika).
export const DIRECT_MAX_FILES = 10;

// Cel i kryteria z wejścia: pozycje backlogu (tytuły), plik sprintu (cel), tekst zadania (pierwszy nagłówek albo linia).
export function directSpec(task, { goal = null, items = [] } = {}) {
  const firstLine = String(task ?? '').split(/\r?\n/).map((l) => l.replace(/^#+\s*/, '').trim()).find((l) => l && !/^task: backlog items$/i.test(l)) ?? 'Task';
  const g = goal || (items.length === 1 ? items[0].title : items.length ? `Backlog items ${items.map((x) => x.id).join(', ')}` : firstLine);
  const acceptance = items.length
    ? items.map((x, i) => `AC-${i + 1} ${x.id} done as its backlog entry in task.md says: ${x.title}`)
    : [`AC-1 The task in task.md is done: ${g}`];
  return { goal: g.slice(0, 200), acceptance };
}

// Plan zadania 1 trybu direct (idempotentnie: istniejący plik zostaje). `verify` puste: wykonawca dopisuje komendy.
export function writeDirectBrief(root, run, spec) {
  const dir = taskDir(root, 1);
  const file = join(dir, 'brief.md');
  if (existsSync(file)) return false;
  mkdirSync(dir, { recursive: true });
  const header = {
    schema: 'dwmt/brief@1', run: run.run, task: 'T-1', goal: spec.goal, mode: DIRECT, acceptance: spec.acceptance,
    scope: ['**'], verify: [], delete: [], risks: [], decisions: [], questions: [],
  };
  const body = [
    `# ${spec.goal}`, '',
    '## Context',
    'No plan (mode direct): `task.md` in the run directory holds the work (backlog items with their notes, anchors and sources, or the task text). The executor decides the change.', '',
    '## UAT',
    'UAT: none.', '',
  ].join('\n');
  writeFileSync(file, withHeader(header, `\n${body}`));
  return true;
}

// Pierwszy sprint direct (2026-10-05): pozycje z intake mają w `task.md` tylko tytuł; treść uwagi (dowód, scenariusz,
// przyczyna) leży w recenzji źródłowego przebiegu. `src: review:<run>/T-k/F-n` → sekcja uwagi z kopii w głównym drzewie.
export function findingSources(mainTree, items, findingSection) {
  const out = [];
  for (const x of asList(items)) {
    const m = /^review:([\w.-]+)\/T-(\d+)\/(F-\d+)$/.exec(String(x.src ?? ''));
    if (!m) continue;
    const dir = join(mainTree, '.dwmt', 'runs', m[1], 'tasks', m[2]);
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter((f) => /^review-\d+(-\d+)?\.md$/.test(f)).sort().reverse();
    for (const f of files) {
      const s = findingSection(read(join(dir, f)), m[3]);
      if (s) { out.push(`## ${x.id}: review finding ${m[3]} of T-${m[2]} in run ${m[1]}`, '', s.replace(/^#+\s+/, '### '), ''); break; }
    }
  }
  return out.join('\n');
}

// Plan z `task.md`, gdy go brak (wejście tekstowe: sesja zapisuje task.md po `init`).
export function ensureDirectBrief(root, run) {
  if (!isDirect(run)) return false;
  const task = join(root, 'task.md');
  if (!existsSync(task)) return false;
  return writeDirectBrief(root, run, directSpec(read(task), { items: asList(run.directItems) }));
}

// Dopisek do promptu wykonawcy w rundzie 1 trybu direct.
export function directPrompt(taskRel) {
  return ` No plan (mode direct): do the work in ${taskRel} yourself. Read the code it points to; make the smallest correct change; for a behavioural item first a test that is red on the current code. Before you finish, put the targeted commands that prove the work into \`verify\` in the plan's header (plain commands; the script adds the project's guards). Replace "UAT: none." in the plan with 1–3 steps in the user's language only if the user can see the change. Escalate instead of guessing: if the work needs more than about ${DIRECT_MAX_FILES} code files, a contract or data migration, a new screen, deleting files, or a decision of the user, change nothing and end BLOCKED with \`escalate: <reason>\` in the result header.`;
}
