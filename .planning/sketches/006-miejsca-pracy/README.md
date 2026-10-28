---
sketch: 006
name: miejsca-pracy
question: "Where and how does the decision-maker see their workplaces (worktrees) and the sprints assigned to them, so they know what runs where and what is ready to push, without asking the PO?"
winner: "C"
tags: [worktree, workplace, git, push, board, k7, k10]
---

# Sketch 006: Miejsca pracy (worktree)

## Design Question
Where the decision-maker sees their workplaces (named git worktrees from roadmap step K7) and the sprints assigned to each, so they know what runs where, in what order, what waits for them and what is ready to push, without asking the PO (each question to the PO is a paid turn). The sprint card stays as today; it only gains a "Miejsce pracy" box.

## How to View
Open `index.html` (file:// works; the sketch links the real `dwmt/templates/view/view.css`). Sketch bar: variant, situation, and K10 placeholders on/off. URL params `?v=A|B|C&s=par|push|attn|none&freeze=1` (freeze stops the "s temu" ticking, for screenshots); extra: `k10=0` hides the K10 placeholders, `w=all|main|<name>` preselects the workplace filter in C, `tab=roadmap|wp` picks the tab in A, `open=<sprint id>` opens a sprint card. Sample data is invented (neutral shop project `sklep-demo`, workplaces `platnosci` and `magazyn`), not project content.

## Variants
- **A: Zakładka „Miejsca pracy”**: own tab after Roadmapa, with a count and a flag ("1 do wypchnięcia" / "czeka na Ciebie"). One card per workplace: name and state (Pracuje / Gotowe do wypchnięcia / Czeka na Ciebie / Wypchnięte), six git facts (branch, path, based on, ahead/behind develop, pushed, uncommitted), attention lines, a lane of its sprints in order (done with commit / running with live step / queued / awaiting UAT / held), and the "Gotowe do wypchnięcia" box with the copyable `git push -u origin <branch>` once all its sprints are done. The main tree is a one-line card at the bottom linking to Roadmapa. The board on Roadmapa stays exactly as today.
- **B: Pasy na tablicy**: the existing state board split into swimlanes: "Główne drzewo" first, then one lane per workplace. Column headers (Draft / Do zrobienia / W toku / Czeka na przegląd) once at the top; each lane header carries the git facts, the order of its sprints as chips (`✓ blik → ● zwroty → raty`), attention lines and the push box. Done workplace sprints sit in "Czeka na przegląd" as compact cards ("zrobiony, czeka na wypchnięcie"). Below 900 px lanes stack and each cell shows its state.
- **C: Znaczek na karcie + filtr**: the board as today; each workplace sprint gets a coloured badge with its position (`platnosci · 2 z 3`). A switcher under the tabs (Wszystkie / Główne drzewo / platnosci / magazyn, with counts and ✓ / ! marks). With "Wszystkie", a compact strip shows one row of git facts per workplace (push command inline when ready). Selecting a workplace filters the board to its sprints and shows its full facts strip and push box.

All variants: clicking a sprint opens the centred sprint card as today, with a "Miejsce pracy" box on the right (name, branch, position in order, commit; "one commit on branch X, nothing goes to develop").

## Situations
- **Dwa równolegle**: `platnosci` (blik done, zwroty running "Zadanie 2 z 4 · Recenzja", raty queued) and `magazyn` (stany-magazynu running) work at the same time; the main tree runs newsletter and has koszyk-mobile awaiting UAT.
- **Gotowe do wypchnięcia**: all 3 sprints of `platnosci` done, 3 commits ahead, 2 behind develop, not pushed: push box with the command.
- **Wymaga uwagi**: `magazyn` is 27 commits behind develop, has 4 uncommitted files from outside the sprints (so the queued `rezerwacje` is held), and `stany-magazynu` awaits UAT. `platnosci` is already pushed and waits for the team's review (cleanup placeholder only).
- **Bez miejsc pracy**: today's behaviour. A has no tab, B has no lanes, C has no switcher or badges: the page is the current board.

## Room for later actions (K10, not built)
K10 makes the page interactive (assign sprints to a workplace, reorder, start/pause, push). Nothing here is clickable for that; each variant reserves the spot with a dashed, hatched box labelled **„później (K10)”** (toggle "Miejsca na akcje K10: ukryj" to see the page without them):
- A: "+ Nowe miejsce pracy" in the summary bar; "Wstrzymaj · Wznów" (or "Usuń po scaleniu" once pushed) in each card header; "kolejność: przeciąganie" over the lane; "+ Przypisz sprint" tile at the end of the lane; "Wypchnij" next to the push command.
- B: same header slots per lane, "kolejność: przeciąganie" next to the order chips, and the empty "Do zrobienia" cell of each workplace lane as a drop zone ("przeciągnij tu sprint z Głównego drzewa").
- C: "+ Nowe miejsce pracy" at the end of the switcher; "+ miejsce pracy" on unassigned To-do cards; pause/cleanup in the selected-workplace strip; "Wypchnij" next to the command.
- Sprint card (all variants): "Przenieś do innego miejsca · zmień kolejność" or "Przypisz do miejsca pracy" in the Miejsce pracy box. This is also where the first workplace would be created when none exist yet, so situation 4 stays free of placeholders.

The "Kopiuj" button next to the push command is not a K10 action: it only copies text and works on the static page.

## Data behind it (0 tokens)
Workplace record from K7 (name, path, branch, base commit and date, assigned sprints in order, state); sprint header `workTree: <name>`; git per worktree (`rev-list --left-right --count develop...<branch>`, upstream tracking for "pushed", `status --porcelain` for uncommitted files); run state and `live.js` for the running step (same as sketch 005); commit per finished sprint from the run. Assumptions made by the sketch, to confirm in the spec: uncommitted files outside a sprint block the next queued sprint; "many commits behind" threshold (here 20); done-but-unpushed sprints count as "Czeka na przegląd" on the board (the column already means "UAT or reading the code before push").

## What to Look For
- Own tab (A), lanes on the board (B) or a badge plus filter (C): which one do you open first when you ask "what runs where, and can I push?"
- Is the order of a workplace's sprints readable: lane tiles (A), order chips in the lane header (B), "2 z 3" on the badge (C)?
- B: do the mostly empty Draft / To-do cells of workplace lanes bother you, or are they the right place for the later drop zone?
- C: does the board stay readable with badges on half the cards, and is one switcher enough when there are 4–5 workplaces?
- Where a done-but-unpushed sprint should live on the board: "Czeka na przegląd" (as sketched) or off the board, only in the workplace view.
- Do the K10 placeholders sit where you would expect the buttons later?
