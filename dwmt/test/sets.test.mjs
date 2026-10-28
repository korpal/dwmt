import './tmp-root.mjs';
// Zestawy testów i środowisko testów (kt, AC-5, R-6, R-7, R-9): lista wolnych plików istnieje, każdy plik testów jest
// w dokładnie jednym zestawie, dzieci testów nie czytają prawdziwych transkryptów, kopie repo z szablonu są niezależne.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, relative, isAbsolute, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { SLOW, TEST_DIR, testFiles, fastFiles, slowFiles } from './sets.mjs';
import { repo, gitIn, fromTemplate } from './helpers.mjs';

test('sets: every SLOW entry is an existing dwmt/test/*.test.mjs, without duplicates', () => {
  assert.equal(new Set(SLOW).size, SLOW.length, 'duplicates in SLOW');
  for (const f of SLOW) {
    assert.match(f, /^[^/\\]+\.test\.mjs$/, f);
    assert.ok(existsSync(join(TEST_DIR, f)), `missing ${f}`);
  }
});

test('sets: fast and slow are disjoint and together are every test file', () => {
  const fast = fastFiles();
  const slow = slowFiles();
  assert.deepEqual(fast.filter((f) => slow.includes(f)), []);
  assert.deepEqual([...fast, ...slow].sort(), testFiles());
  assert.deepEqual(testFiles(), readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.mjs')).sort());
  assert.ok(fast.includes('sets.test.mjs'), 'the guard itself runs in the fast set');
});

test('env: DWMT_TRANSCRIPTS is an empty dir under DWMT_TEST_TMP', () => {
  const tr = process.env.DWMT_TRANSCRIPTS;
  assert.ok(tr, 'DWMT_TRANSCRIPTS set');
  assert.ok(statSync(tr).isDirectory());
  assert.deepEqual(readdirSync(tr), []);
  const rel = relative(process.env.DWMT_TEST_TMP, tr);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), `${tr} under ${process.env.DWMT_TEST_TMP}`);
});

test('env: NODE_COMPILE_CACHE is set', () => {
  assert.ok(process.env.NODE_COMPILE_CACHE);
});

test('template: two repo() calls are independent copies with a clean status', () => {
  const a = repo();
  const b = repo();
  assert.notEqual(a, b);
  const ga = gitIn(a);
  const gb = gitIn(b);
  assert.equal(ga('status', '--porcelain'), '');
  assert.equal(gb('status', '--porcelain'), '');
  assert.equal(gb('branch', '--show-current'), 'master');
  const head = gb('rev-parse', 'HEAD');
  writeFileSync(join(a, 'x.txt'), 'x\n');
  ga('add', '-A');
  ga('commit', '-q', '-m', 'x');
  assert.notEqual(ga('rev-parse', 'HEAD'), head);
  assert.equal(gb('rev-parse', 'HEAD'), head);
  assert.equal(gb('status', '--porcelain'), '');
  assert.equal(gb('config', 'user.email'), 't@example.com');
  assert.equal(gb('config', 'core.autocrlf'), 'false');
});

test('template: a builder whose files name its own directory builds on every call', () => {
  let builds = 0;
  const build = () => {
    builds++;
    const d = mkdtempSync(join(tmpdir(), 'dwmt-self-'));
    writeFileSync(join(d, 'where.txt'), `${basename(d)}\n`);
    return d;
  };
  const x = fromTemplate('self-naming', build);
  const y = fromTemplate('self-naming', build);
  assert.equal(builds, 2);
  assert.notEqual(x, y);
  let plain = 0;
  const p1 = fromTemplate('plain', () => { plain++; const d = mkdtempSync(join(tmpdir(), 'dwmt-plain-')); writeFileSync(join(d, 'a.txt'), 'a\n'); return d; });
  const p2 = fromTemplate('plain', () => { plain++; return null; });
  assert.equal(plain, 1);
  assert.notEqual(p1, p2);
  assert.ok(existsSync(join(p2, 'a.txt')));
});
