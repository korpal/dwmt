#!/usr/bin/env node
// Runner testów (kt, D-15): `node dwmt/test/run.mjs fast|slow|<plik>... [--jobs N] [--times <plik.md>] [--timeout-min M]`.
// Każdy plik we własnym `node --test` (pula --jobs), bez DWMT_TEST_TMP w env dziecka (dziecko ma własny katalog
// tymczasowy i sprząta go samo). Na końcu linia na plik `ok|not ok <n> - <ścieżka> # <s> s`, którą łapie
// `verify.failedFileRegex`, ogony czerwonych plików i podsumowanie. Wyjście 1: czerwony plik; 2: błąd użycia.
import { spawn } from 'node:child_process';
import { availableParallelism, platform } from 'node:os';
import { existsSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { TEST_DIR, fastFiles, slowFiles } from './sets.mjs';

const REPO = resolve(TEST_DIR, '..', '..');
const fwd = (p) => p.replace(/\\/g, '/');
const usage = (msg) => { process.stderr.write(`run.mjs: ${msg}\nusage: node dwmt/test/run.mjs fast|slow|<file>... [--jobs N] [--times <file.md>] [--timeout-min M]\n`); process.exit(2); };

export function parseArgs(argv) {
  const o = { names: [], jobs: Math.max(1, availableParallelism() - 1), times: null, timeoutMin: 30 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) usage(`${a} needs a value`); return v; };
    if (a === '--jobs') { o.jobs = Number(val()); if (!Number.isInteger(o.jobs) || o.jobs < 1) usage('--jobs must be a positive integer'); }
    else if (a === '--times') o.times = val();
    else if (a === '--timeout-min') { o.timeoutMin = Number(val()); if (!(o.timeoutMin > 0)) usage('--timeout-min must be positive'); }
    else if (a.startsWith('--')) usage(`unknown option ${a}`);
    else o.names.push(a);
  }
  return o;
}

function resolveFiles(names) {
  if (!names.length) usage('no set or files');
  if (names.length === 1 && (names[0] === 'fast' || names[0] === 'slow')) {
    const files = (names[0] === 'fast' ? fastFiles() : slowFiles()).map((f) => join(TEST_DIR, f));
    if (!files.length) usage(`set ${names[0]} has no files`);
    return { set: names[0], files };
  }
  const files = names.map((n) => resolve(n));
  for (const f of files) if (!existsSync(f)) usage(`no such file: ${f}`);
  return { set: 'files', files };
}

function runFile(file, timeoutMin) {
  return new Promise((res) => {
    const env = { ...process.env };
    delete env.DWMT_TEST_TMP;
    const t0 = Date.now();
    const p = spawn(process.execPath, ['--test', file], { cwd: process.cwd(), env, windowsHide: true });
    let out = '';
    let killed = false;
    p.stdout.on('data', (b) => { out += b; });
    p.stderr.on('data', (b) => { out += b; });
    const timer = setTimeout(() => { killed = true; p.kill(); }, timeoutMin * 60_000);
    p.on('close', (code) => {
      clearTimeout(timer);
      if (killed) out += `\n# killed after ${timeoutMin} min\n`;
      res({ file, ok: code === 0 && !killed, s: (Date.now() - t0) / 1000, out });
    });
    p.on('error', (e) => { clearTimeout(timer); res({ file, ok: false, s: (Date.now() - t0) / 1000, out: `${out}\n${e.message}` }); });
  });
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const { set, files } = resolveFiles(o.names);
  const rel = (f) => fwd(relative(REPO, f));
  const t0 = Date.now();
  const results = new Array(files.length);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      const r = await runFile(files[i], o.timeoutMin);
      results[i] = r;
      process.stdout.write(`# ${r.ok ? 'ok' : 'red'} ${rel(r.file)} ${r.s.toFixed(1)} s\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.jobs, files.length) }, worker));
  const wall = (Date.now() - t0) / 1000;
  const lines = results.map((r, i) => `${r.ok ? 'ok' : 'not ok'} ${i + 1} - ${rel(r.file)} # ${r.s.toFixed(1)} s`);
  process.stdout.write(`${lines.join('\n')}\n`);
  const red = results.filter((r) => !r.ok);
  for (const r of red) {
    const tail = r.out.replace(/\r/g, '').trimEnd().split('\n').slice(-40);
    process.stdout.write(`# --- ${rel(r.file)}\n${tail.map((l) => `# ${l}`).join('\n')}\n`);
  }
  process.stdout.write(`# ${set}: ${files.length} files, ${red.length} red, ${wall.toFixed(1)} s wall, jobs ${o.jobs}\n`);
  if (o.times) {
    const rows = [...results].sort((a, b) => b.s - a.s).map((r) => `| ${rel(r.file)} | ${r.s.toFixed(1)} | ${r.ok ? 'ok' : 'red'} |`);
    writeFileSync(o.times, [
      `# Test times`, '', `- date: ${new Date().toISOString()}`, `- node: ${process.version}`, `- platform: ${platform()}`,
      `- jobs: ${o.jobs}`, `- arguments: ${process.argv.slice(2).join(' ')}`, `- wall: ${wall.toFixed(1)} s`,
      `- files: ${files.length}, red: ${red.length}`, '', '| file | seconds | result |', '|---|---|---|', ...rows, '',
    ].join('\n'));
  }
  process.exitCode = red.length ? 1 : 0;
}

main();
