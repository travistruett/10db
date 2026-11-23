# 10db design system

The UI is a dense operations console: many workstreams, one inbox, quick keyboard answers. It
favors legibility and calm over decoration.

- **Library:** Mantine 9 components and theme tokens only. Icons: Tabler, stroke 1.5, size 16
  in dense lists and 20 elsewhere.
- **Color scheme:** dark by default; light is a toggle and must be equally usable. Never hard-code
  colors; use theme tokens (`var(--mantine-color-…)`) so both schemes work.
- **Palette:** [Selenized](https://github.com/jan-warchol/selenized): Selenized dark paints the
  dark scheme and Selenized light the light one (`apps/desktop/src/theme.ts`), with every value
  exactly as Selenized defines it: never mixed, lightened or darkened, and never adjusted to reach a
  contrast ratio. Text is fg_0, bright text fg_1 and dimmed text dim_0, on bg_0; controls and
  light-variant backgrounds are bg_1, hovering on bg_2. An accent is drawn in its base value and
  hovers in its bright one; text on a filled accent is bg_0, as in reverse video. Every Mantine hue
  maps to a Selenized accent (teal is cyan, pink and grape are magenta, indigo is violet, lime is
  green), so no stock Mantine color appears.
- **Primary color:** blue. Status colors: blue = running, yellow = waiting on a human, orange =
  paused (limits), red = failed, green = done or ready, gray = queued or cancelled. Green is the only
  "OK" color for a task or goal; don't use cyan or teal for success there. A connection's status (Overview,
  Integrations, an account's state) is the exception: teal = works, yellow = needs the builder, gray = off, never
  green or red, and its dot always comes with words. Every card in the Inbox's Open state waits on the
  builder, so its kind mark (in the card's meta line) stays yellow, a flag's too: red there would read as an
  error. Waiting holds what the builder waits on someone else for; waiting on someone shows as a line on
  the row, not a color. A status is
  never told by color alone: a bare dot means running, a dot with a ring waits on the builder (yellow, or red for
  a failure), and failed, paused and done are icons in their colors. Green on a Sessions row means landed (a pull request merged,
  or the branch merged into its base on a `local` project).
- **Type:** system font stack; monospace for IDs, paths, commands and logs.
- **Density:** `size="sm"` controls in lists and tables; `md` in forms and dialogs.
- **Board cards:** compact `Paper`s that drag from anywhere on the card, with no handle: a pointer drag
  starts after a few pixels of movement, so a click still opens the card, and Space picks a focused card
  up. A card that can't move (In progress, Blocked, Done) says why in a tooltip. The card's actions menu
  sits in its corner and keeps its own clicks and keys. Human columns sit left of the system columns.
  Open columns flex (`flex: 1 1 0`) between 260 and 380 px, so they fill the window and a card gets
  about 300 px; the board scrolls sideways only when the open columns can't fit at 260 px. An empty
  column folds to a 44 px rail: its label turned on its side and its count. The rail is the column's
  drop target, so it still takes a card. Ready stays open while empty, because its foot holds Add
  Task. The builder can collapse the human columns (Icebox among them) and Done with the chevron in
  the column's header, and open a rail again with the chevron on it; the choice is remembered per
  project in this browser (`localStorage`, `tendb.board-collapsed.<project id>`), not on the daemon.
  A card's face, top to bottom: the goal's title (small, dimmed, when the task is in a goal); the task's
  title (weight 500, at most three lines); the why (dimmed, `xs`, at most
  two lines, only when there is one); a status line (see Card state); and a row of indicators, only when
  the task has one. Areas, the criteria count, the landing line, the placement badge, the pull request and
  CI links, "Review sent back" and the shipped-at-limit line are not on the face: the task drawer holds
  them, and the card's screen-reader summary still speaks them. The indicator row is one component that
  takes a list of small labelled badges, so a new kind is another entry in the list: a shared branch (the
  batch has more than one task), CI passed or failed on a shipped pull request, waits on (the titles of the
  unfinished dependencies are its tooltip) and Cancelled.
- **Board depth:** depth comes from tone, not lines, and every tone is a Selenized background. A column
  with cards is a recessed tray (`--tendb-color-column`) under a header band of its own tone, with a soft
  `bg_1` edge; an empty column or rail is an unfilled dashed slot. Cards are the raised tone
  (`--tendb-color-card`) with no outline of their own. The pair swaps between schemes, because Selenized
  dark lightens from `bg_0` and Selenized light darkens: in dark the tray is `bg_0` and the card `bg_1`, in
  light the tray is `bg_1` and the card `bg_0`. The cards sit 20 px in from every side of the tray. The
  list draws no scrollbar; an end of it fades into the tray while cards are hidden past it, as the board's
  own sides fade while columns are. A column's footer (Add Task, Show All) sits 10 px from the tray's
  edges, wider than the cards, and Add Task is an unfilled dashed slot that takes the card tone on hover,
  so it never reads as a card.
- **Page panels:** a Settings page's tables and charts can sit on the raised panel tone
  (`--tendb-color-panel`, `bg_1` in both schemes) through `RaisedPanel` or a table's `backgroundColor`, so
  they stand off the page body. Settings › Models uses it; other pages adopt it one at a time.
- **Card state:** the card's border takes the status color (blue running, yellow waiting on you, orange
  paused, red failed, green done); a queued card's border is its own tone, so it shows none. No fill, no left stripe, no pulsing. A
  card waiting on the builder is the most prominent: a full 2 px yellow border. The card writes the state
  as a line with a dot, such as "Waiting on you: answer in Inbox", only when the color is yellow, red or
  orange, because only then does the builder have something to do or read. A failed task's line is the
  plain-words one below. Blue, green and gray cards show no line: the border and the column say it, and
  the screen-reader summary still does. A Sessions row follows the same states as a pill: a 1 px yellow ring
  waits on you, a 1 px red ring stopped on an error, and its one state mark sits at the row's right edge.
- **A failure in plain words:** a failed task says what happened and what Retry will do, in one line from
  `failureLine` (`task-state.ts`), the same on the card, in the task drawer and in Factory's Needs you block:
  "The review session stopped without reporting a result. Retry runs the review step again." The line is
  worded from the failure kind the daemon records, and its Retry half from the rule the daemon's retry
  follows, so after a review's rejection at the retry limit it names the earlier step that runs again. A run
  with no kind, or one this build doesn't know, gets a generic line. The raw reason is the line's tooltip
  on the card and in Factory, and is shown under the line in the drawer.
- **Task drawer:** a side panel, `min(640px, 50vw)` wide and never wider, so the Board stays visible beside
  it. Top to bottom: the title with the why under it (no line when there
  is none); **one status line** (the run's state,
  or the column's name once the run has finished; where the required checks stand; the Pull request and CI
  job links; the run actions Retry, Start over, Cancel Run, Close task, Start, Remove, Run Next and Hold);
  an alert only when the task needs the builder or has failed; then the tabs **Overview** (the default),
  **Reviews** (with a count of rounds) and **Edit**. There is no column badge and no separate links row.
  Overview reads What it promises (the criteria), Waits on (one task a line), Delivery (branch and Abandon) and the latest
  review. Only Edit holds the form and the sticky Cancel / Save Changes bar, so the drawer reads as a
  record when the builder came only to look; closing it with an unsaved edit still asks first. A Hold the
  daemon would refuse stays as a disabled button with its reason in a tooltip, and the reason never names
  the task.
- **Goal line:** the Board has no goal strips and no goal drawer; a goal's detail lives in Factory. Choosing a
  goal in the header's Goal select shows one compact line beside it: the status dot, "Idle · 4 in review ·
  1 ready", **Start Ready** and **Open in Factory ›**. With All goals selected nothing shows. A goal is never a
  card in a column: cards are tasks, and the columns stay about tasks. Each of a goal's task cards carries the
  goal's title as a small dimmed label, except while the Goal select shows that goal.
- **Goal status:** a goal says its status once, in a dot and one plain line, and the first match wins:
  failed (red: a goal task failed and isn't retried), waiting on you (yellow: an open Inbox card on one of its
  tasks), waiting on someone (yellow: a card owned by another person; from phase 3), paused (orange), running
  (blue: a goal task's run is active), shipping (blue: every task is done but a pull request isn't merged),
  idle (gray: some task has run or finished, and nothing runs or waits in the queue, such as "Idle · 4 of 8
  tasks merged · 4 in review"), not started (gray: no task in the goal has ever run, such as "Not started ·
  11 tasks"; the line states a fact, it gives no instruction) and done (green: every task not cancelled is
  done and merged). Gray is queued, idle and not started, so a goal nobody is running is gray, not blue.
  Progress counts merged tasks and in-review tasks apart ("6 of 11 tasks merged · 2 in review"), matching
  the Board's In review column: a task whose pull request is open is in review, never done. Green is only
  for work that has merged: a goal with open pull requests is Shipping, in blue, never green. A goal's
  Decisions are those its own tasks recorded, not every decision in the project.
- **Factory is one live list, not a section per project:** every project's runs in sections by what they need (Needs You, Failed, Running, In Review, Waiting, Done Today), each row a dot, the task, what it is doing, its project's tile and name and how long ago, a section with nothing in it left out (`decisions/2026-11-19-factory-is-a-live-list-across-projects.md`). Goals are a section under it, each project's under its name, only while a project has one; Metrics, a switch in the title row, holds Rigor, Human touch and Card types for one project. Within a project, goals are rows of one list separated by hairline dividers, and the open
  goal's area takes the `bg_1` fill. Rows take no borders and no shadows; cards stay the Board's draggable
  things. Each row is a button (`aria-expanded`) over a `role="region"`: title, status dot and one line, collapsed
  until opened, one open at a time. Order: failed, waiting on you, waiting on someone, paused, running,
  shipping, idle, not started, then done goals under one collapsed "Done (n)". News is plain text ("· 3 new since 3h ago"):
  no badge and no color.
- **An open goal has four zones, ordered by what the builder acts on:** a bar split by state with its counts
  ("0 merged · 4 in review · 1 ready · 3 not started"; green only for merged) and Start Ready Tasks; a
  Needs you block, drawn only when an Inbox card waits on a goal task or a run failed (a failure is said in
  `failureLine`'s words with its Retry); one Tasks list; then two collapsed lines, "Since you last looked (3h)"
  and "About this goal", and one dimmed `xs` footer line with the team and the cost. There are no label/value
  rows. The team names each persona once with its distinct `model@effort` ("Implementer opus@high,
  sonnet@medium · Reviewer opus@medium").
- **A task row** is a state dot, the title, its state, a pull request link
  and the last activity. Only a running row adds its step ("Implement 2/4 · sonnet") and context gauge; a
  failed row says "Failed" and Retry is in Needs you; the first ready task the digest names as next says
  "Ready · next", and a task that waits says "Waits on 2". Tasks that share a branch each carry a "Shared
  branch" tag and the pull request link shows once, on the first. A row goes to the Board with that task's
  drawer open and the Board filtered to the task's goal; a task not in a goal opens the Board unfiltered
  (work in no goal is the Factory's live list).
- **"Since you last looked"** holds the window's deviations and decisions, one clamped line each: session ids
  are dropped from the line and kept in its tooltip, and Show Earlier adds the rest.
- **Radius:** `md` everywhere.
- **Motion:** short eases, 150–200 ms, of opacity, color or shadow, for what appears as a side effect
  (an edge fade, a hint, a scroll shadow) and for drag feedback (the column a card would land in).
  Nothing moves for decoration.
- **Nudges:** a model's suggestion beside an input (Plan's fast-model nudges) is a `Button variant="subtle"
size="xs"` with a Tabler `sparkles` icon and an × to dismiss, at most two at once; never a badge or a color. A
  suggestion built by rules (Sessions' Start from) is not a nudge: it shows its source's icon, with no sparkles and
  no ×.
- **Fills:** the `bg_1` raised panel is the builder's own message. Code, command output, banners and read-only
  lines sit on `bg_0` with a 1 px `bg_2` border.
- **Diffs:** colored text on `bg_1`, changed words on `bg_2`, no tinted rows, and 10db's own gutter per hunk.
- **Agent output** renders as markdown through one component, by
  `docs/architecture/decisions/2026-11-13-agent-output-renders-as-hardened-markdown.md`, with a Selenized Shiki
  theme for code. **Tool calls** are rows, not cards; cards stay for what the builder answers.
- **Keys:** ⌘↩ sends in every composer; on Sessions, ⌘T (anywhere), ⌘W, ⌘⇧T, ⌘1–9, ⌘⇧[ ], ⌃Tab, ⌘J, ⌘⇧D (Changes) and Esc. A session's work bar answers 1 (Here) and 2 (On a New Branch).
- **Alerts:** an `Alert` is for something the builder must act on, such as a missing tool or a
  refused key. A condition that clears on its own, such as a rate-limited sync, is a dimmed
  `xs` line with an icon in the header of the view it affects.
- **Copy:** Title Case for buttons, menu items and the names of things, such as flows and columns
  ("Create Task", "Start Ready Tasks", "Quick"); sentence case for labels, descriptions and messages.
  A button or menu item never ends in "…", even when it opens a dialog; "…" is for work in progress
  ("Closing the pass…") and placeholders.
  Say what happened and what to do next.
- **Panel lists:** every panel's list is drawn alike. Its head is full width, edge to edge with the rows: a
  search (`PanelSearch`, `shell/panel-search.tsx`) on the switch's darker track tone with no border, 12 px above
  the first row. Rows are rounded, 12 px in from their edges, half a step up under the pointer and a full step
  when selected (`--panel-row-hover`, `--panel-row-selected`, set on the panel's body); two-line rows (the Inbox,
  the Workbench's pages) part with a hairline inset by the row's padding, which goes beside a filled row. A row's
  own controls (Dismiss, ⋯) show on hover and on the selected row.
- **Create buttons:** a button that makes a new thing in a list (Add Page, Add Task) is `CreateButton`
  (`shell/create-button.tsx`): a dashed slot with a + tile and the thing's name. Hovered, it fills, its border
  firms up and its + turns primary; pressed, it sinks a pixel. Never restyle a `Button` with a dashed border by hand.
- **Buttons:** one filled primary per group. A standalone secondary action is `variant="default"`
  (bordered, neutral); `subtle` only inside dense rows and menus; never `outline` beside a filled
  primary, where its colored border competes with it.
- **Counts:** a label never carries its count in parentheses ("Start Pass (2)", "Archived (3)"). A count
  of what is already on screen, such as the pills just picked, is left out. A count of what is hidden or
  waiting is a `CountBadge` (`apps/desktop/src/shell/count-badge.tsx`) in the control's `rightSection`, or
  beside the label in a control that has none; a row with a line of its own says it in words there ("4
  goals"). See `docs/architecture/decisions/2026-11-11-a-label-never-carries-its-count.md`. The Sessions badge
  counts the sessions that need the builder: Needs you and Stopped by an error, and Ready once M6 brings it.
  A count is a small pill no taller than its label's text, in the sidebar, on rows, tabs and in buttons (the
  Inbox's switch is the exception, below). It is muted
  (`tone` neutral, the default) and blue (`tone="attention"`) only when it means something needs the builder:
  Inbox's Open state, the Sessions and Workbench needs-you counts. The Inbox's Open count is the daemon's (the
  rows `GET /inbox/page` counts with no filter), and a filter or a search on the list never changes it
  (`decisions/2026-11-17-the-daemon-groups-inbox-rows-in-its-code-and-the-browser-groups-nothing.md`).
- **Inbox rows:** a row is two lines at a fixed height (64 px): the title, `×n` for rows that stand for several
  cards and the age; then the project and the first line of the body. A row carries no kind tag or icon: nearly
  every row would wear the same one, and the content's meta line names the kind. A hairline inset by the row's
  padding parts each row from the next and goes beside the hovered or selected row; there are no stripes, and the
  list has no scrollbar. The selected row's fill is its only mark: a focused row draws no outline. A flag's row
  offers Dismiss on hover, over the row's end, and `e` dismisses the selected one. The list keeps one row selected
  and its content is drawn beside the panel. The panel's head is the switch (Open, Waiting and Resolved), then the
  search, which searches the state chosen; only Open and Waiting carry a count, a plain dim number beside the
  label rather than a pill, since the segment already frames it. A notice, which asks nothing, is not in the
  Inbox: it is a row of the Factory's Activity drawer (the history button in its title row), the same two lines
  with an orange warning icon for a warning, opening in a drawer with no answer and no Dismiss.
- **Inbox content:** the selected card opens with its title (16 / 600) on a line of its own and one dim meta line
  under it: the kind's icon and name, the project, how many identical cards and how long ago (`card-header.tsx`).
  Its text keeps a 760 px measure. An answered card's buttons (a flag's, a question's, a permission's) are a bar held at the foot
  of the content, a hairline above (`card-actions.tsx`), so Dismiss and Send Answer stay in one place however long
  the card is; check, plan, drafted-question, 10db and pass cards keep their own buttons in their flow. A field's label
  never says "(optional)": the placeholder says Optional.
- **Page header:** a page has one header, the frame's title row (`TitleRow`,
  `apps/desktop/src/shell/title-row.tsx`), at the top of the content column on the content's own tone: the title
  at 14 px / 600 (a title can itself be the switcher, as a session's is), an optional dim meta line, then the actions at the right (28 px
  controls, `default` or one `primary`, then ⋯). Nothing in the content repeats it: no second title or byline that
  names the same thing and no heading larger than the title. Under it, at the top of the content, `PageIntro`
  (`apps/desktop/src/shell/page-intro.tsx`) holds at most one dim intro line (13 px, a sentence) and one toolbar,
  underlined tabs on the left and filters on the right, whose first label sits on the content's edge. A part that
  is absent takes no space. The type scale under the title: in-content section heads 14 / 600, card and row titles
  14 / 500, a drawer's title 16 / 600, body 14, meta 12. A split view's pane may have a 13 px / 600 label row with
  its own actions. Workspaces, where the content is the work, keep compact headers of their own: an open Workbench pass.
  Sessions' title row is the frame's: the session's title, which is the switcher (the title and a ⌄ as one quiet
  button that opens the session menu and takes the row up to the controls; rename is in ⋯), then the next git
  step (a filled xs button: Commit, Open Pull Request, Merge), the terminal button and ⋯. A thin dim strip under the composer holds
  the rest: the project and its place in git's words on the left ("acme-web · on `main`", or only the project
  while the session has changed nothing), then the agent (its tooltip says what it is), the context ring and the
  change count ("+41 −6", which opens Changes). The composer lists no keys. The panel lists sessions by project, one 32 px row each: its title and one
  mark, with no place icon (where it works is the strip's line). A fresh tab reads New Session, with a +, in the
  create button's dashed slot and no ×; a fresh tab whose project is gone is dropped, and a removed project's
  sessions group under "Removed project". A project is a folder row as tall and wide as a session row, open or closed
  with no chevron or count, dim while folded; its sessions sit indented under its name. The fold is kept per window,
  and a folded group still shows the selected session. The switcher lists sessions, not fresh tabs, and
  the title row's ⋯ leaves Open in Terminal to the terminal button beside it; there is no tab strip. A session reads freely, and the
  first time it goes to change files a bar above the composer asks **Here, on `<branch>`** or **On a New
  Branch**; Changes opens as a drawer from the right.
- **Surfaces:** the frame is the bar (the top 44 px, carrying the traffic lights, the sidebar button and each
  column's head) and the rail down the left, one `bg1` surface with no line between them. The section's panel and
  the content sit together in one rounded box (10 px corners) under the bar, 4 px short of the window's right and
  bottom edges; its edge is one 1 px `bg2` hairline and one faint 3 px inner shade, and inside it the panel is half
  way from `bg1` to `bg0` and the content `bg0`, divided by a hairline
  (`docs/architecture/decisions/2026-11-19-the-content-sits-in-a-rounded-box.md`). Nothing else on the frame
  casts a shadow: sheets (the sidebar over the content in a narrow window) and drawers do, and a conversation's
  header or the title row takes a 1 px hairline while content scrolls under it. Cards on the content do not wear a
  border and a shadow as well. A control sits on `bg1` in both schemes (`theme.ts`).
- **Drawers:** one slide-out kind, `SurfaceDrawer` (`apps/desktop/src/shell/surface-drawer.tsx`), from the
  content's right edge, inside the box: half the column, 480 to 760 px, all of it under 640 px, in the
  content's tone with a 1 px `bg2` left edge and the sidebar sheet's shadow cast left onto the view, 24 px insets, no eyebrow and a 16 px / 600 title. It slides in over 150 ms (at once with reduced motion), is not modal, and closes with
  Esc inside it or its ×.
- **Loading:** a page draws its header first, since the title and byline are known before the data. After 300 ms
  of waiting, quiet placeholder rows in the shape of what is coming take the content's place
  (`PageLoading`, `apps/desktop/src/shell/page-loading.tsx`: a list, cards or transcript lines), always static,
  with no shimmer, and no wider than 720 px. A page never shows a lone spinner as its whole content; a spinner
  stays inside a button or a row.
- **Picking several from a list that is bounded** (a project's pages, which the builder reads whole) is tickable
  rows, each a checkbox named by the item, with its detail on the same line and why it can't be picked under it
  (`views/workbench/page-list.tsx`).
- **Picking several from a list that grows without bound** is one searchable `MultiSelect`: each option shows what tells
  it apart (a route, when it last changed), an option that can't be picked stays in the list, disabled, with
  the reason under it, and the pills show what is picked. A list that grows never gets a column of checkboxes under a separate
  filter box.
- **Checks** mark the chosen row on the right, in `Select`, `MultiSelect`, `Combobox` and `Menu` alike.
- **Forms:** textareas autosize and start small (one or two rows). The actions sit `xl` below the last
  field. A field's error goes on the field; a submit's error goes beside its submit button, never
  above the form where it can be scrolled away.
- **Modals:** a form modal is centered, with a header and a footer of actions that stay put while its
  body scrolls.
- **Navigation:** the sidebar's rail holds the sections, global ones above the project's, with Settings at the
  foot. It is labelled (200 px) and ⇧⌘S switches it to icons only (76 px, each name in a tooltip), remembered. The
  active row fills with `bg2`; hover is half of it. The project is a row of its tile and name (a tile alone when
  icons only). A section with a list has a panel beside the rail (340 px, dragged between 240 and 480) (Settings' sections, the Inbox's rows and, while a
  pass is open, the Workbench's queue: the Workbench has a panel only then), whose head
  is the sidebar's top row with the section's name and controls. From 1000 px both show and ⌘\, a click on the
  open section's rail item or the head's button hides the panel. From 640 px the rail is icons only and ⇧⌘S opens the
  labelled sidebar over the content, ⌘\ the panel beside the icons; under 640 px the sidebar folds and the toggle
  beside the traffic lights opens it. The title row sits at the top of the content, level with the traffic lights,
  44 px tall. When the panel is not shown, the Workbench's queue becomes a strip across the top of the content,
  and the title row names the open page.
- **Tooltips:** the bright ink on the base tone in both schemes, 12 px and tight (`theme.ts`); a view never styles
  its own. A view with unsaved edits asks before anything discards them (`shell/unsaved-guard.tsx`).
- **Scope follows the question, not the screen**
  (`docs/architecture/decisions/2026-11-09-scope-follows-the-question.md`). A view that answers "what needs
  me?" or "what is running, and on what?" is global: the Inbox and Factory. They show every project and
  narrow by a visible project filter, never by the project chosen elsewhere. A view of how one repo's work
  is shaped belongs to a project: Board, Plan, Knowledge and the project's settings. Sessions is global too:
  its panel lists sessions across projects, each under its own. The sidebar reads in that order: Inbox, Factory and Sessions; then a "Project" label over the project switcher and that project's Board,
  Plan, Knowledge and Project Settings; then app-wide Settings at the foot. The Settings sidebar keeps the
  same order (Back to Board, the project's sections, then the app-wide ones), one scope at a time: a "This
  Project" / "All Projects" switch under Back to Board picks which half the sections list shows, under subheads,
  so the list fits 1280×720.
- **Tables:** the identifying column (a name, a title) takes the spare width; numeric columns are
  right-aligned. A status is dimmed text after the
  name, never a pill, in a dense list. Violet marks a role's pick in Settings › Models; orange stays
  paused.
- **Accessibility:** the builder is the only user, so accessibility and narrow windows are not work unless
  they ask. jsx-a11y lint still runs; no axe checks are added, and an existing one that blocks a change may go.
