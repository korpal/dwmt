// Pomocniki testów warstwy produktowej (D4): CLI `product`, zakończone przebiegi w kopii głównego drzewa, eksperci.
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { SCRIPT, DWMT_HOME, gitIn, repo, fromTemplate } from './helpers.mjs';

export const NO_TRANSCRIPTS = mkdtempSync(join(tmpdir(), 'dwmt-tr-'));
const env = (extra) => ({ ...process.env, CLAUDE_CODE_SESSION_ID: 'sess-1', DWMT_HOME, DWMT_TRANSCRIPTS: NO_TRANSCRIPTS, ...extra });

export function dw(d, args, extra = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: d, encoding: 'utf8', env: env(extra) });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* tekst */ }
  return { code: r.status, json, out: r.stdout.trimEnd(), err: r.stderr };
}
export const pr = (d, ...args) => dw(d, ['product', ...args]);
export const prEnv = (d, extra, ...args) => dw(d, ['product', ...args], extra);
export function prAsync(d, args, extra = {}) {
  return new Promise((res) => {
    const p = spawn(process.execPath, [SCRIPT, 'product', ...args], { cwd: d, env: env(extra) });
    let out = '';
    p.stdout.on('data', (b) => { out += b; });
    p.on('close', (code) => { let json = null; try { json = JSON.parse(out); } catch { /* tekst */ } res({ code, json, out }); });
  });
}

export function write(d, rel, text) {
  mkdirSync(dirname(join(d, rel)), { recursive: true });
  writeFileSync(join(d, rel), text);
}
export function config(d, obj) { write(d, '.claude/dwmt.json', `${JSON.stringify(obj, null, 2)}\n`); }

// Zakończony przebieg (kopia w głównym drzewie): commit „squash” ze zmienionymi plikami i run.json z finish.
export function fakeRun(d, id, { files = ['src/a.ts'], cost = 2, mode = 'single', modeLabel, spec, items, sprint, uat = 'n/a', status = 'squashed', reportMode, scope, extra = {} } = {}) {
  const g = gitIn(d);
  for (const f of files) write(d, f, `// ${id} ${f}\n`);
  g('add', '-A', '--', ...files);
  g('commit', '-q', '-m', `squash ${id}`, '--', ...files);
  const commit = g('rev-parse', '--short=10', 'HEAD');
  const dir = join(d, '.dwmt', 'runs', id);
  mkdirSync(dir, { recursive: true });
  const run = { schema: 'dwmt/run@1', run: id, mode, ...(modeLabel ? { modeLabel } : {}), ...(spec ? { spec } : {}), ...(items ? { items } : {}), ...(sprint ? { sprint } : {}), created: new Date().toISOString(), session_ids: [], tasks: [], finish: status ? { status, commit: status === 'squashed' ? commit : null, cost, uat, at: '2026-10-01T10:00:00Z' } : null, ...extra };
  writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2));
  writeFileSync(join(dir, 'final-report.md'), `---\nschema: "dwmt/final-report@1"\nrun: "${id}"\nmode: "${reportMode ?? mode}"\nscope: ${JSON.stringify(scope ?? files)}\ncost: {"total": ${cost}}\n---\n# Report\n`);
  return { dir, commit };
}

// kt (D-16): with the shared `repo` and the default goal the repo is a copy of one per-process build.
export function productRepo(repoFn, goal = 'Pilot: build cost') {
  if (repoFn === repo && goal === 'Pilot: build cost') return fromTemplate('productRepo', () => buildProductRepo(repoFn, goal));
  return buildProductRepo(repoFn, goal);
}
function buildProductRepo(repoFn, goal) {
  const d = repoFn();
  const r = pr(d, 'init', '--goal', goal);
  if (r.code !== 0) throw new Error(r.out);
  gitIn(d)('add', '-A');
  gitIn(d)('commit', '-q', '-m', 'product init');
  return d;
}

export const expertText = (domain, { lines = 0, drop = null, title = `${domain} expert` } = {}) => [
  '---', 'schema: dwmt/expert@1', `domain: ${domain}`, `title: ${title}`, ...(drop === 'maximizes' ? [] : ['maximizes: "usability"']),
  'guards:', '  - "every screen has a mockup"', 'explorers:', '  allowed: false', 'effort: high', '---', '## Rules', 'Ask about the user first.',
  ...Array.from({ length: lines }, (_, i) => `line ${i}`), '',
].join('\n');
