---
schema: dwmt/plan@1
run: <run-id>
goal: "<sprint goal in one sentence>"
acceptance: ["AC-1 <checkable criterion of the sprint>", "AC-2 <…>"]
tasks: [T-1, T-2]       # in order of execution; each task up to ~90k tokens of code to read and change
scope: ["src/<area>/**"]
shared: []              # files shared with other sprints of the order (API contract, migrations); only when the prompt lists the order
decisions: [D-1]
questions: []           # Q-n still open for the user; all the sprint's questions at once, before the design in depth
delete: []              # files the sprint removes whole, full paths from the repo root; listed with the questions: the user consents in that turn
# files: [3, 8]         # only when the prompt names the price gate: changed code files expected (source and tests), written with the questions
# questionsRound: 2     # only for a second batch of questions found in the round for the plan
# second: "size: <one paragraph: the second sprint>"   # only when this is really two sprints (size: too large; decision: needs a product decision); then plan only the first
---
# <sprint goal>

## Context
<why, and what already exists, as capabilities and elements; 3–6 lines>

## Design
<3–8 lines at capability level for the user: contexts and slices touched, their relations and integration style, ownership of data, consistency choices, the main trade-off; no classes>

## Input coverage
- <element of the input: a sentence of the task, a roadmap item, a mockup element, an answer> → AC-1
- <element> → AC-2, AC-3
- <element> → out: <why it is not in this sprint>

## Decisions
### D-1 <title>
<decision and reason>

## Assumptions
- A-1 <assumption the user can correct>

## Contracts
### C-1 <contract between tasks: API, data schema, event, extension point>
<exact shape both tasks rely on, signatures by symbol `path#Symbol`>

## Tasks
<each task plan names these criteria by id in its `acceptance` (a shared one as `AC-n (part: …)`), the sprint's D-n and C-n by heading alone, and stays under `plan.taskPlanMaxKB` (10 KB)>
### T-1 <title>
- Goal: <what this task delivers>
- Acceptance: AC-1, AC-2 (part: <which part, when an AC is shared>)
- Scope: <globs>
- Contracts: C-1
- Depends: none

### T-2 <title>
- Goal: <…>
- Acceptance: AC-2 (part: <…>)
- Scope: <globs>
- Contracts: C-1
- Depends: T-1

## UAT
<!-- only what a human must check (judgement, decision, screen); each step ends with (R-n): a human or ui risk of the task's plan, or (AC-n): a criterion marked [human]; outside a ### T-k group (T-k/R-n); rules 2.12 reject a step without it -->
### T-1 <title>
1. <screen> → <action> → <expected result, in the user's language> (R-2)

### T-2 <title>
1. <…> (AC-3)

<!-- or a single line "UAT: none" when nothing needs a human: what tests prove is no UAT step -->

## Questions
### Q-1 <short title>
- Why I ask: <the principle or product goal at stake, and what the answer changes>
- What happens: <the situation, in domain language>
- Options: <A: consequence for product, cost or risk>; <B: …>
- Recommendation: <option and why>
- Affects: <sprints of the order it may concern | none | uncertain>   (only when the prompt lists the order)
- Technical note: <classes, files; last>

## Standards and docs excerpts
- [S-1] `<doc path>` — "<verbatim excerpt from an ADR or standard>"
