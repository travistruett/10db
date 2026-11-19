# The content sits in a rounded box, inside a frame of the bar, the rail and thin gutters

- **Date:** 2026-11-19
- **Amends:** `decisions/2026-11-19-the-bar-divides-its-columns-with-short-lines.md`,
  `decisions/2026-11-18-the-window-has-one-bar-and-one-sidebar-button.md` (the hairline under the bar), and
  `docs/superpowers/specs/2026-11-17-10db-app-shell-design.md` §Brief ("no rounded inset card")

## Decision

- The bar (top 44 px) and the rail are one surface, bg1, with no line between them. The panel column and the
  content sit together in one box with 10 px corners, from the rail column's edge under the bar to a 4 px gutter
  short of the window's right and bottom edges. With no rail column the box starts a gutter in from the left too.
- The box's edge is one hairline and one faint 3 px inner shade inside all four edges, drawn by the frame over the
  box. The panel and the content have no edge or shade of their own; inside the box the panel is a half tone above
  the content, divided by its hairline. Elevation steps once, from the frame to the box.
- The panel belongs in the box because it is the section's own list, picked from for the content beside it; the
  bar and the rail are the same on every page.

## Why

The builder compared 10db with Slack and Codex, which both set their content in a rounded box inside a frame of a
header bar, the side navigation and very thin right and bottom gutters, and liked it. The rounded card that the
shell spec dropped sat under a header band darker than both its neighbours in light mode, which left a seam under
the traffic lights; here the bar and the rail share one tone, so there is no band and no seam.
