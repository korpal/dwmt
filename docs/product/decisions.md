# dwmt/decisions@1 — active decisions, one section each (≤ 8 lines); superseded ones in decisions-archive.md

### PD-1 Major deferred findings: fix batch first
area: review; at: 2026-10-22; src: -; by: po
Decision: Major deferred review findings go to the fix batch first; the run asks the user only about those the batch did not close.
Against recommendation: no

### PD-2 No owner for deferred findings without the product layer
area: review; at: 2026-10-22; src: -; by: po
Decision: Without the product layer, deferred findings have no owner field; they are simply deferred remarks in the roadmap.
Against recommendation: no

### PD-3 UAT closes itself without human steps
area: uat; at: 2026-10-24; src: -; by: po
Decision: A sprint whose UAT has no step needing a human (judgement, decision, screen) records UAT as passed at finish; late defects stay possible
Why: UAT queue grew with steps that only repeat tests
Against recommendation: no

### PD-4 Start price stays per changed file
area: price; at: 2026-10-24; src: -; by: po
Decision: The start price is computed per changed code file; changed lines are shown only in history
Why: the file count is known before start, the line count is not
Against recommendation: no

### PD-5 Known red expires after 7 days
area: verify; at: 2026-10-24; src: -; by: po
Decision: An accepted red test gets a 7-day expiry and an owner backlog item; after expiry it blocks finish again
Why: sprints run daily; longer lets red settle in
Against recommendation: no

### PD-6 Workplaces shown as a badge on board cards with a workplace filter
area: view; at: 2026-10-26; src: .planning/sketches/006-miejsca-pracy; by: po
Decision: K7 page view follows sketch 006 variant C: each workplace sprint card carries a coloured badge with its position (e.g. platnosci · 2 z 3); a switcher under the tabs filters the board to one workplace and shows its git facts (branch, ahead/behind, pushed, uncommitted) and the push box; with "all" a compact strip shows one row of facts per workplace
Why: smallest change to today's page; the board stays the only screen
Rejected: A own "Miejsca pracy" tab (recommended by the PO session), B workplace swimlanes on the board
Against recommendation: yes — the session recommended A with C's badge

### PD-7 Stacked target branches; a dependency is met when its sprint is done on its branch
area: git; at: 2026-10-26; src: run 2026-10-26-k7 Q-1; by: po
Decision: A target branch may be created from another target branch (stacked pull requests). A sprint depending on a sprint of another target branch waits by default until that sprint is done (committed on its target branch); the external review or merge into develop never holds it; the user may order it to start earlier and the driver and supervisor do not block that
Why: sequential sprints going as separate pull requests must not wait for the team's review of the first one
Rejected: PO refuses cross-branch dependencies; dependency only warns on the page
Against recommendation: yes — the architect recommended refusing such assignments
