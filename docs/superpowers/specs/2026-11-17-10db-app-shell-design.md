# 10db app shell: a rail, a panel and one content surface

**Status:** designed on 2026-11-17, not built.

**Mockups:** `2026-11-17-10db-app-shell-mockups.html`, in this folder: six framed screens in Selenized dark and
light (the buttons at the top switch), at 1280, 900 and 480 px.

**Companion:** `2026-11-17-10db-sessions-simplified-design.md` changes what a session is (one kind of session; the
first change asks where the work happens). This spec draws the frame those sessions live in. Where they meet, the
Sessions spec says what a session shows and this one says where.

**Supersedes:** `2026-11-11-10db-sessions-ui.md` §5 (tabs in the title bar, the tab strip, the All Tabs menu, the
narrow table) and DESIGN.md's "Navigation" and "Page header" paragraphs. Everything else in those files stands.

## Brief

**What changes for you.**

- The labelled sidebar becomes a slim **icon rail**. Each icon's name shows in a tooltip to its right. Inbox,
  Factory and Sessions come first, then a divider and the project's tile with Board, Plan, UI Workbench and
  Knowledge. The status icons (keep-awake, light/dark) and Settings sit at the foot.
- Beside the rail, a section can have a **panel**: the list you pick from. The content shows what you picked.
  Sessions lists its sessions, grouped by project. Inbox's Open list moves into the panel, email-style. The UI
  Workbench lists its pass's pages. Settings lists its sections. Board and Factory have no panel and keep the full
  width.
- **Session tabs go away.** The panel and a ⌄ beside the session's title switch between sessions. ⌘1–9, ⌘W, ⌘J,
  ⌘⇧T and ⌘⇧[ ] keep working on the panel's order.
- **Every section is titled in the same place:** a title row level with the traffic lights. It starts on the
  content's left edge and holds the view's actions. A hairline continues the panel's edge up through it.
- The content sits on **one rounded surface**, inset from the frame, like Codex. #645's heavy scroll shadows give
  way to a hairline.
- **Narrower windows:** under 1000 px the panel folds behind a sidebar button (⌘\). Under 640 px the rail folds
  too, and the button opens both over the content.

**What it buys.** One frame for every screen, with nothing floating: lists on the left, the work on the right,
titles where your eye expects them. Sessions stops filling the title bar with tabs. The Inbox reads like mail.

**What could go wrong, and how we'd know.**

- *Icons without labels slow you down at first.* Tooltips open after 300 ms, and the badges stay. If you still
  hunt for a section after a week, the panel can show the section's name larger, or the rail can grow labels at
  wide widths. That's a follow-up, not this build.
- *The Workbench beside your browser (420–520 px) gets cramped.* The rail folds under 640 px, so at 480 px the
  content gets the whole width less a 6 px margin. Its queue strip stays on top, as Workbench §4.3 asks. An e2e
  measures the Workbench at 420, 520, 900 and 1280 px.
- *Workbench and Plan lay out by the window's width, not their own.* With a rail and panel, the window no longer
  says how wide the content is. Both switch to measuring their container, with a rendered test each.
- *Many tests select today's sidebar, tab strip and header.* About 16 unit files and 5 e2e specs change. Sessions'
  tests change most, and change anyway with the simplified sessions.

**Calls you might disagree with.**

1. **The project tile sits in the rail, above the project's icons.** A click opens today's project switcher, which
   gains a Project Settings item. Global sections stay above the divider, as "scope follows the question" asks.
2. **The panel is 260 px and fixed.** Dragging its edge is a follow-up.
3. **The panel opens over the content (an overlay) when the window is narrow**, rather than squeezing it.
4. **All three Inbox states use the panel** (the builder's pick). `Open · Waiting · Resolved` sits in the
   panel's head, and the list below pages as you scroll. #647's tables give way to the list and a filter menu. Their
   paged routes and filters are reused.
5. **A running session shows a small spinner in its panel row.** This reverses the Sessions UI rule "no spinner".
   With reduced motion it's a static dot.
6. **The sidebar shortcut is ⌘\.** ⌘B is left free for the composer.
7. **Plan and Knowledge get no panel yet.** Plan keeps its History button; Knowledge keeps its tabs.

**Needed from you:** nothing to start. Reply to approve. The first build PR is the shell alone, with every view
moved onto it unchanged. Sessions follows with its own spec.

---

The rest is for the agents building it.

## 1. Layout

```
┌──────┬────────────────────┬─────────────────────────────────────────────┐
│ ●●●  │              [▣]   │ Title ⌄   meta line            actions  ⋯  │  44 px title row (frame)
├──────┼────────────────────┤ ┌─────────────────────────────────────────┐ │
│ rail │ panel              │ │ content surface (rounded 10 px)         │ │
│ 52px │ 260 px             │ │                                         │ │
│      │                    │ │                                         │ │
│      │                    │ └─────────────────────────────────────────┘ │  8 px inset right and bottom
└──────┴────────────────────┴─────────────────────────────────────────────┘
```

- **Frame (the builder's pick, tone C in the mockups).** The panel and the title row share one flat surface:
  `--mantine-color-default` (bg1), today's sidebar tone. The rail sits one step darker, on
  `--mantine-color-body` (bg0), so it reads as the window's edge. Its active item fills with bg1, the panel's
  tone. Nothing on the frame has a border or a shadow, except the hairline described under §1.3.
- **Content surface.** The content sits on `--mantine-color-body` (bg0), with a 10 px radius on all four corners.
  It's inset 8 px from the window's right and bottom edges and from the title row. It sits flush against the panel
  (or the rail, when there's no panel). Its edge is a 1 px `bg2` ring in both schemes, Selenized only
  (`2026-10-28-selenized-exactly.md`). Its shadow is one tight layer: `0 1px 2px` at `.35` in dark and `.06` in
  light. That is a shadow's black, not a colour. Under 640 px the inset is 6 px on every side.
- **Columns.** A CSS grid with `rail | panel | content` columns and `44px | 1fr` rows. Mantine's `AppShell` has no
  slot for a second left column, so the shell becomes `AppFrame`, our own layout component, in
  `apps/desktop/src/shell/app-frame.tsx`. It keeps what `AppShell.Main` guarantees today: the window never scrolls,
  and the content is exactly the window's height and scrolls inside itself. It keeps every mount `AppLayout` has
  today (`app-layout.tsx:146-177`, `320-325`): `RenderLayout` for render mode, `ScreenRenderHost`, the
  `ReconnectingBanner` (at the top of the content surface), `useDesktopSync`, `useNewSessionKey`, and the
  first-run swap. The 48 px drag strips in `app-error.tsx` and `first-run.tsx` become 44 px, to match the title
  row.

### 1.1 The title row

- It's 44 px, on the frame, and spans the content column. The traffic lights (Tauri `trafficLightPosition` 16, 22)
  sit on the same row, over the rail and panel. The row's empty space keeps `data-tauri-drag-region`, so a
  double-click zooms the window. Its controls never carry the drag attribute.
- Its text starts on the content surface's inner left edge (the surface's 24 px padding). The title lines up with
  the first line of content below it.
- Left to right: the **title** (14 px, weight 600, fg1, one line, ellipsis), an optional **⌄ switcher**, the
  **meta line** (12 px, dim, one line), then the view's **actions**, right-aligned (buttons 28 px high, `default`
  or `primary`) and ⋯.
- Views draw into it through `TitleRow`, a portal like today's `HeaderSlot`. It takes `title`, `meta`, `switcher`
  and `actions`. `HeaderSlot` is removed: its only caller was the Sessions tab strip.
- A view's `PageHeader` loses its title and actions to the title row. Its byline and toolbar rows stay at the top of
  the content. `PageHeader` keeps rendering those two rows and is renamed `PageIntro`.

### 1.2 The rail

- It's 52 px wide. Its items are 36 × 34 px with an 18 px Tabler icon at stroke 1.6, in this order:
  - Inbox, Factory, Sessions
  - a divider (24 px, `bg2`)
  - the project tile (26 px `ProjectTile` with a 1 px ring), then Board, Plan, UI Workbench, Knowledge
  - a spacer
  - the download status (only while downloading), daemon status (only when not connected), keep-awake, light/dark,
    and Settings.
- **Active item:** a `bg2` fill, radius `md`, icon in fg1. No outline.
- **Tooltip:** Mantine `Tooltip`, `position="right"`, `openDelay={300}`, with the section's name. The accessible name
  is the section's name, and its count phrase is separate, as `CountBadge` does today
  (`2026-11-11-a-label-never-carries-its-count.md`).
- **Badges:** the Inbox's open count and the Sessions and Workbench needs-you counts. A compact `CountBadge` pinned
  to the icon's top-right corner, in attention blue, never more than three characters ("99+").
- **The project tile:** a click opens `ProjectSwitcher`'s dropdown to the tile's right. The dropdown keeps its
  search and New Project, and gains **Project Settings**. The tile's tooltip names the project.
- **Keyboard:** the rail is a `nav` landmark named "Sections". Tab enters it, ↑/↓ move between items, and Enter
  opens one.

### 1.3 The panel

- It's 260 px wide, on the frame (bg1), with no border of its own. Its right edge is where the content surface
  begins. **The hairline "pipe"** is a 1 px `bg2` line in the title row at that same x, from 10 px below the
  window's top down to the surface. The panel's edge reads as one line from the top of the window to the bottom.
- **Head:** 34 px high, holding the section's name (14 px, weight 600) and the section's own controls: Sessions has
  search and New Session; Inbox has its project filter.
- **Rows:** 30 px high, radius `md`, 8 px side padding. The selected row takes the `bg2` fill.
- **Group labels:** 11.5 px, weight 600, dim, with an optional 14 px project tile.
- **Narrow layouts:** the panel's list is the content's own state, not the shell's. The shell asks each view for a
  `panel` element and draws it, in the column or in the overlay (§2).
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
drawer, from the content surface's right edge.

- **Size:** 50% of the surface, at least 480 px and at most 760 px. Under 640 px it takes the whole surface.
- **Look:** the surface's own tone (bg0), with a 1 px `bg2` left edge and the surface's tight shadow, never a heavy
  one. It slides in over 150 ms, or appears at once with reduced motion.
- **Not modal.** The conversation stays usable beside it, so a line quoted from Changes lands in the composer:
  - when the surface is at least 1200 px wide, the conversation's column moves left to stay in view;
  - narrower, the drawer covers it until closed.
- **Closing:** Esc (when focus is inside it), its ×, or the key that opened it.
- **One at a time:** opening another replaces it.
- **Remembered per session:** whether it's open is kept for each session (#651's rule for Changes).
- **Built once:** a `Drawer` shell component used by every caller, replacing `ChangesPanel`'s side column and the
  Board's `task-drawer.tsx` layout.

### 1.5 Spacing that makes it read as one

- **The content column:** conversations keep their 720 px column. Its left edge is where the title row's text
  starts when the content fills the surface (Board, Factory, Inbox detail). In a centred conversation, the title row
  keeps the surface's left padding. The mockups show both.
- **Panel rows** start 8 px in from the panel's left edge. The rail's icons are centred in their 52 px. Nothing
  else is inset.
- **Shadows:** the scroll shadow over a conversation's header (#645, `conversation-layout.module.css`) and the
  gradient above its composer (`conversation-list.module.css`) are replaced. While the list is scrolled under it,
  the header gets a 1 px `bg2` line only. The composer gets nothing: it sits on bg1, which already sets it apart.

## 2. Widths

These are measured on the window, because the shell decides them:

| Window | Rail | Panel | Sidebar button |
|---|---|---|---|
| ≥ 1000 px | shown | shown, where the section has one | after the traffic lights, at the panel's right end; hides the panel |
| 640–999 px | shown | folded; the button (or ⌘\) opens it **over** the content, and Esc or a click outside closes it | after the traffic lights |
| < 640 px | folded | folded; the button opens rail and panel together over the content | after the traffic lights; the title row starts after it |

- A panel you hide at ≥ 1000 px stays hidden for that section until you show it again, kept in `localStorage`
  under `tendb.shell.panel.<section>`. A cleared store shows it.
- An open overlay is `inert` while folded (as the navbar is today). Picking a row in it closes it.
- **Views measure their container, not the window.** Plan already does (`split-pane.tsx:49`). These switch from the
  window to their own root's width:
  - the Workbench's `useViewportSize` (`pass-workspace.tsx:37`);
  - `chat-tab.tsx:170` and `fresh-tab.tsx:58`, the narrow composer;
  - `task-tab.tsx:60`, where Changes opened by itself, which becomes a drawer in the Sessions spec.

  Sessions' narrow rules (`strip-layout.ts`) go with the tab strip.
- **The Workbench's queue strip** shows exactly when the panel isn't shown: folded, or hidden with ⌘\. It never
  depends on a width. The queue is never drawn twice.
- **Between 640 and 999 px** the title row starts after the sidebar button, at 112 px from the window's edge, clear
  of the traffic lights (which reach about 70 px).
- The window's minimum stays 420 × 600 (`2026-11-09-the-window-narrows-to-the-workbench.md`).

## 3. Keyboard

- **⌘\**: show or hide the panel (or the overlay, when folded). Bound in the shell, on every view.
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

- **Paging.** Every state reads `GET /inbox/page` with a cursor (`after`), one page of 50 rows. Open uses rows
  grouped by the daemon (`2026-11-16-the-open-inbox-is-paged-by-row-and-the-daemon-groups-the-rows.md`): that
  decision is built in this step, before the panel. Waiting and Resolved use the paged routes #647 built.
  `useInfiniteQuery` holds the pages.
- **Lazy load on scroll.** The next page loads when the list is within 10 rows of its end, or when j/k moves the
  selection past what is loaded. A row placeholder shows while it loads; the list never jumps.
- **Virtualised rows.** The list renders only the rows in view plus an overscan of 10, with `@tanstack/react-virtual`
  (already a dependency, used by `conversation-list.tsx`). Row height is fixed at 52 px, so no measuring is needed.
- **Counts never load lists.** The segmented control's counts and the rail badge read the `total` of a page-size-1
  query, as the paged-row decision says. They're refreshed from the event stream, not by polling.
- **Search and filters run on the server.** Search is debounced by 250 ms and passed to the paged route. A change
  resets the list to its first page, and the previous results stay on screen until the new page arrives
  (`placeholderData: keepPreviousData`), so it doesn't flicker.
- **Live updates.** An event for a card patches the loaded pages: a new Open card lands at the top, and an answered
  one is removed. The list isn't refetched. A whole refetch happens only on reconnect.
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
- The fold queries at 899 and 767 px (replaced by §2).
- `PageHeader`'s title and actions rows (renamed `PageIntro`).
- #645's scroll shadow and composer gradient (§1.5).
- In Sessions, through its own spec: the tab strip, All Tabs, the tab context menu's placement and the session bar.

## 6. Provider parity

The shell shows nothing that depends on a provider. A session's agent and model stay in its title row, as the
Sessions spec says, and read the same on a Claude plan, Bedrock, an API key and Codex.

## 7. Build order

Each step is one pull request, a vertical slice tested through the real daemon, as `.claude/rules/testing.md` asks
for views.

1. **The frame.** `AppFrame`, the rail, the title row, the panel column and overlay, widths, ⌘\, and the shadow
   change. Every view moves onto it with no panel yet. `PageHeader` becomes `PageIntro`, and its title and actions
   go to `TitleRow`. The Workbench and Plan measure their containers. Settings' nav becomes its panel. The
   Sessions tab strip stays for now: it renders in the title row's switcher slot until step 2.
2. **Sessions on the frame,** with the simplified sessions (its own spec and plan).
3. **The Inbox on the panel:** build the paged Open rows (the 2026-11-16 decision), then all three states as paged,
   virtualised panel lists, with search, filters and detail.
4. **The Workbench queue in the panel.**

## 8. Tests

- **Pure:** the width table (§2) as a function of window width and section, one row per band. The rail's order and
  scope grouping as a table.
- **Rendered (`renderWithDaemon`):**
  - The rail: names, the active item, badges and their phrases, the project tile's switcher with Project Settings.
  - The title row: a view's title and actions land there, and the drag region excludes the controls.
  - The panel: hidden and remembered per section; the overlay opens and closes; Esc closes it.
  - The Workbench and Plan switch layout on their container's width.
  - The Inbox: j/k move the panel's selection, and answering selects the next row. Scrolling near the end loads the
    next page. The DOM holds under 100 rows with 10,000 loaded. A filter change keeps the old rows until the new
    page arrives.
- **e2e (WebKit, real daemon):**
  - Extend `workbench.spec.ts`'s width sweep to 420, 520, 900 and 1280 with the new frame.
  - One new `shell.spec.ts`: every rail item opens its section, ⌘\ toggles the panel, and at 600 px the button
    opens rail and panel over the content.
  - Update the specs that select the old navbar (`loop`, `settings`, `shape`, `process-per-rigor`, `sessions`).
- **What breaks:** `app.test.tsx` (13 tests), `settings-nav.test`, `project-switcher.test`, `narrow-sessions.test`,
  and the 5 e2e specs above. Each is edited in the PR that changes what it selects.

## 9. Docs

- DESIGN.md: rewrite "Navigation" and "Page header" for the rail, panel and title row. Add "Surfaces: one rounded
  content surface on the frame", and the shadow rule (a hairline when scrolled, nothing else).
- Decisions (one file each in `docs/architecture/decisions/`):
  - "The shell is a rail, a panel and one content surface"
  - "Views lay out by their container's width"
  - "A running session's row may show a spinner"
- `apps/desktop/src/shell/AGENTS.md` (new): the frame's slots and the rules for drawing into the title row.
- Sessions UI spec: a note at §5's head pointing here.
