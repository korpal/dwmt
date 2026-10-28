---
schema: "dwmt/sprint-spec@1"
id: "kt"
kind: "maintenance"
items: ["B-8"]
touch: []
refs: []
uatGate: false
ui: false
mode: "intermediate"
est: "start:[2.6,4]"
ready: {"at":"2026-10-22","by":"decydent","direct":true}
run: null
actual: {"files":33,"tokens":13.67,"uat":"positive","merged":"2026-10-22","lines":1225}
---

## Goal
Sprint verification time down so a task verifies in minutes, not tens of minutes: the slowest test files run faster, the tests split into a fast and a slow set (a slice of step K8), and a fix or repair round no longer reruns the whole verify set (B-8). Context: user decisions 2026-10-22; measured times: `product.test` + `view.test` ~10 min, `d2`/`x7`/`d3` ~12 min, `s2`/`v28`/`v28b`/`r1009` ~20 min.

## Acceptance
- AC-1 Per-file test durations are measured before and after; the files named in Goal are faster, with the before/after table in the sprint report.
- AC-2 The tests are split into a fast set and a slow set, each runnable with one named command; the fast set runs in at most ~5 min on the user's machine. `.claude/dwmt.json` `verify.full` runs the fast set.
- AC-3 A fix or repair round reruns only the test files that were red or that the fix touches, not the task's whole verify set; the whole set still runs once before the task is accepted (B-8).
- AC-4 No coverage lost: no test deleted or weakened to gain speed; every moved or restructured test keeps its assertions.

## Out of scope
- The full suite by modules (step K5); the run format normaliser and the rest of the fast/integration split (step K8).

## Decisions
- SD-1 Task verification takes at most ~5 min and runs only the tests related to the change (`--test-name-pattern` instead of whole heavy files) (user, 2026-10-22).
- SD-2 Never run the full suite `dwmt/test/*.test.mjs` (user, 2026-10-21).

## Open questions
- [architect] How the fast/slow split is marked (file list, directory, tag) and how the slow set is still run regularly.

## For you
Title: Szybsze testy: sprawdzenie zadania w minutach, nie w dziesiątkach minut
Why: Dziś najwolniejsze pliki testów zabierają większość czasu sprintu, a każda poprawka puszcza wszystko od nowa. Po tym sprincie zadanie sprawdza się w kilka minut, a sprinty kończą się szybciej i taniej.
Changes:
- najwolniejsze testy przyspieszone, z tabelą czasów przed i po
- podział na szybkie testy (do ~5 minut) i wolne, puszczane osobno
- poprawka po recenzji puszcza tylko testy, które były czerwone albo których dotyczy
Not included:
- pełny podział wszystkich testów na moduły (późniejszy sprint)
Check:
- w raporcie sprintu tabela czasów: najwolniejsze pliki są wyraźnie szybsze
- szybki zestaw testów kończy się w ~5 minut
- żaden test nie zniknął ani nie został osłabiony
