# The shell is a rail, a panel and one content surface

- **Date:** 2026-11-17
- **Superseded by:** `decisions/2026-11-17-the-window-is-two-columns-a-sidebar-and-the-content.md`

## Decision

The window's frame is `AppFrame` (`apps/desktop/src/shell/app-frame.tsx`), a CSS grid of a 52 px icon rail, an
optional 260 px panel, a 44 px title row beside the traffic lights, and one rounded content surface that holds the
view. Mantine's `AppShell`, the header and the sidebar are gone.

- The frame is flat: the rail is `bg0`, the panel and title row `bg1`, with no border or shadow on them. The
  content surface is `bg0` with a 1 px `bg2` ring and one tight shadow, and it is the only shadow in the window.
  A conversation's header takes a 1 px hairline while its list scrolls under it; the scroll shadow and the
  composer's gradient are removed.
- What is drawn follows the window's width (rail and panel from 1000 px; the rail alone from 640 px, the panel
  over the content from a sidebar button or ⌘\; both folded under 640 px). A panel hidden at 1000 px and over is
  remembered per section.
- A view draws into the frame through slots (`TitleRow`, `Panel`, `SurfaceDrawer`), never by rendering the
  frame's parts. Side panels are one `SurfaceDrawer`, not Mantine's `Drawer`.

## Why

- Settings needed a second column (its sections) that `AppShell` has no slot for.
- One rounded surface on a flat frame reads as one window and drops the heavy scroll shadows that stacked with
  card borders.
- Slots keep each view's title, actions and list next to the view's own code and let a view render alone in a
  test.
