# The window has one bar and one sidebar button, and a wide window never hides the panel

- **Date:** 2026-11-18
- **Amends:** `docs/superpowers/specs/2026-11-17-10db-app-shell-design.md` §1.1 (the title row), §1.2 (the
  toggle), §1.3 (the panel's head and hiding it) and decision 6 of its list (⌘\ and a click on the open section's
  rail item)

## Decision

- The top 44 px of the window is one bar across every column, on the sidebar's tone (bg1) with a hairline
  under it. The rail's part holds the traffic lights; the panel's head and the content's title row are its parts
  over their columns. The rail's own hairline starts under the bar. The traffic lights sit at
  `trafficLightPosition` (16, 24), on the bar's centre line with the button and the titles; at (16, 22) they sat
  about 2.5 pt high in the app on macOS 26. The icons-only rail is 60 px, its first icon 8 px under the bar.
- One sidebar button, `IconLayoutSidebar` ("Toggle sidebar"), sits at x 88, y 8 in every state and on every
  section, and does what ⇧⌘S does: on a wide window it switches the rail between labels and icons only; under
  1000 px it opens the sidebar over the content. What starts the bar right of the rail starts at 128 px or later,
  so the button keeps its place where the icons-only rail is narrower than the lights and the button together.
- On a wide window a section's panel is always a column. It is resized (260 to 480 px, a double-click on its
  edge back to 340), never hidden: ⌘\ does nothing there, its head has no hide button, and no hidden state is
  kept. Under 1000 px the panel is a sheet, as before.
- A click on the open section's rail item is a plain link; it no longer shows or hides the panel.

## Why

The builder hid the Inbox's panel and could not get it back: its only visible hide button lived in the panel's
head, which went with it, and the ways back (⌘\, or a click on the active rail item) showed nowhere. The panel
is the list half of a list and detail view; hiding it leaves the detail with nothing to move between, as Mail
never hides its message list. Resizing gives the room hiding was for. With the panel fixed, one thing folds on a
wide window, the rail's labels, so one button serves, as Mail's and Codex's sidebar buttons do. Two buttons side
by side, one for the rail and one for the panel, were turned down: they look alike and the builder would have to
learn which is which. The rail's button had lived in the rail, which is too narrow for it beside the lights when
icons only, so it dropped under them; in the bar it never moves. A pattern for narrow windows (the list first,
then the item with a way back) is separate work.
