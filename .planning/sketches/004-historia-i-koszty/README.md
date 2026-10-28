---
sketch: 004
name: historia-i-koszty
question: "How to show sprint cost and estimate accuracy?"
winner: "B"
tags: [history, cost, chart]
---

# Sketch 004: Historia i koszty

## Design Question
How the decision-maker sees what closed sprints cost, the cost per changed file, and whether the start price held.

## How to View
Build data, open `index.html`; period presets above everything (14 / 30 days / all measured).

## Variants
- **A: KPI tiles + table with bars** — tiles (sprints closed, tokens, median cost per changed file, start price hit k/n), table: merged, sprint, kind, files, tokens with an inline bar, per file, start price range vs actual with status, review state; earlier sprints without measurement collapsed.
- **B: Charts over time + price accuracy** — same tiles; tokens per sprint (columns), cost per changed file (line with median), start price vs actual (range bar + dot, ▲/▼/✓ with label); table on demand.

## Chart rules applied (dataviz)
One series per chart (slot 1 blue), one axis, hairline solid grid, 4px rounded column ends, 2px line, dots with surface ring, label only the extreme, hover tooltip (value first), table view available; status (within/above/below) always icon + label, never colour alone.

## What to Look For
- Is cost per changed file the right headline (it is the measure used to compare sprints)?
- Does the start-price chart tell you how much to trust the price the PO gives?
