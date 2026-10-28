// Zestawy testów (kt, D-1/D-15): lista plików wolnych; każdy inny `dwmt/test/*.test.mjs` jest szybki, więc nowy plik
// testów biegnie przy każdym finish, dopóki ktoś nie wpisze go tutaj. Szybki: `node dwmt/test/run.mjs fast`
// (verify.full), wolny: `node dwmt/test/run.mjs slow` (ręcznie, przed tagiem dla dwmt-stable, D-7).
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TEST_DIR = fileURLToPath(new URL('.', import.meta.url));

// Pomiar kt (bench/pomiary/2026-10-22-kt/README.md): szybkie są pliki rdzenia i zmierzone zielone pliki dodane od
// najkrótszego, póki szacowany czas zestawu mieści się w ~4,5 min; reszta i pliki czerwone na bazie są wolne.
// price, pm16ui i v210b wróciły do wolnych po próbie z domyślnym `--jobs` (414 s; v210b czerwony tylko pod obciążeniem),
// machine po drugiej próbie (kolejka maszyny: limit 5 s na start CLI przekroczony pod obciążeniem, sam zielony).
// home-tree (K3 T-3, D-13): 75–84 s sam (2026-10-23, Windows; pełny przebieg init → finish → uat to 24–26 s), ponad próg 30 s.
export const SLOW = [
  'd1.test.mjs', 'd2.test.mjs', 'd3.test.mjs', 'd4b.test.mjs', 'e3plus.test.mjs', 'home-tree.test.mjs', 'k7-supervisor.test.mjs', 'k7-workplace-flow.test.mjs','machine.test.mjs', 'n1005.test.mjs',
  'n4fix.test.mjs', 'pm16ui.test.mjs', 'price.test.mjs', 'product.test.mjs', 'r1009.test.mjs', 'run.test.mjs', 's2.test.mjs',
  's3.test.mjs', 'todo-foryou.test.mjs', 'v210.test.mjs', 'v210b.test.mjs', 'v28.test.mjs', 'v28b.test.mjs',
  'v29.test.mjs', 'v3drive.test.mjs', 'view.test.mjs',
];

export const testFiles = () => readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.mjs')).sort();
export const slowFiles = () => testFiles().filter((f) => SLOW.includes(f));
export const fastFiles = () => testFiles().filter((f) => !SLOW.includes(f));
