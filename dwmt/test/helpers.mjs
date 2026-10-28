// Pomocniki testów przebiegu: tymczasowe repo, wywołanie CLI, plan, artefakty.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, cpSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// K4 (D-26): testy ścieżki sesji budują configi bez klucza `drive`; szew przywraca stary domyślny `drive.enabled: false`
// (ustawienie projektu wygrywa). Dziedziczą go procesy CLI; `k4-drive.test.mjs` usuwa go dla swoich przypadków.
process.env.DWMT_DRIVE_DEFAULT ??= 'off';
// K4 T-5 (D-29): driver tests use a `claude -p`-only fake; the seam keeps the hidden agent mode (`k4-bg.test.mjs` removes it).
process.env.DWMT_AGENT_SESSIONS ??= 'headless';

export const SCRIPT = fileURLToPath(new URL('../scripts/dwmt.mjs', import.meta.url));
// Kolejka maszyny testów: osobny ~/.dwmt na plik testów (prawdziwa kolejka nie wstrzymuje testów i odwrotnie).
export const DWMT_HOME = mkdtempSync(join(tmpdir(), 'dwmt-home-'));

// kt (D-16): a builder runs once per process; every call gets a copy of its result (timestamps kept). A template whose
// files (outside .git) name its own directory would carry a wrong path, so that key builds fresh on every call.
const templates = new Map();
function namesItself(dir) {
  const name = basename(dir);
  const walk = (d) => readdirSync(d, { withFileTypes: true }).some((e) => {
    if (e.name === '.git') return false;
    const p = join(d, e.name);
    if (e.isDirectory()) return walk(p);
    return e.isFile() && readFileSync(p, 'latin1').includes(name);
  });
  return walk(dir);
}
export function fromTemplate(key, build) {
  let t = templates.get(key);
  if (!t) {
    const dir = build();
    t = namesItself(dir) ? { fresh: true } : { dir };
    templates.set(key, t);
    if (t.fresh) return dir;
  }
  if (t.fresh) return build();
  const d = mkdtempSync(join(tmpdir(), 'dwmt-t-'));
  cpSync(t.dir, d, { recursive: true, preserveTimestamps: true });
  return d;
}

export function repo() {
  return fromTemplate('repo', buildRepo);
}
function buildRepo() {
  const d = mkdtempSync(join(tmpdir(), 'dwmt-t-'));
  const g = gitIn(d);
  g('init', '-q', '-b', 'master');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'test');
  g('config', 'core.autocrlf', 'false');
  writeFileSync(join(d, 'package.json'), JSON.stringify({ scripts: { test: 'node -e 0' } }));
  writeFileSync(join(d, 'a.txt'), 'jeden\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'start');
  return d;
}
export const gitIn = (d) => (...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function cli(d, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: d, encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'sess-1', DWMT_HOME } });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* tekst sekcji */ }
  return { code: r.status, json, out: r.stdout };
}

export const header = (obj) => `---\n${Object.entries(obj).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n`;
export function plan(d, run, mode, extra = '') {
  const f = join(d, '..', `${run}-plan.md`);
  writeFileSync(f, `${header({ schema: 'dwmt/brief@1', run, goal: 'Dodaj b.txt', mode, acceptance: ['AC-1 b.txt istnieje'], scope: ['*.txt'], verify: ['node -e 0'], risk: [] })}# Plan\n\n## Decisions\n### D-1 prosto\nbez udziwnień\n${extra}\n${UAT_NONE}\nContinue: /dwmt:execute ${run}\n`);
  return f;
}
// v2.6: brief sprintu z jednym zadaniem ma scenariusz UAT; testy mechaniki biorą „UAT: none”.
export const UAT_NONE = '## UAT\nUAT: none.\n';
// v2.6: artefakty zadania leżą w tasks/<k>/, reszta (run.json, task.md, answers.md, plan.md, final-report.md) w katalogu przebiegu.
const TASK_FILE = /^(brief\.md|progress\.md|(result|repair)-.+|tests\.md|diff.*\.patch|fix-delta\.patch|review-.+|ui(\/.*)?|report\.md)$/;
export const runFile = (d, run, name, k = 1) => join(d, '.dwmt', 'runs', run, ...(TASK_FILE.test(name) ? ['tasks', String(k)] : []), name);
export const put = (d, run, name, obj, body = '') => writeFileSync(runFile(d, run, name), `${header(obj)}${body}`);
// Przebieg v2.6 (§5.9 „Przejście z v2.6”): run.json bez `rules`, więc reguły i stany v2.6 z architektem w miejsce planistów.
export function asV26(d, run) {
  const f = runFile(d, run, 'run.json');
  const rj = JSON.parse(readFileSync(f, 'utf8'));
  delete rj.rules;
  writeFileSync(f, JSON.stringify(rj, null, 2));
}

// v2.9: init zapisuje rules 2.9; scenariusze reguł 2.7/2.8 przestawiają `rules` po `init` (przebieg kończy się swoimi regułami).
export function asRules(d, run, R) {
  const f = runFile(d, run, 'run.json');
  const rj = JSON.parse(readFileSync(f, 'utf8'));
  rj.rules = R;
  writeFileSync(f, JSON.stringify(rj, null, 2));
}

// Przebieg v2.7 (v2.8 §0: przebieg z `rules: 2.7` kończy się regułami 2.7): testy mechaniki 2.7 przestawiają `rules` po `init`.
export function asV27(d, run) {
  const f = runFile(d, run, 'run.json');
  const rj = JSON.parse(readFileSync(f, 'utf8'));
  rj.rules = '2.7';
  writeFileSync(f, JSON.stringify(rj, null, 2));
}

export function prepared(d, slug = 'b', mode = 'single') {
  const g = gitIn(d);
  const s = cli(d, 'setup');
  assert.equal(s.code, 0, s.out);
  g('add', '-A');
  g('commit', '-q', '-m', 'dwmt setup');
  const pf = cli(d, 'preflight', '--slug', slug);
  assert.equal(pf.json.ok, true, pf.out);
  const run = pf.json.run;
  assert.equal(cli(d, 'init', '--run', run).json.ok, true);
  const imp = cli(d, 'import-plan', plan(d, run, mode), '--run', run);
  assert.equal(imp.json.ok, true, imp.out);
  return run;
}
