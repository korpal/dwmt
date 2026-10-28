import './tmp-root.mjs';
// Tanie poprawki po sprincie 3 cz. 2 i drugim projekcie: środowisko przed verify, powłoka verify, odłożone uwagi, koszt w raporcie.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyCommands, deferredEntries, sessionsCost, parseYaml, splitHeader } from '../scripts/dwmt.mjs';
import { deferredFindings } from '../scripts/lib/report.mjs';
import { repo, gitIn, cli, header, runFile, put, prepared, asRules } from './helpers.mjs';
import { pr } from './product-helpers.mjs';

const hdr = (f) => parseYaml(splitHeader(readFileSync(f, 'utf8')).yaml);
function withConfig(cfg, slug) {
  const d = repo();
  cli(d, 'setup');
  const f = join(d, '.claude', 'dwmt.json');
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), ...cfg }));
  return { d, run: prepared(d, slug), g: gitIn(d) };
}
const MARK = (d) => `node -e "process.exit(require('fs').existsSync('${d.replace(/\\/g, '/')}/env-ok')?0:1)"`;

test('środowisko: sprawdzenie z `for` tylko dla pasujących komend; niegotowe daje env bez tests.md i bez naprawy', () => {
  const probe = repo();
  const checks = [{ cmd: MARK(probe), hint: 'uruchom compose', for: 'with-env' }];
  const { d, run } = withConfig({ env: { checks } }, 'env');
  assert.match(cli(d, 'preflight', '--slug', 'x').json.warnings.join('\n'), /środowisko: uruchom compose/);
  writeFileSync(join(d, 'b.txt'), 'b\n');
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'DONE' });
  assert.equal(cli(d, 'verify', run).json.result, 'pass', 'komenda briefu nie pasuje do `for`');

  const f = join(d, '.claude', 'dwmt.json');
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), env: { checks: [{ ...checks[0], for: 'node' }] } }));
  const bf = runFile(d, run, 'tests.md');
  const before = readFileSync(bf, 'utf8');
  const v = cli(d, 'verify', run).json;
  assert.equal(v.result, 'env');
  assert.deepEqual(v.env, ['uruchom compose']);
  assert.equal(readFileSync(bf, 'utf8'), before, 'tests.md bez zmian');
  assert.equal(JSON.parse(readFileSync(runFile(d, run, 'run.json'), 'utf8')).repairs, undefined, 'to nie czerwień testów');
  writeFileSync(join(probe, 'env-ok'), '');
  assert.equal(cli(d, 'verify', run).json.result, 'pass');
});

test('powłoka verify: komendy przez verify.shell, architekt i wykonawca znają powłokę', () => {
  const bash = ['C:/Program Files/Git/bin/bash.exe', '/bin/bash'].find((b) => existsSync(b));
  const cwd = mkdtempSync(join(tmpdir(), 'dwmt-sh-'));
  if (bash) {
    const v = verifyCommands(["! grep -q x <<< 'y'"], cwd, { verify: { shell: bash, rerunRed: false } });
    assert.equal(v.result, 'pass', v.body);
  }
  const d = repo();
  cli(d, 'setup');
  const f = join(d, '.claude', 'dwmt.json');
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), verify: { shell: 'C:/Git/bin/bash.exe' } }));
  const run = cli(d, 'preflight', '--slug', 'sh').json.run;
  cli(d, 'init', '--run', run);
  writeFileSync(runFile(d, run, 'task.md'), 'Dodaj b.txt\n');
  assert.match(cli(d, 'state', run).json.prompt, /Verify shell: C:\/Git\/bin\/bash\.exe\./);
});

const REVIEW = `${header({ schema: 'dwmt/review@1', round: 1, passes: ['pragmatism'], verdict: 'PASS', fix: [], defer: ['F-1'], drop: ['F-2'], acceptance: ['AC-1 met'] })}
### F-1 [minor] Kalendarz wyrównany do prawej krawędzi
- Likely: \`date-picker.tsx:192\`

### F-2 [minor] Brak statusu zapisu

## pragmatism
- F-1 \`defer\` — jedno słowo, przy następnym dotknięciu
- F-2 \`drop\` — stan świeżo otwartego arkusza
`;

test('deferredEntries: nagłówek, powód z pragmatism i miejsce', () => {
  assert.deepEqual(deferredEntries([REVIEW], ['F-1']), ['- F-1 [minor] Kalendarz wyrównany do prawej krawędzi — jedno słowo, przy następnym dotknięciu (`date-picker.tsx:192`)']);
  // K2 R-2 (C-1, C-2, D-12): waga efektywna i znacznik podłogi, tytuł bez znaczników; linia pragmatism w formie z dwukropkiem.
  const floor = `${header({ schema: 'dwmt/review@1', round: 1, verdict: 'PASS', fix: [], defer: ['F-1'], drop: [] })}### F-1 [minor] [floor: data-loss] Cleanup removes the parent dir\n\n## pragmatism\n- F-1 \`defer\` — outside the brief\n`;
  assert.deepEqual(deferredEntries([floor], ['F-1']), ['- F-1 [major] [floor: data-loss] Cleanup removes the parent dir — outside the brief']);
  assert.deepEqual(deferredEntries([floor.replace('- F-1 `defer` —', '- F-1: defer —')], ['F-1']), ['- F-1 [major] [floor: data-loss] Cleanup removes the parent dir — outside the brief']);
});

for (const [name, file, tracked] of [['ignorowany (domyślny .dwmt/)', null, false], ['śledzony, w squashu', 'docs/deferred.md', true]]) {
  test(`finish: odłożone uwagi w pliku zbiorczym — ${name}; koszt w raporcie`, () => {
    const root = mkdtempSync(join(tmpdir(), 'dwmt-tr-'));
    mkdirSync(join(root, 'proj', 'sess-1', 'subagents'), { recursive: true });
    const line = (u, rid) => JSON.stringify({ type: 'assistant', requestId: rid, message: { usage: u } });
    writeFileSync(join(root, 'proj', 'sess-1.jsonl'), [line({ input_tokens: 1e6 }, 'a'), line({ input_tokens: 1e6 }, 'a')].join('\n'));
    writeFileSync(join(root, 'proj', 'sess-1', 'subagents', 'agent-x.jsonl'), line({ output_tokens: 1e5, cache_read_input_tokens: 2e6 }, 'b'));
    writeFileSync(join(root, 'proj', 'sess-1', 'subagents', 'agent-x.meta.json'), JSON.stringify({ agentType: 'dwmt-executor' }));
    assert.deepEqual(sessionsCost(['sess-1'], root), { total: 1.6, byRole: { orchestrator: 1, 'dwmt-executor': 0.6 }, sessions: 1 });
    assert.equal(sessionsCost(['brak'], root), null);

    const { d, run, g } = withConfig(file ? { review: { deferredFile: file } } : {}, tracked ? 'dt' : 'di');
    // K5 R-7 (D-6): a run on rules 2.11 keeps its report's first lines (no 2.12 summary block).
    asRules(d, run, '2.11');
    writeFileSync(join(d, 'b.txt'), 'b\n');
    put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'DONE' });
    cli(d, 'verify', run);
    cli(d, 'review-input', run);
    writeFileSync(runFile(d, run, 'review-1.md'), REVIEW);
    cli(d, 'commit', run);
    const prevTr = process.env.DWMT_TRANSCRIPTS;
    process.env.DWMT_TRANSCRIPTS = root;
    const fin = cli(d, 'finish', run).json;
    if (prevTr === undefined) delete process.env.DWMT_TRANSCRIPTS; else process.env.DWMT_TRANSCRIPTS = prevTr;
    assert.equal(fin.status, 'squashed', JSON.stringify(fin));
    assert.equal(fin.cost, 1.6);
    const rep = readFileSync(runFile(d, run, 'final-report.md'), 'utf8');
    assert.deepEqual(hdr(runFile(d, run, 'final-report.md')).cost.byRole, { orchestrator: 1, 'dwmt-executor': 0.6 });
    assert.match(rep, /## Cost\n- 1\.6 M tokens/);
    // K2 R-3 (C-1, D-10): pierwsza linia po H1 to liczba odłożonych uwag, potem `- Run:`; sekcja z pełnym identyfikatorem.
    const body = splitHeader(rep).body.replace(/^\s+/, '');
    assert.match(body, /^# Final report: [^\n]*\n\n- Deferred findings: 1, of which 0 major\.\n- Run: /);
    assert.match(rep, /\n## Deferred findings\n- T-1\/F-1 \[minor\] Kalendarz wyrównany do prawej krawędzi — jedno słowo, przy następnym dotknięciu \(`date-picker\.tsx:192`\)\n[\s\S]*\n## Reviews\n/);
    assert.deepEqual(hdr(runFile(d, run, 'final-report.md')).deferred, ['F-1'], 'nagłówek: identyfikatory jak dotąd');
    const text = readFileSync(fin.deferred, 'utf8');
    assert.match(text, new RegExp(`## ${run}\\n\\nDodaj b\\.txt\\n\\n- F-1 \\[minor\\] Kalendarz`));
    assert.doesNotMatch(text, /F-2/);
    if (tracked) assert.match(g('show', 'master:docs/deferred.md'), /F-1 \[minor\]/);
    else assert.match(fin.deferred, /\.dwmt\/deferred\.md$/);
    assert.equal(g('rev-list', '--count', 'master'), '3', 'jeden squash nad setupem');
  });
}

// K2 R-3 (D-4, D-7): z warstwą produktową obecną i włączoną finish nie pisze pliku odłożonych uwag; trafiają do backlogu przez intake.
test('finish: z warstwą produktową odłożone uwagi idą do backlogu (intake), bez pliku odłożonych uwag', () => {
  const d = repo();
  cli(d, 'setup');
  const p = pr(d, 'init', '--goal', 'Pilot: deferred findings');
  assert.equal(p.code, 0, p.out);
  const run = prepared(d, 'dp');
  writeFileSync(join(d, 'b.txt'), 'b\n');
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'DONE' });
  cli(d, 'verify', run);
  cli(d, 'review-input', run);
  writeFileSync(runFile(d, run, 'review-1.md'), REVIEW);
  cli(d, 'commit', run);
  const fin = cli(d, 'finish', run).json;
  assert.equal(fin.status, 'squashed', JSON.stringify(fin));
  assert.equal(fin.deferred, undefined, 'bez pliku odłożonych uwag');
  assert.equal(existsSync(join(d, '.dwmt', 'deferred.md')), false);
  assert.ok(fin.intake && !fin.intake.warning && fin.intake.items >= 1, JSON.stringify(fin.intake));
  assert.match(readFileSync(join(d, 'docs', 'product', 'backlog.jsonl'), 'utf8'), /Kalendarz wyrównany do prawej krawędzi/);
});

// K2 F-3 (C-3): otwarta pozycja rundy zbiorczej bez sekcji w recenzjach (znana czerwień `KR-n`) ma wagę i tytuł z pozycji;
// nagłówek z wagą w nawiasie okrągłym zachowuje wagę i tytuł.
test('deferredFindings: otwarta znana czerwień z wagą i tytułem pozycji; waga w nawiasie okrągłym', () => {
  const top = mkdtempSync(join(tmpdir(), 'dwmt-df-'));
  const dir = join(top, '.dwmt', 'runs', 'r1', 'tasks', '1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'review-1.md'), `${header({ schema: 'dwmt/review@1', round: 1, verdict: 'PASS', fix: [], defer: ['F-1', 'F-2'], drop: [] })}### F-1 [minor] Label typo\n\n### F-2 (major) Wrong total\n`);
  const title = 'Known red test in a file this sprint changed (dwmt/test/a.test.mjs)';
  const run = { run: 'r1', rules: '2.8', tasks: [{ k: 1 }], batch: { items: [{ id: 'T-1/KR-1', task: 1, finding: 'KR-1', severity: 'major', title, reason: 'known-red' }] } };
  const list = deferredFindings(top, run, {});
  assert.deepEqual(list.map((x) => `${x.id} ${x.severity} ${x.title}`), ['T-1/F-1 minor Label typo', 'T-1/F-2 major Wrong total', `T-1/KR-1 major ${title}`]);
  assert.deepEqual(list.at(-1), { id: 'T-1/KR-1', task: 1, finding: 'KR-1', severity: 'major', floor: null, title, why: null, where: null });
  assert.equal(list.filter((x) => ['major', 'blocker'].includes(x.severity)).length, 2, 'liczone w M');
});

// K2 F-2 (C-1, AC-3): linie pod pierwszą linią raportu — po jednej na uwagę `major` i `blocker`, z pełnym identyfikatorem.
test('finish: odłożone uwagi major i blocker w pierwszych liniach raportu i w sekcji', () => {
  const { d, run } = withConfig({}, 'dm');
  // K5 R-7 (D-6): a run on rules 2.11 keeps its report's first lines (no 2.12 summary block).
  asRules(d, run, '2.11');
  writeFileSync(join(d, 'b.txt'), 'b\n');
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'DONE' });
  cli(d, 'verify', run);
  cli(d, 'review-input', run);
  writeFileSync(runFile(d, run, 'review-1.md'), `${header({ schema: 'dwmt/review@1', round: 1, passes: ['pragmatism'], verdict: 'PASS', fix: [], defer: ['F-1', 'F-3', 'F-4'], drop: [], acceptance: ['AC-1 met'] })}
### F-1 [minor] Label typo

### F-3 [minor] [floor: wrong-results] Totals rounded twice
- Likely: \`totals.mjs#sum\`

### F-4 [blocker] Export drops the last row

## pragmatism
- F-1: defer — cosmetic
- F-3: defer — next task touches totals
- F-4: defer — export is out of scope
`);
  cli(d, 'commit', run);
  // K2 R-6 (D-9): bramka staje na obu (major z podłogi i blocker), zanim przyjęcie przepuści squash.
  const stop = cli(d, 'finish', run).json;
  assert.equal(stop.status, 'deferred-major', JSON.stringify(stop));
  assert.deepEqual(stop.majors.map((m) => m.split(' ').slice(0, 2).join(' ')), ['T-1/F-3 [major]', 'T-1/F-4 [blocker]']);
  const fin = cli(d, 'finish', run, '--accept-deferred').json;
  assert.equal(fin.status, 'squashed', JSON.stringify(fin));
  const rep = readFileSync(runFile(d, run, 'final-report.md'), 'utf8');
  const body = splitHeader(rep).body.replace(/^\s+/, '');
  const on = ` \\(accepted by the user ${new Date().toISOString().slice(0, 10)}\\)`;
  assert.match(body, new RegExp(`^# Final report: [^\\n]*\\n\\n- Deferred findings: 3, of which 2 major\\.\\n {2}- T-1/F-3 \\[major\\] Totals rounded twice${on}\\n {2}- T-1/F-4 \\[blocker\\] Export drops the last row${on}\\n- Run: `));
  assert.deepEqual(hdr(runFile(d, run, 'final-report.md')).acceptedDeferred, ['T-1/F-3', 'T-1/F-4']);
  assert.match(rep, /\n## Deferred findings\n- T-1\/F-1 \[minor\] Label typo — cosmetic\n- T-1\/F-3 \[major\] \[floor: wrong-results\] Totals rounded twice — next task touches totals \(`totals\.mjs#sum`\)\n- T-1\/F-4 \[blocker\] Export drops the last row — export is out of scope\n[\s\S]*\n## Reviews\n/);
});
