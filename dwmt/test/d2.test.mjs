import './tmp-root.mjs';
// D2: recenzja i wykonawca po PM-3 cz. 1 (szacunek z diffu, pliki generowane, naprawa czerwieni, flaky,
// zmiana komend verify, recheck z weryfikatorem UI, limity tur).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { splitPatch, mergeReviews, maxFinding, unitFindings, verifyCommands, parseYaml, splitHeader, reportedPaths, diffParts, snapshotTree } from '../scripts/dwmt.mjs';
import { repo, gitIn, cli, header, runFile, put, prepared } from './helpers.mjs';

const hdr = (f) => parseYaml(splitHeader(readFileSync(f, 'utf8')).yaml);
const RUN = (d) => JSON.parse(readFileSync(join(d, '.dwmt', 'runs', readFileSync(join(d, '.dwmt', 'last'), 'utf8'), 'run.json'), 'utf8'));

// Repo z configiem i przebiegiem single na gotowym briefie; `cfg` łączony z domyślnym configiem setup.
function withConfig(cfg, mode = 'single', slug = 'd2') {
  const d = repo();
  cli(d, 'setup');
  const f = join(d, '.claude', 'dwmt.json');
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), ...cfg }));
  const run = prepared(d, slug, mode);
  writeFileSync(join(d, '.dwmt', 'last'), run);
  return { d, run, g: gitIn(d) };
}
const RED = (d) => `node -e "process.exit(require('fs').existsSync('../${basename(d)}-red')?1:0)"`;

test('splitPatch: plik nowy, zmieniony, usunięty i przemianowany', () => {
  const p = [
    'diff --git a/new.txt b/new.txt', 'new file mode 100644', '--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1 @@', '+a',
    'diff --git a/src/x y.ts b/src/x y.ts', '--- a/src/x y.ts', '+++ b/src/x y.ts', '@@ -1 +1 @@', '-a', '+b',
    'diff --git a/gone.txt b/gone.txt', 'deleted file mode 100644', '--- a/gone.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-a',
    'diff --git a/old.md b/new.md', 'similarity index 100%', 'rename from old.md', 'rename to new.md', '',
  ].join('\n');
  const parts = splitPatch(p);
  assert.deepEqual(parts.map((x) => x.file), ['new.txt', 'src/x y.ts', 'gone.txt', 'new.md']);
  assert.equal(parts.map((x) => x.text).join(''), p, 'części składają się w cały patch');
  assert.deepEqual(splitPatch(''), []);
});

test('szacunek z diffu: duży plik z małą zmianą to jedna jednostka; pliki generowane poza diffem recenzenta', () => {
  const d = repo();
  const g = gitIn(d);
  mkdirSync(join(d, 'api'), { recursive: true });
  mkdirSync(join(d, 'gen'), { recursive: true });
  writeFileSync(join(d, 'api', 'openapi.json'), `${'{"x": 1}\n'.repeat(90000)}`);
  g('add', '-A');
  g('commit', '-q', '-m', 'duży kontrakt');
  cli(d, 'setup');
  const f = join(d, '.claude', 'dwmt.json');
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), review: { ignoreGlobs: ['gen/**'] } }));
  const run = prepared(d, 'duzy');
  const bf = runFile(d, run, 'brief.md');
  // K2: the scope covers every file the test changes (out-of-scope unreported files lose their content in diff.patch).
  writeFileSync(bf, readFileSync(bf, 'utf8').replace('risk: []', 'risk: []\nareas: {"api": ["api/**"], "gen": ["gen/**"]}').replace(/^scope: .*$/m, 'scope: ["*.txt", "api/**", "gen/**"]'));
  cli(d, 'state', run);
  writeFileSync(join(d, 'api', 'openapi.json'), `{"y": 2}\n${readFileSync(join(d, 'api', 'openapi.json'), 'utf8')}`);
  writeFileSync(join(d, 'gen', 'client.ts'), 'export const generated = 1;\n');
  writeFileSync(join(d, 'b.txt'), 'b\n');
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'DONE' });
  assert.equal(cli(d, 'verify', run).json.ok, true);
  const ri = cli(d, 'review-input', run).json;
  assert.equal(ri.units, undefined, 'plik 900 KB z jednym hunkiem nie dzieli recenzji (PM-3: statSync)');
  assert.equal(ri.files, 2);
  const input = readFileSync(runFile(d, run, 'review-input.md'), 'utf8');
  assert.match(hdr(runFile(d, run, 'review-input.md')).diff, /diff-review\.patch$/);
  assert.match(input, /Generated, not in the diff \(`review.ignoreGlobs`\): `gen\/client\.ts`\./);
  assert.doesNotMatch(input, /^- gen\/client\.ts$/m);
  const reviewPatch = readFileSync(runFile(d, run, 'diff-review.patch'), 'utf8');
  assert.match(reviewPatch, /api\/openapi\.json/);
  assert.doesNotMatch(reviewPatch, /gen\/client\.ts/);
  assert.match(readFileSync(runFile(d, run, 'diff.patch'), 'utf8'), /gen\/client\.ts/, 'pełny diff zostaje dla wykonawcy');
});

test('drugie spojrzenie domyślnie wyłączone; limity tur wykonawcy 100 i recenzenta 200', () => {
  const { d, run } = withConfig({ review: { splitAboveK: 0.001 } }, 'single', 'sl');
  const risks = '\n## Risks\n### R-1 [critical] Faktura raz\n- Method: test\n- Area: billing\n';
  const text = readFileSync(runFile(d, run, 'brief.md'), 'utf8').replace('risk: []', 'risk: []\nrisks: ["R-1"]\nareas: {"billing": ["billing/**"]}').replace(/^scope: .*$/m, 'scope: ["*.txt", "billing/**"]') + risks;
  writeFileSync(runFile(d, run, 'brief.md'), text);
  cli(d, 'state', run);
  mkdirSync(join(d, 'billing'));
  writeFileSync(join(d, 'billing', 'x.txt'), 'billing\n');
  writeFileSync(join(d, 'y.txt'), 'y\n');
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'DONE' });
  cli(d, 'verify', run);
  assert.deepEqual(cli(d, 'review-input', run).json.units.map((u) => u.unit), ['billing', 'rest']);
  assert.match(readFileSync(join(d, '.claude', 'agents', 'dwmt-executor.md'), 'utf8'), /^maxTurns: 100$/m);
  assert.match(readFileSync(join(d, '.claude', 'agents', 'dwmt-reviewer.md'), 'utf8'), /^maxTurns: 200$/m);
  assert.match(readFileSync(join(d, '.claude', 'agents', 'dwmt-executor.md'), 'utf8'), /template 16/);
});

test('K2 reportedPaths: ścieżka z czoła wpisu outOfScopeChanges', () => {
  assert.deepEqual(reportedPaths(['src/billing/invoice.ts#invoice: message shortened to pass the length test']), ['src/billing/invoice.ts']);
  assert.deepEqual(reportedPaths(['fixed.txt: the marker the full suite check needs']), ['fixed.txt']);
  assert.deepEqual(reportedPaths(['src\\a.ts:12 — off by one', 'b.js — x', 'd.js something', 'b.js: again']), ['src/a.ts', 'b.js', 'd.js']);
  assert.deepEqual(reportedPaths(undefined), []);
});

test('kr1 reportedPaths: every path-like token of an entry, in any form (D-8, D-16)', () => {
  assert.deepEqual(reportedPaths(['`src/a.ts`: why']), ['src/a.ts']);
  assert.deepEqual(reportedPaths(['`src/a.ts#f`: why']), ['src/a.ts']);
  assert.deepEqual(reportedPaths(['"src/a.ts": why']), ['src/a.ts']);
  assert.deepEqual(reportedPaths(['src/a.ts:why']), ['src/a.ts']);
  assert.deepEqual(reportedPaths(['src/a.ts:12-14 why', 'src/b.ts:L12', 'src/c.ts:12:5']), ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  // A suffix outside the wrapping: the closing backtick or quote surfaces only after the cut.
  assert.deepEqual(reportedPaths(['`src/a.ts`:12 why', '"src/b.ts"#f', '`src/c.ts`:L3', '`src/d.ts`#invoice: x']), ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
  assert.deepEqual(reportedPaths(['src/a.ts, src/b.ts: shared helper']), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(reportedPaths(['Fixed src/a.ts and README.md.']), ['src/a.ts', 'README.md']);
  assert.deepEqual(reportedPaths(['(src/a.ts) why', '[src/b.ts]']), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(reportedPaths(['app/[id]/page.tsx: route']), ['app/[id]/page.tsx']);
  assert.deepEqual(reportedPaths(['C:\\Work\\Repo\\src\\a.ts: x'], 'c:/work/repo'), ['src/a.ts']);
  assert.deepEqual(reportedPaths(['/work/repo/src/b.ts: y'], '/work/repo'), ['src/b.ts']);
  assert.deepEqual(reportedPaths(['refactor only']), []);
});

test('K2 diffParts: treść w zakresie i zgłoszona, reszta po nazwie, warstwa produktowa osobno', () => {
  const files = ['b.txt', 'docs/product/roadmap.md', 'docs/product/roadmap.html', 'gen/client.ts', 'src/x.ts', 'other/y.js'];
  const parts = diffParts(files, { scope: ['*.txt', 'src/**'], reported: ['gen/client.ts'], productDir: 'docs/product', publish: 'docs/product/roadmap.html' });
  assert.deepEqual(parts.content, ['b.txt', 'gen/client.ts', 'src/x.ts']);
  assert.deepEqual(parts.outside, ['other/y.js']);
  assert.deepEqual(parts.product, ['docs/product/roadmap.md', 'docs/product/roadmap.html']);
  // Bez zakresu (plan sprzed K2): tylko filtr produktowy; katalog z `./` i `/`, strona poza katalogiem.
  const legacy = diffParts([...files, 'site/roadmap.html'], { productDir: './docs/product/', publish: 'site/roadmap.html' });
  assert.deepEqual(legacy.content, ['b.txt', 'gen/client.ts', 'src/x.ts', 'other/y.js']);
  assert.deepEqual(legacy.outside, []);
  assert.deepEqual(legacy.product, ['docs/product/roadmap.md', 'docs/product/roadmap.html', 'site/roadmap.html']);
});

test('K2 diff.patch: tylko pliki w zakresie i zgłoszone; niezgłoszone i warstwa produktowa po nazwie we wejściu recenzji', () => {
  const { d, run, g } = withConfig({ product: { dir: 'docs/product' } }, 'single', 'k2scope');
  mkdirSync(join(d, 'docs', 'product'), { recursive: true });
  mkdirSync(join(d, 'other'), { recursive: true });
  mkdirSync(join(d, 'rep'), { recursive: true });
  writeFileSync(join(d, 'b.txt'), 'b\n');
  writeFileSync(join(d, 'other', 'x.js'), 'export const x = 1;\n');
  writeFileSync(join(d, 'rep', 'y.js'), 'export const y = 1;\n');
  writeFileSync(join(d, 'rep', 'z.js'), 'export const f = 1;\n');
  writeFileSync(join(d, 'docs', 'product', 'roadmap.md'), '# Roadmap\n');
  g('add', '--', 'docs/product');
  g('commit', '-q', '-m', 'product: update', '--', 'docs/product');
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'DONE', outOfScopeChanges: ['rep/y.js: helper for the test', '`rep/z.js#f`: second helper'] });
  assert.equal(cli(d, 'verify', run).json.ok, true);
  const diff = cli(d, 'diff', run).json;
  assert.equal(diff.outside, 1);
  assert.equal(diff.product, 1);
  const ri = cli(d, 'review-input', run).json;
  assert.equal(ri.ok, true, JSON.stringify(ri));
  const patch = readFileSync(runFile(d, run, 'diff.patch'), 'utf8');
  assert.match(patch, /^diff --git a\/b\.txt b\/b\.txt$/m);
  assert.match(patch, /^diff --git a\/rep\/y\.js b\/rep\/y\.js$/m, 'R-3: zgłoszona zmiana poza zakresem zachowuje treść');
  assert.match(patch, /^diff --git a\/rep\/z\.js b\/rep\/z\.js$/m, 'kr1 R-1: zgłoszenie w odwróconych apostrofach z #Symbol zachowuje treść');
  assert.doesNotMatch(patch, /other\/x\.js/);
  assert.doesNotMatch(patch, /docs\/product/, 'R-1: commit warstwy produktowej poza diffem zadania');
  const input = readFileSync(runFile(d, run, 'review-input.md'), 'utf8');
  assert.match(input, /^Changed outside the task scope and not reported by the executor \(names only, not in the diff; read the file to review it\): `other\/x\.js`\.$/m, 'R-2');
  assert.match(input, /^Product-layer files changed on the branch \(not part of the task, not in the diff\): `docs\/product\/roadmap\.md`\.$/m);
  assert.doesNotMatch(input, /^- docs\/product/m);
  assert.doesNotMatch(input, /^- other\/x\.js$/m);
  assert.doesNotMatch(input, /^Changed outside the task scope.*rep\/z\.js/m, 'kr1: zgłoszony plik nie jest w linii poza zakresem');
});

test('naprawa: czerwone testy celowane raz wracają do wykonawcy rundy, druga czerwień idzie do recenzji', () => {
  const { d, run } = withConfig({}, 'single', 'rep');
  writeFileSync(join(d, '.claude', 'dwmt.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(d, '.claude', 'dwmt.json'), 'utf8')), verify: { targeted: RED(d), full: [] } }));
  writeFileSync(join(d, '..', `${basename(d)}-red`), '1');
  assert.equal(cli(d, 'state', run).json.next, 'implement');
  writeFileSync(join(d, 'b.txt'), 'b\n');
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'DONE', evidence: ['R-9 t › a'] });
  const v = cli(d, 'verify', run).json;
  assert.equal(v.ok, false);
  assert.equal(v.repair, true);
  let st = cli(d, 'state', run).json;
  assert.equal(st.next, 'repair');
  assert.equal(st.agent, 'dwmt-executor');
  assert.match(st.output, /repair-1\.md$/);
  assert.match(st.prompt, /^Round 1, repair: the targeted tests in .*tests\.md are red\. Make them green without weakening or skipping tests\. .*`unrelatedRed`.*Result: .*repair-1\.md\. The script runs `verify` in \S+\. New assumptions start at A-\d+\.$/);
  assert.equal(cli(d, 'state', run).json.next, 'repair', 'state powtarzalny');

  put(d, run, 'repair-1.md', { schema: 'dwmt/result@1', status: 'DONE', unrelatedRed: ['red.js: red on master too'] });
  assert.equal(cli(d, 'state', run).json.next, 'verify');
  const v2 = cli(d, 'verify', run).json;
  assert.equal(v2.ok, false);
  assert.equal(v2.repair, undefined, 'druga czerwień bez kolejnej naprawy');
  assert.equal(cli(d, 'state', run).json.next, 'verify', 'teraz review-input');
  cli(d, 'review-input', run);
  const input = readFileSync(runFile(d, run, 'review-input.md'), 'utf8');
  assert.match(input, /## Red tests the executor attributes to other causes\n\n- red\.js: red on master too/);
  st = cli(d, 'state', run).json;
  assert.equal(st.next, 'review');

  put(d, run, 'review-1.md', { schema: 'dwmt/review@1', round: 1, passes: ['correctness'], verdict: 'FIX', fix: ['F-1'] }, '### F-1 [blocker] czerwone\n');
  assert.equal(cli(d, 'state', run).json.next, 'fix');
  put(d, run, 'result-2.md', { schema: 'dwmt/result@1', status: 'DONE', fixed: ['F-1'] });
  assert.equal(cli(d, 'verify', run).json.repair, true, 'każda runda ma swoją jedną naprawę');
  st = cli(d, 'state', run).json;
  assert.equal(st.next, 'repair');
  assert.equal(st.agent, 'dwmt-executor-high');
  assert.equal(st.round, 2);
});

test('naprawa w inline: orkiestrator poprawia sam, potem verify i recenzja', () => {
  const { d, run } = withConfig({}, 'inline', 'repi');
  writeFileSync(join(d, '.claude', 'dwmt.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(d, '.claude', 'dwmt.json'), 'utf8')), verify: { targeted: RED(d), full: [] } }));
  writeFileSync(join(d, '..', `${basename(d)}-red`), '1');
  writeFileSync(join(d, 'c.txt'), 'c\n');
  assert.equal(cli(d, 'verify', run).json.repair, true);
  const st = cli(d, 'state', run).json;
  assert.equal(st.next, 'repair');
  assert.equal(st.agent, null);
  assert.match(st.hint, /inline: popraw sam czerwone testy/);
  assert.equal(cli(d, 'verify', run).json.repair, undefined);
  cli(d, 'review-input', run);
  assert.equal(cli(d, 'state', run).json.next, 'review');
});

// kt (D-4, D-13): brief verify replaced by `cmds`; `B` is red while the tracked b.txt holds `broken`.
const setVerify = (d, run, cmds) => {
  const bf = runFile(d, run, 'brief.md');
  writeFileSync(bf, readFileSync(bf, 'utf8').replace('verify: ["node -e 0"]', `verify: ${JSON.stringify(cmds)}`));
};
const CMD_A = 'node -e "process.exit(0)"';
const CMD_B = `node -e "const f=require('fs');process.exit(f.existsSync('b.txt')&&f.readFileSync('b.txt','utf8').trim()==='broken'?1:0)"`;
const pass = (round, verdict = 'PASS', extra = {}) => ({ schema: 'dwmt/review@1', round, passes: ['correctness'], verdict, fix: verdict === 'PASS' ? [] : ['F-1'], acceptance: ['AC-1 met'], ...extra });

test('closing verify: a fix that breaks a carried command is caught by one whole run before commit', () => {
  const { d, run } = withConfig({}, 'single', 'cl1');
  setVerify(d, run, [CMD_A, CMD_B]);
  assert.equal(cli(d, 'state', run).json.next, 'implement');
  writeFileSync(join(d, 'b.txt'), 'ok\n');
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'DONE' });
  const v1 = cli(d, 'verify', run).json;
  assert.equal(v1.ok, true, JSON.stringify(v1));
  assert.equal(hdr(runFile(d, run, 'tests.md')).whole, true);
  cli(d, 'review-input', run);
  put(d, run, 'review-1.md', pass(1, 'FIX'), '### F-1 [major] x\n');
  assert.equal(cli(d, 'state', run).json.next, 'fix');
  // round 2: the fix breaks B, whose command is carried (nothing in it changed)
  writeFileSync(join(d, 'b.txt'), 'broken\n');
  put(d, run, 'result-2.md', { schema: 'dwmt/result@1', status: 'DONE', fixed: ['F-1'] });
  const v2 = cli(d, 'verify', run).json;
  assert.equal(v2.ok, true, JSON.stringify(v2));
  assert.equal(v2.carried, 2);
  const h2 = hdr(runFile(d, run, 'tests.md'));
  assert.deepEqual(h2.commands.map((c) => [c.cmd, c.exit, c.ms, c.carried]), [[CMD_A, 0, 0, true], [CMD_B, 0, 0, true]]);
  assert.equal(h2.whole, false);
  cli(d, 'review-input', run);
  put(d, run, 'review-2.md', pass(2));
  let st = cli(d, 'state', run).json;
  assert.equal(st.next, 'verify');
  assert.equal(st.closing, true);
  const v3 = cli(d, 'verify', run).json;
  assert.equal(v3.ok, false);
  assert.equal(v3.closing, true);
  assert.equal(v3.repair, true);
  st = cli(d, 'state', run).json;
  assert.equal(st.next, 'repair');
  assert.equal(st.agent, 'dwmt-executor-high');
  assert.match(st.output, /repair-2\.md$/);
  writeFileSync(join(d, 'b.txt'), 'ok\n');
  put(d, run, 'repair-2.md', { schema: 'dwmt/result@1', status: 'DONE' });
  st = cli(d, 'state', run).json;
  assert.equal(st.next, 'verify');
  assert.equal(st.closing, true);
  const v4 = cli(d, 'verify', run).json;
  assert.equal(v4.ok, true, JSON.stringify(v4));
  const h4 = hdr(runFile(d, run, 'tests.md'));
  assert.equal(h4.closing, true);
  assert.equal(h4.whole, true);
  assert.equal(cli(d, 'state', run).json.next, 'commit');
  assert.equal(cli(d, 'commit', run).json.ok, true);
});

test('closing verify: an unchanged tree after a PASS goes straight to commit', () => {
  const { d, run } = withConfig({}, 'single', 'cl2');
  cli(d, 'state', run);
  writeFileSync(join(d, 'b.txt'), 'b\n');
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'DONE' });
  assert.equal(cli(d, 'verify', run).json.ok, true);
  cli(d, 'review-input', run);
  put(d, run, 'review-1.md', pass(1));
  const st = cli(d, 'state', run).json;
  assert.equal(st.next, 'commit');
  assert.equal(st.closing, undefined);
  const t = RUN(d).tasks[0];
  assert.equal(t.whole.tree, snapshotTree(d));
  assert.equal(t.whole.ok, true);
  assert.equal(t.lastVerify.whole, true);
  assert.equal(cli(d, 'commit', run).json.ok, true);
});

test('closing verify: still red after the round\'s repair stops at ask-rounds; commit --accept commits', () => {
  const { d, run } = withConfig({}, 'single', 'cl3');
  const marker = join(d, '..', `${basename(d)}-red`);
  setVerify(d, run, [RED(d), CMD_B]);
  writeFileSync(marker, '1');
  cli(d, 'state', run);
  writeFileSync(join(d, 'b.txt'), 'ok\n');
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'DONE' });
  assert.equal(cli(d, 'verify', run).json.repair, true);
  put(d, run, 'repair-1.md', { schema: 'dwmt/result@1', status: 'DONE' });
  const v2 = cli(d, 'verify', run).json;
  assert.equal(v2.ok, false);
  assert.equal(v2.carried, 1, 'the green command is carried, the red one reruns');
  cli(d, 'review-input', run);
  put(d, run, 'review-1.md', pass(1, 'FIX'), '### F-1 [major] x\n');
  put(d, run, 'result-2.md', { schema: 'dwmt/result@1', status: 'DONE', fixed: ['F-1'] });
  assert.equal(cli(d, 'verify', run).json.repair, true, 'round 2 uses its repair');
  // the repair makes the red command green but breaks the carried one
  rmSync(marker);
  writeFileSync(join(d, 'b.txt'), 'broken\n');
  put(d, run, 'repair-2.md', { schema: 'dwmt/result@1', status: 'DONE' });
  assert.equal(cli(d, 'verify', run).json.ok, true);
  cli(d, 'review-input', run);
  put(d, run, 'review-2.md', pass(2));
  assert.equal(cli(d, 'state', run).json.closing, true);
  const v = cli(d, 'verify', run).json;
  assert.equal(v.ok, false);
  assert.equal(v.repair, undefined);
  const st = cli(d, 'state', run).json;
  assert.equal(st.next, 'ask-rounds');
  assert.equal(st.closingRed, true);
  assert.equal(st.round, 2);
  const c = cli(d, 'commit', run, '--accept').json;
  assert.equal(c.ok, true, JSON.stringify(c));
});

// Batch F-1: inline rounds up to a red closing verify (round 2 carries `cmds` while b.txt is broken, review 2 PASS).
function inlineClosingRed(slug, cmds) {
  const { d, run } = withConfig({}, 'inline', slug);
  setVerify(d, run, cmds);
  assert.equal(cli(d, 'state', run).json.next, 'implement');
  writeFileSync(join(d, 'b.txt'), 'ok\n');
  assert.equal(cli(d, 'verify', run).json.ok, true);
  cli(d, 'review-input', run);
  put(d, run, 'review-1.md', pass(1, 'FIX'), '### F-1 [major] x\n');
  assert.equal(cli(d, 'state', run).json.next, 'fix');
  writeFileSync(join(d, 'b.txt'), 'broken\n');
  assert.equal(cli(d, 'verify', run).json.carried, cmds.length);
  cli(d, 'review-input', run);
  put(d, run, 'review-2.md', pass(2));
  assert.equal(cli(d, 'state', run).json.closing, true);
  const v = cli(d, 'verify', run).json;
  assert.deepEqual([v.ok, v.closing, v.repair], [false, true, true]);
  const st = cli(d, 'state', run).json;
  assert.deepEqual([st.next, st.agent], ['repair', null]);
  return { d, run };
}

// The orchestrator's repair changes nothing: the verify after it is closing and whole, then ask-rounds.
// One command: before the fix that verify ran whole but not closing, so `state` gave `commit` (a red no review saw).
// Two commands: before the fix the green one was carried, so `state` gave `repair` after every verify (a loop).
for (const [slug, cmds] of [['cli1', [CMD_B]], ['cli2', [CMD_A, CMD_B]]]) {
  test(`closing verify: inline, a repair that changes nothing reruns the whole list and stops at ask-rounds (${cmds.length} command${cmds.length > 1 ? 's' : ''})`, () => {
    const { d, run } = inlineClosingRed(slug, cmds);
    const v = cli(d, 'verify', run).json;
    assert.deepEqual([v.ok, v.closing, v.repair, v.carried], [false, true, undefined, undefined], JSON.stringify(v));
    const h = hdr(runFile(d, run, 'tests.md'));
    assert.deepEqual([h.whole, h.closing], [true, true]);
    const st = cli(d, 'state', run).json;
    assert.deepEqual([st.next, st.closingRed, st.round], ['ask-rounds', true, 2], 'no commit of a red the review never saw, no loop back to repair');
    assert.equal(cli(d, 'state', run).json.next, 'ask-rounds');
  });
}

// Batch F-2: after `commit --accept` at the round limit the closing verify belongs to the accepted round.
test('closing verify: commit --accept at the round limit books the closing verify under the last round, without a repair', () => {
  const { d, run } = withConfig({}, 'single', 'cl4');
  setVerify(d, run, [CMD_A, CMD_B]);
  cli(d, 'state', run);
  writeFileSync(join(d, 'b.txt'), 'ok\n');
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'DONE' });
  assert.equal(cli(d, 'verify', run).json.ok, true);
  cli(d, 'review-input', run);
  put(d, run, 'review-1.md', pass(1, 'FIX'), '### F-1 [major] x\n');
  writeFileSync(join(d, 'b.txt'), 'broken\n');
  put(d, run, 'result-2.md', { schema: 'dwmt/result@1', status: 'DONE', fixed: ['F-1'] });
  assert.equal(cli(d, 'verify', run).json.carried, 2);
  cli(d, 'review-input', run);
  put(d, run, 'review-2.md', pass(2, 'FIX'), '### F-1 [major] x\n');
  assert.deepEqual(['next', 'round'].map((k) => cli(d, 'state', run).json[k]), ['ask-rounds', 2]);
  const a = cli(d, 'commit', run, '--accept').json;
  assert.deepEqual([a.ok, a.next, a.closing], [false, 'verify', true], JSON.stringify(a));
  const st = cli(d, 'state', run).json;
  assert.deepEqual([st.next, st.closing, st.round], ['verify', true, 2]);
  const v = cli(d, 'verify', run).json;
  assert.deepEqual([v.ok, v.closing, v.round, v.repair], [false, true, 2, undefined], JSON.stringify(v));
  assert.equal(hdr(runFile(d, run, 'tests.md')).round, 2);
  const t = RUN(d).tasks[0];
  assert.deepEqual(Object.keys(t.repairs ?? {}), [], 'no repair booked for a round that never runs');
  assert.equal(t.closingRuns['2'], 1);
  assert.equal(cli(d, 'state', run).json.next, 'commit');
  assert.equal(cli(d, 'commit', run, '--accept').json.ok, true);
});

test('verify selection: after a repair only the red file reruns and green commands are carried', () => {
  const { d, run } = withConfig({ verify: { full: [], testFiles: 't/*.test.mjs', failedFileRegex: 'not ok \\d+ - (\\S+\\.test\\.mjs)' } }, 'single', 'sel');
  mkdirSync(join(d, 't'), { recursive: true });
  writeFileSync(join(d, 't', 'two.mjs'), [
    "import fs from 'node:fs'; import path from 'node:path';",
    "const red = fs.existsSync(path.join('..', path.basename(process.cwd()) + '-sel'));",
    'let bad = 0;',
    "process.argv.slice(2).forEach((f, i) => { const no = red && f === 't/b.test.mjs'; if (no) bad++; console.log(`${no ? 'not ok' : 'ok'} ${i + 1} - ${f}`); });",
    'process.exit(bad ? 1 : 0);', '',
  ].join('\n'));
  const TWO = 'node t/two.mjs t/a.test.mjs t/b.test.mjs';
  setVerify(d, run, [TWO, 'node -e 0']);
  const marker = join(d, '..', `${basename(d)}-sel`);
  writeFileSync(marker, '1');
  cli(d, 'state', run);
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'DONE' });
  const v1 = cli(d, 'verify', run).json;
  assert.equal(v1.repair, true, JSON.stringify(v1));
  assert.deepEqual(RUN(d).tasks[0].lastVerify.commands[0].red, ['t/b.test.mjs']);
  assert.deepEqual(RUN(d).tasks[0].lastVerify.commands[1], { cmd: 'node -e 0', exit: 0, red: [] });
  rmSync(marker);
  put(d, run, 'repair-1.md', { schema: 'dwmt/result@1', status: 'DONE' });
  const v2 = cli(d, 'verify', run).json;
  assert.equal(v2.ok, true, JSON.stringify(v2));
  assert.equal(v2.narrowed, 1);
  assert.equal(v2.carried, 1);
  const h = hdr(runFile(d, run, 'tests.md'));
  assert.equal(h.commands[0].cmd, TWO);
  assert.equal(h.commands[0].ran, 'node t/two.mjs t/b.test.mjs');
  assert.deepEqual(h.commands[0].narrowed, ['t/b.test.mjs']);
  assert.equal(h.commands[0].exit, 0);
  assert.deepEqual([h.commands[1].exit, h.commands[1].ms, h.commands[1].carried], [0, 0, true], 'R-12: a carried entry counts as green');
  assert.equal(h.whole, false);
});

test('flaky: czerwona raz, zielona w powtórce; nie odsyła wykonawcy, nie blokuje finish, raport ją wymienia', () => {
  const once = (m) => `node -e "const f='.dwmt/${m}';const fs=require('fs');if(fs.existsSync(f))process.exit(0);fs.writeFileSync(f,'');process.exit(2)"`;
  const { d, run } = withConfig({}, 'single', 'fl');
  writeFileSync(join(d, '.claude', 'dwmt.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(d, '.claude', 'dwmt.json'), 'utf8')), verify: { targeted: once('t'), full: [once('f')] } }));
  cli(d, 'state', run);
  writeFileSync(join(d, 'b.txt'), 'b\n');
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'DONE' });
  const v = cli(d, 'verify', run).json;
  assert.equal(v.result, 'pass');
  assert.equal(v.repair, undefined);
  assert.ok(v.commands.some((c) => c.startsWith('0 ') && c.endsWith(' (flaky)')), v.commands.join('\n'));
  const tests = readFileSync(runFile(d, run, 'tests.md'), 'utf8');
  assert.match(tests, /\(flaky: exit 2, then 0 on rerun\)/);
  assert.deepEqual(hdr(runFile(d, run, 'tests.md')).flaky, [once('t')]);
  cli(d, 'review-input', run);
  assert.match(readFileSync(runFile(d, run, 'review-input.md'), 'utf8'), /marks 1 command\(s\) flaky[\s\S]*likely race/);
  put(d, run, 'review-1.md', { schema: 'dwmt/review@1', round: 1, passes: [], verdict: 'PASS', fix: [], acceptance: ['AC-1 met'] });
  assert.equal(cli(d, 'commit', run).json.ok, true);
  const fin = cli(d, 'finish', run).json;
  assert.equal(fin.status, 'squashed', JSON.stringify(fin));
  assert.deepEqual(hdr(runFile(d, run, 'final-report.md')).tests.flaky, [once('t'), once('f')]);

  const cwd = mkdtempSync(join(tmpdir(), 'dwmt-fl-'));
  mkdirSync(join(cwd, '.dwmt'));
  assert.equal(verifyCommands([once('x')], cwd, { verify: { rerunRed: false } }).result, 'fail', 'rerunRed: false wyłącza powtórkę');
});

test('komendy verify poprawione po planie: sekcja w wejściu recenzji i verifyChanged w raporcie', () => {
  const { d, run } = withConfig({}, 'single', 'vc');
  assert.equal(cli(d, 'state', run).json.next, 'implement');
  assert.deepEqual(RUN(d).tasks[0].verifyPlanned, ['node -e 0']);
  const bf = runFile(d, run, 'brief.md');
  writeFileSync(bf, readFileSync(bf, 'utf8').replace('verify: ["node -e 0"]', 'verify: ["node -e \\"0\\""]'));
  writeFileSync(join(d, 'b.txt'), 'b\n');
  put(d, run, 'result-1.md', { schema: 'dwmt/result@1', status: 'DONE' });
  assert.equal(cli(d, 'verify', run).json.ok, true);
  cli(d, 'review-input', run);
  const input = readFileSync(runFile(d, run, 'review-input.md'), 'utf8');
  assert.match(input, /## Verify commands changed after planning\n\n- planned: `node -e 0`\n- now: `node -e "0"`/);
  assert.match(input, /never what it runs/);
  put(d, run, 'review-1.md', { schema: 'dwmt/review@1', round: 1, passes: [], verdict: 'PASS', fix: [], acceptance: ['AC-1 met'] });
  cli(d, 'commit', run);
  assert.equal(cli(d, 'finish', run).json.status, 'squashed');
  assert.deepEqual(hdr(runFile(d, run, 'final-report.md')).verifyChanged, ['- node -e 0', '+ node -e "0"']);
});

test('mergeReviews z base: uwagi poprzedniej rundy zachowują numery, nowe numerowane dalej bez kolizji', () => {
  const a = `${header({ schema: 'dwmt/review@1', round: 2, passes: ['recheck'], verdict: 'FIX', fix: ['F-3', 'F-26'], counts: { major: 1 } })}- F-3 open\n### F-26 [major] nowa w kodzie\n`;
  const b = `${header({ schema: 'dwmt/review@1', round: 2, passes: ['visual'], verdict: 'FIX', fix: ['F-26'], counts: { major: 1 } })}- F-7 resolved\n### F-26 [major] nowa na ekranie\n`;
  const text = mergeReviews([{ name: 'recheck', text: a }, { name: 'ui', text: b }], 25);
  const h = parseYaml(splitHeader(text).yaml);
  assert.deepEqual(h.fix, ['F-3', 'F-26', 'F-27']);
  assert.match(text, /- F-7 resolved/);
  assert.match(text, /### F-27 \[major\] nowa na ekranie/);
  assert.equal(maxFinding(text), 27);
  assert.deepEqual(unitFindings(text), { recheck: ['F-26'], ui: ['F-27'] });
});

test('mergeReviews: wynik weryfikatora UI z `proven` zastępuje „ui unit” recenzenta kodu (PM-3 cz. 2)', () => {
  const a = `${header({ schema: 'dwmt/review@1', round: 1, passes: ['risks'], verdict: 'PASS', fix: [], risks: ['R-1 proven', 'R-10 ui unit (shot written)', 'R-11 ui unit (shot written)'] })}ok\n`;
  const b = `${header({ schema: 'dwmt/review@1', round: 1, passes: ['visual'], verdict: 'PASS', fix: [], risks: ['R-10 Okno zgodne z makietą', 'R-11 Kalendarz'], proven: ['R-10 proven', 'R-11 unproven: popover po złej stronie'] })}ok\n`;
  const h = parseYaml(splitHeader(mergeReviews([{ name: 'all', text: a }, { name: 'ui', text: b }])).yaml);
  assert.deepEqual(h.risks, ['R-1 proven', 'R-10 proven', 'R-11 unproven: popover po złej stronie']);
});
