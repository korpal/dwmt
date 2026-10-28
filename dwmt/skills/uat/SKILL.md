---
name: uat
description: The user's acceptance test of merged dwmt sprints. Shows the UAT list from the sprint report, holds merges into the target branch while the user tests, records the result with defect classes and prepares the fix sprint.
argument-hint: "[<sprint>…] [--late]"
effort: high
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
# dwmt: uat

You run the user's acceptance test of merged sprints. You read only script output and report sections, never the code. Never run tests, E2E or the app's scripts: the user tests; a missing screenshot or file is reported as missing.

**Messages.** When you need the user (a question, a stop) and when the UAT ends: one sentence what happened, one what you need from them ("nothing" when nothing); send that line first with PushNotification (load it with ToolSearch `select:PushNotification`; it is skipped while the user is at the terminal). Plain talk (user's rule): to the user, name things by what they do or what the user sees, not by identifiers (B-n, AC-n, D-n, F-n, R-n, Q-n, run or sprint ids, file paths), and assume they do not remember the details: give the one sentence of context a question needs.

**Script.** `dwmt <command>` means exactly `node "${CLAUDE_PLUGIN_ROOT}/scripts/dwmt.mjs" <command>`, run from the repo root (any tree of the project; it works on the main tree). It prints JSON. Never put environment variables or `$(…)` substitutions in commands. Talk to the user in the language of the report's `## UAT` steps (the rest of the report is in English).

**Arguments:** `$ARGUMENTS`

## 1. What waits

- No sprint given: `dwmt uat list`. Show `waiting` (since when) and `mergeWait` (sprints whose squash waits), then ask which to test now (AskUserQuestion, multiSelect). None: end.
- `--late`: a defect found after the UAT. `dwmt uat list --all` gives merged sprints with date and scope; propose the source sprint from the scope and the user's description, confirm with one question, then go to step 4 and record with `--late` (no hold).

## 2. Start

`dwmt uat start <sprint…>`. It refuses a sprint whose squash is not on its target branch (e.g. in `merge-wait`; for a sprint of a workplace the target is the workplace branch): say why. It holds merges into the target branch until `until`, so the app does not change while the user tests. With `tree` (a workplace sprint: its squash exists only on the workplace branch), tell the user in one plain line to start and test the app in that tree, not in the main one.

## 3. The UAT list

For each report in `reports`: `dwmt section <report> UAT`. Show it compactly: how to start the app, the scenario per task, the items for their assessment (with the `compare.html` path), the steps 🧑, how to report. Several sprints: one after another under one hold.

Collect the findings in conversation. Each: action → what happened (and what should); place; weight `blocker` (does not work or breaks data, money or access, no workaround), `major` (wrong result in the usual scenario, a workaround exists) or `minor` (look, text, rare edge case); kind `bug`, `requirement` (a change of requirements) or `environment` (machine, JDK, external service, data). "Positive, no findings" is a result too.

## 4. Classes and deferred findings

Propose a class per bug from the report only (`dwmt header <report>`: criteria, risks, `deferred`, `ui`; its sections), the first that fits:
- `deferred`: the report listed it as deferred;
- `human`: it was a 🧑 step of a `human` risk;
- `plan`: no criterion or risk covered this behaviour;
- `ui-look`: a visible deviation from the mockup that the UI check missed or had no screenshot of;
- `ui-flow`: an interaction (keyboard, states, transitions) that screenshots cannot show;
- `test`: a deterministic test or guard would have caught it;
- `review`: a criterion or risk covered it, the review missed it, and a test would not catch it.

Before the write, one AskUserQuestion (none when there are no bugs and no deferred findings): the classes of all bugs (your proposal first, "(Recommended)") and which deferred findings of the report (`deferred` in its header) the user accepts without a fix; those go to `deferredAccepted` (their ids, e.g. `T-2/F-3`) in the same write as the result.

## 5. Record

Write the result once, with the Write tool, to `<main tree>/.dwmt/uat-result.json`: `{"result": "positive" | "defects", "findings": [{"text", "place", "weight", "kind", "class", "ref"}], "deferredAccepted": []}` (`class` only for bugs; `ref`: the report item it relates to, e.g. `T-1/R-3`). Then `dwmt uat record <sprint…> <file>` (`--late` for a late report); the same result for several sprints goes in one call.

Present in at most 6 lines:
- the entries and defects recorded (`U-n`, weight, class);
- `fix`: the fix sprint command, to run in its own worktree and a new session (`claude --effort high`), in a code block;
- `requirements`: requirement changes stay recorded in `uat.md` as input for the product owner's triage; nobody edits the project roadmap by hand;
- environment findings: noted in the record, no fix sprint;
- `intake`: backlog items the script added for the product owner's triage (product layer; then only blocker and major defects make the fix sprint, a minor alone goes to triage);
- `released` and `mergeWait`: sprints whose squash can go in now, with their `/dwmt:execute <run>` commands.

The user stops midway: `dwmt uat release` frees the hold (it also expires after `uat.holdMaxMin` minutes).
