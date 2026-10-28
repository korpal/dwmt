// dwmt: weryfikacja UI (X7): zrzuty z e2e obok makiet.
import { writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, copyFileSync, statSync } from 'node:fs';
import { join, resolve, basename, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { ROOT, fwd, read } from './util.mjs';
import { trimOutput } from './text.mjs';
import { parseRisks } from './risks.mjs';

// ---------- weryfikacja UI (X7): zrzuty z e2e obok makiet ----------

export const uiRisks = (text) => parseRisks(text).filter((r) => r.method === 'ui');
export const uiDir = (dir) => join(dir, 'ui');
const cellText = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const html = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function pngsSince(root, t0) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.png$/i.test(e.name) && statSync(f).mtimeMs >= t0 - 1000) out.push(f);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

// Playwright czyści katalog wyników na starcie każdego uruchomienia, więc świeże zrzuty kopiujemy po każdej komendzie.
export function collectShots(root, t0, dest) {
  const files = pngsSince(root, t0);
  if (files.length) mkdirSync(dest, { recursive: true });
  for (const f of files) copyFileSync(f, join(dest, basename(f)));
  return files.length;
}

// `Shot: nazwa` pasuje do `nazwa.png` albo `nazwa-<cokolwiek>.png` (np. `capture()` dopisuje viewport).
export function matchShot(files, name) {
  const base = (f) => f.replace(/\.png$/i, '');
  return files.find((f) => base(f) === name) ?? files.filter((f) => base(f).startsWith(`${name}-`)).sort()[0] ?? null;
}

const RENDER = join(ROOT, 'scripts', 'render-mockup.mjs');
function renderMockups(top, cfg, jobs) {
  if (!jobs.length) return {};
  const f = join(tmpdir(), `dwmt-render-${process.pid}-${Date.now()}.json`);
  writeFileSync(f, JSON.stringify({ viewport: cfg.ui.viewport, css: cfg.ui.mockupCss, jobs }));
  try {
    const r = spawnSync(process.execPath, [RENDER, f], { cwd: resolve(top, cfg.ui.playwright), encoding: 'utf8', timeout: 5 * 60e3, windowsHide: true });
    let out;
    try { out = JSON.parse(r.stdout); } catch { out = { ok: false, error: trimOutput([r.stdout, r.stderr, r.error?.message].filter(Boolean).join('\n'), 3).lines.join(' | ') || 'render bez wyniku' }; }
    if (out.error) return Object.fromEntries(jobs.map((j) => [j.id, out.error]));
    return Object.fromEntries((out.results || []).filter((x) => !x.ok).map((x) => [x.id, x.error]));
  } finally { rmSync(f, { force: true }); }
}

// Pary ryzyk `ui`: zrzut tej rundy i makieta (png kopiowana, html renderowany raz na przebieg).
export function prepareUi(top, dir, cfg, round, risks) {
  const ud = uiDir(dir);
  const shotsDir = join(ud, `r${round}`);
  mkdirSync(ud, { recursive: true });
  const files = existsSync(shotsDir) ? readdirSync(shotsDir).filter((f) => /\.png$/i.test(f)) : [];
  const jobs = [];
  const pairs = risks.map((r) => {
    const out = join(ud, `mockup-${String(r.id).replace(/\//g, '-')}.png`);
    const src = resolve(top, r.mockup);
    let mockupError = null;
    if (!existsSync(src)) mockupError = `no mockup file ${r.mockup}`;
    else if (/\.png$/i.test(src)) copyFileSync(src, out);
    else if (!existsSync(out)) jobs.push({ id: r.id, html: fwd(src), state: r.state, out: fwd(out) });
    const shot = matchShot(files, r.shot);
    return { id: r.id, title: r.title, weight: r.weight, shotName: r.shot, shot: shot ? fwd(join(shotsDir, shot)) : null, mockupSrc: r.mockup, state: r.state, mockup: fwd(out), mockupError };
  });
  const errors = renderMockups(top, cfg, jobs);
  for (const p of pairs) {
    if (errors[p.id]) p.mockupError = errors[p.id];
    if (p.mockupError || !existsSync(p.mockup)) { p.mockupError ??= 'mockup not rendered'; p.mockup = null; }
  }
  writeFileSync(join(ud, `pairs-r${round}.json`), `${JSON.stringify(pairs, null, 2)}\n`);
  return pairs;
}

export function readPairs(dir, round) {
  const f = join(uiDir(dir), `pairs-r${round}.json`);
  return existsSync(f) ? JSON.parse(read(f)) : [];
}
export function latestPairs(dir) {
  const ud = uiDir(dir);
  if (!existsSync(ud)) return [];
  const rounds = readdirSync(ud).map((n) => /^pairs-r(\d+)\.json$/.exec(n)?.[1]).filter(Boolean).map(Number);
  return rounds.length ? readPairs(dir, Math.max(...rounds)) : [];
}

export const screensTable = (pairs, title, note) => [
  `## ${title}`, '', note, '', '| Risk | Screenshot (app) | Mockup |', '|---|---|---|',
  ...pairs.map((p) => `| ${cellText(`${p.id} ${p.title}`)} | ${p.shot ? `\`${p.shot}\`` : `none: no screenshot \`${p.shotName}\` this round`} | ${p.mockup ? `\`${p.mockup}\`` : `unavailable: ${cellText(p.mockupError)}`} (source \`${p.mockupSrc}\`${p.state ? `, state \`${cellText(p.state)}\`` : ''}) |`),
  '',
];

// Strona dla człowieka: makieta obok zrzutu, status ryzyka z recenzji (DoD sprintu 3: ocena na screenshotach).
export function writeCompare(dir, pairs, status = {}) {
  const ud = uiDir(dir);
  const img = (p, alt) => (p ? `<img src="${html(fwd(relative(ud, p)))}" alt="${html(alt)}">` : `<p class="miss">${html(alt)}</p>`);
  const items = pairs.map((p) => `<section><h2>${html(p.id)} ${html(p.title)}</h2><p class="st">${html(status[p.id] ?? 'not reviewed yet')}</p><div class="pair">`
    + `<figure><figcaption>Mockup: ${html(p.mockupSrc)}${p.state ? ` (${html(p.state)})` : ''}</figcaption>${img(p.mockup, p.mockupError || 'mockup')}</figure>`
    + `<figure><figcaption>App: ${html(p.shotName)}</figcaption>${img(p.shot, p.shot ? p.shotName : 'no screenshot')}</figure></div></section>`);
  const css = 'body{font:14px system-ui,sans-serif;margin:16px;background:#fff;color:#111}.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}figure{margin:0}img{width:100%;border:1px solid #ccc}.st{font-weight:600}.miss{color:#b00}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}}';
  const file = join(ud, 'compare.html');
  writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>dwmt: screens</title><style>${css}</style></head><body><h1>Screens: mockup | app</h1>${items.join('\n')}</body></html>\n`);
  return fwd(file);
}
