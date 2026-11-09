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
  "OK" color; don't use cyan or teal for success. Every Inbox card waits on the builder, so its kind
  is yellow, a flag's too: red there would read as an error.
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
  A card's face, top to bottom: the goal's title (small, dimmed, when the task is in a goal); the headline,
  or the title when the headline is empty (weight 500, at most three lines); the why (dimmed, `xs`, at most
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
- **Card state:** the card's border takes the status color (blue running, yellow waiting on you, orange
  paused, red failed, green done); a queued card's border is its own tone, so it shows none. No fill, no left stripe, no pulsing. A
  card waiting on the builder is the most prominent: a full 2 px yellow border. The card writes the state
  as a line with a dot, such as "Waiting on you: answer in Inbox", only when the color is yellow, red or
  orange, because only then does the builder have something to do or read. A failed task's line is the
  plain-words one below. Blue, green and gray cards show no line: the border and the column say it, and
  the screen-reader summary still does.
- **A failure in plain words:** a failed task says what happened and what Retry will do, in one line from
  `failureLine` (`task-state.ts`), the same on the card, in the task drawer and in Factory's Needs you block:
  "The review session stopped without reporting a result. Retry runs the review step again." The line is
  worded from the failure kind the daemon records, and its Retry half from the rule the daemon's retry
  follows, so after a review's rejection at the retry limit it names the earlier step that runs again. A run
  with no kind, or one this build doesn't know, gets a generic line. The raw reason is the line's tooltip
  on the card and in Factory, and is shown under the line in the drawer.
- **Task drawer:** a side panel, `min(640px, 50vw)` wide and never wider, so the Board stays visible beside
  it. Top to bottom: the headline (the title when there is none) with the why under it (no line when there
  is none; with no headline a dimmed "Add a headline" link opens Edit); **one status line** (the run's state,
  or the column's name once the run has finished; where the required checks stand; the Pull request and CI
  job links; the run actions Retry, Start over, Cancel Run, Close task, Start, Remove, Run Next and Hold);
  an alert only when the task needs the builder or has failed; then the tabs **Overview** (the default),
  **Reviews** (with a count of rounds) and **Edit**. There is no column badge and no separate links row.
  Overview reads What it promises (the criteria; the title above them only when there is a headline, so the
  title shows once outside Edit), Waits on (one task a line), Delivery (branch and Abandon) and the latest
  review. Only Edit holds the form and the sticky Cancel / Save Changes bar, so the drawer reads as a
  record when the builder came only to look; closing it with an unsaved edit still asks first. A Hold the
  daemon would refuse stays as a disabled button with its reason in a tooltip, and the reason never names
  the task.
- **Goal line:** the Board has no goal strips and no goal drawer; a goal's detail lives in Factory. Choosing a
  goal in the header's Goal select shows one compact line beside it: the status dot, "Idle · 4 in review ·
  1 ready", **Start Ready…** and **Open in Factory ›**. With All goals selected nothing shows. A goal is never a
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
- **Factory is one list, not cards:** goals are rows of one list separated by hairline dividers, and the open
  goal's area takes the `bg_1` fill. Rows take no borders and no shadows; cards stay the Board's draggable
  things. Each row is a button (`aria-expanded`) over a `role="region"`: title, status dot and one line, collapsed
  until opened, one open at a time. Order: failed, waiting on you, waiting on someone, paused, running,
  shipping, idle, not started, the Not in a goal row, then done goals under one collapsed "Done (n)". News is plain text ("· 3 new since 3h ago"):
  no badge and no color.
- **An open goal has four zones, ordered by what the builder acts on:** a bar split by state with its counts
  ("0 merged · 4 in review · 1 ready · 3 not started"; green only for merged) and Start Ready Tasks…; a
  Needs you block, drawn only when an Inbox card waits on a goal task or a run failed (a failure is said in
  `failureLine`'s words with its Retry); one Tasks list; then two collapsed lines, "Since you last looked (3h)"
  and "About this goal", and one dimmed `xs` footer line with the team and the cost. There are no label/value
  rows. The team names each persona once with its distinct `model@effort` ("Implementer opus@high,
  sonnet@medium · Reviewer opus@medium").
- **A task row** is a state dot, the headline (the title when it has none), its state, a pull request link
  and the last activity. Only a running row adds its step ("Implement 2/4 · sonnet") and context gauge; a
  failed row says "Failed" and Retry is in Needs you; the first ready task the digest names as next says
  "Ready · next", and a task that waits says "Waits on 2". Tasks that share a branch each carry a "Shared
  branch" tag and the pull request link shows once, on the first. A row goes to the Board with that task's
  drawer open and the Board filtered to the task's goal; a task not in a goal opens the Board unfiltered
  (the Not in a goal row still lists sessions).
- **"Since you last looked"** holds the window's deviations and decisions, one clamped line each: session ids
  are dropped from the line and kept in its tooltip, and Show Earlier adds the rest.
- **Radius:** `md` everywhere.
- **Motion:** short eases, 150–200 ms, of opacity, color or shadow, for what appears as a side effect
  (an edge fade, a hint, a scroll shadow) and for drag feedback (the column a card would land in).
  Nothing moves for decoration.
- **Nudges:** a model's suggestion beside an input (Plan's fast-model nudges) is a `Button variant="subtle"
size="xs"` with a Tabler `sparkles` icon and an × to dismiss, at most two at once; never a badge or a color.
- **Alerts:** an `Alert` is for something the builder must act on, such as a missing tool or a
  refused key. A condition that clears on its own, such as a rate-limited sync, is a dimmed
  `xs` line with an icon in the header of the view it affects.
- **Copy:** Title Case for buttons, menu items and the names of things, such as flows and columns
  ("Create Task", "Start Ready Tasks…", "Quick"); sentence case for labels, descriptions and messages.
  Say what happened and what to do next.
- **Buttons:** one filled primary per group. A standalone secondary action is `variant="default"`
  (bordered, neutral); `subtle` only inside dense rows and menus; never `outline` beside a filled
  primary, where its colored border competes with it.
- **Checks** mark the chosen row on the right, in `Select`, `MultiSelect`, `Combobox` and `Menu` alike.
- **Forms:** textareas autosize and start small (one or two rows). The actions sit `xl` below the last
  field. A field's error goes on the field; a submit's error goes beside its submit button, never
  above the form where it can be scrolled away.
- **Modals:** a form modal is centered, with a header and a footer of actions that stay put while its
  body scrolls.
- **Navigation:** nav links take the `md` radius, so their hover and active fills are rounded pills
  inset from the sidebar's edge. The fill marks where you are; no outline on each item.
- **Tables:** the identifying column (a name, a title) takes the spare width; numeric columns are
  right-aligned.
- **Accessibility:** jsx-a11y strict passes; every interactive control is reachable by keyboard and
  has a visible focus ring; axe runs in Playwright tests (M1b) with every rule but `color-contrast`,
  since contrast is whatever Selenized gives.
