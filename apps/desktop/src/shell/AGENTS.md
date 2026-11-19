# apps/desktop/src/shell

The window's frame and the parts every view shares. Design: `DESIGN.md` (Navigation, Page header, Surfaces,
Drawers), spec `docs/superpowers/specs/2026-11-17-10db-app-shell-design.md`.

- `AppFrame` (`app-frame.tsx`, `app-frame.module.css`) is the frame: one bar across the top 44 px and the rail down
  the left, one surface on bg1 with no line between them, round a rounded content box
  (`decisions/2026-11-19-the-content-sits-in-a-rounded-box.md`). The bar holds the traffic lights, the sidebar
  button, the panel's head and the content's title row (`decisions/2026-11-18-the-window-has-one-bar-and-one-sidebar-button.md`).
  The box holds the panel column and the content, starts at the rail column's edge under the bar (a gutter in from
  the window where there is no rail column) and stops a 4 px gutter (`--shell-gutter`, `GUTTER`) short of the
  window's right and bottom. Its edge is `.boxEdge`, drawn over it and never taking a press: one hairline on its
  outline and one faint 3 px inner shade, in a darker shade of the content's tone, inside all four edges. A view
  never draws its own edge shade. Inside, the panel's body is half way from bg1 to bg0 and the content bg0, divided
  by the panel's hairline; a column's hairline crosses the bar as a short divider centred in it, 12 px clear above
  and below (`--shell-bar-divider-inset`), for the labelled rail and the panel. Sheets draw their own edges and
  stand over the box. The traffic lights sit at y 20, centred on the bar with the button in the installed app.
  Lists in the panel and the rail scroll without a scrollbar. The rail's foot holds the status controls and
  Settings; the theme and keep-awake are set in Settings › App. The window never scrolls; the content is exactly
  the window's height less the bar and the gutter and scrolls inside it, and it is its own stacking context so a
  sheet always stands over it.
  Rail widths (200 labelled, 60 icons only) and the title row's height (44 px) are constants there.
- The panel column and the content are a Mantine `Splitter`: the panel's hairline is the handle, and the builder
  drags the panel between 260 and 480 px (340 until dragged, and again on a double-click of the handle; `PANEL_WIDTH` and its bounds in `shell-layout.ts`).
  One width for every section, remembered (`panel-width.ts`, `tendb.shell.panelWidth`); a sheet takes it too.
  Only a panel column takes the pane's room: otherwise the pane is `display: contents`, and the handle is hidden.
- What the frame draws is a pure function of the window's width band, whether the section has a panel, the labels
  preference and which sheet is open (`shellLayout` in `shell-layout.ts`; bands at 1000
  and 640 px). The window's width, not a container's, decides it (`useShellBand`), because the frame decides what
  its content gets. The labels preference is remembered (`sidebar-labels.ts`, `tendb.shell.labels`).
- One sidebar button ("Toggle sidebar", y 8, on every section: x 88 beside the lights, or ending the rail's part of the bar over a labelled rail column, its icon level with the counts) does what ⇧⌘S does: it flips
  labels and icons when wide and opens the whole sidebar as a sheet otherwise. The bar's text starts at 128 px or
  later (`BAR_START`): the title row's padding and the panel head's `--shell-bar-start` clear the lights and the
  button where the rail is narrower than them. A wide window always draws a section's panel as a column, resized
  but never hidden; ⌘\ opens and closes the panel's sheet only where the window is not wide. A rail item is a plain
  link, the open section's too. Esc, a click on the backdrop, or moving anywhere closes a sheet.
- The rail is `rail.tsx` over `rail-items.ts` (`RAIL_ITEMS`, one flat list with no group type; a route maps to its
  section with `railSectionForPath`) and draws labelled or icons only from `RailModeContext` (`rail-mode.ts`), which the
  project row and the status controls read. `rail-badges.tsx` draws the counts. `factory-status.tsx` is the Factory row's status dot (`GET /status`, refetched on `status.changed`, never polled), in the row's count slot so nothing moves when it shows: amber from load level 1 (very busy, a hold near), orange while 10db holds new work for the load or any other status line, nothing otherwise. Its hovercard (`role="tooltip"`, so it describes the link) says in plain words what is happening, the busiest things by name where the daemon sends them, and that a hold ends by itself; it asks the builder nothing. The rail's foot has no status bar.

## Drawing into the frame

A view never renders the frame's parts; it draws into slots (`frame-slots.ts`, read with `useFrameSlots`) while it
is mounted:

- `TitleRow` (`title-row.tsx`): the title, an optional `switcher`, a dim `meta` line and `actions` at the right.
  The row's box and the space between its parts carry `data-tauri-drag-region`; a control a view puts in never
  does. A view with no title passes `title={null}` (Sessions draws its tab strip as the switcher; Settings, the Inbox and the Workbench have a panel; the Workbench's only while a pass is open).
  `lines` (1 or 2) is how many lines a long title takes before it is cut; two reads whole at a narrow width.
- `Panel` (`panel.tsx`): a section's list, with a 44 px head (its `title` and `controls`), its part of the bar. Mounting it is what tells the frame the section has a panel (`registerPanel`); unmounting withdraws it.
  A pick in a panel's list that changes no route (a row selected, a search change) calls `closeSheet()` from
  `useFrameSlots()`, since a sheet closes on its own only when the pathname changes.
- `FrameSlots.panelShown` says whether the frame draws the panel now: a column, or the open sheet. A view that draws
  something in the panel when it is shown and elsewhere when it is not (the Workbench's queue: the panel's body, else a
  strip across the content; the pass's name and menu: the panel's head, else the title row) reads it, and draws the
  thing once.
- `RenderLayout` (the screen frame) has a panel host only while a section registers a panel.
- `PageIntro` (`page-intro.tsx`): not a slot, but the top of a view's content: an optional one-line intro (13 px, a
  sentence) and an optional toolbar of tabs and filters. A page has one header, the title row; the content never
  repeats it. Nothing is drawn when both are absent.
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
content column (the nearest positioned box when drawn without a frame), 480 to 760 px wide and the whole surface under
640 px. It is not modal (`role=dialog`, `aria-modal=false`, no overlay); focus moves in on opening and back on
closing; Esc with focus inside, or ×, closes it. Use it for every side panel (Changes, an Inbox item, a Board
task); never Mantine's `Drawer`.

## Tests

jsdom has no layout, so a component that draws into the frame or measures itself is tested with the helpers in
`src/test/`:

- `frame.tsx`: `FrameSlots` wraps a component with a title row, a panel and a drawer layer.
- `sized-observer.ts`: `observeWidthsOf(width)` makes every `ResizeObserver` report `width`, and
  `resetObservedWidth` restores the real one after the test. Use it for a view that measures its container.
