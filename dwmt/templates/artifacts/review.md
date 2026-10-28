---
schema: dwmt/review@1
round: 1
passes: [risks, correctness, pragmatism]
verdict: FIX            # PASS | FIX
counts: {blocker: 0, major: 1, minor: 0}
fix: [F-1]
defer: []
drop: []
visible: [F-1]         # findings a user would notice in the running app (screen, behaviour, message, data shown)
acceptance: ["AC-1 met"]
risks: ["R-1 unproven: the test never reaches the payment branch"]
missed: []              # re-review: new findings in code the fix did not touch
---
## risks
### F-1 [major] [floor: wrong-results] <title>
- Evidence: `<file>:<line>`
- Impact: <…>
- Test: <scenario or test idea that shows it>

## pragmatism
- F-1: fix — <reason>
