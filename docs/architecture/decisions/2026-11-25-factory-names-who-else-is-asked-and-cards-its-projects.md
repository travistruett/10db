# Factory lists each question out with someone else, and draws each project as a card

- **Date:** 2026-11-25
- **Amends:** `decisions/2026-11-25-factory-leads-with-needs-you-then-projects.md`

## Decision

- **Waiting on others is a table of its own,** under Needs you, unlit and on no fill. It replaces the dim line.
  Each row is one question out with someone else: the person (an avatar and their name), the question's own words
  (the open card that targets the run), the task, the project, how long ago, and Open. Needs you keeps only what
  waits on the builder.
- **Each project is a separated accordion card** on the Board card's tone, with its `xs` shadow and the `md`
  radius, apart from the next. It replaces a hairline-divided row.
- The Needs you table pads its cells at `md`, and the page sits at the Page width
  (`decisions/2026-11-25-a-view-takes-the-reading-or-the-page-width.md`).

## Why

"Waiting on Mark Ellis: 1 question" didn't say which question. Putting it in the same list as the builder's own
asks blurred what needs them against what needs someone else. With every project as text on one tone, the page
read as one wall of rows. The Board's cards already have a slight depth, so the project cards borrow it rather
than inventing another.
