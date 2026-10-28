// dwmt: nagłówki YAML artefaktów (podzbiór YAML, walidacja schematów, sekcje).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, fwd, read } from './util.mjs';

const SCHEMAS = JSON.parse(readFileSync(join(ROOT, 'schemas', 'headers.json'), 'utf8'));

// ---------- nagłówki YAML (podzbiór: skalary, flow [] {}, JSON, listy blokowe, komentarze) ----------

export function splitHeader(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return m ? { yaml: m[1], body: text.slice(m[0].length) } : null;
}

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '\\' && q === '"') i++; else if (c === q) q = null; continue; }
    const prev = line.slice(0, i).trimEnd().slice(-1);
    if ((c === '"' || c === "'") && (prev === '' || ':[{,-'.includes(prev))) q = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function scalar(raw) {
  if (raw === '' || raw === '~' || raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

export function parseFlow(s) {
  let i = 0;
  const fail = () => { throw new Error(`nieczytelna wartość YAML: ${s}`); };
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const quoted = () => {
    const q = s[i];
    let j = i + 1;
    while (j < s.length && (s[j] !== q || (q === "'" && s[j + 1] === "'"))) { if ((q === '"' && s[j] === '\\') || (q === "'" && s[j] === "'")) j++; j++; }
    if (j >= s.length) fail();
    const raw = s.slice(i, j + 1);
    i = j + 1;
    if (q !== '"') return raw.slice(1, -1).replace(/''/g, "'");
    // D-8: an escape JSON does not know (a Windows path: `\.`, `\S`) keeps every backslash literal; else JSON semantics.
    const inner = raw.slice(1, -1);
    return /\\(?!["\\/bfnrt]|u[0-9a-fA-F]{4})/.test(inner.replace(/\\\\/g, '')) ? inner : JSON.parse(raw);
  };
  const value = (stop) => {
    ws();
    const c = s[i];
    if (c === '[') {
      i++; const arr = []; ws();
      if (s[i] === ']') { i++; return arr; }
      for (;;) {
        arr.push(value(',]')); ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ']') { i++; return arr; }
        fail();
      }
    }
    if (c === '{') {
      i++; const obj = {}; ws();
      if (s[i] === '}') { i++; return obj; }
      for (;;) {
        ws();
        let k;
        if (s[i] === '"' || s[i] === "'") k = quoted();
        else { const j = s.indexOf(':', i); if (j < 0) fail(); k = s.slice(i, j).trim(); i = j; }
        ws(); if (s[i] !== ':') fail(); i++;
        obj[k] = value(',}'); ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === '}') { i++; return obj; }
        fail();
      }
    }
    if (c === '"' || c === "'") return quoted();
    let j = i;
    while (j < s.length && !stop.includes(s[j])) j++;
    const raw = s.slice(i, j).trim();
    i = j;
    return scalar(raw);
  };
  const v = value('');
  ws();
  if (i < s.length) fail();
  return v;
}

export function parseYaml(src) {
  const out = {};
  let key = null;
  let blockItem = false;
  for (const raw of src.split(/\r?\n/)) {
    const line = stripComment(raw).trimEnd();
    if (!line.trim()) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && key) {
      if (!Array.isArray(out[key])) out[key] = [];
      const pair = /^([A-Za-z_][\w-]*)\s*:\s+(.*)$/.exec(item[1]);
      out[key].push(pair ? { [pair[1]]: parseFlow(pair[2]) } : parseFlow(item[1]));
      blockItem = !!pair;
      continue;
    }
    const nested = /^\s+([A-Za-z_][\w-]*)\s*:\s+(.*)$/.exec(line);
    if (nested && key && blockItem && Array.isArray(out[key])) {
      out[key].at(-1)[nested[1]] = parseFlow(nested[2]);
      continue;
    }
    if (nested && key && (out[key] === null || (typeof out[key] === 'object' && !Array.isArray(out[key])))) {
      out[key] = { ...(out[key] || {}), [nested[1]]: parseFlow(nested[2]) };
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:(?:\s+(.*))?$/.exec(line);
    if (!kv) throw new Error(`nieczytelna linia YAML: ${raw}`);
    key = kv[1];
    blockItem = false;
    out[key] = kv[2] === undefined ? null : parseFlow(kv[2]);
  }
  return out;
}

export const emitYaml = (obj) => Object.entries(obj).map(([k, v]) => `${k}: ${JSON.stringify(v ?? null)}`).join('\n');
export const withHeader = (obj, body) => `---\n${emitYaml(obj)}\n---\n${body}`;

export function readHeader(file) {
  const h = splitHeader(read(file));
  if (!h) throw new Error(`brak nagłówka YAML: ${fwd(file)}`);
  return parseYaml(h.yaml);
}

export function validateHeader(h) {
  const s = SCHEMAS[h?.schema];
  if (!s) return [`nieznany schemat: ${h?.schema}`];
  const errors = [];
  for (const k of s.required) if (h[k] === undefined || h[k] === null) errors.push(`brak pola ${k}`);
  for (const [k, vals] of Object.entries(s.enums)) if (h[k] != null && !vals.includes(h[k])) errors.push(`${k}=${h[k]}, dozwolone: ${vals.join('|')}`);
  for (const k of s.arrays) if (h[k] != null && !Array.isArray(h[k])) errors.push(`${k} musi być listą`);
  return errors;
}

// Pole listowe zapisane przez agenta jako mapa (`risks: {R-1: proven}`) to lista „R-1 proven” (X7, sandbox).
export function normalizeLists(h) {
  for (const k of SCHEMAS[h?.schema]?.arrays || []) {
    const v = h[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) h[k] = Object.entries(v).map(([id, s]) => `${id} ${typeof s === 'string' ? s : JSON.stringify(s)}`);
  }
  return h;
}

export function tryHeader(file) {
  if (!existsSync(file)) return null;
  try { const h = normalizeLists(readHeader(file)); const errors = validateHeader(h); return errors.length ? { ...h, errors } : h; }
  catch (e) { return { errors: [e.message] }; }
}

export function section(text, id) {
  const lines = text.split(/\r?\n/);
  const re = new RegExp(`^(#{1,6})\\s.*\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  const at = lines.findIndex((l) => re.test(l));
  if (at < 0) return null;
  const level = re.exec(lines[at])[1].length;
  let end = lines.length;
  let fence = false;
  for (let i = at + 1; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    else if (!fence && /^(#{1,6})\s/.test(lines[i]) && /^(#+)/.exec(lines[i])[1].length <= level) { end = i; break; }
  }
  return lines.slice(at, end).join('\n').trimEnd();
}
