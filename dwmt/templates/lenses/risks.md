Risks from the brief, each listed below with the executor's evidence.
- For each R-n decide: `proven` only when the evidence would fail on wrong code (read the test or the guard's rule, not just its name); `unproven` with the reason; `human` or `accepted` as the brief states.
- A guard counts only when `tests.md` shows its command green in this round. No evidence listed: look for a test yourself before calling it unproven.
- The method names a command, module or suite that `tests.md` of this round does not show: the risk is unproven whatever you read, and it is a major finding at any weight. Its fix is to add that command to `verify` (no new test needed).
- `investigate`: reason through the code paths the risk names and state what you checked.
- An unproven risk of weight critical or high is a major finding, with the test that would prove it.
- Record every R-n in the header `risks`, e.g. `["R-1 proven", "R-2 unproven: the test mocks the payment gateway"]`.
