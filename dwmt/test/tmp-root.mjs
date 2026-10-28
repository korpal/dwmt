// Wspólny katalog tymczasowy procesu testów: `os.tmpdir()` (i procesy potomne: git, skrypty, atrapa claude) piszą
// do jednego katalogu, usuwanego przy wyjściu procesu. Przegląd 2026-10-09: testy zostawiały w %TEMP% ok. 30 tys.
// katalogów `dwmt-*` i zapełniły dysk C:. Import musi być pierwszy w pliku testu (moduły wykonują się w kolejności importów).
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Batch F-4: tests run by a supervised driver inherit DWMT_SUPERVISED; drivers and watchers under test notify unless a
// test sets it itself.
delete process.env.DWMT_SUPERVISED;

if (!process.env.DWMT_TEST_TMP) {
  // Canonical (long) path: cmd.exe may set TEMP to an 8.3 short name (C:\Users\ABCDEF~1\...), while git
  // (`rev-parse --show-toplevel`) reports the long one, so path assertions built from tmpdir() would not match.
  const base = realpathSync.native(tmpdir());
  const root = mkdtempSync(join(base, 'dwmt-test-'));
  process.env.DWMT_TEST_TMP = root;
  // kt (D-11): Node's compile cache outside the per-run root, so the CLI's modules compile once across runs.
  process.env.NODE_COMPILE_CACHE ??= join(base, 'dwmt-test-compile-cache');
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = root;
  // Live sprint view: test runs of `dwmt state` and the driver start no detached writers (live tests turn it on).
  process.env.DWMT_LIVE ??= '0';
  // K5 D-8: `dwmt launch` in tests starts no detached session watcher (k5-run turns it on with DWMT_PLATFORM_LOG).
  process.env.DWMT_LAUNCH_WATCH ??= 'off';
  // kt (R-6): test children never scan the user's real ~/.claude/projects.
  if (!process.env.DWMT_TRANSCRIPTS) {
    const none = join(root, 'no-transcripts');
    mkdirSync(none);
    process.env.DWMT_TRANSCRIPTS = none;
  }
  process.on('exit', () => {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch { /* plik zajęty przez proces potomny: zostaje */ }
  });
}
