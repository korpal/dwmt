---
schema: dwmt/result@1
status: DONE            # DONE | PARTIAL | BLOCKED
testsRun: [{cmd: "<command>", result: passed}]   # a command with backslashes: in single quotes or with /
evidence: ["R-1 <test file> › <test name>"]   # a test per brief risk with Method: test
changedContracts: []   # "C-1 as planned", or "path#Symbol: what changed" for a public API change outside the plan
outOfScopeChanges: []   # "<path>: <reason>", path first; the script's scope check reads the paths
assumptions: []         # A-n
questions: []           # Q-n when BLOCKED
planIssue: null        # BLOCKED: what in the plan is wrong (the architect corrects the plan)
laterNotes: []         # anchored facts found beyond your plan: ["path#Symbol: …"] or ["C-1: …"]; "[plan] …" only when later work as designed cannot hold
fixed: []               # fix mode: [{id: F-1, redTest: "<test red before the fix>"}]
notReproduced: []       # fix mode: ["F-2: <reason>"]
unrelatedRed: []        # a red verify command this change did not cause: ["<command exactly as in verify>: <why>"] (result or repair)
---
## Reasons
- <briefly, what and why>

### Q-1 <question, only when BLOCKED>
