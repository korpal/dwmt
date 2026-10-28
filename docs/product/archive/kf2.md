---
schema: "dwmt/sprint-spec@1"
id: "kf2"
kind: "bugfix"
goal: "time to fix"
items: ["B-16"]
touch: []
refs: []
uatGate: false
ui: false
mode: "auto"
est: null
ready: {"at":"2026-10-22","by":"decydent"}
run: null
actual: {"files":12,"tokens":5.73,"uat":"positive","merged":"2026-10-23","lines":624}
---

## Goal
Fix B-16 (Supervisor keeps order-time deps; a sprint reordered in the roadmap starts first).

## Acceptance
- AC-1 B-16 no longer happens: repro steps no longer show "Supervisor keeps order-time deps; a sprint reordered in the roadmap s…"; expected behaviour holds (product item B-16 --detail).

## Out of scope
- Anything beyond the listed bugs.

## For you
Title: Nadzorca pilnuje aktualnej kolejności sprintów z planu
Why: Dziś nadzorca zapamiętuje, co na co czeka, w chwili zlecenia. Gdy potem zmienisz kolejność w planie, sprint może ruszyć za wcześnie i trzeba to odkręcać ręcznie. Po poprawce zmiana kolejności w planie działa od razu.
Changes:
- nadzorca bierze kolejność i zależności z bieżącego planu, nie z chwili zlecenia
Check:
- zleć dwa sprinty, zmień w planie ich kolejność i sprawdź, że rusza ten, który jest teraz pierwszy
