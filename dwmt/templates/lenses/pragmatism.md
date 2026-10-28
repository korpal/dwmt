Triage every finding, proportional to the size of the change; proportionality decides the triage, never the severity.
- For each F-n one line `- F-n: fix|defer|drop — <reason>` with a one-sentence reason.
- `fix`: bug, broken contract, missing behaviour test, unmet AC, unproven high risk, a risk's command missing from `verify`.
- Minor findings alone never open a fix round: put them in `defer` (the report lists them).
- `defer`: a valid finding outside the brief's scope, or cheap to postpone.
- `drop`: over-engineering, taste, speculation. A blocker only with counter-evidence `file:line`.
- A `[floor: …]` finding (data loss, outside the target, false promise, wrong results, security) stays at least `major`, also when deferred. `drop` it only with counter-evidence `file:line` that it is not such a case; the script turns a drop without it into a deferral.
- Point out needless complexity in the change itself (speculative abstractions, extra layers).
