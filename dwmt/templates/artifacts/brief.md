---
schema: dwmt/brief@1    # task plan: the brief header, so review-input, validation, status and the report keep working; a design skeleton of at most `plan.taskPlanMaxKB` (10 KB), no code
run: <run-id>
task: T-<k>
goal: "<what this task delivers, one sentence>"
mode: single            # inline | single
acceptance: ["AC-1", "AC-2 (part: <this task's part of a shared sprint AC>)"]   # with a sprint plan: ids, the text stays there; without one: "AC-1 <checkable criterion>"
scope: ["<globs: the files this task may change, full paths from the repo root>"]
read_first: ["<path#Symbol the executor reads before changing>", "<path of a precedent>"]   # full paths, no line numbers
verify: ["<targeted test command>", "<guard command a risk relies on>"]   # plain commands: no $( ), backticks or $VAR; complex logic goes into a script in the repo
delete: []             # files this task removes whole, full paths from the repo root; the script deletes them after the user's consent (executors never delete files)
expectedRed: []         # a verify command this task knowingly leaves red: ["<command exactly as in verify>: <why; which T-j turns it green>"]
risks: [R-1, R-2]
areas: {<area>: ["<globs>"]}   # optional; code reviewed together, a cross-cutting flow is one area
shared: []              # sprint of one task under a supervisor: files shared with other sprints of the order
decisions: [D-1]
questions: []           # Q-n still open for the user; empty when the plan is final
---
# <goal>

## Context
<why, and what already exists, as capabilities and elements (`path#Symbol`); 3–6 lines; no abbreviations of paths>

## Contracts
### C-1 <contract this task creates or uses>
<a contract of the sprint plan: the heading alone, no body; the executor gets its text from the sprint plan>

## Changes
<each entry 1–2 lines (at most 400 characters): what and where, who calls whom; how to build it is the executor's; a parameter only when it is a product decision or a contract>
- [new <term from the vocabulary>] `<Name>(<signature>)` in `<full file path>` — responsible for <…>, called by `<path#Symbol>`; pattern: `<path#Symbol>`; not: <alternative>, because <…>; test first: <case with values>
- [change] `<path#Symbol>` — <operation in domain terms>; test first: <input → expected result, with values (a number, "a string" or `a literal`), red before the change; every code file but tests>
- [remove] `<path#Symbol>` — <why; what replaces it>
- [sweep] `<glob>` — <one rule applied to every hit: what replaces what, what stays>; check: `<regex (one line) that finds what is left>`
<[sweep] for mechanical work across many files (a removed field, a cast pattern): a rule, not a list of lines that ages before the task starts>
<a named pattern without a precedent in the code: 2–4 numbered steps indented under its entry, each at most 200 characters>

## Decisions
### D-1 <title>
<a D-n of this task only: decision and reason; a D-n of the sprint plan: the heading alone, no body>
<replan only: a small user-visible detail settled without the user is `### D-n [visible] <title in the user's language>` with the reason; it goes to the UAT list>

## Assumptions
- A-1 <assumption the user can correct>

## Risks
### R-1 [critical|high|medium|low] <invariant or harm, in domain terms>
- Method: guard <command> | test <case tied to AC-n or C-n> | investigate | human <steps or command for the user> | accepted | ui
- Area: <area>

### R-2 [medium] <screen this task changes> matches the agreed mockup <id, variant>
- Method: ui
- Mockup: <path/to/mockup.html or .png>
- Mockup-state: <JS run in the mockup page to show the variant and state; omit when the default is right>
- Shot: <screenshot name the e2e test of this task captures>
- Area: <area>

## Out of scope
- <what this task must not do, and which task does it>

## UAT
<only without a sprint plan (inline mode or an imported plan): only steps a human must check, in the user's language, screen → action → expected result, each ending with the `human`/`ui` risk or `[human]` criterion it checks; or "UAT: none"; rules 2.12 reject a step without the reference>
1. <screen> → <action> → <expected result> (R-2)

## Questions
<only without a sprint plan, or when a replan needs the user>
### Q-1 <short title>
- Why I ask: <the principle or product goal at stake, and what the answer changes>
- What happens: <the situation, in domain language>
- Options: <A: consequence for product, cost or risk>; <B: …>
- Recommendation: <option and why>
- Technical note: <classes, files; last>

## Standards and docs excerpts
- [S-1] `<doc path>` — "<verbatim excerpt from an ADR, a standard or CLAUDE.md; never code>"
