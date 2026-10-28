import './tmp-root.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cli, repo } from './helpers.mjs';
import { splitHeader, parseYaml, parseFlow, emitYaml, withHeader, validateHeader, section, globToRegExp, pickLenses, trimOutput, slugify, stripJsonComments } from '../scripts/dwmt.mjs';

test('nagłówek: frontmatter LF i CRLF', () => {
  for (const eol of ['\n', '\r\n']) {
    const h = splitHeader(['---', 'schema: dwmt/result@1', 'status: DONE', '---', '# treść'].join(eol));
    assert.deepEqual(parseYaml(h.yaml), { schema: 'dwmt/result@1', status: 'DONE' });
    assert.equal(h.body, '# treść');
  }
  assert.equal(splitHeader('# bez nagłówka'), null);
});

test('YAML: flow, JSON, komentarze, listy blokowe, zagnieżdżona mapa', () => {
  const y = parseYaml([
    'goal: "Pochodzenie: API # nie komentarz"   # komentarz',
    "note: 'it''s'",
    'acceptance: ["AC-1 GET /x zwraca 200", AC-2 edytor]',
    'testsRun: [{cmd: "npm test", result: passed}, {"cmd": "x", "result": "failed"}]',
    'planIssue: null',
    'round: 2',
    'risk:',
    '  - data',
    '  - ui',
    'counts:',
    '  blocker: 1',
    '  major: 0',
  ].join('\n'));
  assert.equal(y.goal, 'Pochodzenie: API # nie komentarz');
  assert.equal(y.note, "it's");
  assert.deepEqual(y.acceptance, ['AC-1 GET /x zwraca 200', 'AC-2 edytor']);
  assert.deepEqual(y.testsRun, [{ cmd: 'npm test', result: 'passed' }, { cmd: 'x', result: 'failed' }]);
  assert.equal(y.planIssue, null);
  assert.equal(y.round, 2);
  assert.deepEqual(y.risk, ['data', 'ui']);
  assert.deepEqual(y.counts, { blocker: 1, major: 0 });
  assert.throws(() => parseFlow('[a, b'), /nieczytelna/);
});

test('YAML: Windows paths in double quotes keep backslashes, JSON escapes keep meaning (D-8, AC-4, AC-10, R-2)', () => {
  const q = (inner) => parseFlow(`"${inner}"`);
  assert.equal(q('proj\\.venv\\Scripts\\python -m pytest'), 'proj\\.venv\\Scripts\\python -m pytest');
  assert.equal(q('C:\\Users\\x\\.venv'), 'C:\\Users\\x\\.venv');
  assert.equal(q('a \\"b\\" c'), 'a "b" c');
  assert.equal(q('C:\\\\Users\\\\x'), 'C:\\Users\\x');
  assert.equal(q('line\\nnext'), 'line\nnext');
  assert.equal(q('\\u00e9'), 'é');
  assert.equal(q('mix \\\\ and \\.'), 'mix \\\\ and \\.');
  assert.equal(q('tab\\there \\/ ok'), 'tab\there / ok');
  assert.equal(q('bad \\u00zz'), 'bad \\u00zz');
  assert.throws(() => parseFlow('"open \\.'), /nieczytelna/);
  const y = parseYaml(['schema: dwmt/result@1', 'status: DONE', 'testsRun: [{cmd: "proj\\.venv\\Scripts\\python -m pytest", result: passed}]'].join('\n'));
  assert.deepEqual(y.testsRun, [{ cmd: 'proj\\.venv\\Scripts\\python -m pytest', result: 'passed' }]);
});

test('YAML: dwmt header prints a result whose testsRun cmd is a Windows path (AC-4)', () => {
  const d = repo();
  const f = join(d, 'result-1.md');
  writeFileSync(f, ['---', 'schema: dwmt/result@1', 'status: DONE', 'testsRun: [{cmd: "proj\\.venv\\Scripts\\python -m pytest", result: passed}]', '---', '## Reasons', ''].join('\n'));
  const r = cli(d, 'header', f);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.json.testsRun[0].cmd, 'proj\\.venv\\Scripts\\python -m pytest');
});

test('emisja: backslash, cudzysłów i nowa linia wracają bez zmian (round-trip, AC-10, R-2)', () => {
  const obj = { schema: 'dwmt/result@1', cmd: 'C:\\Users\\x\\.venv\\python "a b"', multi: 'line1\nline2\t\\n', list: [{ cmd: 'echo \\"x\\" \\\\ y', note: 'é \u0001' }], path: 'C:\\\\double' };
  assert.deepEqual(parseYaml(splitHeader(withHeader(obj, 'x')).yaml), obj);
});

test('YAML: blokowa lista map (zwykły styl wykonawcy)', () => {
  const y = parseYaml(['testsRun:', '  - cmd: npm test', '    result: passed', '  - cmd: "node --test"', 'fixed:', '  - id: F-1', '    redTest: "t: czerwony"', 'status: DONE'].join('\n'));
  assert.deepEqual(y.testsRun, [{ cmd: 'npm test', result: 'passed' }, { cmd: 'node --test' }]);
  assert.deepEqual(y.fixed, [{ id: 'F-1', redTest: 't: czerwony' }]);
  assert.equal(y.status, 'DONE');
});

test('emisja jest czytelna dla parsera (round-trip)', () => {
  const obj = { schema: 'dwmt/tests@1', run: 'r', kind: 'full', result: 'fail', commands: [{ cmd: 'mvn -q "a b"', exit: 1, ms: 5 }], note: 'ą: #x' };
  assert.deepEqual(parseYaml(splitHeader(withHeader(obj, 'x')).yaml), obj);
  assert.match(emitYaml({ a: null }), /^a: null$/);
});

test('walidacja: pola wymagane, enumy, listy', () => {
  assert.deepEqual(validateHeader({ schema: 'dwmt/result@1', status: 'DONE' }), []);
  assert.deepEqual(validateHeader({ schema: 'dwmt/result@1', status: 'OK' }), ['status=OK, dozwolone: DONE|PARTIAL|BLOCKED']);
  assert.deepEqual(validateHeader({ schema: 'dwmt/brief@1', run: 'r', goal: 'g', mode: 'single', acceptance: [], scope: [], verify: [] }), [], 'flagi risk są opcjonalne (D1)');
  assert.ok(validateHeader({ schema: 'dwmt/brief@1', run: 'r', goal: 'g', mode: 'single', acceptance: 'x', scope: [] }).some((e) => /verify/.test(e)));
  assert.match(validateHeader({ schema: 'x' })[0], /nieznany schemat/);
});

test('section: po identyfikatorze, do nagłówka tego samego poziomu', () => {
  const md = '## correctness\n### F-1 [major] a\ndowód\n### F-10 [minor] b\nx\n## pragmatism\n- F-1: fix';
  assert.equal(section(md, 'F-1'), '### F-1 [major] a\ndowód');
  assert.equal(section(md, 'F-10'), '### F-10 [minor] b\nx');
  assert.equal(section(md, 'F-2'), null);
  const fenced = '### F-1 a\n```bash\n# komentarz w kodzie\nnpm test\n```\ndalej\n### F-2 b';
  assert.equal(section(fenced, 'F-1'), '### F-1 a\n```bash\n# komentarz w kodzie\nnpm test\n```\ndalej');
});

test('globy', () => {
  assert.ok(globToRegExp('**/auth/**').test('src/auth/x.js'));
  assert.ok(globToRegExp('**/auth/**').test('auth/x.js'));
  assert.ok(!globToRegExp('**/auth/**').test('src/author/x.js'));
  assert.ok(globToRegExp('frontend/**').test('frontend/src/a/b.tsx'));
  assert.ok(globToRegExp('src/*.{js,mjs}').test('src/a.mjs'));
  assert.ok(!globToRegExp('src/*.js').test('src/a/b.js'));
  assert.ok(globToRegExp('{src/**,lib/**}').test('lib/x/y.js'));
  assert.ok(globToRegExp('src/{*.ts,*.js}').test('src/a.ts'));
  assert.ok(!globToRegExp('src/{*.ts,*.js}').test('src/a.css'));
});

test('perspektywy: correctness pierwsza, pragmatism ostatnia, najwyżej 2 ryzyka, flagi przed globami', () => {
  const available = ['correctness', 'security', 'data', 'api-contract', 'ui', 'pragmatism'];
  const lensGlobs = { security: ['**/auth/**'], ui: ['frontend/**'], data: ['**/db/migration/**'] };
  const changed = ['src/auth/a.js', 'frontend/a.tsx', 'frontend/b.tsx'];
  assert.deepEqual(pickLenses({ risk: [], changed, lensGlobs, available }), ['correctness', 'ui', 'security', 'pragmatism']);
  assert.deepEqual(pickLenses({ risk: ['data'], changed, lensGlobs, available }), ['correctness', 'data', 'ui', 'pragmatism']);
  assert.deepEqual(pickLenses({ risk: ['nieznana', 'pragmatism'], changed: [], lensGlobs, available }), ['correctness', 'pragmatism']);
  assert.deepEqual(pickLenses({ risk: ['data', 'ui', 'security'], changed: [], lensGlobs, max: 2, available }), ['correctness', 'data', 'ui', 'pragmatism']);
});

test('przycinanie outputu: ANSI, szum, ogon 40, długie linie', () => {
  const lines = ['\x1b[31mFAIL\x1b[0m a', 'warning: in the working copy of \'x\', LF will be replaced by CRLF', 'Picked up JAVA_TOOL_OPTIONS: -D', '', ...Array.from({ length: 50 }, (_, i) => `l${i}`), 'x'.repeat(400)];
  const t = trimOutput(lines.join('\r\n'));
  assert.equal(t.lines.length, 40);
  assert.equal(t.dropped, 12);
  assert.equal(t.lines.at(-1).length, 301);
  assert.ok(!t.lines.some((l) => /Picked up|LF will be/.test(l)));
  assert.deepEqual(trimOutput('\x1b[31mFAIL\x1b[0m a').lines, ['FAIL a']);
});

test('config jsonc: komentarze poza stringami', () => {
  const t = '{\n  // całą linią\n  "a": "http://x", // na końcu\n  "b": "\\"//\\""\n}';
  assert.deepEqual(JSON.parse(stripJsonComments(t)), { a: 'http://x', b: '"//"' });
});

test('slug', () => {
  assert.equal(slugify('Koszt dostawy: złoty środek!'), 'koszt-dostawy-zloty-srodek');
  assert.equal(slugify('???'), 'run');
});
