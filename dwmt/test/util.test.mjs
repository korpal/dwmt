import './tmp-root.mjs';
// Zapis atomowy (run.json, drive.json): ponowienia przy EPERM na Windows, na końcu zwykły zapis, bez pliku tmp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileAtomic } from '../scripts/lib/util.mjs';

const busy = (code) => Object.assign(new Error(code), { code });

test('writeFileAtomic: rename z EPERM dwa razy, potem udany: nowa treść, bez pliku tmp', () => {
  const d = mkdtempSync(join(tmpdir(), 'dwmt-atomic-'));
  const f = join(d, 'drive.json');
  writeFileSync(f, 'stare\n');
  let calls = 0;
  writeFileAtomic(f, 'nowe\n', { rename: (a, b) => { calls++; if (calls <= 2) throw busy('EPERM'); renameSync(a, b); } });
  assert.equal(calls, 3);
  assert.equal(readFileSync(f, 'utf8'), 'nowe\n');
  assert.deepEqual(readdirSync(d), ['drive.json']);
});

test('writeFileAtomic: rename zawsze EBUSY albo inny błąd: zwykły zapis, plik tmp usunięty', () => {
  for (const [code, expected] of [['EBUSY', 21], ['ENOENT', 1]]) {
    const d = mkdtempSync(join(tmpdir(), 'dwmt-atomic-'));
    const f = join(d, 'run.json');
    let calls = 0;
    writeFileAtomic(f, `{"x": "${code}"}\n`, { rename: () => { calls++; throw busy(code); } });
    assert.equal(calls, expected, code);
    assert.equal(readFileSync(f, 'utf8'), `{"x": "${code}"}\n`);
    assert.deepEqual(readdirSync(d), ['run.json']);
  }
});
