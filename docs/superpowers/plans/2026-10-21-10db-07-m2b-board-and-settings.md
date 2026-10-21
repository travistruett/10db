# 10db M2b Board and Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Tasks list becomes a kanban board whose cards the builder drags to set priority, a Settings view gives every project and app setting a home, and "Start N" opens a batch approval sheet that shows what each picked task will run before anything starts.

**Architecture:**
- **Two parts, two PRs.** Part A (Tasks 1–8) is the board with drag and drop and the Settings shell. It depends on nothing new and ships first. Part B (Tasks 9–13) is the picker and the batch approval sheet. Its daemon half (Tasks 9–11) can be built at any time; its sheet (Task 12) starts tasks through the **batch entity that the delivery spec defines** (one PR per batch, in progress), so Task 12 waits until that entity's contracts and its create route are on `main`.
- **Board.** Columns are the derived `TaskDto.boardStatus` the daemon already computes (Backlog, Ready, In progress, Blocked, Done). Drag and drop reorders cards inside a column, which sets the task's `board_order`; a card never changes column by being dropped (Open decision 1). One new daemon route moves a task between two neighbours; the daemon computes the stored order.
- **Settings.** One route, `/settings/$section`, over a section registry. Sections whose APIs exist get real content (project general fields, areas and hazards, billing, keep-awake). The rest render a "planned" panel that names the plan that fills it; Accounts is one of those slots (accounts spec §7, §12).
- **Picker.** A pure daemon module orders the Ready tasks (resumed work first, then the longest chain of open work each unblocks, then board order) and leaves out any whose claims collide with active work or an earlier pick. A read-only route returns that proposal with each candidate's step plan. It models no batch; it is the sheet's input.
- **Approval sheet.** A drawer lists the proposal, lets the builder untick tasks and change each task's flow and risk tags (existing `PATCH /tasks/:id`), and starts the ticked tasks as one batch through the delivery spec's route.

**Tech Stack:** As in M2a. New desktop dependencies: `@dnd-kit/core`, `@dnd-kit/sortable` and `@dnd-kit/utilities` (spec §10 names dnd-kit). No daemon dependency changes.

**Spec:** `docs/superpowers/specs/2026-10-13-10db-factory-loop-design.md`, plus `docs/superpowers/specs/2026-10-17-10db-accounts-design.md` §7 and §12 for the Accounts slot. This plan implements:
- §5.1: the board shows the derived status (already computed by `deriveBoardStatus`).
- §5.2 points 1 and 4: the picker rules and the approval sheet. Point 2 (the PM-agent review) is not built; the sheet says the rules alone chose the batch.
- §10 Shell: the Board and Settings views in the navigation.
- §10 Board: the five columns, "drag and drop moves tasks and sets priority", cards with areas, dependency markers and live workstream state, and "Start N opens the batch approval sheet".
- §10 Settings: the sections, with the per-project budget ceiling and gate command editable and the rest shown or slotted (Open decision 7).
- Accounts spec §7 and §12 point 4: the Accounts section exists as a slot; the screen itself is the accounts plan's.

**Not in this plan:**
- The PM-agent review (§5.2.2), the Brainstorm side panel (§10), the consult step (§5.2.6) and ⌘K (§10). They are the daemon half of planning and get their own plan.
- Takeover and the PTY (§5.4): plan `08-m2c-takeover`.
- Accounts: the daemon, the API and the Accounts screen (accounts spec §7). This plan leaves the slot and the project's account picker slot.
- Editors for team bindings, routing rules, personas, flows and model profiles, the AA key field and the Intelligence-vs-Cost chart. Their routes exist (M2a); their sections are slots here (Open decision 7).
- Branch and PR delivery, and the batch entity: the delivery spec and its plan.
- The Ready rule's "no open blocking inbox item" (open item, spec §5.1) and the inbox's mine/teammate filter.
- The live acceptance run on the standard flow (open item from M2a).

**Plan series:** `00-spikes` … `06-m2a-teams-and-routing`, **`07-m2b-board-and-settings` (this file)**, then `08-m2c-takeover`. The accounts plan and the delivery plan are written separately. This plan was written against `main` at `2b3d811`. Where a file, signature or anchor it names doesn't match the code on `main`, trust the code, adapt the step and say so in the task's report.

**Mantine docs:** the Mantine MCP server may be unavailable. The pinned version is `@mantine/core` 9.7.2; read component props from `apps/desktop/node_modules/@mantine/core/lib/components/<Name>/<Name>.d.ts` when a prop named here is in doubt.

## Open decisions for Travis

The spec is silent or ambiguous on these. The plan is written against the recommended default in each row; changing a default changes the tasks named.

| # | Question | Recommended default (the plan follows it) | Alternative | Tasks affected |
|---|---|---|---|---|
| 1 | What does dropping a card on another column do? Columns are derived from state (§5.1), so a drop can't simply set a column. | **Refused.** Each column is its own drop area; a card can only be reordered inside its column. Moving between columns happens by doing the work (start, finish, cancel). | Map drops to commands: Ready → In progress opens the sheet for that task; any → Done cancels. | 5 |
| 2 | The spec orders picker candidates "in-progress first, then by longest remaining dependency chain" (§5.2.1) and also says drag and drop "sets priority" (§10). Which wins? | **Spec order, board order breaks ties:** resumed work first, then the longest chain of open tasks it unblocks, then board order. | Board order first; the chain length shown only as a hint. | 10 |
| 3 | What can the builder edit on the approval sheet ("The builder edits and approves", §5.2.4)? | **Which tasks are in the batch, and each task's flow and risk tags** (through the existing `PATCH /tasks/:id`, which re-plans). Per-step persona and model overrides are not offered: they need a start-with-overrides contract and a rule for how an override interacts with escalation. | Per-step persona and profile overrides on the sheet, stored on the workstream at start. | 12 |
| 4 | Once batches exist, can a single card still be started on its own? | **Part A keeps each card's Start** (today's `POST /tasks/:id/start`). **Part B removes it**: every start is a batch, and one task is a batch of one, because delivery happens per batch. | Keep a per-card Start beside the sheet. | 4, 12 |
| 5 | What is the batch API the sheet calls? The delivery spec owns it and isn't written yet. | **Assumed:** `@10db/contracts` exports `BatchInput` and `BatchDto`; `POST /projects/:projectId/batches` takes `{ taskIds: TaskId[] }` in the sheet's order, starts every task or none, answers 201 with a `BatchDto`, refuses an over-budget plan with 400 naming the steps (as `startTaskWithPlan` does), and emits events with `entityType: 'batch'`. The batch's name and branch are the delivery spec's to derive. | If the route needs a name or a base branch from the builder, the sheet gains that field; if the names differ, only `useStartBatch` and its test change. | 12, 13 |
| 6 | Does the board replace the Tasks view? | **Yes.** `/board` replaces `/tasks`, which redirects; the project and task forms move onto the board. | Keep both views. | 4 |
| 7 | Which Settings sections get content now? | **General** (every `ProjectPatch` field: name, gate command, lane cap, handoff and nudge, human wait, flow, budget ceiling), **Areas and hazards** (read-only: no patch route), **Billing** (read-only, with the account picker slot), **Keep-awake** (editable). **Slots** with a planned panel: Team, Routing rules, Personas and flows, Models and benchmarks (AA key, profiles, the chart), Accounts. | Build the team and routing-rule editors now; their routes exist. | 6, 7 |
| 8 | Does dragging a queued task change when it launches? | **No.** The scheduler keeps launching queued work in creation order; a batch is created in the sheet's order, so priority at approval time is launch order. | The scheduler launches queued work in board order (a change to `apps/daemon/src/scheduler/`). | none |
| 9 | Small defaults | The Done column is not reorderable, lists the most recently finished first and shows 20 with "Show all". The sheet's batch size starts at the project's lane cap (1–16). The board shows one project at a time; there is no "All projects" board. | — | 4, 12 |

## Shared hot spots

Everything this plan changes in shared packages and in daemon files the parallel delivery work may also touch, so the two can be sequenced.

**`packages/contracts`** (additive only; `PROTOCOL_VERSION` stays 2; no existing schema, `EventType` value or ID kind changes):

| Change | File | Task |
|---|---|---|
| New `TaskMove` schema | `src/board.ts` (new), `src/index.ts` (one export line) | 1 |
| Register `task-move` | `src/json-schema.ts`, `generated/task-move.schema.json` (new, generated) | 1 |
| New `PICK_MAX`, `PickSize`, `PickerClaim`, `PickerCandidate`, `PickerProposalDto` | `src/picker.ts` (new), `src/index.ts` (one export line) | 9 |
| Register `picker-proposal-dto` | `src/json-schema.ts`, `generated/picker-proposal-dto.schema.json` (new, generated) | 9 |

**Depends on the delivery spec** (not defined here; Open decision 5): `BatchInput`, `BatchDto`, `POST /projects/:projectId/batches`, and the `batch` event entity type. Task 12 consumes them and is the only task that waits for them.

**`packages/db`:** no schema change and no migration. One store addition: `moveTask` (with a private renumbering helper) in `src/store/tasks.ts` (Task 2). It reaches the package entry through the existing `export * from './tasks'`.

**`apps/daemon`:**

| File | Change | Task | Overlap risk |
|---|---|---|---|
| `src/api/app.ts`, `src/api/services.ts`, `src/api/app.test.ts` | two routes (`POST /tasks/:taskId/move`, `GET /projects/:projectId/candidates`) and their `ApiServices` methods and stubs | 3, 11 | delivery adds its batch routes to the same files: textual conflicts only, resolved by rebase |
| `src/daemon/services.ts` | the two service methods | 3, 11 | same |
| `src/daemon/start.test.ts` | one integration test per route | 3, 11 | low |
| `src/picker/` (new, pure) | the picker rules | 10 | none |
| `src/team/candidates.ts` (new), `src/team/index.ts` | the proposal | 11 | low |
| `apps/daemon/AGENTS.md` | the module order line gains `picker` | 13 | low |

Not touched: `src/guard`, `src/mcp`, `src/git`, `src/runner`, `src/scheduler`, `src/sessions`.

**Docs:** new rows in `docs/architecture/decisions.md`, numbered **with the next free numbers at merge** (written here as A1–A5 and B1–B2; `tests/repo/src/architecture-docs.test.ts` requires the numbers to run without gaps, so whichever PR merges second renumbers its rows). `docs/open-items.md` lines.

## New decisions

Recorded in `docs/architecture/decisions.md` by Task 8 (A1–A5) and Task 13 (B1–B2), each with the next free number at merge.

| # | Decision | Why |
|---|---|---|
| A1 | The board's columns are the derived board status, so drag and drop only reorders cards inside a column. Each column is its own drop area, and the Done column (most recently finished first) is not reorderable. Every drag has a menu alternative on the card: Move to top, Move up, Move down, Move to bottom. | Spec §5.1 derives the status; a drop can't set a state without a command behind it. WCAG 2.2 SC 2.5.7 asks for a single-pointer alternative to dragging. |
| A2 | A task's priority is its `board_order`, a real number. A move names the task's new neighbours (`after`, `before`, either may be null but not both), and the daemon writes the midpoint of their orders, or one past the end. When the neighbours' gap is under 1e-6 it first renumbers the project's tasks 1…n in their current order. Neighbours in the wrong order answer 409. | One row write per move in the common case; the client never computes a stored order; a stale view fails visibly instead of scrambling the board. |
| A3 | The board replaces the Tasks view at `/board`, and `/tasks` redirects there. The board shows one project at a time, chosen by the same remembered project as Settings. | Spec §10 names Board, not Tasks; one place to create, order and start work. |
| A4 | Drag and drop uses dnd-kit's stable line, `@dnd-kit/core` with `@dnd-kit/sortable` and `@dnd-kit/utilities`, not `@dnd-kit/react`, which is still 0.x. | Spec §10 names dnd-kit. The stable line has a keyboard sensor and screen-reader announcements built in. |
| A5 | Settings is one route, `/settings/$section`, over a registry of sections grouped Project and App. A section that is not built yet renders a planned panel that says what it will hold and which plan fills it; an unknown section redirects to General. | Later plans (accounts, team editors, the AA chart) fill a slot by changing one registry entry and one switch arm. |
| B1 | The picker proposes from the project's Ready tasks. Order: tasks with an earlier, ended workstream first; then the longest chain of open tasks each one unblocks; then board order. A task is left out, with the reason, when one of its claims (an area or a hazard) is held by active work (any workstream not yet terminal, queued included) or by a task picked before it, when its step plan can't be resolved, or when a step is over the budget ceiling. The first `size` tasks left are proposed. The PM-agent review is not built; the sheet says the rules alone chose. | Spec §5.2.1, with board order as the tie-break that makes "sets priority" matter (Open decision 2). Queued work holds no claims until it launches, so its task's areas count as held. |
| B2 | The approval sheet edits which tasks start and each task's flow and risk tags, through `PATCH /tasks/:id`; the proposal re-plans on the task event. It starts the ticked tasks, in the sheet's order, as one batch through the delivery spec's batch route; the board has no per-task Start once batches exist. | Spec §5.2.4. Per-step overrides need a contract and an escalation rule (Open decision 3); delivery happens per batch (Open decision 4). |

## Global Constraints

Everything in M0's, M1a's, M1b's and M2a's Global Constraints still applies. On top of that:
- **Branches:** Part A on `feat/m2b-board-and-settings`, cut from `main`. Part B on `feat/m2b-batch-approval`, cut from `main` after Part A merges; Task 12 starts only after the delivery spec's batch contracts and create route are on `main`. Each part ends with a PR to `main` whose title is a Conventional Commit.
- **Commits:**
  - One command that names its paths: `git add <path> … && git commit -m '…'`. Never `git add -A`, `git add .` or `git commit -a`. Use single quotes for `-m`.
  - Scope from `daemon`, `desktop`, `contracts`, `db`, `harness`, `repo`, `ci`, `docs`, `deps`; lowercase subject; header at most 100 characters.
  - Run `pnpm format` first. A failing hook leaves the paths staged: fix the cause and rerun the same line. Never `--no-verify` or `LEFTHOOK=0`.
  - End every commit message with the attribution lines the session gives.
- **Generated files** are regenerated, never edited: `pnpm --filter @10db/contracts generate` after a contracts change; commit the output with its source.
- **Contracts are additive.** New files and new registry entries only.
- **No db schema change.** If a task seems to need one, stop and report: the delivery work is changing the schema in parallel, and the baseline is regenerated (decision 67), so two schema changes must be sequenced by hand.
- **Pins:** for each new npm dependency run `pnpm view <pkg> time --json` and pin the latest stable release at least 24 hours old (`pnpm-workspace.yaml` sets `minimumReleaseAge: 1440`). When this plan was written that was `@dnd-kit/core` 6.3.1, `@dnd-kit/sortable` 10.0.0 and `@dnd-kit/utilities` 3.2.2.
- **The UI reaches the daemon only through the `hc<AppType>` client** and parses every response with its contracts schema via `readJson` (`apps/desktop/AGENTS.md`). Server state lives in TanStack Query; the event stream invalidates by entity type (`INVALIDATIONS`). Don't poll.
- **Mantine components and theme tokens only** (`DESIGN.md`): `size="sm"` in lists, `md` in forms and dialogs, teal primary, sentence-case copy that says what happened and what to do next. Every view works in dark and light.
- **The React Compiler is on:** no hand-written `useMemo` or `useCallback` for render performance.
- **No `as` casts, no `!`, no `any`** except at a validated boundary with a comment. Exhaustive switches over `BoardStatus` and `SettingsSectionKey`.
- **Untrusted text is data:** task titles, descriptions, areas and plan reasons render as text, never Markdown or HTML.
- **Accessibility:** every drag has the card-menu alternative; every control has a name; axe runs over every view in dark and light in the e2e test.
- **Tests:**
  - Red first (`.claude/rules/testing.md`). Table-driven for `planMove`, `groupByColumn`, `moveTask`, the picker, `checkGeneral` and the sheet's selection rules.
  - Real SQLite in a temp directory for `packages/db` and the daemon. MSW for the UI, never a real daemon.
  - jsdom has no layout, so dnd-kit's pointer and keyboard sensors can't move a card there. UI tests drive moves through the card menu, which calls the same mutation; the e2e test drives a real keyboard drag in WebKit.
  - Never pipe test output through `tail` or append `; echo $?`.
- **Comments never carry decision or task numbers.** They say the why in words, or cite the spec (`spec §5.2.1`).

## Review Focus

These are the six inputs or conditions most likely to bite a person, each with the task that pins it:
1. **The board changed under a drag.**
   - Case: the event stream reorders or finishes a task while the builder drags, so the neighbours the UI sends are in the wrong order, or one moved to another project's view.
   - The daemon answers 409 ("The board changed while you were dragging; try again") and writes nothing. The UI rolls the optimistic order back, shows the message and refetches.
   - Tests: Task 2 (`answers a conflict for neighbours in the wrong order`), Task 5 (`rolls the order back and says why when the daemon refuses a move`).
2. **Many moves into the same gap.**
   - Case: the builder keeps dropping cards between the same two tasks; halving the gap 50 times exhausts a double's precision and two tasks would share an order.
   - Under a 1e-6 gap the project renumbers 1…n first, keeps the visible order, and the move lands between its neighbours.
   - Tests: Task 2 (`renumbers the project when the gap is too small, keeping the order`).
3. **A drop that isn't a move.**
   - Case: the card is dropped on itself, outside every card, or (with a pointer) over another column.
   - Nothing is sent. A card never changes column by a drop.
   - Tests: Task 5 (`planMove` rows: same index, unknown card; `dropTarget` rows: no target, a target outside the column).
4. **A keyboard-only or switch user.**
   - Every reorder is reachable from the card menu, the drag handle has a name and works with Space and the arrow keys, and the menu disables moves that do nothing.
   - Tests: Task 5 (`moves a card to the top from its menu`, `disables Move up on the first card`), Task 8 (e2e keyboard drag).
5. **A Settings save the daemon refuses, or a project that changes while its form is open.**
   - Case: the nudge at or below the handoff, an empty name or gate command, a negative ceiling, an empty number field; or the event stream updates the project mid-edit.
   - Client checks block the save with the field's message and send nothing; a daemon refusal shows its message; "Nothing to change" when no field differs. The form keeps the builder's edits until saved or reset, and switching project resets it.
   - Tests: Task 7 (`checkGeneral` table, `shows the daemon's message when it refuses the change`).
6. **Nothing can start, or the start fails.**
   - Case: no Ready tasks; every candidate collides with running work; a candidate's plan is over budget or has no flow; the batch route answers 400 or 409.
   - The sheet names each left-out task's reason, disables Start with the reason when a ticked task can't run, sends nothing when nothing is ticked, and shows the daemon's message on failure with nothing marked started.
   - Tests: Task 10 (picker rows), Task 12 (`startBlockers` table, `shows why nothing can start`, `shows the daemon's message when the batch is refused`).

---

## File Structure

```
packages/contracts/src/
  board.ts             TaskMove                                                       (Task 1)
  picker.ts            PICK_MAX, PickSize, PickerClaim, PickerCandidate, PickerProposalDto  (Task 9)
  index.ts  json-schema.ts                                                            (Tasks 1, 9)
packages/contracts/generated/   task-move.schema.json, picker-proposal-dto.schema.json (generated)
packages/db/src/store/tasks.ts  (+ moveTask, private renumberBoard)                   (Task 2)
apps/daemon/src/
  api/app.ts api/services.ts api/app.test.ts daemon/services.ts daemon/start.test.ts  (Tasks 3, 11)
  picker/              pick.ts pick.test.ts index.ts                                  (Task 10)
  team/                candidates.ts candidates.test.ts index.ts                      (Task 11)
apps/desktop/src/
  router.tsx  shell/app-layout.tsx                                                    (Tasks 4, 6)
  shell/selected-project.ts  shell/project-picker.tsx (moved)  shell/keep-awake-labels.ts
  daemon/queries.ts  daemon/events.ts                                                 (Tasks 7, 12)
  views/board/         (renamed from views/tasks)
    board-view.tsx board-view.test.tsx board-columns.ts board-columns.test.ts
    board-column.tsx task-card.tsx task-card-menu.tsx reorder.ts reorder.test.ts
    use-move-task.ts sortable-column.tsx
    areas-text.ts areas-text.test.ts board-status-badge.tsx new-project-form.tsx new-task-form.tsx
    batch/ batch-sheet.tsx batch-candidate.tsx batch-steps.tsx batch-selection.ts
           batch-selection.test.ts batch-sheet.test.tsx                               (Task 12)
  views/settings/
    sections.ts sections.test.ts settings-view.tsx settings-nav.tsx section-body.tsx
    planned-section.tsx project-areas.tsx project-billing.tsx keep-awake-section.tsx
    project-general-form.tsx general-values.ts general-values.test.ts settings-view.test.tsx
  test/fixtures.ts     (+ stepDto, candidate, flowDto, batchDto)                       (Task 12)
apps/desktop/e2e/loop.spec.ts                                                         (Tasks 8, 13)
apps/desktop/package.json  pnpm-lock.yaml                                             (Task 5)
docs/architecture/decisions.md  docs/open-items.md  apps/desktop/AGENTS.md  apps/daemon/AGENTS.md  DESIGN.md
```

---

# Part A: the board and Settings

### Task 1: The `TaskMove` contract

**Files:**
- Create: `packages/contracts/src/board.ts`, `packages/contracts/src/board.test.ts`
- Modify: `packages/contracts/src/index.ts`, `packages/contracts/src/json-schema.ts`
- Generated: `packages/contracts/generated/task-move.schema.json`

**Interfaces:**
- Consumes: `TaskId` from `./ids`.
- Produces: `TaskMove` (schema and type): `{ after: TaskId | null; before: TaskId | null }`, at least one non-null, and `after !== before`. "After" is the task that will sit directly above the moved one in its column, "before" the one directly below. Used by Tasks 2, 3 and 5.

- [ ] **Step 1: Write the failing test**

`packages/contracts/src/board.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TaskMove } from './board';
import { mintId } from './ids';

const a = mintId('Task');
const b = mintId('Task');

describe('TaskMove', () => {
  it.each([
    { name: 'between two tasks', value: { after: a, before: b }, ok: true },
    { name: 'to the top of a column', value: { after: null, before: a }, ok: true },
    { name: 'to the bottom of a column', value: { after: a, before: null }, ok: true },
    { name: 'with no neighbour', value: { after: null, before: null }, ok: false },
    { name: 'between a task and itself', value: { after: a, before: a }, ok: false },
    { name: 'with a malformed id', value: { after: 'tsk_nope', before: null }, ok: false },
    { name: 'with a missing key', value: { after: a }, ok: false },
  ])('parses a move $name: $ok', ({ value, ok }) => {
    expect(TaskMove.safeParse(value).success).toBe(ok);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @10db/contracts exec vitest run src/board.test.ts`
Expected: FAIL, `Cannot find module './board'`.

- [ ] **Step 3: Write the schema**

`packages/contracts/src/board.ts`:

```ts
import { z } from 'zod';
import { TaskId } from './ids';

/**
 * Where a dragged task lands in its column: directly below `after` and directly above `before`.
 * The daemon computes the stored order from the neighbours, so a client never writes one.
 */
export const TaskMove = z
  .object({ after: TaskId.nullable(), before: TaskId.nullable() })
  .refine((m) => m.after !== null || m.before !== null, {
    message: 'Name a neighbour: after, before or both',
  })
  .refine((m) => m.after === null || m.after !== m.before, {
    message: 'after and before must be different tasks',
    path: ['before'],
  });
export type TaskMove = z.infer<typeof TaskMove>;
```

In `packages/contracts/src/index.ts`, add `export * from './board';` in alphabetical order (after `./benchmarks`). In `packages/contracts/src/json-schema.ts`, import `TaskMove` from `./board` and add `'task-move': TaskMove,` after `'task-patch': TaskPatch,`.

- [ ] **Step 4: Run the tests and regenerate**

Run: `pnpm --filter @10db/contracts exec vitest run && pnpm --filter @10db/contracts generate && git status --short packages/contracts/generated`
Expected: PASS, and one new file `packages/contracts/generated/task-move.schema.json`. No other generated file changes.

- [ ] **Step 5: Commit**

```bash
pnpm format && git add packages/contracts/src/board.ts packages/contracts/src/board.test.ts packages/contracts/src/index.ts packages/contracts/src/json-schema.ts packages/contracts/generated/task-move.schema.json && git commit -m 'feat(contracts): add the task move contract for board reordering'
```

---

### Task 2: `moveTask` in the store

**Files:**
- Modify: `packages/db/src/store/tasks.ts`
- Test: `packages/db/src/store/board-order.test.ts` (new)

**Interfaces:**
- Consumes: `TaskMove` (Task 1); `WriteContext`, `getTask`, `listTasks`, `EventType.TaskChanged`.
- Produces: `moveTask(ctx: WriteContext, id: TaskId, move: TaskMove): TaskDto`. Throws `NotFoundError` for an unknown task or neighbour, `InvalidError` for a neighbour in another project or the task itself, `ConflictError` for neighbours in the wrong order. Emits `task.changed` with `data: { boardOrder }` for the moved task, and one per task a renumbering changed. Used by Task 3.

- [ ] **Step 1: Write the failing tests**

`packages/db/src/store/board-order.test.ts`:

```ts
import {
  ConflictError,
  EventType,
  InvalidError,
  mintId,
  NotFoundError,
  type ProjectDto,
  type TaskDto,
} from '@10db/contracts';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../schema';
import type { Store } from './store';
import { insertTask, listTasks, moveTask } from './tasks';
import { createTestStore, seedProject } from './test-support';

let store: Store;
let close: () => void;
let project: ProjectDto;
let tasks: Record<'a' | 'b' | 'c' | 'd', TaskDto>;
beforeEach(() => {
  ({ store, close } = createTestStore());
  project = seedProject(store);
  const add = (title: string) =>
    store.write((ctx) =>
      insertTask(ctx, project.id, { title, acceptanceCriteria: ['x'], areas: ['api'] }),
    ).value;
  // insertTask gives orders 1, 2, 3, 4.
  tasks = { a: add('a'), b: add('b'), c: add('c'), d: add('d') };
});
afterEach(() => {
  close();
});

const order = () => listTasks(store.db, project.id).map((t) => t.title);
const id = (key: keyof typeof tasks | null) => (key === null ? null : tasks[key].id);

describe('moveTask', () => {
  it.each([
    { name: 'between two tasks', task: 'd', after: 'a', before: 'b', expected: ['a', 'd', 'b', 'c'] },
    { name: 'to the top', task: 'c', after: null, before: 'a', expected: ['c', 'a', 'b', 'd'] },
    { name: 'to the bottom', task: 'a', after: 'd', before: null, expected: ['b', 'c', 'd', 'a'] },
    { name: 'down one place', task: 'b', after: 'c', before: 'd', expected: ['a', 'c', 'b', 'd'] },
    { name: 'to where it already is', task: 'b', after: 'a', before: 'c', expected: ['a', 'b', 'c', 'd'] },
  ] as const)('moves a task $name', ({ task, after, before, expected }) => {
    const moved = store.write((ctx) =>
      moveTask(ctx, tasks[task].id, { after: id(after), before: id(before) }),
    );
    expect(order()).toEqual(expected);
    expect(moved.value.id).toBe(tasks[task].id);
    expect(moved.events).toEqual([
      expect.objectContaining({
        type: EventType.TaskChanged,
        entityType: 'task',
        entityId: tasks[task].id,
        data: { boardOrder: moved.value.boardOrder },
      }),
    ]);
  });

  it('answers a conflict for neighbours in the wrong order, and writes nothing', () => {
    expect(() =>
      store.write((ctx) => moveTask(ctx, tasks.a.id, { after: tasks.d.id, before: tasks.b.id })),
    ).toThrow(ConflictError);
    expect(order()).toEqual(['a', 'b', 'c', 'd']);
  });

  it.each([
    { name: 'a neighbour in another project', error: InvalidError, other: true },
    { name: 'the task as its own neighbour', error: InvalidError, other: false },
  ])('refuses $name', ({ error, other }) => {
    const neighbour = other
      ? store.write((ctx) =>
          insertTask(ctx, seedProject(store).id, { title: 'x', acceptanceCriteria: ['x'], areas: ['api'] }),
        ).value.id
      : tasks.b.id;
    expect(() =>
      store.write((ctx) => moveTask(ctx, tasks.b.id, { after: neighbour, before: null })),
    ).toThrow(error);
  });

  it('answers not found for an unknown task or neighbour', () => {
    expect(() =>
      store.write((ctx) => moveTask(ctx, mintId('Task'), { after: tasks.a.id, before: null })),
    ).toThrow(NotFoundError);
    expect(() =>
      store.write((ctx) => moveTask(ctx, tasks.a.id, { after: mintId('Task'), before: null })),
    ).toThrow(NotFoundError);
  });

  it('renumbers the project when the gap is too small, keeping the order', () => {
    // Squeeze b right up against a, as fifty halvings would.
    store.db
      .update(schema.tasks)
      .set({ boardOrder: 1 + 1e-9 })
      .where(eq(schema.tasks.id, tasks.b.id))
      .run();
    const moved = store.write((ctx) =>
      moveTask(ctx, tasks.d.id, { after: tasks.a.id, before: tasks.b.id }),
    );
    expect(order()).toEqual(['a', 'd', 'b', 'c']);
    const orders = listTasks(store.db, project.id).map((t) => t.boardOrder);
    expect(new Set(orders).size).toBe(4);
    // Every task whose order changed announced it.
    expect(new Set(moved.events.map((e) => e.entityId))).toEqual(
      new Set([tasks.b.id, tasks.c.id, tasks.d.id]),
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @10db/db exec vitest run src/store/board-order.test.ts`
Expected: FAIL, `moveTask` is not exported from `./tasks`.

- [ ] **Step 3: Write `moveTask`**

In `packages/db/src/store/tasks.ts`, add `ConflictError` and `TaskMove` to the `@10db/contracts` import and `asc` to the `drizzle-orm` import, then add:

```ts
/** Below this gap between neighbours a midpoint loses precision, so the project is renumbered first. */
const MIN_ORDER_GAP = 1e-6;

function boardOrderOf(db: DbReader, id: TaskId): number {
  const row = db
    .select({ boardOrder: schema.tasks.boardOrder })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, id))
    .get();
  if (!row) throw new NotFoundError('task', id);
  return row.boardOrder;
}

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
    ctx.tx
      .update(schema.tasks)
      .set({ boardOrder, updatedAt: ctx.now })
      .where(eq(schema.tasks.id, row.id))
      .run();
    ctx.emit({ type: EventType.TaskChanged, entityType: 'task', entityId: row.id, data: { boardOrder } });
  });
}

/** Places a task between its new neighbours on the board (spec §10: drag and drop sets priority). */
export function moveTask(ctx: WriteContext, id: TaskId, move: TaskMove): TaskDto {
  const { after, before } = TaskMove.parse(move);
  const task = getTask(ctx.tx, id);
  for (const neighbour of [after, before]) {
    if (neighbour === null) continue;
    if (neighbour === id) throw new InvalidError('A task cannot be its own neighbour');
    if (getTask(ctx.tx, neighbour).projectId !== task.projectId)
      throw new InvalidError('Both neighbours must be tasks in the same project');
  }
  const neighbours = () => ({
    lo: after === null ? null : boardOrderOf(ctx.tx, after),
    hi: before === null ? null : boardOrderOf(ctx.tx, before),
  });
  const first = neighbours();
  if (first.lo !== null && first.hi !== null) {
    if (first.lo >= first.hi)
      throw new ConflictError('The board changed while you were dragging; try again');
    if (first.hi - first.lo < MIN_ORDER_GAP) renumberBoard(ctx, task.projectId);
  }
  const { lo, hi } = neighbours();
  const boardOrder =
    lo !== null && hi !== null ? (lo + hi) / 2 : lo !== null ? lo + 1 : hi !== null ? hi - 1 : task.boardOrder;
  ctx.tx
    .update(schema.tasks)
    .set({ boardOrder, updatedAt: ctx.now })
    .where(eq(schema.tasks.id, id))
    .run();
  ctx.emit({ type: EventType.TaskChanged, entityType: 'task', entityId: id, data: { boardOrder } });
  return getTask(ctx.tx, id);
}
```

The renumber case emits for the moved task twice when renumbering changed its order too (once from the renumber, once for the final position). That is correct: both are state changes. The renumber test asserts the set of entity IDs, not the count.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @10db/db exec vitest run && pnpm --filter @10db/db typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format && git add packages/db/src/store/tasks.ts packages/db/src/store/board-order.test.ts && git commit -m 'feat(db): move a task between neighbours on the board, renumbering when the gap runs out'
```

---

### Task 3: `POST /tasks/:taskId/move`

**Files:**
- Modify: `apps/daemon/src/api/app.ts`, `apps/daemon/src/api/services.ts`, `apps/daemon/src/daemon/services.ts`
- Test: `apps/daemon/src/api/app.test.ts`, `apps/daemon/src/daemon/start.test.ts`

**Interfaces:**
- Consumes: `TaskMove` (Task 1), `moveTask` (Task 2).
- Produces: `POST /tasks/:taskId/move`, body `TaskMove`, answers 200 `TaskDto`; 400 for a malformed body or ID, 404 for an unknown task, 409 for neighbours in the wrong order. `ApiServices.moveTask(id: TaskId, move: TaskMove): TaskDto`. The desktop calls it as `client.tasks[':taskId'].move.$post({ param: { taskId }, json: move })` (Task 5).

- [ ] **Step 1: Write the failing tests**

In `apps/daemon/src/api/app.test.ts`, add `moveTask: track('moveTask'),` to `stubServices`, then add to the `team, routing and benchmark routes` table (or a new `describe('board routes')` with the same shape):

```ts
describe('board routes', () => {
  const taskId = mintId('Task');
  it('routes POST /tasks/:id/move to its service', async () => {
    const res = await app().request(`/tasks/${taskId}/move`, {
      method: 'POST',
      ...json,
      body: JSON.stringify({ after: mintId('Task'), before: null }),
    });
    expect(res.status).toBe(500);
    expect(reached).toEqual(['moveTask']);
  });

  it.each([
    { name: 'no neighbour', body: { after: null, before: null }, path: `/tasks/${taskId}/move` },
    { name: 'a malformed neighbour', body: { after: 'x', before: null }, path: `/tasks/${taskId}/move` },
    { name: 'a malformed task id', body: { after: mintId('Task'), before: null }, path: '/tasks/nope/move' },
  ])('answers 400 for $name without calling the service', async ({ body, path }) => {
    const res = await app().request(path, { method: 'POST', ...json, body: JSON.stringify(body) });
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
    ).request(`/tasks/${taskId}/move`, {
      method: 'POST',
      ...json,
      body: JSON.stringify({ after: mintId('Task'), before: mintId('Task') }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ message: 'The board changed while you were dragging; try again' });
  });
});
```

(`json` is the existing helper with the auth and content-type headers; if the file names it differently, use that name.)

In `apps/daemon/src/daemon/start.test.ts`, add a test against the real daemon:

```ts
  it('moves a task on the board and persists the order', async () => {
    const repo = createTempRepo();
    try {
      daemon = await startDaemon({ dataDir: dir.path, port: 0, adapter: new FakeAdapter({}), logLevel: 'warn', ...QUIET });
      const api = apiClient(daemon.url, daemon.token);
      const project = await api.post('/projects', ProjectDto, {
        name: 'demo',
        repoPath: repo.path,
        gateCommand: 'true',
        areas: [{ name: 'src', globs: ['src/**'] }],
      });
      const add = (title: string) =>
        api.post(`/projects/${project.id}/tasks`, TaskDto, { title, acceptanceCriteria: ['x'], areas: ['src'] });
      const first = await add('first');
      const second = await add('second');
      await api.post(`/tasks/${second.id}/move`, TaskDto, { after: null, before: first.id });
      const titles = (await api.get(`/projects/${project.id}/tasks`, z.array(TaskDto))).map((t) => t.title);
      expect(titles).toEqual(['second', 'first']);
      await expect(
        api.post(`/tasks/${first.id}/move`, TaskDto, { after: first.id, before: null }),
      ).rejects.toThrow('-> 400');
    } finally {
      repo.cleanup();
    }
  });
```

Import `ProjectDto` and `TaskDto` from `@10db/contracts` there if they aren't imported yet.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @10db/daemon exec vitest run src/api/app.test.ts src/daemon/start.test.ts`
Expected: FAIL: typecheck error on `moveTask` in the stub, then 404s for the new path.

- [ ] **Step 3: Add the service and the route**

In `apps/daemon/src/api/services.ts`, import `TaskMove` (type) and add:

```ts
  /** Places a task between new neighbours; throws ConflictError when they are out of order. */
  moveTask(id: TaskId, move: TaskMove): TaskDto;
```

In `apps/daemon/src/daemon/services.ts`, import `moveTask` from `@10db/db` and add:

```ts
    moveTask: (id, move) => deps.state.write((ctx) => moveTask(ctx, id, move)),
```

In `apps/daemon/src/api/app.ts`, import `TaskMove` and chain after the `PATCH /tasks/:taskId` route:

```ts
    .post(
      '/tasks/:taskId/move',
      validator('json', (value): TaskMove => TaskMove.parse(value)),
      (c) => c.json(deps.services.moveTask(TaskId.parse(c.req.param('taskId')), c.req.valid('json'))),
    )
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @10db/daemon exec vitest run && pnpm -r typecheck`
Expected: PASS; the desktop typechecks against the new `AppType`.

- [ ] **Step 5: Commit**

```bash
pnpm format && git add apps/daemon/src/api/app.ts apps/daemon/src/api/services.ts apps/daemon/src/api/app.test.ts apps/daemon/src/daemon/services.ts apps/daemon/src/daemon/start.test.ts && git commit -m 'feat(daemon): serve post /tasks/:taskId/move for board reordering'
```

---

### Task 4: The board replaces the Tasks view

The board with its five columns and cards, the project and task forms, and each card's Start. No drag and drop yet (Task 5).

**Files:**
- Rename: `apps/desktop/src/views/tasks/` → `apps/desktop/src/views/board/` (`git mv`), then `tasks-view.tsx` → `board-view.tsx` and `tasks-view.test.tsx` → `board-view.test.tsx`
- Move: `apps/desktop/src/views/board/project-picker.tsx` → `apps/desktop/src/shell/project-picker.tsx`
- Create: `apps/desktop/src/shell/selected-project.ts`, `apps/desktop/src/views/board/board-columns.ts`, `board-columns.test.ts`, `board-column.tsx`, `task-card.tsx`, `task-card-menu.tsx`
- Modify: `apps/desktop/src/router.tsx`, `apps/desktop/src/shell/app-layout.tsx`, `apps/desktop/e2e/loop.spec.ts` (only the view name and the start, so the gate stays green; Task 8 extends it)

**Interfaces:**
- Consumes: `TaskDto.boardStatus`, `.boardOrder`, `.dependsOn`, `.workstreamId`; `useProjects`, `useTasks`, `useWorkstreams`, `useStartTask`; `StateBadge`, `StepCell`.
- Produces:
  - `useSelectedProject(): { projects: UseQueryResult<ProjectDto[]>; project: ProjectDto | null; select(id: ProjectId | null): void }` in `shell/selected-project.ts`, remembering the choice under the existing `tendb.project` key. Used by the board (Task 4) and Settings (Task 6).
  - `BOARD_COLUMNS: readonly BoardStatus[]` (display order) and `groupByColumn(tasks: readonly TaskDto[]): Record<BoardStatus, TaskDto[]>`, `DONE_LIMIT = 20`, in `board-columns.ts`.
  - `BoardColumn({ status, tasks, children })` renders a titled list `<ul aria-label="{label} tasks">`; `TaskCard({ task, column, workstream, titles, menu })` renders one `<li>`; `TaskCardMenu` renders the card's action menu, named `Actions for {title}`. Task 5 adds the drag handle and the move items; Task 12 removes Start.
  - Route `/board`; `/tasks` redirects to `/board`; nav: Board, Factory, Inbox (Settings is added by Task 6).

- [ ] **Step 1: Write the failing tests**

`apps/desktop/src/views/board/board-columns.test.ts`:

```ts
import { BoardStatus } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { taskDto } from '../../test/fixtures';
import { BOARD_COLUMNS, DONE_LIMIT, groupByColumn } from './board-columns';

const at = (minute: number) => `2026-10-13T12:${String(minute).padStart(2, '0')}:00.000Z`;

describe('groupByColumn', () => {
  it('lists the columns in the spec’s order', () => {
    expect(BOARD_COLUMNS).toEqual(['backlog', 'ready', 'in_progress', 'blocked', 'done']);
  });

  it.each([
    {
      name: 'each task in its board status, keeping board order',
      tasks: [
        taskDto({ title: 'r2', boardStatus: 'ready', boardOrder: 2 }),
        taskDto({ title: 'b1', boardStatus: 'backlog', boardOrder: 1 }),
        taskDto({ title: 'r1', boardStatus: 'ready', boardOrder: 0.5 }),
        taskDto({ title: 'x', boardStatus: 'blocked', boardOrder: 3 }),
      ],
      expected: { backlog: ['b1'], ready: ['r1', 'r2'], in_progress: [], blocked: ['x'], done: [] },
    },
    {
      name: 'done tasks most recently finished first',
      tasks: [
        taskDto({ title: 'old', boardStatus: 'done', boardOrder: 1, updatedAt: at(1) }),
        taskDto({ title: 'new', boardStatus: 'done', boardOrder: 2, updatedAt: at(9) }),
      ],
      expected: { backlog: [], ready: [], in_progress: [], blocked: [], done: ['new', 'old'] },
    },
    {
      name: 'nothing when there are no tasks',
      tasks: [],
      expected: { backlog: [], ready: [], in_progress: [], blocked: [], done: [] },
    },
  ])('puts $name', ({ tasks, expected }) => {
    const columns = groupByColumn(tasks);
    for (const status of Object.values(BoardStatus))
      expect(columns[status].map((t) => t.title)).toEqual(expected[status]);
  });

  it('keeps the done limit at 20', () => {
    expect(DONE_LIMIT).toBe(20);
  });
});
```

`board-view.test.tsx` (the renamed `tasks-view.test.tsx`): rename the `describe` to `BoardView`, replace every `renderApp('/tasks')` with `renderApp('/board')`, and change the three tests that find a task row:
- `starts a ready task`: find the card instead of the row, and start it from its menu:

```tsx
    const ready = await screen.findByRole('list', { name: 'Ready tasks' });
    const card = within(ready).getByRole('listitem', { name: 'Alpha' });
    fireEvent.click(within(card).getByRole('button', { name: 'Actions for Alpha' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Start' }));
```

- the `it.each` over workstream states: find the card with `screen.findByRole('listitem', { name: 'Busy' })`, open its menu, and assert `screen.queryByRole('menuitem', { name: 'Start' }) !== null` equals `startable`. Close the menu with `fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })` after the assertion.
- `creates a task …`: the last line becomes `expect(await screen.findByRole('listitem', { name: 'Beta' })).toBeTruthy();`.

Then add:

```tsx
  it('shows each task in its column with its areas, waits and live state', async () => {
    const project = projectDto();
    const ws = workstreamDto({ projectId: project.id, taskTitle: 'Base', state: 'RUNNING' });
    const running = taskDto({
      id: ws.taskId,
      projectId: project.id,
      title: 'Base',
      boardStatus: 'in_progress',
      boardOrder: 1,
      workstreamId: ws.id,
    });
    const next = taskDto({
      projectId: project.id,
      title: 'Next',
      boardStatus: 'backlog',
      boardOrder: 2,
      areas: ['api', 'ui'],
      dependsOn: [running.id],
    });
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([running, next])),
      http.get(daemonUrl('/workstreams'), () => HttpResponse.json([ws])),
    );
    renderApp('/board');

    const inProgress = await screen.findByRole('list', { name: 'In progress tasks' });
    const runningCard = within(inProgress).getByRole('listitem', { name: 'Base' });
    expect(await within(runningCard).findByText('Running')).toBeTruthy();
    const backlog = screen.getByRole('list', { name: 'Backlog tasks' });
    const nextCard = within(backlog).getByRole('listitem', { name: 'Next' });
    expect(within(nextCard).getByText('api')).toBeTruthy();
    expect(within(nextCard).getByText('ui')).toBeTruthy();
    expect(within(nextCard).getByText('Waits on Base')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Done tasks' })).toBeTruthy();
  });

  it('shows the 20 most recent done tasks and the rest on request', async () => {
    const project = projectDto();
    const done = Array.from({ length: 22 }, (_, i) =>
      taskDto({
        projectId: project.id,
        title: `Done ${String(i)}`,
        boardStatus: 'done',
        status: 'done',
        boardOrder: i,
        updatedAt: `2026-10-13T12:${String(i).padStart(2, '0')}:00.000Z`,
      }),
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

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @10db/desktop exec vitest run src/views/board`
Expected: FAIL: `./board-columns` doesn't exist and `/board` isn't a route.

- [ ] **Step 3: Move the files and extract the selected project**

```bash
git mv apps/desktop/src/views/tasks apps/desktop/src/views/board
git mv apps/desktop/src/views/board/tasks-view.tsx apps/desktop/src/views/board/board-view.tsx
git mv apps/desktop/src/views/board/tasks-view.test.tsx apps/desktop/src/views/board/board-view.test.tsx
git mv apps/desktop/src/views/board/project-picker.tsx apps/desktop/src/shell/project-picker.tsx
```

Fix `project-picker.tsx`'s import to `../daemon/queries`.

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

- [ ] **Step 4: Write the columns and the card**

`apps/desktop/src/views/board/board-columns.ts`:

```ts
import { BoardStatus, type TaskDto } from '@10db/contracts';

/** Spec §10's column order. */
export const BOARD_COLUMNS: readonly BoardStatus[] = [
  BoardStatus.Backlog,
  BoardStatus.Ready,
  BoardStatus.InProgress,
  BoardStatus.Blocked,
  BoardStatus.Done,
];

/** Done cards shown before "Show all"; the column only grows. */
export const DONE_LIMIT = 20;

/** Tasks by column: board order everywhere, except Done, which lists the most recently finished first. */
export function groupByColumn(tasks: readonly TaskDto[]): Record<BoardStatus, TaskDto[]> {
  const columns: Record<BoardStatus, TaskDto[]> = {
    [BoardStatus.Backlog]: [],
    [BoardStatus.Ready]: [],
    [BoardStatus.InProgress]: [],
    [BoardStatus.Blocked]: [],
    [BoardStatus.Done]: [],
  };
  for (const task of tasks) columns[task.boardStatus].push(task);
  for (const status of BOARD_COLUMNS) {
    if (status === BoardStatus.Done) columns[status].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    else columns[status].sort((a, b) => a.boardOrder - b.boardOrder);
  }
  return columns;
}
```

In `board-status-badge.tsx`, export the existing label map as `BOARD_STATUS` (`label` and `color` per status), so the column header and the badge share it.

`apps/desktop/src/views/board/board-column.tsx`:

```tsx
import type { BoardStatus } from '@10db/contracts';
import { Badge, Group, Paper, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { BOARD_STATUS } from './board-status-badge';

export interface BoardColumnProps {
  readonly status: BoardStatus;
  readonly count: number;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}

/** One column: a titled list whose items are task cards. */
export function BoardColumn({ status, count, children, footer }: BoardColumnProps) {
  const { label } = BOARD_STATUS[status];
  return (
    <Paper withBorder radius="md" p="xs" miw={220}>
      <Stack gap="xs">
        <Group justify="space-between">
          <Text fw={600} size="sm">{label}</Text>
          <Badge size="sm" variant="light" color="gray">{count}</Badge>
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

`apps/desktop/src/views/board/task-card-menu.tsx` (Start moves here from the old table row; `canStart` keeps its rules):

```tsx
import { BoardStatus, TaskStatus, WorkstreamState, type TaskDto } from '@10db/contracts';
import { ActionIcon, Menu } from '@mantine/core';
import { IconDots } from '@tabler/icons-react';

const STARTABLE: readonly BoardStatus[] = [BoardStatus.Ready, BoardStatus.Backlog];
/** A task whose latest workstream ended without finishing can run again. */
const RESTARTABLE: readonly WorkstreamState[] = [WorkstreamState.Failed, WorkstreamState.Cancelled];

export function canStart(task: TaskDto, latest: WorkstreamState | undefined): boolean {
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
  readonly workstream: WorkstreamDto | undefined;
  /** Titles and statuses of the project's tasks, for the dependency marker. */
  readonly peers: ReadonlyMap<TaskId, Pick<TaskDto, 'title' | 'status'>>;
  readonly menu: ReactNode;
  /** The drag handle, when the column is reorderable. */
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
            <Text size="sm" fw={500}>{task.title}</Text>
          </Group>
          {menu}
        </Group>
        <Group gap={4}>
          {task.areas.map((area) => (
            <Code key={area}>{area}</Code>
          ))}
          {task.status === TaskStatus.Cancelled ? <Badge size="xs" color="gray" variant="light">Cancelled</Badge> : null}
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

The `<li>` wrapper lives in the view (`<li aria-label={task.title}>…</li>`), so Task 5 can make it the sortable node.

- [ ] **Step 5: Write the view, the route and the nav**

`apps/desktop/src/views/board/board-view.tsx` keeps the old view's header, alerts, empty states and modals, with `useSelectedProject()` in place of the inline storage logic, `Title` "Board", and the table replaced by the columns:

```tsx
  const { projects, project, select } = useSelectedProject();
  const tasks = useTasks(project?.id ?? null);
  const workstreams = useWorkstreams({ active: false });
  const start = useStartTask();
  const [showAllDone, setShowAllDone] = useState(false);
  const byId = new Map((workstreams.data ?? []).map((ws) => [ws.id, ws]));
  const taskList = tasks.data ?? [];
  const peers = new Map(taskList.map((t) => [t.id, t]));
  const columns = groupByColumn(taskList);
  // …header, alerts, project line and modals as before…
      {project && tasks.isSuccess ? (
        <ScrollArea type="auto" offsetScrollbars>
          <Group align="flex-start" wrap="nowrap" gap="sm">
            {BOARD_COLUMNS.map((status) => {
              const all = columns[status];
              const shown = status === BoardStatus.Done && !showAllDone ? all.slice(0, DONE_LIMIT) : all;
              return (
                <BoardColumn
                  key={status}
                  status={status}
                  count={all.length}
                  footer={
                    shown.length < all.length ? (
                      <Button variant="subtle" size="xs" onClick={() => { setShowAllDone(true); }}>
                        {`Show all ${String(all.length)}`}
                      </Button>
                    ) : null
                  }
                >
                  {shown.map((task) => {
                    const ws = task.workstreamId ? byId.get(task.workstreamId) : undefined;
                    return (
                      <li key={task.id} aria-label={task.title}>
                        <TaskCard
                          task={task}
                          workstream={ws}
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

Keep the "No tasks yet." text when the project has no tasks, above the columns. `TaskCard` shows a workstream only while it is active or failed: pass `ws` only when `ws` is not `DONE` or `CANCELLED`, so a finished card doesn't repeat "Done".

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

In `apps/desktop/e2e/loop.spec.ts`, only what keeps the existing run green: `VIEWS = ['Board', 'Factory', 'Inbox']`, `page.goto('/board')`, the empty-state label `'board, empty, dark'`, and the start:

```ts
  const card = page.getByRole('listitem', { name: TASK });
  await card.getByRole('button', { name: `Actions for ${TASK}` }).click();
  await page.getByRole('menuitem', { name: 'Start' }).click();
```

and the later checks `await open(page, 'Board'); await expect(page.getByRole('list', { name: 'Done tasks' }).getByRole('listitem', { name: TASK })).toBeVisible();` in place of the row checks (after the reload too).

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @10db/desktop exec vitest run && pnpm --filter @10db/desktop typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
pnpm format && git add apps/desktop/src/views/board apps/desktop/src/views/tasks apps/desktop/src/shell/project-picker.tsx apps/desktop/src/shell/selected-project.ts apps/desktop/src/shell/app-layout.tsx apps/desktop/src/router.tsx apps/desktop/e2e/loop.spec.ts && git commit -m 'feat(desktop): replace the task list with a board of derived columns'
```

---

### Task 5: Reordering: the card menu, the mutation and drag and drop

**Files:**
- Create: `apps/desktop/src/views/board/reorder.ts`, `apps/desktop/src/views/board/reorder.test.ts`, `apps/desktop/src/views/board/use-move-task.ts`, `apps/desktop/src/views/board/sortable-column.tsx`
- Modify: `apps/desktop/package.json`, `pnpm-lock.yaml`, `apps/desktop/src/views/board/task-card-menu.tsx`, `apps/desktop/src/views/board/board-view.tsx`, `apps/desktop/src/views/board/board-view.test.tsx`

**Interfaces:**
- Consumes: `POST /tasks/:taskId/move` (Task 3), `TaskMove` (Task 1), `BoardColumn`, `TaskCard`, `TaskCardMenu`, `groupByColumn` (Task 4).
- Produces:
  - `planMove(column: readonly Pick<TaskDto, 'id' | 'boardOrder'>[], taskId: TaskId, toIndex: number): PlannedMove | null`, where `PlannedMove = { move: TaskMove; order: number }` (`order` is the client's estimate, used only for the optimistic sort).
  - `dropTarget(columnIds: readonly TaskId[], overId: string | null): number | null`: the index a drop lands on, or null when the drop is outside the column.
  - `reorderLocally(tasks: readonly TaskDto[], taskId: TaskId, order: number): TaskDto[]`.
  - `useMoveTask(projectId: ProjectId)` in `views/board/use-move-task.ts`: a mutation taking `{ taskId, move, order }` with an optimistic update and rollback. It lives beside the board, not in `daemon/queries.ts`, so `daemon/` never imports from a view.
  - `SortableColumn({ tasks, render })`: one dnd-kit context per reorderable column.
  - `TaskCardMenu` gains `position: { index: number; count: number } | null` and `onMove(toIndex: number)`.

- [ ] **Step 1: Add the dependencies**

```bash
pnpm view @dnd-kit/core time --json
pnpm view @dnd-kit/sortable time --json
pnpm view @dnd-kit/utilities time --json
pnpm --filter @10db/desktop add --save-exact @dnd-kit/core@<latest stable, ≥24h> @dnd-kit/sortable@<latest stable, ≥24h> @dnd-kit/utilities@<latest stable, ≥24h>
```

Use the versions the `time` output shows (6.3.1, 10.0.0 and 3.2.2 when this plan was written).

- [ ] **Step 2: Write the failing tests**

`apps/desktop/src/views/board/reorder.test.ts`:

```ts
import { mintId, type TaskId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { taskDto } from '../../test/fixtures';
import { dropTarget, planMove, reorderLocally } from './reorder';

const [a, b, c] = [mintId('Task'), mintId('Task'), mintId('Task')];
const column = [
  { id: a, boardOrder: 1 },
  { id: b, boardOrder: 2 },
  { id: c, boardOrder: 4 },
];

describe('planMove', () => {
  it.each([
    { name: 'the first card to the bottom', task: a, to: 2, expected: { move: { after: c, before: null }, order: 5 } },
    { name: 'the last card to the top', task: c, to: 0, expected: { move: { after: null, before: a }, order: 0 } },
    { name: 'the first card down one', task: a, to: 1, expected: { move: { after: b, before: c }, order: 3 } },
    { name: 'the last card up one', task: c, to: 1, expected: { move: { after: a, before: b }, order: 1.5 } },
    { name: 'a card past the end, clamped', task: a, to: 9, expected: { move: { after: c, before: null }, order: 5 } },
    { name: 'a card onto its own place', task: b, to: 1, expected: null },
    { name: 'a card that is not in the column', task: mintId('Task'), to: 0, expected: null },
  ])('plans $name', ({ task, to, expected }) => {
    expect(planMove(column, task, to)).toEqual(expected);
  });

  it('plans nothing in a column of one', () => {
    expect(planMove([{ id: a, boardOrder: 1 }], a, 0)).toBeNull();
  });
});

describe('dropTarget', () => {
  const ids: TaskId[] = [a, b, c];
  it.each([
    { name: 'a card in the column', over: b, expected: 1 },
    { name: 'no target', over: null, expected: null },
    { name: 'a card outside the column', over: mintId('Task'), expected: null },
  ])('answers $name', ({ over, expected }) => {
    expect(dropTarget(ids, over)).toBe(expected);
  });
});

describe('reorderLocally', () => {
  it('gives the task its new order and sorts by board order', () => {
    const tasks = [
      taskDto({ id: a, title: 'a', boardOrder: 1 }),
      taskDto({ id: b, title: 'b', boardOrder: 2 }),
    ];
    expect(reorderLocally(tasks, a, 3).map((t) => t.title)).toEqual(['b', 'a']);
    expect(tasks.map((t) => t.title)).toEqual(['a', 'b']);
  });
});
```

In `board-view.test.tsx`, add:

```tsx
  it('moves a card to the top from its menu, and disables moves that do nothing', async () => {
    const project = projectDto();
    let tasks = [
      taskDto({ projectId: project.id, title: 'One', boardStatus: 'ready', boardOrder: 1 }),
      taskDto({ projectId: project.id, title: 'Two', boardStatus: 'ready', boardOrder: 2 }),
    ];
    const moves: unknown[] = [];
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json(tasks)),
      http.post(daemonUrl('/tasks/:taskId/move'), async ({ request, params }) => {
        moves.push({ taskId: params['taskId'], body: await request.json() });
        const [one, two] = tasks;
        if (!one || !two) throw new Error('fixture');
        tasks = [{ ...two, boardOrder: 0 }, one];
        return HttpResponse.json(tasks[0]);
      }),
    );
    renderApp('/board');

    const ready = await screen.findByRole('list', { name: 'Ready tasks' });
    fireEvent.click(within(ready).getByRole('button', { name: 'Actions for One' }));
    // Mantine marks a disabled Menu.Item with data-disabled.
    expect((await screen.findByRole('menuitem', { name: 'Move up' })).hasAttribute('data-disabled')).toBe(true);
    expect(screen.getByRole('menuitem', { name: 'Move down' }).hasAttribute('data-disabled')).toBe(false);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    fireEvent.click(within(ready).getByRole('button', { name: 'Actions for Two' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to top' }));
    await waitFor(() => {
      expect(within(ready).getAllByRole('listitem').map((li) => li.getAttribute('aria-label'))).toEqual(['Two', 'One']);
    });
    expect(moves).toEqual([{ taskId: tasks[0]?.id, body: { after: null, before: tasks[1]?.id } }]);
  });

  it('rolls the order back and says why when the daemon refuses a move', async () => {
    const project = projectDto();
    const tasks = [
      taskDto({ projectId: project.id, title: 'One', boardStatus: 'ready', boardOrder: 1 }),
      taskDto({ projectId: project.id, title: 'Two', boardStatus: 'ready', boardOrder: 2 }),
    ];
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json(tasks)),
      http.post(daemonUrl('/tasks/:taskId/move'), () =>
        HttpResponse.json(
          { error: 'conflict', message: 'The board changed while you were dragging; try again' },
          { status: 409 },
        ),
      ),
    );
    renderApp('/board');

    const ready = await screen.findByRole('list', { name: 'Ready tasks' });
    fireEvent.click(within(ready).getByRole('button', { name: 'Actions for Two' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to top' }));
    expect(await screen.findByText('The board changed while you were dragging; try again')).toBeTruthy();
    expect(within(ready).getAllByRole('listitem').map((li) => li.getAttribute('aria-label'))).toEqual(['One', 'Two']);
  });

  it('offers no moves on a done card', async () => {
    const project = projectDto();
    const done = taskDto({ projectId: project.id, title: 'Shipped', boardStatus: 'done', status: 'done' });
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([done])),
    );
    renderApp('/board');

    const column = await screen.findByRole('list', { name: 'Done tasks' });
    expect(within(column).queryByRole('button', { name: 'Drag Shipped' })).toBeNull();
    fireEvent.click(within(column).getByRole('button', { name: 'Actions for Shipped' }));
    expect(await screen.findByRole('menu')).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Move to top' })).toBeNull();
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @10db/desktop exec vitest run src/views/board`
Expected: FAIL: `./reorder` doesn't exist; no `Move to top` item.

- [ ] **Step 4: Write the pure helpers**

`apps/desktop/src/views/board/reorder.ts`:

```ts
import type { TaskDto, TaskId, TaskMove } from '@10db/contracts';

export interface PlannedMove {
  readonly move: TaskMove;
  /** The client's estimate of the stored order, for the optimistic sort only; the daemon computes the real one. */
  readonly order: number;
}

/** The neighbours a card gets when it lands at `toIndex` of its column; null when nothing would change. */
export function planMove(
  column: readonly Pick<TaskDto, 'id' | 'boardOrder'>[],
  taskId: TaskId,
  toIndex: number,
): PlannedMove | null {
  const from = column.findIndex((t) => t.id === taskId);
  if (from < 0) return null;
  const to = Math.max(0, Math.min(toIndex, column.length - 1));
  if (from === to) return null;
  const rest = column.filter((t) => t.id !== taskId);
  const after = to > 0 ? rest[to - 1] : undefined;
  const before = rest[to];
  const order =
    after && before
      ? (after.boardOrder + before.boardOrder) / 2
      : after
        ? after.boardOrder + 1
        : before
          ? before.boardOrder - 1
          : 0;
  return { move: { after: after?.id ?? null, before: before?.id ?? null }, order };
}

/** Where a drop lands in its column; null for a drop outside every card of the column. */
export function dropTarget(columnIds: readonly TaskId[], overId: string | null): number | null {
  if (overId === null) return null;
  const index = columnIds.findIndex((id) => id === overId);
  return index < 0 ? null : index;
}

/** The task list with one task's order replaced, sorted as the daemon sorts it. */
export function reorderLocally(tasks: readonly TaskDto[], taskId: TaskId, order: number): TaskDto[] {
  return tasks
    .map((t) => (t.id === taskId ? { ...t, boardOrder: order } : t))
    .sort((x, y) => x.boardOrder - y.boardOrder);
}
```

- [ ] **Step 5: Write the mutation**

`apps/desktop/src/views/board/use-move-task.ts`:

```ts
import { TaskDto, type ProjectId, type TaskId, type TaskMove } from '@10db/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { readJson } from '../../daemon/client';
import { useDaemon } from '../../daemon/provider';
import { queryKeys } from '../../daemon/queries';
import { reorderLocally } from './reorder';

export interface MoveTaskInput {
  readonly taskId: TaskId;
  readonly move: TaskMove;
  readonly order: number;
}

/** Reorders a card at once and rolls back if the daemon refuses; the event stream brings the real order. */
export function useMoveTask(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  const key = queryKeys.tasks(projectId);
  return useMutation({
    mutationFn: async ({ taskId, move }: MoveTaskInput) =>
      readJson(await client.tasks[':taskId'].move.$post({ param: { taskId }, json: move }), TaskDto),
    onMutate: async ({ taskId, order }: MoveTaskInput) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<TaskDto[]>(key);
      if (previous) queryClient.setQueryData(key, reorderLocally(previous, taskId, order));
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['tasks'] }),
  });
}
```

- [ ] **Step 6: Add the menu items and the sortable column**

`TaskCardMenu` gains two props and four items:

```tsx
  /** The card's place in a reorderable column; null in Done. */
  readonly position: { readonly index: number; readonly count: number } | null;
  readonly onMove: (toIndex: number) => void;
// …inside Menu.Dropdown, before Start:
        {position ? (
          <>
            <Menu.Item disabled={position.index === 0} onClick={() => { onMove(0); }}>Move to top</Menu.Item>
            <Menu.Item disabled={position.index === 0} onClick={() => { onMove(position.index - 1); }}>Move up</Menu.Item>
            <Menu.Item disabled={position.index === position.count - 1} onClick={() => { onMove(position.index + 1); }}>Move down</Menu.Item>
            <Menu.Item disabled={position.index === position.count - 1} onClick={() => { onMove(position.count - 1); }}>Move to bottom</Menu.Item>
          </>
        ) : null}
```

`apps/desktop/src/views/board/sortable-column.tsx`:

```tsx
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { TaskDto, TaskId } from '@10db/contracts';
import { ActionIcon } from '@mantine/core';
import { IconGripVertical } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { dropTarget } from './reorder';

function SortableItem({ task, children }: { readonly task: TaskDto; readonly children: (handle: ReactNode) => ReactNode }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: task.id });
  const handle = (
    <ActionIcon
      ref={setActivatorNodeRef}
      variant="subtle"
      size="sm"
      aria-label={`Drag ${task.title}`}
      style={{ cursor: 'grab' }}
      {...attributes}
      {...listeners}
    >
      <IconGripVertical size={16} stroke={1.5} />
    </ActionIcon>
  );
  return (
    <li
      ref={setNodeRef}
      aria-label={task.title}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 }}
    >
      {children(handle)}
    </li>
  );
}

export interface SortableColumnProps {
  readonly tasks: readonly TaskDto[];
  readonly onDrop: (taskId: TaskId, toIndex: number) => void;
  readonly render: (task: TaskDto, handle: ReactNode) => ReactNode;
}

/**
 * One drag-and-drop area per column: a card can only be reordered inside its own column, because
 * columns follow the task's state (spec §5.1).
 */
export function SortableColumn({ tasks, onDrop, render }: SortableColumnProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = tasks.map((t) => t.id);
  function handleDragEnd({ active, over }: DragEndEvent) {
    const to = dropTarget(ids, over === null ? null : String(over.id));
    const taskId = ids.find((id) => id === String(active.id));
    if (to === null || taskId === undefined) return;
    onDrop(taskId, to);
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {tasks.map((task) => (
          <SortableItem key={task.id} task={task}>
            {(handle) => render(task, handle)}
          </SortableItem>
        ))}
      </SortableContext>
    </DndContext>
  );
}
```

dnd-kit's default screen-reader announcements and instructions stay on; they name the card by its ID, so pass `accessibility={{ announcements }}` to `DndContext` with announcements that use the task's title (`onDragStart`: `Picked up ${title}.`, `onDragOver`: `${title} is over position ${n} of ${count}.`, `onDragEnd`: `${title} was dropped at position ${n} of ${count}.`, `onDragCancel`: `Moving ${title} was cancelled.`), looking titles up from `tasks`.

In `board-view.tsx`, every column except Done renders through `SortableColumn`:

```tsx
  const move = useMoveTask(project.id); // inside a child component that has the project
  function moveTo(column: readonly TaskDto[], taskId: TaskId, toIndex: number) {
    const planned = planMove(column, taskId, toIndex);
    if (planned) move.mutate({ taskId, ...planned });
  }
```

Move the column rendering into a small `BoardColumns({ project, tasks, workstreams })` component inside `board-view.tsx` so the hook gets a non-null project. The Done column keeps Task 4's plain `<li>`s and passes `position={null}`. Show `move.error` above the columns as `<Alert color="red" title="Couldn't move the task">{move.error.message}</Alert>`.

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @10db/desktop exec vitest run && pnpm --filter @10db/desktop typecheck && pnpm lint && pnpm knip`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
pnpm format && git add apps/desktop/package.json pnpm-lock.yaml apps/desktop/src/views/board && git commit -m 'feat(desktop): reorder board cards by drag and drop or from the card menu'
```

---

### Task 6: The Settings shell

**Files:**
- Create: `apps/desktop/src/views/settings/sections.ts`, `sections.test.ts`, `settings-view.tsx`, `settings-nav.tsx`, `section-body.tsx`, `planned-section.tsx`, `project-areas.tsx`, `project-billing.tsx`, `keep-awake-section.tsx`, `settings-view.test.tsx`; `apps/desktop/src/shell/keep-awake-labels.ts`
- Modify: `apps/desktop/src/router.tsx`, `apps/desktop/src/shell/app-layout.tsx`, `apps/desktop/src/shell/keep-awake-control.tsx`

**Interfaces:**
- Consumes: `useSelectedProject`, `ProjectPicker` (Task 4); `useKeepAwake`, `useSetKeepAwake`; `formatAreas` (`views/board/areas-text.ts`).
- Produces:
  - `SettingsSectionKey` (`as const`): `general`, `areas`, `billing`, `team`, `routing-rules`, `keep-awake`, `accounts`, `models`, `personas-and-flows`.
  - `SettingsSection = { key; group: 'project' | 'app'; label: string; planned: string | null }`, `SETTINGS_SECTIONS`, `GENERAL_SECTION`, `isSettingsSectionKey(value: string): value is SettingsSectionKey`, `sectionByKey(key: SettingsSectionKey): SettingsSection`.
  - Routes `/settings` (redirects to `/settings/general`) and `/settings/$section` (an unknown section redirects to `general`). Nav entry Settings (`IconSettings`).
  - `SectionBody({ sectionKey, project })`, an exhaustive switch. Task 7 replaces the General arm's placeholder with the form; the accounts plan replaces the Accounts arm.

- [ ] **Step 1: Write the failing tests**

`apps/desktop/src/views/settings/sections.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isSettingsSectionKey, SETTINGS_SECTIONS, SettingsSectionKey } from './sections';

describe('settings sections', () => {
  it('lists every key once, project sections first', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.key)).toEqual([
      'general',
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
    for (const label of ['General', 'Areas and hazards', 'Billing', 'Team', 'Routing rules', 'Keep-awake', 'Accounts', 'Models and benchmarks', 'Personas and flows'])
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

The General arm's text is replaced by the form in Task 7, in the same PR; it is not shipped.

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

### Task 7: The project General form

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

### Task 8: Part A end to end, docs and the gate

**Files:**
- Modify: `apps/desktop/e2e/loop.spec.ts`, `docs/architecture/decisions.md`, `docs/open-items.md`, `apps/desktop/AGENTS.md`, `DESIGN.md`

**Interfaces:**
- Consumes: Tasks 1–7.

- [ ] **Step 1: Extend the end-to-end run**

In `apps/desktop/e2e/loop.spec.ts`:
- `VIEWS = ['Board', 'Factory', 'Inbox', 'Settings']`.
- Before creating `TASK`, create a second task, `Tidy the readme`, with the same single area, so the board has two Ready cards and `TASK` is second.
- Reorder with the keyboard, and check that it persisted:

```ts
  const ready = page.getByRole('list', { name: 'Ready tasks' });
  await expect(ready.getByRole('listitem')).toHaveCount(2);
  await expect(ready.getByRole('listitem').nth(0)).toHaveAccessibleName('Tidy the readme');
  await ready.getByRole('button', { name: `Drag ${TASK}` }).focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Space');
  await expect(ready.getByRole('listitem').nth(0)).toHaveAccessibleName(TASK);
  await page.reload();
  await expect(page.getByRole('list', { name: 'Ready tasks' }).getByRole('listitem').nth(0)).toHaveAccessibleName(TASK);
  await expectAccessible(page, 'board, two ready, dark');
```

- Start `TASK` from its card menu (Task 4's lines). `Tidy the readme` has no script and is never started.
- After the run, open Settings and visit a planned section:

```ts
  await open(page, 'Settings');
  await expectAccessible(page, 'settings, general, dark');
  await page.getByRole('link', { name: /Accounts/ }).click();
  await expect(page.getByText('Not built yet')).toBeVisible();
```

The light-mode loop at the end already visits every view in `VIEWS`.

- [ ] **Step 2: Record the decisions**

Append rows A1–A5 from this plan's "New decisions" table to `docs/architecture/decisions.md`, numbered with the next free numbers when this PR merges (if the delivery PR merges first, start after its rows). Text verbatim except the number.

- [ ] **Step 3: Update the open items and the agent docs**

In `docs/open-items.md`:
- Replace the M2b line ("M2b: the board, the picker and PM-agent review …") with:
  - `- [x] M2b: the board with drag and drop, and the Settings view with General, Areas and hazards, Billing and Keep-awake (plan 07, part A).`
  - `- [ ] M2b: the picker and the batch approval sheet (plan 07, part B), after the delivery spec's batch entity.`
  - `- [ ] M2: the PM-agent review (need estimates, optional steps), the Brainstorm panel, the consult step and ⌘K.`
  - `- [ ] M2: Settings editors for team bindings, routing rules, personas, flows and model profiles, the AA key field and the Intelligence-vs-Cost chart (Pareto line, axis picker, AA logo and source link); their sections are slots.`
  - `- [ ] M2: editing a project's areas and hazards (no patch route yet; Settings shows them read-only).`
- Replace "M2: Settings view (billing mode, thresholds, keep-awake) and the ⌘K palette." with "M2: the ⌘K palette." (Settings is built.)

In `apps/desktop/AGENTS.md`, add:
- `- The board (`views/board/`) shows the daemon's derived columns; drag and drop only reorders within a column through `POST /tasks/:taskId/move`, and every drag has a card-menu alternative. jsdom can't drive dnd-kit's sensors (no layout): unit tests move cards through the menu; `e2e/loop.spec.ts` drives a keyboard drag in WebKit.`
- `- Settings (`views/settings/`) is one route over `sections.ts`. To fill a planned section, set its `planned` to null and replace its arm in `section-body.tsx`.`

In `DESIGN.md`, add one line under Density: `Board cards are compact `Paper`s with a drag handle (Tabler grip-vertical) and an actions menu; columns scroll horizontally on narrow windows.`

- [ ] **Step 4: Run the gate**

Run: `make gate`
Expected: the last line starts `GATE PASS format lint typecheck test build e2e drift knip`.
- A `knip` failure names an unused export: remove it or use it.
- An `e2e` failure in the keyboard drag: confirm the handle has focus (`toBeFocused()`) before `Space`; dnd-kit's keyboard sensor starts on Space or Enter on the activator.

- [ ] **Step 5: Commit and open the PR**

```bash
pnpm format && git add apps/desktop/e2e/loop.spec.ts docs/architecture/decisions.md docs/open-items.md apps/desktop/AGENTS.md DESIGN.md && git commit -m 'docs(docs): record the board and settings decisions'
```

Push the branch and open a PR to `main` titled `feat(desktop): board with drag and drop and a settings view (m2b part a)`. Its body lists what Part A builds, the contracts and db additions (`TaskMove`, `moveTask`; no schema change), what waits for Part B, and the `GATE PASS` line.

---

# Part B: the picker and the batch approval sheet

Tasks 9–11 depend only on Part A and M2a and can be built at any time. Task 12 starts only once the delivery spec's batch contracts (`BatchInput`, `BatchDto`) and its create route are on `main`; before starting it, read the delivery plan and check its route against Open decision 5. Where they differ, follow the delivery plan, change only `useStartBatch`, its MSW handlers and the `batchDto` fixture, and say so in the task's report.

### Task 9: The picker proposal contract

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

### Task 10: The picker rules

A pure module, like `routing/`: it imports `@10db/contracts` only, and its caller passes the rows in.

**Files:**
- Create: `apps/daemon/src/picker/pick.ts`, `apps/daemon/src/picker/pick.test.ts`, `apps/daemon/src/picker/index.ts`

**Interfaces:**
- Consumes: `BoardStatus`, `TaskStatus`, `TaskDto` fields.
- Produces:
  - `PickerTask = Pick<TaskDto, 'id' | 'title' | 'areas' | 'dependsOn' | 'status' | 'boardStatus' | 'boardOrder' | 'workstreamId'>`.
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
  'id' | 'title' | 'areas' | 'dependsOn' | 'status' | 'boardStatus' | 'boardOrder' | 'workstreamId'
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
    .filter((t) => t.boardStatus === BoardStatus.Ready)
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
Expected: PASS. (knip may flag `picker/index.ts` until Task 11 imports it; run knip after Task 11.)

- [ ] **Step 5: Commit**

```bash
pnpm format && git add apps/daemon/src/picker && git commit -m 'feat(daemon): add the picker rules that order and filter ready tasks'
```

---

### Task 11: `GET /projects/:projectId/candidates`

**Files:**
- Create: `apps/daemon/src/team/candidates.ts`, `apps/daemon/src/team/candidates.test.ts`
- Modify: `apps/daemon/src/team/index.ts`, `apps/daemon/src/api/app.ts`, `apps/daemon/src/api/services.ts`, `apps/daemon/src/daemon/services.ts`, `apps/daemon/src/api/app.test.ts`, `apps/daemon/src/daemon/start.test.ts`

**Interfaces:**
- Consumes: `pickCandidates` (Task 10), `PickerProposalDto`, `PickSize` (Task 9), `resolveStepPlan` (M2a), and from `@10db/db`: `getProject`, `getTask`, `listTasks`, `listWorkstreams`, `activeClaims`, `claimRequestsForTask`.
- Produces:
  - `proposeCandidates(db: DbReader, projectId: ProjectId, size: number): PickerProposalDto` in `team/candidates.ts`, exported from `team/index.ts`.
  - `GET /projects/:projectId/candidates?size=N` answers 200 `PickerProposalDto`; 400 for a missing or out-of-range size; 404 for an unknown project. `ApiServices.proposeCandidates(projectId: ProjectId, size: number): PickerProposalDto`.
  - The desktop calls it as `client.projects[':projectId'].candidates.$get({ param: { projectId }, query: { size: String(size) } })` (Task 12).

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/team/candidates.test.ts`:

```ts
import { mintId, NotFoundError } from '@10db/contracts';
import { createTestStore, insertTask, patchProject, seedProject } from '@10db/db';
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

### Task 12: The batch approval sheet

**Blocked until** the delivery spec's `BatchInput`, `BatchDto` and `POST /projects/:projectId/batches` are on `main` (Open decision 5).

**Files:**
- Create: `apps/desktop/src/views/board/batch/batch-selection.ts`, `batch-selection.test.ts`, `batch-steps.tsx`, `batch-candidate.tsx`, `batch-sheet.tsx`, `batch-sheet.test.tsx`
- Modify: `apps/desktop/src/daemon/queries.ts`, `apps/desktop/src/daemon/events.ts`, `apps/desktop/src/test/fixtures.ts`, `apps/desktop/src/views/board/board-view.tsx`, `apps/desktop/src/views/board/task-card-menu.tsx`, `apps/desktop/src/views/board/board-view.test.tsx`

**Interfaces:**
- Consumes: `GET /projects/:projectId/candidates` (Task 11), `PickerProposalDto`, `PickerCandidate`, `PICK_MAX` (Task 9), `PATCH /tasks/:taskId` (M2a), `useFlows` (Task 7), and from the delivery spec `BatchDto` and `POST /projects/:projectId/batches`.
- Produces:
  - `initialSelection(proposal): ReadonlySet<TaskId>`, `toggle(selection, id): ReadonlySet<TaskId>`, `orderedSelection(proposal, selection): TaskId[]`, `startBlockers(proposal, selection): string[]` in `batch-selection.ts`.
  - `useCandidates(projectId, size, enabled)`, `usePatchTask()`, `useStartBatch(projectId)` and `queryKeys.candidates(projectId, size)` in `daemon/queries.ts`.
  - `BatchSheet({ project, opened, onClose })`, opened by the board's `Start N` button.
  - The card menu loses Start (`canStart` is deleted with it).

- [ ] **Step 1: Write the failing tests**

Add fixtures to `apps/desktop/src/test/fixtures.ts` (import `FlowDto`, `PickerCandidate`, `WorkstreamStep` and the delivery spec's `BatchDto`):

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

Add `batchDto(overrides)`, which parses with the delivery spec's `BatchDto` and fills its required fields with schema-valid values; the tests below assert only on what the UI sent.

`apps/desktop/src/views/board/batch/batch-selection.test.ts`:

```ts
import { PickerProposalDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { candidate, projectDto, taskDto } from '../../../test/fixtures';
import { initialSelection, orderedSelection, startBlockers, toggle } from './batch-selection';

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
    candidate(three, {
      proposed: false,
      plan: { flowName: 'standard', steps: [], overBudget: [0] },
      conflict: 'Over the budget ceiling: step 1 (implement)',
    }),
  ],
});

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
    { name: 'nothing ticked', ticked: [], blockers: ['Tick at least one task'] },
    { name: 'a proposed task', ticked: [one.id], blockers: [] },
    { name: 'a task sharing an area (it waits its turn)', ticked: [one.id, two.id], blockers: [] },
    { name: 'an over-budget task', ticked: [three.id], blockers: ['Three is over the budget ceiling'] },
  ])('answers the blockers for $name', ({ ticked, blockers }) => {
    expect(startBlockers(proposal, new Set(ticked))).toEqual(blockers);
  });

  it('names a task whose plan failed', () => {
    const failed = PickerProposalDto.parse({
      projectId: project.id,
      size: 1,
      candidates: [candidate(one, { plan: null, planError: 'The standard flow is missing; restart 10db to seed it' })],
    });
    expect(startBlockers(failed, new Set([one.id]))).toEqual([
      'One: The standard flow is missing; restart 10db to seed it',
    ]);
  });
});
```

`apps/desktop/src/views/board/batch/batch-sheet.test.tsx`:

```tsx
import { PickerProposalDto, type TaskDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse, type RequestHandler } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../../test/daemon';
import { batchDto, candidate, flowDto, projectDto, taskDto } from '../../../test/fixtures';

const project = projectDto({ maxLanes: 2, gateCommand: 'make gate' });
const one = taskDto({ projectId: project.id, title: 'One', boardStatus: 'ready', boardOrder: 1 });
const two = taskDto({ projectId: project.id, title: 'Two', boardStatus: 'ready', boardOrder: 2 });

function serve(proposal: (size: number) => PickerProposalDto, tasks: TaskDto[], ...overrides: RequestHandler[]) {
  server.use(
    ...overrides,
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json(tasks)),
    http.get(daemonUrl('/flows'), () => HttpResponse.json([])),
    http.get(daemonUrl('/projects/:projectId/candidates'), ({ request }) =>
      HttpResponse.json(proposal(Number(new URL(request.url).searchParams.get('size')))),
    ),
    ...baseHandlers(),
  );
}

async function openSheet() {
  renderApp('/board');
  fireEvent.click(await screen.findByRole('button', { name: 'Start N' }));
  return screen.findByRole('dialog', { name: 'Start a batch' });
}

const twoCandidates = (size: number) =>
  PickerProposalDto.parse({
    projectId: project.id,
    size,
    candidates: [
      candidate(one),
      candidate(two, { proposed: false, conflict: 'Area src is shared with One, picked before it' }),
    ],
  });

describe('BatchSheet', () => {
  it('shows the proposal at the lane cap and starts the ticked tasks in order', async () => {
    const sizes: number[] = [];
    const posted: unknown[] = [];
    serve(
      (size) => {
        sizes.push(size);
        return twoCandidates(size);
      },
      [one, two],
      http.post(daemonUrl('/projects/:projectId/batches'), async ({ request }) => {
        posted.push(await request.json());
        return HttpResponse.json(batchDto({ projectId: project.id }), { status: 201 });
      }),
    );
    const sheet = await openSheet();
    expect(await within(sheet).findByRole('checkbox', { name: 'One' })).toHaveProperty('checked', true);
    expect(within(sheet).getByRole('checkbox', { name: 'Two' })).toHaveProperty('checked', false);
    expect(within(sheet).getByText('Area src is shared with One, picked before it')).toBeTruthy();
    expect(within(sheet).getByText('make gate')).toBeTruthy();
    expect(within(sheet).getByText(/The PM review isn’t built yet/)).toBeTruthy();
    expect(sizes[0]).toBe(2);

    fireEvent.click(within(sheet).getByRole('checkbox', { name: 'Two' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Start 2 tasks' }));
    await waitFor(() => {
      expect(posted).toEqual([{ taskIds: [one.id, two.id] }]);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Start a batch' })).toBeNull();
    });
  });

  it('shows each step’s persona, profile and why', async () => {
    serve(twoCandidates, [one, two]);
    const sheet = await openSheet();
    const steps = await within(sheet).findByRole('table', { name: 'Steps for One' });
    expect(within(steps).getByText('Implementer')).toBeTruthy();
    expect(within(steps).getAllByText('sonnet@high').length).toBeGreaterThan(0);
    expect(within(steps).getAllByText('cheapest profile at or above 40 coding').length).toBeGreaterThan(0);
  });

  it('refetches the proposal when the batch size changes', async () => {
    const sizes: number[] = [];
    serve((size) => {
      sizes.push(size);
      return twoCandidates(size);
    }, [one, two]);
    const sheet = await openSheet();
    fireEvent.change(await within(sheet).findByLabelText('Batch size'), { target: { value: '1' } });
    await waitFor(() => {
      expect(sizes).toContain(1);
    });
  });

  it('disables Start and says why when nothing is ticked', async () => {
    serve(twoCandidates, [one, two]);
    const sheet = await openSheet();
    fireEvent.click(await within(sheet).findByRole('checkbox', { name: 'One' }));
    expect(within(sheet).getByRole('button', { name: 'Start 0 tasks' })).toHaveProperty('disabled', true);
    expect(within(sheet).getByText('Tick at least one task')).toBeTruthy();
  });

  it('shows why nothing can start when no task is ready', async () => {
    serve((size) => PickerProposalDto.parse({ projectId: project.id, size, candidates: [] }), []);
    const sheet = await openSheet();
    expect(
      await within(sheet).findByText('No ready tasks. A task is ready when everything it depends on is done.'),
    ).toBeTruthy();
  });

  it("shows the daemon's message when the batch is refused, and stays open", async () => {
    serve(
      twoCandidates,
      [one, two],
      http.post(daemonUrl('/projects/:projectId/batches'), () =>
        HttpResponse.json(
          { error: 'conflict', message: 'Task One already has an active workstream' },
          { status: 409 },
        ),
      ),
    );
    const sheet = await openSheet();
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Start 1 task' }));
    expect(await within(sheet).findByText('Task One already has an active workstream')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Start a batch' })).toBeTruthy();
  });

  it('changes a task’s flow from the sheet', async () => {
    const quick = flowDto({ name: 'quick' });
    const patched: unknown[] = [];
    serve(
      twoCandidates,
      [one, two],
      http.get(daemonUrl('/flows'), () => HttpResponse.json([quick])),
      http.patch(daemonUrl('/tasks/:taskId'), async ({ request }) => {
        patched.push(await request.json());
        return HttpResponse.json(one);
      }),
    );
    const sheet = await openSheet();
    fireEvent.click(await within(sheet).findByRole('textbox', { name: 'Flow for One' }));
    fireEvent.click(await screen.findByRole('option', { name: 'quick' }));
    await waitFor(() => {
      expect(patched).toEqual([{ flowId: quick.id }]);
    });
  });
});
```

In `board-view.test.tsx`, delete `starts a ready task` and the `it.each` over startable states (the card has no Start any more) and add:

```tsx
  it('offers no Start on a card; work starts through Start N', async () => {
    const project = projectDto();
    const ready = taskDto({ projectId: project.id, title: 'Alpha', boardStatus: 'ready' });
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([ready])),
    );
    renderApp('/board');
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Alpha' }));
    expect(await screen.findByRole('menu')).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Start' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Start N' })).toBeTruthy();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @10db/desktop exec vitest run src/views/board`
Expected: FAIL: `./batch-selection` doesn't exist; no `Start N` button.

- [ ] **Step 3: Write the selection rules**

`apps/desktop/src/views/board/batch/batch-selection.ts`:

```ts
import type { PickerProposalDto, TaskId } from '@10db/contracts';

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
 * one after the other. A plan that failed or is over budget is, because the daemon would refuse it.
 */
export function startBlockers(proposal: PickerProposalDto, selection: ReadonlySet<TaskId>): string[] {
  const ticked = proposal.candidates.filter((c) => selection.has(c.task.id));
  if (ticked.length === 0) return ['Tick at least one task'];
  return ticked.flatMap((c) => {
    if (c.planError !== null) return [`${c.task.title}: ${c.planError}`];
    if (c.plan === null) return [`${c.task.title} has no step plan`];
    if (c.plan.overBudget.length > 0) return [`${c.task.title} is over the budget ceiling`];
    return [];
  });
}
```

- [ ] **Step 4: Write the hooks**

In `apps/desktop/src/daemon/queries.ts`, import `BatchDto` (delivery), `PickerProposalDto` and `TaskPatch` (type), add `candidates: (projectId: ProjectId, size: number) => ['candidates', projectId, size] as const,` to `queryKeys`, and add:

```ts
export function useCandidates(projectId: ProjectId, size: number, enabled: boolean) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: queryKeys.candidates(projectId, size),
    queryFn: async () =>
      readJson(
        await client.projects[':projectId'].candidates.$get({
          param: { projectId },
          query: { size: String(size) },
        }),
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

/** Starts the ticked tasks as one batch, through the delivery spec's batch route. */
export function useStartBatch(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (taskIds: readonly TaskId[]) =>
      readJson(
        await client.projects[':projectId'].batches.$post({
          param: { projectId },
          json: { taskIds: [...taskIds] },
        }),
        BatchDto,
      ),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
        queryClient.invalidateQueries({ queryKey: ['workstreams'] }),
        queryClient.invalidateQueries({ queryKey: ['candidates'] }),
      ]),
  });
}
```

Delete `useStartTask` once nothing uses it (knip will say).

In `apps/desktop/src/daemon/events.ts`, add `['candidates']` to the lists for `project`, `task`, `workstream`, `claim`, `flow`, `persona`, `team`, `model_profile` and `benchmarks`, and add `batch: [['tasks'], ['workstreams'], ['candidates']]` (the entity type the delivery spec emits; Open decision 5).

- [ ] **Step 5: Write the sheet**

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

The plan's step for a role with no persona shows `ROLE_LABEL` in the Step column and the persona's name beside it; the test's `getByText('Implementer')` matches the persona cell (the role label for implement is also "Implementer", so use `getAllByText` there if both render).

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
            {candidate.resumed ? (
              <Badge size="sm" variant="light">
                Resumed
              </Badge>
            ) : null}
            {candidate.unblocks > 0 ? (
              <Badge size="sm" variant="light" color="gray">{`Unblocks ${String(candidate.unblocks)}`}</Badge>
            ) : null}
          </Group>
        </Group>
        {candidate.conflict ? (
          <Text size="sm" c="yellow">
            {candidate.conflict}
          </Text>
        ) : null}
        <Group gap={4}>
          <Text size="xs" c="dimmed">
            Claims
          </Text>
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
        {patch.error ? (
          <Alert color="red" title="Couldn't change the task">
            {patch.error.message}
          </Alert>
        ) : null}
        {candidate.planError ? (
          <Alert color="red" title="No step plan">
            {candidate.planError}
          </Alert>
        ) : null}
        {candidate.plan ? <BatchSteps title={task.title} plan={candidate.plan} /> : null}
      </Stack>
    </Paper>
  );
}
```

`apps/desktop/src/views/board/batch/batch-sheet.tsx`:

```tsx
import { PICK_MAX, type PickerProposalDto, type ProjectDto } from '@10db/contracts';
import { Alert, Button, Code, Drawer, Group, List, Loader, NumberInput, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { useCandidates, useStartBatch } from '../../../daemon/queries';
import { BatchCandidate } from './batch-candidate';
import { initialSelection, orderedSelection, startBlockers, toggle } from './batch-selection';

interface ChoicesProps {
  readonly project: ProjectDto;
  readonly proposal: PickerProposalDto;
  readonly onStarted: () => void;
}

function Choices({ project, proposal, onStarted }: ChoicesProps) {
  const [selection, setSelection] = useState(() => initialSelection(proposal));
  const start = useStartBatch(project.id);
  const ordered = orderedSelection(proposal, selection);
  const blockers = startBlockers(proposal, selection);
  if (proposal.candidates.length === 0)
    return <Text c="dimmed">No ready tasks. A task is ready when everything it depends on is done.</Text>;
  return (
    <Stack>
      {proposal.candidates.map((c) => (
        <BatchCandidate
          key={c.task.id}
          candidate={c}
          ticked={selection.has(c.task.id)}
          onToggle={() => {
            setSelection((s) => toggle(s, c.task.id));
          }}
        />
      ))}
      <Text size="sm">
        Verification: 10db runs <Code>{project.gateCommand}</Code> after each implement step, and review
        steps must approve.
      </Text>
      {blockers.length > 0 ? (
        <List size="sm" c="yellow">
          {blockers.map((b) => (
            <List.Item key={b}>{b}</List.Item>
          ))}
        </List>
      ) : null}
      {start.error ? (
        <Alert color="red" title="Couldn't start the batch">
          {start.error.message}
        </Alert>
      ) : null}
      <Group justify="flex-end">
        <Button
          disabled={blockers.length > 0}
          loading={start.isPending}
          onClick={() => {
            start.mutate(ordered, { onSuccess: onStarted });
          }}
        >
          {`Start ${String(ordered.length)} task${ordered.length === 1 ? '' : 's'}`}
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
          Chosen by the picker’s rules: ready tasks, resumed work first, then the work that unblocks most,
          then board order. Tasks whose areas collide are left out. The PM review isn’t built yet.
        </Text>
        {proposal.isError ? (
          <Alert color="red" title="Couldn't load the proposal">
            {proposal.error.message}
          </Alert>
        ) : null}
        {proposal.isPending && opened ? <Loader size="sm" aria-label="Loading the proposal" /> : null}
        {proposal.data ? (
          <Choices key={size} project={project} proposal={proposal.data} onStarted={onClose} />
        ) : null}
      </Stack>
    </Drawer>
  );
}
```

`key={size}` resets the ticks when the size changes (a new proposal). A refetch for the same size (a task event) keeps the builder's ticks, and `orderedSelection` drops any that stopped being candidates.

In `board-view.tsx`, add a `Start N` button to the header when a project is selected (`<Button size="sm" onClick={sheet.open}>Start N</Button>`, with `const [sheetOpen, sheet] = useDisclosure(false);`), and render `<BatchSheet key={project.id} project={project} opened={sheetOpen} onClose={sheet.close} />`. In `task-card-menu.tsx`, delete Start, `canStart`, `STARTABLE`, `RESTARTABLE` and the `latest` and `onStart` props; the board stops calling `useStartTask`.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @10db/desktop exec vitest run && pnpm --filter @10db/desktop typecheck && pnpm lint && pnpm knip`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
pnpm format && git add apps/desktop/src/views/board apps/desktop/src/daemon/queries.ts apps/desktop/src/daemon/events.ts apps/desktop/src/test/fixtures.ts && git commit -m 'feat(desktop): add the batch approval sheet behind start n'
```

---

### Task 13: Part B end to end, docs and the gate

**Files:**
- Modify: `apps/desktop/e2e/loop.spec.ts`, `docs/architecture/decisions.md`, `docs/open-items.md`, `apps/daemon/AGENTS.md`, `apps/desktop/AGENTS.md`

- [ ] **Step 1: Start the run through the sheet**

In `apps/desktop/e2e/loop.spec.ts`, replace the card-menu start with:

```ts
  await page.getByRole('button', { name: 'Start N' }).click();
  const sheet = page.getByRole('dialog', { name: 'Start a batch' });
  await expect(sheet.getByRole('checkbox', { name: TASK })).toBeChecked();
  // Both tasks claim the only area, so the picker leaves the second out and says why.
  await expect(sheet.getByRole('checkbox', { name: 'Tidy the readme' })).not.toBeChecked();
  await expect(sheet.getByText(`Area greeting is shared with ${TASK}, picked before it`)).toBeVisible();
  await expectAccessible(page, 'batch sheet, dark');
  await sheet.getByRole('button', { name: 'Start 1 task' }).click();
  await expect(sheet).toBeHidden();
```

The drag Task 8 added puts `TASK` first, so it is the one proposed. If the delivery work makes a batch create a branch or open a PR in the disposable repo, follow the delivery plan's e2e guidance for the gate command and the final assertions; this plan doesn't change them.

- [ ] **Step 2: Record the decisions**

Append rows B1 and B2 from "New decisions" to `docs/architecture/decisions.md`, numbered with the next free numbers at merge.

- [ ] **Step 3: Update the open items and the agent docs**

In `docs/open-items.md`, tick `M2b: the picker and the batch approval sheet (plan 07, part B), after the delivery spec's batch entity.`

In `apps/daemon/AGENTS.md`, add `picker` to the first group of the module order line, after `routing`, and add the line:
- ``picker/` is pure like `routing/`: the spec §5.2.1 rules over rows its caller passes in. `team/candidates.ts` gathers the rows, adds each candidate's step plan and serves `GET /projects/:projectId/candidates`. It models no batch; batches belong to the delivery work.`

In `apps/desktop/AGENTS.md`, add:
- `Work starts only through the board's batch sheet (`views/board/batch/`), which calls the batch route; there is no per-task Start in the UI.`

- [ ] **Step 4: Run the gate**

Run: `make gate`
Expected: the last line starts `GATE PASS format lint typecheck test build e2e drift knip`.

- [ ] **Step 5: Commit and open the PR**

```bash
pnpm format && git add apps/desktop/e2e/loop.spec.ts docs/architecture/decisions.md docs/open-items.md apps/daemon/AGENTS.md apps/desktop/AGENTS.md && git commit -m 'docs(docs): record the picker and approval sheet decisions'
```

Push the branch and open a PR to `main` titled `feat(desktop): pick and approve a batch from the board (m2b part b)`. Its body lists what Part B builds, the contracts it adds (`PickerProposalDto`, `PickSize`, `PICK_MAX`) and the delivery contracts it consumes, and the `GATE PASS` line.

---

## Self-review notes

- **Spec coverage:**
  - §10 Shell: the Board and Settings views in the nav (Tasks 4 and 6). ⌘K is not in this plan (listed).
  - §10 Board: five columns (Task 4); drag and drop sets priority (Tasks 2, 3, 5); cards with areas, dependency markers and live state (Task 4); Start N and the sheet (Task 12). Brainstorm is not in this plan.
  - §5.1 derived status: shown as the daemon derives it (Task 4); the Ready rule's blocking-card check stays an open item.
  - §5.2.1 picker: Task 10. §5.2.2 PM review: not built, and the sheet says so (Task 12). §5.2.3 router: M2a, shown per step (Task 12). §5.2.4 approval sheet: Task 12, with the edits of Open decision 3.
  - §10 Settings: per project, the gate command and budget ceiling are editable (Task 7), areas, hazards and billing are shown (Task 6), team bindings and routing rules are slots; app-wide, keep-awake is editable (Task 6), and providers fold into the Accounts slot because the accounts spec replaces billing modes and the per-provider cap.
  - Accounts spec §7 and §12 point 4: the Accounts slot and the Billing section's account-picker slot (Task 6).
  - §5.4 takeover: plan 08.
- **Placeholder scan:** the only content this plan leaves to another plan is the delivery spec's `BatchDto`, its fixture and its route (Task 12), which this plan must not define. Open decision 5 states the assumed shape and names the one hook, handler and fixture that change if it differs.
- **Types across tasks:**
  - `TaskMove` (Task 1) → `moveTask` (Task 2) → `ApiServices.moveTask` (Task 3) → `planMove` and `useMoveTask` (Task 5).
  - `useSelectedProject` and `ProjectPicker` (Task 4) → Settings (Task 6).
  - `BOARD_STATUS` is exported from `board-status-badge.tsx` (Task 4) and read by `BoardColumn`.
  - `TaskCardMenu` props: Task 4 (`task`, `latest`, `onStart`); Task 5 adds `position` and `onMove`; Task 12 removes `latest` and `onStart`.
  - `useFlows` and `queryKeys.flows` (Task 7) → `BatchCandidate` (Task 12).
  - `PickerProposalDto`, `PickerCandidate`, `PickSize` and `PICK_MAX` (Task 9) → `proposeCandidates` (Task 11) → `useCandidates` and `BatchSheet` (Task 12).
  - `pickCandidates` and `PickerTask` (Task 10) → `proposeCandidates` (Task 11).
- **Review Focus:** each of the six lines has its test in its owning task: 1 (Tasks 2 and 5), 2 (Task 2), 3 (Task 5), 4 (Tasks 5 and 8), 5 (Task 7), 6 (Tasks 10 and 12).
