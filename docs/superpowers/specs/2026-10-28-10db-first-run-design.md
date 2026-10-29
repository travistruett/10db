# 10db first run, board and settings: the UI agreed on 2026-10-28

**Status:** written on 2026-10-28 from the builder's walk through 10db from an empty data dir, without the
builder present, then revised after a plan-reviewer pass (Fable). Every UI decision here was made with the
builder during that walk and is logged in `scratch/ux-feedback-2026-10-28.md` (cited as "item N"); where this
spec made a call the builder had not, it was listed in §14; the builder has since answered each one.
**Extends:** `2026-10-13-10db-factory-loop-design.md` §10 (UI) and `2026-10-17-10db-accounts-design.md` (the
identity check). **Keeps:** the batch delivery, lane sandbox and worktree mode specs unchanged, except the
optional gate (§9.4), which changes when a task counts as done.
**Reference sketch:** the throwaway branch `spike/first-run-wizard` holds a working sketch of everything in
§4–§8 (`git diff origin/main...spike/first-run-wizard -- apps/desktop`). It has no tests and fakes what the
daemon can't yet answer. This spec describes the product to build properly; the sketch shows how it looks.

Each part is marked:

- **Built:** on `main` today.
- **Sketched:** on the spike only; rebuilt with tests.
- **Designed:** neither; new work.

## 1. Intent

A fresh install opens on an empty Board with a project form that asks for a gate command, glob areas, a
handoff percentage and a PR title prefix. Nothing explains what any of them is, nothing checks that Claude
Code, git or gh are there, and the words ("lane", "batch", "delivery", "handoff", "areas") assume the user
has read the design. Once a project exists, the Board repeats itself (a "Board" title, a path and gate
line, a separate project picker), its columns are short boxes, and a card can only be dragged by a small
handle and never opened.

**Success means:**

1. A person who has never seen 10db opens it, confirms the Claude login it found, picks a folder in the
   native panel, accepts the detected check command, and lands on a Board with one project, in about a
   minute, without typing a path, a glob or a commit prefix.
2. Setup asks only what 10db can't work out: which folder, whether the detected check is right, and
   whether finished work becomes a pull request or a commit. Everything else defaults and lives in
   Settings.
3. A project with no check command works: each finished task waits for the builder to look at it instead
   of counting as done on the agent's word.
4. The Board shows the project's work and nothing else: no title, no metadata line, full-height columns,
   cards that open their details on click and drag from anywhere on the card.
5. Settings reads as a list of plain-words settings, grouped by what they affect, with the project's
   sections separate from the global ones.
6. `DESIGN.md` states every rule this UI follows, so the next view follows it without the walk.

**Non-goals:** the shaping flow (chat, screenshots and files into tasks; goals), areas proposed from the
repository's structure, per-task placement (your folder vs a separate copy per task), Codex as a second
agent, a Models section, voice capture. Each is in §13.

**Anti-goals:** running anything from the chosen repository to detect its setup (no `make -n`, no
`npm run`, no reading files through a shell); a first run that can't be finished without the builder
knowing 10db's vocabulary; a task that counts as done because the agent said so.

## 2. Words

The UI uses the plain word until the user meets the concept where it acts (item 26). The daemon's
names don't change.

| Daemon / docs          | UI says                                                                     | Where the user meets it   |
| ---------------------- | --------------------------------------------------------------------------- | ------------------------- |
| delivery               | "When work is finished": "Open a pull request" / "Commit directly"           | first run, Settings       |
| batch (start)          | "Start Ready Tasks…" (the menu item; the sheet's own copy is queue task 3's)  | Board menu                |
| lane                   | "task"; "Most tasks at once"; "while tasks run"                              | Settings, header          |
| handoff %              | "Fresh session: when a session's memory is this full…"                       | Settings                  |
| workspace mode         | "Where tasks work": "Your folder" / "Separate copies"                        | Settings                  |
| worktree seed          | "Copy into each task's copy"                                                  | Settings                  |
| gate command           | "Gate command": "the command that checks the work"                           | first run, Settings       |
| areas / hazards        | explained in one line where they appear (item 45, 53)                         | New Task, Settings        |
| system column          | its hint line ("Waiting on another task to finish.")                          | Board                     |
| flow keys              | Title Case names ("Quick", "Standard", "Full") with steps as a byline         | drawer, Settings          |

## 3. Decisions

| #   | Decision | Why |
| --- | -------- | --- |
| F1  | With no projects, the window shows the first run instead of the app shell. It has three steps: Welcome, Check your setup, Add a project. There is no review step. | Item 1, 31. A review step repeated what the user had just chosen. |
| F2  | "Continue" from Check your setup needs Claude Code and git found; it shows the login tasks will run as, and asks for no confirmation. gh is optional. | Nothing runs without Claude Code or git. The default account's login doesn't need the builder: the account preparer records it from its first probe and raises an information card (`accounts/preparer.ts`, `recordedCard`), so a first task never stalls on it. Without gh only "Commit directly" is possible, which still works. Decided by the builder (§14). |
| F3  | The project folder is chosen in the native folder panel (Tauri's dialog plugin) and inspected by the daemon, which reports the repository's root, branches, default branch, remote and candidate gate commands. The browser UI types the path. | Item 16, 17, 21, 22, 25. A web page never gets a picked folder's absolute path. The UI must not guess what a folder holds. |
| F4  | Inspection reads a few files as data and runs only the daemon's own read-only git, outside the pin and trust machinery; nothing from the repository runs, and it raises no card. | The folder isn't trusted until it is a project; the security rule in `apps/daemon/AGENTS.md` forbids running repository code on the host. A folder the builder may never add must not produce trust cards. |
| F5  | The gate command is optional. With none, a task whose last step finishes waits for the builder with a "Ready for you to check" card showing its diff, and counts as done only when the builder approves. A pull request then ships without a gate step. | Item 18, 25, 32, 109. The agent never judges its own work done; a missing check moves the judgment to the builder instead of failing setup. |
| F6  | A task waiting for that check is `WAITING_HUMAN` with no session, a new next action `builder_review`, and a targeted Inbox card of a new kind `check`; the workflow gains the edges `VERIFYING → WAITING_HUMAN` and `WAITING_HUMAN → VERIFYING`. No new workstream state. | The Board already shows `WAITING_HUMAN` as Blocked ("waiting on you"), and recovery already parks a workstream on a card that targets it. A new state would need the same edges plus a Board column mapping and every exhaustive switch. The existing `review` card is raised after DONE and means something else, so this one is its own kind. |
| F7  | Setup asks for: folder, name (prefilled), gate command (detected), account (only when there is more than one), "When work is finished", and base branch (only under pull requests, chosen from the folder's branches). Everything else takes its default and lives in Settings: one area `repo` over `**`, handoff 40 %, shared workspace, no flow, no budget. | Item 15, 28, 29, 30, 64. Each removed field confused the builder in the walk; none needs an answer before the first task. |
| F8  | The pull request title prefix is never shown in setup. While `ProjectInput` requires a prefix for pull request delivery (`entities.ts`, the refine), setup sends `feat` with a pull request choice; once queue task 3 lifts that rule, setup sends nothing and Settings shows the prefix as an optional override. | Item 27, 30, 104. One prefix per project mislabels most PRs. |
| F9  | The first run and the "New Project" modal share one form (`useProjectSetup`): the same fields, submit and errors. The old `new-project-form.tsx` is deleted. | Item 64. Two forms drifted within a day. |
| F10 | The current project is switched from the top of the sidebar (a searchable list with paths, ending in "New Project"). No view has its own project picker or a page title. | Item 34, 35, 36, 41, 63. The nav says where you are; the switcher says which project. |
| F11 | Settings takes over the sidebar: "Back to Board", a "Project" group headed by a compact switcher, a "Global" group (was "App"). Planned sections are hidden. Each section is cards of rows: name and one line on the left, the control on the right. | Item 70, 71, 72, 73, 75, 83. Direction A of three mockups; VS Code's split of project vs global without its scope toggle. |
| F12 | A whole board card drags (no handle) and a click or Enter opens its details in a right-side drawer. Space picks a focused card up for a keyboard drag. | Item 93, 94. The handle crowded the title and couldn't be found; clicking a card did nothing. |
| F13 | Board columns fill the window's height, are dashed while empty with one hint line on what lands there, and have a fixed 40 px header band. The lock icon goes. | Item 39, 40, 42, 51. |
| F14 | "New Task" is a split button whose menu holds "Start Ready Tasks…" (with the Ready count) and "Add Column…". | Item 37, 44, 98. |
| F15 | Short eases are allowed for what appears as a side effect and for drag feedback: opacity, color and shadow, 150–200 ms. | Item 59, 60, 61. "No motion" made fades snap and drop targets flicker. |
| F16 | One hook, `useHiddenEdges`, reports which edges of a scroll container have content hidden past them; the board fades those edges and the form modal casts scroll shadows. | Item 58, 66, 69. Two copies of the same measuring code existed on the spike. |
| F17 | A crash that escapes every view shows a root error page that clears the window's traffic lights and offers Try Again and Reload Window. | Item 23. TanStack's default rendered under the traffic lights. |
| F18 | `DESIGN.md` gains the rules in §10 in its own docs PR, before this build. | Item 61. The rules bind every view, not just these. |

## 4. First run

**Sketched**, except where a row says otherwise.

The first run replaces the app shell while `GET /projects` answers an empty list (F1). While the list is
loading, or the daemon is connecting or reconnecting, the shell shows as today (its banners say why); the
first run appears only once the list has loaded empty. A 48 px strip at the
top drags the window and clears the traffic lights. A 290 px left rail holds the logo (`app-icon.svg`,
**designed**: the sketch has a placeholder) and a vertical `Stepper`; a done step can be clicked to go
back, a later one can't. The right side scrolls its content above a footer bar pinned to the bottom: a
submit error at its left, Back (`default` variant) and the primary action at its right ("Get Started",
"Continue", "Create Project"). No max width on the content (item 3).

### 4.1 Welcome

`h2` "Welcome to 10db" and one dimmed line: "Run Claude Code on your repositories, from task to pull
request. Setup takes about a minute."

### 4.2 Check your setup

Two cards with the same shape (item 9, 10, 12): an `h4` heading with one `default` "Recheck" in its header,
then one row per item (a status mark, the name at `sm`/500, one dimmed detail line, and any actions under
it).

**Agents** (Codex joins later). One row, Claude Code:

| What the probe finds | Mark | Detail | Actions |
| --- | --- | --- | --- |
| no `claude` where 10db looks (`findClaude`: the install prefixes, `~/.local/bin`, `~/.claude/local`; never the login PATH) | red | "Not found in <the places, as `INSTALL_PREFIXES_TEXT` lists them, plus the two home folders>. Install Claude Code, then recheck." | none |
| probe running | gray | "Starting Claude Code to read the account…" | none |
| signed in (confirmed or not yet recorded) | green | "Signed in as <email>. Tasks run as this login.", with " · <organization>" after the email unless it is the personal default "<email>'s Organization" (item 14) | Add Another Login |
| any other refusal | red | the refusal's message | Add Another Login |

The identity probe (`GET /accounts/:id/identity`, **built**) starts Claude Code, so it runs once on entering
the step and again on Recheck, never on every render. Nothing in the first run patches the account: the
preparer records the default login on the first task (F2). "Add Another Login" opens the existing Add
Account modal (`accounts/add-account-modal.tsx`, **built**), which adds an account and its sign-in steps
without touching the default; the first run never offers to switch the default login, which is
`~/.claude`, the terminal's own (accounts spec §3). Once a second account exists, Add a project shows its
Account select (item 8); there is no other per-project login choice in the first run.

The footer shows, left of Continue on this step, one dimmed line naming the login tasks will run as: "Tasks
will run as <email>." (nothing while the probe runs or fails).

**Tools.** git (required): green with its version, or red "Not found in <`INSTALL_PREFIXES_TEXT`>." GitHub
CLI (optional): green "<version>, signed in as <login>"; yellow "Not signed in. Run `gh auth login` in a
terminal, then recheck." (**designed**, §9.3); yellow "Not found. Needed only for pull requests." Recheck
calls `GET /system?recheck=1`.

"Continue" is enabled when F2 holds. Docker isn't shown: nothing in the first task needs it.

### 4.3 Add a project

Only the folder control shows until a folder is chosen (item 15, 22):

- **Tauri:** one primary "Choose Folder…" opening the native panel (`directory: true`), with an "or type a
  path" link beside it that swaps in the browser's path input (item 22). Once a folder is chosen, the
  inspected `root` shows once, monospace, in a bordered box with a "Change" button. No label. The native
  panel needs Tauri's dialog plugin (**designed**: a pinned Rust crate and npm package, the
  `dialog:allow-open` window capability, and a decision file if the pin is held back for the supply-chain
  minimum age, as `2.8.3` was on the spike).
- **Browser:** a monospace path input with the placeholder `/Users/you/Projects/app`; it inspects when the
  input loses focus or Enter is pressed.

Choosing a folder calls `POST /folders/inspect` (**designed**, §9.1). While it runs the fields below stay
hidden and the box shows a loader. A refusal shows on the folder box, in red, with its message ("This
folder isn't a git repository.", "<name> is already a project.", …), and nothing else appears. The box
always shows the inspection's `root`, the repository's real top level: when it differs from what was
picked (a subfolder, or a path through a link), one dimmed line under it says "The repository's top
folder."

Then, in order:

1. **Name**, prefilled from the inspection's suggested name (the root folder's name) until edited.
2. **Gate command** (**designed** detection; the sketch has a plain input). Description: "The command that
   checks the work, such as your tests. A task counts as done only when it passes." The best candidate is
   prefilled; every candidate shows as a pill under the input (clicking one fills it), each with its source
   as a tooltip ("from Makefile", "from package.json"). With no candidate the input is empty. Until the
   optional gate (§9.4) is built, an empty gate is a field error, "Enter the command that checks the
   work", and Create Project stays disabled; once it is built, the line under an empty input says "No
   check found. Leave it empty and you'll check each finished task yourself." and an empty value is sent
   as `null`. The value is monospace; the label isn't (item 20).
3. **Account**, only when there are two or more unarchived accounts (`AccountSelect`: name in the field,
   "email · kind" as each option's byline, item 87).
4. **When work is finished**, two radio cards (item 19, 26):
   - "Open a pull request": "10db works on a separate branch and opens a pull request on GitHub for you to
     review and merge." Disabled, with the reason as its line, when gh is missing or signed out ("Needs the
     GitHub CLI, signed in.") or the folder has no GitHub remote ("This folder has no GitHub remote.").
   - "Commit directly": "10db commits straight to the branch checked out in this folder. Nothing goes to
     GitHub."
   Preselected: pull request when it is possible, else commit directly.
5. **Base branch**, only under pull requests: a searchable `Select` of the folder's branches (origin's
   first), preselected to `defaultBranch` (**designed**; the sketch types `main`). Description: "Pull
   requests start from and merge into this branch." With no branches (a repository with no commits)
   "Open a pull request" is disabled with "This repository has no commits yet." A `defaultBranch` of null
   with branches present preselects nothing and the field is required.

"Create Project" is enabled once a folder passed inspection, the name is non-empty and the gate rule
above holds. It sends F7's defaults and F8's prefix. A refusal from `POST /projects` shows in the footer,
left of the buttons, prefixed "Couldn't create the project:" (item 33). On success the project is selected
and the window navigates to `/board` (the index route still redirects to `/factory` otherwise).

## 5. Shell

### 5.1 Sidebar

**Sketched.** The sidebar sits one Selenized step above the content: its background is the controls' color
(bg_1), and its hover and active fills move up a step (bg_2) through navbar-scoped CSS variables (item 70,
71). Nav links have the app's radius, so fills read as rounded pills inset from the edge (item 56); the
active link's label is bright text at weight 600, not the primary color (item 76).

At its top, the **project switcher** (F10, item 41, 43): a nav-styled button with the project's tile (two
letters on a blue `Avatar`), its name and a selector icon. It opens a 300 px `Combobox` with a search field
("Find a project"; matches name or path), one option per project (tile, name, `~`-relative path, a check on
the right for the current one), and a footer with a full-width `default` "New Project" that opens the shared
project form in a `FormModal` (F9). Below it a divider, then Board, Factory, Inbox (with its count) and
Settings. `shell/project-picker.tsx` is deleted.

### 5.2 Header

**Sketched.** The keep-awake menu has no label; its three options ("Never", "While tasks run", "Always")
say it, with the check on the right (item 54, 55).

### 5.3 Shared pieces

| Piece | What it does | Status |
| --- | --- | --- |
| `shell/form-modal.tsx` `FormModal` | `Modal.Root` composed so the body scrolls between a fixed header and a fixed footer; the footer holds the submit error left and the actions right; centered; the header and footer cast a soft shadow (200 ms) while content is hidden past them (item 65–69). Panel styles go through `styles.content`, never `style` on `Modal.Content`. | Sketched |
| `shell/use-hidden-edges.ts` `useHiddenEdges` | Given a scroll element (tracked by callback ref, since Mantine attaches panels after mount), reports `{top, bottom, left, right}` hidden flags from scroll position and a `ResizeObserver` on the element and its first child; one pixel of slack. | Designed (F16) |
| `shell/split-button.tsx` `SplitButton` | A filled button joined to a chevron `ActionIcon` that opens a `Menu`; the seam is a 1 px border in the body color; the chevron has an `aria-label`. | Sketched |
| `shell/project-tile.tsx` `ProjectTile` | The two-letter tile, 24 px (16 px compact). | Sketched |
| `shell/app-error.tsx` `AppError` | The root route's `errorComponent` (F17): drag strip, a red `Alert` with the message in a code block, Try Again (resets) and Reload Window. | Sketched |
| `views/board/field-help.tsx` `LabelWithHelp` | A label with an info icon whose hover card explains the field; a visually hidden "About <label>" for assistive tech. | Sketched |
| `views/board/flow-select.tsx` `FlowSelect` | Flows by Title Case name, fewest steps first, each option's steps as a byline ("Build → Review"). | Sketched |
| theme `components` | `Select`/`MultiSelect` `checkIconPosition: 'right'`; `Switch` `withThumbIndicator: false` (item 110); `NavLink` radius and active weight. | Sketched |

The sign-in steps' copy icon centers vertically on its command (item 7): one line on the spike, carried
over as is.

## 6. Board

**Sketched**, except where noted.

- **No title, no metadata line, no "No tasks yet"** (item 35, 36, 41). A right-aligned toolbar holds the
  `SplitButton` "New Task" (F14). Its menu: "Start Ready Tasks…" with "N ready" (or "Nothing in Ready",
  disabled) as a dimmed count on the label's baseline, inside the item rather than as its right section
  (item 44), opening today's batch sheet unchanged (its copy and fields are queue task 3's); and "Add
  Column…", which opens Settings → Board columns.
- **The board fills the window below the header**, and its columns fill the board's height (F13).
- **Columns** are 240 px wide with the app's radius, a 1 px border that is dashed while the column is empty
  and solid once it holds a card. Each has a 40 px header band in the controls' color with the name (`sm`,
  600) and the count as a dimmed number (a light badge vanishes on bg_1, item 51). An empty column shows one
  dimmed `xs` line under the band from `column-hints.ts` (item 42, 90):

  | Column | Hint |
  | --- | --- |
  | Backlog | Waiting on another task to finish. |
  | Ready | Next up. Start Ready Tasks picks from here. |
  | In progress | Being worked on now. |
  | Blocked | Waiting on you, paused at a limit, or failed. |
  | Done | Finished or cancelled. |
  | a human column | Parked. 10db won't start these until you move them. |

  Ready ends in a dashed `default` "Add Task" button: a new task with nothing to wait on lands in Ready
  (item 41). Done keeps its "Show all N" past its limit.
- **Horizontal scroll** (item 50, 57, 58): the columns sit in a `ScrollArea` with `type="hover"`,
  `offsetScrollbars="x"`, a 12 px bar and 12 px of room above it. While columns are hidden past an edge, a
  56 px gradient into the body color covers that edge; it stays mounted and eases its opacity over 200 ms
  (item 59). It uses `useHiddenEdges`.
- **Cards** (item 93): 12 px padding, 8 px between rows. The title takes the full width and wraps; the
  card's menu sits in the top-right corner and stops its own clicks and keys from reaching the card. Under
  the title: the task's areas as light gray labels and "N criteria" dimmed; "Cancelled" when cancelled;
  "Waits on <titles>" when it has unfinished dependencies; the workstream's state and step while one is
  active or failed; the pull request link once shipped. How a running task's state reads is queue task 9's,
  not this spec's.
- **Drag** (F12, item 93, 95): the card is one `role="button"` element. A pointer drag starts after 4 px of
  movement, so a click still opens. Space starts a keyboard drag; Enter opens. A card that can't move (in
  progress, blocked, done, or held by a started dependent) gets a pointer cursor, its refusal as a
  tooltip, and the same refusal as its accessible description (`aria-describedby`), so a keyboard user
  hears it on focus; it doesn't start a drag. While dragging, a `DragOverlay` portaled to the body draws the card
  above every column (no column clips it) and the card's place shows as a 30 % opacity slot. The column
  under the card gets an inset 2 px primary outline and a light primary fill, eased over 150 ms, only when
  the drop rules (`resolveDrop`) would move or start the card there; a column that would refuse stays plain
  (item 60). The click that ends a drop doesn't open the card.
- **Batch strips and history** stay as they are on `main` until queue task 9 replaces them.
- **New Task** opens in a `FormModal` (§7.2).

## 7. A task's details

### 7.1 The task drawer

**Sketched** (item 94, 96). Clicking a card, or Enter on it, opens a 520 px right `Drawer` titled "Task":

1. **Title**, a borderless-looking `md` input at weight 600.
2. A row of labels: the column the card is in (its human column's name or the state column's label), the
   task's areas, and "Waits on <titles>".
3. **Description**, autosizing (2–12 rows).
4. **Acceptance criteria**, autosizing (2–16 rows), one per line, with the description "One per line. A
   reviewer agent checks each one and asks for a test that proves it." Queue task 4 replaces it with a
   list editor.
5. **Flow**, a clearable `FlowSelect` with the placeholder "Project default".
6. **Risks**, a `MultiSelect` with plain labels: Security, Sign-in and permissions, Database migration,
   Dependencies. Its description: "Security, sign-in or migration work gets a review of the plan before any
   code."

A footer pinned to the drawer's bottom holds the error on the left and Cancel and "Save Changes" on the
right. Save sends `PATCH /tasks/:id` (**built**) with the five fields, after checking the title is
non-empty and there is at least one criterion. Areas and dependencies are read-only: there is no patch
route for them (§13). Saving is allowed while the task runs; a session reads the task when it starts, so
while a workstream is active the footer's left side says "Changes apply from the task's next session."
Closing with unsaved edits (the close button, Escape, Cancel or a click outside) asks first, in a small
centered modal: "Discard your changes to this task?" with "Keep Editing" (default) and "Discard"; with
no edits it closes at once.

### 7.2 New Task

**Built** with sketched changes (item 45, 46, 47, 48, 52, 53):

- In a `FormModal` titled "New Task", "Create Task" in its footer.
- Description autosizes from 1 row to 10; acceptance criteria from 2 to 12, with the placeholder "One per
  line, for example:\nSearch shows results in under a second with 10,000 tasks".
- Acceptance criteria's label has a help card: what a criterion is for (the agent works until each holds,
  a reviewer agent checks each and wants a test, the project's gate runs separately), and two vague →
  sharp pairs ("Make search faster" → "Search shows results in under a second with 10,000 tasks"; "Fix the
  login bug" → "Signing in with an expired password says so, instead of showing a blank page"). It says
  nothing about criteria counts changing the flow (item 52).
- Areas lists the project's areas only; hazards stay out (an agent asks for one with `request_claim`). With
  one area, the field is hidden and that area is sent. Its label's help card: "The parts of the project
  this task may change. 10db keeps the agent's edits inside them, and runs tasks in different areas at the
  same time."

## 8. Settings

**Sketched**, except where noted.

### 8.1 Layout

On `/settings/*` the sidebar shows `SettingsNav` instead of the app nav (F11): "Back to Board"; a dimmed
"Project" label, then the switcher in its compact form (16 px tile, `sm` text in normal color, drawn as a
darker outlined well, item 74, 75) and the project's sections with icons; a dimmed "Global" label and the
global sections. Sections that aren't built are hidden. The page has no title and no width cap (item 85);
it shows the section's cards.

`SettingsCard` is an optional `h5` title over a bordered `Paper` whose rows are separated by hairlines.
`SettingRow` is the setting's name (`sm`/500) and one dimmed `xs` line on the left, and its control in a
260 px column on the right; a control too wide for that (a list, a textarea) stacks under the text. Field
labels stay sentence case; actions are Title Case (item 85).

### 8.2 General

A form over the project's `ProjectPatch` fields, in cards (item 73, 78, 79, 80, 84). Each row names its
field:

| Card | Row | Field | Line under the name |
| --- | --- | --- | --- |
| (none) | Name | `name` | |
| | Gate command | `gateCommand` | "Checks the work. A task is done only when it passes." Clearable once §9.4 is built; empty then reads "No automatic check: each finished task waits for you." |
| When work is finished | Delivery: Pull request / Commit directly | `delivery` | |
| | Base branch (pull requests only) | `baseBranch` | "Pull requests start from and merge into this branch." A text input as today; a `Select` from inspection is §13 |
| | Pull request title (pull requests only) | `prTitlePrefix` | "Starts every title, as a commit type and scope: feat(desktop)." An optional override once queue task 3 lands (F8) |
| Running tasks | Most tasks at once | `maxLanes` | "10db runs fewer when tasks change the same areas or a usage limit is near." |
| | Where tasks work: Your folder / Separate copies | `workspaceMode` (`shared` / `worktree`) | the trade-off in one line; queue task 5 adds what Your folder does to the checkout |
| | Copy into each task's copy (Separate copies only) | `worktreeSeed` | "Ignored folders, such as node_modules, copied from this checkout." |
| | Fresh session, a slider | `handoffPct` | "When a session's memory is this full, it writes a handoff note and a fresh one carries on." |
| Advanced, collapsed behind a `default` toggle with `aria-expanded` | Flow | `flowId` | "The default steps a task goes through. A task can choose its own." |
| | Firm reminder | `nudgePct` | "If a session hasn't handed off by this much memory, it is told again, firmly." |
| | Wait for your answer | `humanWaitMinutes` | "After this long, a waiting task pauses and frees its place; it resumes when you answer." |
| | Spending limit per task | `budgetCeiling` | "Leave empty for no limit. Models that cost more per task aren't used." |
| | Commands that don't ask | `allowedCommands` | "One per line, such as pnpm test. Tasks run these without asking you; 10db still checks each one." |
| | Allow localhost | `sandboxLoopback` | "For tests that start a local server. Opens every local port to tasks, not just this project's." |

A save bar sticks to the bottom of the window (z-index `app`, reaching over the shell's bottom padding so
the page doesn't scroll past it, item 77, 89): an error on the left; Reset and Save on the right; after a
save, a green check and "Saved" beside them that fades out after 4 s (item 111).

### 8.3 Other project sections

- **Board columns** (item 88, 90): the builder's columns first, each led by its up and down arrows, then
  the state columns, dimmed, with their task counts and their hint as a byline and no arrows or actions.
  Actions are Title Case (Add Column, Delete Column, Save Name).
- **Areas and hazards:** being rebuilt by the running 10db task "Edit a project's areas and hazards in
  Settings". This spec adds nothing to it beyond the card style above.
- **Billing** (item 82, 87, 92): one card with Account, Backup account and "Switch at", each with one
  plain line. The fallback model is not shown: it is routing, not billing (queue task 2).

### 8.4 Global sections

- **Keep awake:** one row with Never / While tasks run / Always.
- **Accounts** (item 85, 86): the table gives the Account column the spare width; Kind 220 px, Status
  140 px, This month 220 px right-aligned; rows at `sm` vertical spacing; the account cell is its name row
  with the email 4 px under it as dimmed text (not a code chip). Actions are Title Case (Add Account,
  Archive Account, Save Secret, Replace Secret).

## 9. What the daemon adds

### 9.1 Folder inspection

**Designed.** `POST /folders/inspect` with `{ path }` (an absolute path; zod at the boundary). It answers
`FolderInspection`, a new contract:

```
{
  root: string,                 // the repository's top level, real path
  suggestedName: string,        // the root's folder name
  branches: { name: string, remote: boolean }[],   // origin's branches first, then local heads not on origin
  defaultBranch: string | null, // origin/HEAD's target, else the current branch if it has commits, else null
  github: string | null,        // `owner/name`, from origin's fetch URL through `githubRepoOf`
  gateCandidates: { command: string, source: 'makefile' | 'package_json' | 'cargo' | 'go' }[],  // best first
}
```

or a refusal with a typed reason the UI shows on the folder box:

| Reason | When | Message |
| --- | --- | --- |
| `not_found` | nothing at the path | "Nothing is at this path." |
| `not_a_directory` | a file | "This is a file, not a folder." |
| `not_a_repository` | git finds no repository at or above it | "This folder isn't a git repository." |
| `bare_repository` | a bare repository | "This is a bare repository; choose a checkout." |
| `already_a_project` | `root` is a registered checkout | "<name> is already a project." |
| `inside_a_project` | `root` lies inside a registered checkout, or contains one | "This folder is inside <name>, which is already a project." / "This folder contains <name>, which is already a project." |
| `protected_path` | `root` is at or under the data dir, the lane temp root or the worktree root | "10db keeps its own files here; choose another folder." |
| `unreadable` | git refuses the repository (a gitfile or alternates pointing somewhere git won't follow, ownership) | git's reason, one line |

**How it reads the folder** (F4):

- git runs through the daemon's `git()` with its fixed config (no hooks, filters, fsmonitor, attributes or
  optional locks) on the unpinned, observed path the trust check itself uses (as `readGitDirs` does), never
  through a pinned entry point. Inspection raises no Inbox card: a `GitTrustError` becomes `unreadable`.
  It writes nothing and pins nothing; `POST /projects` pins the checkout as today.
- It reads at most three files at `root`: `Makefile`, `package.json` and, to name the package manager, the
  existence of lockfiles. Each read is `lstat` first: a link is not followed and counts as absent; a file
  over 256 KiB counts as absent. `package.json` is parsed with zod (an object with an optional
  `scripts: Record<string, string>` and `packageManager: string`); anything else counts as absent.
- **Residual:** the repository chooses the candidate commands. The builder sees and accepts the command, and
  it only ever runs as the gate, under the gate sandbox (decision 132), as a typed one does today.
- `github` is `githubRepoOf(origin's fetch URL)`, the parser delivery already names a PR's repository with,
  so a folder counts as a GitHub one exactly when shipping a PR from it would work. GitHub Enterprise hosts
  don't count, as in delivery.
- A repository with no commits answers `branches: []` and `defaultBranch: null`.

### 9.2 Gate detection

**Designed.** `gateCandidates(files)`, a pure function from the read files to candidates, in this order,
each only when present:

1. A `Makefile` target named `gate`, then `check`, then `test`: a line that starts at column 0 with exactly
   the name, then `:` or `::`, prerequisites allowed (`gate: deps`). `.PHONY: gate` doesn't count; a
   pattern (`%:`) or variable target doesn't count; `include`d makefiles aren't read. Command `make
   <target>`.
2. `package.json` `scripts.gate`, then `check`, then `test`. The package manager comes from
   `packageManager` (the name before `@`), else the lockfile (`pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn,
   `bun.lock` or `bun.lockb` → bun, `package-lock.json` → npm), else npm. Command `<pm> run <script>`,
   except `test` with npm, pnpm or yarn, which is `<pm> test`. bun always uses `bun run`, since `bun test`
   is bun's own runner. npm's placeholder test script (`echo "Error: no test specified" && exit 1`) isn't a
   candidate.
3. `Cargo.toml` (presence only, through `lstat`): `cargo test`.
4. `go.mod` (presence only): `go test ./...`.

The first is prefilled.

### 9.3 gh sign-in in the system check

**Designed.**

- `Gh` gains `authLogin(call): Promise<string | null>`: runs `gh api user --jq .login` with the network
  env and `networkTimeoutMs`; the login on success, `null` when gh reports it is signed out (the existing
  `SIGNED_OUT` match or exit code 4), and it throws on anything else (a timeout, no network).
- `ToolCheck` gains `signedIn: z.string().nullable().default(null)`, set for `gh` only. A throw leaves it
  null and sets the gh row's version line as today.
- The daemon keeps the last login in memory. `GET /system` answers from it; `GET /system?recheck=1`
  (zod: `recheck` is `'1'` or absent) probes again first. The first `GET /system` after start probes.
  The UI's Recheck sends `recheck=1`; every other caller doesn't.
- `markGhRequired` is unchanged: once a pull-request project exists, gh is required, and the first run's
  "optional" wording only appears before the first project.

### 9.4 The optional gate

**Designed** (F5, F6). It touches these places:

1. **Contracts and data.** `ProjectInput.gateCommand` is `z.string().min(1).nullable().default(null)`;
   `ProjectDto.gateCommand` and `ProjectPatch.gateCommand` are nullable. `projects.gate_command` becomes
   nullable in a forward-only migration (`packages/db/AGENTS.md`; v0.1.0 is released). `ProjectPatch` is
   being edited by the running areas task, so this lands after it merges.
2. **Workflow.** `WORKSTREAM_TRANSITIONS` gains `Verifying → WaitingHuman` (the check is asked for) and
   `WaitingHuman → Verifying` (approved). `NextAction` gains `{ kind: 'builder_review', inboxId }`.
   `InboxKind` gains `check`. `EvidenceKind` gains `builder`, with `command` and `exitCode` nullable for
   that kind only (a discriminated union, so a gate's evidence still requires both).
3. **Permissions.** With no gate, `baseAllowedTools` has no `Bash(<gate>)` entry, and the read-only filter
   in `permissions/rules.ts` compares against no gate entry rather than `Bash(null)`.
4. **The end of a step.** In `verify()`, with no gate command: a step that has a next step advances as a
   passing gate does, with the reason "no gate command" and no evidence. The last step moves `VERIFYING →
   WAITING_HUMAN` with `nextAction: builder_review`, `currentSessionId` null, and inserts a `check` card
   that targets the workstream (title "Ready for you to check: <task title>", options "approve" and
   "send_back", detail `{ workstreamId, baseHead, head, commits }`). Claims stay held: a task waiting for
   its check still owns its areas, so with one `repo` area (F7) no other task of the project starts until
   the builder answers.
5. **Answering.** The inbox service gains `onCheckAnswer`, beside `onFlagAnswer`; `deliverParkedAnswer`
   never handles a `check` card.
   - **Approve:** `WAITING_HUMAN → VERIFYING`, and verify completes the workstream with no gate, as
     `completeInTx` does today, except that it raises no post-DONE `review` card (the builder just
     reviewed it).
   - **Send Back:** the answer's note is required for this kind (a 400 without it). It records `builder`
     evidence with the note as its summary and moves `WAITING_HUMAN → QUEUED` with `nextAction: { kind:
     'fix', evidenceId }`, counting an attempt against `maxFixAttempts` like a failed gate. The fix prompt
     (`briefing/prompts.ts`) gains a branch: "The builder sent the work back: <note>".
6. **Waiting.** No session is live, so no lane is held and `humanWaitMinutes` doesn't apply; the card waits
   until answered.
7. **Recovery.** `nextActionAfterCrash` keeps `builder_review`, and workstream recovery keeps a
   `WAITING_HUMAN` workstream whose open `check` card targets it parked, with the same card: a restart
   neither runs verify again nor raises a second card. A `VERIFYING` workstream with no gate recovers by
   re-running verify, which raises the card once (the insert is skipped when an open `check` card for the
   workstream exists).
8. **What the builder checks.** `GET /workstreams/:id/changes` answers the unified diff from `baseHead` to
   the workstream's head in its checkout (`checkoutOf`), read through the daemon's git with no external diff
   or textconv, capped at 512 KiB with a `truncated` flag, plus `git diff --numstat` per file. The Inbox
   renders a `check` card as the criteria, the commits, the changed files with their counts, and the diff
   in a scrollable monospace block, with "Approve" and "Send Back" (Send Back opens a required note). In
   Your folder mode the diff is also what the checkout already shows; nothing switches branches.
9. **Ship.** A batch whose project has no gate skips the gate step of shipping; the PR body's gate line
   says "No gate command: each task was approved in 10db." The ship trigger is unchanged: it waits for every
   task of the batch to be done.
10. **Board.** `WAITING_HUMAN` already maps to Blocked. The card's status line is queue task 9's; this spec
    gives it the words "Ready for you to check" for a workstream whose `nextAction` is `builder_review`.

### 9.5 Pull request titles

**Not here.** Writing each PR's title from the work, and lifting the rule that pull request delivery needs a
prefix, is queue task 3 (daemon part in flight on its own branch). Setup follows F8.

## 10. DESIGN.md rules

These go into `DESIGN.md` in their own PR (F18), and this build follows them:

1. **Title Case** for buttons, menu items and names of things (flows, columns); sentence case for labels,
   descriptions and messages (item 2, 38, 96).
2. **Secondary buttons** are `variant="default"`; `subtle` only inside dense rows and menus; never
   `outline` beside a filled primary (item 13, 81).
3. **Checks sit on the right** of the chosen row (item 54).
4. **Form actions** sit `xl` below the last field (item 47).
5. **Textareas** autosize and start small (item 46).
6. **Errors:** a submit's error sits beside its submit button; a field's error on the field (item 33).
7. **Nav fills** are rounded (`md`), inset from the sidebar edge; no outline per item (item 56).
8. **Motion:** short eases (150–200 ms; opacity, color, shadow) for things that appear as a side effect and
   for drag feedback; nothing decorative (item 59, 60, 61).
9. **Form modals** center, with a fixed header and footer (item 65, 67).
10. **Tables** give the identifying column the spare width and right-align numbers (item 86).
11. **Board cards** drag from anywhere on the card; no handle; a card that can't move says why (item 93).

## 11. Order and overlaps

Work in flight that touches the same files, and who owns what:

| In flight | Touches | Here |
| --- | --- | --- |
| 10db task "Edit a project's areas and hazards in Settings" (queue task 0) | `ProjectPatch`, `packages/db/src/store/projects.ts`, daemon project API tests, Settings → Areas | §9.4's contract change waits for it to merge; the Areas section is its |
| Queue task 2, routing role defaults | `routing/` | Billing drops the fallback model; nothing else |
| Queue task 3, PR titles from the work | `delivery/pr-text.ts`, `ship.ts`, the prefix rule, the Start sheet | owns the Start sheet's copy and fields; F8; §9.4's ship change rebases on it |
| Queue task 4, criteria list editor and drawer Start | the drawer, New Task | builds on §7 once it lands |
| Queue task 9, one place for a running task's state | the card's status line, batch strips | owns the line; §9.4 gives it one string |
| Renovate #67 | `apps/desktop/src/test/setup.ts` | none |

The build's order: shared pieces and theme; shell (switcher, error page); Board; drawer and New Task;
Settings; daemon inspection, detection and gh sign-in; the shared project form and the first run (with a
required gate command); the optional gate last, which then relaxes the form's gate rule.

## 12. Testing

Per `.claude/rules/testing.md`: red first, MSW for the daemon in desktop tests, real git in temp repos for
the daemon.

- **Gate detection:** a table, one row per file layout: each Makefile target and its edge cases (`gate::`,
  `gate: deps`, `.PHONY: gate`, `%:`), each package manager by field and by lockfile, `bun run test`, the
  npm placeholder, Cargo, Go, none, several. It asserts the ordered candidates.
- **Folder inspection:** real temp repos with a bare origin and maintenance off, one row per refusal in
  §9.1 and per answer shape: a root, a subfolder, a path through a link, a repo with no commits, no remote,
  a GitHub remote, a non-GitHub remote, no `origin/HEAD`, a `package.json` that is a link, one over the cap.
  Each asserts the answer, that no Inbox card was raised, and that the repository is unchanged (`git
  status`, the config file's bytes, no new files under `.git`).
- **gh sign-in:** `authLogin` against a fake exec: signed in, signed out (message and exit 4), timeout. The
  route: a plain `GET /system` doesn't probe after the first; `?recheck=1` does; a bad `recheck` is a 400.
- **Optional gate:** a table over the runner with the fake adapter: a middle step without a gate advances;
  the last step raises one `check` card and waits with no lane; Approve completes, releases claims and
  raises no `review` card; Send Back without a note is a 400; Send Back with one queues a fix whose prompt
  carries the note and counts an attempt; past `maxFixAttempts` it fails; a restart while waiting keeps one
  card and the same next action; with a gate everything is as today. `baseAllowedTools` and the read-only
  filter with a null gate. A batch ships without a gate step. `GET /workstreams/:id/changes` caps and flags.
- **First run:** Testing Library over the three steps with MSW: each Claude row state from §4.2; Continue's
  rule (F2: enabled without confirmation, disabled without git or Claude Code); each refusal shown on the
  folder box; candidates prefilled and pills fill the input; an empty gate refused until §9.4; pull
  requests disabled without gh, signed out, with no GitHub remote, and with no commits; Base branch with
  `defaultBranch: null`; the create request's body (areas, handoff, prefix per F8); the submit error in the
  footer; the window lands on `/board`.
- **Shell:** the switcher lists, searches, selects and opens New Project; Settings swaps the sidebar; the
  root error page renders and resets.
- **Board:** columns render hints while empty and counts; the split button's menu disables Start with
  nothing ready; a card click opens the drawer and Enter does too; a locked card's refusal is its accessible
  description; a drawer save sends the patch. `useHiddenEdges` with a stubbed `ResizeObserver` and scroll
  metrics.
- **e2e** (`apps/desktop/e2e/loop.spec.ts`): the run starts on a fresh data dir, where the window would now
  open on the first run, and the Playwright image may have no Claude Code, so the spec creates its project
  through `POST /projects` before opening the page, then drives the rest as today with the new names
  (New Task, Create Task, Start Ready Tasks…) and the keyboard drag on the card itself (focus the card,
  Space, arrows, Space; the locked card's refusal read from its description). The first run and the native
  folder panel are checked by hand in the Tauri window (`apps/desktop/AGENTS.md`).
- **Settings:** each section's rows and their patch; the save bar's Saved note and its fade (fake timers).
- axe in the e2e run passes with every rule but `color-contrast`.

## 13. Not covered

- **Areas proposed from the repository** (workspace packages, app folders, screens; item 28) and a task's
  areas proposed from its description (item 45). The log says "build"; this spec defers it to keep the
  first build bounded. The inspection endpoint is where the first would go.
- **Base branch as a Select in Settings:** needs inspection of an existing project's checkout; Settings
  keeps the text input.
- **Editing a task's areas and dependencies** in the drawer: needs a patch route.
- **Per-task placement** (your folder or a separate copy, chosen per task; `docs/open-items.md`).
- **Goals and the shaping flow** (`scratch/design-note-2026-10-28-starting-work-and-goals.md`), voice
  capture (item 62).
- **Codex** as a second agent in "Agents".
- **The global Models section** and the fallback model as two selects (item 84, 92).
- **A written type scale and spacing rhythm** in `DESIGN.md` (item 12): wants its own pass over every view.
- **The sandbox check** in setup: 10db checks its sandbox when a lane starts, and a setup row would need a
  daemon probe that doesn't exist yet.
- **A sharpen assist** that rewrites vague criteria (item 49).

## 14. Decisions on the open questions

The builder answered these on 2026-10-28, relayed by the orchestrating session; each answer is folded into
the sections above.

1. **Confirming the login (F2):** no explicit "Use <email>". The footer shows the login tasks will run as
   (§4.2).
2. **A gate-less task waiting for its check (F5, F6):** it holds its areas for now; `WAITING_HUMAN` plus a
   `check` card, no new state. Revisit with Goals.
3. **A second login in the first run:** none beyond the Account select that appears once a second account
   exists; adding one stays in Settings → Accounts and the first run's "Add Another Login".
4. **The name for a group of tasks:** Goal.
5. **Gate command's label:** "Gate command", with a plain description.
6. **The drawer and unsaved changes:** closing with edits asks before discarding (§7.1).
7. **Several gate candidates:** the Makefile `gate` target wins (§9.2's order).
8. **Switching the default login:** the first run offers only "Add Another Login", never "Switch Login"
   (§4.2).
