---
sketch: 003
name: backlog-i-decyzje
question: "How to browse hundreds of backlog items and dozens of decisions?"
winner: "B"
tags: [backlog, decisions, filters, table]
---

# Sketch 003: Backlog i decyzje

## Design Question
How the decision-maker browses the open backlog (and closed items on demand) and the decision register: flat filterable table or groups with counts.

## How to View
Build data, open `index.html`; switch Backlog / Decyzje with the app tabs, variants with the dark bar.

## Variants
- **A: Table with filters (Jira backlog)** — search, type chips with counts, triage and severity selects, "show closed"; sortable columns; decisions as a table with area chips and "only against recommendation".
- **B: Groups with counts (GitHub Projects)** — group by triage / sprint / type / severity, collapsible groups with a type-mix bar; decisions grouped by area.

Both: row → centred card (002 winner) with human field names; sprint chips open the sprint card.

## Human vocabulary
Triage: to triage (new) / in sprint X / on touch / later / never; state: open / planned / done / dropped; severity: blocker / major / minor. Content stays English until the translation memory exists (one note on top instead of per-row badges).

## Finding from an earlier product layer
Dozens of open items were assigned to sprints that were already closed: neither done nor returned to triage. The view flags them with ⚠; the cause is a dwmt sync gap to check.

## What to Look For
- Can you find "what's new to triage" and "what's assigned to the next sprint" in a few seconds?
- Table density vs. groups: which one do you scan faster?
