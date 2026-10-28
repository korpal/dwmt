// dwmt D4: cena bez modelu (spec warstwy produktowej §4.11 pkt 4, §4.12, §5.1, §5.3, §6.4; 0 tokenów).
// Zakończony przebieg = kopia przebiegu w głównym drzewie z `finish.status: squashed` i commitem squasha: zmienione pliki
// kodu z `git diff --numstat <squash>^1 <squash>` (bez binarnych), koszt z `finish.cost` albo nagłówka raportu, tryb
// `modeLabel ?? mode` (nagłówek raportu podaje tryb faktyczny, gdy run.json ma `auto`). Listy plików w pamięci podręcznej
// `.dwmt/price-cache.json` (commit się nie zmienia).
import { existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fwd, read, asList } from './util.mjs';
import { splitHeader, parseYaml } from './headers.mjs';
import { gitRaw, git } from './git.mjs';
import { globToRegExp } from './text.mjs';
import { loadConfig } from './config.mjs';
import { contextHome } from './run.mjs';
import { agentCosts } from './sessions.mjs';
import { productConfig, codeMatcher, NO_PRODUCT_M_PER_FILE } from './product-config.mjs';

export const MODES = ['direct', 'inline', 'intermediate', 'single'];
export const r1 = (x) => Math.round(x * 10) / 10;
export const r2 = (x) => Math.round(x * 100) / 100;

// Percentyl z interpolacją liniową (p25, p50, p75).
export function pct(values, p) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = (v.length - 1) * p;
  const lo = Math.floor(i);
  return v[lo] + (v[Math.min(lo + 1, v.length - 1)] - v[lo]) * (i - lo);
}
export const median = (v) => pct(v, 0.5);

const headerOf = (file) => { try { const s = splitHeader(read(file)); return s ? parseYaml(s.yaml) : null; } catch { return null; } };

// Changed code files of a squash commit and their changed lines (added + deleted) from one numstat; binary files
// (`-`) are skipped. Null when the commit is not in the repo.
export function changedCode(cwd, commit, isCode) {
  const r = gitRaw(['diff', '--numstat', '--no-renames', `${commit}^1`, commit], { cwd });
  if (r.status !== 0) return null;
  const rows = r.stdout.split(/\r?\n/).filter(Boolean).map((l) => l.split('\t')).filter(([a, , p]) => a !== '-' && p && isCode(p));
  return { files: rows.map(([, , p]) => p), lines: rows.reduce((n, [a, del]) => n + (Number(a) || 0) + (Number(del) || 0), 0) };
}
// Zmienione pliki kodu commita squasha (null, gdy commitu nie ma w repo).
export const changedCodeFiles = (cwd, commit, isCode) => changedCode(cwd, commit, isCode)?.files ?? null;

// Zakończone przebiegi projektu: [{run, spec, sprint, goal, mode, costM, files, changed, lines, mPerFile, mPerLine, at, sessions}].
export function completedRuns(top, cfg = loadConfig(top), pc = productConfig(top, cfg)) {
  const main = contextHome(top);
  const base = join(main, '.dwmt', 'runs');
  if (!existsSync(base)) return [];
  const isCode = codeMatcher(cfg, pc);
  const cacheFile = join(main, '.dwmt', 'price-cache.json');
  let cache = {};
  try { cache = JSON.parse(read(cacheFile)); } catch { /* pierwszy odczyt */ }
  const globsKey = JSON.stringify([pc.codeGlobs, cfg.review?.ignoreGlobs ?? []]);
  let dirty = false;
  const out = [];
  for (const id of readdirSync(base)) {
    let run;
    try { run = JSON.parse(read(join(base, id, 'run.json'))); } catch { continue; }
    const commit = run.finish?.status === 'squashed' ? run.finish.commit : null;
    if (!commit) continue;
    const rep = headerOf(join(base, id, 'final-report.md')) ?? {};
    const costM = Number(run.finish.cost ?? rep.cost?.total);
    const hit = cache[id];
    let changed = hit?.commit === commit && hit?.globs === globsKey && Number.isInteger(hit?.lines) ? hit.files : null;
    let lines = changed ? hit.lines : null;
    if (!changed) {
      const cc = changedCode(main, commit, isCode);
      if (!cc) continue;
      ({ files: changed, lines } = cc);
      cache[id] = { commit, globs: globsKey, files: changed, lines };
      dirty = true;
    }
    const files = changed.length;
    const mode = run.modeLabel ?? (MODES.includes(rep.mode) ? rep.mode : run.mode);
    // W-4: koszt rundy zbiorczej z nagłówka raportu (`batch.cost`); bez niego (przebieg bez partii albo sprzed v2.8) null.
    const batchM = Number.isFinite(Number(rep.batch?.cost)) && rep.batch?.cost !== null ? Number(rep.batch.cost) : null;
    const ok = Number.isFinite(costM) && costM > 0;
    out.push({
      run: id, spec: run.spec ?? null, sprint: run.sprint ?? null, goal: rep.goal ?? null, mode, costM: ok ? costM : null,
      files, changed, lines, mPerFile: files && ok ? costM / files : null, mPerLine: lines && ok ? costM / lines : null, batchM,
      mPerFileTasks: files && ok ? (costM - Math.min(batchM ?? 0, costM)) / files : null, at: run.finish.at ?? run.created ?? null, sessions: asList(run.session_ids),
    });
  }
  if (dirty) { try { mkdirSync(join(main, '.dwmt'), { recursive: true }); writeFileSync(cacheFile, `${JSON.stringify(cache)}\n`); } catch { /* tylko pamięć podręczna */ } }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

// Przegląd 2026-10-09 (W-4): udział rundy zbiorczej w koszcie (sprint V: 13,2 z 55,7 mln = 24%) jawnie w cenie: mediana
// batch / koszt zakończonych przebiegów z kosztem partii w raporcie (≥ 3), inaczej 0,15.
export const BATCH_SHARE_DEFAULT = 0.15;
export function batchShare(runs) {
  const v = runs.filter((r) => r.batchM != null && r.costM > 0).map((r) => Math.min(r.batchM, r.costM) / r.costM);
  return v.length >= 3 ? { share: r2(median(v)), basis: `batch +${Math.round(median(v) * 100)}% n=${v.length}` } : { share: BATCH_SHARE_DEFAULT, basis: `batch +${BATCH_SHARE_DEFAULT * 100}% default` };
}

// mln na zmieniony plik kodu (§6.4 pkt 3): mediana przebiegów w trybie (≥ 3), inaczej wszystkich (≥ 3), inaczej domyślna.
// Przegląd 2026-10-04 (dwa sprinty 1,3× i 2,8× ponad górną granicę): przedział ceny brał tylko niepewność liczby plików,
// a koszt na plik w projekcie testowym to 0,09–0,45. `lo`/`hi` = p25/p75 kosztu na plik (test wsteczny: model stała + plik nie był lepszy).
// W-4: koszt na plik z historii bez rundy zbiorczej (`mPerFileTasks`; koszt przebiegu w raporcie ją zawiera), a partia
// wraca w cenie jako `share` (priceRange: × (1 + share)), więc nie liczy się dwa razy i jest widoczna w podstawie.
export function mPerFile(runs, mode, pc) {
  const ok = runs.filter((r) => r.mPerFile != null);
  const inMode = ok.filter((r) => r.mode === mode);
  const b = batchShare(runs);
  const of = (list, basis) => { const v = list.map((r) => r.mPerFileTasks ?? r.mPerFile); return { m: r2(median(v)), lo: r2(pct(v, 0.25)), hi: r2(pct(v, 0.75)), share: b.share, basis: `${basis}; ${b.basis}` }; };
  if (inMode.length >= 3) return of(inMode, `${mode} n=${inMode.length}`);
  if (ok.length >= 3) return of(ok, `all n=${ok.length}`);
  const m = pc?.present ? Number(pc.price?.defaultMPerFile?.[mode] ?? NO_PRODUCT_M_PER_FILE) : NO_PRODUCT_M_PER_FILE;
  return { m, lo: m, hi: m, share: b.share, basis: `${pc?.present ? `default ${mode}` : 'default (no product layer)'}; ${b.basis}` };
}

export function parseRange(s, what = 'zakres') {
  const v = Array.isArray(s) ? s.map(Number) : String(s ?? '').split(/[,\s]+/).filter(Boolean).map(Number);
  if (v.length === 1) v.push(v[0]);
  if (v.length !== 2 || v.some((x) => !Number.isFinite(x) || x < 0) || v[0] > v[1]) throw new Error(`${what}: oczekiwano <min,max>, jest ${s}`);
  return v;
}

// Cena projektu (§6.4 pkt 3): designM = [files.min × p25, files.max × p75] kosztu na plik (`m` = mediana do opisu)
// × (1 + udział rundy zbiorczej, W-4).
export const priceRange = (files, k) => { const f = 1 + (k.share ?? 0); return [r1(files[0] * (k.lo ?? k.m) * f), r1(files[1] * (k.hi ?? k.m) * f)]; };
export function designPrice(top, files, mode = 'single', { cfg = loadConfig(top), runs = null } = {}) {
  const pc = productConfig(top, cfg);
  const md = MODES.includes(mode) ? mode : 'single';
  const k = mPerFile(runs ?? completedRuns(top, cfg, pc), md, pc);
  return { files, mode: md, m: k.m, mRange: [k.lo, k.hi], batchShare: k.share, basis: k.basis, designM: priceRange(files, k) };
}

// `dwmt.mjs price --files <min,max> [--mode <tryb>]`: część dwmt (bramka w `run` działa bez warstwy produktowej).
export function cmdPrice(top, opts) {
  const files = parseRange(opts.files, '--files');
  return { ok: true, ...designPrice(top, files, opts.mode || 'single') };
}

// Cena eksploratorów (§4.11 pkt 4): n × explorerM, a przy ≥ 6 eksploratorach w przebiegach projektu ich p25–p75.
export function explorerPrice(top, n, { cfg = loadConfig(top), runs = null, costs = null } = {}) {
  if (!Number.isInteger(n) || n < 1) throw new Error('--areas: liczba obszarów ≥ 1');
  const pc = productConfig(top, cfg);
  const per = costs ?? (runs ?? completedRuns(top, cfg, pc)).slice(-10).flatMap((r) => agentCosts(r.sessions, 'dwmt-explorer'));
  const [lo, hi] = per.length >= 6 ? [pct(per, 0.25), pct(per, 0.75)] : pc.price.explorerM;
  const rangeM = [r1(n * lo), r1(n * hi)];
  return { ok: true, areas: n, rangeM, perExplorerM: [r2(lo), r2(hi)], basis: per.length >= 6 ? `project explorers n=${per.length} p25-p75` : 'default explorerM', line: `scan of ${n} area${n > 1 ? 's' : ''} ~${rangeM[0]}-${rangeM[1]} M tokens` };
}

// Pliki śledzone przez git minus review.ignoreGlobs (jak sizes.txt, spec dwmt §5.2) z rozmiarem w bajtach.
export function trackedFiles(top, cfg) {
  const ignored = asList(cfg.review?.ignoreGlobs).map((g) => globToRegExp(String(g)));
  return git(['ls-files', '-z'], { cwd: top }).split('\0').filter((f) => f && !ignored.some((r) => r.test(f)));
}

export const globsOf = (v) => asList(v).flatMap((g) => String(g).split(',')).map((g) => g.trim()).filter(Boolean).map((g) => fwd(g).replace(/^\.\//, ''));
// Glob bez znaków specjalnych to też katalog: `src/a` obejmuje `src/a/**`.
export function globMatcher(globs) {
  const res = globsOf(globs).flatMap((g) => (/[*?{]/.test(g) ? [globToRegExp(g)] : [globToRegExp(g), globToRegExp(`${g.replace(/\/$/, '')}/**`)]));
  return (f) => res.some((r) => r.test(fwd(f)));
}

// Zbiór roboczy (§4.12 pkt 1): suma bajtów / 4 plików pasujących do globów, w tysiącach tokenów; globy bez trafień osobno.
export function workingSet(top, globs, cfg = loadConfig(top)) {
  const files = trackedFiles(top, cfg);
  let bytes = 0;
  const empty = [];
  for (const g of globsOf(globs)) if (!files.some(globMatcher([g]))) empty.push(g);
  const hit = globMatcher(globs);
  for (const f of files) {
    if (!hit(f)) continue;
    try { bytes += statSync(join(top, f)).size; } catch { /* usunięty w drzewie */ }
  }
  return { workingSetK: r1(bytes / 4 / 1000), empty };
}

// Analogia (§5.3): przebiegi, których zmienione pliki kodu przecinają globy (bez globów: wszystkie z danymi).
export function analogRuns(runs, globs = null) {
  const hit = globs && globsOf(globs).length ? globMatcher(globs) : null;
  return runs.filter((r) => r.costM != null && r.files > 0 && (!hit || r.changed.some(hit)));
}

export function analogSummary(list) {
  if (!list.length) return null;
  const modes = {};
  for (const r of list) modes[r.mode] = (modes[r.mode] || 0) + 1;
  const mode = Object.entries(modes).sort((a, b) => b[1] - a[1])[0][0];
  const cost = list.map((r) => r.costM);
  const files = list.map((r) => r.files);
  return {
    n: list.length, mode, medianM: r1(median(cost)), rangeM: [r1(pct(cost, 0.25)), r1(pct(cost, 0.75))],
    files: [Math.round(pct(files, 0.25)), Math.round(pct(files, 0.75))], mPerFile: r2(median(list.map((r) => r.costM / r.files))),
  };
}
