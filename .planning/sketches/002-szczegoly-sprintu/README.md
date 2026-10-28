---
sketch: 002
name: szczegoly-sprintu
question: "How to show a sprint to a human on click without losing the board?"
winner: "B"
tags: [detail, panel, human-section]
---

# Sketch 002: Szczegóły sprintu

## Design Question
Where the sprint detail opens (side panel, centred card, separate page) and what a human-friendly panel contains instead of the agent's sprint file.

## How to View
Build data (`python ../data/build-data.py [project-root]`), open `index.html`, click a card on the board.

## Variants
- **A: Side panel** — board stays visible; "From you" on top, then why / what changes / not included, then queue, scale, mockups, decisions; technical details collapsed.
- **B: Centred card (Jira issue view)** — two columns: human content left, facts right.
- **C: Separate page** — breadcrumb back, previous/next in queue, technical details open.

## Panel content
- Written by the PO (proposed `## For you` section in the sprint file, user's language, not given to agents): title, why, what changes, not included, how to check (UAT).
- Computed by the script (0 tokens): from you (readiness gaps, run, UAT), queue position and "must be done first", scale (start price, closed analogies), mockup links, decision titles, result for merged sprints.
- Fallback when the PO section is missing: goal and acceptance from the agent file without IDs, marked EN.
- Sketch stand-ins: human texts in the optional `data/human.js` (sprint id → title, why, changes, not included, check); "to do" = sprint file with acceptance criteria; analogies = same kind, nearest item count (the real view uses the product analogy rules).

## What to Look For
- Can you decide "take it / not yet" from the panel without the technical part?
- Is "From you" the right first thing?
- Fallback (sprints without a PO text): acceptable until the PO writes the section?
