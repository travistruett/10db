# 10db M2b Board and Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Tasks list becomes a kanban board with the builder's own columns for parked work beside the derived ones. The builder drags cards to park, plan, prioritize and start work. A Settings view gives every project and app setting a home. "Start a batch" opens an approval sheet that shows what each picked task will run before anything starts.

**Architecture:**
- **Two parts, two PRs.** Part A (Tasks 1–10) covers the board with human columns and drag and drop, plus the Settings shell. It needs nothing that isn't on `main` and ships first. Part B (Tasks 11–15) covers the picker and the batch approval sheet. Its daemon half (Tasks 11–13) can be built at any time. Its sheet (Task 14) starts work through the **batch entity defined by the approved delivery spec** (`docs/superpowers/specs/2026-10-21-10db-batch-delivery-design.md`, on `docs/batch-delivery-design`), so Task 14 waits until the delivery plan's contracts and routes are on `main`.
- **Board model.** There are two kinds of column:
  - **Human columns** belong to a project. Any number, named and ordered by the builder (for example "Icebox", "Exploring", "Pending - Mark", "Needs spec"). A new project gets one, "Icebox". A task in a human column is **parked**: it is never picked and never launched.
  - **System columns** are locked and derived as today by `deriveBoardStatus`: Backlog, Ready, In progress, Blocked, Done.
  - A task's nullable `board_column_id` says which kind it is: set means parked in that human column; null means **planned**, with its column derived. Order inside a column is `board_order`.
- **Drag rules.**
  - Drags between human columns are free.
  - Human → Backlog or Ready plans the task, and its dependencies decide which of the two it lands in.
  - Backlog or Ready → a human column parks it.
  - Ready → In progress starts it through `POST /tasks/:id/start`.
  - In progress, Blocked and Done refuse drags, with a tooltip saying why.
  - Every drag has a card-menu equivalent.
  - One daemon route moves a task: the target column plus the task's new neighbours. The daemon computes the stored order.
- **Settings.** One route, `/settings/$section`, over a section registry.
  - Built now: project General fields, Board columns (add, rename, reorder, delete), Areas and hazards, Billing, and Keep-awake.
  - The other sections render a "planned" panel that names the plan that fills them. Accounts is one of those slots (accounts spec §7, §12).
- **Picker.** A pure daemon module orders the planned Ready tasks: resumed work first, then the longest chain of open work each one unblocks, then board order. It leaves out any task whose claims collide with active work or with an earlier pick. A read-only route returns that proposal with each candidate's step plan. It models no batch; it is the sheet's input.
- **Approval sheet.** A drawer lists the proposal. It lets the builder untick tasks and change each task's flow and risk tags (existing `PATCH /tasks/:id`), and it starts the ticked tasks according to the project's delivery mode and current batch (Open decision 5).

**Tech Stack:** As in M2a. New desktop dependencies: `@dnd-kit/core`, `@dnd-kit/sortable` and `@dnd-kit/utilities` (spec §10 names dnd-kit). No daemon dependency changes.

**Spec:** `docs/superpowers/specs/2026-10-13-10db-factory-loop-design.md`, plus `docs/superpowers/specs/2026-10-17-10db-accounts-design.md` §7 and §12 for the Accounts slot, and `docs/superpowers/specs/2026-10-21-10db-batch-delivery-design.md` §3–§8 for how the sheet starts work. This plan implements:
- §5.1: the board shows the derived status. Human columns park tasks outside it (Travis's board model, decisions A1–A3).
- §5.2 points 1 and 4: the picker rules and the approval sheet. Point 2 (the PM-agent review) is not built; the sheet says the rules alone chose the batch.
- §10 Shell: the Board and Settings views in the navigation.
- §10 Board: the columns; "drag and drop moves tasks and sets priority"; cards with areas, dependency markers and live workstream state; and "Start N opens the batch approval sheet".
- §10 Settings: the sections, with the per-project budget ceiling and gate command editable and the rest shown or slotted (Open decision 7).
- Accounts spec §7 and §12 point 4: the Accounts section exists as a slot; the screen itself belongs to the accounts plan.
- Delivery spec §5 and §8: the sheet starts a new batch with `POST /projects/:id/batches` and joins or reopens one through `POST /tasks/:id/start`.

**Designed for later, not built here** (each fits as an additive, nullable column or setting):
- A per-project **manual board** setting that lets drags override the system columns.
- **Person-linked columns:** `board_columns.person_id`, a nullable reference to `people`, for "Pending - Mark"-style columns that wait on a teammate.
- **On-drop behaviors:** `board_columns.on_drop`, nullable, for example "start a consult with a persona when a card lands here".

**Not in this plan:**
- The PM-agent review (§5.2.2), the Brainstorm side panel (§10), the consult step (§5.2.6) and ⌘K (§10). They are the daemon half of planning and get their own plan.
- Takeover and the PTY (§5.4): the takeover plan.
- Accounts: the daemon, the API and the Accounts screen (accounts spec §7). This plan leaves the slot and the project's account-picker slot.
- Editors for team bindings, routing rules, personas, flows and model profiles, the AA key field and the Intelligence-vs-Cost chart. Their routes exist (M2a); their sections are slots here (Open decision 7).
- Branch and PR delivery, the batch entity and the batch strip: the delivery spec and its plan.
- The Ready rule's "no open blocking inbox item" (open item, spec §5.1) and the inbox's mine/teammate filter.
- The live acceptance run on the standard flow (open item from M2a).

**Plan series:** `00-spikes` … `06-m2a-teams-and-routing`, **`07-m2b-board-and-settings` (this file)**. The delivery plan and the takeover plan are numbered when written. This plan was written against `main` at `2b3d811`. Where a file, signature or anchor it names doesn't match the code on `main`, trust the code, adapt the step and say so in the task's report.

**Mantine docs:** the Mantine MCP server may be unavailable. The pinned version is `@mantine/core` 9.7.2. When a prop named here is in doubt, read it from `apps/desktop/node_modules/@mantine/core/lib/components/<Name>/<Name>.d.ts`.

## Open decisions for Travis

The board model itself is decided (decisions A1–A3). The rows below are what the spec, the board model or the delivery spec leave open; the plan is written against the recommended default in each row.

| # | Question | Recommended default (the plan follows it) | Alternative | Tasks affected |
|---|---|---|---|---|
| 1 | Where do human columns sit, and how does a parked task report its state? | **Left of the system columns, in their `position` order.** `TaskDto.boardStatus` stays the derived system status for every task. The board places a task by `boardColumnId ?? boardStatus`. | Human columns to the right of Done; or a separate `parked` board status. | 2, 5 |
| 2 | The spec orders picker candidates "in-progress first, then by longest remaining dependency chain" (§5.2.1) and also says drag and drop "sets priority" (§10). Which wins? | **The spec's order, with board order breaking ties:** resumed work first, then the longest chain of open tasks it unblocks, then board order. | Board order first, with the chain length shown only as a hint. | 12 |
| 3 | What can the builder edit on the approval sheet ("The builder edits and approves", §5.2.4)? | **Which tasks are in the batch, and each task's flow and risk tags**, through the existing `PATCH /tasks/:id`, which re-plans. Per-step persona and model overrides are not offered: they need a start-with-overrides contract and a rule for how an override interacts with escalation. | Per-step persona and profile overrides on the sheet, stored on the workstream at start. | 14 |
| 4 | Dragging a Backlog card onto In progress, and the menu Start on a Backlog card. | **The drag is refused** ("Only a Ready card starts by dragging"). **The card menu's Start keeps today's rule** (`canStart` allows Backlog, which queues until the dependencies finish), except for parked tasks. The picker offers Ready tasks only. | Allow both, or refuse both. | 5, 6 |
| 5 | How does the sheet start work in each delivery mode and batch state? The delivery spec (§5) says `POST /projects/:id/batches` "starts a batch" and `POST /tasks/:id/start` joins an `OPEN` batch or reopens a `FAILED` one. | **Branch on `project.delivery` and `project.currentBatch`:**<br>• `local`: start each ticked task with `POST /tasks/:id/start`, in sheet order.<br>• `pull_request` with no unfinished batch (none, `SHIPPED`, `CLOSED`, `ABANDONED`): `POST /projects/:id/batches` with `{ title, taskIds }`, where the title is required and defaults to the first ticked task's title.<br>• `OPEN`: "Add N tasks to ‹title›", through `POST /tasks/:id/start` per task.<br>• `FAILED`: the same route, with copy saying that starting reopens the batch as a fix.<br>• `CUTTING` or `SHIPPING`: Start disabled, with the reason.<br>A per-task sequence stops at the first refusal and says which tasks started. | If the delivery plan makes the batch route join an `OPEN` batch, use it for joining too; only `useStartWork` and its tests change. | 14 |
| 6 | Does the board replace the Tasks view? | **Yes.** `/board` replaces `/tasks`, which redirects; the project and task forms move onto the board. | Keep both views. | 5 |
| 7 | Which Settings sections get content now? | **General** (every `ProjectPatch` field: name, gate command, lane cap, handoff and nudge, human wait, flow, budget ceiling), **Board columns** (add, rename, reorder, delete), **Areas and hazards** (read-only: no patch route), **Billing** (read-only, with the account-picker slot), **Keep-awake** (editable).<br>**Slots** with a planned panel: Team, Routing rules, Personas and flows, Models and benchmarks (AA key, profiles, the chart), Accounts. | Build the team and routing-rule editors now; their routes exist. | 7–9 |
| 8 | Does dragging a queued task change when it launches? | **No.** The scheduler keeps launching queued work in creation order, and a batch or a sequence of starts runs in the sheet's order, so priority at approval time is launch order. | The scheduler launches queued work in board order (a change to `apps/daemon/src/scheduler/`, which the delivery plan also changes). | none |
| 9 | Small defaults | The Done column lists the most recently finished first and shows 20, with "Show all". A card-menu move to another column lands at the top of it. The sheet's batch size starts at the project's lane cap (1–16). The board shows one project at a time; there is no "All projects" board. Deleting a non-empty human column always asks where its tasks go, with no preselected answer. | — | 5, 6, 8, 14 |

## Shared hot spots

This section lists everything this plan changes in shared packages, and in files the delivery work also touches, so the two can be sequenced.

**`packages/contracts`** (additive only; `PROTOCOL_VERSION` stays 2):

| Change | File | Task |
|---|---|---|
| New ID kind `BoardColumn` (`bcl`), `BoardColumnId` | `src/ids.ts` | 1 |
| New `BoardColumnName`, `BoardColumnDto`, `BoardColumnInput`, `BoardColumnPatch`, `BoardColumnDelete`, `DEFAULT_BOARD_COLUMN`, `TaskMove` | `src/board.ts` (new), `src/index.ts` (one export line) | 1 |
| New `EventType.BoardColumnSaved` (`board_column.saved`) and `BoardColumnDeleted` (`board_column.deleted`), entity type `board_column` | `src/events.ts` | 1 |
| `TaskDto` gains `boardColumnId: BoardColumnId \| null` | `src/entities.ts` | 2 |
| Register `board-column-dto`, `board-column-input`, `board-column-patch`, `board-column-delete`, `task-move`; `task-dto` changes | `src/json-schema.ts`, `generated/*.schema.json` | 1, 2 |
| New `PICK_MAX`, `PickSize`, `PickerClaim`, `PickerCandidate`, `PickerProposalDto` | `src/picker.ts` (new), `src/index.ts`, `src/json-schema.ts`, `generated/picker-proposal-dto.schema.json` | 11 |

**`packages/db`: a schema change in Part A.**
- `src/schema.ts` gains the `board_columns` table and `tasks.board_column_id` (Task 2).
- Until `v0.1.0` the migration baseline is **regenerated, not extended** (`packages/db/AGENTS.md`). The delivery plan regenerates it too (for `batches` and the project and workstream columns). **Whichever of the two merges second regenerates the baseline again** on top of the other's schema. Never hand-merge `drizzle/`.
- `src/store/board-columns.ts` (new) and `src/store/index.ts` (one export line).
- `src/store/projects.ts`: `insertProject` seeds "Icebox". The delivery plan adds project columns in the same file.
- `src/store/tasks.ts`: `moveTask`, a private renumber helper, and `boardColumnId` in `toTaskDto`.
- `src/store/workstreams.ts`: `insertWorkstream` refuses a parked task. The delivery plan adds `batch_id` in the same file.

**Depends on the delivery plan** (consumed, not defined here; Task 14 only):
- the batch schema the delivery plan exports (the spec names it `Batch`, with `BatchState`);
- `ProjectDto.delivery` and `ProjectDto.currentBatch`;
- `POST /projects/:projectId/batches` with `{ title, taskIds }`, which answers 201 at once while cutting finishes in the background;
- `POST /tasks/:id/start` joining or reopening a batch;
- `EventType.BatchUpdated` (`batch.updated`) with entity type `batch`.

Task 14's first step checks each of these against the delivery plan.

**`apps/daemon`:**

| File | Change | Task | Overlap risk |
|---|---|---|---|
| `src/api/app.ts`, `src/api/services.ts`, `src/api/app.test.ts` | routes: `POST /tasks/:taskId/move`, the four board-column routes, `GET /projects/:projectId/candidates`; their `ApiServices` methods and stubs | 4, 13 | delivery adds its batch routes to the same files: textual conflicts only |
| `src/daemon/services.ts`, `src/daemon/start.test.ts` | the service methods and one integration test per feature | 4, 13 | same |
| `src/picker/` (new, pure) | the picker rules | 12 | none |
| `src/team/candidates.ts` (new), `src/team/index.ts` | the proposal | 13 | low (delivery changes `team/steps.ts`' retry) |
| `apps/daemon/AGENTS.md` | the module order line gains `picker` | 15 | low |

Not touched: `src/guard`, `src/mcp`, `src/git`, `src/runner`, `src/scheduler`, `src/sessions`.

**`apps/desktop`:**
- `src/views/tasks/` → `src/views/board/` (a `git mv` rename, Task 5). The delivery plan's project-form changes land in the moved `new-project-form.tsx`: whichever merges second applies its edits to the file at its new or old path.
- `new-project-form.tsx`: the delivery plan adds delivery, base branch and PR title prefix.
- `src/views/settings/project-general-form.tsx` and `general-values.ts` (Task 9): whichever of Part A and the delivery plan merges second adds those three fields to `checkGeneral`, its test table and the form.
- `src/test/fixtures.ts`: both add fields to `projectDto` and `taskDto`.
- `e2e/loop.spec.ts` (Tasks 5, 10, 15): both edit the run.

**Docs:** new rows in `docs/architecture/decisions.md`, numbered **with the next free numbers at merge**. They are written here as A1–A7 and B1–B2. `tests/repo/src/architecture-docs.test.ts` requires the numbers to run without gaps, so whichever PR merges second renumbers its rows. Also new lines in `docs/open-items.md`.

## New decisions

Recorded in `docs/architecture/decisions.md` by Task 10 (A1–A7) and Task 15 (B1–B2), each with the next free number at merge.

| # | Decision | Why |
|---|---|---|
| A1 | The board has two kinds of column.<br>• **Human columns** belong to a project; there can be any number, and the builder names and orders them. A new project gets one, "Icebox". A task in a human column is parked: never picked and never launched (`insertWorkstream` refuses it).<br>• **System columns** (Backlog, Ready, In progress, Blocked, Done) are locked and derived from task and workstream state as before.<br>A task's nullable `board_column_id` names its human column; null means planned, and its column is derived. Human columns sit left of the system columns. | Travis's board model: a place for ideas, exploration and work waiting on a person, which the factory must never pick up, beside the state-driven columns that report what the factory is doing. |
| A2 | `board_columns` rows hold `id` (`bcl_…`), `project_id`, `name` (unique per project, 1–40 characters), `position`, `created_at` and `updated_at`.<br>Deleting a column moves its tasks to another human column of the project, or to planned; deleting a non-empty column requires the choice.<br>Designed for later as additive nullable columns: `person_id` (a link to `people`, for "Pending - Mark") and `on_drop` (for example, start a consult). Also for later: a per-project "manual board" setting that lets drags override the system columns. | The later fields are named now so the row shape doesn't change when they arrive. |
| A3 | Drag rules:<br>• Free between human columns.<br>• Human → Backlog or Ready plans the task, and the derived column decides which: a drop on Ready with unfinished dependencies lands in Backlog, with a note.<br>• Backlog or Ready → a human column parks it.<br>• Ready → In progress starts it through `POST /tasks/:id/start`.<br>• In progress, Blocked and Done refuse drags, with a tooltip reason; so do drops on Blocked and Done, and drops on In progress from anything but Ready.<br>Every drag has a card-menu equivalent: Move to top, up, down and bottom; Move to each other column; and Start. | Moves that change state go through the same commands as everything else. WCAG 2.2 SC 2.5.7 asks for a single-pointer alternative to dragging. |
| A4 | A task's priority is its `board_order`, a real number, project-wide.<br>A move names its target column (a human column, or null for planned) and the task's new neighbours in that column (`after`, `before`; both may be null when the column is empty). The daemon writes the midpoint of their orders, or one past an end. When the neighbours' gap is under 1e-6 it first renumbers the project's tasks 1…n in their current order.<br>Neighbours in the wrong order answer 409, as does moving a task whose derived status is In progress, Blocked or Done. | One row write per move in the common case. The client never computes a stored order. A stale view fails visibly instead of scrambling the board. |
| A5 | The board replaces the Tasks view at `/board`, and `/tasks` redirects there. The board shows one project at a time, chosen by the same remembered project as Settings. | Spec §10 names Board, not Tasks; one place to create, park, order and start work. |
| A6 | Drag and drop uses dnd-kit's stable line, `@dnd-kit/core` with `@dnd-kit/sortable` and `@dnd-kit/utilities`, not `@dnd-kit/react`, which is still 0.x. | Spec §10 names dnd-kit. The stable line has a keyboard sensor, multi-container sorting and screen-reader announcements built in. |
| A7 | Settings is one route, `/settings/$section`, over a registry of sections grouped Project and App. A section that is not built yet renders a planned panel that says what it will hold and which plan fills it. An unknown section redirects to General. | Later plans (accounts, team editors, the AA chart) fill a slot by changing one registry entry and one switch arm. |
| B1 | The picker proposes from the project's planned Ready tasks; parked tasks are never candidates.<br>Order: tasks with an earlier, ended workstream first; then the longest chain of open tasks each one unblocks; then board order.<br>A task is left out, with the reason, when:<br>• one of its claims (an area or a hazard) is held by active work (any workstream not yet terminal, queued included) or by a task picked before it;<br>• its step plan can't be resolved;<br>• a step is over the budget ceiling.<br>The first `size` tasks left are proposed. The PM-agent review is not built; the sheet says the rules alone chose. | Spec §5.2.1, with board order as the tie-break that makes "sets priority" matter (Open decision 2). Queued work holds no claims until it launches, so its task's areas count as held. |
| B2 | The approval sheet edits which tasks start and each task's flow and risk tags, through `PATCH /tasks/:id`; the proposal re-plans on the task event.<br>It starts the ticked tasks in the sheet's order:<br>• in a `local` project, one `POST /tasks/:id/start` each;<br>• in a `pull_request` project with no unfinished batch, one `POST /projects/:id/batches` with a required title;<br>• with an `OPEN` or `FAILED` batch, one `POST /tasks/:id/start` each, which joins it or reopens it as a fix;<br>• never while the batch is `CUTTING` or `SHIPPING`.<br>Each card keeps its own Start. | Spec §5.2.4 and delivery spec §5: `POST /tasks/:id/start` is right in both delivery modes, and per-step overrides need a contract and an escalation rule (Open decision 3). |

## Global Constraints

Everything in M0's, M1a's, M1b's and M2a's Global Constraints still applies. On top of that:
- **Branches:** Part A on `feat/m2b-board-and-settings`, cut from `main`. Part B on `feat/m2b-batch-approval`, cut from `main` after Part A merges. Task 14 starts only after the delivery plan's contracts and routes are on `main`. Each part ends with a PR to `main` whose title is a Conventional Commit.
- **Commits:**
  - Each commit is one command that names its paths: `git add <path> … && git commit -m '…'`. Never `git add -A`, `git add .` or `git commit -a`. Use single quotes for `-m`.
  - The scope is one of `daemon`, `desktop`, `contracts`, `db`, `harness`, `repo`, `ci`, `docs`, `deps`. The subject is lowercase and the header is at most 100 characters.
  - Run `pnpm format` first. A failing hook leaves the paths staged: fix the cause and rerun the same line. Never `--no-verify` or `LEFTHOOK=0`.
  - End every commit message with the attribution lines the session gives.
- **Generated files** are regenerated, never edited: run `pnpm --filter @10db/contracts generate` after a contracts change, and follow `packages/db/AGENTS.md` to regenerate the migration baseline after a schema change. Commit the output with its source.
- **Contracts are additive:** new files, new fields on output DTOs, new `EventType` values and a new ID kind only.
- **One schema change, in Task 2.** No other task changes `packages/db/src/schema.ts`. If one seems to need it, stop and report: the delivery plan regenerates the same baseline.
- **Pins:** for each new npm dependency, run `pnpm view <pkg> time --json` and pin the latest stable release that is at least 24 hours old (`pnpm-workspace.yaml` sets `minimumReleaseAge: 1440`). When this plan was written that was `@dnd-kit/core` 6.3.1, `@dnd-kit/sortable` 10.0.0 and `@dnd-kit/utilities` 3.2.2.
- **The UI reaches the daemon only through the `hc<AppType>` client** and parses every response with its contracts schema via `readJson` (`apps/desktop/AGENTS.md`). Server state lives in TanStack Query, and the event stream invalidates by entity type (`INVALIDATIONS`). Don't poll.
- **Mantine components and theme tokens only** (`DESIGN.md`): `size="sm"` in lists, `md` in forms and dialogs, teal primary, sentence-case copy that says what happened and what to do next. Every view works in dark and light.
- **The React Compiler is on:** no hand-written `useMemo` or `useCallback` for render performance.
- **No `as` casts, no `!`, no `any`** except at a validated boundary with a comment. Switches over `BoardStatus`, `SettingsSectionKey`, `ColumnKey['kind']` and `SheetMode['kind']` are exhaustive.
- **Untrusted text is data:** task titles, column names, descriptions, areas and plan reasons render as text, never as Markdown or HTML.
- **Accessibility:** every drag has the card-menu alternative; every control has a name; axe runs over every view, in dark and light, in the e2e test.
- **Tests:**
  - Red first (`.claude/rules/testing.md`). Table-driven for `resolveDrop`, `groupByColumn`, `moveTask`, the board-column repository, the picker, `checkGeneral`, `sheetMode` and `startBlockers`.
  - Real SQLite in a temp directory for `packages/db` and the daemon. MSW for the UI, never a real daemon.
  - jsdom has no layout, so dnd-kit's pointer and keyboard sensors can't move a card there. UI tests drive moves through the card menu, which calls the same `resolveDrop` and mutations. The e2e test drives a real keyboard drag in WebKit.
  - Never pipe test output through `tail` or append `; echo $?`.
- **Comments never carry decision or task numbers.** They say the why in words, or cite the spec (`spec §5.2.1`).

## Review Focus

These are the seven inputs or conditions most likely to bite a person, each with the task that pins it:
1. **The board changed under a drag.**
   - Case: the event stream reorders, starts or finishes a task while the builder drags, so the neighbours the UI sends are in the wrong order, or no longer in the target column, or the task started meanwhile.
   - The daemon answers 409 or 400 and writes nothing. The UI rolls the optimistic placement back, shows the message and refetches.
   - Tests: Task 3 (`answers a conflict for neighbours in the wrong order`, `refuses a neighbour outside the target column`, `refuses to move a running task`), Task 6 (`rolls the placement back and says why when the daemon refuses a move`).
2. **Many moves into the same gap.**
   - Case: the builder keeps dropping cards between the same two tasks. Halving the gap 50 times exhausts a double's precision, and two tasks would share an order.
   - Under a 1e-6 gap the project is renumbered 1…n first, the visible order is kept, and the move lands between its neighbours.
   - Tests: Task 3 (`renumbers the project when the gap is too small, keeping the order`).
3. **A drop that isn't allowed, or isn't a move.**
   - Case: a card dropped on itself or outside every column; a running card dragged; a drop on Blocked or Done; a Backlog or parked card dropped on In progress; a card dropped on Ready whose dependencies aren't done.
   - Nothing is sent for a no-op. A refusal shows its reason. The Ready drop plans the task and says it waits in Backlog.
   - Tests: Task 6 (`resolveDrop` table).
4. **A parked task tries to run.**
   - Case: the menu's Start on a parked card, an API client calling `POST /tasks/:id/start`, the picker, a batch.
   - `insertWorkstream` refuses with 409 naming the column, the card menu offers no Start, and the picker skips it.
   - Tests: Task 3 (`refuses to start a parked task`), Task 4 (start route 409), Task 5 (no Start on a parked card), Task 12 (`never offers a task parked in a human column`).
5. **A keyboard-only or switch user.**
   - Every move is reachable from the card menu. The drag handle has a name and works with Space and the arrow keys. A locked card's handle is disabled and says why.
   - Tests: Task 6 (`moves a card to the top from its menu`, `parks and plans a card from its menu`, `explains why a running card can't be dragged`), Task 10 (e2e keyboard drag).
6. **A Settings save the daemon refuses, or a project or column that changes while its form is open.**
   - Case: the nudge at or below the handoff; an empty name or gate command; a negative ceiling; an empty number field; a duplicate or empty column name; deleting a column whose tasks need a home; the event stream updating the project mid-edit.
   - Client checks block the save with the field's message and send nothing, and a daemon refusal shows its message. "Nothing to change" appears when no field differs. A non-empty column's delete asks where its tasks go.
   - Tests: Task 8 (`shows the daemon's message for a duplicate name`, `asks where a non-empty column's tasks go`), Task 9 (`checkGeneral` table, `shows the daemon's message when it refuses the change`).
7. **Nothing can start, or the start fails.**
   - Case: no Ready tasks; every candidate collides with running work; a candidate's plan is over budget or has no flow; the batch is `CUTTING` or `SHIPPING`; the batch route answers 409; one task in a sequence of starts is refused.
   - The sheet names each left-out task's reason, and disables Start with the reason when a ticked task can't run or the batch is busy. It sends nothing when nothing is ticked, and shows the daemon's message on failure, including which tasks already started.
   - Tests: Task 12 (picker rows), Task 14 (`sheetMode` and `startBlockers` tables, the per-state sheet tests, `shows the daemon's message when the batch is refused`, `stops at the first refused start and says which started`).

---

## File Structure

```
packages/contracts/src/
  ids.ts (+ BoardColumn)   events.ts (+ BoardColumnSaved, BoardColumnDeleted)              (Task 1)
  board.ts             BoardColumn*, DEFAULT_BOARD_COLUMN, TaskMove                         (Task 1)
  entities.ts          TaskDto.boardColumnId                                                (Task 2)
  picker.ts            PICK_MAX, PickSize, PickerClaim, PickerCandidate, PickerProposalDto  (Task 11)
  index.ts  json-schema.ts                                                                  (Tasks 1, 11)
packages/contracts/generated/   board-column-*.schema.json, task-move.schema.json, task-dto.schema.json,
                                picker-proposal-dto.schema.json (generated)
packages/db/src/
  schema.ts            board_columns, tasks.board_column_id                                 (Task 2)
  store/board-columns.ts (+ test)  store/projects.ts (Icebox)  store/index.ts               (Task 2)
  store/tasks.ts (+ moveTask)  store/workstreams.ts (parked refusal)  store/board-order.test.ts (Task 3)
packages/db/drizzle/   0000_init.sql, meta/ (regenerated baseline)                          (Task 2)
apps/daemon/src/
  api/app.ts api/services.ts api/app.test.ts daemon/services.ts daemon/start.test.ts        (Tasks 4, 13)
  picker/              pick.ts pick.test.ts index.ts                                        (Task 12)
  team/                candidates.ts candidates.test.ts index.ts                            (Task 13)
apps/desktop/src/
  router.tsx  shell/app-layout.tsx                                                          (Tasks 5, 7)
  shell/selected-project.ts  shell/project-picker.tsx (moved)  shell/keep-awake-labels.ts
  daemon/queries.ts  daemon/events.ts                                                       (Tasks 5, 8, 9, 14)
  views/board/         (renamed from views/tasks)
    board-view.tsx board-view.test.tsx board-layout.ts board-layout.test.ts board-column.tsx
    task-card.tsx task-card-menu.tsx drop-rules.ts drop-rules.test.ts use-board-actions.ts
    board-dnd.tsx areas-text.ts areas-text.test.ts board-status-badge.tsx new-project-form.tsx
    new-task-form.tsx
    batch/ batch-sheet.tsx batch-candidate.tsx batch-steps.tsx batch-selection.ts
           batch-selection.test.ts batch-sheet.test.tsx use-start-work.ts                   (Task 14)
  views/settings/
    sections.ts sections.test.ts settings-view.tsx settings-nav.tsx section-body.tsx
    planned-section.tsx project-areas.tsx project-billing.tsx keep-awake-section.tsx         (Task 7)
    board-columns-section.tsx board-columns-section.test.tsx                                (Task 8)
    project-general-form.tsx general-values.ts general-values.test.ts settings-view.test.tsx (Task 9)
  test/fixtures.ts     (+ boardColumnDto; stepDto, candidate, flowDto, batch fixture in Task 14)
apps/desktop/e2e/loop.spec.ts                                                               (Tasks 5, 10, 15)
apps/desktop/package.json  pnpm-lock.yaml                                                   (Task 6)
docs/architecture/decisions.md  docs/open-items.md  apps/desktop/AGENTS.md  apps/daemon/AGENTS.md  DESIGN.md
```

---

# Part A: the board, human columns and Settings

### Task 1: Board column and task move contracts

**Files:**
- Create: `packages/contracts/src/board.ts`, `packages/contracts/src/board.test.ts`
- Modify: `packages/contracts/src/ids.ts`, `packages/contracts/src/events.ts`, `packages/contracts/src/index.ts`, `packages/contracts/src/json-schema.ts`
- Generated: `packages/contracts/generated/board-column-dto.schema.json`, `board-column-input.schema.json`, `board-column-patch.schema.json`, `board-column-delete.schema.json`, `task-move.schema.json`, and `daemon-event.schema.json` (its `type` enum grows)

**Interfaces:**
- Consumes: `idSchema`, `ProjectId`, `TaskId`.
- Produces (used by Tasks 2–8):
  - ID kind `BoardColumn` with prefix `bcl`; `BoardColumnId` (schema and type); `mintId('BoardColumn')`.
  - `BoardColumnName`: a string, trimmed, 1–40 characters.
  - `BoardColumnDto = { id: BoardColumnId; projectId: ProjectId; name: string; position: number; createdAt: string; updatedAt: string }`.
  - `BoardColumnInput = { name }`; `BoardColumnPatch = { name?, position? }`, at least one; `BoardColumnDelete = { moveTasksTo: BoardColumnId | null }`, where null means planned.
  - `DEFAULT_BOARD_COLUMN = 'Icebox'`.
  - `TaskMove = { to: BoardColumnId | null; after: TaskId | null; before: TaskId | null }`, where `to` null means planned and `after` and `before` are the task's new neighbours in the target column (both may be null; they must differ when both are set).
  - `EventType.BoardColumnSaved = 'board_column.saved'`, `EventType.BoardColumnDeleted = 'board_column.deleted'`; their entity type is `board_column`.

- [ ] **Step 1: Write the failing test**

`packages/contracts/src/board.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BoardColumnInput, BoardColumnPatch, DEFAULT_BOARD_COLUMN, TaskMove } from './board';
import { EventType } from './events';
import { BoardColumnId, mintId } from './ids';

const a = mintId('Task');
const b = mintId('Task');
const column = mintId('BoardColumn');

describe('TaskMove', () => {
  it.each([
    { name: 'between two planned tasks', value: { to: null, after: a, before: b }, ok: true },
    { name: 'to the top of a human column', value: { to: column, after: null, before: a }, ok: true },
    { name: 'into an empty human column', value: { to: column, after: null, before: null }, ok: true },
    { name: 'between a task and itself', value: { to: null, after: a, before: a }, ok: false },
    { name: 'to a malformed column', value: { to: 'bcl_nope', after: null, before: null }, ok: false },
    { name: 'with a missing key', value: { to: null, after: a }, ok: false },
  ])('parses a move $name: $ok', ({ value, ok }) => {
    expect(TaskMove.safeParse(value).success).toBe(ok);
  });
});

describe('board columns', () => {
  it('mints column ids with the bcl prefix', () => {
    expect(BoardColumnId.safeParse(column).success).toBe(true);
    expect(column.startsWith('bcl_')).toBe(true);
  });

  it.each([
    { name: 'a plain name', value: 'Exploring', ok: true, parsed: 'Exploring' },
    { name: 'a padded name, trimmed', value: '  Needs spec ', ok: true, parsed: 'Needs spec' },
    { name: 'an empty name', value: '   ', ok: false, parsed: null },
    { name: 'a 41-character name', value: 'x'.repeat(41), ok: false, parsed: null },
  ])('parses $name', ({ value, ok, parsed }) => {
    const result = BoardColumnInput.safeParse({ name: value });
    expect(result.success).toBe(ok);
    if (result.success) expect(result.data.name).toBe(parsed);
  });

  it('refuses an empty patch', () => {
    expect(BoardColumnPatch.safeParse({}).success).toBe(false);
    expect(BoardColumnPatch.safeParse({ position: 0 }).success).toBe(true);
  });

  it('names Icebox as the default column and its events', () => {
    expect(DEFAULT_BOARD_COLUMN).toBe('Icebox');
    expect(EventType.BoardColumnSaved).toBe('board_column.saved');
    expect(EventType.BoardColumnDeleted).toBe('board_column.deleted');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @10db/contracts exec vitest run src/board.test.ts`
Expected: FAIL, `Cannot find module './board'`.

- [ ] **Step 3: Add the ID kind, the events and the schemas**

In `packages/contracts/src/ids.ts`, add `BoardColumn: idSchema('bcl', 'BoardColumnId'),` to `ID_SCHEMAS`, `BoardColumn: 'bcl',` to `ID_PREFIX`, and:

```ts
export const BoardColumnId = ID_SCHEMAS.BoardColumn;
export type BoardColumnId = IdOf<'BoardColumn'>;
```

In `packages/contracts/src/events.ts`, add after `StepChanged`:

```ts
  BoardColumnSaved: 'board_column.saved',
  BoardColumnDeleted: 'board_column.deleted',
```

`packages/contracts/src/board.ts`:

```ts
import { z } from 'zod';
import { BoardColumnId, ProjectId, TaskId } from './ids';

/** The human column every new project starts with. */
export const DEFAULT_BOARD_COLUMN = 'Icebox';

export const BoardColumnName = z.string().trim().min(1, 'Enter a name').max(40, 'Use at most 40 characters');

/**
 * A column the builder names and orders. A task in one is parked: never picked and never launched.
 * Later fields (a linked person, an on-drop behavior) arrive as nullable additions.
 */
export const BoardColumnDto = z.object({
  id: BoardColumnId,
  projectId: ProjectId,
  name: z.string(),
  position: z.int().min(0),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type BoardColumnDto = z.infer<typeof BoardColumnDto>;

export const BoardColumnInput = z.object({ name: BoardColumnName });
export type BoardColumnInput = z.infer<typeof BoardColumnInput>;

export const BoardColumnPatch = z
  .object({ name: BoardColumnName, position: z.int().min(0) })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: 'Change at least one field' });
export type BoardColumnPatch = z.infer<typeof BoardColumnPatch>;

/** Where a deleted column's tasks go: another human column, or null for planned. */
export const BoardColumnDelete = z.object({ moveTasksTo: BoardColumnId.nullable() });
export type BoardColumnDelete = z.infer<typeof BoardColumnDelete>;

/**
 * Where a dragged task lands: in human column `to`, or planned when `to` is null, directly below
 * `after` and directly above `before`. The daemon computes the stored order from the neighbours.
 */
export const TaskMove = z
  .object({ to: BoardColumnId.nullable(), after: TaskId.nullable(), before: TaskId.nullable() })
  .refine((m) => m.after === null || m.after !== m.before, {
    message: 'after and before must be different tasks',
    path: ['before'],
  });
export type TaskMove = z.infer<typeof TaskMove>;
```

In `packages/contracts/src/index.ts`, add `export * from './board';` after `./benchmarks`. In `packages/contracts/src/json-schema.ts`, import the five schemas from `./board` and add, in alphabetical order among the entries, `'board-column-delete': BoardColumnDelete`, `'board-column-dto': BoardColumnDto`, `'board-column-input': BoardColumnInput`, `'board-column-patch': BoardColumnPatch` and `'task-move': TaskMove`.

- [ ] **Step 4: Run the tests and regenerate**

Run: `pnpm --filter @10db/contracts exec vitest run && pnpm --filter @10db/contracts generate && git status --short packages/contracts/generated`
Expected: PASS. Five new generated files appear, and `daemon-event.schema.json` changes (two new `type` values).

- [ ] **Step 5: Commit**

```bash
pnpm format && git add packages/contracts/src/board.ts packages/contracts/src/board.test.ts packages/contracts/src/ids.ts packages/contracts/src/events.ts packages/contracts/src/index.ts packages/contracts/src/json-schema.ts packages/contracts/generated && git commit -m 'feat(contracts): add board columns and the task move contract'
```

---

### Task 2: The `board_columns` table, parked tasks and the column repository

**Files:**
- Modify: `packages/db/src/schema.ts`, `packages/db/src/store/projects.ts`, `packages/db/src/store/tasks.ts`, `packages/db/src/store/index.ts`, `packages/contracts/src/entities.ts`, `apps/desktop/src/test/fixtures.ts`
- Create: `packages/db/src/store/board-columns.ts`, `packages/db/src/store/board-columns.test.ts`
- Generated: `packages/db/drizzle/0000_init.sql`, `packages/db/drizzle/meta/*` (the regenerated baseline; `0001_decisions_fts.sql` is restored byte for byte), `packages/contracts/generated/task-dto.schema.json`

**Interfaces:**
- Consumes: Task 1's contracts.
- Produces:
  - `schema.boardColumns`, and `schema.tasks.boardColumnId` (nullable, referencing `board_columns.id`).
  - `TaskDto.boardColumnId: BoardColumnId | null`.
  - In `store/board-columns.ts`:
    - `listBoardColumns(db, projectId): BoardColumnDto[]` (by position)
    - `getBoardColumn(db, id): BoardColumnDto` (`NotFoundError`)
    - `insertBoardColumn(ctx, projectId, input): BoardColumnDto` (appended last; `ConflictError` for a duplicate name)
    - `patchBoardColumn(ctx, id, patch): BoardColumnDto[]` (rename, or move to `position`, shifting the others; answers the project's columns)
    - `deleteBoardColumn(ctx, id, del): BoardColumnDto[]` (moves its tasks first, then compacts the positions)
  - `insertProject` creates the project's "Icebox" column in the same transaction.

- [ ] **Step 1: Write the failing tests**

`packages/db/src/store/board-columns.test.ts`:

```ts
import {
  ConflictError,
  DEFAULT_BOARD_COLUMN,
  EventType,
  InvalidError,
  mintId,
  NotFoundError,
  type ProjectDto,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteBoardColumn,
  insertBoardColumn,
  listBoardColumns,
  patchBoardColumn,
} from './board-columns';
import type { Store } from './store';
import { getTask, insertTask } from './tasks';
import { createTestStore, seedProject } from './test-support';

let store: Store;
let close: () => void;
let project: ProjectDto;
beforeEach(() => {
  ({ store, close } = createTestStore());
  project = seedProject(store);
});
afterEach(() => {
  close();
});

const names = () => listBoardColumns(store.db, project.id).map((c) => c.name);
const add = (name: string) => store.write((ctx) => insertBoardColumn(ctx, project.id, { name })).value;
const columnId = (name: string) => {
  const found = listBoardColumns(store.db, project.id).find((c) => c.name === name);
  if (!found) throw new Error(name);
  return found.id;
};

describe('board columns', () => {
  it('gives a new project an Icebox column', () => {
    expect(names()).toEqual([DEFAULT_BOARD_COLUMN]);
    expect(listBoardColumns(store.db, project.id)[0]?.position).toBe(0);
  });

  it('appends a column and announces it', () => {
    const { value, events } = store.write((ctx) => insertBoardColumn(ctx, project.id, { name: ' Exploring ' }));
    expect(value).toMatchObject({ name: 'Exploring', position: 1 });
    expect(events).toEqual([expect.objectContaining({ type: EventType.BoardColumnSaved, entityType: 'board_column', entityId: value.id })]);
  });

  it('refuses a duplicate name in the same project only', () => {
    expect(() => add('Icebox')).toThrow(ConflictError);
    expect(() =>
      store.write((ctx) => insertBoardColumn(ctx, seedProject(store).id, { name: 'Exploring' })),
    ).not.toThrow();
  });

  it('renames a column, refusing a name another column has', () => {
    add('Exploring');
    store.write((ctx) => patchBoardColumn(ctx, columnId('Exploring'), { name: 'Needs spec' }));
    expect(names()).toEqual(['Icebox', 'Needs spec']);
    expect(() => store.write((ctx) => patchBoardColumn(ctx, columnId('Needs spec'), { name: 'Icebox' }))).toThrow(ConflictError);
  });

  it.each([
    { name: 'the first column to the end', column: 'Icebox', position: 2, expected: ['Exploring', 'Pending - Mark', 'Icebox'] },
    { name: 'the last column to the start', column: 'Pending - Mark', position: 0, expected: ['Pending - Mark', 'Icebox', 'Exploring'] },
    { name: 'a column past the end, clamped', column: 'Icebox', position: 9, expected: ['Exploring', 'Pending - Mark', 'Icebox'] },
    { name: 'a column to its own place', column: 'Exploring', position: 1, expected: ['Icebox', 'Exploring', 'Pending - Mark'] },
  ])('moves $name', ({ column, position, expected }) => {
    add('Exploring');
    add('Pending - Mark');
    const columns = store.write((ctx) => patchBoardColumn(ctx, columnId(column), { position })).value;
    expect(columns.map((c) => c.name)).toEqual(expected);
    expect(columns.map((c) => c.position)).toEqual([0, 1, 2]);
  });

  describe('delete', () => {
    const park = (title: string, column: string) => {
      const task = store.write((ctx) =>
        insertTask(ctx, project.id, { title, acceptanceCriteria: ['x'], areas: ['api'] }),
      ).value;
      store.db
        .update(schema.tasks)
        .set({ boardColumnId: columnId(column) })
        .where(eq(schema.tasks.id, task.id))
        .run();
      return task.id;
    };

    it.each([
      { name: 'another human column', target: 'Exploring', expected: 'Exploring' },
      { name: 'planned', target: null, expected: null },
    ])("moves a deleted column's tasks to $name", ({ target, expected }) => {
      add('Exploring');
      const parked = park('idea', 'Icebox');
      const { value, events } = store.write((ctx) =>
        deleteBoardColumn(ctx, columnId('Icebox'), { moveTasksTo: target === null ? null : columnId(target) }),
      );
      expect(value.map((c) => [c.name, c.position])).toEqual([['Exploring', 0]]);
      expect(getTask(store.db, parked).boardColumnId).toBe(expected === null ? null : columnId(expected));
      // The tasks move first, then the column goes, then Exploring closes the gap (position 1 to 0).
      expect(events.map((e) => e.type)).toEqual([
        EventType.TaskChanged,
        EventType.BoardColumnDeleted,
        EventType.BoardColumnSaved,
      ]);
    });

    it.each([
      { name: 'to itself', target: 'self' },
      { name: "to another project's column", target: 'other' },
    ])('refuses moving the tasks $name', ({ target }) => {
      const other = store.write((ctx) => insertBoardColumn(ctx, seedProject(store).id, { name: 'Elsewhere' })).value.id;
      const self = columnId('Icebox');
      expect(() =>
        store.write((ctx) => deleteBoardColumn(ctx, self, { moveTasksTo: target === 'self' ? self : other })),
      ).toThrow(InvalidError);
      expect(names()).toEqual(['Icebox']);
    });

    it('answers not found for an unknown column', () => {
      expect(() => store.write((ctx) => deleteBoardColumn(ctx, mintId('BoardColumn'), { moveTasksTo: null }))).toThrow(NotFoundError);
    });
  });
});
```

Add `import { eq } from 'drizzle-orm';` and `import * as schema from '../schema';` at the top (the `park` helper sets the column directly; Task 3's `moveTask` is the real path).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @10db/db exec vitest run src/store/board-columns.test.ts`
Expected: FAIL, `Cannot find module './board-columns'`.

- [ ] **Step 3: Change the schema and regenerate the baseline**

In `packages/db/src/schema.ts`, import the `BoardColumnId` type, add the table before `tasks`:

```ts
/** Columns the builder names and orders; a task in one is parked: never picked, never launched. */
export const boardColumns = sqliteTable(
  'board_columns',
  {
    id: text('id').$type<BoardColumnId>().primaryKey(),
    projectId: text('project_id')
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id),
    name: text('name').notNull(),
    position: integer('position').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('board_columns_name_idx').on(t.projectId, t.name)],
);
```

Then add to `tasks`, after `boardOrder`:

```ts
    /** Set: parked in that human column. Null: planned, with its column derived from its state. */
    boardColumnId: text('board_column_id')
      .$type<BoardColumnId>()
      .references(() => boardColumns.id),
```

Regenerate the baseline as `packages/db/AGENTS.md` says, from `packages/db`:

```bash
cp drizzle/0001_decisions_fts.sql /tmp/10db-decisions-fts.sql
rm -r drizzle
pnpm exec drizzle-kit generate --name init
pnpm exec drizzle-kit generate --custom --name decisions_fts
cp /tmp/10db-decisions-fts.sql drizzle/0001_decisions_fts.sql
git diff --stat -- drizzle
```

Expected: `0000_init.sql` gains `board_columns` and `tasks.board_column_id`, `0001_decisions_fts.sql` shows no diff, and `meta/` changes. (Use the scratch directory your session gives instead of `/tmp` if it has one.) A local data directory made before this change is refused with `StaleSchemaBaselineError`; delete it.

- [ ] **Step 4: Write the repository and seed Icebox**

In `packages/contracts/src/entities.ts`, import `BoardColumnId` and add `boardColumnId: BoardColumnId.nullable(),` to `TaskDto` after `boardOrder`. In `packages/db/src/store/tasks.ts`, `toTaskDto` adds `boardColumnId: row.boardColumnId,`. In `apps/desktop/src/test/fixtures.ts`, `taskDto` adds `boardColumnId: null,` to its defaults. Run `pnpm --filter @10db/contracts generate` (only `task-dto.schema.json` changes).

`packages/db/src/store/board-columns.ts`:

```ts
import {
  BoardColumnDelete,
  BoardColumnInput,
  BoardColumnPatch,
  ConflictError,
  EventType,
  InvalidError,
  mintId,
  NotFoundError,
  type BoardColumnDto,
  type BoardColumnId,
  type ProjectId,
} from '@10db/contracts';
import { and, asc, eq, ne } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

export function listBoardColumns(db: DbReader, projectId: ProjectId): BoardColumnDto[] {
  return db
    .select()
    .from(schema.boardColumns)
    .where(eq(schema.boardColumns.projectId, projectId))
    .orderBy(asc(schema.boardColumns.position), asc(schema.boardColumns.id))
    .all();
}

export function getBoardColumn(db: DbReader, id: BoardColumnId): BoardColumnDto {
  const row = db.select().from(schema.boardColumns).where(eq(schema.boardColumns.id, id)).get();
  if (!row) throw new NotFoundError('board column', id);
  return row;
}

function refuseDuplicate(db: DbReader, projectId: ProjectId, name: string, except: BoardColumnId | null): void {
  const clash = db
    .select({ id: schema.boardColumns.id })
    .from(schema.boardColumns)
    .where(
      and(
        eq(schema.boardColumns.projectId, projectId),
        eq(schema.boardColumns.name, name),
        ...(except ? [ne(schema.boardColumns.id, except)] : []),
      ),
    )
    .get();
  if (clash) throw new ConflictError(`This project already has a column named "${name}"`);
}

/** Writes positions 0…n-1 in the given order; each changed column announces it. */
function writePositions(ctx: WriteContext, ordered: readonly BoardColumnDto[]): void {
  ordered.forEach((column, position) => {
    if (column.position === position) return;
    ctx.tx
      .update(schema.boardColumns)
      .set({ position, updatedAt: ctx.now })
      .where(eq(schema.boardColumns.id, column.id))
      .run();
    ctx.emit({ type: EventType.BoardColumnSaved, entityType: 'board_column', entityId: column.id, data: { position } });
  });
}

export function insertBoardColumn(ctx: WriteContext, projectId: ProjectId, input: BoardColumnInput): BoardColumnDto {
  const { name } = BoardColumnInput.parse(input);
  refuseDuplicate(ctx.tx, projectId, name, null);
  const row: BoardColumnDto = {
    id: mintId('BoardColumn'),
    projectId,
    name,
    position: listBoardColumns(ctx.tx, projectId).length,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.boardColumns).values(row).run();
  ctx.emit({ type: EventType.BoardColumnSaved, entityType: 'board_column', entityId: row.id, data: { projectId } });
  return row;
}

export function patchBoardColumn(ctx: WriteContext, id: BoardColumnId, patch: BoardColumnPatch): BoardColumnDto[] {
  const changes = BoardColumnPatch.parse(patch);
  const column = getBoardColumn(ctx.tx, id);
  if (changes.name !== undefined && changes.name !== column.name) {
    refuseDuplicate(ctx.tx, column.projectId, changes.name, id);
    ctx.tx
      .update(schema.boardColumns)
      .set({ name: changes.name, updatedAt: ctx.now })
      .where(eq(schema.boardColumns.id, id))
      .run();
    ctx.emit({ type: EventType.BoardColumnSaved, entityType: 'board_column', entityId: id, data: { name: changes.name } });
  }
  if (changes.position !== undefined) {
    const rest = listBoardColumns(ctx.tx, column.projectId).filter((c) => c.id !== id);
    const at = Math.min(changes.position, rest.length);
    writePositions(ctx, [...rest.slice(0, at), column, ...rest.slice(at)]);
  }
  return listBoardColumns(ctx.tx, column.projectId);
}

/** Moves the column's tasks to another human column or to planned, then deletes it. */
export function deleteBoardColumn(ctx: WriteContext, id: BoardColumnId, del: BoardColumnDelete): BoardColumnDto[] {
  const { moveTasksTo } = BoardColumnDelete.parse(del);
  const column = getBoardColumn(ctx.tx, id);
  if (moveTasksTo !== null) {
    if (moveTasksTo === id) throw new InvalidError("A column's tasks can't move to the column being deleted");
    if (getBoardColumn(ctx.tx, moveTasksTo).projectId !== column.projectId)
      throw new InvalidError("The tasks must move to a column in the same project");
  }
  const parked = ctx.tx
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(eq(schema.tasks.boardColumnId, id))
    .all();
  for (const task of parked) {
    ctx.tx
      .update(schema.tasks)
      .set({ boardColumnId: moveTasksTo, updatedAt: ctx.now })
      .where(eq(schema.tasks.id, task.id))
      .run();
    ctx.emit({ type: EventType.TaskChanged, entityType: 'task', entityId: task.id, data: { boardColumnId: moveTasksTo } });
  }
  ctx.tx.delete(schema.boardColumns).where(eq(schema.boardColumns.id, id)).run();
  ctx.emit({ type: EventType.BoardColumnDeleted, entityType: 'board_column', entityId: id, data: { projectId: column.projectId } });
  writePositions(ctx, listBoardColumns(ctx.tx, column.projectId));
  return listBoardColumns(ctx.tx, column.projectId);
}
```

The `data` record must be JSON (`z.json()`): `moveTasksTo` is a string or null, so it fits.

Export it from `packages/db/src/store/index.ts` (`export * from './board-columns';`). In `packages/db/src/store/projects.ts`, after inserting the project row and emitting `ProjectCreated`:

```ts
  insertBoardColumn(ctx, row.id, { name: DEFAULT_BOARD_COLUMN });
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @10db/db exec vitest run && pnpm -r typecheck && pnpm --filter @10db/daemon exec vitest run`
Expected: PASS. The daemon suites still pass: a project now emits one more event at creation, and no daemon test counts creation events exactly. If one does, update its expected list to include `board_column.saved` and say so in the report.

- [ ] **Step 6: Commit**

```bash
pnpm format && git add packages/db/src/schema.ts packages/db/drizzle packages/db/src/store/board-columns.ts packages/db/src/store/board-columns.test.ts packages/db/src/store/index.ts packages/db/src/store/projects.ts packages/db/src/store/tasks.ts packages/contracts/src/entities.ts packages/contracts/generated/task-dto.schema.json apps/desktop/src/test/fixtures.ts && git commit -m 'feat(db): add human board columns, with icebox for every new project'
```

---

### Task 3: Moving tasks, and parked tasks never start

**Files:**
- Modify: `packages/db/src/store/tasks.ts`, `packages/db/src/store/workstreams.ts`
- Test: `packages/db/src/store/board-order.test.ts` (new)

**Interfaces:**
- Consumes: `TaskMove`, `getBoardColumn` (Tasks 1, 2).
- Produces:
  - `moveTask(ctx: WriteContext, id: TaskId, move: TaskMove): TaskDto`. It throws:
    - `NotFoundError` for an unknown task, neighbour or column;
    - `InvalidError` for a column or neighbour in another project, a neighbour outside the target column, or the task as its own neighbour;
    - `ConflictError` for neighbours in the wrong order, or a task whose derived status is In progress, Blocked or Done.
  - Emits `task.changed` with `data: { boardOrder, boardColumnId }`, plus one `task.changed` per task a renumbering changed.
  - `insertWorkstream` throws `ConflictError` ("Task ‹title› is parked in ‹column›; move it to Backlog or Ready to start it") for a parked task, so every start path (the start route, the delivery plan's batch route) refuses it.

- [ ] **Step 1: Write the failing tests**

`packages/db/src/store/board-order.test.ts`:

```ts
import {
  ConflictError,
  EventType,
  InvalidError,
  mintId,
  NotFoundError,
  type BoardColumnId,
  type ProjectDto,
  type TaskDto,
  type TaskMove,
} from '@10db/contracts';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../schema';
import { insertBoardColumn, listBoardColumns } from './board-columns';
import type { Store } from './store';
import { getTask, insertTask, listTasks, moveTask } from './tasks';
import { createTestStore, seedProject } from './test-support';
import { insertWorkstream } from './workstreams';

let store: Store;
let close: () => void;
let project: ProjectDto;
let icebox: BoardColumnId;
let tasks: Record<'a' | 'b' | 'c' | 'd', TaskDto>;
beforeEach(() => {
  ({ store, close } = createTestStore());
  project = seedProject(store);
  const first = listBoardColumns(store.db, project.id)[0];
  if (!first) throw new Error('no Icebox');
  icebox = first.id;
  const add = (title: string) =>
    store.write((ctx) => insertTask(ctx, project.id, { title, acceptanceCriteria: ['x'], areas: ['api'] })).value;
  // insertTask gives orders 1, 2, 3, 4, all planned.
  tasks = { a: add('a'), b: add('b'), c: add('c'), d: add('d') };
});
afterEach(() => {
  close();
});

const order = () => listTasks(store.db, project.id).map((t) => t.title);
const id = (key: keyof typeof tasks | null) => (key === null ? null : tasks[key].id);

describe('moveTask among planned tasks', () => {
  it.each([
    { name: 'between two tasks', task: 'd', after: 'a', before: 'b', expected: ['a', 'd', 'b', 'c'] },
    { name: 'to the top', task: 'c', after: null, before: 'a', expected: ['c', 'a', 'b', 'd'] },
    { name: 'to the bottom', task: 'a', after: 'd', before: null, expected: ['b', 'c', 'd', 'a'] },
    { name: 'down one place', task: 'b', after: 'c', before: 'd', expected: ['a', 'c', 'b', 'd'] },
    { name: 'to where it already is', task: 'b', after: 'a', before: 'c', expected: ['a', 'b', 'c', 'd'] },
  ] as const)('moves a task $name', ({ task, after, before, expected }) => {
    const moved = store.write((ctx) => moveTask(ctx, tasks[task].id, { to: null, after: id(after), before: id(before) }));
    expect(order()).toEqual(expected);
    expect(moved.events).toEqual([
      expect.objectContaining({
        type: EventType.TaskChanged,
        entityType: 'task',
        entityId: tasks[task].id,
        data: { boardOrder: moved.value.boardOrder, boardColumnId: null },
      }),
    ]);
  });

  it('answers a conflict for neighbours in the wrong order, and writes nothing', () => {
    expect(() => store.write((ctx) => moveTask(ctx, tasks.a.id, { to: null, after: tasks.d.id, before: tasks.b.id }))).toThrow(ConflictError);
    expect(order()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('renumbers the project when the gap is too small, keeping the order', () => {
    // Squeeze b right up against a, as fifty halvings would.
    store.db.update(schema.tasks).set({ boardOrder: 1 + 1e-9 }).where(eq(schema.tasks.id, tasks.b.id)).run();
    const moved = store.write((ctx) => moveTask(ctx, tasks.d.id, { to: null, after: tasks.a.id, before: tasks.b.id }));
    expect(order()).toEqual(['a', 'd', 'b', 'c']);
    expect(new Set(listTasks(store.db, project.id).map((t) => t.boardOrder)).size).toBe(4);
    // Renumbering 1, 1+1e-9, 3, 4 to 1, 2, 3, 4 changes only b; the move then changes d.
    expect(new Set(moved.events.map((e) => e.entityId))).toEqual(new Set([tasks.b.id, tasks.d.id]));
  });
});

describe('moveTask between columns', () => {
  it('parks a planned task in a human column and plans it again', () => {
    store.write((ctx) => moveTask(ctx, tasks.b.id, { to: icebox, after: null, before: null }));
    expect(getTask(store.db, tasks.b.id).boardColumnId).toBe(icebox);
    store.write((ctx) => moveTask(ctx, tasks.b.id, { to: null, after: tasks.c.id, before: tasks.d.id }));
    expect(getTask(store.db, tasks.b.id).boardColumnId).toBeNull();
    expect(order()).toEqual(['a', 'c', 'b', 'd']);
  });

  it('moves a parked task between human columns', () => {
    const exploring = store.write((ctx) => insertBoardColumn(ctx, project.id, { name: 'Exploring' })).value.id;
    store.write((ctx) => moveTask(ctx, tasks.a.id, { to: icebox, after: null, before: null }));
    store.write((ctx) => moveTask(ctx, tasks.a.id, { to: exploring, after: null, before: null }));
    expect(getTask(store.db, tasks.a.id).boardColumnId).toBe(exploring);
  });

  it.each([
    { name: 'a neighbour outside the target column', error: InvalidError, setup: 'planned-neighbour' },
    { name: "another project's column", error: InvalidError, setup: 'other-column' },
    { name: 'the task as its own neighbour', error: InvalidError, setup: 'self' },
    { name: 'an unknown column', error: NotFoundError, setup: 'unknown-column' },
    { name: 'an unknown neighbour', error: NotFoundError, setup: 'unknown-neighbour' },
  ] as const)('refuses $name', ({ error, setup }) => {
    const moveFor = (): TaskMove => {
      switch (setup) {
        case 'planned-neighbour':
          return { to: icebox, after: tasks.c.id, before: null };
        case 'other-column':
          return {
            to: store.write((ctx) => insertBoardColumn(ctx, seedProject(store).id, { name: 'Elsewhere' })).value.id,
            after: null,
            before: null,
          };
        case 'self':
          return { to: null, after: tasks.b.id, before: null };
        case 'unknown-column':
          return { to: mintId('BoardColumn'), after: null, before: null };
        case 'unknown-neighbour':
          return { to: null, after: mintId('Task'), before: null };
      }
    };
    const move = moveFor();
    expect(() => store.write((ctx) => moveTask(ctx, tasks.b.id, move))).toThrow(error);
  });

  it('refuses to move a running task', () => {
    store.write((ctx) => insertWorkstream(ctx, tasks.a.id));
    expect(() => store.write((ctx) => moveTask(ctx, tasks.a.id, { to: icebox, after: null, before: null }))).toThrow(ConflictError);
  });
});

describe('parked tasks', () => {
  it('refuses to start a parked task, naming its column', () => {
    store.write((ctx) => moveTask(ctx, tasks.a.id, { to: icebox, after: null, before: null }));
    expect(() => store.write((ctx) => insertWorkstream(ctx, tasks.a.id))).toThrow(
      'Task a is parked in Icebox; move it to Backlog or Ready to start it',
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @10db/db exec vitest run src/store/board-order.test.ts`
Expected: FAIL, `moveTask` is not exported from `./tasks`.

- [ ] **Step 3: Write `moveTask`**

In `packages/db/src/store/tasks.ts`, add `BoardStatus` (already imported), `ConflictError`, `TaskMove` and `type BoardColumnId` to the `@10db/contracts` import, `asc` to `drizzle-orm`, `getBoardColumn` from `./board-columns`, and:

```ts
/** Below this gap between neighbours a midpoint loses precision, so the project is renumbered first. */
const MIN_ORDER_GAP = 1e-6;

/** Only planned and parked work moves; the rest follows its workstream. */
const MOVABLE: readonly BoardStatus[] = [BoardStatus.Backlog, BoardStatus.Ready];

/** Rewrites the project's orders as 1…n in their current order; each changed task announces it. */
function renumberBoard(ctx: WriteContext, projectId: ProjectId): void {
  const rows = ctx.tx
    .select({ id: schema.tasks.id, boardOrder: schema.tasks.boardOrder })
    .from(schema.tasks)
    .where(eq(schema.tasks.projectId, projectId))
    .orderBy(asc(schema.tasks.boardOrder), asc(schema.tasks.id))
    .all();
  rows.forEach((row, index) => {
    const boardOrder = index + 1;
    if (row.boardOrder === boardOrder) return;
    ctx.tx.update(schema.tasks).set({ boardOrder, updatedAt: ctx.now }).where(eq(schema.tasks.id, row.id)).run();
    ctx.emit({ type: EventType.TaskChanged, entityType: 'task', entityId: row.id, data: { boardOrder } });
  });
}

/** Places a task in a column, between its new neighbours there (spec §10: drag and drop sets priority). */
export function moveTask(ctx: WriteContext, id: TaskId, move: TaskMove): TaskDto {
  const { to, after, before } = TaskMove.parse(move);
  const task = getTask(ctx.tx, id);
  if (!MOVABLE.includes(task.boardStatus))
    throw new ConflictError(`${task.title} follows its workstream; only planned and parked tasks move`);
  if (to !== null && getBoardColumn(ctx.tx, to).projectId !== task.projectId)
    throw new InvalidError('The column must belong to the same project');
  const orderOf = (neighbour: TaskId | null): number | null => {
    if (neighbour === null) return null;
    if (neighbour === id) throw new InvalidError('A task cannot be its own neighbour');
    const other = getTask(ctx.tx, neighbour);
    if (other.projectId !== task.projectId) throw new InvalidError('Both neighbours must be tasks in the same project');
    if (other.boardColumnId !== to) throw new InvalidError('A neighbour must be in the column the task moves to');
    return other.boardOrder;
  };
  const first = { lo: orderOf(after), hi: orderOf(before) };
  if (first.lo !== null && first.hi !== null) {
    if (first.lo >= first.hi) throw new ConflictError('The board changed while you were dragging; try again');
    if (first.hi - first.lo < MIN_ORDER_GAP) renumberBoard(ctx, task.projectId);
  }
  const lo = orderOf(after);
  const hi = orderOf(before);
  const boardOrder =
    lo !== null && hi !== null ? (lo + hi) / 2 : lo !== null ? lo + 1 : hi !== null ? hi - 1 : task.boardOrder;
  ctx.tx
    .update(schema.tasks)
    .set({ boardOrder, boardColumnId: to, updatedAt: ctx.now })
    .where(eq(schema.tasks.id, id))
    .run();
  ctx.emit({ type: EventType.TaskChanged, entityType: 'task', entityId: id, data: { boardOrder, boardColumnId: to } });
  return getTask(ctx.tx, id);
}
```

A parked task keeps its derived `boardStatus` (Backlog or Ready, since it has no active workstream), so `MOVABLE` covers parked tasks too.

In `packages/db/src/store/workstreams.ts`, in `insertWorkstream`, after the status check:

```ts
  if (task.boardColumnId !== null) {
    const column = getBoardColumn(ctx.tx, task.boardColumnId);
    throw new ConflictError(`Task ${task.title} is parked in ${column.name}; move it to Backlog or Ready to start it`);
  }
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @10db/db exec vitest run && pnpm --filter @10db/db typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format && git add packages/db/src/store/tasks.ts packages/db/src/store/workstreams.ts packages/db/src/store/board-order.test.ts && git commit -m 'feat(db): move tasks between board columns and never start a parked task'
```

---

### Task 4: Routes for moving tasks and editing board columns

**Files:**
- Modify: `apps/daemon/src/api/app.ts`, `apps/daemon/src/api/services.ts`, `apps/daemon/src/daemon/services.ts`
- Test: `apps/daemon/src/api/app.test.ts`, `apps/daemon/src/daemon/start.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces these routes. Every body is parsed with its contracts schema:

| Method and path | Body | Answers |
|---|---|---|
| `POST /tasks/:taskId/move` | `TaskMove` | `TaskDto`; 409 for a stale or locked move |
| `GET /projects/:projectId/board-columns` | | `BoardColumnDto[]` by position; 404 for an unknown project |
| `POST /projects/:projectId/board-columns` | `BoardColumnInput` | 201 `BoardColumnDto`; 409 for a duplicate name |
| `PATCH /board-columns/:columnId` | `BoardColumnPatch` | `BoardColumnDto[]` |
| `POST /board-columns/:columnId/delete` | `BoardColumnDelete` | `BoardColumnDto[]` |

`ApiServices` gains `moveTask(id, move): TaskDto`, `listBoardColumns(projectId): BoardColumnDto[]`, `createBoardColumn(projectId, input): BoardColumnDto`, `patchBoardColumn(id, patch): BoardColumnDto[]` and `deleteBoardColumn(id, del): BoardColumnDto[]`. The desktop calls them as `client.tasks[':taskId'].move.$post(…)`, `client.projects[':projectId']['board-columns'].$get(…)` / `.$post(…)`, `client['board-columns'][':columnId'].$patch(…)` and `client['board-columns'][':columnId'].delete.$post(…)`.

- [ ] **Step 1: Write the failing tests**

In `apps/daemon/src/api/app.test.ts`, add tracking stubs for the five methods to `stubServices` and:

```ts
describe('board routes', () => {
  const taskId = mintId('Task');
  const projectId = mintId('Project');
  const columnId = mintId('BoardColumn');
  it.each([
    { name: 'POST /tasks/:id/move', method: 'POST', path: `/tasks/${taskId}/move`, body: { to: null, after: mintId('Task'), before: null }, service: 'moveTask' },
    { name: 'GET /projects/:id/board-columns', method: 'GET', path: `/projects/${projectId}/board-columns`, body: undefined, service: 'listBoardColumns' },
    { name: 'POST /projects/:id/board-columns', method: 'POST', path: `/projects/${projectId}/board-columns`, body: { name: 'Exploring' }, service: 'createBoardColumn' },
    { name: 'PATCH /board-columns/:id', method: 'PATCH', path: `/board-columns/${columnId}`, body: { position: 0 }, service: 'patchBoardColumn' },
    { name: 'POST /board-columns/:id/delete', method: 'POST', path: `/board-columns/${columnId}/delete`, body: { moveTasksTo: null }, service: 'deleteBoardColumn' },
  ] as const)('routes $name to its service', async ({ method, path, body, service }) => {
    const res = await app().request(path, { method, ...(body === undefined ? auth : { ...json, body: JSON.stringify(body) }) });
    expect(res.status).toBe(500);
    expect(reached).toEqual([service]);
  });

  it.each([
    { name: 'a move between a task and itself', path: `/tasks/${taskId}/move`, method: 'POST', body: { to: null, after: taskId, before: taskId } },
    { name: 'a malformed task id', path: '/tasks/nope/move', method: 'POST', body: { to: null, after: null, before: null } },
    { name: 'an empty column name', path: `/projects/${projectId}/board-columns`, method: 'POST', body: { name: ' ' } },
    { name: 'an empty column patch', path: `/board-columns/${columnId}`, method: 'PATCH', body: {} },
    { name: 'a delete with no target', path: `/board-columns/${columnId}/delete`, method: 'POST', body: {} },
  ])('answers 400 for $name without calling a service', async ({ path, method, body }) => {
    const res = await app().request(path, { method, ...json, body: JSON.stringify(body) });
    expect(res.status).toBe(400);
    expect(reached).toEqual([]);
  });

  it('answers 409 with the message when the board changed', async () => {
    const res = await app(
      stubServices({
        moveTask: () => {
          throw new ConflictError('The board changed while you were dragging; try again');
        },
      }),
    ).request(`/tasks/${taskId}/move`, { method: 'POST', ...json, body: JSON.stringify({ to: null, after: mintId('Task'), before: mintId('Task') }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ message: 'The board changed while you were dragging; try again' });
  });
});
```

(`json` and `auth` are the file's existing helpers; use whatever names it has.)

In `apps/daemon/src/daemon/start.test.ts`, add a test against the real daemon:

```ts
  it('gives a project Icebox, parks a task in it, refuses to start it, and plans it again', async () => {
    const repo = createTempRepo();
    try {
      daemon = await startDaemon({ dataDir: dir.path, port: 0, adapter: new FakeAdapter({}), logLevel: 'warn', ...QUIET });
      const api = apiClient(daemon.url, daemon.token);
      const project = await api.post('/projects', ProjectDto, { name: 'demo', repoPath: repo.path, gateCommand: 'true', areas: [{ name: 'src', globs: ['src/**'] }] });
      const [icebox] = await api.get(`/projects/${project.id}/board-columns`, z.array(BoardColumnDto));
      expect(icebox?.name).toBe('Icebox');
      if (!icebox) throw new Error('no Icebox');
      const add = (title: string) => api.post(`/projects/${project.id}/tasks`, TaskDto, { title, acceptanceCriteria: ['x'], areas: ['src'] });
      const first = await add('first');
      const second = await add('second');
      await api.post(`/tasks/${second.id}/move`, TaskDto, { to: null, after: null, before: first.id });
      expect((await api.get(`/projects/${project.id}/tasks`, z.array(TaskDto))).map((t) => t.title)).toEqual(['second', 'first']);
      const parked = await api.post(`/tasks/${first.id}/move`, TaskDto, { to: icebox.id, after: null, before: null });
      expect(parked.boardColumnId).toBe(icebox.id);
      await expect(api.post(`/tasks/${first.id}/start`, WorkstreamDto)).rejects.toThrow('-> 409');
      const exploring = await api.post(`/projects/${project.id}/board-columns`, BoardColumnDto, { name: 'Exploring' });
      const columns = await api.post(`/board-columns/${icebox.id}/delete`, z.array(BoardColumnDto), { moveTasksTo: exploring.id });
      expect(columns.map((c) => c.name)).toEqual(['Exploring']);
    } finally {
      repo.cleanup();
    }
  });
```

Import `BoardColumnDto`, `ProjectDto`, `TaskDto` and `WorkstreamDto` from `@10db/contracts` there if they aren't imported yet.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @10db/daemon exec vitest run src/api/app.test.ts src/daemon/start.test.ts`
Expected: FAIL. The route table fails with `expected 500, received 404` (Vitest doesn't typecheck, so the missing service methods surface as unknown routes), and the start test fails on `-> 404`.

- [ ] **Step 3: Add the services and the routes**

In `apps/daemon/src/api/services.ts`, import the types and add:

```ts
  /** Places a task in a column between new neighbours; throws ConflictError for a stale or locked move. */
  moveTask(id: TaskId, move: TaskMove): TaskDto;
  listBoardColumns(projectId: ProjectId): BoardColumnDto[];
  createBoardColumn(projectId: ProjectId, input: BoardColumnInput): BoardColumnDto;
  patchBoardColumn(id: BoardColumnId, patch: BoardColumnPatch): BoardColumnDto[];
  /** Moves the column's tasks to another column or to planned, then deletes it. */
  deleteBoardColumn(id: BoardColumnId, del: BoardColumnDelete): BoardColumnDto[];
```

In `apps/daemon/src/daemon/services.ts`, import the repositories from `@10db/db` and add:

```ts
    moveTask: (id, move) => deps.state.write((ctx) => moveTask(ctx, id, move)),
    listBoardColumns(projectId) {
      getProject(db, projectId);
      return listBoardColumns(db, projectId);
    },
    createBoardColumn(projectId, input) {
      getProject(db, projectId);
      return deps.state.write((ctx) => insertBoardColumn(ctx, projectId, input));
    },
    patchBoardColumn: (id, patch) => deps.state.write((ctx) => patchBoardColumn(ctx, id, patch)),
    deleteBoardColumn: (id, del) => deps.state.write((ctx) => deleteBoardColumn(ctx, id, del)),
```

In `apps/daemon/src/api/app.ts`, import the schemas and chain after `PATCH /tasks/:taskId`:

```ts
    .post(
      '/tasks/:taskId/move',
      validator('json', (value): TaskMove => TaskMove.parse(value)),
      (c) => c.json(deps.services.moveTask(TaskId.parse(c.req.param('taskId')), c.req.valid('json'))),
    )
    .get('/projects/:projectId/board-columns', (c) =>
      c.json(deps.services.listBoardColumns(ProjectId.parse(c.req.param('projectId')))),
    )
    .post(
      '/projects/:projectId/board-columns',
      validator('json', (value): BoardColumnInput => BoardColumnInput.parse(value)),
      (c) => c.json(deps.services.createBoardColumn(ProjectId.parse(c.req.param('projectId')), c.req.valid('json')), 201),
    )
    .patch(
      '/board-columns/:columnId',
      validator('json', (value): BoardColumnPatch => BoardColumnPatch.parse(value)),
      (c) => c.json(deps.services.patchBoardColumn(BoardColumnId.parse(c.req.param('columnId')), c.req.valid('json'))),
    )
    .post(
      '/board-columns/:columnId/delete',
      validator('json', (value): BoardColumnDelete => BoardColumnDelete.parse(value)),
      (c) => c.json(deps.services.deleteBoardColumn(BoardColumnId.parse(c.req.param('columnId')), c.req.valid('json'))),
    )
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @10db/daemon exec vitest run && pnpm -r typecheck`
Expected: PASS; the desktop typechecks against the new `AppType`.

- [ ] **Step 5: Commit**

```bash
pnpm format && git add apps/daemon/src/api/app.ts apps/daemon/src/api/services.ts apps/daemon/src/api/app.test.ts apps/daemon/src/daemon/services.ts apps/daemon/src/daemon/start.test.ts && git commit -m 'feat(daemon): serve task moves and board column editing'
```

---

### Task 5: The board replaces the Tasks view

The board with its human and system columns and cards, the project and task forms, and each card's Start. Drag and drop and the move menu are Task 6.

**Files:**
- Rename (Step 1): `apps/desktop/src/views/tasks/` → `apps/desktop/src/views/board/`; `tasks-view.tsx` → `board-view.tsx`; `tasks-view.test.tsx` → `board-view.test.tsx`; `views/board/project-picker.tsx` → `apps/desktop/src/shell/project-picker.tsx`
- Create: `apps/desktop/src/shell/selected-project.ts`, `apps/desktop/src/views/board/board-layout.ts`, `board-layout.test.ts`, `board-column.tsx`, `task-card.tsx`, `task-card-menu.tsx`
- Modify: `apps/desktop/src/views/board/board-status-badge.tsx`, `apps/desktop/src/daemon/queries.ts`, `apps/desktop/src/daemon/events.ts`, `apps/desktop/src/test/fixtures.ts`, `apps/desktop/src/router.tsx`, `apps/desktop/src/shell/app-layout.tsx`, `apps/desktop/e2e/loop.spec.ts` (only the view name and the start, so the gate stays green; Task 10 extends it)

**Interfaces:**
- Consumes: `TaskDto.boardStatus`, `.boardOrder`, `.boardColumnId`, `.dependsOn`, `.workstreamId`; `GET /projects/:projectId/board-columns` (Task 4); `useProjects`, `useTasks`, `useWorkstreams`, `useStartTask`; `StateBadge`, `StepCell`.
- Produces:
  - `useSelectedProject(): { projects: UseQueryResult<ProjectDto[]>; project: ProjectDto | null; select(id: ProjectId | null): void }` in `shell/selected-project.ts`. It remembers the choice under the existing `tendb.project` key and is used by the board and Settings (Task 7).
  - `useBoardColumns(projectId: ProjectId | null)` and `queryKeys.boardColumns(projectId)` in `daemon/queries.ts`; `INVALIDATIONS.board_column = [['board-columns']]`.
  - In `board-layout.ts`:
    - `ColumnKey = { kind: 'human'; id: BoardColumnId } | { kind: 'system'; status: BoardStatus }`;
    - `LayoutColumn = { key: ColumnKey; label: string; tasks: readonly TaskDto[] }`;
    - `SYSTEM_COLUMNS`, `DONE_LIMIT = 20`;
    - `columnKeyId(key: ColumnKey): string` (`human:<id>` or `system:<status>`);
    - `sameColumn(a: ColumnKey, b: ColumnKey): boolean`;
    - `boardLayout(columns: readonly BoardColumnDto[], tasks: readonly TaskDto[]): LayoutColumn[]`, with human columns first by position, then the five system columns.
  - `BOARD_STATUS` (label and color per status), exported from `board-status-badge.tsx`.
  - `BoardColumn({ label, count, locked, children, footer })`: a titled `<ul aria-label="{label} tasks">`, with a lock icon on system columns.
  - `TaskCard({ task, workstream, peers, menu, handle })`: one card.
  - `TaskCardMenu({ task, latest, onStart })`: the card's action menu, named `Actions for {title}`, with Start when `canStart` allows it.
  - `canStart(task, latest)`: today's rule, and never for a parked task.
  - Route `/board`; `/tasks` redirects to `/board`; nav Board, Factory, Inbox (Settings is added by Task 7).

- [ ] **Step 1: Move the files**

`views/board/` must not exist before this step, so the renames come first:

```bash
git mv apps/desktop/src/views/tasks apps/desktop/src/views/board
git mv apps/desktop/src/views/board/tasks-view.tsx apps/desktop/src/views/board/board-view.tsx
git mv apps/desktop/src/views/board/tasks-view.test.tsx apps/desktop/src/views/board/board-view.test.tsx
git mv apps/desktop/src/views/board/project-picker.tsx apps/desktop/src/shell/project-picker.tsx
```

Fix the moved files' relative imports (`project-picker.tsx` imports `../daemon/queries`; `board-view.tsx` imports `../../shell/project-picker`). Run `pnpm --filter @10db/desktop typecheck`; expect PASS before anything else changes.

- [ ] **Step 2: Write the failing tests**

Add a fixture to `apps/desktop/src/test/fixtures.ts` (`BoardColumnDto` from `@10db/contracts`):

```ts
export function boardColumnDto(overrides: Partial<BoardColumnDto> = {}): BoardColumnDto {
  return BoardColumnDto.parse({
    id: mintId('BoardColumn'),
    projectId: mintId('Project'),
    name: 'Icebox',
    position: 0,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}
```

`apps/desktop/src/views/board/board-layout.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { boardColumnDto, taskDto } from '../../test/fixtures';
import { boardLayout, columnKeyId, DONE_LIMIT } from './board-layout';

const at = (minute: number) => `2026-10-13T12:${String(minute).padStart(2, '0')}:00.000Z`;
const icebox = boardColumnDto({ name: 'Icebox', position: 0 });
const exploring = boardColumnDto({ name: 'Exploring', position: 1 });

describe('boardLayout', () => {
  it('lists human columns by position, then the system columns in the spec’s order', () => {
    expect(boardLayout([exploring, icebox], []).map((c) => c.label)).toEqual([
      'Icebox',
      'Exploring',
      'Backlog',
      'Ready',
      'In progress',
      'Blocked',
      'Done',
    ]);
  });

  it.each([
    {
      name: 'a parked task in its human column, whatever its status',
      tasks: [taskDto({ title: 'idea', boardStatus: 'ready', boardColumnId: icebox.id })],
      expected: { Icebox: ['idea'], Ready: [] },
    },
    {
      name: 'planned tasks by board status, in board order',
      tasks: [
        taskDto({ title: 'r2', boardStatus: 'ready', boardOrder: 2 }),
        taskDto({ title: 'b1', boardStatus: 'backlog', boardOrder: 1 }),
        taskDto({ title: 'r1', boardStatus: 'ready', boardOrder: 0.5 }),
      ],
      expected: { Backlog: ['b1'], Ready: ['r1', 'r2'] },
    },
    {
      name: 'a task whose column is gone in its system column',
      tasks: [taskDto({ title: 'orphan', boardStatus: 'backlog', boardColumnId: boardColumnDto().id })],
      expected: { Backlog: ['orphan'], Icebox: [] },
    },
    {
      name: 'done tasks most recently finished first',
      tasks: [
        taskDto({ title: 'old', boardStatus: 'done', status: 'done', updatedAt: at(1) }),
        taskDto({ title: 'new', boardStatus: 'done', status: 'done', updatedAt: at(9) }),
      ],
      expected: { Done: ['new', 'old'] },
    },
  ])('puts $name', ({ tasks, expected }) => {
    const layout = boardLayout([icebox, exploring], tasks);
    for (const [label, titles] of Object.entries(expected))
      expect(layout.find((c) => c.label === label)?.tasks.map((t) => t.title)).toEqual(titles);
  });

  it('gives each column a stable key and keeps the done limit at 20', () => {
    const [first] = boardLayout([icebox], []);
    if (!first) throw new Error('no column');
    expect(columnKeyId(first.key)).toBe(`human:${icebox.id}`);
    expect(columnKeyId({ kind: 'system', status: 'ready' })).toBe('system:ready');
    expect(DONE_LIMIT).toBe(20);
  });
});
```

`board-view.test.tsx` (the renamed `tasks-view.test.tsx`): rename the `describe` to `BoardView` and replace every `renderApp('/tasks')` with `renderApp('/board')`. Add `http.get(daemonUrl('/projects/:projectId/board-columns'), () => HttpResponse.json([]))` to the file's `serve()` defaults, so every test has columns; tests that need them override it. Then change the three tests that find a task row:
- `starts a ready task`: find the card instead of the row, and start it from its menu:

```tsx
    const ready = await screen.findByRole('list', { name: 'Ready tasks' });
    const card = within(ready).getByRole('listitem', { name: 'Alpha' });
    fireEvent.click(within(card).getByRole('button', { name: 'Actions for Alpha' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Start' }));
```

- The `it.each` over workstream states: find the card with `screen.findByRole('listitem', { name: 'Busy' })`, open its menu, and assert that `screen.queryByRole('menuitem', { name: 'Start' }) !== null` equals `startable`. Close the menu with `fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })`.
- `creates a task …`: the last line becomes `expect(await screen.findByRole('listitem', { name: 'Beta' })).toBeTruthy();`.

Then add:

```tsx
  it('shows human columns before the system columns, and each task where it belongs', async () => {
    const project = projectDto();
    const icebox = boardColumnDto({ projectId: project.id, name: 'Icebox' });
    const ws = workstreamDto({ projectId: project.id, taskTitle: 'Base', state: 'RUNNING' });
    const running = taskDto({ id: ws.taskId, projectId: project.id, title: 'Base', boardStatus: 'in_progress', boardOrder: 1, workstreamId: ws.id });
    const next = taskDto({ projectId: project.id, title: 'Next', boardStatus: 'backlog', boardOrder: 2, areas: ['api', 'ui'], dependsOn: [running.id] });
    const idea = taskDto({ projectId: project.id, title: 'Idea', boardStatus: 'ready', boardOrder: 3, boardColumnId: icebox.id });
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/board-columns'), () => HttpResponse.json([icebox])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([running, next, idea])),
      http.get(daemonUrl('/workstreams'), () => HttpResponse.json([ws])),
    );
    renderApp('/board');

    const lists = await screen.findAllByRole('list', { name: / tasks$/ });
    expect(lists.map((l) => l.getAttribute('aria-label'))).toEqual([
      'Icebox tasks',
      'Backlog tasks',
      'Ready tasks',
      'In progress tasks',
      'Blocked tasks',
      'Done tasks',
    ]);
    const inProgress = screen.getByRole('list', { name: 'In progress tasks' });
    expect(await within(within(inProgress).getByRole('listitem', { name: 'Base' })).findByText('Running')).toBeTruthy();
    const nextCard = within(screen.getByRole('list', { name: 'Backlog tasks' })).getByRole('listitem', { name: 'Next' });
    expect(within(nextCard).getByText('api')).toBeTruthy();
    expect(within(nextCard).getByText('Waits on Base')).toBeTruthy();
    expect(within(screen.getByRole('list', { name: 'Icebox tasks' })).getByRole('listitem', { name: 'Idea' })).toBeTruthy();
    expect(within(screen.getByRole('list', { name: 'Ready tasks' })).queryByRole('listitem', { name: 'Idea' })).toBeNull();
  });

  it('offers no Start on a parked card', async () => {
    const project = projectDto();
    const icebox = boardColumnDto({ projectId: project.id });
    const idea = taskDto({ projectId: project.id, title: 'Idea', boardStatus: 'ready', boardColumnId: icebox.id });
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/board-columns'), () => HttpResponse.json([icebox])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([idea])),
    );
    renderApp('/board');
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Idea' }));
    expect(await screen.findByRole('menu')).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Start' })).toBeNull();
  });

  it('shows the 20 most recent done tasks and the rest on request', async () => {
    const project = projectDto();
    const done = Array.from({ length: 22 }, (_, i) =>
      taskDto({ projectId: project.id, title: `Done ${String(i)}`, boardStatus: 'done', status: 'done', boardOrder: i, updatedAt: `2026-10-13T12:${String(i).padStart(2, '0')}:00.000Z` }),
    );
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json(done)),
    );
    renderApp('/board');

    const column = await screen.findByRole('list', { name: 'Done tasks' });
    expect(within(column).getAllByRole('listitem')).toHaveLength(20);
    expect(within(column).queryByRole('listitem', { name: 'Done 0' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show all 22' }));
    expect(within(column).getAllByRole('listitem')).toHaveLength(22);
  });

  it('redirects /tasks to the board', async () => {
    serve();
    const { router } = renderApp('/tasks');
    expect(await screen.findByRole('heading', { name: 'Board', level: 2 })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/board');
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @10db/desktop exec vitest run src/views/board`
Expected: FAIL: `./board-layout` doesn't exist and `/board` isn't a route.

- [ ] **Step 4: Extract the selected project and add the columns query**

`apps/desktop/src/shell/selected-project.ts` (the logic moves out of the old `TasksView` unchanged):

```ts
import { ProjectId, type ProjectDto } from '@10db/contracts';
import { useLocalStorage } from '@mantine/hooks';
import type { UseQueryResult } from '@tanstack/react-query';
import { useProjects } from '../daemon/queries';

/** The remembered project id comes from storage, so it is validated before it is trusted. */
function deserializeProjectId(value: string | undefined): ProjectId | null {
  try {
    if (value === undefined) return null;
    const parsed = ProjectId.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface SelectedProject {
  readonly projects: UseQueryResult<ProjectDto[]>;
  readonly project: ProjectDto | null;
  select(id: ProjectId | null): void;
}

/** The project the board and Settings show; a remembered project that no longer exists falls back to the first. */
export function useSelectedProject(): SelectedProject {
  const projects = useProjects();
  const [storedId, setStoredId] = useLocalStorage<ProjectId | null>({
    key: 'tendb.project',
    defaultValue: null,
    getInitialValueInEffect: false,
    deserialize: deserializeProjectId,
  });
  const list = projects.data ?? [];
  const project = list.find((p) => p.id === storedId) ?? list[0] ?? null;
  return { projects, project, select: setStoredId };
}
```

In `apps/desktop/src/daemon/queries.ts`, add `boardColumns: (projectId: ProjectId) => ['board-columns', projectId] as const,` to `queryKeys`, and:

```ts
const BoardColumnList = z.array(BoardColumnDto);

export function useBoardColumns(projectId: ProjectId | null) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: projectId ? queryKeys.boardColumns(projectId) : ['board-columns', 'none'],
    queryFn: async () =>
      projectId
        ? readJson(await client.projects[':projectId']['board-columns'].$get({ param: { projectId } }), BoardColumnList)
        : [],
    enabled: projectId !== null,
  });
}
```

In `apps/desktop/src/daemon/events.ts`, add `board_column: [['board-columns']],` to `INVALIDATIONS`.

- [ ] **Step 5: Write the layout, the column and the card**

In `board-status-badge.tsx`, export the existing label map as `BOARD_STATUS` (`label` and `color` per status), so the column header and the badge share it.

`apps/desktop/src/views/board/board-layout.ts`:

```ts
import { BoardStatus, type BoardColumnDto, type BoardColumnId, type TaskDto } from '@10db/contracts';
import { BOARD_STATUS } from './board-status-badge';

export type ColumnKey =
  | { readonly kind: 'human'; readonly id: BoardColumnId }
  | { readonly kind: 'system'; readonly status: BoardStatus };

export interface LayoutColumn {
  readonly key: ColumnKey;
  readonly label: string;
  readonly tasks: readonly TaskDto[];
}

/** Spec §10's derived columns, in order; they sit right of the human columns. */
export const SYSTEM_COLUMNS: readonly BoardStatus[] = [
  BoardStatus.Backlog,
  BoardStatus.Ready,
  BoardStatus.InProgress,
  BoardStatus.Blocked,
  BoardStatus.Done,
];

/** Done cards shown before "Show all"; the column only grows. */
export const DONE_LIMIT = 20;

export function columnKeyId(key: ColumnKey): string {
  switch (key.kind) {
    case 'human':
      return `human:${key.id}`;
    case 'system':
      return `system:${key.status}`;
  }
}

export function sameColumn(a: ColumnKey, b: ColumnKey): boolean {
  return columnKeyId(a) === columnKeyId(b);
}

const byOrder = (a: TaskDto, b: TaskDto) => a.boardOrder - b.boardOrder;
const recentFirst = (a: TaskDto, b: TaskDto) => b.updatedAt.localeCompare(a.updatedAt);

/**
 * The board's columns: the builder's human columns by position, then the system columns. A parked
 * task sits in its human column; every other task, and one whose column is gone, in its derived one.
 */
export function boardLayout(columns: readonly BoardColumnDto[], tasks: readonly TaskDto[]): LayoutColumn[] {
  const human = [...columns].sort((a, b) => a.position - b.position);
  const known = new Set(human.map((c) => c.id));
  const parkedIn = (task: TaskDto) => (task.boardColumnId !== null && known.has(task.boardColumnId) ? task.boardColumnId : null);
  return [
    ...human.map((column): LayoutColumn => ({
      key: { kind: 'human', id: column.id },
      label: column.name,
      tasks: tasks.filter((t) => parkedIn(t) === column.id).sort(byOrder),
    })),
    ...SYSTEM_COLUMNS.map((status): LayoutColumn => ({
      key: { kind: 'system', status },
      label: BOARD_STATUS[status].label,
      tasks: tasks
        .filter((t) => parkedIn(t) === null && t.boardStatus === status)
        .sort(status === BoardStatus.Done ? recentFirst : byOrder),
    })),
  ];
}
```

`apps/desktop/src/views/board/board-column.tsx`:

```tsx
import { Badge, Group, Paper, Stack, Text, Tooltip } from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import type { ReactNode } from 'react';

export interface BoardColumnProps {
  readonly label: string;
  readonly count: number;
  /** System columns follow task state; the builder can't rename or delete them. */
  readonly locked: boolean;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}

/** One column: a titled list whose items are task cards. */
export function BoardColumn({ label, count, locked, children, footer }: BoardColumnProps) {
  return (
    <Paper withBorder radius="md" p="xs" miw={220}>
      <Stack gap="xs">
        <Group justify="space-between">
          <Group gap={4}>
            <Text fw={600} size="sm">
              {label}
            </Text>
            {locked ? (
              <Tooltip label="Follows the task's state">
                <IconLock size={14} stroke={1.5} aria-label="Follows the task's state" />
              </Tooltip>
            ) : null}
          </Group>
          <Badge size="sm" variant="light" color="gray">
            {count}
          </Badge>
        </Group>
        <Stack component="ul" gap="xs" m={0} p={0} style={{ listStyle: 'none' }} aria-label={`${label} tasks`}>
          {children}
        </Stack>
        {footer}
      </Stack>
    </Paper>
  );
}
```

`apps/desktop/src/views/board/task-card-menu.tsx`:

```tsx
import { BoardStatus, TaskStatus, WorkstreamState, type TaskDto } from '@10db/contracts';
import { ActionIcon, Menu } from '@mantine/core';
import { IconDots } from '@tabler/icons-react';

const STARTABLE: readonly BoardStatus[] = [BoardStatus.Ready, BoardStatus.Backlog];
/** A task whose latest workstream ended without finishing can run again. */
const RESTARTABLE: readonly WorkstreamState[] = [WorkstreamState.Failed, WorkstreamState.Cancelled];

/** Today's rule (a Backlog task queues until its dependencies finish), and never a parked task. */
export function canStart(task: TaskDto, latest: WorkstreamState | undefined): boolean {
  if (task.boardColumnId !== null) return false;
  if (task.status !== TaskStatus.Open || !STARTABLE.includes(task.boardStatus)) return false;
  return task.workstreamId === null || (latest !== undefined && RESTARTABLE.includes(latest));
}

export interface TaskCardMenuProps {
  readonly task: TaskDto;
  readonly latest: WorkstreamState | undefined;
  readonly onStart: () => void;
}

export function TaskCardMenu({ task, latest, onStart }: TaskCardMenuProps) {
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon variant="subtle" size="sm" aria-label={`Actions for ${task.title}`}>
          <IconDots size={16} stroke={1.5} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {canStart(task, latest) ? <Menu.Item onClick={onStart}>Start</Menu.Item> : null}
      </Menu.Dropdown>
    </Menu>
  );
}
```

`apps/desktop/src/views/board/task-card.tsx`:

```tsx
import { TaskStatus, type TaskDto, type TaskId, type WorkstreamDto } from '@10db/contracts';
import { Badge, Code, Group, Paper, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { StateBadge } from '../factory/state-badge';
import { StepCell } from '../factory/step-cell';

export interface TaskCardProps {
  readonly task: TaskDto;
  /** The task's workstream while it is active or failed; a finished one isn't repeated on the card. */
  readonly workstream: WorkstreamDto | undefined;
  /** Titles and statuses of the project's tasks, for the dependency marker. */
  readonly peers: ReadonlyMap<TaskId, Pick<TaskDto, 'title' | 'status'>>;
  readonly menu: ReactNode;
  /** The drag handle (Task 6). */
  readonly handle?: ReactNode;
}

/** A board card: title, areas, unfinished dependencies and live workstream state (spec §10). */
export function TaskCard({ task, workstream, peers, menu, handle }: TaskCardProps) {
  const waits = task.dependsOn.flatMap((id) => {
    const peer = peers.get(id);
    return peer && peer.status !== TaskStatus.Done ? [peer.title] : [];
  });
  return (
    <Paper withBorder radius="md" p="xs">
      <Stack gap={4}>
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <Group gap={4} wrap="nowrap">
            {handle}
            <Text size="sm" fw={500}>
              {task.title}
            </Text>
          </Group>
          {menu}
        </Group>
        <Group gap={4}>
          {task.areas.map((area) => (
            <Code key={area}>{area}</Code>
          ))}
          {task.status === TaskStatus.Cancelled ? (
            <Badge size="xs" color="gray" variant="light">
              Cancelled
            </Badge>
          ) : null}
        </Group>
        {waits.length > 0 ? <Text size="xs" c="dimmed">{`Waits on ${waits.join(', ')}`}</Text> : null}
        {workstream ? (
          <Group gap="xs" align="flex-start">
            <StateBadge state={workstream.state} />
            <StepCell workstream={workstream} />
          </Group>
        ) : null}
      </Stack>
    </Paper>
  );
}
```

The `<li>` wrapper lives in the view (`<li aria-label={task.title}>…</li>`), so Task 6 can make it the sortable node.

- [ ] **Step 6: Write the view, the route and the nav**

`board-view.tsx` keeps the old view's header (Title "Board", `ProjectPicker`, New project, New task), alerts, empty states and modals, with `useSelectedProject()` in place of the inline storage logic. The table becomes the columns. Add `useBoardColumns(project?.id ?? null)` beside `useTasks`, with an error `Alert` ("Couldn't load the board columns") like the others:

```tsx
  const layout = boardLayout(columns.data ?? [], taskList);
  const latestOf = new Map((workstreams.data ?? []).map((ws) => [ws.id, ws]));
  const peers = new Map(taskList.map((t) => [t.id, t]));
  const SHOWN_STATES: readonly WorkstreamState[] = Object.values(WorkstreamState).filter(
    (s) => s !== WorkstreamState.Done && s !== WorkstreamState.Cancelled,
  );
  // …
      {project && tasks.isSuccess ? (
        <ScrollArea type="auto" offsetScrollbars>
          <Group align="flex-start" wrap="nowrap" gap="sm">
            {layout.map((column) => {
              const isDone = column.key.kind === 'system' && column.key.status === BoardStatus.Done;
              const shown = isDone && !showAllDone ? column.tasks.slice(0, DONE_LIMIT) : column.tasks;
              return (
                <BoardColumn
                  key={columnKeyId(column.key)}
                  label={column.label}
                  count={column.tasks.length}
                  locked={column.key.kind === 'system'}
                  footer={
                    shown.length < column.tasks.length ? (
                      <Button variant="subtle" size="xs" onClick={() => { setShowAllDone(true); }}>
                        {`Show all ${String(column.tasks.length)}`}
                      </Button>
                    ) : null
                  }
                >
                  {shown.map((task) => {
                    const ws = task.workstreamId ? latestOf.get(task.workstreamId) : undefined;
                    return (
                      <li key={task.id} aria-label={task.title}>
                        <TaskCard
                          task={task}
                          workstream={ws && SHOWN_STATES.includes(ws.state) ? ws : undefined}
                          peers={peers}
                          menu={<TaskCardMenu task={task} latest={ws?.state} onStart={() => { start.mutate(task.id); }} />}
                        />
                      </li>
                    );
                  })}
                </BoardColumn>
              );
            })}
          </Group>
        </ScrollArea>
      ) : null}
```

Keep "No tasks yet." above the columns when the project has no tasks. Hoist `SHOWN_STATES` to module scope.

In `apps/desktop/src/router.tsx`: import `BoardView`, rename `TasksPage` to `BoardPage` (`<ViewBoundary name="Board">`), add `boardRoute` at `/board`, and turn `tasksRoute` into a redirect:

```tsx
const tasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tasks',
  beforeLoad: () => {
    // TanStack Router's redirect is thrown by design.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({ to: '/board' });
  },
});
```

Add `boardRoute` to `routeTree`. In `apps/desktop/src/shell/app-layout.tsx`, `NAV` becomes Board (`/board`, `IconLayoutKanban`), Factory, Inbox.

In `apps/desktop/e2e/loop.spec.ts`, change only what keeps the existing run green:
- `VIEWS = ['Board', 'Factory', 'Inbox']`, `page.goto('/board')`, and the empty-state label `'board, empty, dark'`;
- the start:

```ts
  const card = page.getByRole('listitem', { name: TASK });
  await card.getByRole('button', { name: `Actions for ${TASK}` }).click();
  await page.getByRole('menuitem', { name: 'Start' }).click();
```

- in place of the row checks (and again after the reload): `await open(page, 'Board'); await expect(page.getByRole('list', { name: 'Done tasks' }).getByRole('listitem', { name: TASK })).toBeVisible();`.

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @10db/desktop exec vitest run && pnpm --filter @10db/desktop typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
pnpm format && git add apps/desktop/src/views/board apps/desktop/src/views/tasks apps/desktop/src/shell/project-picker.tsx apps/desktop/src/shell/selected-project.ts apps/desktop/src/shell/app-layout.tsx apps/desktop/src/router.tsx apps/desktop/src/daemon/queries.ts apps/desktop/src/daemon/events.ts apps/desktop/src/test/fixtures.ts apps/desktop/e2e/loop.spec.ts && git commit -m 'feat(desktop): replace the task list with a board of human and derived columns'
```

---

### Task 6: Drag and drop, and the move menu

**Files:**
- Create: `apps/desktop/src/views/board/drop-rules.ts`, `drop-rules.test.ts`, `use-move-task.ts`, `use-board-actions.ts`, `board-dnd.tsx`
- Modify: `apps/desktop/package.json`, `pnpm-lock.yaml`, `apps/desktop/src/views/board/task-card-menu.tsx`, `board-view.tsx`, `board-view.test.tsx`

**Interfaces:**
- Consumes: `POST /tasks/:taskId/move` and `TaskMove` (Tasks 1, 4); `POST /tasks/:taskId/start` (`useStartTask`); `boardLayout`, `LayoutColumn`, `ColumnKey`, `columnKeyId`, `sameColumn`, `BoardColumn`, `TaskCard`, `TaskCardMenu` (Task 5).
- Produces:
  - `DropAction`, one of:
    - `{ kind: 'none' }`;
    - `{ kind: 'refuse'; reason: string }`;
    - `{ kind: 'move'; taskId: TaskId; move: TaskMove; order: number; note: string | null }`, where `order` is the client's estimate, for the optimistic placement only;
    - `{ kind: 'start'; taskId: TaskId }`.
  - `DropTarget = { key: ColumnKey; index: number }`.
  - `dragRefusal(key: ColumnKey): string | null`: why cards in that column can't be dragged.
  - `resolveDrop(layout: readonly LayoutColumn[], taskId: TaskId, to: DropTarget): DropAction`: the drag rules (decision A3). `index` is the card's place in the target column. In its own column it follows array-move semantics: the index the card ends up at.
  - `dropTarget(layout, overId: string | null): DropTarget | null`: a dnd-kit `over.id` (a card's task ID, or `column:<columnKeyId>` for a column's empty space) mapped to a target.
  - `MenuMove = { label: string; target: DropTarget | null }` (null means disabled) and `menuMoves(layout, taskId): MenuMove[]`.
  - `placeLocally(tasks, taskId, order, boardColumnId): TaskDto[]`.
  - `useMoveTask(projectId)` (in `views/board/use-move-task.ts`, so `daemon/` never imports from a view): a mutation over `{ taskId, move, order }` with an optimistic placement and rollback.
  - `useBoardActions(projectId): { apply(action: DropAction): void; notice: string | null; error: Error | null; dismiss(): void }`.
  - `BoardDnd({ layout, shown, onDrop, renderColumn, renderCard })`: one dnd-kit context for the board, a droppable list per column and a sortable per card.
  - `BoardColumn` gains `listRef`.
  - `TaskCardMenu` gains `moves: readonly MenuMove[]` and `onMove(target: DropTarget)`.

- [ ] **Step 1: Add the dependencies**

```bash
pnpm view @dnd-kit/core time --json
pnpm view @dnd-kit/sortable time --json
pnpm view @dnd-kit/utilities time --json
pnpm --filter @10db/desktop add --save-exact @dnd-kit/core@<latest stable, ≥24h> @dnd-kit/sortable@<latest stable, ≥24h> @dnd-kit/utilities@<latest stable, ≥24h>
```

Use the versions the `time` output shows (6.3.1, 10.0.0 and 3.2.2 when this plan was written).

- [ ] **Step 2: Write the failing tests**

`apps/desktop/src/views/board/drop-rules.test.ts`:

```ts
import { mintId, type TaskDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { boardColumnDto, taskDto } from '../../test/fixtures';
import { boardLayout, type ColumnKey } from './board-layout';
import { dropTarget, menuMoves, placeLocally, resolveDrop } from './drop-rules';

const icebox = boardColumnDto({ name: 'Icebox', position: 0 });
const exploring = boardColumnDto({ name: 'Exploring', position: 1 });
const ICEBOX: ColumnKey = { kind: 'human', id: icebox.id };
const EXPLORING: ColumnKey = { kind: 'human', id: exploring.id };
const system = (status: 'backlog' | 'ready' | 'in_progress' | 'blocked' | 'done'): ColumnKey => ({ kind: 'system', status });

const idea1 = taskDto({ title: 'idea1', boardStatus: 'ready', boardOrder: 1, boardColumnId: icebox.id });
const idea2 = taskDto({ title: 'idea2', boardStatus: 'backlog', boardOrder: 2, boardColumnId: icebox.id });
const ready1 = taskDto({ title: 'ready1', boardStatus: 'ready', boardOrder: 3 });
const ready2 = taskDto({ title: 'ready2', boardStatus: 'ready', boardOrder: 4 });
const waiting = taskDto({ title: 'waiting', boardStatus: 'backlog', boardOrder: 5 });
const running = taskDto({ title: 'running', boardStatus: 'in_progress', boardOrder: 6 });
const shipped = taskDto({ title: 'shipped', boardStatus: 'done', status: 'done', boardOrder: 7 });
const tasks: TaskDto[] = [idea1, idea2, ready1, ready2, waiting, running, shipped];
const layout = boardLayout([icebox, exploring], tasks);

describe('resolveDrop', () => {
  it.each([
    { name: 'a human card down its own column', task: idea1, to: { key: ICEBOX, index: 1 }, expected: { kind: 'move', move: { to: icebox.id, after: idea2.id, before: null }, note: null } },
    { name: 'a ready card up its own column', task: ready2, to: { key: system('ready'), index: 0 }, expected: { kind: 'move', move: { to: null, after: null, before: ready1.id }, note: null } },
    { name: 'a card onto its own place', task: ready1, to: { key: system('ready'), index: 0 }, expected: { kind: 'none' } },
    { name: 'a human card to another human column', task: idea1, to: { key: EXPLORING, index: 0 }, expected: { kind: 'move', move: { to: exploring.id, after: null, before: null }, note: null } },
    { name: 'a parked card with done dependencies to Ready', task: idea1, to: { key: system('ready'), index: 1 }, expected: { kind: 'move', move: { to: null, after: ready1.id, before: ready2.id }, note: null } },
    { name: 'a parked card with unfinished dependencies to Ready', task: idea2, to: { key: system('ready'), index: 2 }, expected: { kind: 'move', move: { to: null, after: ready2.id, before: null }, note: 'idea2 waits on its dependencies, so it is in Backlog' } },
    { name: 'a ready card to a human column', task: ready1, to: { key: ICEBOX, index: 2 }, expected: { kind: 'move', move: { to: icebox.id, after: idea2.id, before: null }, note: null } },
    { name: 'a backlog card to Ready', task: waiting, to: { key: system('ready'), index: 0 }, expected: { kind: 'move', move: { to: null, after: null, before: ready1.id }, note: 'waiting waits on its dependencies, so it is in Backlog' } },
    { name: 'a ready card to In progress', task: ready1, to: { key: system('in_progress'), index: 0 }, expected: { kind: 'start', taskId: ready1.id } },
    { name: 'a backlog card to In progress', task: waiting, to: { key: system('in_progress'), index: 0 }, expected: { kind: 'refuse', reason: 'Only a Ready card starts by dragging; use Start in its menu to queue it until its dependencies finish' } },
    { name: 'a parked card to In progress', task: idea1, to: { key: system('in_progress'), index: 0 }, expected: { kind: 'refuse', reason: 'Move idea1 to Backlog or Ready before starting it' } },
    { name: 'a ready card to Blocked', task: ready1, to: { key: system('blocked'), index: 0 }, expected: { kind: 'refuse', reason: 'Blocked and Done follow the task’s state; cards can’t be dropped there' } },
    { name: 'a ready card to Done', task: ready1, to: { key: system('done'), index: 0 }, expected: { kind: 'refuse', reason: 'Blocked and Done follow the task’s state; cards can’t be dropped there' } },
    { name: 'a running card anywhere', task: running, to: { key: ICEBOX, index: 0 }, expected: { kind: 'refuse', reason: 'In progress cards follow their workstream; they can’t be dragged' } },
    { name: 'a done card anywhere', task: shipped, to: { key: system('ready'), index: 0 }, expected: { kind: 'refuse', reason: 'Done cards stay where they finished; they can’t be dragged' } },
    { name: 'an unknown card', task: taskDto({ title: 'ghost' }), to: { key: system('ready'), index: 0 }, expected: { kind: 'none' } },
  ])('resolves $name', ({ task, to, expected }) => {
    const action = resolveDrop(layout, task.id, to);
    expect(action).toMatchObject(expected);
  });

  it('estimates an order between the neighbours for the optimistic placement', () => {
    const action = resolveDrop(layout, idea1.id, { key: system('ready'), index: 1 });
    expect(action).toMatchObject({ kind: 'move', order: 3.5 });
  });
});

describe('dropTarget', () => {
  it.each([
    { name: 'a card', over: ready2.id, expected: { key: system('ready'), index: 1 } },
    { name: "a column's empty space", over: `column:human:${exploring.id}`, expected: { key: EXPLORING, index: 0 } },
    { name: 'nothing', over: null, expected: null },
    { name: 'an unknown id', over: mintId('Task'), expected: null },
  ])('maps $name', ({ over, expected }) => {
    expect(dropTarget(layout, over)).toEqual(expected);
  });
});

describe('menuMoves', () => {
  const labels = (task: TaskDto) => menuMoves(layout, task.id).map((m) => [m.label, m.target !== null]);
  it.each([
    {
      name: 'the first parked card: no move up, the other column, and planning it',
      task: idea1,
      expected: [['Move to top', false], ['Move up', false], ['Move down', true], ['Move to bottom', true], ['Move to Exploring', true], ['Move to Ready', true]],
    },
    {
      name: 'a parked card with unfinished dependencies plans to Backlog',
      task: idea2,
      expected: [['Move to top', true], ['Move up', true], ['Move down', false], ['Move to bottom', false], ['Move to Exploring', true], ['Move to Backlog', true]],
    },
    {
      name: 'a planned card parks in each human column',
      task: ready2,
      expected: [['Move to top', true], ['Move up', true], ['Move down', false], ['Move to bottom', false], ['Move to Icebox', true], ['Move to Exploring', true]],
    },
    { name: 'a running card has none', task: running, expected: [] },
    { name: 'a done card has none', task: shipped, expected: [] },
  ])('offers $name', ({ task, expected }) => {
    expect(labels(task)).toEqual(expected);
  });
});

describe('placeLocally', () => {
  it('gives the task its new order and column, and sorts by board order', () => {
    const placed = placeLocally([ready1, ready2], ready1.id, 5, icebox.id);
    expect(placed.map((t) => [t.title, t.boardColumnId])).toEqual([['ready2', null], ['ready1', icebox.id]]);
  });
});
```

In `board-view.test.tsx`, add the imports (`TaskMove`, `type BoardColumnDto`, `type TaskDto` from `@10db/contracts`, `type RequestHandler` from `msw`, `boardColumnDto` from the fixtures) and:

```tsx
  /** A board whose daemon applies each move, as the real one does, so refetches agree with the UI. */
  function boardWith(initial: TaskDto[], columns: BoardColumnDto[], opts: { readonly refuse?: string } = {}) {
    const project = projectDto();
    let current = initial;
    const moves: { taskId: unknown; body: TaskMove }[] = [];
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/board-columns'), () => HttpResponse.json(columns)),
      http.get(daemonUrl('/projects/:projectId/tasks'), () =>
        HttpResponse.json([...current].sort((a, b) => a.boardOrder - b.boardOrder)),
      ),
      http.post(daemonUrl('/tasks/:taskId/move'), async ({ request, params }) => {
        const body = TaskMove.parse(await request.json());
        moves.push({ taskId: params['taskId'], body });
        if (opts.refuse) return HttpResponse.json({ error: 'conflict', message: opts.refuse }, { status: 409 });
        const orderOf = (id: string | null) => current.find((t) => t.id === id)?.boardOrder;
        const before = orderOf(body.before);
        const after = orderOf(body.after);
        current = current.map((t) =>
          t.id === params['taskId']
            ? { ...t, boardColumnId: body.to, boardOrder: before !== undefined ? before - 0.5 : after !== undefined ? after + 0.5 : t.boardOrder }
            : t,
        );
        return HttpResponse.json(current.find((t) => t.id === params['taskId']));
      }),
    );
    renderApp('/board');
    return moves;
  }
  const titlesIn = (list: HTMLElement) => within(list).getAllByRole('listitem').map((li) => li.getAttribute('aria-label'));

  it('moves a card to the top from its menu, and disables moves that do nothing', async () => {
    const one = taskDto({ title: 'One', boardStatus: 'ready', boardOrder: 1 });
    const two = taskDto({ title: 'Two', boardStatus: 'ready', boardOrder: 2 });
    const moves = boardWith([one, two], []);

    const ready = await screen.findByRole('list', { name: 'Ready tasks' });
    fireEvent.click(within(ready).getByRole('button', { name: 'Actions for One' }));
    // Mantine marks a disabled Menu.Item with data-disabled.
    expect((await screen.findByRole('menuitem', { name: 'Move up' })).hasAttribute('data-disabled')).toBe(true);
    expect(screen.getByRole('menuitem', { name: 'Move down' }).hasAttribute('data-disabled')).toBe(false);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    fireEvent.click(within(ready).getByRole('button', { name: 'Actions for Two' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to top' }));
    await waitFor(() => {
      expect(titlesIn(ready)).toEqual(['Two', 'One']);
    });
    expect(moves).toEqual([{ taskId: two.id, body: { to: null, after: null, before: one.id } }]);
  });

  it('parks and plans a card from its menu', async () => {
    const icebox = boardColumnDto({ name: 'Icebox' });
    const one = taskDto({ title: 'One', boardStatus: 'ready', boardOrder: 1 });
    const idea = taskDto({ title: 'Idea', boardStatus: 'ready', boardOrder: 2, boardColumnId: icebox.id });
    const moves = boardWith([one, idea], [icebox]);

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for One' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to Icebox' }));
    const iceboxList = screen.getByRole('list', { name: 'Icebox tasks' });
    await waitFor(() => {
      expect(titlesIn(iceboxList)).toEqual(['One', 'Idea']);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Idea' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to Ready' }));
    await waitFor(() => {
      expect(titlesIn(screen.getByRole('list', { name: 'Ready tasks' }))).toEqual(['Idea']);
    });
    expect(moves.map((m) => m.body)).toEqual([
      { to: icebox.id, after: null, before: idea.id },
      { to: null, after: null, before: null },
    ]);
  });

  it('rolls the placement back and says why when the daemon refuses a move', async () => {
    const one = taskDto({ title: 'One', boardStatus: 'ready', boardOrder: 1 });
    const two = taskDto({ title: 'Two', boardStatus: 'ready', boardOrder: 2 });
    boardWith([one, two], [], { refuse: 'The board changed while you were dragging; try again' });

    const ready = await screen.findByRole('list', { name: 'Ready tasks' });
    fireEvent.click(within(ready).getByRole('button', { name: 'Actions for Two' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to top' }));
    expect(await screen.findByText('The board changed while you were dragging; try again')).toBeTruthy();
    expect(titlesIn(ready)).toEqual(['One', 'Two']);
  });

  it('explains why a running or done card can’t be dragged', async () => {
    const running = taskDto({ title: 'Running', boardStatus: 'in_progress' });
    const shipped = taskDto({ title: 'Shipped', boardStatus: 'done', status: 'done' });
    boardWith([running, shipped], []);

    const handle = await screen.findByRole('button', { name: 'Can’t drag Shipped' });
    expect(handle.hasAttribute('disabled') || handle.hasAttribute('data-disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Can’t drag Running' })).toBeTruthy();
    fireEvent.mouseEnter(handle.parentElement ?? handle);
    expect(await screen.findByText('Done cards stay where they finished; they can’t be dragged')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Drag Shipped' })).toBeNull();
  });
```

A card-menu move to another column lands at the top of it (Open decision 9), so `One` goes above `Idea` in Icebox. When `Idea` then moves to Ready, Ready is empty, so the move has no neighbours.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @10db/desktop exec vitest run src/views/board`
Expected: FAIL: `./drop-rules` doesn't exist; no `Move to top` item.

- [ ] **Step 4: Write the drop rules**

`apps/desktop/src/views/board/drop-rules.ts`:

```ts
import {
  BoardStatus,
  type BoardColumnId,
  type TaskDto,
  type TaskId,
  type TaskMove,
} from '@10db/contracts';
import { columnKeyId, sameColumn, type ColumnKey, type LayoutColumn } from './board-layout';
import { BOARD_STATUS } from './board-status-badge';

export type DropAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'refuse'; readonly reason: string }
  | {
      readonly kind: 'move';
      readonly taskId: TaskId;
      readonly move: TaskMove;
      /** The client's estimate of the stored order, for the optimistic placement only. */
      readonly order: number;
      readonly note: string | null;
    }
  | { readonly kind: 'start'; readonly taskId: TaskId };

export interface DropTarget {
  readonly key: ColumnKey;
  readonly index: number;
}

export interface MenuMove {
  readonly label: string;
  /** Null when the move would do nothing. */
  readonly target: DropTarget | null;
}

const LOCKED_DROP = 'Blocked and Done follow the task’s state; cards can’t be dropped there';

/** Why cards in a column can't be dragged; null when they can. */
export function dragRefusal(key: ColumnKey): string | null {
  if (key.kind === 'human') return null;
  switch (key.status) {
    case BoardStatus.Backlog:
    case BoardStatus.Ready:
      return null;
    case BoardStatus.InProgress:
      return 'In progress cards follow their workstream; they can’t be dragged';
    case BoardStatus.Blocked:
      return 'Blocked cards wait for a retry or an answer; they can’t be dragged';
    case BoardStatus.Done:
      return 'Done cards stay where they finished; they can’t be dragged';
  }
}

function locate(layout: readonly LayoutColumn[], taskId: TaskId) {
  for (const column of layout) {
    const index = column.tasks.findIndex((t) => t.id === taskId);
    const task = column.tasks[index];
    if (task) return { column, index, task };
  }
  return null;
}

function place(
  layout: readonly LayoutColumn[],
  task: TaskDto,
  from: ColumnKey,
  fromIndex: number,
  to: DropTarget,
  boardColumnId: BoardColumnId | null,
  note: string | null,
): DropAction {
  const target = layout.find((c) => sameColumn(c.key, to.key));
  if (!target) return { kind: 'none' };
  const rest = target.tasks.filter((t) => t.id !== task.id);
  const index = Math.max(0, Math.min(to.index, rest.length));
  if (sameColumn(from, to.key) && fromIndex === index) return { kind: 'none' };
  const after = index > 0 ? rest[index - 1] : undefined;
  const before = rest[index];
  const order =
    after && before
      ? (after.boardOrder + before.boardOrder) / 2
      : after
        ? after.boardOrder + 1
        : before
          ? before.boardOrder - 1
          : task.boardOrder;
  return {
    kind: 'move',
    taskId: task.id,
    move: { to: boardColumnId, after: after?.id ?? null, before: before?.id ?? null },
    order,
    note,
  };
}

/** The board's drag rules: free among human columns and planned work, a start into In progress, nothing else. */
export function resolveDrop(layout: readonly LayoutColumn[], taskId: TaskId, to: DropTarget): DropAction {
  const found = locate(layout, taskId);
  if (!found) return { kind: 'none' };
  const { column, index, task } = found;
  const refusal = dragRefusal(column.key);
  if (refusal) return { kind: 'refuse', reason: refusal };
  if (to.key.kind === 'human') return place(layout, task, column.key, index, to, to.key.id, null);
  switch (to.key.status) {
    case BoardStatus.InProgress:
      if (column.key.kind === 'human')
        return { kind: 'refuse', reason: `Move ${task.title} to Backlog or Ready before starting it` };
      return column.key.status === BoardStatus.Ready
        ? { kind: 'start', taskId }
        : {
            kind: 'refuse',
            reason: 'Only a Ready card starts by dragging; use Start in its menu to queue it until its dependencies finish',
          };
    case BoardStatus.Blocked:
    case BoardStatus.Done:
      return { kind: 'refuse', reason: LOCKED_DROP };
    case BoardStatus.Backlog:
    case BoardStatus.Ready: {
      // The derived column decides: a task's dependencies, not the drop, put it in Backlog or Ready.
      const lands = task.boardStatus;
      const note =
        lands !== to.key.status
          ? `${task.title} ${lands === BoardStatus.Backlog ? 'waits on its dependencies, so it is in Backlog' : 'has no unfinished dependencies, so it is in Ready'}`
          : null;
      return place(layout, task, column.key, index, to, null, note);
    }
  }
}

/** A dnd-kit `over.id`: a card's task ID, or `column:<columnKeyId>` for a column's empty space. */
export function dropTarget(layout: readonly LayoutColumn[], overId: string | null): DropTarget | null {
  if (overId === null) return null;
  for (const column of layout) {
    if (overId === `column:${columnKeyId(column.key)}`) return { key: column.key, index: column.tasks.length };
    const index = column.tasks.findIndex((t) => t.id === overId);
    if (index >= 0) return { key: column.key, index };
  }
  return null;
}

/** The card menu's moves: the same rules as a drag, without a pointer (WCAG 2.2 SC 2.5.7). */
export function menuMoves(layout: readonly LayoutColumn[], taskId: TaskId): MenuMove[] {
  const found = locate(layout, taskId);
  if (!found || dragRefusal(found.column.key)) return [];
  const { column, index, task } = found;
  const last = column.tasks.length - 1;
  const at = (i: number): DropTarget | null => (i === index ? null : { key: column.key, index: i });
  const moves: MenuMove[] = [
    { label: 'Move to top', target: at(0) },
    { label: 'Move up', target: index > 0 ? at(index - 1) : null },
    { label: 'Move down', target: index < last ? at(index + 1) : null },
    { label: 'Move to bottom', target: at(last) },
  ];
  for (const other of layout) {
    if (other.key.kind !== 'human' || sameColumn(other.key, column.key)) continue;
    moves.push({ label: `Move to ${other.label}`, target: { key: other.key, index: 0 } });
  }
  if (column.key.kind === 'human') {
    const status = task.boardStatus === BoardStatus.Backlog ? BoardStatus.Backlog : BoardStatus.Ready;
    moves.push({ label: `Move to ${BOARD_STATUS[status].label}`, target: { key: { kind: 'system', status }, index: 0 } });
  }
  return moves;
}

/** The task list with one task placed, sorted as the daemon sorts it. */
export function placeLocally(
  tasks: readonly TaskDto[],
  taskId: TaskId,
  order: number,
  boardColumnId: BoardColumnId | null,
): TaskDto[] {
  return tasks
    .map((t) => (t.id === taskId ? { ...t, boardOrder: order, boardColumnId } : t))
    .sort((x, y) => x.boardOrder - y.boardOrder);
}
```

The `Move to Ready` item for a parked task targets the top of Ready, so `Idea` above lands before any Ready card (in the menu test Ready is empty after `One` moves, so the move has no neighbours).

- [ ] **Step 5: Write the mutation and the actions**

`apps/desktop/src/views/board/use-move-task.ts`:

```ts
import { TaskDto, type ProjectId, type TaskId, type TaskMove } from '@10db/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { readJson } from '../../daemon/client';
import { useDaemon } from '../../daemon/provider';
import { queryKeys } from '../../daemon/queries';
import { placeLocally } from './drop-rules';

export interface MoveTaskInput {
  readonly taskId: TaskId;
  readonly move: TaskMove;
  readonly order: number;
}

/** Places a card at once and rolls back if the daemon refuses; the event stream brings the real order. */
export function useMoveTask(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  const key = queryKeys.tasks(projectId);
  return useMutation({
    mutationFn: async ({ taskId, move }: MoveTaskInput) =>
      readJson(await client.tasks[':taskId'].move.$post({ param: { taskId }, json: move }), TaskDto),
    onMutate: async ({ taskId, move, order }: MoveTaskInput) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<TaskDto[]>(key);
      if (previous) queryClient.setQueryData(key, placeLocally(previous, taskId, order, move.to));
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['tasks'] }),
  });
}
```

`apps/desktop/src/views/board/use-board-actions.ts`:

```ts
import type { ProjectId } from '@10db/contracts';
import { useState } from 'react';
import { useStartTask } from '../../daemon/queries';
import type { DropAction } from './drop-rules';
import { useMoveTask } from './use-move-task';

/** Carries out a drop or a menu move: a placement, a start, or a refusal shown to the builder. */
export function useBoardActions(projectId: ProjectId) {
  const move = useMoveTask(projectId);
  const start = useStartTask();
  const [notice, setNotice] = useState<string | null>(null);
  function apply(action: DropAction): void {
    switch (action.kind) {
      case 'none':
        return;
      case 'refuse':
        setNotice(action.reason);
        return;
      case 'move':
        setNotice(null);
        move.mutate(action, { onSuccess: () => { setNotice(action.note); } });
        return;
      case 'start':
        setNotice(null);
        start.mutate(action.taskId);
        return;
    }
  }
  return { apply, notice, error: move.error ?? start.error, dismiss: () => { setNotice(null); } };
}
```

- [ ] **Step 6: Add the menu moves and the drag and drop**

`TaskCardMenu` gains two props, and its dropdown lists the moves before Start:

```tsx
  readonly moves: readonly MenuMove[];
  readonly onMove: (target: DropTarget) => void;
// …inside Menu.Dropdown:
        {moves.map((m) => (
          <Menu.Item
            key={m.label}
            disabled={m.target === null}
            onClick={() => {
              if (m.target) onMove(m.target);
            }}
          >
            {m.label}
          </Menu.Item>
        ))}
        {moves.length > 0 && canStart(task, latest) ? <Menu.Divider /> : null}
```

`apps/desktop/src/views/board/board-dnd.tsx`:

```tsx
import {
  closestCorners,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { TaskDto } from '@10db/contracts';
import { ActionIcon, Tooltip } from '@mantine/core';
import { IconGripVertical } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { columnKeyId, type LayoutColumn } from './board-layout';
import { dragRefusal, dropTarget, resolveDrop, type DropAction } from './drop-rules';

function Handle({ task, refusal, sortable }: { readonly task: TaskDto; readonly refusal: string | null; readonly sortable: ReturnType<typeof useSortable> }) {
  if (refusal)
    return (
      <Tooltip label={refusal}>
        <span>
          <ActionIcon variant="subtle" size="sm" disabled aria-label={`Can’t drag ${task.title}`}>
            <IconGripVertical size={16} stroke={1.5} />
          </ActionIcon>
        </span>
      </Tooltip>
    );
  return (
    <ActionIcon
      ref={sortable.setActivatorNodeRef}
      variant="subtle"
      size="sm"
      aria-label={`Drag ${task.title}`}
      style={{ cursor: 'grab' }}
      {...sortable.attributes}
      {...sortable.listeners}
    >
      <IconGripVertical size={16} stroke={1.5} />
    </ActionIcon>
  );
}

function SortableCard({ task, refusal, children }: { readonly task: TaskDto; readonly refusal: string | null; readonly children: (handle: ReactNode) => ReactNode }) {
  const sortable = useSortable({ id: task.id, disabled: refusal !== null });
  return (
    <li
      ref={sortable.setNodeRef}
      aria-label={task.title}
      style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition, opacity: sortable.isDragging ? 0.6 : 1 }}
    >
      {children(<Handle task={task} refusal={refusal} sortable={sortable} />)}
    </li>
  );
}

/** Makes the column's list a drop target, so an empty column or the space below its cards accepts a card. */
function DroppableColumn({
  column,
  children,
}: {
  readonly column: LayoutColumn;
  readonly children: (listRef: (element: HTMLElement | null) => void) => ReactNode;
}) {
  const { setNodeRef } = useDroppable({ id: `column:${columnKeyId(column.key)}` });
  return <>{children(setNodeRef)}</>;
}

export interface BoardDndProps {
  readonly layout: readonly LayoutColumn[];
  /** The cards to show per column (Done is cut to its limit). */
  readonly shown: (column: LayoutColumn) => readonly TaskDto[];
  readonly onDrop: (action: DropAction) => void;
  /** Renders a column; `listRef` goes on its `<ul>`, which becomes the column's drop target. */
  readonly renderColumn: (
    column: LayoutColumn,
    cards: ReactNode,
    listRef: (element: HTMLElement | null) => void,
  ) => ReactNode;
  readonly renderCard: (task: TaskDto, handle: ReactNode) => ReactNode;
}

/** One drag-and-drop context for the board; the drop rules decide what each drop does. */
export function BoardDnd({ layout, shown, onDrop, renderColumn, renderCard }: BoardDndProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const titles = new Map<string, string>(layout.flatMap((c) => c.tasks.map((t) => [t.id, t.title] as const)));
  const title = (id: string | number) => titles.get(String(id)) ?? 'The card';
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${title(active.id)}.`,
    onDragOver: ({ active, over }) => (over ? `${title(active.id)} is over ${String(over.id).startsWith('column:') ? 'an empty space' : title(over.id)}.` : `${title(active.id)} is over no column.`),
    onDragEnd: ({ active, over }) => (over ? `${title(active.id)} was dropped.` : `${title(active.id)} was put back.`),
    onDragCancel: ({ active }) => `Moving ${title(active.id)} was cancelled.`,
  };
  function handleDragEnd({ active, over }: DragEndEvent) {
    const target = dropTarget(layout, over === null ? null : String(over.id));
    if (target === null) return;
    const taskId = layout.flatMap((c) => c.tasks).find((t) => t.id === String(active.id))?.id;
    if (taskId === undefined) return;
    onDrop(resolveDrop(layout, taskId, target));
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={handleDragEnd} accessibility={{ announcements }}>
      {layout.map((column) => {
        const cards = shown(column);
        const refusal = dragRefusal(column.key);
        return (
          <DroppableColumn key={columnKeyId(column.key)} column={column}>
            {(listRef) =>
              renderColumn(
                column,
                <SortableContext items={cards.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                  {cards.map((task) => (
                    <SortableCard key={task.id} task={task} refusal={refusal}>
                      {(handle) => renderCard(task, handle)}
                    </SortableCard>
                  ))}
                </SortableContext>,
                listRef,
              )
            }
          </DroppableColumn>
        );
      })}
    </DndContext>
  );
}
```

`BoardColumn` gains an optional `listRef?: (element: HTMLElement | null) => void` prop, set as the `ref` of its `<Stack component="ul">`, so the `<li>`s stay direct children of the list (axe's `list` rule) and the list is the drop target.

In `board-view.tsx`, replace Task 5's column loop with `BoardDnd`, inside a `BoardColumns({ project, layout, … })` child component, so the hooks get a non-null project:

```tsx
  const actions = useBoardActions(project.id);
  // …
      {actions.notice ? (
        <Alert color="yellow" withCloseButton onClose={actions.dismiss}>
          {actions.notice}
        </Alert>
      ) : null}
      {actions.error ? <Alert color="red" title="Couldn't move the task">{actions.error.message}</Alert> : null}
      <BoardDnd
        layout={layout}
        shown={(column) => (isDone(column) && !showAllDone ? column.tasks.slice(0, DONE_LIMIT) : column.tasks)}
        onDrop={actions.apply}
        renderColumn={(column, cards, listRef) => (
          <BoardColumn
            listRef={listRef}
            label={column.label}
            count={column.tasks.length}
            locked={column.key.kind === 'system'}
            footer={
              isDone(column) && !showAllDone && column.tasks.length > DONE_LIMIT ? (
                <Button variant="subtle" size="xs" onClick={() => { setShowAllDone(true); }}>
                  {`Show all ${String(column.tasks.length)}`}
                </Button>
              ) : null
            }
          >
            {cards}
          </BoardColumn>
        )}
        renderCard={(task, handle) => {
          const ws = task.workstreamId ? latestOf.get(task.workstreamId) : undefined;
          return (
          <TaskCard
            task={task}
            workstream={ws && SHOWN_STATES.includes(ws.state) ? ws : undefined}
            peers={peers}
            handle={handle}
            menu={
              <TaskCardMenu
                task={task}
                latest={ws?.state}
                moves={menuMoves(layout, task.id)}
                onMove={(target) => { actions.apply(resolveDrop(layout, task.id, target)); }}
                onStart={() => { actions.apply({ kind: 'start', taskId: task.id }); }}
              />
            }
          />
          );
        }}
      />
```

`isDone(column)` is `column.key.kind === 'system' && column.key.status === BoardStatus.Done`; `peers`, `latestOf`, `SHOWN_STATES`, `showAllDone` and `DONE_LIMIT` are Task 5's.

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @10db/desktop exec vitest run && pnpm --filter @10db/desktop typecheck && pnpm lint && pnpm knip`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
pnpm format && git add apps/desktop/package.json pnpm-lock.yaml apps/desktop/src/views/board && git commit -m 'feat(desktop): drag cards between board columns, with the same moves in each card menu'
```

---

### Task 7: The Settings shell

**Files:**
- Create: `apps/desktop/src/views/settings/sections.ts`, `sections.test.ts`, `settings-view.tsx`, `settings-nav.tsx`, `section-body.tsx`, `planned-section.tsx`, `project-areas.tsx`, `project-billing.tsx`, `keep-awake-section.tsx`, `settings-view.test.tsx`; `apps/desktop/src/shell/keep-awake-labels.ts`
- Modify: `apps/desktop/src/router.tsx`, `apps/desktop/src/shell/app-layout.tsx`, `apps/desktop/src/shell/keep-awake-control.tsx`

**Interfaces:**
- Consumes: `useSelectedProject`, `ProjectPicker` (Task 5); `useKeepAwake`, `useSetKeepAwake`; `formatAreas` (`views/board/areas-text.ts`).
- Produces:
  - `SettingsSectionKey` (`as const`): `general`, `board-columns`, `areas`, `billing`, `team`, `routing-rules`, `keep-awake`, `accounts`, `models`, `personas-and-flows`.
  - `SettingsSection = { key; group: 'project' | 'app'; label: string; planned: string | null }`, `SETTINGS_SECTIONS`, `GENERAL_SECTION`, `isSettingsSectionKey(value: string): value is SettingsSectionKey`, `sectionByKey(key: SettingsSectionKey): SettingsSection`.
  - Routes `/settings` (redirects to `/settings/general`) and `/settings/$section` (an unknown section redirects to `general`). Nav entry Settings (`IconSettings`).
  - `SectionBody({ sectionKey, project })`, an exhaustive switch. Task 8 replaces the Board columns arm's placeholder with its editor and Task 9 the General arm's with the form; the accounts plan replaces the Accounts arm.

- [ ] **Step 1: Write the failing tests**

`apps/desktop/src/views/settings/sections.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isSettingsSectionKey, SETTINGS_SECTIONS, SettingsSectionKey } from './sections';

describe('settings sections', () => {
  it('lists every key once, project sections first', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.key)).toEqual([
      'general',
      'board-columns',
      'areas',
      'billing',
      'team',
      'routing-rules',
      'keep-awake',
      'accounts',
      'models',
      'personas-and-flows',
    ]);
    expect(new Set(SETTINGS_SECTIONS.map((s) => s.key)).size).toBe(Object.values(SettingsSectionKey).length);
  });

  it.each([
    { key: 'general', planned: false },
    { key: 'board-columns', planned: false },
    { key: 'areas', planned: false },
    { key: 'billing', planned: false },
    { key: 'keep-awake', planned: false },
    { key: 'team', planned: true },
    { key: 'routing-rules', planned: true },
    { key: 'accounts', planned: true },
    { key: 'models', planned: true },
    { key: 'personas-and-flows', planned: true },
  ])('marks $key planned: $planned', ({ key, planned }) => {
    expect(SETTINGS_SECTIONS.find((s) => s.key === key)?.planned !== null).toBe(planned);
  });

  it.each([
    { value: 'general', ok: true },
    { value: 'accounts', ok: true },
    { value: 'General', ok: false },
    { value: 'nope', ok: false },
  ])('recognizes $value as a section: $ok', ({ value, ok }) => {
    expect(isSettingsSectionKey(value)).toBe(ok);
  });
});
```

`apps/desktop/src/views/settings/settings-view.test.tsx`:

```tsx
import { KeepAwakeStatus } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { projectDto } from '../../test/fixtures';

describe('SettingsView', () => {
  it('opens General from /settings and lists every section in its group', async () => {
    server.use(...baseHandlers());
    const { router } = renderApp('/settings');
    expect(await screen.findByRole('heading', { name: 'Settings', level: 2 })).toBeTruthy();
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings/general');
    });
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    for (const label of ['General', 'Board columns', 'Areas and hazards', 'Billing', 'Team', 'Routing rules', 'Keep-awake', 'Accounts', 'Models and benchmarks', 'Personas and flows'])
      expect(within(nav).getByRole('link', { name: new RegExp(label) })).toBeTruthy();
  });

  it('redirects an unknown section to General', async () => {
    server.use(...baseHandlers());
    const { router } = renderApp('/settings/nope');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings/general');
    });
  });

  it('says what a planned section will hold and which plan fills it', async () => {
    server.use(...baseHandlers());
    renderApp('/settings/accounts');
    expect(await screen.findByRole('heading', { name: 'Accounts', level: 3 })).toBeTruthy();
    expect(screen.getByText(/Not built yet/)).toBeTruthy();
    expect(screen.getByText(/accounts plan/)).toBeTruthy();
  });

  it('asks for a project before showing a project section', async () => {
    server.use(...baseHandlers());
    renderApp('/settings/areas');
    expect(await screen.findByText('Create a project on the board first.')).toBeTruthy();
  });

  it("shows the selected project's areas, hazards and billing", async () => {
    const project = projectDto({
      areas: [{ name: 'api', globs: ['src/api/**'] }],
      hazards: [{ name: 'deps', globs: ['**/package.json'], commands: ['pnpm add'] }],
    });
    server.use(http.get(daemonUrl('/projects'), () => HttpResponse.json([project])), ...baseHandlers());
    renderApp('/settings/areas');
    expect(await screen.findByText('src/api/**')).toBeTruthy();
    expect(screen.getByText('pnpm add')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: /Billing/ }));
    expect(await screen.findByText('Subscription')).toBeTruthy();
    expect(screen.getByText(/account picker/)).toBeTruthy();
  });

  it('changes the keep-awake mode', async () => {
    const put: unknown[] = [];
    server.use(
      http.put(daemonUrl('/settings/keep-awake'), async ({ request }) => {
        put.push(await request.json());
        return HttpResponse.json(KeepAwakeStatus.parse({ mode: 'always', active: true }));
      }),
      ...baseHandlers(),
    );
    renderApp('/settings/keep-awake');
    fireEvent.click(await screen.findByRole('radio', { name: 'Always keep the Mac awake' }));
    await waitFor(() => {
      expect(put).toEqual([{ mode: 'always' }]);
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @10db/desktop exec vitest run src/views/settings`
Expected: FAIL: `./sections` doesn't exist.

- [ ] **Step 3: Write the registry**

`apps/desktop/src/views/settings/sections.ts`:

```ts
export const SettingsSectionKey = {
  General: 'general',
  BoardColumns: 'board-columns',
  Areas: 'areas',
  Billing: 'billing',
  Team: 'team',
  RoutingRules: 'routing-rules',
  KeepAwake: 'keep-awake',
  Accounts: 'accounts',
  Models: 'models',
  PersonasAndFlows: 'personas-and-flows',
} as const;
export type SettingsSectionKey = (typeof SettingsSectionKey)[keyof typeof SettingsSectionKey];

export const SettingsGroup = { Project: 'project', App: 'app' } as const;
export type SettingsGroup = (typeof SettingsGroup)[keyof typeof SettingsGroup];

export interface SettingsSection {
  readonly key: SettingsSectionKey;
  readonly group: SettingsGroup;
  readonly label: string;
  /** What a section that is not built yet will hold, and which plan fills it; null once it is built. */
  readonly planned: string | null;
}

export const GENERAL_SECTION: SettingsSection = {
  key: SettingsSectionKey.General,
  group: SettingsGroup.Project,
  label: 'General',
  planned: null,
};

/** Spec §10 Settings: per project, then app-wide. */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  GENERAL_SECTION,
  { key: SettingsSectionKey.BoardColumns, group: SettingsGroup.Project, label: 'Board columns', planned: null },
  { key: SettingsSectionKey.Areas, group: SettingsGroup.Project, label: 'Areas and hazards', planned: null },
  { key: SettingsSectionKey.Billing, group: SettingsGroup.Project, label: 'Billing', planned: null },
  {
    key: SettingsSectionKey.Team,
    group: SettingsGroup.Project,
    label: 'Team',
    planned: 'Which persona runs each role in this project, and its human members. The team editor plan fills it.',
  },
  {
    key: SettingsSectionKey.RoutingRules,
    group: SettingsGroup.Project,
    label: 'Routing rules',
    planned: 'Who answers each question category, optionally per area. The team editor plan fills it.',
  },
  { key: SettingsSectionKey.KeepAwake, group: SettingsGroup.App, label: 'Keep-awake', planned: null },
  {
    key: SettingsSectionKey.Accounts,
    group: SettingsGroup.App,
    label: 'Accounts',
    planned: "Each billing account with its kind, verified identity and this month's usage against its cap, and the sign-in steps for subscriptions. The accounts plan fills it.",
  },
  {
    key: SettingsSectionKey.Models,
    group: SettingsGroup.App,
    label: 'Models and benchmarks',
    planned: "The Artificial Analysis key and sync, the model profiles, and the Intelligence-vs-Cost chart with AA's attribution. A later M2 plan fills it.",
  },
  {
    key: SettingsSectionKey.PersonasAndFlows,
    group: SettingsGroup.App,
    label: 'Personas and flows',
    planned: 'The personas, their instructions and pins, and the flows of steps. The team editor plan fills it.',
  },
];

const KEYS = new Set<string>(Object.values(SettingsSectionKey));

export function isSettingsSectionKey(value: string): value is SettingsSectionKey {
  return KEYS.has(value);
}

export function sectionByKey(key: SettingsSectionKey): SettingsSection {
  return SETTINGS_SECTIONS.find((s) => s.key === key) ?? GENERAL_SECTION;
}
```

- [ ] **Step 4: Write the routes and the view**

In `apps/desktop/src/router.tsx`:

```tsx
const settingsIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  beforeLoad: () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({ to: '/settings/$section', params: { section: SettingsSectionKey.General } });
  },
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/$section',
  beforeLoad: ({ params }) => {
    if (!isSettingsSectionKey(params.section))
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ to: '/settings/$section', params: { section: SettingsSectionKey.General } });
  },
  component: SettingsPage,
});
```

with `SettingsPage` wrapping `SettingsView` in `<ViewBoundary name="Settings">`, both routes added to `routeTree`, and `{ to: '/settings', label: 'Settings', icon: IconSettings }` appended to `NAV` in `app-layout.tsx` (its `NavLink` stays active on `/settings/*` because TanStack's `Link` matches by prefix; if it doesn't, pass `activeOptions={{ exact: false }}`).

`apps/desktop/src/views/settings/settings-view.tsx`:

```tsx
import { Group, Stack, Title } from '@mantine/core';
import { useParams } from '@tanstack/react-router';
import { useSelectedProject } from '../../shell/selected-project';
import { SectionBody } from './section-body';
import { isSettingsSectionKey, SettingsSectionKey } from './sections';
import { SettingsNav } from './settings-nav';

export function SettingsView() {
  const { section } = useParams({ from: '/settings/$section' });
  // The route redirects unknown sections, so this fallback is only for the type.
  const key = isSettingsSectionKey(section) ? section : SettingsSectionKey.General;
  const { project, select } = useSelectedProject();
  return (
    <Stack>
      <Title order={2}>Settings</Title>
      <Group align="flex-start" wrap="nowrap" gap="lg">
        <SettingsNav current={key} project={project} onProject={select} />
        <Stack flex={1} miw={0}>
          <SectionBody sectionKey={key} project={project} />
        </Stack>
      </Group>
    </Stack>
  );
}
```

`apps/desktop/src/views/settings/settings-nav.tsx`:

```tsx
import type { ProjectDto, ProjectId } from '@10db/contracts';
import { Badge, NavLink, Stack, Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { ProjectPicker } from '../../shell/project-picker';
import { SETTINGS_SECTIONS, SettingsGroup, type SettingsSectionKey } from './sections';

export interface SettingsNavProps {
  readonly current: SettingsSectionKey;
  readonly project: ProjectDto | null;
  readonly onProject: (id: ProjectId | null) => void;
}

const GROUP_LABEL: Readonly<Record<SettingsGroup, string>> = {
  [SettingsGroup.Project]: 'Project',
  [SettingsGroup.App]: 'App',
};

export function SettingsNav({ current, project, onProject }: SettingsNavProps) {
  return (
    <Stack component="nav" aria-label="Settings sections" w={240} gap={4}>
      {Object.values(SettingsGroup).map((group) => (
        <Stack key={group} gap={4} mb="sm">
          <Text size="xs" fw={700} c="dimmed" tt="uppercase">{GROUP_LABEL[group]}</Text>
          {group === SettingsGroup.Project && project ? <ProjectPicker value={project.id} onChange={onProject} /> : null}
          {SETTINGS_SECTIONS.filter((s) => s.group === group).map((s) => (
            <NavLink
              key={s.key}
              label={s.label}
              active={s.key === current}
              rightSection={s.planned ? <Badge size="xs" variant="light" color="gray">Planned</Badge> : undefined}
              renderRoot={(props) => <Link {...props} to="/settings/$section" params={{ section: s.key }} />}
            />
          ))}
        </Stack>
      ))}
    </Stack>
  );
}
```

`ProjectPicker` renders a labelled `Select` ("Project") at `w={260}`; give it a `w` prop or let it fill the nav (`w="100%"`), keeping the board's width.

`apps/desktop/src/views/settings/section-body.tsx`:

```tsx
import type { ProjectDto } from '@10db/contracts';
import { Text, Title } from '@mantine/core';
import { KeepAwakeSection } from './keep-awake-section';
import { PlannedSection } from './planned-section';
import { ProjectAreas } from './project-areas';
import { ProjectBilling } from './project-billing';
import { sectionByKey, SettingsSectionKey } from './sections';

function NoProject() {
  return <Text c="dimmed">Create a project on the board first.</Text>;
}

export function SectionBody({ sectionKey, project }: { readonly sectionKey: SettingsSectionKey; readonly project: ProjectDto | null }) {
  const section = sectionByKey(sectionKey);
  const heading = <Title order={3}>{section.label}</Title>;
  switch (sectionKey) {
    case SettingsSectionKey.General:
      return <>{heading}{project ? <Text c="dimmed">Project fields arrive with the form.</Text> : <NoProject />}</>;
    case SettingsSectionKey.BoardColumns:
      return <>{heading}{project ? <Text c="dimmed">Columns arrive with their editor.</Text> : <NoProject />}</>;
    case SettingsSectionKey.Areas:
      return <>{heading}{project ? <ProjectAreas project={project} /> : <NoProject />}</>;
    case SettingsSectionKey.Billing:
      return <>{heading}{project ? <ProjectBilling project={project} /> : <NoProject />}</>;
    case SettingsSectionKey.KeepAwake:
      return <>{heading}<KeepAwakeSection /></>;
    case SettingsSectionKey.Team:
    case SettingsSectionKey.RoutingRules:
    case SettingsSectionKey.Accounts:
    case SettingsSectionKey.Models:
    case SettingsSectionKey.PersonasAndFlows:
      return <>{heading}<PlannedSection section={section} /></>;
  }
}
```

The General and Board columns arms' texts are replaced in Tasks 9 and 8, in the same PR; they are not shipped.

`planned-section.tsx` renders Mantine's `EmptyState` with `title="Not built yet"` and `description={section.planned}`. `project-areas.tsx` renders two `Table`s: Areas (name, globs as `Code`), Hazards (name, globs, commands as `Code`), each with a caption "Editing areas comes later; create a new project to change them." Paths and globs are text. `project-billing.tsx` shows the billing mode label (`Subscription`, `API key`, `Bedrock`, from an exhaustive record over `BillingMode`), the default `model@effort`, and the text "Accounts replace billing modes: this is where the project's account picker goes, filled by the accounts plan."

`apps/desktop/src/shell/keep-awake-labels.ts` holds `MODE_LABELS` (moved from `keep-awake-control.tsx`, which imports it). `keep-awake-section.tsx`:

```tsx
import { KeepAwakeMode } from '@10db/contracts';
import { Radio, Stack, Text } from '@mantine/core';
import { useKeepAwake, useSetKeepAwake } from '../../daemon/queries';
import { MODE_LABELS } from '../../shell/keep-awake-labels';

const MODES: readonly KeepAwakeMode[] = Object.values(KeepAwakeMode);

function isMode(value: string): value is KeepAwakeMode {
  return MODES.some((m) => m === value);
}

export function KeepAwakeSection() {
  const status = useKeepAwake();
  const setMode = useSetKeepAwake();
  return (
    <Stack>
      <Radio.Group
        label="Keep the Mac awake"
        value={status.data?.mode ?? null}
        onChange={(value) => {
          if (isMode(value)) setMode.mutate(value);
        }}
      >
        <Stack gap="xs" mt="xs">
          {MODES.map((mode) => (
            <Radio key={mode} value={mode} label={MODE_LABELS[mode]} />
          ))}
        </Stack>
      </Radio.Group>
      <Text size="sm" c="dimmed">
        {status.data?.active ? 'Keeping the Mac awake now.' : 'Not keeping the Mac awake now.'}
      </Text>
    </Stack>
  );
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @10db/desktop exec vitest run && pnpm --filter @10db/desktop typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm format && git add apps/desktop/src/views/settings apps/desktop/src/shell/keep-awake-labels.ts apps/desktop/src/shell/keep-awake-control.tsx apps/desktop/src/shell/app-layout.tsx apps/desktop/src/router.tsx && git commit -m 'feat(desktop): add the settings view with project and app sections'
```

---

### Task 8: The Board columns section

**Files:**
- Create: `apps/desktop/src/views/settings/board-columns-section.tsx`, `apps/desktop/src/views/settings/board-columns-section.test.tsx`
- Modify: `apps/desktop/src/views/settings/section-body.tsx`, `apps/desktop/src/daemon/queries.ts`

**Interfaces:**
- Consumes: the board-column routes (Task 4), `useBoardColumns` (Task 5), `useTasks`, the section registry and `SectionBody` (Task 7).
- Produces:
  - `useCreateBoardColumn(projectId)`, `usePatchBoardColumn()`, `useDeleteBoardColumn()` in `daemon/queries.ts`. Each invalidates `['board-columns']`; the delete also invalidates `['tasks']`.
  - `BoardColumnsSection({ project })`: list, add, rename, move up and down, and delete. Deleting a column that holds tasks asks where they go: another human column, or "Planned (Backlog or Ready)".

- [ ] **Step 1: Write the failing tests**

`apps/desktop/src/views/settings/board-columns-section.test.tsx`:

```tsx
import type { BoardColumnDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { boardColumnDto, projectDto, taskDto } from '../../test/fixtures';

const project = projectDto();
const icebox = boardColumnDto({ projectId: project.id, name: 'Icebox', position: 0 });
const exploring = boardColumnDto({ projectId: project.id, name: 'Exploring', position: 1 });

function serve(columns: BoardColumnDto[], tasks = [taskDto({ projectId: project.id, title: 'Idea', boardColumnId: icebox.id })]) {
  const sent: { method: string; path: string; body: unknown }[] = [];
  const record = async (method: string, request: Request) => {
    sent.push({ method, path: new URL(request.url).pathname, body: await request.json() });
  };
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl('/projects/:projectId/board-columns'), () => HttpResponse.json(columns)),
    http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json(tasks)),
    http.post(daemonUrl('/projects/:projectId/board-columns'), async ({ request }) => {
      await record('POST', request);
      return HttpResponse.json(boardColumnDto({ projectId: project.id, name: 'Needs spec', position: 2 }), { status: 201 });
    }),
    http.patch(daemonUrl('/board-columns/:columnId'), async ({ request }) => {
      await record('PATCH', request);
      return HttpResponse.json(columns);
    }),
    http.post(daemonUrl('/board-columns/:columnId/delete'), async ({ request }) => {
      await record('DELETE', request);
      return HttpResponse.json(columns.filter((c) => !new URL(request.url).pathname.includes(c.id)));
    }),
    ...baseHandlers(),
  );
  renderApp('/settings/board-columns');
  return sent;
}

describe('BoardColumnsSection', () => {
  it('lists the columns in order, the system columns as locked', async () => {
    serve([icebox, exploring]);
    const table = await screen.findByRole('table', { name: 'Human columns' });
    expect(within(table).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0]?.textContent)).toEqual(['Icebox', 'Exploring']);
    expect(screen.getByText('Backlog, Ready, In progress, Blocked and Done follow each task’s state and can’t be changed.')).toBeTruthy();
  });

  it('adds a column', async () => {
    const sent = serve([icebox]);
    fireEvent.change(await screen.findByLabelText('New column'), { target: { value: 'Needs spec' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
    await waitFor(() => {
      expect(sent).toEqual([{ method: 'POST', path: `/projects/${project.id}/board-columns`, body: { name: 'Needs spec' } }]);
    });
  });

  it("shows the daemon's message for a duplicate name", async () => {
    serve([icebox]);
    // The latest server.use wins, so this refusal overrides serve()'s create handler.
    server.use(
      http.post(daemonUrl('/projects/:projectId/board-columns'), () =>
        HttpResponse.json({ error: 'conflict', message: 'This project already has a column named "Icebox"' }, { status: 409 }),
      ),
    );
    fireEvent.change(await screen.findByLabelText('New column'), { target: { value: 'Icebox' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
    expect(await screen.findByText('This project already has a column named "Icebox"')).toBeTruthy();
  });

  it('renames a column and moves it down, and offers no move up for the first', async () => {
    const sent = serve([icebox, exploring]);
    fireEvent.click(await screen.findByRole('button', { name: 'Rename Icebox' }));
    fireEvent.change(screen.getByLabelText('Name for Icebox'), { target: { value: 'Someday' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    expect(screen.getByRole('button', { name: 'Move Icebox up' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Move Icebox down' }));
    await waitFor(() => {
      expect(sent).toEqual([
        { method: 'PATCH', path: `/board-columns/${icebox.id}`, body: { name: 'Someday' } },
        { method: 'PATCH', path: `/board-columns/${icebox.id}`, body: { position: 1 } },
      ]);
    });
  });

  it('deletes an empty column after confirming', async () => {
    const sent = serve([icebox, exploring]);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Exploring' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Exploring' });
    expect(within(dialog).queryByLabelText('Move its tasks to')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete column' }));
    await waitFor(() => {
      expect(sent).toEqual([{ method: 'DELETE', path: `/board-columns/${exploring.id}/delete`, body: { moveTasksTo: null } }]);
    });
  });

  it.each([
    { choice: 'Exploring', expected: () => exploring.id },
    { choice: 'Planned (Backlog or Ready)', expected: () => null },
  ])("asks where a non-empty column's tasks go: $choice", async ({ choice, expected }) => {
    const sent = serve([icebox, exploring]);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Icebox' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Icebox' });
    expect(within(dialog).getByText('Icebox holds 1 task. Where should it go?')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Delete column' })).toHaveProperty('disabled', true);
    fireEvent.click(within(dialog).getByLabelText('Move its tasks to'));
    fireEvent.click(await screen.findByRole('option', { name: choice }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete column' }));
    await waitFor(() => {
      expect(sent).toEqual([{ method: 'DELETE', path: `/board-columns/${icebox.id}/delete`, body: { moveTasksTo: expected() } }]);
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @10db/desktop exec vitest run src/views/settings/board-columns-section.test.tsx`
Expected: FAIL: no `Human columns` table (the section shows Task 7's placeholder text).

- [ ] **Step 3: Write the hooks**

In `apps/desktop/src/daemon/queries.ts`:

```ts
export function useCreateBoardColumn(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: BoardColumnInput) =>
      readJson(await client.projects[':projectId']['board-columns'].$post({ param: { projectId }, json: input }), BoardColumnDto),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['board-columns'] }),
  });
}

export function usePatchBoardColumn() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { readonly id: BoardColumnId; readonly patch: BoardColumnPatch }) =>
      readJson(await client['board-columns'][':columnId'].$patch({ param: { columnId: id }, json: patch }), BoardColumnList),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['board-columns'] }),
  });
}

export function useDeleteBoardColumn() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, moveTasksTo }: { readonly id: BoardColumnId; readonly moveTasksTo: BoardColumnId | null }) =>
      readJson(await client['board-columns'][':columnId'].delete.$post({ param: { columnId: id }, json: { moveTasksTo } }), BoardColumnList),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['board-columns'] }),
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
      ]),
  });
}
```

- [ ] **Step 4: Write the section**

`apps/desktop/src/views/settings/board-columns-section.tsx`:

```tsx
import { BoardColumnName, type BoardColumnDto, type BoardColumnId, type ProjectDto } from '@10db/contracts';
import { ActionIcon, Alert, Button, Group, Modal, Select, Stack, Table, Text, TextInput } from '@mantine/core';
import { IconArrowDown, IconArrowUp, IconPencil, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import {
  useBoardColumns,
  useCreateBoardColumn,
  useDeleteBoardColumn,
  usePatchBoardColumn,
  useTasks,
} from '../../daemon/queries';

const PLANNED = 'planned';

function DeleteColumn({ column, columns, parked, onClose }: { readonly column: BoardColumnDto; readonly columns: readonly BoardColumnDto[]; readonly parked: number; readonly onClose: () => void }) {
  const remove = useDeleteBoardColumn();
  const [target, setTarget] = useState<string | null>(null);
  const others = columns.filter((c) => c.id !== column.id);
  // The Select offers only these IDs and PLANNED, so the lookup gives back the branded ID without a cast.
  const byId = new Map<string, BoardColumnId>(others.map((c) => [c.id, c.id]));
  const moveTasksTo = target === null || target === PLANNED ? null : (byId.get(target) ?? null);
  return (
    <Modal opened onClose={onClose} title={`Delete ${column.name}`}>
      <Stack>
        {parked > 0 ? (
          <>
            <Text size="sm">{`${column.name} holds ${String(parked)} task${parked === 1 ? '' : 's'}. Where should ${parked === 1 ? 'it' : 'they'} go?`}</Text>
            <Select
              label="Move its tasks to"
              data={[...others.map((c) => ({ value: c.id, label: c.name })), { value: PLANNED, label: 'Planned (Backlog or Ready)' }]}
              value={target}
              onChange={setTarget}
            />
          </>
        ) : (
          <Text size="sm">{`${column.name} is empty.`}</Text>
        )}
        {remove.error ? <Alert color="red" title="Couldn't delete the column">{remove.error.message}</Alert> : null}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Keep it</Button>
          <Button
            color="red"
            disabled={parked > 0 && target === null}
            loading={remove.isPending}
            onClick={() => { remove.mutate({ id: column.id, moveTasksTo }, { onSuccess: onClose }); }}
          >
            Delete column
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** The project's human columns: add, rename, reorder, delete. */
export function BoardColumnsSection({ project }: { readonly project: ProjectDto }) {
  const columns = useBoardColumns(project.id);
  const tasks = useTasks(project.id);
  const create = useCreateBoardColumn(project.id);
  const patch = usePatchBoardColumn();
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ readonly id: BoardColumnId; readonly name: string } | null>(null);
  const [deleting, setDeleting] = useState<BoardColumnDto | null>(null);
  const list = [...(columns.data ?? [])].sort((a, b) => a.position - b.position);
  const parkedIn = (id: BoardColumnId) => (tasks.data ?? []).filter((t) => t.boardColumnId === id).length;

  function add() {
    const parsed = BoardColumnName.safeParse(name);
    if (!parsed.success) {
      setNameError(parsed.error.issues[0]?.message ?? 'Enter a name');
      return;
    }
    setNameError(null);
    create.mutate({ name: parsed.data }, { onSuccess: () => { setName(''); } });
  }

  return (
    <Stack maw={640}>
      <Text size="sm" c="dimmed">
        Tasks in these columns are parked: 10db never picks or starts them. Backlog, Ready, In progress, Blocked and Done follow each task’s state and can’t be changed.
      </Text>
      <Table aria-label="Human columns" verticalSpacing="xs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Name</Table.Th>
            <Table.Th>Tasks</Table.Th>
            <Table.Th>Actions</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {list.map((column, i) => (
            <Table.Tr key={column.id}>
              <Table.Td>
                {renaming?.id === column.id ? (
                  <Group gap="xs">
                    <TextInput
                      size="sm"
                      aria-label={`Name for ${column.name}`}
                      value={renaming.name}
                      onChange={(e) => { setRenaming({ id: column.id, name: e.currentTarget.value }); }}
                    />
                    <Button
                      size="xs"
                      onClick={() => {
                        patch.mutate({ id: column.id, patch: { name: renaming.name } }, { onSuccess: () => { setRenaming(null); } });
                      }}
                    >
                      Save name
                    </Button>
                  </Group>
                ) : (
                  column.name
                )}
              </Table.Td>
              <Table.Td>{parkedIn(column.id)}</Table.Td>
              <Table.Td>
                <Group gap={4}>
                  <ActionIcon variant="subtle" aria-label={`Rename ${column.name}`} onClick={() => { setRenaming({ id: column.id, name: column.name }); }}>
                    <IconPencil size={16} stroke={1.5} />
                  </ActionIcon>
                  <ActionIcon variant="subtle" aria-label={`Move ${column.name} up`} disabled={i === 0} onClick={() => { patch.mutate({ id: column.id, patch: { position: i - 1 } }); }}>
                    <IconArrowUp size={16} stroke={1.5} />
                  </ActionIcon>
                  <ActionIcon variant="subtle" aria-label={`Move ${column.name} down`} disabled={i === list.length - 1} onClick={() => { patch.mutate({ id: column.id, patch: { position: i + 1 } }); }}>
                    <IconArrowDown size={16} stroke={1.5} />
                  </ActionIcon>
                  <ActionIcon variant="subtle" color="red" aria-label={`Delete ${column.name}`} onClick={() => { setDeleting(column); }}>
                    <IconTrash size={16} stroke={1.5} />
                  </ActionIcon>
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {list.length === 0 ? <Text size="sm" c="dimmed">No human columns. Every task is planned.</Text> : null}
      {patch.error ? <Alert color="red" title="Couldn't change the column">{patch.error.message}</Alert> : null}
      <Group align="flex-end">
        <TextInput label="New column" value={name} error={nameError} onChange={(e) => { setName(e.currentTarget.value); }} />
        <Button onClick={add} loading={create.isPending}>Add column</Button>
      </Group>
      {create.error ? <Alert color="red" title="Couldn't add the column">{create.error.message}</Alert> : null}
      {deleting ? (
        <DeleteColumn column={deleting} columns={list} parked={parkedIn(deleting.id)} onClose={() => { setDeleting(null); }} />
      ) : null}
    </Stack>
  );
}
```

In `section-body.tsx`, the Board columns arm renders `<BoardColumnsSection key={project.id} project={project} />` when a project is selected.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @10db/desktop exec vitest run && pnpm --filter @10db/desktop typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm format && git add apps/desktop/src/views/settings apps/desktop/src/daemon/queries.ts && git commit -m 'feat(desktop): add, rename, reorder and delete human board columns in settings'
```

---

### Task 9: The project General form

The delivery plan adds `delivery`, `base_branch` and `pr_title_prefix` to projects. Whichever of Part A and the delivery plan merges second adds those three fields to `GeneralValues`, `checkGeneral`, its test table and this form (Shared hot spots).

**Files:**
- Create: `apps/desktop/src/views/settings/general-values.ts`, `general-values.test.ts`, `project-general-form.tsx`
- Modify: `apps/desktop/src/views/settings/section-body.tsx`, `apps/desktop/src/daemon/queries.ts`, `apps/desktop/src/daemon/events.ts`, `apps/desktop/src/views/settings/settings-view.test.tsx`

**Interfaces:**
- Consumes: `PATCH /projects/:projectId` (`ProjectPatch`, built in M2a), `GET /flows`.
- Produces:
  - `GeneralValues` (form state: strings for text, `number | ''` for numbers, `FlowId | null` for the flow), `generalValues(project: ProjectDto): GeneralValues`, `checkGeneral(project: ProjectDto, values: GeneralValues): GeneralCheck`, where `GeneralCheck = { ok: true; patch: ProjectPatch | null } | { ok: false; errors: Partial<Record<keyof GeneralValues, string>> }`.
  - `usePatchProject()`, `useFlows()` and `queryKeys.flows` in `daemon/queries.ts`; `INVALIDATIONS.flow = [queryKeys.flows]`.

- [ ] **Step 1: Write the failing tests**

`apps/desktop/src/views/settings/general-values.test.ts`:

```ts
import { mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { projectDto } from '../../test/fixtures';
import { checkGeneral, generalValues, type GeneralValues } from './general-values';

const project = projectDto({ name: 'demo', gateCommand: 'make gate', budgetCeiling: null });
const base = generalValues(project);
const flowId = mintId('Flow');

describe('checkGeneral', () => {
  it.each<{ name: string; change: Partial<GeneralValues>; expected: ReturnType<typeof checkGeneral> }>([
    { name: 'nothing changed', change: {}, expected: { ok: true, patch: null } },
    { name: 'a new name, trimmed', change: { name: '  demo2 ' }, expected: { ok: true, patch: { name: 'demo2' } } },
    { name: 'a ceiling', change: { budgetCeiling: 2.5 }, expected: { ok: true, patch: { budgetCeiling: 2.5 } } },
    { name: 'a flow', change: { flowId }, expected: { ok: true, patch: { flowId } } },
    { name: 'the lane cap and wait', change: { maxLanes: 4, humanWaitMinutes: 30 }, expected: { ok: true, patch: { maxLanes: 4, humanWaitMinutes: 30 } } },
    { name: 'an empty name', change: { name: ' ' }, expected: { ok: false, errors: { name: 'Enter a name' } } },
    { name: 'an empty gate', change: { gateCommand: '' }, expected: { ok: false, errors: { gateCommand: 'Enter the gate command' } } },
    { name: 'an empty lane cap', change: { maxLanes: '' }, expected: { ok: false, errors: { maxLanes: 'Enter the lane cap' } } },
    { name: 'an empty handoff', change: { handoffPct: '' }, expected: { ok: false, errors: { handoffPct: 'Enter the handoff percentage' } } },
    { name: 'a nudge at the handoff', change: { handoffPct: 50, nudgePct: 50 }, expected: { ok: false, errors: { nudgePct: 'The nudge must come after the handoff' } } },
    { name: 'a zero ceiling', change: { budgetCeiling: 0 }, expected: { ok: false, errors: { budgetCeiling: 'Enter a ceiling above $0, or leave it empty for none' } } },
  ])('answers $name', ({ change, expected }) => {
    expect(checkGeneral(project, { ...base, ...change })).toEqual(expected);
  });

  it('clears a ceiling when the field is emptied', () => {
    const capped = projectDto({ budgetCeiling: 3 });
    expect(checkGeneral(capped, { ...generalValues(capped), budgetCeiling: '' })).toEqual({ ok: true, patch: { budgetCeiling: null } });
  });
});
```

In `settings-view.test.tsx`, add:

```tsx
  it('saves only the changed project fields', async () => {
    let project = projectDto({ name: 'demo', gateCommand: 'make gate' });
    const patched: unknown[] = [];
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/flows'), () => HttpResponse.json([])),
      http.patch(daemonUrl('/projects/:projectId'), async ({ request }) => {
        const body = await request.json();
        patched.push(body);
        project = { ...project, gateCommand: 'make check' };
        return HttpResponse.json(project);
      }),
      ...baseHandlers(),
    );
    renderApp('/settings/general');
    const gate = await screen.findByLabelText('Gate command');
    fireEvent.change(gate, { target: { value: 'make check' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(patched).toEqual([{ gateCommand: 'make check' }]);
    });
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });

  it('blocks a nudge at the handoff without calling the daemon', async () => {
    let calls = 0;
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([projectDto()])),
      http.get(daemonUrl('/flows'), () => HttpResponse.json([])),
      http.patch(daemonUrl('/projects/:projectId'), () => {
        calls += 1;
        return HttpResponse.json({}, { status: 500 });
      }),
      ...baseHandlers(),
    );
    renderApp('/settings/general');
    fireEvent.change(await screen.findByLabelText('Nudge at %'), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The nudge must come after the handoff')).toBeTruthy();
    expect(calls).toBe(0);
  });

  it("shows the daemon's message when it refuses the change", async () => {
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([projectDto()])),
      http.get(daemonUrl('/flows'), () => HttpResponse.json([])),
      http.patch(daemonUrl('/projects/:projectId'), () =>
        HttpResponse.json({ error: 'not_found', message: 'flow flw_x not found' }, { status: 404 }),
      ),
      ...baseHandlers(),
    );
    renderApp('/settings/general');
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('flow flw_x not found')).toBeTruthy();
  });

  it('says there is nothing to change', async () => {
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([projectDto()])),
      http.get(daemonUrl('/flows'), () => HttpResponse.json([])),
      ...baseHandlers(),
    );
    renderApp('/settings/general');
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Nothing to change.')).toBeTruthy();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @10db/desktop exec vitest run src/views/settings`
Expected: FAIL: `./general-values` doesn't exist; no `Gate command` field.

- [ ] **Step 3: Write the values and the check**

`apps/desktop/src/views/settings/general-values.ts`:

```ts
import type { FlowId, ProjectDto, ProjectPatch } from '@10db/contracts';

/** The General form's fields; an emptied number field is ''. */
export interface GeneralValues {
  readonly name: string;
  readonly gateCommand: string;
  readonly maxLanes: number | '';
  readonly handoffPct: number | '';
  readonly nudgePct: number | '';
  readonly humanWaitMinutes: number | '';
  readonly flowId: FlowId | null;
  /** '' means no ceiling. */
  readonly budgetCeiling: number | '';
}

export type GeneralErrors = Partial<Record<keyof GeneralValues, string>>;
export type GeneralCheck =
  | { readonly ok: true; readonly patch: ProjectPatch | null }
  | { readonly ok: false; readonly errors: GeneralErrors };

export function generalValues(project: ProjectDto): GeneralValues {
  return {
    name: project.name,
    gateCommand: project.gateCommand,
    maxLanes: project.maxLanes,
    handoffPct: project.handoffPct,
    nudgePct: project.nudgePct,
    humanWaitMinutes: project.humanWaitMinutes,
    flowId: project.flowId,
    budgetCeiling: project.budgetCeiling ?? '',
  };
}

/** Client-side checks with the daemon's rules, and the patch of what differs from the project. */
export function checkGeneral(project: ProjectDto, values: GeneralValues): GeneralCheck {
  const errors: GeneralErrors = {};
  const name = values.name.trim();
  const gateCommand = values.gateCommand.trim();
  if (name === '') errors.name = 'Enter a name';
  if (gateCommand === '') errors.gateCommand = 'Enter the gate command';
  if (values.maxLanes === '') errors.maxLanes = 'Enter the lane cap';
  if (values.handoffPct === '') errors.handoffPct = 'Enter the handoff percentage';
  if (values.nudgePct === '') errors.nudgePct = 'Enter the nudge percentage';
  else if (values.handoffPct !== '' && values.nudgePct <= values.handoffPct)
    errors.nudgePct = 'The nudge must come after the handoff';
  if (values.humanWaitMinutes === '') errors.humanWaitMinutes = 'Enter the wait in minutes';
  if (values.budgetCeiling !== '' && values.budgetCeiling <= 0)
    errors.budgetCeiling = 'Enter a ceiling above $0, or leave it empty for none';
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const patch: { -readonly [K in keyof ProjectPatch]: ProjectPatch[K] } = {};
  if (name !== project.name) patch.name = name;
  if (gateCommand !== project.gateCommand) patch.gateCommand = gateCommand;
  if (values.maxLanes !== '' && values.maxLanes !== project.maxLanes) patch.maxLanes = values.maxLanes;
  if (values.handoffPct !== '' && values.handoffPct !== project.handoffPct) patch.handoffPct = values.handoffPct;
  if (values.nudgePct !== '' && values.nudgePct !== project.nudgePct) patch.nudgePct = values.nudgePct;
  if (values.humanWaitMinutes !== '' && values.humanWaitMinutes !== project.humanWaitMinutes)
    patch.humanWaitMinutes = values.humanWaitMinutes;
  if (values.flowId !== project.flowId) patch.flowId = values.flowId;
  const ceiling = values.budgetCeiling === '' ? null : values.budgetCeiling;
  if (ceiling !== project.budgetCeiling) patch.budgetCeiling = ceiling;
  return { ok: true, patch: Object.keys(patch).length > 0 ? patch : null };
}
```

If `ProjectPatch`'s inferred type (a `.partial()` object behind `.refine`) doesn't accept the mapped type, declare `patch` as `Partial<Record<…>>` per field the same way the old `NewProjectForm` builds its body; keep it cast-free.

- [ ] **Step 4: Write the hooks and the form**

In `apps/desktop/src/daemon/queries.ts`, add `flows: ['flows']` to `queryKeys`, then:

```ts
const FlowList = z.array(FlowDto);

export function useFlows() {
  const { client } = useDaemon();
  return useQuery({ queryKey: queryKeys.flows, queryFn: async () => readJson(await client.flows.$get(), FlowList) });
}

export function usePatchProject(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patch: ProjectPatch) =>
      readJson(await client.projects[':projectId'].$patch({ param: { projectId }, json: patch }), ProjectDto),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
  });
}
```

In `apps/desktop/src/daemon/events.ts`, change `flow: []` to `flow: [queryKeys.flows]`.

`apps/desktop/src/views/settings/project-general-form.tsx`:

```tsx
import type { FlowId, ProjectDto } from '@10db/contracts';
import { Alert, Button, Group, NumberInput, Select, Stack, Text, TextInput } from '@mantine/core';
import { useState } from 'react';
import { useFlows, usePatchProject } from '../../daemon/queries';
import { checkGeneral, generalValues, type GeneralErrors, type GeneralValues } from './general-values';

const asNumber = (value: number | string): number | '' => (typeof value === 'number' ? value : '');

/** The project's editable fields (spec §10 Settings): saved as one patch of what changed. */
export function ProjectGeneralForm({ project }: { readonly project: ProjectDto }) {
  const flows = useFlows();
  const patch = usePatchProject(project.id);
  const [values, setValues] = useState<GeneralValues>(() => generalValues(project));
  const [errors, setErrors] = useState<GeneralErrors>({});
  const [note, setNote] = useState<string | null>(null);
  const set = (change: Partial<GeneralValues>) => {
    setValues((v) => ({ ...v, ...change }));
    setNote(null);
  };
  const flowData = (flows.data ?? []).map((f) => ({ value: f.id, label: f.name }));
  // The Select offers only IDs the daemon sent, so looking the string up gives back the branded ID without a cast.
  const flowById = new Map<string, FlowId>((flows.data ?? []).map((f) => [f.id, f.id]));

  function save() {
    const checked = checkGeneral(project, values);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    if (checked.patch === null) {
      setNote('Nothing to change.');
      return;
    }
    patch.mutate(checked.patch, { onSuccess: () => { setNote('Saved.'); } });
  }

  return (
    <Stack maw={520}>
      <TextInput label="Name" value={values.name} error={errors.name} onChange={(e) => { set({ name: e.currentTarget.value }); }} />
      <TextInput label="Gate command" ff="monospace" value={values.gateCommand} error={errors.gateCommand} onChange={(e) => { set({ gateCommand: e.currentTarget.value }); }} />
      <Group grow>
        <NumberInput label="Lanes" min={1} max={16} value={values.maxLanes} error={errors.maxLanes} onChange={(v) => { set({ maxLanes: asNumber(v) }); }} />
        <NumberInput label="Human wait (minutes)" min={1} max={240} value={values.humanWaitMinutes} error={errors.humanWaitMinutes} onChange={(v) => { set({ humanWaitMinutes: asNumber(v) }); }} />
      </Group>
      <Group grow>
        <NumberInput label="Handoff at %" min={5} max={95} value={values.handoffPct} error={errors.handoffPct} onChange={(v) => { set({ handoffPct: asNumber(v) }); }} />
        <NumberInput label="Nudge at %" min={6} max={98} value={values.nudgePct} error={errors.nudgePct} onChange={(v) => { set({ nudgePct: asNumber(v) }); }} />
      </Group>
      <Select
        label="Flow"
        placeholder="Default (standard)"
        clearable
        data={flowData}
        value={values.flowId}
        onChange={(v) => { set({ flowId: v === null ? null : (flowById.get(v) ?? null) }); }}
      />
      <NumberInput
        label="Budget ceiling per task (USD)"
        description="Empty for no ceiling. Compared with each model profile's cost per task."
        min={0}
        decimalScale={2}
        prefix="$"
        value={values.budgetCeiling}
        error={errors.budgetCeiling}
        onChange={(v) => { set({ budgetCeiling: asNumber(v) }); }}
      />
      {patch.error ? <Alert color="red" title="Couldn't save the project">{patch.error.message}</Alert> : null}
      <Group>
        <Button onClick={save} loading={patch.isPending}>Save</Button>
        <Button variant="default" onClick={() => { setValues(generalValues(project)); setErrors({}); setNote(null); }}>Reset</Button>
        {note ? <Text size="sm" c="dimmed">{note}</Text> : null}
      </Group>
    </Stack>
  );
}
```

In `section-body.tsx`, the General arm renders `<ProjectGeneralForm key={project.id} project={project} />` (the `key` resets the form when the builder switches project).

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @10db/desktop exec vitest run && pnpm --filter @10db/desktop typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm format && git add apps/desktop/src/views/settings apps/desktop/src/daemon/queries.ts apps/desktop/src/daemon/events.ts && git commit -m 'feat(desktop): edit a project’s gate, lanes, thresholds, flow and budget ceiling in settings'
```

---

### Task 10: Part A end to end, docs and the gate

**Files:**
- Modify: `apps/desktop/e2e/loop.spec.ts`, `docs/architecture/decisions.md`, `docs/open-items.md`, `apps/desktop/AGENTS.md`, `packages/db/AGENTS.md`, `DESIGN.md`

**Interfaces:**
- Consumes: Tasks 1–9.

- [ ] **Step 1: Extend the end-to-end run**

In `apps/desktop/e2e/loop.spec.ts`:
- `VIEWS = ['Board', 'Factory', 'Inbox', 'Settings']`.
- After creating the project, the board shows its Icebox column: `await expect(page.getByRole('list', { name: 'Icebox tasks' })).toBeVisible();`.
- Before creating `TASK`, create a second task, `Tidy the readme`, with the same single area, so Ready has two cards with `TASK` second.
- Reorder with the keyboard, and check that it persisted:

```ts
  const ready = page.getByRole('list', { name: 'Ready tasks' });
  await expect(ready.getByRole('listitem')).toHaveCount(2);
  await expect(ready.getByRole('listitem').nth(0)).toHaveAccessibleName('Tidy the readme');
  const handle = ready.getByRole('button', { name: `Drag ${TASK}` });
  await handle.focus();
  await expect(handle).toBeFocused();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Space');
  await expect(ready.getByRole('listitem').nth(0)).toHaveAccessibleName(TASK);
  await page.reload();
  await expect(page.getByRole('list', { name: 'Ready tasks' }).getByRole('listitem').nth(0)).toHaveAccessibleName(TASK);
```

- Park the second task from its menu and plan it again, checking that parking survives a reload:

```ts
  const tidy = page.getByRole('listitem', { name: 'Tidy the readme' });
  await tidy.getByRole('button', { name: 'Actions for Tidy the readme' }).click();
  await page.getByRole('menuitem', { name: 'Move to Icebox' }).click();
  await expect(page.getByRole('list', { name: 'Icebox tasks' }).getByRole('listitem', { name: 'Tidy the readme' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('list', { name: 'Icebox tasks' }).getByRole('listitem', { name: 'Tidy the readme' })).toBeVisible();
  await expectAccessible(page, 'board, parked, dark');
  await page.getByRole('button', { name: 'Actions for Tidy the readme' }).click();
  await page.getByRole('menuitem', { name: 'Move to Ready' }).click();
  await expect(page.getByRole('list', { name: 'Ready tasks' }).getByRole('listitem', { name: 'Tidy the readme' })).toBeVisible();
```

- Start `TASK` from its card menu (Task 5's lines). `Tidy the readme` has no script and is never started.
- After the run, open Settings, add a human column, and visit a planned section:

```ts
  await open(page, 'Settings');
  await expectAccessible(page, 'settings, general, dark');
  await page.getByRole('link', { name: /Board columns/ }).click();
  await page.getByLabel('New column').fill('Exploring');
  await page.getByRole('button', { name: 'Add column' }).click();
  await expect(page.getByRole('table', { name: 'Human columns' }).getByText('Exploring')).toBeVisible();
  await page.getByRole('link', { name: /Accounts/ }).click();
  await expect(page.getByText('Not built yet')).toBeVisible();
  await open(page, 'Board');
  await expect(page.getByRole('list', { name: 'Exploring tasks' })).toBeVisible();
```

The light-mode loop at the end already visits every view in `VIEWS`.

- [ ] **Step 2: Record the decisions**

Append rows A1–A7 from this plan's "New decisions" table to `docs/architecture/decisions.md`, numbered with the next free numbers when this PR merges (if the delivery PR merges first, start after its rows). Copy the text verbatim except the number.

- [ ] **Step 3: Update the open items and the agent docs**

In `docs/open-items.md`:
- Replace the M2b line ("M2b: the board, the picker and PM-agent review …") with:
  - `- [x] M2b: the board with human and derived columns and drag and drop, and the Settings view with General, Board columns, Areas and hazards, Billing and Keep-awake (plan 07, part A).`
  - `- [ ] M2b: the picker and the batch approval sheet (plan 07, part B), after the delivery plan's batch contracts.`
  - `- [ ] M2: the PM-agent review (need estimates, optional steps), the Brainstorm panel, the consult step and ⌘K.`
  - `- [ ] M2: Settings editors for team bindings, routing rules, personas, flows and model profiles, the AA key field and the Intelligence-vs-Cost chart (Pareto line, axis picker, AA logo and source link); their sections are slots.`
  - `- [ ] M2: editing a project's areas and hazards (no patch route yet; Settings shows them read-only).`
  - `- [ ] Board, designed for later: a per-project manual board setting that lets drags override the system columns; person-linked human columns (board_columns.person_id → people); on-drop behaviors (board_columns.on_drop, e.g. start a consult).`
- Replace "M2: Settings view (billing mode, thresholds, keep-awake) and the ⌘K palette." with "M2: the ⌘K palette." (Settings is built.)

In `apps/desktop/AGENTS.md`, add:
- `` - The board (`views/board/`) has human columns (parked tasks, never started) left of the derived system columns. `drop-rules.ts` holds the drag rules and the card menu's equivalent moves; both call `POST /tasks/:taskId/move` or `POST /tasks/:taskId/start`. jsdom can't drive dnd-kit's sensors (no layout): unit tests move cards through the menu, and `e2e/loop.spec.ts` drives a keyboard drag in WebKit. ``
- `` - Settings (`views/settings/`) is one route over `sections.ts`. To fill a planned section, set its `planned` to null and replace its arm in `section-body.tsx`. ``

In `packages/db/AGENTS.md`, add one line: `` - `board_columns` holds the builder's human columns; `tasks.board_column_id` set means parked (never started: `insertWorkstream` refuses it), null means planned. ``

In `DESIGN.md`, add one line under Density: ``Board cards are compact `Paper`s with a drag handle (Tabler grip-vertical; disabled, with a tooltip saying why, in In progress, Blocked and Done) and an actions menu. Human columns sit left of the locked system columns, which show a lock icon. Columns scroll horizontally on narrow windows.``

- [ ] **Step 4: Run the gate**

Run: `make gate`
Expected: the last line starts `GATE PASS format lint typecheck test build e2e drift knip`.
- A `knip` failure names an unused export: remove it or use it.
- A `drift` failure in `packages/db`: the baseline wasn't regenerated from the final schema; redo Task 2 Step 3's commands.
- An `e2e` failure in the keyboard drag: dnd-kit's keyboard sensor starts on Space or Enter on the focused activator; confirm the handle has focus first.

- [ ] **Step 5: Commit and open the PR**

```bash
pnpm format && git add apps/desktop/e2e/loop.spec.ts docs/architecture/decisions.md docs/open-items.md apps/desktop/AGENTS.md packages/db/AGENTS.md DESIGN.md && git commit -m 'docs(docs): record the board columns and settings decisions'
```

Push the branch and open a PR to `main` titled `feat(desktop): board with human columns and drag and drop, and a settings view (m2b part a)`. Its body:
- lists what Part A builds;
- lists the contracts and db changes (the `board_columns` table, `tasks.board_column_id` and the regenerated baseline), with the note that the delivery plan regenerates the same baseline, so whichever merges second regenerates it again;
- says what waits for Part B;
- includes the `GATE PASS` line.

---

# Part B: the picker and the batch approval sheet

Tasks 11–13 depend only on Part A and M2a, and can be built at any time. Task 14 starts only once the delivery plan's contracts and routes are on `main`. Its first step checks them against what this plan assumes (Open decision 5 and "Depends on the delivery plan" under Shared hot spots). Where they differ, follow the delivery plan, change only `sheet-mode.ts`, `use-start-work.ts`, their tests and the batch fixture, and say so in the task's report.

### Task 11: The picker proposal contract

**Files:**
- Create: `packages/contracts/src/picker.ts`, `packages/contracts/src/picker.test.ts`
- Modify: `packages/contracts/src/index.ts`, `packages/contracts/src/json-schema.ts`
- Generated: `packages/contracts/generated/picker-proposal-dto.schema.json`

**Interfaces:**
- Consumes: `TaskDto`, `StepPlanDto`, `ProjectId`, `ClaimKind`.
- Produces:
  - `PICK_MAX = 16` (the lane cap's maximum) and `PickSize = z.coerce.number().int().min(1).max(PICK_MAX)` for the `size` query parameter.
  - `PickerClaim = { kind: ClaimKind; name: string }`.
  - `PickerCandidate = { task: TaskDto; proposed: boolean; resumed: boolean; unblocks: number; claims: PickerClaim[]; conflict: string | null; plan: StepPlanDto | null; planError: string | null }`.
  - `PickerProposalDto = { projectId: ProjectId; size: number; candidates: PickerCandidate[] }`, candidates in picker order.
  - None of these models a batch: a batch is the delivery spec's entity.

- [ ] **Step 1: Write the failing test**

`packages/contracts/src/picker.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mintId } from './ids';
import { PICK_MAX, PickerProposalDto, PickSize } from './picker';

const AT = '2026-10-21T12:00:00.000Z';
const task = {
  id: mintId('Task'),
  projectId: mintId('Project'),
  title: 'T',
  description: '',
  acceptanceCriteria: ['x'],
  areas: ['api'],
  riskTags: [],
  flowId: null,
  status: 'open',
  boardOrder: 1,
  dependsOn: [],
  boardStatus: 'ready',
  workstreamId: null,
  createdAt: AT,
  updatedAt: AT,
};

describe('PickSize', () => {
  it.each([
    { raw: '1', ok: true },
    { raw: String(PICK_MAX), ok: true },
    { raw: '0', ok: false },
    { raw: String(PICK_MAX + 1), ok: false },
    { raw: '2.5', ok: false },
    { raw: 'two', ok: false },
    { raw: undefined, ok: false },
  ])('parses $raw: $ok', ({ raw, ok }) => {
    expect(PickSize.safeParse(raw).success).toBe(ok);
  });
});

describe('PickerProposalDto', () => {
  it('parses a proposal with a left-out candidate whose plan failed', () => {
    const parsed = PickerProposalDto.parse({
      projectId: task.projectId,
      size: 2,
      candidates: [
        {
          task,
          proposed: false,
          resumed: false,
          unblocks: 0,
          claims: [{ kind: 'area', name: 'api' }],
          conflict: 'The standard flow is missing; restart 10db to seed it',
          plan: null,
          planError: 'The standard flow is missing; restart 10db to seed it',
        },
      ],
    });
    expect(parsed.candidates[0]?.planError).toMatch(/standard flow/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @10db/contracts exec vitest run src/picker.test.ts`
Expected: FAIL, `Cannot find module './picker'`.

- [ ] **Step 3: Write the schemas**

`packages/contracts/src/picker.ts`:

```ts
import { z } from 'zod';
import { TaskDto } from './entities';
import { ProjectId } from './ids';
import { ClaimKind } from './states';
import { StepPlanDto } from './steps';

/** The most tasks a proposal offers at once: the largest lane cap a project can have. */
export const PICK_MAX = 16;

/** The `size` query parameter of a proposal. */
export const PickSize = z.coerce.number().int().min(1).max(PICK_MAX);

export const PickerClaim = z.object({ kind: z.enum(ClaimKind), name: z.string() });
export type PickerClaim = z.infer<typeof PickerClaim>;

/** One Ready task as the picker sees it (spec §5.2.1); the approval sheet shows it (spec §5.2.4). */
export const PickerCandidate = z.object({
  task: TaskDto,
  /** Ticked when the sheet opens: within the size and free of conflicts. */
  proposed: z.boolean(),
  /** An earlier workstream for the task ended without finishing. */
  resumed: z.boolean(),
  /** The longest chain of open tasks waiting on this one. */
  unblocks: z.int().min(0),
  claims: z.array(PickerClaim),
  /** Why the picker left it out; null when it was proposed or only the size kept it out. */
  conflict: z.string().nullable(),
  plan: StepPlanDto.nullable(),
  planError: z.string().nullable(),
});
export type PickerCandidate = z.infer<typeof PickerCandidate>;

export const PickerProposalDto = z.object({
  projectId: ProjectId,
  size: z.int().min(1).max(PICK_MAX),
  candidates: z.array(PickerCandidate),
});
export type PickerProposalDto = z.infer<typeof PickerProposalDto>;
```

Export it from `index.ts` (`export * from './picker';`) and register `'picker-proposal-dto': PickerProposalDto,` in `json-schema.ts`.

- [ ] **Step 4: Run the tests and regenerate**

Run: `pnpm --filter @10db/contracts exec vitest run && pnpm --filter @10db/contracts generate && git status --short packages/contracts/generated`
Expected: PASS, and one new file `picker-proposal-dto.schema.json`.

- [ ] **Step 5: Commit**

```bash
pnpm format && git add packages/contracts/src/picker.ts packages/contracts/src/picker.test.ts packages/contracts/src/index.ts packages/contracts/src/json-schema.ts packages/contracts/generated/picker-proposal-dto.schema.json && git commit -m 'feat(contracts): add the picker proposal for the batch approval sheet'
```

---

### Task 12: The picker rules

A pure module, like `routing/`: it imports `@10db/contracts` only, and its caller passes the rows in.

**Files:**
- Create: `apps/daemon/src/picker/pick.ts`, `apps/daemon/src/picker/pick.test.ts`, `apps/daemon/src/picker/index.ts`

**Interfaces:**
- Consumes: `BoardStatus`, `TaskStatus`, `TaskDto` fields.
- Produces:
  - `PickerTask = Pick<TaskDto, 'id' | 'title' | 'areas' | 'dependsOn' | 'status' | 'boardStatus' | 'boardOrder' | 'workstreamId' | 'boardColumnId'>`. Only planned tasks (`boardColumnId === null`) are candidates; a parked task is never picked.
  - `PickInput = { tasks: readonly PickerTask[]; held: ReadonlyMap<string, string>; hazards: ReadonlySet<string>; ruledOut: ReadonlyMap<TaskId, string>; size: number }`. `held` maps a claim name to the title of the task whose active work holds it; `ruledOut` maps a task to why its plan can't start.
  - `PickResult = { taskId: TaskId; proposed: boolean; resumed: boolean; unblocks: number; conflict: string | null }`.
  - `pickCandidates(input: PickInput): PickResult[]`: every Ready task, in picker order. `index.ts` exports it and `PickerTask`.

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/picker/pick.test.ts`:

```ts
import { mintId, type TaskId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { pickCandidates, type PickerTask } from './pick';

type Spec = Partial<PickerTask> & { readonly title: string };
function tasks(...specs: Spec[]): PickerTask[] {
  return specs.map((s, i) => ({
    id: mintId('Task'),
    areas: ['a'],
    dependsOn: [],
    status: 'open',
    boardStatus: 'ready',
    boardOrder: i + 1,
    workstreamId: null,
    boardColumnId: null,
    ...s,
  }));
}

interface RunOptions {
  readonly held?: readonly [string, string][];
  readonly hazards?: readonly string[];
  readonly ruledOut?: readonly [string, string][];
  readonly size?: number;
}

function run(list: PickerTask[], opts: RunOptions = {}) {
  const byTitle = new Map(list.map((t) => [t.title, t.id]));
  const title = new Map(list.map((t) => [t.id, t.title]));
  const ruledOut = new Map<TaskId, string>();
  for (const [t, why] of opts.ruledOut ?? []) {
    const id = byTitle.get(t);
    if (id) ruledOut.set(id, why);
  }
  return pickCandidates({
    tasks: list,
    held: new Map(opts.held ?? []),
    hazards: new Set(opts.hazards ?? []),
    ruledOut,
    size: opts.size ?? 16,
  }).map((p) => ({
    title: title.get(p.taskId),
    proposed: p.proposed,
    resumed: p.resumed,
    unblocks: p.unblocks,
    conflict: p.conflict,
  }));
}

describe('pickCandidates', () => {
  it('proposes Ready tasks in board order when nothing else differs', () => {
    const list = tasks({ title: 'x', areas: ['a'] }, { title: 'y', areas: ['b'] });
    expect(run(list).map((p) => [p.title, p.proposed])).toEqual([
      ['x', true],
      ['y', true],
    ]);
  });

  it('puts a task whose earlier workstream ended first', () => {
    const list = tasks(
      { title: 'x', areas: ['a'] },
      { title: 'y', areas: ['b'], workstreamId: mintId('Workstream') },
    );
    expect(run(list).map((p) => [p.title, p.resumed])).toEqual([
      ['y', true],
      ['x', false],
    ]);
  });

  it('orders by the longest chain of open work each task unblocks, counting open dependents only', () => {
    const [leaf, root, side] = tasks(
      { title: 'leaf', areas: ['a'] },
      { title: 'root', areas: ['b'] },
      { title: 'side', areas: ['c'] },
    );
    if (!leaf || !root || !side) throw new Error('fixture');
    const [mid] = tasks({ title: 'mid', boardStatus: 'backlog', dependsOn: [root.id] });
    if (!mid) throw new Error('fixture');
    const [top] = tasks({ title: 'top', boardStatus: 'backlog', dependsOn: [mid.id] });
    const [finished] = tasks({ title: 'finished', status: 'done', boardStatus: 'done', dependsOn: [side.id] });
    if (!top || !finished) throw new Error('fixture');
    expect(run([leaf, root, side, mid, top, finished]).map((p) => [p.title, p.unblocks])).toEqual([
      ['root', 2],
      ['leaf', 0],
      ['side', 0],
    ]);
  });

  it.each([
    {
      name: 'an area held by active work',
      areas: ['api'],
      opts: { held: [['api', 'Base']] } satisfies RunOptions,
      conflict: 'Area api is held by Base, which is already running or queued',
    },
    {
      name: 'a hazard held by active work, named as a hazard',
      areas: ['deps'],
      opts: { held: [['deps', 'Bump']], hazards: ['deps'] } satisfies RunOptions,
      conflict: 'Hazard deps is held by Bump, which is already running or queued',
    },
    {
      name: 'a plan that cannot start',
      areas: ['api'],
      opts: { ruledOut: [['x', 'Over the budget ceiling: step 2 (review)']] } satisfies RunOptions,
      conflict: 'Over the budget ceiling: step 2 (review)',
    },
  ])('leaves out a task for $name', ({ areas, opts, conflict }) => {
    expect(run(tasks({ title: 'x', areas }), opts)).toEqual([
      { title: 'x', proposed: false, resumed: false, unblocks: 0, conflict },
    ]);
  });

  it('leaves out a task that shares an area with one picked before it', () => {
    const list = tasks({ title: 'first', areas: ['api'] }, { title: 'second', areas: ['api', 'ui'] });
    expect(run(list).map((p) => [p.title, p.proposed, p.conflict])).toEqual([
      ['first', true, null],
      ['second', false, 'Area api is shared with first, picked before it'],
    ]);
  });

  it('proposes at most size tasks and leaves the rest unticked without a conflict', () => {
    const list = tasks({ title: 'x', areas: ['a'] }, { title: 'y', areas: ['b'] }, { title: 'z', areas: ['c'] });
    expect(run(list, { size: 2 }).map((p) => [p.title, p.proposed, p.conflict])).toEqual([
      ['x', true, null],
      ['y', true, null],
      ['z', false, null],
    ]);
  });

  it('lets a left-out task claim nothing', () => {
    const list = tasks({ title: 'blocked', areas: ['api'] }, { title: 'next', areas: ['api'] });
    expect(run(list, { ruledOut: [['blocked', 'No plan']] }).map((p) => [p.title, p.proposed])).toEqual([
      ['blocked', false],
      ['next', true],
    ]);
  });

  it('offers only Ready tasks', () => {
    const list = tasks(
      { title: 'ready' },
      { title: 'backlog', boardStatus: 'backlog' },
      { title: 'running', boardStatus: 'in_progress' },
      { title: 'blocked', boardStatus: 'blocked' },
      { title: 'done', boardStatus: 'done', status: 'done' },
    );
    expect(run(list).map((p) => p.title)).toEqual(['ready']);
  });

  it('never offers a task parked in a human column', () => {
    const list = tasks({ title: 'planned' }, { title: 'parked', boardColumnId: mintId('BoardColumn') });
    expect(run(list).map((p) => p.title)).toEqual(['planned']);
  });

  it('answers an empty list when nothing is Ready', () => {
    expect(run(tasks({ title: 'b', boardStatus: 'backlog' }))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @10db/daemon exec vitest run src/picker`
Expected: FAIL, `Cannot find module './pick'`.

- [ ] **Step 3: Write the rules**

`apps/daemon/src/picker/pick.ts`:

```ts
import { BoardStatus, TaskStatus, type TaskDto, type TaskId } from '@10db/contracts';

export type PickerTask = Pick<
  TaskDto,
  | 'id'
  | 'title'
  | 'areas'
  | 'dependsOn'
  | 'status'
  | 'boardStatus'
  | 'boardOrder'
  | 'workstreamId'
  | 'boardColumnId'
>;

export interface PickInput {
  readonly tasks: readonly PickerTask[];
  /** Claim names held by active work (queued included), each with the title of its task. */
  readonly held: ReadonlyMap<string, string>;
  /** The project's hazard names, so a conflict names a hazard as one. */
  readonly hazards: ReadonlySet<string>;
  /** Tasks whose plan can't start, with why. */
  readonly ruledOut: ReadonlyMap<TaskId, string>;
  readonly size: number;
}

export interface PickResult {
  readonly taskId: TaskId;
  readonly proposed: boolean;
  readonly resumed: boolean;
  readonly unblocks: number;
  readonly conflict: string | null;
}

/** For each task, the longest chain of open tasks that depend on it, directly or through others. */
function unblockChains(tasks: readonly PickerTask[]): Map<TaskId, number> {
  const dependents = new Map<TaskId, TaskId[]>();
  for (const task of tasks) {
    if (task.status !== TaskStatus.Open) continue;
    for (const dep of task.dependsOn) dependents.set(dep, [...(dependents.get(dep) ?? []), task.id]);
  }
  const memo = new Map<TaskId, number>();
  const visiting = new Set<TaskId>();
  const chain = (id: TaskId): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    // Dependencies must exist when a task is created, so no cycle can form; this only stops a loop.
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const length = Math.max(0, ...(dependents.get(id) ?? []).map((d) => 1 + chain(d)));
    visiting.delete(id);
    memo.set(id, length);
    return length;
  };
  for (const task of tasks) chain(task.id);
  return memo;
}

interface Taken {
  readonly title: string;
  readonly picked: boolean;
}

function clash(
  task: PickerTask,
  taken: ReadonlyMap<string, Taken>,
  hazards: ReadonlySet<string>,
): string | null {
  for (const name of task.areas) {
    const holder = taken.get(name);
    if (!holder) continue;
    const what = `${hazards.has(name) ? 'Hazard' : 'Area'} ${name}`;
    return holder.picked
      ? `${what} is shared with ${holder.title}, picked before it`
      : `${what} is held by ${holder.title}, which is already running or queued`;
  }
  return null;
}

/**
 * Spec §5.2.1: Ready tasks, resumed work first, then the longest chain of work each unblocks, then the
 * builder's board order. A task whose claims collide with active work or an earlier pick, or whose
 * plan can't start, is left out with the reason; the first `size` of the rest are proposed.
 */
export function pickCandidates({ tasks, held, hazards, ruledOut, size }: PickInput): PickResult[] {
  const chains = unblockChains(tasks);
  const ready = tasks
    // A task parked in a human column is never picked.
    .filter((t) => t.boardStatus === BoardStatus.Ready && t.boardColumnId === null)
    .map((task) => ({ task, resumed: task.workstreamId !== null, unblocks: chains.get(task.id) ?? 0 }))
    .sort(
      (a, b) =>
        Number(b.resumed) - Number(a.resumed) ||
        b.unblocks - a.unblocks ||
        a.task.boardOrder - b.task.boardOrder,
    );
  const taken = new Map<string, Taken>(
    [...held].map(([name, title]) => [name, { title, picked: false }]),
  );
  let proposedCount = 0;
  return ready.map(({ task, resumed, unblocks }) => {
    const conflict = ruledOut.get(task.id) ?? clash(task, taken, hazards);
    const proposed = conflict === null && proposedCount < size;
    if (proposed) {
      proposedCount += 1;
      for (const name of task.areas) taken.set(name, { title: task.title, picked: true });
    }
    return { taskId: task.id, proposed, resumed, unblocks, conflict };
  });
}
```

`apps/daemon/src/picker/index.ts`:

```ts
export { pickCandidates, type PickerTask } from './pick';
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @10db/daemon exec vitest run src/picker && pnpm --filter @10db/daemon typecheck && pnpm lint`
Expected: PASS. (knip may flag `picker/index.ts` until Task 13 imports it; run knip after Task 13.)

- [ ] **Step 5: Commit**

```bash
pnpm format && git add apps/daemon/src/picker && git commit -m 'feat(daemon): add the picker rules that order and filter ready tasks'
```

---

### Task 13: `GET /projects/:projectId/candidates`

**Files:**
- Create: `apps/daemon/src/team/candidates.ts`, `apps/daemon/src/team/candidates.test.ts`
- Modify: `apps/daemon/src/team/index.ts`, `apps/daemon/src/api/app.ts`, `apps/daemon/src/api/services.ts`, `apps/daemon/src/daemon/services.ts`, `apps/daemon/src/api/app.test.ts`, `apps/daemon/src/daemon/start.test.ts`

**Interfaces:**
- Consumes: `pickCandidates` (Task 12), `PickerProposalDto`, `PickSize` (Task 11), `resolveStepPlan` (M2a), and from `@10db/db`: `getProject`, `getTask`, `listTasks`, `listWorkstreams`, `activeClaims`, `claimRequestsForTask`.
- Produces:
  - `proposeCandidates(db: DbReader, projectId: ProjectId, size: number): PickerProposalDto` in `team/candidates.ts`, exported from `team/index.ts`.
  - `GET /projects/:projectId/candidates?size=N` answers 200 `PickerProposalDto`; 400 for a missing or out-of-range size; 404 for an unknown project. `ApiServices.proposeCandidates(projectId: ProjectId, size: number): PickerProposalDto`.
  - The desktop calls it as `client.projects[':projectId'].candidates.$get({ param: { projectId }, query: { size: String(size) } })` (Task 14).

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/team/candidates.test.ts`:

```ts
import { mintId, NotFoundError } from '@10db/contracts';
import { createTestStore, insertTask, listBoardColumns, moveTask, patchProject, seedProject } from '@10db/db';
import { readDefaultPersonas } from '@10db/harness';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { measureForTests } from '../../test/catalogue';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { proposeCandidates } from './candidates';
import { seedTeam } from './seed';
import { startTaskWithPlan } from './steps';

let state: StateStore;
let close: () => void;
let project: ReturnType<typeof seedProject>;
beforeEach(() => {
  const test = createTestStore();
  close = test.close;
  state = createStateStore(test.store, createEventBus());
  seedTeam(state, readDefaultPersonas());
  project = seedProject(test.store); // areas api and ui
});
afterEach(() => {
  close();
});

const add = (title: string, areas: string[]) =>
  state.write((ctx) => insertTask(ctx, project.id, { title, acceptanceCriteria: ['x'], areas }));

describe('proposeCandidates', () => {
  it('proposes ready tasks with their claims and step plans', () => {
    add('one', ['api']);
    add('two', ['ui']);
    const proposal = proposeCandidates(state.db, project.id, 2);
    expect(proposal.size).toBe(2);
    expect(proposal.candidates.map((c) => [c.task.title, c.proposed])).toEqual([
      ['one', true],
      ['two', true],
    ]);
    expect(proposal.candidates[0]?.claims).toEqual([{ kind: 'area', name: 'api' }]);
    expect(proposal.candidates[0]?.plan?.steps.map((s) => s.role)).toEqual(['implement', 'review']);
  });

  it('leaves out a task whose area a queued workstream will claim', () => {
    startTaskWithPlan(state, add('running', ['api']).id);
    add('waiting', ['api']);
    const proposal = proposeCandidates(state.db, project.id, 2);
    expect(proposal.candidates.map((c) => [c.task.title, c.proposed, c.conflict])).toEqual([
      ['waiting', false, 'Area api is held by running, which is already running or queued'],
    ]);
  });

  it('never proposes a task parked in a human column', () => {
    const parked = add('parked', ['api']);
    const icebox = listBoardColumns(state.db, project.id)[0];
    if (!icebox) throw new Error('no Icebox');
    state.write((ctx) => moveTask(ctx, parked.id, { to: icebox.id, after: null, before: null }));
    expect(proposeCandidates(state.db, project.id, 2).candidates).toEqual([]);
  });

  it('leaves out an over-budget task and keeps its plan for the sheet', () => {
    measureForTests(state);
    add('costly', ['api']);
    state.write((ctx) => patchProject(ctx, project.id, { budgetCeiling: 0.0001 }));
    const [candidate] = proposeCandidates(state.db, project.id, 1).candidates;
    expect(candidate?.proposed).toBe(false);
    expect(candidate?.conflict).toMatch(/^Over the budget ceiling: step 1 \(implement\)/);
    expect(candidate?.plan?.overBudget.length).toBeGreaterThan(0);
  });

  it('answers not found for an unknown project', () => {
    expect(() => proposeCandidates(state.db, mintId('Project'), 1)).toThrow(NotFoundError);
  });
});
```

If the invented catalogue in `test/catalogue.ts` has an implement profile cheaper than `0.0001`, lower the ceiling below its cheapest; the assertion is that the step is named, not the number.

In `apps/daemon/src/api/app.test.ts`, add `proposeCandidates: track('proposeCandidates'),` to `stubServices` and:

```ts
describe('candidate routes', () => {
  const projectId = mintId('Project');
  it('routes GET /projects/:id/candidates with the size to its service', async () => {
    const seen: number[] = [];
    const res = await app(
      stubServices({
        proposeCandidates: (_id, size) => {
          seen.push(size);
          return { projectId, size, candidates: [] };
        },
      }),
    ).request(`/projects/${projectId}/candidates?size=3`, auth);
    expect(res.status).toBe(200);
    expect(seen).toEqual([3]);
  });

  it.each([
    { name: 'no size', query: '' },
    { name: 'a zero size', query: '?size=0' },
    { name: 'a size over the maximum', query: '?size=17' },
  ])('answers 400 for $name without calling the service', async ({ query }) => {
    const res = await app().request(`/projects/${projectId}/candidates${query}`, auth);
    expect(res.status).toBe(400);
    expect(reached).toEqual([]);
  });
});
```

In `apps/daemon/src/daemon/start.test.ts`, add a real-daemon check: create a project with areas `src` and `docs` and two tasks, one in each area, then `await api.get(`/projects/${project.id}/candidates?size=2`, PickerProposalDto)` lists both as proposed.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @10db/daemon exec vitest run src/team/candidates.test.ts src/api/app.test.ts`
Expected: FAIL, `Cannot find module './candidates'`.

- [ ] **Step 3: Write the proposal**

`apps/daemon/src/team/candidates.ts`:

```ts
import {
  ACTIVE_STATES,
  BoardStatus,
  InvalidError,
  type PickerProposalDto,
  type ProjectId,
  type StepPlanDto,
  type TaskId,
} from '@10db/contracts';
import {
  activeClaims,
  claimRequestsForTask,
  getProject,
  getTask,
  listTasks,
  listWorkstreams,
  type DbReader,
} from '@10db/db';
import { pickCandidates } from '../picker';
import { resolveStepPlan } from './steps';

/** Claim names active work holds or will claim when it launches, each with its task's title. */
function heldClaims(db: DbReader, projectId: ProjectId): Map<string, string> {
  const held = new Map<string, string>();
  for (const ws of listWorkstreams(db, { states: ACTIVE_STATES, projectId })) {
    // A queued workstream holds no claims until it launches, so its task's areas count too.
    const names = [...getTask(db, ws.taskId).areas, ...activeClaims(db, ws.id).map((c) => c.name)];
    for (const name of names) if (!held.has(name)) held.set(name, ws.taskTitle);
  }
  return held;
}

/** The approval sheet's input (spec §5.2.4): the picker's order and choices, with each candidate's plan. */
export function proposeCandidates(db: DbReader, projectId: ProjectId, size: number): PickerProposalDto {
  const project = getProject(db, projectId);
  const tasks = listTasks(db, projectId);
  const plans = new Map<TaskId, StepPlanDto>();
  const planErrors = new Map<TaskId, string>();
  const ruledOut = new Map<TaskId, string>();
  for (const task of tasks) {
    if (task.boardStatus !== BoardStatus.Ready) continue;
    try {
      const plan = resolveStepPlan(db, task.id);
      plans.set(task.id, plan);
      if (plan.overBudget.length > 0) {
        const steps = plan.overBudget.map(
          (i) => `step ${String(i + 1)} (${plan.steps[i]?.role ?? 'unknown'})`,
        );
        ruledOut.set(task.id, `Over the budget ceiling: ${steps.join(', ')}`);
      }
    } catch (error) {
      if (!(error instanceof InvalidError)) throw error;
      planErrors.set(task.id, error.message);
      ruledOut.set(task.id, error.message);
    }
  }
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const picks = pickCandidates({
    tasks,
    held: heldClaims(db, projectId),
    hazards: new Set(project.hazards.map((h) => h.name)),
    ruledOut,
    size,
  });
  return {
    projectId,
    size,
    candidates: picks.flatMap(({ taskId, proposed, resumed, unblocks, conflict }) => {
      const task = byId.get(taskId);
      if (!task) return [];
      return [
        {
          task,
          proposed,
          resumed,
          unblocks,
          conflict,
          claims: claimRequestsForTask(task, project),
          plan: plans.get(taskId) ?? null,
          planError: planErrors.get(taskId) ?? null,
        },
      ];
    }),
  };
}
```

Add `export { proposeCandidates } from './candidates';` to `team/index.ts`.

- [ ] **Step 4: Add the service and the route**

`api/services.ts`:

```ts
  /** The picker's proposal for the approval sheet; reads only. */
  proposeCandidates(projectId: ProjectId, size: number): PickerProposalDto;
```

`daemon/services.ts`: `proposeCandidates: (projectId, size) => proposeCandidates(db, projectId, size),` (imported from `../team`).

`api/app.ts`, after `GET /projects/:projectId/routing-rules`:

```ts
    .get(
      '/projects/:projectId/candidates',
      validator('query', (query): { size?: string } =>
        typeof query['size'] === 'string' ? { size: query['size'] } : {},
      ),
      (c) =>
        c.json(
          deps.services.proposeCandidates(
            ProjectId.parse(c.req.param('projectId')),
            PickSize.parse(c.req.valid('query').size),
          ),
        ),
    )
```

A missing or bad size throws a `ZodError`, which `onError` answers with 400.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @10db/daemon exec vitest run && pnpm -r typecheck && pnpm knip`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm format && git add apps/daemon/src/team apps/daemon/src/api apps/daemon/src/daemon/services.ts apps/daemon/src/daemon/start.test.ts && git commit -m 'feat(daemon): serve the picker proposal with each candidate claims and step plan'
```

---

### Task 14: The batch approval sheet

**Blocked until** the delivery plan's contracts and routes are on `main` (Open decision 5).

**Files:**
- Create: `apps/desktop/src/views/board/batch/sheet-mode.ts`, `sheet-mode.test.ts`, `batch-selection.ts`, `batch-selection.test.ts`, `use-start-work.ts`, `batch-steps.tsx`, `batch-candidate.tsx`, `batch-sheet.tsx`, `batch-sheet.test.tsx`
- Modify: `apps/desktop/src/daemon/queries.ts`, `apps/desktop/src/daemon/events.ts`, `apps/desktop/src/test/fixtures.ts`, `apps/desktop/src/views/board/board-view.tsx`, `apps/desktop/src/views/board/board-view.test.tsx`

**Interfaces:**
- Consumes:
  - `GET /projects/:projectId/candidates` (Task 13); `PickerProposalDto`, `PickerCandidate`, `PICK_MAX` (Task 11); `PATCH /tasks/:taskId` (M2a); `useFlows` (Task 9).
  - From the delivery plan: the batch schema it exports (the spec names it `Batch`, with `BatchState`), `ProjectDto.delivery` and `ProjectDto.currentBatch`, `POST /projects/:projectId/batches` with `{ title, taskIds }`, `POST /tasks/:taskId/start` joining or reopening a batch, and `EventType.BatchUpdated` with entity type `batch`.
- Produces:
  - `SheetMode`, one of:
    - `{ kind: 'local' }`;
    - `{ kind: 'new_batch' }`;
    - `{ kind: 'join'; title }`;
    - `{ kind: 'fix'; title }`;
    - `{ kind: 'busy'; title; reason }`.
  - `sheetMode(project): SheetMode` and `submitLabel(mode, count): string` in `sheet-mode.ts`.
  - In `batch-selection.ts`: `initialSelection(proposal)`, `toggle(selection, id)`, `orderedSelection(proposal, selection)`, and `startBlockers(proposal, selection, mode, title): string[]`.
  - `useCandidates(projectId, size, enabled)`, `usePatchTask()` and `queryKeys.candidates(projectId, size)` in `daemon/queries.ts`.
  - `useStartWork(projectId)` in `batch/use-start-work.ts`, and `StartStoppedError`.
  - `BatchSheet({ project, opened, onClose })`, opened by the board's "Start a batch" button.
  - Each card keeps its Start (`canStart`, Task 5).

- [ ] **Step 1: Check the delivery plan's contracts**

Before writing code, read the delivery plan and `packages/contracts/src` on `main`, and confirm each of these. Note every difference in the task report and adapt the code below to it:
1. The batch schema's export name (`Batch`), its `title` and `state` fields, and the `BatchState` values `CUTTING`, `OPEN`, `SHIPPING`, `SHIPPED`, `CLOSED`, `FAILED`, `ABANDONED` (delivery spec §4).
2. `ProjectDto.delivery` (`local` or `pull_request`) and `ProjectDto.currentBatch` (the unfinished or latest batch, or null; delivery spec §8).
3. `POST /projects/:projectId/batches`:
   - its body is `{ title, taskIds }`;
   - it answers 201 with the batch at once, and cutting finishes in the background with refusals as inbox cards (delivery spec §5);
   - it refuses with 409 while the batch is `CUTTING` or `SHIPPING`.
4. The batch's workstreams are inserted in `taskIds` order, so the sheet's order is launch order (Open decision 8).
5. `POST /tasks/:taskId/start` joins an `OPEN` batch and reopens a `FAILED` one in a `pull_request` project, and behaves as today in a `local` one (delivery spec §5).
6. `EventType.BatchUpdated` is `batch.updated` and its events carry `entityType: 'batch'`.

- [ ] **Step 2: Write the failing tests**

Add fixtures to `apps/desktop/src/test/fixtures.ts`. Import `FlowDto`, `PickerCandidate`, `WorkstreamStep` and the delivery plan's `Batch`. Give `projectDto` the defaults `delivery: 'local'` and `currentBatch: null` if the delivery plan hasn't already.

```ts
export function stepDto(overrides: Partial<WorkstreamStep> = {}): WorkstreamStep {
  return WorkstreamStep.parse({
    role: 'implement',
    personaId: null,
    personaName: 'Implementer',
    tools: 'edit',
    score: 'coding',
    profileId: null,
    model: 'sonnet',
    effort: 'high',
    need: 40,
    reason: 'cheapest profile at or above 40 coding',
    overBudget: false,
    pinned: false,
    status: 'pending',
    attempts: 0,
    startedAt: null,
    sessionFloor: 0,
    result: null,
    ...overrides,
  });
}

export function candidate(task: TaskDto, overrides: Partial<PickerCandidate> = {}): PickerCandidate {
  return PickerCandidate.parse({
    task,
    proposed: true,
    resumed: false,
    unblocks: 0,
    claims: task.areas.map((name) => ({ kind: 'area', name })),
    conflict: null,
    plan: {
      flowName: 'standard',
      steps: [stepDto(), stepDto({ role: 'review', personaName: 'Reviewer', tools: 'read_only', score: 'intelligence' })],
      overBudget: [],
    },
    planError: null,
    ...overrides,
  });
}

export function flowDto(overrides: Partial<FlowDto> = {}): FlowDto {
  return FlowDto.parse({
    id: mintId('Flow'),
    name: 'quick',
    steps: [{ role: 'implement', need: 40, skip: [], persona: null }],
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}
```

Add `batchFixture(overrides)`, which parses with the delivery plan's `Batch` and fills its required fields with schema-valid values (`title` `'Fix the login'`, `state` `'OPEN'` by default). The tests use only `title` and `state`.

`apps/desktop/src/views/board/batch/sheet-mode.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { batchFixture, projectDto } from '../../../test/fixtures';
import { sheetMode, submitLabel } from './sheet-mode';

const title = 'Fix the login';
const pr = (state: string | null) =>
  projectDto({ delivery: 'pull_request', currentBatch: state === null ? null : batchFixture({ title, state }) });

describe('sheetMode', () => {
  it.each([
    { name: 'a local project', project: projectDto({ delivery: 'local' }), expected: { kind: 'local' } },
    { name: 'no batch yet', project: pr(null), expected: { kind: 'new_batch' } },
    { name: 'a shipped batch', project: pr('SHIPPED'), expected: { kind: 'new_batch' } },
    { name: 'a closed batch', project: pr('CLOSED'), expected: { kind: 'new_batch' } },
    { name: 'an abandoned batch', project: pr('ABANDONED'), expected: { kind: 'new_batch' } },
    { name: 'an open batch', project: pr('OPEN'), expected: { kind: 'join', title } },
    { name: 'a failed batch', project: pr('FAILED'), expected: { kind: 'fix', title } },
    { name: 'a batch cutting its branch', project: pr('CUTTING'), expected: { kind: 'busy', title, reason: 'Fix the login is still cutting its branch; start when it is open' } },
    { name: 'a shipping batch', project: pr('SHIPPING'), expected: { kind: 'busy', title, reason: 'Fix the login is shipping; start once it has shipped' } },
  ])('answers $name', ({ project, expected }) => {
    expect(sheetMode(project)).toEqual(expected);
  });
});

describe('submitLabel', () => {
  it.each([
    { mode: { kind: 'local' } as const, count: 1, label: 'Start 1 task' },
    { mode: { kind: 'local' } as const, count: 2, label: 'Start 2 tasks' },
    { mode: { kind: 'new_batch' } as const, count: 2, label: 'Start a batch of 2 tasks' },
    { mode: { kind: 'join', title } as const, count: 1, label: 'Add 1 task to Fix the login' },
    { mode: { kind: 'fix', title } as const, count: 2, label: 'Add 2 fix tasks to Fix the login' },
  ])('says "$label"', ({ mode, count, label }) => {
    expect(submitLabel(mode, count)).toBe(label);
  });
});
```

`apps/desktop/src/views/board/batch/batch-selection.test.ts`:

```ts
import { PickerProposalDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { candidate, projectDto, taskDto } from '../../../test/fixtures';
import { initialSelection, orderedSelection, startBlockers, toggle } from './batch-selection';
import type { SheetMode } from './sheet-mode';

const project = projectDto();
const one = taskDto({ projectId: project.id, title: 'One' });
const two = taskDto({ projectId: project.id, title: 'Two' });
const three = taskDto({ projectId: project.id, title: 'Three' });
const proposal = PickerProposalDto.parse({
  projectId: project.id,
  size: 2,
  candidates: [
    candidate(one),
    candidate(two, { proposed: false, conflict: 'Area src is shared with One, picked before it' }),
    candidate(three, { proposed: false, plan: { flowName: 'standard', steps: [], overBudget: [0] }, conflict: 'Over the budget ceiling: step 1 (implement)' }),
  ],
});
const LOCAL: SheetMode = { kind: 'local' };
const NEW: SheetMode = { kind: 'new_batch' };

describe('batch selection', () => {
  it('starts with the proposed tasks ticked', () => {
    expect([...initialSelection(proposal)]).toEqual([one.id]);
  });

  it('keeps the picker’s order whatever order the builder ticked in', () => {
    expect(orderedSelection(proposal, toggle(toggle(new Set(), two.id), one.id))).toEqual([one.id, two.id]);
  });

  it('drops a ticked task that is no longer a candidate', () => {
    expect(orderedSelection(proposal, new Set([one.id, taskDto().id]))).toEqual([one.id]);
  });

  it.each([
    { name: 'nothing ticked', ticked: [], mode: LOCAL, title: '', blockers: ['Tick at least one task'] },
    { name: 'a proposed task, local', ticked: [one.id], mode: LOCAL, title: '', blockers: [] },
    { name: 'a task sharing an area (it waits its turn)', ticked: [one.id, two.id], mode: LOCAL, title: '', blockers: [] },
    { name: 'an over-budget task', ticked: [three.id], mode: LOCAL, title: '', blockers: ['Three is over the budget ceiling'] },
    { name: 'a new batch with a title', ticked: [one.id], mode: NEW, title: 'One', blockers: [] },
    { name: 'a new batch with no title', ticked: [one.id], mode: NEW, title: '  ', blockers: ['Name the batch'] },
    { name: 'joining an open batch', ticked: [one.id], mode: { kind: 'join', title: 'Fix the login' }, title: '', blockers: [] },
    { name: 'fixing a failed batch', ticked: [one.id], mode: { kind: 'fix', title: 'Fix the login' }, title: '', blockers: [] },
    { name: 'a batch cutting its branch', ticked: [one.id], mode: { kind: 'busy', title: 'Fix the login', reason: 'Fix the login is still cutting its branch; start when it is open' }, title: '', blockers: ['Fix the login is still cutting its branch; start when it is open'] },
    { name: 'a shipping batch', ticked: [one.id], mode: { kind: 'busy', title: 'Fix the login', reason: 'Fix the login is shipping; start once it has shipped' }, title: '', blockers: ['Fix the login is shipping; start once it has shipped'] },
  ] satisfies { name: string; ticked: string[]; mode: SheetMode; title: string; blockers: string[] }[])(
    'answers the blockers for $name',
    ({ ticked, mode, title, blockers }) => {
      const selection = new Set(proposal.candidates.filter((c) => ticked.includes(c.task.id)).map((c) => c.task.id));
      expect(startBlockers(proposal, selection, mode, title)).toEqual(blockers);
    },
  );

  it('names a task whose plan failed', () => {
    const failed = PickerProposalDto.parse({
      projectId: project.id,
      size: 1,
      candidates: [candidate(one, { plan: null, planError: 'The standard flow is missing; restart 10db to seed it' })],
    });
    expect(startBlockers(failed, new Set([one.id]), LOCAL, '')).toEqual(['One: The standard flow is missing; restart 10db to seed it']);
  });
});
```

`apps/desktop/src/views/board/batch/batch-sheet.test.tsx`:

```tsx
import { PickerProposalDto, type ProjectDto, type TaskDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse, type RequestHandler } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../../test/daemon';
import { batchFixture, candidate, flowDto, projectDto, taskDto, workstreamDto } from '../../../test/fixtures';

const local = projectDto({ maxLanes: 2, gateCommand: 'make gate', delivery: 'local' });
const one = taskDto({ projectId: local.id, title: 'One', boardStatus: 'ready', boardOrder: 1 });
const two = taskDto({ projectId: local.id, title: 'Two', boardStatus: 'ready', boardOrder: 2 });

const proposalOf = (project: ProjectDto, size: number, both = false) =>
  PickerProposalDto.parse({
    projectId: project.id,
    size,
    candidates: [
      candidate(one),
      candidate(two, both ? {} : { proposed: false, conflict: 'Area src is shared with One, picked before it' }),
    ],
  });

interface Sent {
  readonly path: string;
  readonly body: unknown;
}

function serve(project: ProjectDto, opts: { readonly sizes?: number[]; readonly both?: boolean; readonly tasks?: TaskDto[] } = {}, ...overrides: RequestHandler[]): Sent[] {
  const sent: Sent[] = [];
  server.use(
    ...overrides,
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl('/projects/:projectId/board-columns'), () => HttpResponse.json([])),
    http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json(opts.tasks ?? [one, two])),
    http.get(daemonUrl('/flows'), () => HttpResponse.json([])),
    http.get(daemonUrl('/projects/:projectId/candidates'), ({ request }) => {
      const size = Number(new URL(request.url).searchParams.get('size'));
      opts.sizes?.push(size);
      return HttpResponse.json(proposalOf(project, size, opts.both ?? false));
    }),
    http.post(daemonUrl('/tasks/:taskId/start'), async ({ request, params }) => {
      sent.push({ path: new URL(request.url).pathname, body: await request.text() });
      return HttpResponse.json(workstreamDto({ taskId: String(params['taskId']) === one.id ? one.id : two.id }), { status: 201 });
    }),
    http.post(daemonUrl('/projects/:projectId/batches'), async ({ request }) => {
      sent.push({ path: new URL(request.url).pathname, body: await request.json() });
      return HttpResponse.json(batchFixture({ projectId: project.id, state: 'CUTTING' }), { status: 201 });
    }),
    ...baseHandlers(),
  );
  return sent;
}

async function openSheet() {
  renderApp('/board');
  fireEvent.click(await screen.findByRole('button', { name: 'Start a batch' }));
  return screen.findByRole('dialog', { name: 'Start a batch' });
}

const pr = (state: string | null) =>
  projectDto({ ...local, delivery: 'pull_request', currentBatch: state === null ? null : batchFixture({ title: 'Fix the login', state }) });

describe('BatchSheet', () => {
  it('in a local project, shows the proposal at the lane cap and starts each ticked task in order', async () => {
    const sizes: number[] = [];
    const sent = serve(local, { sizes });
    const sheet = await openSheet();
    expect(await within(sheet).findByRole('checkbox', { name: 'One' })).toHaveProperty('checked', true);
    expect(within(sheet).getByRole('checkbox', { name: 'Two' })).toHaveProperty('checked', false);
    expect(within(sheet).getByText('Area src is shared with One, picked before it')).toBeTruthy();
    expect(within(sheet).getByText('make gate')).toBeTruthy();
    expect(within(sheet).getByText(/The PM review isn’t built yet/)).toBeTruthy();
    expect(within(sheet).queryByLabelText('Batch title')).toBeNull();
    expect(sizes[0]).toBe(2);

    fireEvent.click(within(sheet).getByRole('checkbox', { name: 'Two' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Start 2 tasks' }));
    await waitFor(() => {
      expect(sent.map((s) => s.path)).toEqual([`/tasks/${one.id}/start`, `/tasks/${two.id}/start`]);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Start a batch' })).toBeNull();
    });
  });

  it.each([
    { name: 'no batch yet', state: null },
    { name: 'a shipped batch', state: 'SHIPPED' },
  ])('with $name, starts a new batch titled after the first ticked task', async ({ state }) => {
    const sent = serve(pr(state), { both: true });
    const sheet = await openSheet();
    const titleField = await within(sheet).findByLabelText('Batch title');
    expect(titleField).toHaveProperty('value', 'One');
    fireEvent.change(titleField, { target: { value: 'Greeting and readme' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Start a batch of 2 tasks' }));
    await waitFor(() => {
      expect(sent).toEqual([{ path: `/projects/${local.id}/batches`, body: { title: 'Greeting and readme', taskIds: [one.id, two.id] } }]);
    });
    // The route answers at once; cutting finishes in the background and its refusals arrive as cards.
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Start a batch' })).toBeNull();
    });
  });

  it('refuses a new batch with no title', async () => {
    serve(pr(null));
    const sheet = await openSheet();
    fireEvent.change(await within(sheet).findByLabelText('Batch title'), { target: { value: ' ' } });
    expect(within(sheet).getByRole('button', { name: 'Start a batch of 1 task' })).toHaveProperty('disabled', true);
    expect(within(sheet).getByText('Name the batch')).toBeTruthy();
  });

  it('adds ticked tasks to an open batch one start at a time', async () => {
    const sent = serve(pr('OPEN'));
    const sheet = await openSheet();
    expect(await within(sheet).findByText('These tasks join Fix the login, on its branch.')).toBeTruthy();
    expect(within(sheet).queryByLabelText('Batch title')).toBeNull();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add 1 task to Fix the login' }));
    await waitFor(() => {
      expect(sent.map((s) => s.path)).toEqual([`/tasks/${one.id}/start`]);
    });
  });

  it('says that starting reopens a failed batch as a fix', async () => {
    serve(pr('FAILED'));
    const sheet = await openSheet();
    expect(await within(sheet).findByText('Fix the login failed to ship. Starting these tasks reopens it as a fix.')).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: 'Add 1 fix task to Fix the login' })).toHaveProperty('disabled', false);
  });

  it.each([
    { state: 'CUTTING', reason: 'Fix the login is still cutting its branch; start when it is open' },
    { state: 'SHIPPING', reason: 'Fix the login is shipping; start once it has shipped' },
  ])('disables Start while the batch is $state and says why', async ({ state, reason }) => {
    const sent = serve(pr(state));
    const sheet = await openSheet();
    expect(await within(sheet).findByText(reason)).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: 'Add 1 task to Fix the login' })).toHaveProperty('disabled', true);
    expect(sent).toEqual([]);
  });

  it("shows the daemon's message when the batch is refused, and stays open", async () => {
    serve(
      pr(null),
      {},
      http.post(daemonUrl('/projects/:projectId/batches'), () =>
        HttpResponse.json({ error: 'conflict', message: 'The batch Fix the login is shipping; start once it has shipped' }, { status: 409 }),
      ),
    );
    const sheet = await openSheet();
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Start a batch of 1 task' }));
    expect(await within(sheet).findByText('The batch Fix the login is shipping; start once it has shipped')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Start a batch' })).toBeTruthy();
  });

  it('stops at the first refused start and says which started', async () => {
    serve(
      local,
      { both: true },
      http.post(daemonUrl('/tasks/:taskId/start'), ({ params }) =>
        String(params['taskId']) === one.id
          ? HttpResponse.json(workstreamDto({ taskId: one.id }), { status: 201 })
          : HttpResponse.json({ error: 'conflict', message: 'Task Two already has an active workstream' }, { status: 409 }),
      ),
    );
    const sheet = await openSheet();
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Start 2 tasks' }));
    expect(await within(sheet).findByText('Started 1 of 2; Two was refused: Task Two already has an active workstream')).toBeTruthy();
  });

  it('shows each step’s persona, profile and why', async () => {
    serve(local);
    const sheet = await openSheet();
    const steps = await within(sheet).findByRole('table', { name: 'Steps for One' });
    expect(within(steps).getAllByText('Implementer').length).toBeGreaterThan(0);
    expect(within(steps).getAllByText('sonnet@high').length).toBeGreaterThan(0);
    expect(within(steps).getAllByText('cheapest profile at or above 40 coding').length).toBeGreaterThan(0);
  });

  it('refetches the proposal when the batch size changes', async () => {
    const sizes: number[] = [];
    serve(local, { sizes });
    const sheet = await openSheet();
    fireEvent.change(await within(sheet).findByLabelText('Batch size'), { target: { value: '1' } });
    await waitFor(() => {
      expect(sizes).toContain(1);
    });
  });

  it('disables Start and says why when nothing is ticked', async () => {
    serve(local);
    const sheet = await openSheet();
    fireEvent.click(await within(sheet).findByRole('checkbox', { name: 'One' }));
    expect(within(sheet).getByRole('button', { name: 'Start 0 tasks' })).toHaveProperty('disabled', true);
    expect(within(sheet).getByText('Tick at least one task')).toBeTruthy();
  });

  it('shows why nothing can start when no task is ready', async () => {
    serve(local, { tasks: [] }, http.get(daemonUrl('/projects/:projectId/candidates'), ({ request }) =>
      HttpResponse.json(PickerProposalDto.parse({ projectId: local.id, size: Number(new URL(request.url).searchParams.get('size')), candidates: [] })),
    ));
    const sheet = await openSheet();
    expect(await within(sheet).findByText('No ready tasks. A task is ready when everything it depends on is done.')).toBeTruthy();
  });

  it('changes a task’s flow from the sheet', async () => {
    const quick = flowDto({ name: 'quick' });
    const patched: unknown[] = [];
    serve(
      local,
      {},
      http.get(daemonUrl('/flows'), () => HttpResponse.json([quick])),
      http.patch(daemonUrl('/tasks/:taskId'), async ({ request }) => {
        patched.push(await request.json());
        return HttpResponse.json(one);
      }),
    );
    const sheet = await openSheet();
    fireEvent.click(await within(sheet).findByLabelText('Flow for One'));
    fireEvent.click(await screen.findByRole('option', { name: 'quick' }));
    await waitFor(() => {
      expect(patched).toEqual([{ flowId: quick.id }]);
    });
  });
});
```

`serve` puts a test's `overrides` first in its `server.use` call; MSW uses the first handler that matches, so they win over the defaults after them.

In `board-view.test.tsx`, add:

```tsx
  it('keeps each card’s Start beside the Start a batch button', async () => {
    const project = projectDto();
    const ready = taskDto({ projectId: project.id, title: 'Alpha', boardStatus: 'ready' });
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([ready])),
    );
    renderApp('/board');
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Alpha' }));
    expect(await screen.findByRole('menuitem', { name: 'Start' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start a batch' })).toBeTruthy();
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @10db/desktop exec vitest run src/views/board`
Expected: FAIL: `./sheet-mode` doesn't exist; no `Start a batch` button.

- [ ] **Step 4: Write the mode and the selection rules**

`apps/desktop/src/views/board/batch/sheet-mode.ts`:

```ts
import { BatchState, type ProjectDto } from '@10db/contracts';

/** How the sheet starts work, from the project's delivery mode and current batch (delivery spec §5). */
export type SheetMode =
  | { readonly kind: 'local' }
  | { readonly kind: 'new_batch' }
  | { readonly kind: 'join'; readonly title: string }
  | { readonly kind: 'fix'; readonly title: string }
  | { readonly kind: 'busy'; readonly title: string; readonly reason: string };

export function sheetMode(project: Pick<ProjectDto, 'delivery' | 'currentBatch'>): SheetMode {
  if (project.delivery === 'local') return { kind: 'local' };
  const batch = project.currentBatch;
  if (batch === null) return { kind: 'new_batch' };
  const { title } = batch;
  switch (batch.state) {
    case BatchState.Open:
      return { kind: 'join', title };
    case BatchState.Failed:
      return { kind: 'fix', title };
    case BatchState.Cutting:
      return { kind: 'busy', title, reason: `${title} is still cutting its branch; start when it is open` };
    case BatchState.Shipping:
      return { kind: 'busy', title, reason: `${title} is shipping; start once it has shipped` };
    case BatchState.Shipped:
    case BatchState.Closed:
    case BatchState.Abandoned:
      return { kind: 'new_batch' };
  }
}

const tasks = (n: number, word = 'task') => `${String(n)} ${word}${n === 1 ? '' : 's'}`;

/** The Start button says what will happen. */
export function submitLabel(mode: SheetMode, count: number): string {
  switch (mode.kind) {
    case 'local':
      return `Start ${tasks(count)}`;
    case 'new_batch':
      return `Start a batch of ${tasks(count)}`;
    case 'join':
    case 'busy':
      return `Add ${tasks(count)} to ${mode.title}`;
    case 'fix':
      return `Add ${tasks(count, 'fix task')} to ${mode.title}`;
  }
}
```

`apps/desktop/src/views/board/batch/batch-selection.ts`:

```ts
import type { PickerProposalDto, TaskId } from '@10db/contracts';
import type { SheetMode } from './sheet-mode';

export function initialSelection(proposal: PickerProposalDto): ReadonlySet<TaskId> {
  return new Set(proposal.candidates.filter((c) => c.proposed).map((c) => c.task.id));
}

export function toggle(selection: ReadonlySet<TaskId>, id: TaskId): ReadonlySet<TaskId> {
  const next = new Set(selection);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** The ticked tasks in the picker's order, which becomes their launch order. */
export function orderedSelection(proposal: PickerProposalDto, selection: ReadonlySet<TaskId>): TaskId[] {
  return proposal.candidates.filter((c) => selection.has(c.task.id)).map((c) => c.task.id);
}

/**
 * Why the ticked tasks can't start. A shared area is not a blocker: the scheduler runs those tasks
 * one after the other. A busy batch, a missing title, or a plan the daemon would refuse is.
 */
export function startBlockers(
  proposal: PickerProposalDto,
  selection: ReadonlySet<TaskId>,
  mode: SheetMode,
  title: string,
): string[] {
  if (mode.kind === 'busy') return [mode.reason];
  const ticked = proposal.candidates.filter((c) => selection.has(c.task.id));
  if (ticked.length === 0) return ['Tick at least one task'];
  const blockers = mode.kind === 'new_batch' && title.trim() === '' ? ['Name the batch'] : [];
  return [
    ...blockers,
    ...ticked.flatMap((c) => {
      if (c.planError !== null) return [`${c.task.title}: ${c.planError}`];
      if (c.plan === null) return [`${c.task.title} has no step plan`];
      if (c.plan.overBudget.length > 0) return [`${c.task.title} is over the budget ceiling`];
      return [];
    }),
  ];
}
```

- [ ] **Step 5: Write the hooks**

In `apps/desktop/src/daemon/queries.ts`, import `PickerProposalDto` and `TaskPatch` (type). Add `candidates: (projectId: ProjectId, size: number) => ['candidates', projectId, size] as const,` to `queryKeys`, and:

```ts
export function useCandidates(projectId: ProjectId, size: number, enabled: boolean) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: queryKeys.candidates(projectId, size),
    queryFn: async () =>
      readJson(
        await client.projects[':projectId'].candidates.$get({ param: { projectId }, query: { size: String(size) } }),
        PickerProposalDto,
      ),
    enabled,
  });
}

export function usePatchTask() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ taskId, patch }: { readonly taskId: TaskId; readonly patch: TaskPatch }) =>
      readJson(await client.tasks[':taskId'].$patch({ param: { taskId }, json: patch }), TaskDto),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
        queryClient.invalidateQueries({ queryKey: ['candidates'] }),
      ]),
  });
}
```

`apps/desktop/src/views/board/batch/use-start-work.ts`:

```ts
import { Batch, WorkstreamDto, type ProjectId, type TaskId } from '@10db/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { readJson } from '../../../daemon/client';
import { useDaemon } from '../../../daemon/provider';
import { queryKeys } from '../../../daemon/queries';
import type { SheetMode } from './sheet-mode';

/** A sequence of starts stopped at a refusal; the tasks before it did start. */
export class StartStoppedError extends Error {
  override readonly name = 'StartStoppedError';
  readonly started: readonly TaskId[];
  constructor(started: readonly TaskId[], total: number, refusedTitle: string, cause: unknown) {
    const why = cause instanceof Error ? cause.message : String(cause);
    super(
      started.length === 0
        ? `${refusedTitle} was refused: ${why}`
        : `Started ${String(started.length)} of ${String(total)}; ${refusedTitle} was refused: ${why}`,
    );
    this.started = started;
  }
}

/** Thrown only if Start is pressed while the batch is busy; the sheet disables it then. */
export class BatchBusyError extends Error {
  override readonly name = 'BatchBusyError';
}

export interface StartWorkInput {
  readonly mode: SheetMode;
  readonly title: string;
  readonly tasks: readonly { readonly id: TaskId; readonly title: string }[];
}

/**
 * Starts the ticked tasks in the sheet's order. A new batch is one request; local work, joining an
 * open batch and fixing a failed one are one start per task.
 */
export function useStartWork(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ mode, title, tasks }: StartWorkInput): Promise<void> => {
      switch (mode.kind) {
        case 'busy':
          throw new BatchBusyError(mode.reason);
        case 'new_batch':
          await readJson(
            await client.projects[':projectId'].batches.$post({
              param: { projectId },
              json: { title: title.trim(), taskIds: tasks.map((t) => t.id) },
            }),
            Batch,
          );
          return;
        case 'local':
        case 'join':
        case 'fix': {
          const started: TaskId[] = [];
          for (const task of tasks) {
            try {
              await readJson(await client.tasks[':taskId'].start.$post({ param: { taskId: task.id } }), WorkstreamDto);
            } catch (error) {
              throw new StartStoppedError(started, tasks.length, task.title, error);
            }
            started.push(task.id);
          }
          return;
        }
      }
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
        queryClient.invalidateQueries({ queryKey: ['workstreams'] }),
        queryClient.invalidateQueries({ queryKey: ['candidates'] }),
      ]),
  });
}
```

`queryKeys.projects` is invalidated because `currentBatch` lives on the project.

In `apps/desktop/src/daemon/events.ts`:
- add `['candidates']` to the lists for `project`, `task`, `workstream`, `claim`, `flow`, `persona`, `team`, `model_profile`, `benchmarks` and `board_column`;
- add `batch: [queryKeys.projects, ['tasks'], ['workstreams'], ['candidates']]`. The entity type of `EventType.BatchUpdated` is checked in Step 1, and `currentBatch` is on the project, so the project list must refetch.

Delete `useStartTask` only if nothing uses it; the card menu's Start (Task 6) still does.

- [ ] **Step 6: Write the sheet**

`apps/desktop/src/views/board/batch/batch-steps.tsx`:

```tsx
import { ROLE_LABEL, type StepPlanDto } from '@10db/contracts';
import { Badge, Table, Text } from '@mantine/core';

/** Spec §5.2.4: each step's persona, model@effort and why. */
export function BatchSteps({ title, plan }: { readonly title: string; readonly plan: StepPlanDto }) {
  return (
    <Table verticalSpacing={4} fz="sm" aria-label={`Steps for ${title}`}>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Step</Table.Th>
          <Table.Th>Persona</Table.Th>
          <Table.Th>Profile</Table.Th>
          <Table.Th>Why</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {plan.steps.map((step, i) => (
          <Table.Tr key={`${String(i)}-${step.role}`}>
            <Table.Td>{ROLE_LABEL[step.role]}</Table.Td>
            <Table.Td>{step.personaName}</Table.Td>
            <Table.Td>
              <Text size="sm" ff="monospace">{`${step.model}@${step.effort}`}</Text>
              {plan.overBudget.includes(i) ? (
                <Badge size="xs" color="red" variant="light">
                  Over budget
                </Badge>
              ) : null}
            </Table.Td>
            <Table.Td>
              <Text size="xs" c="dimmed">
                {step.reason}
              </Text>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}
```

`apps/desktop/src/views/board/batch/batch-candidate.tsx`:

```tsx
import { RiskTag, type FlowId, type PickerCandidate } from '@10db/contracts';
import { Alert, Badge, Checkbox, Code, Group, MultiSelect, Paper, Select, Stack, Text } from '@mantine/core';
import { useFlows, usePatchTask } from '../../../daemon/queries';
import { BatchSteps } from './batch-steps';

const RISK_TAGS: readonly RiskTag[] = Object.values(RiskTag);
const isRiskTag = (value: string): value is RiskTag => RISK_TAGS.some((t) => t === value);

export interface BatchCandidateProps {
  readonly candidate: PickerCandidate;
  readonly ticked: boolean;
  readonly onToggle: () => void;
}

export function BatchCandidate({ candidate, ticked, onToggle }: BatchCandidateProps) {
  const { task } = candidate;
  const flows = useFlows();
  const patch = usePatchTask();
  // The Select offers only IDs the daemon sent, so the lookup returns the branded ID without a cast.
  const flowById = new Map<string, FlowId>((flows.data ?? []).map((f) => [f.id, f.id]));
  return (
    <Paper withBorder radius="md" p="sm">
      <Stack gap="xs">
        <Group justify="space-between">
          <Checkbox label={task.title} checked={ticked} onChange={onToggle} />
          <Group gap={4}>
            {candidate.resumed ? <Badge size="sm" variant="light">Resumed</Badge> : null}
            {candidate.unblocks > 0 ? (
              <Badge size="sm" variant="light" color="gray">{`Unblocks ${String(candidate.unblocks)}`}</Badge>
            ) : null}
          </Group>
        </Group>
        {candidate.conflict ? <Text size="sm" c="yellow">{candidate.conflict}</Text> : null}
        <Group gap={4}>
          <Text size="xs" c="dimmed">Claims</Text>
          {candidate.claims.map((c) => (
            <Code key={`${c.kind}:${c.name}`}>{c.kind === 'hazard' ? `${c.name} (hazard)` : c.name}</Code>
          ))}
        </Group>
        <Group grow>
          <Select
            aria-label={`Flow for ${task.title}`}
            size="sm"
            placeholder="Project default flow"
            clearable
            data={(flows.data ?? []).map((f) => ({ value: f.id, label: f.name }))}
            value={task.flowId}
            onChange={(v) => {
              patch.mutate({ taskId: task.id, patch: { flowId: v === null ? null : (flowById.get(v) ?? null) } });
            }}
          />
          <MultiSelect
            aria-label={`Risk tags for ${task.title}`}
            size="sm"
            placeholder="Risk tags"
            data={[...RISK_TAGS]}
            value={[...task.riskTags]}
            onChange={(values) => {
              patch.mutate({ taskId: task.id, patch: { riskTags: values.filter(isRiskTag) } });
            }}
          />
        </Group>
        {patch.error ? <Alert color="red" title="Couldn't change the task">{patch.error.message}</Alert> : null}
        {candidate.planError ? <Alert color="red" title="No step plan">{candidate.planError}</Alert> : null}
        {candidate.plan ? <BatchSteps title={task.title} plan={candidate.plan} /> : null}
      </Stack>
    </Paper>
  );
}
```

`apps/desktop/src/views/board/batch/batch-sheet.tsx`:

```tsx
import { PICK_MAX, type PickerProposalDto, type ProjectDto } from '@10db/contracts';
import { Alert, Button, Code, Drawer, Group, List, Loader, NumberInput, Stack, Text, TextInput } from '@mantine/core';
import { useState } from 'react';
import { useCandidates } from '../../../daemon/queries';
import { BatchCandidate } from './batch-candidate';
import { initialSelection, orderedSelection, startBlockers, toggle } from './batch-selection';
import { sheetMode, submitLabel, type SheetMode } from './sheet-mode';
import { useStartWork } from './use-start-work';

function ModeNote({ mode }: { readonly mode: SheetMode }) {
  switch (mode.kind) {
    case 'local':
      return <Text size="sm" c="dimmed">This project delivers locally: each task starts on the current branch.</Text>;
    case 'new_batch':
      return <Text size="sm" c="dimmed">These tasks start a new batch with its own branch, and one pull request when they’re all done.</Text>;
    case 'join':
      return <Text size="sm">{`These tasks join ${mode.title}, on its branch.`}</Text>;
    case 'fix':
      return <Text size="sm">{`${mode.title} failed to ship. Starting these tasks reopens it as a fix.`}</Text>;
    case 'busy':
      return null;
  }
}

interface ChoicesProps {
  readonly project: ProjectDto;
  readonly mode: SheetMode;
  readonly proposal: PickerProposalDto;
  readonly onStarted: () => void;
}

function Choices({ project, mode, proposal, onStarted }: ChoicesProps) {
  const [selection, setSelection] = useState(() => initialSelection(proposal));
  const ordered = orderedSelection(proposal, selection);
  const titleOf = new Map(proposal.candidates.map((c) => [c.task.id, c.task.title]));
  const [title, setTitle] = useState<string | null>(null);
  // Until the builder types one, the batch is named after the first ticked task.
  const first = ordered[0];
  const batchTitle = title ?? (first === undefined ? '' : (titleOf.get(first) ?? ''));
  const start = useStartWork(project.id);
  const blockers = startBlockers(proposal, selection, mode, batchTitle);
  if (proposal.candidates.length === 0)
    return <Text c="dimmed">No ready tasks. A task is ready when everything it depends on is done.</Text>;
  return (
    <Stack>
      {mode.kind === 'new_batch' ? (
        <TextInput label="Batch title" description="The pull request's title, after the project's prefix." value={batchTitle} onChange={(e) => { setTitle(e.currentTarget.value); }} />
      ) : null}
      {proposal.candidates.map((c) => (
        <BatchCandidate key={c.task.id} candidate={c} ticked={selection.has(c.task.id)} onToggle={() => { setSelection((s) => toggle(s, c.task.id)); }} />
      ))}
      <Text size="sm">
        Verification: 10db runs <Code>{project.gateCommand}</Code> after each implement step, and review steps must approve.
      </Text>
      {blockers.length > 0 ? (
        <List size="sm" c="yellow">
          {blockers.map((b) => <List.Item key={b}>{b}</List.Item>)}
        </List>
      ) : null}
      {start.error ? <Alert color="red" title="Couldn't start the work">{start.error.message}</Alert> : null}
      <Group justify="flex-end">
        <Button
          disabled={blockers.length > 0}
          loading={start.isPending}
          onClick={() => {
            start.mutate(
              { mode, title: batchTitle, tasks: ordered.map((id) => ({ id, title: titleOf.get(id) ?? id })) },
              { onSuccess: onStarted },
            );
          }}
        >
          {submitLabel(mode, ordered.length)}
        </Button>
      </Group>
    </Stack>
  );
}

export interface BatchSheetProps {
  readonly project: ProjectDto;
  readonly opened: boolean;
  readonly onClose: () => void;
}

/** Spec §5.2.4: what each picked task will run, before anything starts. */
export function BatchSheet({ project, opened, onClose }: BatchSheetProps) {
  const [size, setSize] = useState(project.maxLanes);
  const proposal = useCandidates(project.id, size, opened);
  const mode = sheetMode(project);
  return (
    <Drawer opened={opened} onClose={onClose} position="right" size="xl" title="Start a batch">
      <Stack>
        <NumberInput
          label="Batch size"
          min={1}
          max={PICK_MAX}
          value={size}
          onChange={(v) => {
            if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= PICK_MAX) setSize(v);
          }}
        />
        <Text size="sm" c="dimmed">
          Chosen by the picker’s rules: ready tasks, resumed work first, then the work that unblocks most, then board order. Tasks whose areas collide are left out. The PM review isn’t built yet.
        </Text>
        <ModeNote mode={mode} />
        {proposal.isError ? <Alert color="red" title="Couldn't load the proposal">{proposal.error.message}</Alert> : null}
        {proposal.isPending && opened ? <Loader size="sm" aria-label="Loading the proposal" /> : null}
        {proposal.data ? <Choices key={size} project={project} mode={mode} proposal={proposal.data} onStarted={onClose} /> : null}
      </Stack>
    </Drawer>
  );
}
```

Notes on the sheet:
- `key={size}` resets the ticks and the title when the size changes (a new proposal).
- A refetch for the same size (a task or batch event) keeps the builder's ticks, and `orderedSelection` drops any that stopped being candidates.
- The sheet closes as soon as the batch route answers 201. Cutting finishes in the background, and its refusals arrive as inbox cards and on the delivery plan's batch strip, not in the sheet.

In `board-view.tsx`, add a "Start a batch" button to the header when a project is selected (`const [sheetOpen, sheet] = useDisclosure(false);`, `<Button size="sm" onClick={sheet.open}>Start a batch</Button>`), and render `<BatchSheet key={project.id} project={project} opened={sheetOpen} onClose={sheet.close} />`. Each card keeps its menu Start.

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @10db/desktop exec vitest run && pnpm --filter @10db/desktop typecheck && pnpm lint && pnpm knip`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
pnpm format && git add apps/desktop/src/views/board apps/desktop/src/daemon/queries.ts apps/desktop/src/daemon/events.ts apps/desktop/src/test/fixtures.ts && git commit -m 'feat(desktop): add the batch approval sheet for local and pull request delivery'
```

---

### Task 15: Part B end to end, docs and the gate

**Files:**
- Modify: `apps/desktop/e2e/loop.spec.ts`, `docs/architecture/decisions.md`, `docs/open-items.md`, `apps/daemon/AGENTS.md`, `apps/desktop/AGENTS.md`

- [ ] **Step 1: Start the run through the sheet**

The e2e project uses `local` delivery (the default), so the sheet starts each ticked task with `POST /tasks/:id/start`. In `apps/desktop/e2e/loop.spec.ts`, replace the card-menu start with:

```ts
  await page.getByRole('button', { name: 'Start a batch' }).click();
  const sheet = page.getByRole('dialog', { name: 'Start a batch' });
  await expect(sheet.getByRole('checkbox', { name: TASK })).toBeChecked();
  // Both tasks claim the only area, so the picker leaves the second out and says why.
  await expect(sheet.getByRole('checkbox', { name: 'Tidy the readme' })).not.toBeChecked();
  await expect(sheet.getByText(`Area greeting is shared with ${TASK}, picked before it`)).toBeVisible();
  await expectAccessible(page, 'batch sheet, dark');
  await sheet.getByRole('button', { name: 'Start 1 task' }).click();
  await expect(sheet).toBeHidden();
```

The drag Task 10 added puts `TASK` first, and Task 10 plans `Tidy the readme` again after parking it, so both are candidates and `TASK` is the one proposed. A `pull_request` run needs a remote and `gh`, which the disposable repo doesn't have; the delivery plan's tests cover that mode.

- [ ] **Step 2: Record the decisions**

Append rows B1 and B2 from "New decisions" to `docs/architecture/decisions.md`, numbered with the next free numbers at merge.

- [ ] **Step 3: Update the open items and the agent docs**

In `docs/open-items.md`, tick `M2b: the picker and the batch approval sheet (plan 07, part B), after the delivery plan's batch contracts.`

In `apps/daemon/AGENTS.md`, add `picker` to the first group of the module order line, after `routing`, and add the line:
- `` `picker/` is pure like `routing/`: the spec §5.2.1 rules over rows its caller passes in, planned tasks only. `team/candidates.ts` gathers the rows, adds each candidate's step plan and serves `GET /projects/:projectId/candidates`. It models no batch; batches belong to the delivery module. ``

In `apps/desktop/AGENTS.md`, add:
- `` The board's batch sheet (`views/board/batch/`) starts work as the project's delivery mode and current batch allow: a new batch through `POST /projects/:id/batches`, otherwise one `POST /tasks/:id/start` per task. Each card's menu keeps its own Start. ``

- [ ] **Step 4: Run the gate**

Run: `make gate`
Expected: the last line starts `GATE PASS format lint typecheck test build e2e drift knip`.

- [ ] **Step 5: Commit and open the PR**

```bash
pnpm format && git add apps/desktop/e2e/loop.spec.ts docs/architecture/decisions.md docs/open-items.md apps/daemon/AGENTS.md apps/desktop/AGENTS.md && git commit -m 'docs(docs): record the picker and approval sheet decisions'
```

Push the branch and open a PR to `main` titled `feat(desktop): pick and approve a batch from the board (m2b part b)`. Its body:
- lists what Part B builds;
- lists the contracts it adds (`PickerProposalDto`, `PickSize`, `PICK_MAX`) and the delivery contracts it consumes, with any difference Task 14 Step 1 found;
- includes the `GATE PASS` line.

---

## Self-review notes

- **Spec coverage:**
  - §10 Shell: the Board and Settings views in the nav (Tasks 5 and 7). ⌘K is not in this plan (listed).
  - §10 Board: the derived columns plus Travis's human columns (Tasks 1–3, 5); drag and drop moves tasks and sets priority (Tasks 3, 4, 6); cards with areas, dependency markers and live state (Task 5); "Start a batch" (the spec's "Start N") and the sheet (Task 14). Brainstorm is not in this plan.
  - §5.1 derived status: unchanged and shown as the daemon derives it (Task 5). Parked tasks sit outside it (decision A1). The Ready rule's blocking-card check stays an open item.
  - §5.2.1 picker: Task 12, planned tasks only. §5.2.2 PM review: not built, and the sheet says so (Task 14). §5.2.3 router: M2a, shown per step (Task 14). §5.2.4 approval sheet: Task 14, with the edits of Open decision 3.
  - §10 Settings: per project, the gate command and budget ceiling are editable (Task 9), board columns are editable (Task 8), areas, hazards and billing are shown (Task 7), and team bindings and routing rules are slots. App-wide, keep-awake is editable (Task 7). Providers fold into the Accounts slot, because the accounts spec replaces billing modes and the per-provider cap.
  - Accounts spec §7 and §12 point 4: the Accounts slot and the Billing section's account-picker slot (Task 7).
  - Delivery spec §5 and §8: the sheet's start paths per delivery mode and batch state (Task 14), checked against the delivery plan first (Task 14 Step 1).
  - §5.4 takeover: the takeover plan.
  - Travis's board model: human columns and Icebox (Task 2), parking and planning by drag and menu (Tasks 3, 6), parked tasks never start (Task 3) and are never picked (Task 12), the Board columns section (Task 8). Designed for later and recorded, not built: the manual board setting, person-linked columns and on-drop behaviors (header, decision A2, open items in Task 10).
- **Placeholder scan:** the only content this plan leaves to another plan is the delivery plan's batch schema, project fields and routes (Task 14), which this plan must not define. Open decision 5 and Task 14 Step 1 state the assumed shapes and name the files that change if they differ.
- **Types across tasks:**
  - `BoardColumnId`, `BoardColumnDto`, `BoardColumnInput`, `BoardColumnPatch`, `BoardColumnDelete`, `TaskMove` (Task 1) → the repository (Task 2) → `moveTask` (Task 3) → the routes (Task 4) → `useBoardColumns` (Task 5), `resolveDrop` and `useMoveTask` (Task 6), the Board columns section (Task 8).
  - `TaskDto.boardColumnId` (Task 2) → `boardLayout` and `canStart` (Task 5), `resolveDrop` and `placeLocally` (Task 6), `PickerTask` (Task 12).
  - `ColumnKey`, `LayoutColumn`, `columnKeyId`, `sameColumn` (Task 5) → `drop-rules.ts` and `BoardDnd` (Task 6).
  - `BoardColumn` props: Task 5 (`label`, `count`, `locked`, `children`, `footer`); Task 6 adds `listRef`.
  - `TaskCardMenu` props: Task 5 (`task`, `latest`, `onStart`); Task 6 adds `moves` and `onMove`. Start stays through Part B.
  - `useSelectedProject` and `ProjectPicker` (Task 5) → Settings (Task 7).
  - `useFlows` and `queryKeys.flows` (Task 9) → `BatchCandidate` (Task 14).
  - `PickerProposalDto`, `PickerCandidate`, `PickSize` and `PICK_MAX` (Task 11) → `proposeCandidates` (Task 13) → `useCandidates` and `BatchSheet` (Task 14).
  - `pickCandidates` and `PickerTask` (Task 12) → `proposeCandidates` (Task 13).
  - `SheetMode`, `sheetMode`, `submitLabel` (Task 14) → `startBlockers`, `useStartWork` and `BatchSheet` (Task 14).
- **Review Focus:** each of the seven lines has its test in its owning task: 1 (Tasks 3 and 6), 2 (Task 3), 3 (Task 6), 4 (Tasks 3, 4, 5 and 12), 5 (Tasks 6 and 10), 6 (Tasks 8 and 9), 7 (Tasks 12 and 14).
