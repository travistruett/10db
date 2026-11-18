# The window is two columns, a sidebar and the content

- **Date:** 2026-11-17
- **Supersedes:** `decisions/2026-11-17-the-shell-is-a-rail-a-panel-and-one-content-surface.md`

## Decision

The window's frame is `AppFrame` (`apps/desktop/src/shell/app-frame.tsx`): two columns divided by 1 px `bg2`
hairlines.

- **The sidebar** is `bg1` from the window's top to its bottom. It carries the traffic lights and a Toggle sidebar
  button (⇧⌘S) on its top row, then the rail (labelled, 200 px, or icons only, 76 px) and, where the section has
  one, the 260 px panel, whose head is the same top row.
- **The content** is `bg0` from top to bottom, with its own 44 px title row at its top, level with the traffic
  lights. There is no full-width header band, no rounded inset card, and no ring or shadow on the frame. Sheets
  and drawers cast the only shadows.
- Every page has one header, the title row. Nothing in the content repeats it.
- ⇧⌘S flips the rail's labels and icons when the window is 1000 px or wider (remembered in `tendb.shell.labels`)
  and opens the whole sidebar as a sheet over the content below that. ⌘\ shows and hides the section's panel only;
  so does a click on the open section's rail item.

## Why

- The first frame (an `bg0` rail, a `bg1` title band and an inset `bg0` card) put the traffic lights across a tone
  seam, and in light mode the band was darker than both its neighbours, so it read as a second header.
- The inset card forced a frame-toned band over the content to wrap it. Without the card the content keeps the 8 px
  it lost on the right and bottom, and a title sits on the content's own tone.
- A labelled rail is the builder's choice on every page; icons only stays one key away for a narrow content area.
- Rejected: keeping the card and recolouring the band (the seam stays), and a 52 px icon rail with a content-toned
  top (the lights would sit on a seam again).
