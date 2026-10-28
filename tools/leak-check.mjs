#!/usr/bin/env node
// Leak check before publishing: scans files and commit messages for patterns that must not leave your machine
// (names of other projects, local paths). The patterns live outside the repo, in `~/.dwmt/forbidden.json`
// (or the file named by DWMT_FORBIDDEN): {"patterns": ["regex", …], "allow": [{"file", "pattern"}]}, case-insensitive.
//   node tools/leak-check.mjs              tracked and untracked (not ignored) files of the working tree
//   node tools/leak-check.mjs --pre-push   as a git pre-push hook: the pushed commits' trees and messages
// Exit 0: clean (or no pattern file); 1: matches, listed as `where:line: pattern`.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const git = (args, input) => execFileSync('git', args, { input, maxBuffer: 1 << 28 });
const ZERO = /^0+$/;

function loadRules() {
  const file = process.env.DWMT_FORBIDDEN || join(homedir(), '.dwmt', 'forbidden.json');
  if (!existsSync(file)) return null;
  const r = JSON.parse(readFileSync(file, 'utf8'));
  return { allow: r.allow ?? [], res: r.patterns.map((p) => ({ p, re: new RegExp(p, 'i') })) };
}

// Matches in one text (skipped when it has a 0 byte, i.e. binary).
function scanText(where, buf, rules, hits) {
  if (buf.includes(0)) return;
  const lines = buf.toString('utf8').split('\n');
  for (const { p, re } of rules.res) {
    if (rules.allow.some((a) => a.file === where && a.pattern === p)) continue;
    lines.forEach((l, i) => { if (re.test(l)) hits.push(`${where}:${i + 1}: ${p}`); });
  }
}

// Every blob of a commit's tree, read with one `cat-file --batch`.
function scanTree(sha, rules, hits) {
  const entries = git(['ls-tree', '-r', '-z', sha]).toString('utf8').split('\0').filter(Boolean)
    .map((l) => { const [meta, path] = l.split('\t'); const [, type, blob] = meta.split(' '); return { type, blob, path }; })
    .filter((e) => e.type === 'blob');
  if (!entries.length) return;
  const out = git(['cat-file', '--batch'], entries.map((e) => e.blob).join('\n') + '\n');
  let pos = 0;
  for (const e of entries) {
    const nl = out.indexOf(10, pos);
    const size = Number(out.subarray(pos, nl).toString('utf8').split(' ')[2]);
    scanText(e.path, out.subarray(nl + 1, nl + 1 + size), rules, hits);
    pos = nl + 1 + size + 1;
  }
}

function prePush(rules, hits) {
  const lines = readFileSync(0, 'utf8').split('\n').filter(Boolean);
  for (const l of lines) {
    const [, local, , remote] = l.split(' ');
    if (ZERO.test(local)) continue; // deleting a remote ref
    scanTree(local, rules, hits);
    const range = ZERO.test(remote) ? [local, '--not', '--remotes'] : [`${remote}..${local}`];
    for (const c of git(['rev-list', ...range]).toString('utf8').split('\n').filter(Boolean)) {
      scanText(`commit ${c.slice(0, 7)}`, git(['log', '-1', '--format=%an <%ae>%n%B', c]), rules, hits);
    }
  }
}

function workingTree(rules, hits) {
  for (const f of git(['ls-files', '-z', '-co', '--exclude-standard']).toString('utf8').split('\0').filter(Boolean)) {
    if (existsSync(f)) scanText(f, readFileSync(f), rules, hits);
  }
}

const rules = loadRules();
if (!rules) {
  process.stderr.write('leak-check: no pattern file (~/.dwmt/forbidden.json or DWMT_FORBIDDEN), nothing checked\n');
} else {
  const hits = [];
  if (process.argv.includes('--pre-push')) prePush(rules, hits); else workingTree(rules, hits);
  if (hits.length) {
    const push = process.argv.includes('--pre-push') ? '; the push was stopped' : '';
    process.stderr.write(`${hits.join('\n')}\nleak-check: ${hits.length} forbidden matches${push}\n`);
    process.exitCode = 1;
  } else process.stderr.write('leak-check: clean\n');
}
