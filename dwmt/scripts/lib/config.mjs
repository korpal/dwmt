// dwmt: config projektu (.claude/dwmt.json) i wartości domyślne.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { read } from './util.mjs';
import { gitRaw } from './git.mjs';

export const DEFAULTS = {
  model: 'opus',
  roles: {
    // v2.7 (D3): architekt zamiast planistów; eksplorator Opus `medium` z mikrosondy (w naszej sondzie Sonnet zmyślał pola kontraktu);
    // kontrola celu przed finish bez kodu. Effort każdej roli w agencie, bo subagent bez niego dziedziczy effort sesji (T-D5).
    architect: { effort: 'xhigh', maxTurns: 200 },
    explorer: { model: 'opus', effort: 'medium', maxTurns: 100 },
    // D2: wykonawca krótszymi odcinkami (kontynuacja od progress.md w świeżym kontekście), recenzent bez podziału dłużej.
    executor: { effort: 'medium', maxTurns: 100 },
    'executor-high': { from: 'executor', effort: 'high' },
    reviewer: { effort: 'xhigh', maxTurns: 200 },
    // v2.10 (tryb pośredni): zadanie bez zmian kodu (same dokumenty) recenzuje ten sam recenzent na `high`; wybiera skrypt z diffu.
    'reviewer-high': { from: 'reviewer', effort: 'high' },
    checker: { effort: 'medium', maxTurns: 40 },
    'ui-verifier': { effort: 'xhigh', maxTurns: 80 },
  },
  // v2.7: obszar do selfReadMaxK (tys. tokenów z sizes.txt) architekt czyta sam; maxRounds rund z jednym eksploratorem.
  explore: { selfReadMaxK: 30, maxRounds: 3 },
  // plan (v2.11, K4): taskPlanMaxKB: limit planu zadania w KB (UTF-8, po autopoprawkach); większy wraca do architekta.
  plan: { taskPlanMaxKB: 10 },
  // deferredFile: zbiorczy plik odłożonych uwag (po sprincie 3 cz. 2 znikały w raportach przebiegów); null wyłącza.
  // batch (v2.8): od razu tylko blocker i uwaga w miejscu późniejszego zadania; reszta w rundzie zbiorczej po ostatnim zadaniu.
  // docsOnlyRole (v2.10): rola recenzenta zmiany, w której każdy plik pasuje do docsGlobs (null = zawsze `reviewer`).
  review: {
    maxRounds: 2, maxRiskLenses: 2, lensGlobs: {}, splitAboveK: 150, secondLookCritical: false, ignoreGlobs: [], deferredFile: '.dwmt/deferred.md', batch: true,
    docsOnlyRole: 'reviewer-high', docsGlobs: ['**/*.md', '**/*.mdx', '**/*.rst', '**/*.adoc'],
  },
  // heavy: regex komend ciężkich (e2e, IT) idących przez kolejkę maszyny (S1a); pełna suita przy finish jest ciężka zawsze.
  // shell: powłoka komend verify (np. Git Bash); null = cmd.exe na Windows, /bin/sh gdzie indziej (`!`, '…', bash = WSL).
  // ports (v2.10, C): [{for: "<regex komendy>", ports: [5173]}]; zajęty port → wynik `env` z PID i linią polecenia właściciela.
  // unit (przegląd 2026-10-09, W-5): [{glob, cmd}] — zadanie zmieniające plik z `glob` ma w verify komendę od `cmd`
  // (testy jednostkowe obszaru, np. frontendu); walidacja planu to sprawdza, architekt dostaje regułę w prompcie.
  // modules (K5 D-5): [{name?, glob: string|string[], full: [cmd]}]; with modules the finish suite is verify.full plus the
  // full commands of the modules the sprint changed (a code file outside every module runs all); [] = verify.full only.
  // knownRedDays (K5 D-17): expiry of an accepted red test in the project registry .dwmt/known-red.json.
  verify: { targeted: null, full: [], heavy: null, rerunRed: true, rerunFailedIndividually: false, rerunCmd: null, failedFileRegex: null, testFiles: null, shell: null, ports: [], e2eChanged: null, unit: [], modules: [], knownRedDays: 7 },
  // A (noc 2026-10-05, sprinty 9 i 16: nowe e2e nie biegły nigdzie): `verify.e2eChanged: {glob, cmd, strip?}` — przy `finish` do
  // pełnej suity dochodzi `cmd` z `{files}` = pliki e2e dodane albo zmienione przez sprint (glob od katalogu głównego repo,
  // `strip`: przedrostek usuwany ze ścieżek, np. "frontend/" dla komendy `npm --prefix frontend …`). Stare e2e nie biegną.
  // checks: [{cmd, hint, for?, up?}] — środowisko przed verify (np. compose); `for` = regex komend, które go potrzebują;
  // `up` (v2.6): komenda uruchamiana raz przy niegotowym środowisku (zgodą jest wpis w configu).
  env: { checks: [] },
  // scriptChecks (v2.11, K4): po każdym kroku wykonawcy skrypt sprawdza pliki poza zakresem zadania bez powodu, usunięte
  // albo osłabione asercje i dodane skip/only (przebieg 2.11 z planem sprintu); false wyłącza.
  scriptChecks: { enabled: true },
  ui: null,
  git: { branchPrefix: 'dwmt/', finish: 'squash', target: null, rebase: 'finish' },
  // v2.6 (S2): lista UAT w raporcie i wstrzymanie scaleń na czas UAT; sesja następczyni po zadaniu; pliki wspólne sprintów.
  uat: { start: [], notes: [], holdMaxMin: 240 },
  // lean (v2.9): sesja następczyni bez innych wtyczek i bez serwerów MCP.
  launch: { permissionMode: 'auto', lean: true },
  // v2.10: `dwmt watch` (alarm przestoju): odczyt co intervalSec; bez procesu i przyrostu przez idleMin = przestój;
  // żywy proces bez przyrostu przez hangMin = podejrzenie zawieszenia.
  watch: { intervalSec: 30, idleMin: 30, hangMin: 90 },
  // v3 (sterownik, N-2): `drive.mjs` zamiast pętli orkiestratora LLM; agenci jako `claude -p --agent`. false = v2.10 bez zmian.
  // K4 (D-2): domyślnie włączony; `"drive": {"enabled": false}` w projekcie przywraca sesję modelu (tryb inline zawsze nią jest).
  // workerCacheTtl (przegląd sprintu 16 (UI)): czas życia cache ról roboczych sterownika (`5m`|`1h`, null = domyślny `claude -p`).
  // maxTurnRestarts (przegląd 2026-10-09, W-1): świeże odcinki wykonawcy po limicie tur (`--max-turns` z roli) w jednej rundzie.
  // finishRepair (W-2): jedna naprawa świeżym wykonawcą po czerwieni albo konflikcie przy finish (false wyłącza).
  // K4 T-5 (D-29): `agentSessions` background (`claude --bg`, visible in `claude agents`) | headless (`claude -p`).
  // K5 (D-7): firstStepMin: a background session not busy and without its first assistant call after that many minutes
  // is failed (no-start); relaunchDelaySec: pause before the one relaunch of a failed background step.
  drive: { enabled: true, permissionMode: null, agentTimeoutMin: 240, workerCacheTtl: '5m', maxTurnRestarts: 5, finishRepair: true, agentSessions: 'background', firstStepMin: 5, relaunchDelaySec: 30 },
  // worktreeDir, worktreeSetup (recenzja N-4, `init --worktree`; spec supervisora §4.1): katalog worktree przebiegów
  // względem głównego drzewa i komendy przygotowania nowego worktree (np. junction node_modules), uruchamiane w nim.
  supervisor: { hotFiles: [], worktreeDir: '.claude/worktrees', worktreeSetup: [] },
  // D4 (spec warstwy produktowej §6.4): bramka drogich rozwiązań w `run` (cena projektu z `files` planu, pytanie `Q-price`);
  // false = v2.10; true albo obiekt = włączona; `askAboveM` (recenzja N-4): próg mln, ponad którym pyta zawsze (null = brak).
  run: { priceGate: { askAboveM: null } },
  // Decyzja użytkownika 2026-10-21: pliki z `delete` planów usuwane bez pytania (tylko śledzone przez git, więc do odzyskania);
  // `ask: true` przywraca pytanie w turze pytań architekta (`ask-plan`) i krok `ask-delete`.
  deletes: { ask: false },
  // T-4 (D-10): zakres strażnika `guard-destructive` run | repo | always; env DWMT_GUARD_SCOPE wygrywa; czyta go sam hook.
  guard: { scope: 'run' },
  agentsScope: 'project',
  language: 'en',
};
export const REBASE = ['finish', 'review', 'none'];

function merge(a, b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = a && typeof a[k] === 'object' && !Array.isArray(a[k]) ? merge(a[k], v) : v;
  return out;
}

export function stripJsonComments(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { out += c; if (c === '\\') out += text[++i] ?? ''; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    out += c;
  }
  return out;
}

// v2.7: `roles.planner` z configów sprzed D3 to alias `architect` (jego wartości nad domyślnymi, `architect` z configu ponad nimi).
export function aliasRoles(user) {
  const warnings = [];
  const roles = user?.roles;
  if (!roles || typeof roles !== 'object') return warnings;
  if (roles.planner) {
    const { planner, ...rest } = roles;
    user.roles = { ...rest, architect: { ...planner, ...(rest.architect || {}) } };
    warnings.push('roles.planner w .claude/dwmt.json czytam jako roles.architect (v2.7): zmień nazwę klucza');
  }
  for (const r of Object.values(user.roles)) if (r && r.from === 'planner') r.from = 'architect';
  return warnings;
}

// Target branch when the config has no `git.target`. A trial in a project whose integration branch was `develop`
// failed: the old default knew only `main` and `master`.
// - `target`: runtime default, independent of the checked-out branch (a run worktree sits on its own branch):
//   the remote's default branch (origin/HEAD) if it exists locally, then the first existing well-known name.
// - `certain` and `candidates`: for setup, which asks when the choice is not certain. Certain = origin/HEAD, the only
//   local branch, or the only well-known branch with the user on it (or on a dwmt branch).
const KNOWN_TARGETS = ['main', 'master', 'develop', 'development', 'trunk'];
export function detectTarget(top, branchPrefix = DEFAULTS.git.branchPrefix) {
  const has = (b) => gitRaw(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], { cwd: top }).status === 0;
  const head = gitRaw(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd: top });
  const remote = head.status === 0 ? head.stdout.trim().replace(/^origin\//, '') : '';
  if (remote && has(remote)) return { target: remote, source: 'origin/HEAD', certain: true, candidates: [remote] };
  const local = gitRaw(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: top }).stdout
    .split(/\r?\n/).filter((b) => b && !b.startsWith(branchPrefix));
  const cur = gitRaw(['branch', '--show-current'], { cwd: top }).stdout.trim();
  const current = cur && !cur.startsWith(branchPrefix) ? cur : null;
  const known = KNOWN_TARGETS.filter((b) => local.includes(b));
  if (local.length === 1) return { target: local[0], source: 'only-branch', certain: true, candidates: local };
  const candidates = [...new Set([...known, ...(current ? [current] : [])])];
  const target = known[0] ?? 'master';
  if (known.length === 1 && (!current || current === known[0])) return { target, source: 'known', certain: true, candidates };
  // Setup recommends the branch the user is on when it has a well-known name (e.g. `develop` beside `main`).
  const recommended = current && known.includes(current) ? current : known[0] ?? current ?? null;
  return { target, source: known.length ? 'known' : 'none', certain: false, candidates, recommended };
}

export function loadConfig(top) {
  const f = join(top, '.claude', 'dwmt.json');
  const user = existsSync(f) ? JSON.parse(stripJsonComments(read(f))) : {};
  const warnings = aliasRoles(user);
  // A copy: `merge` reuses nested default objects the user config does not touch, and the lines below assign into them
  // (without it the first project's detected target leaked into DEFAULTS for every later loadConfig in the process).
  const cfg = merge(structuredClone(DEFAULTS), user);
  cfg.warnings = warnings;
  // K4 (D-26, D-27): `driveDefault` = `drive.enabled` z wartości domyślnych (komunikat przy init); DWMT_DRIVE_DEFAULT=off
  // (tylko testy) przywraca stary domyślny false; ustawienie projektu wygrywa zawsze.
  if (user?.drive?.enabled === undefined) {
    cfg.driveDefault = true;
    if (process.env.DWMT_DRIVE_DEFAULT === 'off') cfg.drive.enabled = false;
  }
  // K4 T-5 (D-29): DWMT_AGENT_SESSIONS (only the test helpers set it) replaces the default; a project setting wins.
  if (user?.drive?.agentSessions === undefined && ['background', 'headless'].includes(process.env.DWMT_AGENT_SESSIONS)) cfg.drive.agentSessions = process.env.DWMT_AGENT_SESSIONS;
  if (!cfg.git.target) {
    cfg.git.target = detectTarget(top, cfg.git.branchPrefix).target;
    cfg.targetDefault = true;
  }
  if (cfg.ui) cfg.ui = { playwright: '.', viewport: [1440, 900], mockupCss: '', maxPairs: 6, ...cfg.ui };
  cfg.exists = existsSync(f);
  return cfg;
}
