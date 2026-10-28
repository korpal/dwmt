---
sketch: 005
name: podglad-sprintu
question: "Where and how does the decision-maker watch a running sprint live on the product page?"
winner: null
tags: [live, sprint, progress, cost]
---

# Sketch 005: Podgląd sprintu na żywo

## Design Question
Where the live view of a running sprint sits on the product page and what it shows, so the user can see what is happening without asking the PO (each question to the PO is a paid turn).

## How to View
Open `index.html` (file:// works; the sketch links the real `dwmt/templates/view/view.css`). Sketch bar: variant and situation. URL params `?v=A|B|C&s=work|ask|red|stall|stale&freeze=1` (freeze stops the simulated ticking, for screenshots). Sample data is invented (neutral shop project), not project content.

## Variants
- **A: Na karcie sprintu**: the board card in "In progress" gets a live dot, per-task progress segments, current step and spent vs price; clicking opens the existing centred sprint card with a live section: steps, activity feed, From you, Time, Cost.
- **B: Pasek „Teraz”**: a strip under the header on every tab (live dot, current step, segments, spent vs price, elapsed, From you), expandable to a panel with a time bar (Gantt), steps, cost and feed; the board stays below.
- **C: Zakładka „Na żywo”**: own first tab with KPI tiles (now / spent / elapsed / from you), the step list with the activity feed nested under the current step, important events on the side; several running sprints stack as sections.

## Situations
Work in progress; question waiting for the user (task paused); red tests in a task (normal step, nothing from the user); stall (nothing alive for 34 min, PO alarmed); stale data (page got no new data for 3 min: computer asleep or writer ended).

## Data behind it (0 tokens, all existing)
Run state and plan (steps, task titles, commits), event log (task start/end, question waiting, red command, stall), `watch` liveness, session transcripts (cost so far by role; last tool calls for the feed: reads, edits, commands), start price and naive forecast (`price-alert`), questions (already in the user's language). Live delivery without a server: the page polls a small data file written next to it every few seconds.

## What to Look For
- Which placement do you reach for first: card (A), strip on every tab (B), own tab (C)?
- Activity feed: is file-level detail ("Recenzent czyta X") useful, or are important events enough?
- End-time forecast from task pace: helpful or misleading?
- Is "From you" clear enough when a question waits?
