import './tmp-root.mjs';
// PM-3 cz. 3: kryteria scalane ze wszystkich recenzji, numeracja A-n dalej, założenia wielowierszowe w raporcie.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bullets, parseYaml, splitHeader } from '../scripts/dwmt.mjs';
import { repo, cli, header, runFile, put, prepared, UAT_NONE } from './helpers.mjs';

test('bullets: wcięte wiersze kontynuacji doklejone do punktu', () => {
  assert.deepEqual(bullets('## Assumptions\n- A-1 pierwszy\n  ciąg dalszy\n- A-2 drugi\n\ntekst\n'), ['A-1 pierwszy ciąg dalszy', 'A-2 drugi']);
});

test('raport: recheck nie kasuje kryteriów z rundy 1, prompt podaje następny A-n, założenie briefu w całości', () => {
  const d = repo();
  const run = prepared(d);
  writeFileSync(runFile(d, run, 'brief.md'), `${header({ schema: 'dwmt/brief@1', run, goal: 'Dodaj b.txt', mode: 'single', acceptance: ['AC-1 b.txt istnieje', 'AC-2 treść b'], scope: ['*.txt'], verify: ['node -e 0'], risk: [] })}# Plan\n\n## Decisions\n### D-1 prosto\nbez udziwnień\n\n## Assumptions\n- A-1 plik tekstowy;\n  bez BOM.\n- A-2 małe litery\n\n${UAT_NONE}`);

  assert.match(cli(d, 'state', run).json.prompt, /New assumptions start at A-3\./);
  writeFileSync(join(d, 'b.txt'), 'b\n');
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'DONE', assumptions: ['A-3 LF'] });
  cli(d, 'verify', run);
  cli(d, 'review-input', run);
  put(d, run, 'review-1.md', { schema: 'dwmt/review@1', round: 1, passes: ['correctness'], verdict: 'FIX', counts: { major: 1 }, fix: ['F-1'], defer: [], drop: [], acceptance: ['AC-1 met', 'AC-2 partial (F-1)'] },
    '## correctness\n### F-1 [major] zła treść\nx\n');
  const st = cli(d, 'state', run).json;
  assert.equal(st.next, 'fix');
  assert.match(st.prompt, /New assumptions start at A-4\./, 'runda 2 nie zaczyna od A-1');

  writeFileSync(join(d, 'b.txt'), 'B\n');
  put(d, run, 'result-2.md', { schema: 'dwmt/result@1', status: 'DONE', fixed: ['F-1'], notReproduced: [] });
  cli(d, 'verify', run);
  cli(d, 'review-input', run);
  put(d, run, 'review-2.md', { schema: 'dwmt/review@1', round: 2, passes: ['recheck'], verdict: 'PASS', fix: [], acceptance: ['AC-2 met'] });
  // kt (D-13): round 2 carried its command, so the changed tree gets one closing whole verify before the commit.
  const cl = cli(d, 'state', run).json;
  assert.deepEqual([cl.next, cl.closing], ['verify', true], JSON.stringify(cl));
  assert.equal(cli(d, 'verify', run).json.ok, true);
  assert.equal(cli(d, 'commit', run).json.ok, true);
  assert.equal(cli(d, 'finish', run).json.status, 'squashed');

  const report = readFileSync(runFile(d, run, 'final-report.md'), 'utf8');
  const rh = parseYaml(splitHeader(report).yaml);
  assert.deepEqual(rh.acceptance, ['AC-1 met', 'AC-2 met']);
  assert.match(report, /- AC-1 b\.txt istnieje → \*\*met\*\*\n- AC-2 treść b → \*\*met\*\*/);
  assert.match(report, /- A-1 plik tekstowy; bez BOM\.\n- A-2 małe litery/);
  assert.deepEqual(rh.assumptions, ['A-1', 'A-2', 'A-3 LF']);
});
