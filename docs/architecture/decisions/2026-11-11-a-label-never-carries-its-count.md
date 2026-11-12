# A label never carries its count in parentheses

- **Date:** 2026-11-11

## Decision

No button, menu item, accordion control or section line in the desktop app writes a count into its label as
"(n)": not "Start Pass (2)", "Archived (3)" or "Done (4)" (DESIGN.md, Counts).

- **A count of what is already on screen is left out.** Start Pass, Add Pages and the setup's Apply count rows
  the builder has just picked or ticked and can see, so they say only their action.
- **A count of what is hidden, or waiting,** is a `CountBadge` (`apps/desktop/src/shell/count-badge.tsx`): a
  small filled Mantine `Badge`, round while the count is one digit, put in the control's `rightSection` (Set Up, Show Other Areas)
  or beside the label in a control that has no right section (Archived, Earlier).
- **A row that already has a sentence line** says the count there in words: the Factory's Done row reads
  "Done" with "4 goals" beside it.

The badge is Mantine's, not a Tabler number icon: Tabler draws digits 0 to 9 only, so a tenth item would need
a second form, while a badge widens for any count.

## Why

The builder's call during the Workbench's QA: a count in parentheses reads as text bolted onto a label, and
the earlier labels each did it differently. Most of them counted rows that sit just above the button, so the
count said nothing new. Where a count does tell the builder something (suggestions left in Set Up, areas
behind Show Other Areas), a badge separates it from the action's name. A lint rule was considered and turned
down: a parenthesis after a value is fine in a sentence ("Default (sonnet)", "Hold (reason)"), and telling a
count from those needs more than syntax.
