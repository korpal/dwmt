// dwmt: alarm ceny (przegląd 2026-10-09, W-3, decyzja użytkownika: powiadomić, nigdy nie zatrzymywać). sprint V kosztował
// 55,7 mln przy górnej cenie projektu 25,2 (PO zauważył przypadkiem), phase-5 25,6 przy cenie startu 3,3–3,8. Sterownik po
// każdym agencie woła `price-alert <run>`: koszt przebiegu (to samo źródło co raport) ponad górną granicę ceny projektu
// (`price.design[1]`, bez niej szacunku) → raz zdarzenie `price-alert` (`dwmt wait --progress` daje linię z `push`,
// supervisor powiadamia) i `run.priceAlert` w run.json. Prognoza naiwna: koszt / zadania zacommitowane × zadania.
import { asList } from './util.mjs';
import { loadRun, saveRun, runEvent, isLegacy } from './run.mjs';
import { runCost } from './report.mjs';
import { loadConfig } from './config.mjs';

const r1 = (x) => Math.round(x * 10) / 10;

export function upperPrice(run) {
  const p = run?.price;
  const v = p?.design?.[1] ?? p?.estimate?.[1] ?? run?.estimate?.tokensM?.[1] ?? null;
  return Number.isFinite(Number(v)) && Number(v) > 0 ? { upperM: Number(v), basis: p?.design ? 'design' : 'estimate' } : null;
}

// Prognoza: koszt na zacommitowane zadanie × liczba zadań (null przed pierwszym commitem).
export function naiveForecast(costM, run) {
  if (isLegacy(run)) return null;
  const done = asList(run.tasks).filter((t) => t.commit).length;
  const n = Number(run.count) || asList(run.tasks).length;
  return done && n ? { forecastM: r1((costM / done) * n), done, tasks: n } : { forecastM: null, done: 0, tasks: n || null };
}

export function cmdPriceAlert(top, id, { costFn = runCost } = {}) {
  const run = loadRun(top, id);
  if (run.priceAlert) return { ok: true, already: true, priceAlert: run.priceAlert };
  const up = upperPrice(run);
  if (!up) return { ok: true, skipped: 'brak ceny' };
  const cost = costFn(top, run, loadConfig(top))?.total ?? null;
  if (cost == null || cost <= up.upperM) return { ok: true, costM: cost, upperM: up.upperM };
  const f = naiveForecast(cost, run);
  run.priceAlert = { at: new Date().toISOString(), costM: cost, upperM: up.upperM, basis: up.basis, ...f };
  saveRun(top, run);
  runEvent(top, run, 'price-alert', { costM: cost, detail: { upperM: up.upperM, basis: up.basis, ...f } });
  return { ok: true, alert: true, priceAlert: run.priceAlert };
}
