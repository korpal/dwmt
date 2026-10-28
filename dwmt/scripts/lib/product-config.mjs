// dwmt D4: config warstwy produktowej (`product` w .claude/dwmt.json, spec warstwy produktowej §8) i definicja zmienionego
// pliku kodu (§5.1, przeniesiona z dawnego skryptu analizy kosztów: rozszerzenia kodu, bez plików binarnych, bez generowanych;
// tu uogólniona: `product.codeGlobs` minus `review.ignoreGlobs`). Bez klucza `product` i bez katalogu produktu warstwy nie ma
// (P-11): `present: false`, a cena używa 0,2 mln na plik dla każdego trybu.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { asList } from './util.mjs';
import { globToRegExp } from './text.mjs';

// cost-per-file.py: .java .ts .tsx .css .mjs; generowany klient API i openapi.json wykluczał projekt (tu: review.ignoreGlobs).
export const DEFAULT_CODE_GLOBS = ['**/*.{java,kt,kts,scala,groovy,ts,tsx,js,jsx,mjs,cjs,vue,svelte,css,scss,sass,less,py,rb,go,rs,php,cs,fs,c,h,cc,cpp,hpp,m,mm,swift,dart,sql,sh,ps1}'];

export const PRODUCT_DEFAULTS = {
  dir: 'docs/product',
  codeGlobs: DEFAULT_CODE_GLOBS,
  sprintMax: { files: 120, tokensM: 25 },
  warnAboveM: null, // null = połowa mediany sprintu, bez danych 8
  estimate: { maxTurns: 40, weeklyWarnM: 1.5 },
  contextWarnK: 150,
  designSystem: null,
  mockupsDir: null,
  enabled: null, // null = true, gdy istnieje `dir`
  // Noc 2026-10-05: progi rekomendacji trybu — direct (E) do `directMaxFiles` plików kodu, intermediate (D) do
  // `intermediateMaxFiles` (bez szacunku plików: zbiór roboczy do `intermediateMaxK` tys. tokenów).
  // directMaxCited (przegląd sprintu 16 (UI)): próg direct dla plików cytowanych w treści uwag z recenzji (z dowodami, więc wyższy).
  start: { smallMaxK: 30, smallMaxM: 1.0, directMaxFiles: 10, directMaxCited: 20, intermediateMaxFiles: 60, intermediateMaxK: 150 },
  // fixFilesPerItem (K5 D-20): files per item of a fix sprint while no finished fix sprint gives the p25–p75 range.
  price: { explorerM: [0.24, 0.86], defaultMPerFile: { direct: 0.05, inline: 0.1, intermediate: 0.15, single: 0.2 }, fixFilesPerItem: [1, 3] },
  // Human view (§3.11): page regenerated after commit, sync, brief and intake (`enabled`); titles translated after
  // `product commit` in a detached background process when the language is not en (`translate`); cheap model for them and
  // for `for-you --draft`; timeouts per call. Live sprint view (`live`): a detached writer keeps live.js next to the page
  // while sprints run, every `liveIntervalSec` (the page polls at the same interval). `publish`: path from the repo root of a
  // copy of the page that `product commit` writes before `git add`, so it enters the same commit (null = page only under
  // .dwmt/). The null here is a placeholder: without the key, productConfig sets `<dir>/roadmap.html` (D-5, K2).
  view: { enabled: true, translate: true, model: 'haiku', draftTimeoutS: 180, translateTimeoutS: 120, live: true, liveIntervalSec: 5, publish: null },
  // K7 (D-11, SD-7): a workplace branch this many commits behind its base gets a warning; the worktree location reuses
  // `supervisor.worktreeDir`.
  workplace: { farBehind: 20 },
  import: { branch: 'dwmt/product-import', mPerKChars: [0.009, 0.018], sources: [], batch: 40, agent: { model: 'opus', effort: 'medium', maxTurns: 60 } },
};
// Bez warstwy produktowej (§6.4 pkt 3): 0,2 mln na plik w każdym trybie.
export const NO_PRODUCT_M_PER_FILE = 0.2;

function merge(a, b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = a && typeof a[k] === 'object' && a[k] !== null && !Array.isArray(a[k]) ? merge(a[k], v) : v;
  return out;
}

// `cfg` z loadConfig: klucz `product` istnieje tylko, gdy podał go użytkownik (DEFAULTS dwmt go nie mają).
export function productConfig(top, cfg) {
  const p = merge(PRODUCT_DEFAULTS, cfg?.product && typeof cfg.product === 'object' ? cfg.product : {});
  // D-5 (K2): without an own `product.view.publish` key the page is `<dir>/roadmap.html`, committed with the product;
  // an explicit null keeps it only under .dwmt/, an explicit path stays.
  const own = cfg?.product?.view;
  if (!p.view || typeof p.view !== 'object' || Array.isArray(p.view)) p.view = { ...PRODUCT_DEFAULTS.view };
  if (!(own && typeof own === 'object' && Object.hasOwn(own, 'publish'))) {
    p.view.publish = `${String(p.dir).replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '')}/roadmap.html`;
  }
  p.abs = join(top, p.dir);
  p.present = !!cfg?.product || existsSync(p.abs);
  p.enabled = p.enabled === null || p.enabled === undefined ? existsSync(p.abs) : !!p.enabled;
  return p;
}

// Zmieniony plik kodu: pasuje do codeGlobs i nie pasuje do review.ignoreGlobs.
export function codeMatcher(cfg, pc) {
  const code = asList(pc?.codeGlobs ?? DEFAULT_CODE_GLOBS).map((g) => globToRegExp(String(g)));
  const ignore = asList(cfg?.review?.ignoreGlobs).map((g) => globToRegExp(String(g)));
  return (f) => code.some((r) => r.test(f)) && !ignore.some((r) => r.test(f));
}
