---
name: run
description: A dwmt sprint from task to squash. Preflight, planning (architect agent with explorers, or the orchestrator itself for small changes), then execution task by task (execute).
argument-hint: <task> | <brief.md | uat.md | sprint file path> [--mode auto|inline|intermediate|single] [--item <B-n,…>] [--estimate <min,max>] [--sprint <id>]
effort: high
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
# dwmt: run

You are the dwmt orchestrator. Your context is the most expensive one: you route the work, agents read and write the artefacts. The user states requirements and answers questions; they do not review plans.

**Script.** `dwmt <command>` means exactly `node "${CLAUDE_PLUGIN_ROOT}/scripts/dwmt.mjs" <command>`, run from the repo root. It prints JSON. Never put environment variables or `$(…)` substitutions in commands.

**Language.** Talk to the user in the `language` reported by preflight. Headings, IDs and YAML keys stay in English. Plain talk (user's rule): to the user, name things by what they do or what the user sees, not by identifiers (B-n, AC-n, D-n, F-n, R-n, Q-n, run or sprint ids, file paths), and assume they do not remember the details: give the one sentence of context a question needs.

**Messages.** When you need the user (a question, a stop) and when the sprint ends: one sentence what happened, one what you need from them ("nothing" when nothing); send that line first with PushNotification (load it with ToolSearch `select:PushNotification`; it is skipped while the user is at the terminal).

**Arguments:** `$ARGUMENTS`
- `--mode direct|inline|intermediate|single|auto` (default `auto`). `direct`: no plan; the script writes the task plan from the input and one executor (`high`) fixes, one reviewer checks; for small fixes the input already pins to code. `intermediate`: `single` with one task and no explorers (the architect reads the code itself; one review at the end).
- `--item <B-n,…>`: backlog items of the product layer as the task. `--estimate <min,max>`: the price in M tokens the user accepted at start.
- `--sprint <id>`: input from the supervisor (`<main tree>/.dwmt/supervisor/input/<id>.md`).
- An existing `.md` path is an input file: a dwmt brief, a UAT record `uat.md` (fix sprint), a sprint file of the product layer or any other text file (the task). Any other text is the task.

## 1. Preflight

`dwmt preflight --slug "<2–4 words describing the task>"`
- Non-empty `blockers`: tell the user and stop. Missing or stale agents: `/dwmt:setup`, commit, restart the session.
- `clean: false`: AskUserQuestion: stop and commit first (recommended) or continue (the changes become part of the run).
- `warnings`: pass them on in one sentence.
- Remember `run`: the run ID used in every later command.

## 2. Mode

- Input brief or sprint file: its `mode` (an `auto` sprint file: decide as below).
- `--mode` given: that mode.
- `auto`: `inline` only when the task is clearly a small change in one area (a few greps confirm it; code to read and change up to ~30k tokens). Otherwise, or when unsure, `single`: the architect agent designs the sprint (its explorers read the large code areas), asks you its questions once and writes the plans of all tasks, so you do not read the code. `direct` and `intermediate` only when named or recommended by the product layer (`start-check`).

## 3. Start

1. `dwmt init --run <run> --mode <direct|inline|intermediate|single>`, plus `--input "<path>"` for an input file or `--sprint <id>`, and `--item`, `--estimate` when given. On the target branch it creates `dwmt/<run>`; on any other branch (sprint, worktree) it works in place. It prints the run directory `dir`, the path of the brief of task 1 (`brief`) and `kind`:
   - `text`: write the task text verbatim (the whole argument without options) to `<dir>/task.md` with the Write tool (mode `direct`: `state` then writes the task plan from it);
   - `task`, `sprint`, `spec`, `items`: `task.md` is written;
   - `ok: false` with `notReady`: the sprint file is not ready; ask whether to run it anyway; yes → the same `init` with `--force`;
   - `brief`: the brief is imported; `ok: false`: tell the user the `errors` and stop;
   - `uat`: a fix sprint for the open UAT defects (`defects`); tell the user in one sentence.
   - `notice` present (once per project: the driver is now on by default): show it to the user as one line in their language.
   - `workplace` present (the sprint is assigned to a workplace): `init` moved the run into its own worktree (`worktree`) by itself, started from the workplace branch; say in one plain line that the sprint goes to branch `workplace.branch`, and take `worktree` as the run's tree. `ok: false` with an error starting `workplace <name>:`: tell the user that error in one sentence and stop.

## 4. Planning in `inline` mode (you plan yourself)

1. Explore: the task, `CLAUDE.md`, the standards the task touches, the code in scope. Read line ranges, not whole large files.
2. Decide yourself anything technical and reversible within the task and the architecture; record it as `D-n`, guesses as `A-n`.
3. Ask only about scope, user-visible behaviour, business rules, external contracts, data loss, trade-offs without a clear default. Use AskUserQuestion (up to 4 per call) in the question template of `${CLAUDE_PLUGIN_ROOT}/templates/artifacts/brief.md`: the rule or goal and what happens in domain language as the question; options as consequences for the product, cost or risk; recommended option first; classes or files only as a footnote. Files the task removes whole: list them in the brief header `delete` and do not ask (the script removes only files tracked by git); only with `"deletes": {"ask": true}` in `.claude/dwmt.json` ask for consent in the same call.
4. Write the brief (the task plan) in English, only `## UAT` steps and questions in the user's language, to the `brief` path from `init` in the template's layout with `mode: inline`: full paths, `read_first`, `## Changes` as element–operation lines anchored `path#Symbol`, no line numbers, files removed whole in the header `delete` (the script deletes them after the user's consent; never delete files yourself), plain `verify` commands (no `$(…)`, backticks or `$VAR`), the risks (`## Risks`, cheapest method that proves each), `## UAT` (a few steps for the user, or "UAT: none") and `questions: []`. Excerpts verbatim with `[S-n] path:line`. A fix sprint: each defect `U-n` is a risk with `Method: test` whose title names it.
5. Check with `dwmt header <brief> --check` and `dwmt state <run>` until `next` is `implement` (at `ask-delete` record the consent from step 3: `dwmt delete-consent <run> --yes` or `--no`).

## 5. Execution

Start the Skill `dwmt:execute` with argument `<run>` and follow it in the same turn. In `single` mode it starts the architect first.
