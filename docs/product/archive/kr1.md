---
schema: "dwmt/sprint-spec@1"
id: "kr1"
kind: "bugfix"
goal: "time to fix"
items: ["B-1","B-2","B-3","B-4","B-5","B-9","B-11","B-12","B-13","B-14"]
touch: []
refs: []
uatGate: false
ui: false
mode: "auto"
est: null
ready: {"at":"2026-10-22","by":"decydent"}
run: null
actual: {"files":11,"tokens":4.29,"uat":"n/a","merged":"2026-10-23","lines":230}
---

## Goal
Fix B-1 ([minor] R-4: reuse of a rewritten cache entry is not asserted); B-2 ([minor] The binary skip is not exercised: the binary fixture is never a code file); B-3 ([minor] No test for filling `lines` into an existing `actual` of a sprint awaiting UAT); B-4 ([minor] The file-mode cost chart's plotted values are not asserted); B-5 ([minor] The switch click (remember the choice, redraw only the card) has no test); B-9 ([minor] R-5 guard did not run: the v28 full-sprint test is red before the split); B-11 ([minor] With the default page, `finish` and `uat record` write the page under the merge l…); B-12 ([minor] The batch filter (D-11) and the batch input's left-out lines have no test that fa…); B-13 ([minor] Reviewer and lens choice no longer see unreported out-of-scope code files); B-14 ([minor] `reportedPaths` reads only a bare leading path, so other entry forms mark a repor…).

## Acceptance
- AC-1 B-1 resolved: "[minor] R-4: reuse of a rewritten cache entry is not asserted" no longer holds (product item B-1 --detail).
- AC-2 B-2 resolved: "[minor] The binary skip is not exercised: the binary fixture is never…" no longer holds (product item B-2 --detail).
- AC-3 B-3 resolved: "[minor] No test for filling `lines` into an existing `actual` of a sp…" no longer holds (product item B-3 --detail).
- AC-4 B-4 resolved: "[minor] The file-mode cost chart's plotted values are not asserted" no longer holds (product item B-4 --detail).
- AC-5 B-5 resolved: "[minor] The switch click (remember the choice, redraw only the card) …" no longer holds (product item B-5 --detail).
- AC-6 B-9 resolved: "[minor] R-5 guard did not run: the v28 full-sprint test is red before…" no longer holds (product item B-9 --detail).
- AC-7 B-11 resolved: "[minor] With the default page, `finish` and `uat record` write the pa…" no longer holds (product item B-11 --detail).
- AC-8 B-12 resolved: "[minor] The batch filter (D-11) and the batch input's left-out lines …" no longer holds (product item B-12 --detail).
- AC-9 B-13 resolved: "[minor] Reviewer and lens choice no longer see unreported out-of-scop…" no longer holds (product item B-13 --detail).
- AC-10 B-14 resolved: "[minor] `reportedPaths` reads only a bare leading path, so other entr…" no longer holds (product item B-14 --detail).

## Out of scope
- Anything beyond the listed items.

## Decisions
- SD-1 Task verification takes at most ~5 min and runs only the tests related to the change (`--test-name-pattern` instead of whole heavy files) (user, 2026-10-22).
