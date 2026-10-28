---
schema: "dwmt/sprint-spec@1"
id: "kh"
kind: "feature"
items: ["B-66","B-41"]
touch: []
refs: []
uatGate: false
ui: false
mode: "single"
est: "start:[4.4,15.2]"
ready: {"at":"2026-10-26","by":"decydent","direct":true}
run: null
actual: null
---

## Goal
Show in the History tab how much real agent work time a sprint took per changed line, split into model, tests and machine queue, so slow tests or long fix rounds show up; and push when one session costs far more than usual. Context: B-66 (its detail file), B-41.

## Acceptance
- AC-1 Active time of a run is computed from its session transcripts: intervals of model turns and of running tool calls count; waits for the user (questions, ask stops), gaps with no pending tool call above a cap (default 5 min, configurable) and time between sessions do not.
- AC-2 Active time is split into model, tests (verify commands) and machine queue wait; the parts add up to the total.
- AC-3 finish records active time and its split in the sprint result; the History tab shows minutes per changed line next to tokens per changed line, with the median and the trend, and the split per sprint; a sprint without the data shows "no data", never 0.
- AC-4 Finished sprints whose transcripts still exist get the value backfilled by one command; the others stay "no data".
- AC-5 A session costing more than 3x the rolling average of the run's sessions sends one push; the run never stops for it (B-41).
- AC-6 The product-layer spec describes the measure and the cap; runs created before this change finish under their own rules.

## Out of scope
- Start price from the history of similar sprints (B-60).
- Live time on the running sprint view.

## Decisions
- SD-1 Tests: only those related to the change, never the full `dwmt/test/*.test.mjs` suite during tasks.

## Open questions
- none

## For you
Title: Czas realnej pracy agentów na zmienioną linię w Historii
Why: Pokazuje, ile faktycznej pracy kosztował sprint na linię i co go spowalnia (model, testy, kolejka), bez liczenia przerw, awarii i czekania na Ciebie.
Changes:
- w Historii minuty na zmienioną linię obok tokenów na linię, z medianą i trendem
- podział czasu: praca modelu, testy, czekanie w kolejce
- wcześniejsze sprinty policzone wstecz, jeśli zostały ich zapisy sesji
- powiadomienie, gdy jedna sesja kosztuje ponad 3 razy więcej niż zwykle
Not included:
- cena startowa z historii podobnych sprintów
Check:
- otwórz Historię: czy po czasie na linię widać, które sprinty spowalniały testy
