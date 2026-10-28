// dwmt D4: bramka drogich rozwiązań w `run` (spec warstwy produktowej §6.4) i linie architekta warstwy produktowej (§6.1).
// Cena projektu liczy skrypt (pliki z nagłówka planu × mln na plik, 0 tokenów) przy pierwszej poprawnej walidacji
// `plan.md`; pytanie `Q-price` układa skrypt i dokłada je do tury pytań architekta (`ask-plan`), bez osobnej rundy.
// Wyłączenie (P-11): `run.priceGate: false` w configu → przebieg bez pól bramki (v2.10); błąd ceny → bez pytania,
// ostrzeżenie w `run.warnings` i w raporcie.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fwd, read, asList } from './util.mjs';
import { section } from './headers.mjs';
import { designPrice, r1 } from './price.mjs';
import { productConfig } from './product-config.mjs';
import { firstAgentCallAfter } from './sessions.mjs';

export const gateOn = (run) => run?.priceGate === true;
export const PRICE_Q = 'Q-price';
// Granica oszacowanego sprintu: górna granica ceny projektu ≤ 1,5 × górna granica szacunku (§6.4 pkt 4).
export const LIMIT_FACTOR = 1.5;

// `files: [min, max]`: liczby całkowite ≥ 0, min ≤ max; null = brak albo zły format.
export function validFiles(v) {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [a, b] = v.map(Number);
  return Number.isInteger(a) && Number.isInteger(b) && a >= 0 && a <= b ? [a, b] : null;
}

// Pole `files` w nagłówku planu (§6.4 pkt 2). Recenzja N-4: brak albo zły format to tylko ostrzeżenie bramki (pkt 7),
// nie błąd walidacji planu (ten kosztowałby płatną turę poprawki architekta).
export function filesErrors(h) {
  if (validFiles(h?.files)) return [];
  return [h?.files == null
    ? 'brak files w nagłówku planu (files: [min, max], oczekiwane zmienione pliki kodu)'
    : `files w nagłówku planu: oczekiwano [min, max] (liczby całkowite, min ≤ max), jest ${JSON.stringify(h.files)}`];
}

// Próg bezwzględny (`run.priceGate.askAboveM`, mln; null = brak): projekt ponad nim → pytanie zawsze.
export function askAboveOf(cfg) {
  const g = cfg?.run?.priceGate;
  const v = g && typeof g === 'object' ? g.askAboveM : null;
  return v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
}

const warn = (run, text) => { run.warnings = [...new Set([...asList(run.warnings), text])]; };

// Odpowiedź na `Q-price` z pliku odpowiedzi: pierwsza linia `continue`, `shrink: <tekst>` albo `stop`.
export function priceAnswer(answersFile) {
  if (!existsSync(answersFile)) return null;
  const sec = section(read(answersFile), PRICE_Q);
  if (sec === null) return null;
  const body = sec.split(/\r?\n/).slice(1).map((l) => l.replace(/^\s*[-*>]\s*/, '').trim()).filter(Boolean);
  const first = body[0] ?? '';
  const m = /^(continue|shrink|stop)\b\s*:?\s*(.*)$/i.exec(first);
  if (!m) return { kind: 'continue', text: body.join(' '), unclear: true };
  const kind = m[1].toLowerCase();
  return { kind, text: kind === 'shrink' ? [m[2], ...body.slice(1)].join(' ').trim() : '' };
}

// Krok bramki w `state` (przed computeState; zapis w run.json robi cmdState). Zwraca true, gdy zmienił `run`.
// 1. pierwsza poprawna walidacja `plan.md` → `run.price` z ceną projektu i decyzją (recenzja N-4, ZAŁOŻENIE w §6.4: bramka
//    sama nie dokłada tury pytań): oszacowany ≤ 1,5× → `none`; oszacowany ponad 1,5× → `ask` (może być osobną turą);
//    freestyle → `ask` tylko w istniejącej turze pytań architekta, bez pytań `info` (cena w zdaniu kroku i w raporcie);
//    ponad `askAboveM` → `ask`; brak `files` albo błąd ceny → `error` z ostrzeżeniem;
// 2. odpowiedź `### Q-price` w `answers.md` → `gate: asked` z odpowiedzią i czasem (dalej: stop, zmniejszenie zakresu);
// 3. zmniejszenie zakresu obsłużone (plan.md nowszy od odpowiedzi) → `handledAt`, koniec tury ceny dla P (§9).
export function priceGateStep({ top, root, run, cfg, plan }) {
  if (!gateOn(run)) return false;
  if (!run.price) {
    if (!plan || plan.h.errors || plan.errors.length) return false;
    const est = run.estimate ?? null;
    const open = asList(plan.h.questions).length;
    const base = { estimate: est?.tokensM ?? null, estimateSrc: est?.src ?? null, at: new Date().toISOString(), otherQuestions: open };
    const files = validFiles(plan.h.files);
    if (!files) {
      run.price = { ...base, design: null, gate: 'error' };
      warn(run, `bramka ceny: ${filesErrors(plan.h)[0]}; bez pytania o cenę`);
      return true;
    }
    try {
      const d = designPrice(top, files, run.modeLabel ?? run.mode, { cfg });
      const limit = est ? r1(LIMIT_FACTOR * est.tokensM[1]) : null;
      const askAboveM = askAboveOf(cfg);
      const reasons = [
        ...(est && d.designM[1] > limit ? ['over-estimate'] : []),
        ...(askAboveM != null && d.designM[1] > askAboveM ? ['above-threshold'] : []),
        ...(!est && open ? ['no-estimate'] : []),
      ];
      const gate = reasons.length ? 'ask' : est ? 'none' : 'info';
      run.price = { ...base, files, design: d.designM, m: d.m, mRange: d.mRange, batchShare: d.batchShare, mode: d.mode, basis: d.basis, limit, ...(askAboveM != null ? { askAboveM } : {}), gate, ...(reasons.length ? { reasons } : {}) };
    } catch (e) {
      run.price = { ...base, files, design: null, gate: 'error' };
      warn(run, `bramka ceny: ${e.message}; bez pytania o cenę`);
    }
    return true;
  }
  if (run.price.gate === 'ask') {
    const a = priceAnswer(join(root, 'answers.md'));
    if (!a) return false;
    // Tura tylko z powodu ceny (§9, P): architekt nie miał innych pytań w tej turze.
    const onlyTurn = !run.price.otherQuestions;
    run.price = { ...run.price, gate: 'asked', answer: { kind: a.kind, text: a.text, at: new Date().toISOString() }, onlyTurn };
    if (a.unclear) warn(run, `Q-price: odpowiedź nieczytelna („${a.text.slice(0, 80)}”), przyjęto continue`);
    return true;
  }
  if (run.price.gate === 'asked' && run.price.answer?.kind === 'shrink' && !run.price.handledAt) {
    const f = join(root, 'plan.md');
    const t = existsSync(f) ? statSync(f).mtimeMs : 0;
    if (t > Date.parse(run.price.answer.at)) { run.price.handledAt = new Date(t).toISOString(); return true; }
  }
  return false;
}

// Cena bez pytania (`none`, `info`) w zdaniu kroku orkiestratora (pole `priceNote` w `state`, raz).
export function priceNote(run) {
  const p = run?.price;
  if (!p?.design || !['none', 'info'].includes(p.gate)) return null;
  const why = p.gate === 'none' ? `within ${LIMIT_FACTOR}x the estimate ${p.estimate[0]}-${p.estimate[1]} M` : 'no estimate, no question';
  return `Design price: ~${p.files[0]}-${p.files[1]} files, ~${p.design[0]}-${p.design[1]} M tokens (${p.m} M/file, mode ${p.mode}${p.batchShare != null ? `, fix batch +${Math.round(p.batchShare * 100)}%` : ''}); ${why}.`;
}

// Pytanie dla orkiestratora (`ask-plan`, pole `price`): treść według szablonu pytań (spec dwmt §5.2), opcje z rekomendacją.
export function priceQuestion(run) {
  const p = run.price;
  const over = `the design exceeds the sprint's estimate ${p.estimateSrc === 'start' ? '(price accepted at start)' : p.estimateSrc} of ${p.estimate?.[0]}-${p.estimate?.[1]} M tokens by more than ${LIMIT_FACTOR}x`;
  const texts = { 'over-estimate': over, 'above-threshold': `the design is above the project's price threshold of ${p.askAboveM} M tokens`, 'no-estimate': 'the sprint has no estimate' };
  const reasons = asList(p.reasons).length ? p.reasons : [p.estimate ? 'over-estimate' : 'no-estimate'];
  const why = reasons.map((r) => texts[r]).join('; ');
  return {
    id: PRICE_Q,
    title: 'Price of the design',
    text: `Why I ask: ${why}. Design: ~${p.files[0]}-${p.files[1]} files, ~${p.design[0]}-${p.design[1]} M tokens (${p.mRange && p.mRange[0] !== p.mRange[1] ? `${p.mRange[0]}-${p.mRange[1]}` : p.m} M per file in this project, mode ${p.mode}; basis ${p.basis}).`,
    options: ['continue (Recommended): run the sprint as designed', 'shrink: <what to leave out>: the architect plans the smaller scope', 'stop: the sprint stops; items and sprint file stay unchanged'],
    record: '### Q-price, first line: continue | shrink: <what to leave out> | stop',
  };
}

// Stan bramki w planowaniu architekta: { pending } (pytanie w tej turze), { stop }, { shrink, handled } albo null.
export function priceTurn(root, run) {
  const p = run?.price;
  if (!gateOn(run) || !p) return null;
  if (p.gate === 'ask') return { pending: true };
  if (p.gate !== 'asked' || !p.answer) return null;
  if (p.answer.kind === 'stop') return { stop: true };
  if (p.answer.kind === 'shrink') {
    const f = join(root, 'plan.md');
    const handled = existsSync(f) && statSync(f).mtimeMs > Date.parse(p.answer.at);
    return { shrink: p.answer.text || '(no detail given)', handled };
  }
  return null;
}

// Pole `price` raportu (§6.4 pkt 8). Wartości `gate` (§6.4 pkt 8): `none` (bez pytania: w granicy albo freestyle bez pytań architekta), `asked`, `over`
// (ponad granicą bez pytania) i `error` (ceny nie ma: brak `files` albo błąd skryptu; ostrzeżenie w raporcie).
export function priceReport(run) {
  const p = run?.price;
  if (!gateOn(run)) return null;
  const over = p?.design && p.limit != null && p.design[1] > p.limit;
  const gate = !p ? 'none' : p.gate === 'ask' || p.gate === 'asked' ? 'asked' : p.gate === 'error' ? 'error' : over ? 'over' : 'none';
  return { estimate: p?.estimate ?? run.estimate?.tokensM ?? null, design: p?.design ?? null, gate, ...(p?.files ? { files: p.files } : {}) };
}

// P narzutu (§9): koszt pierwszego wywołania architekta, który odpowiedział na `Q-price` (tylko „zmniejsz zakres”: przy
// „dalej” i „stop” architekt nie wraca), w oknie od odpowiedzi do zapisu poprawionego planu; późniejszy replan nie wchodzi.
export function priceTurnCost(run) {
  const p = run?.price;
  if (!p?.onlyTurn || !p.answer?.at || p.answer.kind !== 'shrink') return 0;
  try { return firstAgentCallAfter(run.session_ids, 'dwmt-architect', p.answer.at, undefined, p.handledAt ?? null) ?? 0; } catch { return 0; }
}

// Linie architekta warstwy produktowej (§6.1, 3 linie) i bramki (§6.4 pkt 2, 1 linia): tylko gdy warstwa albo bramka
// działa, więc bez nich prompt jest jak w v3-driver.
export function productArchitectLines(top, run, cfg) {
  const out = [];
  if (gateOn(run)) out.push(' Price gate: write `files: [min, max]` in the plan header together with the questions: how many code files (source and tests, not docs or generated files) the sprint will change.');
  let pc = null;
  try { pc = productConfig(top, cfg); } catch { /* bez warstwy */ }
  if (run?.spec) out.push(" Sprint file (task.md): its acceptance criteria, decisions and out of scope bind you (add technical AC only); `## Input coverage` covers every AC, every item of `items` and `touch` and every mockup; settle its `[architect]` open questions in your one question turn.");
  const reg = pc?.present ? join(pc.abs, 'decisions.md') : null;
  if (reg && existsSync(reg)) {
    out.push(` Product decisions: ${fwd(reg)}: before a business question grep it for the question's words; an active PD-n is the answer: record it as D-n citing the PD-n and do not ask.`);
    out.push(' A strategic matter (conflict with an ADR or the product goal, a product decision outside the scope): `second` starting `decision:` or a question; `second` for a sprint too large starts `size:`.');
  }
  return out.join('');
}

// `estOverhead` w nagłówku raportu (§9): (E + P) / S; E z dziennika szacunków (gdy jest warstwa produktowa), P z tury
// tylko z powodu `Q-price` (zapis w `run.price.turnM` dla `product overhead`), S = koszt sprintu z raportu.
// null, gdy nie ma ani warstwy, ani bramki (raport jak w v3-driver), albo kosztu sprintu.
export function estOverheadOf(top, run, cfg, S, overheadFn = null) {
  let pc = null;
  try { pc = productConfig(top, cfg); } catch { /* bez warstwy */ }
  if (!gateOn(run) && !pc?.present) return null;
  const P = priceTurnCost(run);
  if (run.price && run.price.onlyTurn) run.price.turnM = P;
  let E = 0;
  if (pc?.present && overheadFn) { try { E = Number(overheadFn().E) || 0; } catch { E = 0; } }
  if (!(Number(S) > 0)) return null;
  return Math.round(((E + P) / Number(S)) * 10000) / 10000;
}
