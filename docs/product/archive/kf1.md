---
schema: "dwmt/sprint-spec@1"
id: "kf1"
kind: "bugfix"
goal: "time to fix"
items: ["B-7"]
touch: []
refs: []
uatGate: false
ui: false
mode: "intermediate"
est: "start:[2.6,4]"
ready: {"at":"2026-10-22","by":"decydent","direct":true}
run: null
actual: {"files":3,"tokens":1.71,"uat":"positive","merged":"2026-10-23","lines":109}
---

## Goal
Fix B-7 (Roadmap state not updated when a sprint merges; page shows a merged sprint as in progress).

## Acceptance
- AC-1 B-7 no longer happens: repro steps no longer show "Roadmap state not updated when a sprint merges; page shows a merged s…"; expected behaviour holds (product item B-7 --detail).

## Out of scope
- Anything beyond the listed bugs.

## Decisions
- SD-1 Task verification takes at most ~5 min and runs only the tests related to the change (`--test-name-pattern` instead of whole heavy files) (user, 2026-10-22).
