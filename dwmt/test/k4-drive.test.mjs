import './tmp-root.mjs';
// K4 (T-4, D-2, D-26, D-27): sterownik domyślnie włączony w projektach bez własnego `drive.enabled`, sesja modelu jako
// powrót (`"drive": {"enabled": false}`), jednorazowy komunikat `init` ze znacznikiem w drzewie domowym przebiegu.
// Bez szwu DWMT_DRIVE_DEFAULT (helpers.mjs ustawia go dla testów ścieżki sesji): ten plik sprawdza nowy domyślny.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULTS, loadConfig } from '../scripts/dwmt.mjs';
import { DRIVE_NOTICE } from '../scripts/lib/setup.mjs';
import { repo } from './helpers.mjs';
import { RUN, repo28, start, writePlans, cliAs } from './fixtures28.mjs';

delete process.env.DWMT_DRIVE_DEFAULT;

const withProject = (cfg) => {
  const d = repo();
  if (cfg !== undefined) { mkdirSync(join(d, '.claude'), { recursive: true }); writeFileSync(join(d, '.claude', 'dwmt.json'), JSON.stringify(cfg)); }
  return d;
};
const marker = (d) => join(d, '.dwmt', 'drive-default-noted.json');
const initJson = (d, slug, ...args) => {
  const run = cliAs(d, 'sess-1', 'preflight', '--slug', slug).json.run;
  const i = cliAs(d, 'sess-1', 'init', '--run', run, ...args).json;
  assert.equal(i?.ok, true, JSON.stringify(i));
  return { run, i };
};

test('K4 loadConfig: drive.enabled domyślnie true, driveDefault bez własnego ustawienia; projekt wygrywa; szew off', () => {
  assert.equal(DEFAULTS.drive.enabled, true);
  const none = loadConfig(withProject());
  assert.deepEqual([none.drive.enabled, none.driveDefault], [true, true]);
  const off = loadConfig(withProject({ drive: { enabled: false } }));
  assert.deepEqual([off.drive.enabled, 'driveDefault' in off], [false, false]);
  const other = loadConfig(withProject({ drive: { permissionMode: 'auto' } }));
  assert.deepEqual([other.drive.enabled, other.driveDefault, other.drive.permissionMode], [true, true, 'auto']);
  const on = loadConfig(withProject({ drive: { enabled: true } }));
  assert.deepEqual([on.drive.enabled, 'driveDefault' in on], [true, false]);
  // R-4: pętla supervisora czyta `cfg.drive.enabled` z loadConfig: projekt bez klucza `drive` idzie sterownikiem.
  process.env.DWMT_DRIVE_DEFAULT = 'off';
  try {
    assert.equal(loadConfig(withProject()).drive.enabled, false);
    assert.equal(loadConfig(withProject({ drive: { enabled: true } })).drive.enabled, true);
  } finally { delete process.env.DWMT_DRIVE_DEFAULT; }
  assert.equal(DEFAULTS.drive.enabled, true, 'loadConfig nie zmienia DEFAULTS');
});

test('K4 state: single bez klucza drive → drive: true; inline bez sterownika; drive.enabled false → sesja z efektami', () => {
  const { d } = repo28();
  const run = start(d, 'kon');
  writePlans(d, run);
  const st = cliAs(d, 'sess-1', 'state', run).json;
  assert.equal(st.next, 'implement', JSON.stringify(st));
  assert.equal(st.drive, true);
  assert.equal(RUN(d, run).tasks[0].started?.[1], undefined, 'state sesji pod sterownikiem nie zapisuje started');
  const run2 = start(d, 'kin', '--mode', 'inline');
  const st2 = cliAs(d, 'sess-1', 'state', run2).json;
  assert.equal(st2.mode, 'inline', JSON.stringify(st2));
  assert.equal('drive' in st2, false);
  // R-1: powrót do sesji modelu.
  const { d: d3 } = repo28({ drive: { enabled: false } });
  const run3 = start(d3, 'koff');
  writePlans(d3, run3);
  const st3 = cliAs(d3, 'sess-1', 'state', run3).json;
  assert.equal(st3.next, 'implement', JSON.stringify(st3));
  assert.equal('drive' in st3, false);
  assert.ok(RUN(d3, run3).tasks[0].started?.[1], 'sesja zapisuje started');
});

test('K4 init: komunikat raz na projekt (znacznik), bez niego przy własnym ustawieniu i w trybie inline', () => {
  const { d } = repo28();
  assert.equal(existsSync(marker(d)), false);
  const first = initJson(d, 'n1', '--mode', 'single').i;
  assert.equal(first.notice, DRIVE_NOTICE);
  assert.match(first.notice, /domyślnie włączony.*"drive": \{"enabled": false\}/);
  assert.ok(JSON.parse(readFileSync(marker(d), 'utf8')).at);
  const second = initJson(d, 'n2', '--mode', 'single').i;
  assert.equal('notice' in second, false);
  // Własne ustawienie (w tę albo w drugą stronę): bez komunikatu i bez znacznika.
  for (const enabled of [true, false]) {
    const { d: e } = repo28({ drive: { enabled } });
    assert.equal('notice' in initJson(e, `x${enabled}`, '--mode', 'single').i, false);
    assert.equal(existsSync(marker(e)), false);
  }
  // Tryb inline zostaje sesją modelu: bez komunikatu; następny start sterownikiem dostaje go.
  const { d: f } = repo28();
  assert.equal('notice' in initJson(f, 'inl', '--mode', 'inline').i, false);
  assert.equal(existsSync(marker(f)), false);
  assert.equal(initJson(f, 'sgl', '--mode', 'single').i.notice, DRIVE_NOTICE);
});

test('K4 init --worktree: znacznik komunikatu w głównym drzewie, nie w worktree przebiegu', () => {
  const { d } = repo28();
  const run = cliAs(d, 'sess-1', 'preflight', '--slug', 'wt', '--worktree').json.run;
  const i = cliAs(d, 'sess-1', 'init', '--run', run, '--mode', 'single', '--worktree').json;
  assert.equal(i?.ok, true, JSON.stringify(i));
  assert.equal(i.notice, DRIVE_NOTICE);
  assert.ok(i.worktree);
  assert.equal(existsSync(marker(d)), true);
  assert.equal(existsSync(marker(i.worktree)), false);
  const run2 = cliAs(d, 'sess-1', 'preflight', '--slug', 'wt2', '--worktree').json.run;
  const i2 = cliAs(d, 'sess-1', 'init', '--run', run2, '--mode', 'single', '--worktree').json;
  assert.equal(i2?.ok, true, JSON.stringify(i2));
  assert.equal('notice' in i2, false);
});
