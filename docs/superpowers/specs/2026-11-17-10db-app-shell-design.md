# 10db app shell: a sidebar and the content

**Status:** the frame is built (M1, then the two-column frame below). The panels of Sessions, Inbox and the
Workbench are designed, not built.

**Mockups:** `2026-11-17-10db-app-shell-mockups.html`, in this folder: six framed screens in Selenized dark and
light (the buttons at the top switch), at 1280, 900 and 480 px.

**Companion:** `2026-11-17-10db-sessions-simplified-design.md` changes what a session is (one kind of session; the
first change asks where the work happens). This spec draws the frame those sessions live in. Where they meet, the
Sessions spec says what a session shows and this one says where.

**Depends on:** #651 (Changes keeps its last diff), whose rule §1.4 and §1.5 generalise.

**Supersedes:** `2026-11-11-10db-sessions-ui.md` §5 (tabs in the title bar, the tab strip, the All Tabs menu, the
narrow table) and DESIGN.md's "Navigation" and "Page header" paragraphs. Everything else in those files stands.

## Brief

**What changes for you.**

- The window is **two columns**, a sidebar and the content, divided by one hairline. The sidebar is one tone (bg1)
  from the window's top to its bottom and holds the traffic lights and a Toggle sidebar button (⇧⌘S). The
  content has its own tone (bg0) and its own title row. There is no header band and no rounded inset card.
- The sidebar's **rail** is labelled (200 px) and ⇧⌘S switches it to **icons only** (76 px; each icon's name in a
  tooltip to its right) on wide windows. Under 1000 px it opens the labelled sidebar over the content. Inbox,
  Factory and Sessions come first, then a divider and the project's tile with Board, Plan, UI Workbench and
  Knowledge. The status icons (keep-awake, light/dark) and Settings sit at the foot.
- Beside the rail, a section can have a **panel**: the list you pick from. The content shows what you picked.
  Sessions lists its sessions, grouped by project. Inbox's Open list moves into the panel, email-style. The UI
  Workbench lists its pass's pages. Settings lists its sections. Board and Factory have no panel and keep the full
  width.
- **Session tabs go away.** The panel and a ⌄ beside the session's title switch between sessions. ⌘1–9, ⌘W, ⌘J,
  ⌘⇧T and ⌘⇧[ ] keep working on the panel's order.
- **Every page has one header:** the title row, level with the traffic lights, at the top of the content. It
  starts on the content's left edge and holds the view's actions. Nothing in the content repeats it.
  #645's heavy scroll shadows give way to a hairline.
- **Narrower windows:** under 1000 px the panel folds and the rail is icons only; ⇧⌘S opens the labelled sidebar
  (with the panel) over the content and ⌘\ opens the panel beside the icons. Under 640 px the sidebar folds
  too, and the toggle beside the traffic lights opens it.

**What it buys.** One frame for every screen, with nothing floating: lists on the left, the work on the right,
titles where your eye expects them. Sessions stops filling the title bar with tabs. The Inbox reads like mail.

**What could go wrong, and how we'd know.**

- *Icons without labels slow you down at first.* Tooltips open after 300 ms, and the badges stay. If you still
  hunt for a section after a week, the panel can show the section's name larger, or the rail can grow labels at
  wide widths. That's a follow-up, not this build.
- *The Workbench beside your browser (420–520 px) gets cramped.* The rail folds under 640 px, so at 480 px the
  content gets the whole width less a 6 px margin. Its queue strip stays on top, as Workbench §4.3 asks. An e2e
  measures the Workbench at 420, 520, 900 and 1280 px.
- *Some views lay out by the window's width, not their own.* With a rail and panel, the window no longer says how
  wide the content is. The Workbench and the session composer switch to measuring their container, with a rendered
  test each. Plan already does.
- *Many tests select today's sidebar, tab strip and header.* About 16 unit files and 5 e2e specs change. Sessions'
  tests change most, and change anyway with the simplified sessions.

**Calls you might disagree with.**

1. **The project tile sits in the rail, above the project's icons.** A click opens today's project switcher, which
   gains a Project Settings item. Global sections stay above the divider, as "scope follows the question" asks.
2. **The panel is 260 px and fixed.** Dragging its edge is a follow-up.
3. **The panel opens over the content (a sheet) when the window is narrow**, rather than squeezing it.
4. **All three Inbox states use the panel** (the builder's pick). `Open · Waiting · Resolved` sits in the
   panel's head, and the list below pages as you scroll. #647's tables give way to the list and a filter menu. Their
   paged routes and filters are reused.
5. **A running session shows a small spinner in its panel row.** This reverses the Sessions UI rule "no spinner".
   With reduced motion it's a static dot.
6. **⇧⌘S is the sidebar and ⌘\ is the panel.** ⌘B is left free for the composer. ⌘\ also answers a click on
   the open section's own rail item.
7. **Plan and Knowledge get no panel yet.** Plan keeps its History button; Knowledge keeps its tabs.

**Needed from you:** nothing to start. Reply to approve. The first build PR is the shell alone, with every view
moved onto it unchanged. Sessions follows with its own spec.

---

The rest is for the agents building it.

## 1. Layout

```
┌────────────────────┬──────────────────┬──────────────────────────────────┐
│ ●●●  [▣]           │ Settings      [◧]│ Title ⌄   meta line   actions  ⋯ │  44 px: lights row, panel head,
├────────────────────┤                  │                                  │  the content's title row
│ rail (200 | 76)    │ panel (260)      │ content (bg0)                    │
│ sidebar, bg1       │ sidebar, bg1     │                                  │
└────────────────────┴──────────────────┴──────────────────────────────────┘
```

- **Two columns.** The sidebar (the rail and, where the section has one, the panel) is `--mantine-color-default`
  (bg1) from the window's top to its bottom. The content column is `--mantine-color-body` (bg0), also top to
  bottom, with its own title row. A 1 px `bg2` hairline runs the full height between the rail and the panel and
  between the sidebar and the content. There is no inset, radius, ring or shadow on the frame: only sheets and
  drawers cast one.
- **Columns.** A CSS grid with `rail | panel | content` columns and `44px | 1fr` rows. Mantine's `AppShell` has no
  slot for a second left column, so the shell becomes `AppFrame`, our own layout component, in
  `apps/desktop/src/shell/app-frame.tsx`. It keeps what `AppShell.Main` guarantees today: the window never scrolls,
  and the content is exactly the window's height and scrolls inside itself. The content column is its own
  stacking context (`isolation: isolate`), so nothing inside it can rise over a sheet. It keeps every mount
  `AppLayout` has today (`app-layout.tsx:146-177`, `320-325`): `RenderLayout` for render mode,
  `ScreenRenderHost`, the `ReconnectingBanner` (at the top of the content), `useDesktopSync`, `useNewSessionKey`,
  and the first-run swap. The 48 px drag strips in `app-error.tsx` and `first-run.tsx` become 44 px, to match the
  title row.

### 1.1 The title row

- It's 44 px, at the top of the content column, on the content's own tone. The traffic lights (Tauri
  `trafficLightPosition` 16, 22) sit on the same row, over the sidebar (or, under 640 px, over the content). The row's empty space keeps `data-tauri-drag-region`, so a
  double-click zooms the window. Its controls never carry the drag attribute.
- Its text starts at the content's left edge plus 24 px. Under 640 px, where the traffic lights and the toggle sit
  on the content's tone, it starts at 116 px. It has no lower edge until the content scrolls under it, then a 1 px
  `bg2` line.
- Left to right: the **title** (14 px, weight 600, fg1, one line, ellipsis), an optional **⌄ switcher**, the
  **meta line** (12 px, dim, one line), then the view's **actions**, right-aligned (buttons 28 px high, `default`
  or `primary`) and ⋯.
- Views draw into it through `TitleRow`, a portal like today's `HeaderSlot`. It takes `title`, `meta`, `switcher`
  and `actions`. `HeaderSlot` is removed: its only caller was the Sessions tab strip.
- A view's `PageHeader` loses its title and actions to the title row. Its byline and toolbar rows stay at the top of
  the content. `PageHeader` keeps rendering those two rows and is renamed `PageIntro`.
- **One header per page.** A page has exactly one header, the title row. Title: what you are looking at, one line,
  14 px / 600. Meta: dim 12 px. Actions: right, 28 px, `default` or one `primary`, then ⋯. In the content, `PageIntro`
  allows at most one dim intro line (13 px, a sentence) and one toolbar of underlined tabs on the left and filters
  on the right. A second title or byline that names the same thing, and any heading larger than the title, is not
  allowed. A split view's pane may have a 13 px / 600 label row with its own actions. The type scale under the
  title: in-content section heads 14 / 600, card and row titles 14 / 500, a drawer's title 16 / 600, body 14,
  meta 12.

### 1.2 The rail

- Labelled it is 200 px wide and icons only 76 px, which holds the traffic lights (x 16 to 68). Labelled rows are
  30 px tall with an 18 px Tabler icon at stroke 1.6 and a 13 px / 500 label; icons-only rows are 40 × 34 px. Order:
  - Inbox, Factory, Sessions
  - a divider
  - the project (labelled: a 32 px row of a 20 px tile, the name and ⌄, which opens `ProjectSwitcher` below it;
    icons only: the 26 px tile with its ring, which opens it to the right), then Board, Plan, UI Workbench, Knowledge
  - a spacer
  - the foot: labelled, the Settings row with keep-awake and light/dark as 28 px icon buttons on its line (the
    download status only while downloading, the daemon status only when not connected); icons only, those icons
    stacked above Settings.
- **Active item:** a `bg2` fill, radius `md`, text in fg1. Hover is half `bg2`. No outline.
- **Tooltip** (icons only): Mantine `Tooltip`, `position="right"`, inside a `Tooltip.Group` that shares one 300 ms
  delay. The accessible name is the section's name, and its count phrase is separate, as `CountBadge` does today
  (`2026-11-11-a-label-never-carries-its-count.md`).
- **Badges:** the Inbox's open count and the Sessions and Workbench needs-you counts. Labelled, a `CountBadge` ends
  the row; icons only, it is pinned to the icon's top-right corner, never more than three characters ("99+").
- **The toggle:** a 28 px `IconLayoutSidebar` button, "Toggle sidebar ⇧⌘S", beside the traffic lights (x 80, y 8)
  when the sidebar is labelled or folded away, and under them (x 24, y 48) in the icons-only rail. Its tooltip
  does not open on focus, so a click never leaves it over what the click changed. A click on the open section's own
  rail item does what ⌘\ does.
- **The project switcher:** the dropdown keeps its search and New Project, and gains **Project Settings**.
- **Keyboard:** the rail is a `nav` landmark named "Sections". Tab enters it, ↑/↓ move between items, and Enter
  opens one.

### 1.3 The panel

- It's 260 px wide, on the sidebar's tone (bg1). A full-height 1 px `bg2` hairline is its right edge (the content's
  edge) and another separates it from the rail.
- **Head:** the sidebar's top row, 44 px, level with the traffic lights and the content's title, with the section's
  name (14 px, weight 600), its own controls and, while the panel is a column, a button that hides it. Where a
  section needs one, a second row follows. Sessions has search and New Session in the first row. The Inbox has search and its
  filter menu in the first row, and the `Open · Waiting · Resolved` switch in a second (§4.1).
- **Rows:** radius `md` and 8 px side padding, at the section's height: one-line rows are 30 px (Sessions, Settings,
  the Workbench), and the Inbox's two-line rows are 52 px. The selected row takes the `bg2` fill.
- **Group labels:** 11.5 px, weight 600, dim, with an optional 14 px project tile.
- **Narrow layouts:** the panel's list is the content's own state, not the shell's. The shell asks each view for a
  `panel` element and draws it, in the column or in a sheet (§2). Hiding it at 1000 px and over works three ways:
  ⌘\, a click on the open section's rail item, or the head's button.
- **Who has a panel:**

| Section | Panel | Content |
|---|---|---|
| Inbox (Open, Waiting, Resolved) | the state's rows, email-style, paged (§4.1) | the selected item |
| Sessions | sessions by project, then Recently closed | the session (Sessions spec) |
| UI Workbench, a pass open | the pass's pages (today's queue) | the page's thread |
| UI Workbench, start page | none | today's start page |
| Settings | today's `SettingsNav` | the section |
| Factory, Board, Plan, Knowledge | none | full width |

### 1.4 Panel lists and performance

A panel list that can grow without limit pages and virtualises. A bounded one renders whole.

| Panel | Grows without limit? | How it loads |
|---|---|---|
| Inbox, every state | yes | cursor pages of 50, on scroll; virtualised (§4.1) |
| Sessions | the sessions you keep open: bounded in practice | the open list renders whole up to 200 rows, then virtualises. Search reads every session (open, closed and archived) from the daemon, paged |
| Workbench pages | no (a pass's pages) | whole |
| Settings sections | no | whole |

- A list keeps its previous rows on screen while a refetch or filter change is on its way. It never drops to a
  loading state it already left (#651's rule).
- Selection, scroll position and the open filter survive switching sections and coming back. They're kept in the
  section's query state, not refetched.

### 1.5 Drawers

Changes (⌘⇧D), an Inbox item opened from elsewhere, and a Board task's details all open as one kind of slide-out
drawer, from the content column's right edge, flush to the window.

- **Size:** 50% of the content column, at least 480 px and at most 760 px. Under 640 px it takes the whole column.
- **Look:** the content's own tone (bg0), with a 1 px `bg2` left edge and a tight shadow, never a heavy one. Its
  insets are 24 px and it has no eyebrow: its title is 16 px / 600. It slides in over 150 ms, or appears at once with reduced motion.
- **Not modal.** The conversation stays usable beside it, so a line quoted from Changes lands in the composer:
  - when the surface is at least 1200 px wide, the conversation's column moves left to stay in view;
  - narrower, the drawer covers it until closed.
- **Closing:** Esc (when focus is inside it), its ×, or the key that opened it.
- **One at a time:** opening another replaces it.
- **Remembered for Changes only:** whether Changes is open is kept per session (#651's rule). The Board's and the
  Inbox's drawers open when asked and don't reopen by themselves.
- **Built once:** a `Drawer` shell component used by every caller, replacing `ChangesPanel`'s side column and the
  Board's `task-drawer.tsx` layout.

### 1.6 Spacing that makes it read as one

- **The content column:** conversations keep their 720 px column. Its left edge is where the title row's text
  starts when the content fills the column (Board, Factory, Inbox detail). In a centred conversation, the title row
  keeps the content's left padding.
- **Panel rows** start 8 px in from the panel's left edge. The icons-only rail's icons are centred in their 76 px.
  Nothing else is inset: there are no 8 px or 6 px insets on the content.
- **Shadows:** the scroll shadow over a conversation's header (#645, `conversation-layout.module.css`) and the
  gradient above its composer (`conversation-list.module.css`) are replaced. While the list is scrolled under it,
  the header gets a 1 px `bg2` line only. The composer gets nothing: it sits on bg1, which already sets it apart.

## 2. Widths

These are measured on the window, because the shell decides them:

| Window | Rail (labels on, the default) | Rail (labels off) | Panel | ⇧⌘S does | ⌘\ does |
|---|---|---|---|---|---|
| ≥ 1000 px | labelled, 200 | icons, 76 | a column beside the rail, 260, where the section has one | switches labels and icons, remembered in `tendb.shell.labels` | hides or shows the panel (per section) |
| 640–999 px | icons, 76 (the preference is kept, not applied) | icons, 76 | folded | opens the labelled rail as a sheet over the content, with the panel beside it where the section has one (460 px); Esc, a click outside or picking a row closes it | opens the panel alone as a sheet beside the icons rail |
| < 640 px | none | none | folded | opens a sheet: the labelled rail (200) for a section with no panel, or the icons rail and its panel (336) for one with a panel | opens the panel sheet, with the icons rail |

- A sheet is the sidebar over the content from the window's top to its bottom (the traffic lights and the toggle sit
  on it), bg1 with an `8px 0 24px` shadow and a 1 px right edge; the content dims behind it. Content widths: 1440
  labelled with no panel 1239, with the panel 979; 1000 labelled with the panel 539; 900 is 823; 480 is 480.
- A panel you hide at ≥ 1000 px stays hidden for that section until you show it again, kept in `localStorage`
  under `tendb.shell.panel.<section>`. A cleared store shows it.
- An open sheet is `inert` while folded (as the navbar is today). Picking a row in it closes it.
- **Views measure their container, not the window.** Plan already does (`split-pane.tsx:49`). These switch from the
  window to their own root's width:
  - the Workbench's `useViewportSize` (`pass-workspace.tsx:37`);
  - `chat-tab.tsx:170` and `fresh-tab.tsx:58`, the narrow composer;
  - `task-tab.tsx:60`, where Changes opened by itself, which becomes a drawer in the Sessions spec.

  Sessions' narrow rules (`strip-layout.ts`) go with the tab strip.
- **The Workbench's queue strip** shows exactly when the panel isn't shown: folded, or hidden with ⌘\. It never
  depends on a width. The queue is never drawn twice.
- **The title row** starts at the content's left edge plus 24 px at every width but one: under 640 px the traffic
  lights and the toggle sit on the content's tone, so it starts at 116 px.
- The window's minimum stays 420 × 600 (`2026-11-09-the-window-narrows-to-the-workbench.md`).

## 3. Keyboard

- **⇧⌘S**: the sidebar: the rail's labels on a wide window, the whole sidebar as a sheet otherwise.
- **⌘\**: show or hide the section's panel only (a sheet when folded); nothing on a section with no panel. Bound in
  the shell, on every view.
- **⌘T** opens a new session from any view, as now.
- Sessions' keys (⌘W, ⌘J, ⌘1–9, ⌘⇧T, ⌘⇧[ ], ⌃Tab) keep their meaning on the panel's order. The Sessions spec owns
  them.
- **Inbox:** j/k and ↑/↓ move the panel's selection. The scope rule in `use-inbox-keys.ts` (the target is `body`,
  or inside `[data-inbox-selected]`) widens to include the panel's list, marked `data-inbox-list`. 1–5, n, Enter
  and ? act on the selected card in the content, as today.
- **Workbench:** j/k, n, ⌘L and Esc as today, with the queue in the panel.
- **Focus:** opening a section from the rail puts focus where the section did before (a conversation's composer, the
  Inbox's selected row). The panel never takes focus unless you click or Tab into it.

## 4. Sections

### 4.1 Inbox

One pattern for all three states: the panel lists the state's rows, and the content shows the selected one.

**The panel's head:**
- "Inbox" and a search field (⌘F when the Inbox is shown).
- A segmented control `Open n · Waiting n · Resolved`, which replaces today's tabs. The counts follow DESIGN.md's
  counts rule. Resolved shows no count.
- A filter menu: project (today's `ProjectFilter`), kind, and, for Resolved, who answered and when.
- The state, search and filters live in the URL (`/inbox?state=&q=&project=&kind=`), so a link or a restart lands on
  the same list.

**A row:** two lines, 8 × 10 px padding, radius `md`. The selected row takes `bg2`.
- Line 1: the kind tag (FLAG, ASK, CHECK…, 9.5 px, weight 700, in the kind's colour), the title (weight 500, fg1,
  one line) and the age (dim). A grouped flag shows "×n" after its title.
- Line 2 depends on the state:
  - Open: the project and the body's first line.
  - Waiting: the project and who it waits on ("Waiting on Sam · 2d").
  - Resolved: the project and how it ended ("Answered · Approve").
- Open rows reuse the shared grouping rule (one row per row key, from the paged-row decision) and the collapsed
  row's content (`inbox-card.tsx:185-231`), without its border.
- A dismissable flag can be dismissed from its row: a hover Dismiss, or `e`. So thin items never need the detail.

**The content:**
- Open: the expanded `InboxCard`, without its `Paper` border and shadow, since the surface is the card now.
  Answering or dismissing selects the next row.
- Open, where it helps: a question's content adds the session's last three messages (read once, on selection). A
  check's content adds its diff (`useWorkstreamChanges`, as the check card does today).
- Waiting: today's waiting row's detail. That's who it waits on and since when, the message sent, and Take It Back.
- Resolved: today's `resolved-detail.tsx`. That's what was answered, by whom, and what it led to.
- Empty states: "Nothing needs you" (Open), "Nothing is waiting on anyone" (Waiting), "Nothing resolved yet"
  (Resolved), and "No matches" with Clear Filters when a search or filter is set.

**Performance.** The Inbox grows without limit, so nothing loads all of it.

- **The route grows a cursor.** Today `GET /inbox/page` (`app.ts:1842`, `packages/contracts/src/inbox-page.ts`)
  pages by number (`page`, `pageSize` ≤ 100) and has no search. Page numbers skip or repeat rows when cards come and
  go, so this step extends `InboxPageQuery` with:
  - `after`: a keyset cursor, the last row's sort key and id;
  - `q`: server-side search over titles and bodies;
  - for Resolved, a date range.

  Page-number reads stay for anything else that uses them. Open uses rows grouped by the daemon
  (`2026-11-16-the-open-inbox-is-paged-by-row-and-the-daemon-groups-the-rows.md`): that decision is built in this
  step, before the panel. Pages are 50 rows, held by `useInfiniteQuery`.
- **Lazy load on scroll.** The next page loads when the list is within 10 rows of its end, or when j/k moves the
  selection past what is loaded. A row placeholder shows while it loads; the list never jumps.
- **Virtualised rows.** The list renders only the rows in view plus an overscan of 10, with `@tanstack/react-virtual`
  (already a dependency, used by `conversation-list.tsx`). Rows are a fixed 52 px, so no measuring is needed.
- **Counts never load lists.** The segmented control's counts and the rail badge read the `total` of a page-size-1
  query, as the paged-row decision says. They're refreshed from the event stream, not by polling.
- **Search and filters run on the server.** Search is debounced by 250 ms. A change resets the list to its first
  page, and the previous results stay on screen until the new page arrives (`placeholderData: keepPreviousData`),
  so it doesn't flicker.
- **Live updates.** An answered or dismissed card is removed from the loaded pages. A new card is inserted where
  its sort key puts it: Open sorts most urgent first, then oldest, so a new card is not always at the top. If it
  falls past what is loaded, only the counts change. A card that joins or leaves a grouped row refetches that one
  row, so the client never copies the daemon's grouping. A whole refetch happens only on reconnect.
- **The detail loads on selection.** The detail is fetched when a row is selected. j/k prefetches the next row's
  detail, so moving down never waits.
- **Budget:** a list of 10,000 resolved items scrolls at 60 fps and keeps under 100 row elements in the DOM. A
  rendered test asserts the DOM bound, and the e2e seeds 2,000 items and checks the first page's time to show.

### 4.2 UI Workbench

- **With a pass open:**
  - The panel's head is the pass's name, with its ⋯ (today's pass header actions).
  - Its rows are the queue (`queue-list.tsx`), in the queue's order: a status dot, the page's name (weight 500 when
    it waits) and one state line.
  - Add Page stays a dashed row at the foot.
  - The title row holds the page's name, its state and the page's actions.
- **With the panel folded or hidden,** the queue strip on top of the content shows instead (§2), as Workbench §4.3
  asks, so the queue is visible at a glance beside the browser.

### 4.3 Settings

- The panel is `SettingsNav` as today, minus "Back to Board": the rail is always there.
- The title row holds the section's title (today's `Title order={3}` in `section-body.tsx` moves there).

### 4.4 Factory, Board, Plan, Knowledge

- No panel.
- The title row takes `PageHeader`'s title and actions: Board's New Task split button, Factory's project filter,
  Knowledge's New button.
- Plan's compact conversation header moves its title, New and History into the title row.
- Board's horizontal scroll and column rail are unchanged.

### 4.5 Sessions

The Sessions spec says what the panel lists and what the title row holds for a session. The shell gives it a panel
and a title row with a switcher, like any section.

## 5. What is removed

- Mantine `AppShell`, its navbar and header, the burger ("Show navigation"), `HeaderSlot` and `HeaderSlotTarget`,
  and `TRAFFIC_LIGHTS_WIDTH` / `SESSIONS_STRIP_START`.
- The rounded content surface, the pipe, the panel's own sidebar button before the title,
  `TITLE_START_CLEAR_OF_BUTTON`, and (by the Sessions spec) the session bar.
- The fold queries at 899 and 767 px (replaced by §2).
- `PageHeader`'s title and actions rows (renamed `PageIntro`).
- #645's scroll shadow and composer gradient (§1.6).
- In Sessions, through its own spec: the tab strip, All Tabs, the tab context menu's placement and the session bar.

## 6. Provider parity

The shell shows nothing that depends on a provider. A session's agent and model stay in its title row, as the
Sessions spec says, and read the same on a Claude plan, Bedrock, an API key and Codex.

## 7. Build order

Each step is one pull request, a vertical slice tested through the real daemon, as `.claude/rules/testing.md` asks
for views.

1. **The frame** (then the two-column frame: sidebar tone, labelled rail, ⇧⌘S, the content column's own title).
   `AppFrame`, the rail, the title row, the panel column and sheet, widths, ⌘\, and the shadow
   change. Every view moves onto it with no panel yet. `PageHeader` becomes `PageIntro`, and its title and actions
   go to `TitleRow`. The Workbench and the session views measure their containers. `SurfaceDrawer` is built, and the Board's task
   drawer uses it. Settings' nav becomes its panel. The
   Sessions tab strip stays for now: it renders in the title row's switcher slot until step 2.
2. **Sessions on the frame,** with the simplified sessions (its own spec and plan).
3. **The Inbox on the panel:** build the paged Open rows (the 2026-11-16 decision), then all three states as paged,
   virtualised panel lists, with search, filters and detail.
4. **The Workbench queue in the panel.**

## 8. Tests

- **Pure:** the width table (§2) as a function of window width, labels and section, one row per band. The rail's order and
  scope grouping as a table.
- **Rendered (`renderWithDaemon`):**
  - The rail: names, the active item, badges and their phrases, the project tile's switcher with Project Settings.
  - The title row: a view's title and actions land there, and the drag region excludes the controls.
  - The panel: hidden and remembered per section; the sheet opens and closes; Esc closes it. The rail's labelled
    render, and ⇧⌘S switching labels and icons.
  - The Workbench switches layout on its container's width.
  - The Inbox: j/k move the panel's selection, and answering selects the next row. Scrolling near the end loads the
    next page. The DOM holds under 100 rows with 10,000 loaded. A filter change keeps the old rows until the new
    page arrives.
- **e2e (WebKit, real daemon):**
  - Extend `workbench.spec.ts`'s width sweep to 420, 520, 900 and 1280 with the new frame.
  - One new `shell.spec.ts`: every rail item opens its section, ⌘\ toggles the panel, ⇧⌘S switches the rail at
    1280 and opens the sidebar over the content at 900 and 600 px.
  - Update the specs that select the old navbar (`loop`, `settings`, `shape`, `process-per-rigor`, `sessions`).
- **What breaks:** `app.test.tsx` (13 tests), `settings-nav.test`, `project-switcher.test`, `narrow-sessions.test`,
  and the 5 e2e specs above. Each is edited in the PR that changes what it selects.

## 9. Docs

- DESIGN.md: rewrite "Navigation", "Page header" and "Surfaces": the sidebar bg1 and the content bg0, divided by
  hairlines, no inset card, and the shadow rule (a hairline when scrolled; sheets and drawers only).
- Decisions (one file each in `docs/architecture/decisions/`):
  - "The shell is a rail, a panel and one content surface" (superseded by "The window is two columns, a sidebar
    and the content")
  - "Views lay out by their container's width"
  - "A running session's row may show a spinner"
- `apps/desktop/src/shell/AGENTS.md` (new): the frame's slots and the rules for drawing into the title row.
- Sessions UI spec: a note at §5's head pointing here.
