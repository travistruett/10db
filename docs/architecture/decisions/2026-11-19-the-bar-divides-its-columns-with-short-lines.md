# The bar divides its columns with short lines, and the sidebar button ends a labelled rail

- **Date:** 2026-11-19
- **Amends:** `decisions/2026-11-18-the-window-has-one-bar-and-one-sidebar-button.md`

## Decision

- Where a column's hairline crosses the bar (the labelled rail's, the panel's), it is a short line centred in
  the bar, 12 px clear of the window's top and of the bar's own hairline, and goes on under the bar. The
  icons-only rail's hairline still starts under the bar.
- Over a labelled rail column the sidebar button ends the rail's part of the bar: its icon ends where the rows'
  counts end. Over the icons-only rail, and when the rail is a sheet, it stays at x 88, beside the lights.
- The traffic lights sit at `trafficLightPosition` (16, 20), level with the button in the installed app. Judge
  them there: with the same setting the 10db Dev window (`pnpm dev:window`) draws them about 4 pt higher. At
  (16, 24), centred in the Dev window, they sat about 4 pt low in the installed app.
- The content column carries one inner shadow along its top and left, 3 px and faint, in a darker shade of its
  own tone. No view draws its own edge shade; the board's 56 px edge fades are gone.

## Why

The builder compared the bar with Codex's: a full-height line through the bar read as a cut across it, a button
floating mid-rail read as misplaced beside a column of counts, and the board's fade read as heavy. The button now
moves when the rail switches between labels and icons; it keeps its place in each state, and the shortcut,
⇧⌘S, never moves.
