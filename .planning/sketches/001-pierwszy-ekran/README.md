---
sketch: 001
name: pierwszy-ekran
question: "Which first-screen layout says 'where are we and what's next' fastest?"
winner: "B2"
tags: [layout, roadmap, dashboard]
---

# Sketch 001: Pierwszy ekran

## Design Question
Which layout of the roadmap screen tells the decision-maker fastest what runs now, what comes next, what waits for what, and what waits for their UAT.

## How to View
Build data first (`python ../data/build-data.py`, by default from this repo's `docs/product/`), then open `index.html` (or `http://127.0.0.1:8765/001-pierwszy-ekran/index.html`).

## Variants
- **A: Tiles + queue (GitHub Projects)** — four tiles (now, next in queue, awaiting your UAT, last 7 days) and the full queue as a table with group-by and filter.
- **B: State board (Jira)** — columns topic → notes → ready → ordered → running → awaiting UAT; cards keep the queue position (#n).
- **C: Dependency map (Delivery Plans)** — columns by dependency depth (closed deps → can start → after 1 sprint …) with arrows; UAT as a strip on top.

All variants: click a sprint → side panel with details (refined in 002); hover → related sprints highlighted; PL/EN in the sketch toolbar; theme light/dark.

## What to Look For
- Is "now / next / awaiting UAT" visible without reading?
- Does the order of work stay readable (table rows vs. #n on cards vs. columns)?
- Are dependencies understandable (chips vs. arrows)?
- Density: enough at a glance on 1440 px, not cramped?
