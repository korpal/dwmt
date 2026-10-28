---
name: execute
description: Execute or resume a dwmt run (a sprint of one or more tasks) from the state in .dwmt/runs/<run>. Started by /dwmt:run, by the session of the previous task, by the supervisor, or manually after a break.
argument-hint: <run-id>
effort: high
allowed-tools: Bash(node:*)
---
# dwmt: execute

You drive run `$ARGUMENTS` to the end, or to the end of this session's part of it: a sprint of several tasks runs each task in a new session.

**Script.** `dwmt <command>` means exactly `node "${CLAUDE_PLUGIN_ROOT}/scripts/dwmt.mjs" <command>`, run from the repo root. It prints JSON. Never put environment variables or `$(…)` substitutions in commands. Talk to the user in the language of the config (`language` from preflight, or the language of the plan's `## UAT` steps); artefacts are in English.

## Rules

- Read only script output, headers (`dwmt header <file>`) and sections (`dwmt section <file> <ID>`). Do not read the brief, diff, results, reviews or test output. Exception: `inline` mode, where you plan and implement yourself.
- An agent gets exactly the `prompt` from `state`, nothing added.
- Wait for each agent's result before the next step. Never run an architect or executors in parallel; review units may run in parallel.
- Run `verify` and `finish` in the background (`run_in_background`) and wait for the result: they may wait in the machine queue behind another project's heavy commands (`queue`, `mergeWaitMs` in the output; say how long in the step sentence). Alongside, run `dwmt watch <run>` in the background too (no timeout): it ends silently with the command, or prints one line. "stopped without a result": run `state` and repeat the step. "hang suspected": ask the user before repeating it.
- After every step run `dwmt state <run>` again. After a break or compaction, start with `state` too.
- `tree` in `state` (the run lives in its own worktree, this session in another tree): before any step you do yourself with files, git or agents (a conflict, a red suite, the loop without the driver, `inline`), `cd <tree>` once; agents then start there. At the run's end `cd` back to where the session started, then the `cleanup.after` commands may run here on the user's yes; never close the session for them.
- Report to the user in one sentence per step: task ("task 2 of 5" when `tasks` > 1), round, what happened, result.
- Plain talk (user's rule): to the user, name things by what they do or what the user sees, never by identifiers (B-n, AC-n, D-n, F-n, R-n, Q-n, run or sprint ids, file paths); assume they do not remember the sprint's details and add the one sentence of context a question needs. Identifiers stay in commands and artefacts.
- When you need the user (a question, a stop) and when the sprint ends: one sentence what happened, one what you need from them ("nothing" when nothing); send that line first with PushNotification (load it with ToolSearch `select:PushNotification`; it is skipped while the user is at the terminal).
- Frame every question in terms of behaviour, capabilities, business rules and architecture; name classes or tests only as a footnote.

## Driver mode

When `state` returns `drive: true` and you are not handling a stop of the driver, a script runs the loop below; do not run it yourself. Start it with `node "${CLAUDE_PLUGIN_ROOT}/scripts/drive.mjs" <run> --detach`, then run `dwmt wait <run> --progress` in the background (`run_in_background`, no timeout). `wait` prints one JSON line `{status, reason}` at a checkpoint or when the run needs you:
- `progress`: say `reason` to the user as one plain line in the user's language (task as "task 2 of 5", the English title in plain words, cost kept), nothing else; with `push: true` (the cost passed the upper price; the sprint goes on) also push that line as in the message rule above; run `dwmt wait <run> --progress` in the background again;
- the user asks for the status meanwhile: `dwmt drive-log <run>`, answer in one sentence; the `wait` keeps running;
- `done`: go to **`done`** below (`finish` in the line is the output of `finish`; for `squashed`, its `cleanup` question as in `finish` below comes after the summary; with `finish.push`, the "gotowe do wypchnięcia" line and `push.cmd` in a code block as in `finish` below come right after the summary, before the `cleanup` question; never run it);
- `waiting-user`: run `dwmt state <run>` and handle that one step with the rules below (questions, rounds, red suite, conflict, environment; for a `finish` stop, `finish` in the line is its output: do not run it again first; `repair interrupted` in `reason`: tell the user what it undid or stashed, then handle the red suite or conflict as below), then start the driver again (under a supervisor, then end);
- `hang`: tell the user `reason` and ask whether to keep waiting (`dwmt wait <run> --progress` again) or stop the command (`dwmt stop <run>`, then `dwmt wait <run> --progress`);
- `stopped` (e.g. an agent or a command ended without a result), `dead` (the driver itself died), `hold`, `not-running`: nothing is retried; tell the user `reason` in one sentence (a subscription limit: the reset time and `/dwmt:execute <run>`). A session started for a supervisor's stop, `hold` and a limit: end. Otherwise ask (AskUserQuestion, why first): resume the driver (`dwmt drive-mode <run> on`, start it again, same step; recommended when the cause is outside dwmt, e.g. memory or a killed process), finish without the driver in this session (`dwmt drive-mode <run> off`, then the loop below from `state`; recommended for a `driver-error`, which is a dwmt bug), or stop here (`/dwmt:execute <run>` later);
- `wait` ended without a line (e.g. killed): run it again.

## Loop

`dwmt state <run>` returns `next`, `task`, `tasks`, `dir` (the task's directory: brief, results, reviews, tests), `round`, `agent`, `key`, `prompt`, `output`, `hint`. First:

- **`limit`** in the output: the last agent hit the subscription limit and returned the limit text instead of a result. Do not treat it as a result. Tell the user the reset time (`limit.resetsAt`, local time) and `/dwmt:execute <run>` for after it; end. Under a supervisor the loop resumes.
- **`second`** in the output (once): the architect found that this is two sprints; tell the user in one sentence (the plan covers the first; `second` describes the next one) and go on.
- **`priceNote`** in the output (once): the design price that needed no question; add it to the step sentence.
- `autofixed` (the script copied contracts and decisions from the sprint plan or expanded paths in task plans), `stoppedSessions` (background sessions of earlier tasks stopped) and `deleted` (files the script removed with the user's consent) need no action; do not mention them unless asked.

Then act on `next`:

- **`plan` or `replan` with `agent` (`dwmt-architect`; in runs from before v2.7 the same agent under the keys `planner`, `planner-T<k>`):**
  - `fresh: true`, or no agent with this `key` is known in this session: Agent tool, `subagent_type` = `agent`, `description` = `dwmt <next> <key>`, `prompt` = `prompt`. Remember the agent ID under its `key`;
  - otherwise (after answers or errors, in the session that started it): send `prompt` to that same agent with SendMessage (load it with ToolSearch `select:SendMessage`), so it keeps its exploration and its explorers. If SendMessage fails, start a new one as above;
  - the architect starts its explorers itself; you never talk to them;
  - `plan` returned: `dwmt header <output>` and one sentence: goal, number of tasks, counts of criteria, risks and open questions;
  - `replan` returned (task `from` with drift `causes`): its reply ends with `REPLAN: changed|unchanged <tasks>; cause: <class>`. Run `dwmt replan-done <run> <from> --result <changed|unchanged> --cause <class>`; with `ok: false` run `state` (it sends the errors to the same architect). One sentence: causes and result. A question about changing the sprint's goal or criteria: ask whether to continue or stop; stop leaves the branch for the user (under a supervisor `dwmt status <run> stopped --reason "<why>"`).
- **`plan` without `agent`:** show `hint`. `inline`: plan yourself per `/dwmt:run` step 4. Missing `task.md` and brief: ask for `/dwmt:run`. Stop.
- **`ask-plan`:** the plan or a brief (`file`) has open questions.
  - For each `Q-n` in `questions`: `dwmt section <file> Q-n`. Ask via AskUserQuestion, up to 4 per call: the rule or goal and what happens as the question, the options as consequences, recommended option first with "(Recommended)", the technical note only as a footnote in the option descriptions.
  - With `delete` in the output: in the same AskUserQuestion call ask whether to delete these files or keep them (their criterion stays unmet); then `dwmt delete-consent <run> --yes` or `--no`.
  - `Q-price` in `questions` (the price gate) has no section: ask it in the same call from `price` (its text as the question, its options, `continue` recommended); record it as `### Q-price` whose first line is `continue`, `shrink: <what to leave out>` or `stop`.
  - Append each answer to the `answers` file (create it with Write, extend it with Edit): `### Q-n <title>` and the answer, in the user's words where they gave any.
  - Then `state` again: it returns `plan` (or `replan`) for the architect to record the answers.
- **`stopped`** (`reason: price`): the user stopped the sprint at the price question; the branch stays, items and sprint file are unchanged. Tell the user in one sentence and end.
- **`ask-delete`:** plans written after the question turn delete the `files` (executors never delete files). Ask once via AskUserQuestion: delete them, or keep them (their criterion stays unmet); then `dwmt delete-consent <run> --yes` or `--no`, and `state`.
- **`implement`, `fix`, `continue`, `repair`, `batch` with `agent`:**
  - Agent tool: `subagent_type` = `agent`, `description` = `dwmt <next> r<round>`, `prompt` = `prompt`;
  - when it returns: `dwmt header <output>`;
  - "Agent type not found": agents are not loaded. Ask for `/dwmt:setup` and a session restart, then `/dwmt:execute <run>`. Stop.
- **`implement` and `fix` without `agent` (`inline`):** implement yourself from the brief.
  - For `fix`, fix the items on the `fix` list in the header of `<dir>/review-<round-1>.md` (`dwmt section <file> F-n`).
  - Behavioural item: first a test that is red on the current code, then the fix. A brief risk with `Method: test` gets a test that would fail if the invariant broke; `Method: ui` gets an e2e test that captures its `Shot`.
  - Targeted tests only. Do not commit.
  - Then `dwmt verify <run>`.
- **`repair` without `agent` (`inline`):** make the red tests in `<dir>/tests.md` green yourself without weakening them, then `dwmt verify <run>`.
- **`ask`:** the executor reported BLOCKED with questions only (a wrong plan, `planIssue`, goes to the architect as `replan`).
  - For each `Q-n` run `dwmt section <file> Q-n` and ask via AskUserQuestion as in `ask-plan`.
  - Add each answer as `### D-n` under `## Decisions` in `<dir>/brief.md` (in the fix batch, `batch: true`: `<dir>/batch.md`, adding the section if missing) with Edit, then `dwmt unblock <run>`.
  - A `planIssue` that changes the goal or the criteria: ask whether to continue with the new decision or stop and start a new run (the branch stays).
  - With `escalate` (mode `direct`, no plan): the work is bigger than a direct fix. Tell the user why in one plain sentence and ask: leave this run (the executor changed nothing; its branch can go) and start the same items with the architect (recommended), or answer and `unblock`.
- **`verify`:** `dwmt verify <run>`. With `repair: true` (red for the first time this round) run `state`: the executor gets the red tests once before the review. Otherwise `dwmt review-input <run>`; tests still red go to the review, which judges them. A command marked `(flaky)` was red, then green on a rerun. `expectedRed`: the red commands are the plan's expected reds or reds the executor attributed to another cause; no repair, the review checks the claims (say so in the step sentence).
  - `result: plan`: the task plan's header is broken; nothing ran. Run `state`: it sends the plan to the architect.
  - `envUp`: the script started the environment itself (`env.checks[].up`); mention it in the step sentence.
  - `result: env`: the environment is not ready (e.g. compose is down) even after `up`; nothing ran and it is not a red test. Show `env` to the user and ask them to prepare it (AskUserQuestion: ready, or stop here), then `verify` again.
  - `ui` in the output (screens for UI risks): a missing screenshot is a red test, so the review sends it back to the executor. `renderErrors`: tell the user in one sentence that a mockup did not render (check `ui.playwright` in `.claude/dwmt.json`, or the network); the run goes on.
  - `status: conflict` (`git.rebase: review`): show the files and ask whether to resolve in the session (`git rebase <target>`, resolve, `git rebase --continue`, then `verify` again) or leave the branch.
  - With `closing: true` (the whole list once more before the commit, because the tree changed since the last whole run): run `state`; no `review-input`.
- **`review`:**
  - with `units`: one Agent per entry, `subagent_type` = its `agent` (`dwmt-reviewer`, or `dwmt-ui-verifier` for screens), with its `prompt`, `description` = `dwmt review r<round> <unit>`; they may run in parallel. When all have returned, `state` merges them into one review;
  - otherwise one Agent of type `agent` (`dwmt-reviewer`, or `dwmt-reviewer-high` for a change without code) with `prompt`;
  - then `dwmt header <dir>/review-<round>.md` and give the verdict, counts and unproven risks in one sentence.
- **`ask-rounds`:** the round limit is reached and the verdict is still FIX. AskUserQuestion:
  - another round: `dwmt extend <run>` (recommended when a blocker is open);
  - accept with open findings: `dwmt commit <run> --accept`;
  - stop: the branch stays for manual work.
  - With `closingRed: true` (the whole list is still red after the round's repair): ask accept with the red (`dwmt commit <run> --accept`) or stop; no extra round.
- **`planned`:** the plan is ready; implementation waits until the sprints in `waitingFor` are merged. Tell the user in one sentence and end; the supervisor loop resumes it.
- **`batch: true`** in the output (v2.8, after the last task's commit, before `goal-check`): the fix batch, one round of fixes for the findings the task reviews moved to it (`items`, `<dir>/batch.md`). `batch` starts the fixer (`dwmt-executor-high`); then `verify`, `review` (a re-check), `ask-rounds` and `commit` work as in a task, on the batch. In the step sentence say "fix batch" with the round and the number of items. `commit` output with `open`: those items stay open (deferred) in the report.
- **`goal-check`:** before `finish`: one Agent `dwmt-checker` with `prompt`, `description` = `dwmt goal check`; then `dwmt header <output>` and one sentence: delivered, out and gap items. Gaps do not block: they go to the report and the UAT list.
- **`commit`:** `dwmt commit <run>`. With `next: handoff` in the output (task k of N committed, `report`), run `state`. `--accept` with `next: verify`: run `state` (the closing verify), then commit.
- **`handoff`:** task `task` is committed; the next task runs in a new session, with a fresh context.
  - Under a supervisor: end; the loop starts the next session.
  - Otherwise: `dwmt launch <run>` starts it in the background in this tree. Give the user `claude attach <id>` in a code block and end. The new session stops the background sessions of earlier tasks itself; this session, when the user started it, they close themselves. If `launch` fails: tell the user to run `/clear`, then `/dwmt:execute <run>`.
- **`finish`:** `dwmt finish <run>`: the deferred-majors check, rebase onto the target (per `git.rebase`), full suite, report, squash or `leave`. By `status`:
  - `deferred-major`: review findings of severity major or blocker stayed deferred after the fix batch; nothing was rebased or merged. Show the `majors` list and ask (AskUserQuestion, why first): accept them and merge (the user runs `dwmt finish <run> --accept-deferred`; the acceptance is recorded and marked in the report; if the harness blocks it, give the exact command to run with `!`, as for `--accept-red`), or fix them before the merge: the user (or you, in the session) fixes them on the run branch and commits, then `dwmt finish <run> --fixed-deferred`; the report lists them as fixed by the user and not re-reviewed, not as accepted (it refuses without a new commit since the stop); or leave the branch unmerged for now (`/dwmt:execute <run>` later asks again). A later `finish` stops only for majors not yet accepted or fixed;
  - `conflict`: show the files. Ask whether to resolve in the session (`git rebase <target>`, resolve, `git rebase --continue`, then `finish` again) or leave the branch;
  - `red`: the full suite is red. `dwmt header <tests>` and ask: fix in the session (fix, `git commit` on the run branch, `finish` again, which reruns only the red commands); accept the red for a stated reason, e.g. it is red on the target too (`dwmt finish <run> --accept-red`); or leave the branch. Never merge by hand. If the harness blocks `--accept-red` the user chose (auto mode sees it as bypassing tests), give the user the exact command to run with `!`, with the absolute script path. When a fix shows a defect the review missed, ask whether that check should run in every round (add its command to `verify.targeted` in `.claude/dwmt.json`): only guards keep defects from coming back;
  - `env`: as for `verify` (show `env`, ask the user to prepare it), then `finish` again;
  - `merge-wait`: the suite passed, but the squash cannot go in now: `reason` `uat` (the user's UAT holds merges into the target branch) or `target-dirty` (`files` changed in the target tree, or the main tree stands on another branch). Not a failure; the merge lock is released. Under a supervisor: end. Otherwise tell the user the reason and files in one sentence and give `/dwmt:execute <run>` for later (then `finish` squashes without the full suite if the target has not moved); end;
  - `squash-failed`: show `hint`, ask the user to remove the cause (e.g. a pre-commit hook), then `finish` again;
  - `squashed` or `left`: go to `done`. For `squashed` with `cleanup.now`, ask via AskUserQuestion whether to delete the run branch (`dwmt finish <run> --cleanup`). With `cleanup.now: false`: when `cleanup.at` is this session's tree, do not ask: give the user the `cleanup.after` commands in a code block, to run after closing this session; when it is another tree (the run's own worktree, e.g. you are the PO session in the main tree), ask the same question in plain words (remove the sprint's working copy and branch; its files are kept in the main tree) and on yes run `dwmt finish <run> --cleanup`. For `squashed` with `push` (the workplace branch has all its sprints done): one plain line "gotowe do wypchnięcia: gałąź <push.branch>, <push.n> sprintów" in the user's language and `push.cmd` in a code block; never run it.
- **`done`:** `dwmt header <report>` (`report` from `finish`; later: `final-report.md` in the run directory `.dwmt/runs/<run>/`). Present at most 8 lines:
  - status and criteria;
  - decisions and assumptions the user did not choose (ids, one line);
  - risks: proven, left for the user (`human`), unproven or accepted;
  - tests and rounds, with flaky commands and changed `verify` commands (`verifyChanged`) when present;
  - deferred findings and `missed`, with the file that collects deferred findings (`deferred` from `finish`; with the product layer there is no file: the deferred findings are the backlog items from `intake`), and the majors the user accepted (`acceptedDeferred`); the fix batch (`batch` in the header): items by reason and result, task fix rounds avoided;
  - commit and the path of `final-report.md` (it holds the contract and the risk coverage table);
  - screens: the `ui` path from the header (mockup next to screenshot), when present;
  - cost: `cost.total` and `cost.byRole` from the header (at report time); with `price` in the header also the design price and `estOverhead`;
  - tasks (`tasks`, `coverage`, `replans`) when there are several: status per task and any criterion that is not met;
  - goal check: `gaps` with the elements of the input that are neither delivered nor excluded (`## Goal check` in the report);
  - `intake` from `finish`: backlog items and register candidates added for the product owner, and `synced`, the roadmap changes the sync made in the same product commit (e.g. `kf1 ordered → done`), shown in one line (a `warning` there never stops the sprint; nor does a `sync:` line in `intake.warnings`, which means the product owner runs `dwmt product sync`).

  Then:
  - `uat: pending`: tell the user the sprint waits for their UAT: `/dwmt:uat <sprint or run>` in any session of the project, when they can (the `## UAT` section of the report is the checklist);
  - a fix sprint (`ratchet` in the header): ask via AskUserQuestion which reproducing tests should run in every round (defects of classes `test` and `human` are the first candidates); add the chosen commands to `verify.targeted` in `.claude/dwmt.json` of the main tree and give the user the commit command.

  End.
