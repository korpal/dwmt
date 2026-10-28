import './tmp-root.mjs';
// Z10: budżety promptów. Liczymy linie treści (bez frontmattera, bez pustych linii na brzegach).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitHeader, parseYaml } from '../scripts/dwmt.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const body = (f) => {
  const text = readFileSync(f, 'utf8');
  const h = splitHeader(text);
  return (h ? h.body : text).trim().split(/\r?\n/).length;
};

test('Z10: agenci ≤ 30 (eksplorator i kontrola celu ≤ 20), perspektywy ≤ 12, skille ≤ 150 linii', () => {
  const dir = (...p) => join(ROOT, ...p);
  for (const f of readdirSync(dir('templates', 'agents'))) assert.ok(body(dir('templates', 'agents', f)) <= 30, `${f}: ${body(dir('templates', 'agents', f))}`);
  // v2.7 (§4): eksplorator i kontrola celu najwyżej ok. 20 linii.
  for (const f of ['dwmt-explorer.md', 'dwmt-checker.md']) assert.ok(body(dir('templates', 'agents', f)) <= 20, `${f}: ${body(dir('templates', 'agents', f))}`);
  assert.ok(!existsSync(dir('templates', 'agents', 'dwmt-planner.md')), 'v2.7: planista zastąpiony przez architekta');
  for (const f of readdirSync(dir('templates', 'lenses'))) assert.ok(body(dir('templates', 'lenses', f)) <= 12, `${f}: ${body(dir('templates', 'lenses', f))}`);
  for (const s of readdirSync(dir('skills'))) assert.ok(body(dir('skills', s, 'SKILL.md')) <= 150, `${s}: ${body(dir('skills', s, 'SKILL.md'))}`);
});

test('skille: effort run=high, execute=high (architekt xhigh w agencie); execute wywoływalny przez model', () => {
  const fm = (s) => parseYaml(splitHeader(readFileSync(join(ROOT, 'skills', s, 'SKILL.md'), 'utf8')).yaml);
  assert.equal(fm('run').effort, 'high');
  assert.equal(fm('execute').effort, 'high');
  assert.equal(fm('uat').effort, 'high');
  assert.equal(fm('uat')['disable-model-invocation'], true, 'UAT tylko na polecenie użytkownika');
  assert.notEqual(fm('execute')['disable-model-invocation'], true);
});

test('prompt-log istnieje z formatem wpisu', () => {
  const f = join(ROOT, 'docs', 'prompt-log.md');
  assert.ok(existsSync(f));
  assert.match(readFileSync(f, 'utf8'), /data \| rola \| linia \| porażka \(przebieg\) \| efekt/);
});
