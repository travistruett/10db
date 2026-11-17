# apps/desktop/src/shell

The window's frame and the parts every view shares. Design: `DESIGN.md` (Navigation, Page header, Surfaces,
Drawers), spec `docs/superpowers/specs/2026-11-17-10db-app-shell-design.md`.

- `AppFrame` (`app-frame.tsx`, `app-frame.module.css`) is a CSS grid: a rail, a panel, a title row and one
  rounded content surface. The window never scrolls; the surface is exactly the window's height and its content
  scrolls inside it. Rail and panel size (52 and 260 px) and the title row's height (44 px) are constants there.
- What the frame draws is a pure function of the window's width band, whether the section has a panel, whether the
  builder hid it and whether the overlay is open (`shellLayout` in `shell-layout.ts`; bands at 1000 and 640 px).
  The window's width, not a container's, decides it (`useShellBand`), because the frame decides what its content
  gets. A hidden panel is remembered per section (`panel-hidden.ts`, `tendb.shell.panel.<section>`); ⌘\ and the
  sidebar button flip it when wide and open the overlay otherwise; Esc, or moving anywhere, closes the overlay.
- The rail is `rail.tsx` over `rail-items.ts` (`RAIL_ITEMS`, one flat list with no group type; a route maps to its
  section with `railSectionForPath`). `rail-badges.tsx` draws the counts.

## Drawing into the frame

A view never renders the frame's parts; it draws into slots (`frame-slots.ts`, read with `useFrameSlots`) while it
is mounted:

- `TitleRow` (`title-row.tsx`): the title, an optional `switcher`, a dim `meta` line and `actions` at the right.
  The row's box and the space between its parts carry `data-tauri-drag-region`; a control a view puts in never
  does. A view with no title passes `title={null}` (Sessions draws its tab strip as the switcher; today only Settings has a panel).
  `lines` (1 or 2) is how many lines a long title takes before it is cut; two reads whole at a narrow width.
- `Panel` (`panel.tsx`): a section's list. Mounting it is what tells the frame the section has a panel
  (`registerPanel`); unmounting withdraws it.
- `PageIntro` (`page-intro.tsx`): not a slot, but the top of a view's content: an optional one-line byline and an
  optional toolbar of tabs and filters. Nothing is drawn when both are absent.
- A host is null until the frame has mounted it, so a view draws nothing on its first pass. Outside a frame
  (a view rendered alone) every host is null and nothing is drawn.
- Views lay out by their container's width (`useElementSize` on their own root), not the window's: the rail and
  panel take some of the window.

- `CountBadge` (`count-badge.tsx`): a count in the rail and lists; `cap` shows `cap+` above that number.
- `RenderLayout` (`screens/render-layout.tsx`), the layout a Plan screen frame renders in place of the shell,
  provides title-row slots too, so a view that draws a `TitleRow` still draws it there.
- `shape-nav.tsx` keeps only `latestOpenShape`, where Plan's rail item opens; the `ShapeNav` component is gone.
- Settings' scope switch is styled in `views/settings/settings-nav.module.css`.
- The tooltip theme (bright ink on the base tone, 12 px, tight) is in `theme.ts`, not per use.

## Unsaved edits

`unsaved-guard.tsx`: a view with edits in progress reports them with `useReportUnsaved(dirty)`. A route change
(rail item, link, back) is then held by the router until the builder answers "discard your changes?"; a change
that stays on the same route (another card, another project) goes through `attempt()` from `useUnsavedGuard`.
Known limit: the guard holds one flag per frame, not one per view, so two dirty views mounted at once share it.

## Drawers

`SurfaceDrawer` (`surface-drawer.tsx`) is the one slide-out: it draws into the frame's drawer layer over the
content surface (the surface's own box when drawn without a frame), 480 to 760 px wide and the whole surface under
640 px. It is not modal (`role=dialog`, `aria-modal=false`, no overlay); focus moves in on opening and back on
closing; Esc with focus inside, or ×, closes it. Use it for every side panel (Changes, an Inbox item, a Board
task); never Mantine's `Drawer`.

## Tests

jsdom has no layout, so a component that draws into the frame or measures itself is tested with the helpers in
`src/test/`:

- `frame.tsx`: `FrameSlots` wraps a component with a title row, a panel and a drawer layer; find the title row with
  `titleRowOf()`.
- `sized-observer.ts`: `observeWidthsOf(width)` makes every `ResizeObserver` report `width`, `resizeObservedTo`
  changes it, `resetObservedWidth` restores the real one. Use it for a view that measures its container.
- `window-width.ts`: `windowWidth` sets the width media queries answer for, `viewportWidth` sets `innerWidth`
  (which the frame reads); each has a reset to call after the test.
