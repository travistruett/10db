# Task 2: Undo Accept

**Spec:** §5 Accept ("Undo Accept is new … while none of its tasks has started. An Accept that also changed or
removed existing Board tasks says so in its confirm and offers no undo for those changes"); §1 (the Accepted
state); §1.1 (the row "Undo Accept | The scheduler starts one of its tasks").
**Track:** A, core (data loss, claims). Read `apps/daemon/src/shape/AGENTS.md` once. Needs Task 1 on the branch.

## Interfaces it implements or calls (quoted)

```ts
// apps/daemon/src/shape/undo.ts
export function removeDraftGoalOf(ctx: WriteContext, shapeId: ShapeId, goalId: GoalId): void;
// packages/db
export function getTask(db: DbReader, id: TaskId): TaskDto;
export function cancelNeverStartedTask(ctx: WriteContext, id: TaskId): TaskDto;
export function deleteShapeLinksOf(ctx: WriteContext, proposalId: ShapeProposalId): void;
export function rekeyShapeAttachmentsToProposal(
  ctx: WriteContext,
  links: readonly Pick<ShapeLinkRow, 'shapeId' | 'key' | 'goalId' | 'taskId'>[],
): void;
export function patchShapeProposal(
  ctx: WriteContext,
  id: ShapeProposalId,
  patch: ShapeProposalPatch,
): void;
export function withdrawDecision(
  ctx: WriteContext,
  id: DecisionId,
  input: { readonly by: string; readonly reason: string; readonly sourceId?: SourceId | null },
): void;
export function insertShapeMessage(
  ctx: WriteContext,
  shapeId: ShapeId,
  input: {
    readonly author: ShapeMessageAuthor;
    readonly kind: ShapeMessageKind;
    readonly body: string;
    readonly queued?: boolean;
    readonly prompt?: string;
    readonly rehearsing?: readonly { readonly taskKey: string; readonly hash: string }[];
  },
): ShapeMessageDto;
// apps/daemon/src/knowledge/records.ts
export function withdrawPrincipleRecord(
  ctx: WriteContext,
  id: PrincipleId,
  reason: string,
  source: KnowledgeSource | undefined,
): PrincipleItem;
// Task 1 (packages/db)
export function latestShapeAccept(db: DbReader, shapeId: ShapeId): ShapeAcceptRow | undefined;
export function markShapeAcceptUndone(ctx: WriteContext, id: ShapeAcceptId): void;
export function listAcceptedProposals(db: DbReader, id: ShapeAcceptId): ShapeProposalRow[];
export function deleteLandingGroupOf(ctx: WriteContext, id: LandingGroupId): void;
export function leaveLandingGroup(ctx: WriteContext, taskId: TaskId): void;
```

**Implements (quoted):**

```ts
// apps/daemon/src/shape/undo.ts
export interface UndoneAccept {
  readonly goals: number;
  readonly tasks: number;
  readonly decisions: number;
  readonly principles: number;
  readonly questions: number;
  /** What this Accept wrote that Undo leaves: changes and removals of Board tasks, a decision superseded or a
   *  principle replaced since, a landing group holding a task with a run or one it didn't make. */
  readonly kept: number;
}
export function undoAccept(ctx: WriteContext, shapeId: ShapeId, acceptId: ShapeAcceptId): UndoneAccept;

// packages/db/src/store/shape-state.ts
/** Deletes a question Convert stored, and its link; its proposal is the caller's to reset. */
export function releaseShapeQuestion(ctx: WriteContext, questionId: ShapeQuestionId): void;

// apps/daemon/src/shape/service.ts (ShapeService)
undoAccept(shapeId: ShapeId, acceptId: ShapeAcceptId): UndoneAccept;
// apps/daemon/src/api/services.ts (ApiServices), and ShapeApiServices
undoShapeAccept(shapeId: ShapeId, acceptId: ShapeAcceptId): ShapeUndoAcceptResult;

// packages/contracts/src/shape-view.ts
export const ShapeAcceptDto = z.object({
  id: ShapeAcceptId,
  at: Timestamp,
  goals: z.int().min(0),
  /** Every task it made: a goal's tasks and loose tasks alike, so a goal-only Accept reads "1 goal, 2 tasks". */
  tasks: z.int().min(0),
  records: z.int().min(0),
  /** What Undo would leave, counted as undoAccept counts `kept`. */
  kept: z.int().min(0),
  /** Every task it made, so the app can tell from its cached runs whether Undo would be refused. */
  taskIds: z.array(TaskId),
});
// ShapeViewDto gains `lastAccept: ShapeAcceptDto.nullable()`: the newest Accept not undone.
export const ShapeUndoAcceptResult = z.object({
  goals: z.int().min(0),
  tasks: z.int().min(0),
  decisions: z.int().min(0),
  principles: z.int().min(0),
  questions: z.int().min(0),
  kept: z.int().min(0),
});
```

## What Undo may remove: exactly this, nothing else

Undo reads only the Accept's record: `listAcceptedProposals(db, acceptId)` and the landing groups with its
`accept_id`. For each proposal, it takes the links Convert wrote under that proposal (`shape_links` with its
`proposal_id`).

**Pre-checks.** These run before anything is written or any store call is made. Each throws a typed error in the
caller's write, so the whole Undo rolls back.

1. The Accept belongs to this shape and is not undone. Otherwise `InvalidError` "This Accept was undone", or an
   unknown Accept.
2. It is `latestShapeAccept(ctx.tx, shapeId)`. Otherwise `InvalidError` "Undo the later Accept first".
3. **No task it would remove has any workstream row**, of any state: queued, held, or cancelled before a session
   included. The check reads `workstreams` by `task_id`, for every task linked under its goal and task proposals
   that is not already cancelled. Otherwise `ConflictError` "<title> has started; cancel its run and remove it
   from the Board first". This is stricter than `cancelNeverStartedTask`'s `startedRun`, on purpose: Undo never cancels a run,
   so it never leaves a branch, batch or worktree behind.
4. **No goal it would remove holds a task, other than a cancelled one, that isn't linked under this Accept's
   proposals.** That means a pass's page, or a task added on the Board. Cancelled tasks are ignored, as
   `removeDraftGoal` ignores them (`goal-removal.ts:33`). Otherwise, for example, Accept 1 makes a goal, Accept 2
   adds T to it, and undoing Accept 2 cancels T but keeps its `goal_id`, so Undo 1 would be refused for ever.
   The refusal is `ConflictError` "<goal> holds <task>, which this Accept didn't make".

**Then, per proposal kind:**

| Proposal kind | Undo does | Refuses when |
| --- | --- | --- |
| `goal` | `removeDraftGoalOf`: the goal, its tasks including additions this Accept made, its attachments rekeyed, its questions released, its links | an outside open task waits on one of its tasks (the store's own refusal) |
| `task` (loose, or an addition to a goal) | if already cancelled: delete its links only. Else rekey its attachments to the proposal, `cancelNeverStartedTask`, delete its links | an outside open task waits on it |
| `decision` with a link, current | `withdrawDecision(ctx, id, { by: 'builder', reason: 'Undo Accept' })`, delete its links | — |
| `decision` with a link, withdrawn since | taken back already: delete its links | — |
| `decision` with a link, superseded since (`decisionSuccessor` non-null) | **leave it**, keep its links and its proposal accepted, add to `kept` | — |
| `decision` without a link (not lasting) | nothing beyond the proposal | — |
| `principle`, current or proposed | `withdrawPrincipleRecord(ctx, id, 'Undo Accept', undefined)`, delete its links | — |
| `principle`, withdrawn or retired since | taken back already: delete its links | — |
| `principle`, replaced since (`supersededById` non-null) | **leave it** as for a superseded decision, add to `kept` | — |
| `question` | `releaseShapeQuestion(ctx, questionId)` | — |
| `landing` | for each group with this `accept_id`: when every member is a task this Undo cancels, `deleteLandingGroupOf`, and the proposal goes back to pending. Otherwise `leaveLandingGroup` for each member this Undo cancels, the group stays, and **its proposal stays accepted under the Accept**, added to `kept` (a member with a run, or one not made here) | — |
| `change_task`, `remove_task` | **nothing**: the change to the Board task stays, and the proposal stays accepted under the Accept. Added to `kept`. | — |

Read the decision and principle states before calling the withdraw functions, so neither one's "already
withdrawn" or "superseded" `ConflictError` is ever reached. Those refusals would lock every earlier Accept.

**Order:**
- first remove the units whose tasks nothing else remaining in the Accept waits on;
- a unit is a goal, as a whole, or a loose task;
- repeat until none are left, as `removeDraftGoal`'s loop does for one goal;
- end with a `ConflictError` rather than loop.

**Rewrapped store refusals:**
- a `TaskStartedError` from the store becomes "<title> has started; cancel its run and remove it from the Board
  first";
- the store's "Batch "<title>" is being cut" `ConflictError` becomes "A batch is being cut; try Undo Accept again
  once it has started".

Both keep their error class, so the status stays 409.

**Afterwards:**
- every proposal Undo took back is set `{ state: Pending, acceptId: null }`;
- the plan is set `{ state: Proposed }`;
- `markShapeAcceptUndone(ctx, acceptId)` runs;
- one transcript note is written, `insertShapeMessage(ctx, shapeId, { author: Note, kind: Event, body })`, with a
  body such as "Undid Accept: 1 goal, 2 tasks; withdrew 1 decision; 1 stays".

**Never:**
- a task with any workstream row;
- a task, goal or record not linked under one of this Accept's proposals;
- a task another Accept made;
- a workstream, batch or worktree.

## Files

### `packages/db/src/store/shape-state.ts`

Add `releaseShapeQuestion(ctx, questionId)`: it deletes the question's link and the question row. Reuse what
`releaseDetachedShapeQuestions` does for one question.

### `apps/daemon/src/shape/undo.ts`

- `undoAccept`, as above.
- Update the module comment, which lists "these three": there are four now.

### `apps/daemon/src/shape/service.ts` and `apps/daemon/src/shape/index.ts`

- `ShapeService.undoAccept(shapeId, acceptId): UndoneAccept` runs `undoAccept` in one `state.write`. Like
  Convert, it never waits on or stops a running turn.

### `apps/daemon/src/shape/view.ts`

- `buildShapeView` adds `lastAccept`, the newest Accept not undone, or null. It counts the Accept's links:
  - `goals` are the goal links;
  - `tasks` are every task link under its goal and task proposals, a goal's tasks included, so a goal-only Accept
    reads "1 goal, 2 tasks";
  - `records` are the decision and principle links that Undo would withdraw;
  - **`kept` is counted as `undoAccept` counts it:** the `change_task` and `remove_task` proposals, the decisions
    superseded and principles replaced since, and the landing groups that hold a task with a run or one it
    didn't make. Put the rule in one function that `undoAccept` and the view both call, so the confirm's
    "N stay" and Undo's result agree;
  - `taskIds` is every task linked under it.

### `packages/contracts/src/shape-view.ts`

`ShapeAcceptDto`, `ShapeViewDto.lastAccept` and `ShapeUndoAcceptResult`. Run the contracts generator if
`packages/contracts/generated/` drifts (`make precheck` says so).

### Route: `apps/daemon/src/api/app.ts`, `api/services.ts`, `daemon/shape-services.ts`

- `POST /shapes/:shapeId/accepts/:acceptId/undo` → `deps.services.undoShapeAccept(shapeId, acceptId)`, answering
  200 with `ShapeUndoAcceptResult`.
- `ConflictError` and `TaskStartedError` map to 409 and `InvalidError` to 400, through the API's error mapping.
  Check `TaskStartedError`'s status there.
- Add `'undoShapeAccept'` to `ShapeApiServices`. It is a POST, so it needs no token-list entry.

## State-table rows

Every row of the index's "Undo Accept" table except the two ⋯ rows, which are Task 4's.

## Tests

Core, red first, on real SQLite: `createTestStore`, `seedProject`, a chat and its plan through the store, and
proposals accepted through `convertProposals`. No mocks of 10db's code. In `apps/daemon/src/shape/undo.test.ts`:

1. **"Undo Accept takes back only what this Accept wrote".** Setup:
   - Accept 1 accepts goal A (two tasks), a lasting decision D1 and a principle P1;
   - an Accept of another plan in the same project makes task X;
   - Accept 2, on the first plan, accepts loose task B, a `change_task` on X, a question and a lasting
     decision D2;
   - D2 is then withdrawn through `withdrawDecision`.

   Undo Accept 2. Then:
   - B is cancelled and its proposal is pending with no `accept_id`;
   - the question row is gone;
   - X keeps the change and its proposal stays accepted;
   - D2's proposal is pending, with no refusal for the withdrawn decision;
   - goal A, its tasks, D1 and P1 stand;
   - Accept 2 has `undone_at` set.

   Then supersede D1 with a new decision written through the store, and undo Accept 1:
   - goal A is gone;
   - D1 is left and counted in `kept`;
   - P1 is withdrawn, read back through the knowledge search, as testing.md asks.
2. **"Undo Accept refuses and writes nothing when a task it would remove has any run, a goal holds a task it
   didn't make, or an outside task waits on one".** Four cases on a fresh Accept, each followed by a check that
   every row is as before (proposal states, task statuses, `undone_at` null):
   - a workstream row cancelled before any session, inserted through the store's workstream insert;
   - a task added to its goal outside the Accept;
   - an open task outside the Accept that depends on one of its tasks;
   - an Accept that is not the latest.

**Red proofs:**
- Prove test 1 red against an `undoAccept` that withdraws D1 without checking for a successor, so it refuses.
- Prove test 2 red against an `undoAccept` without pre-check 3. Its first case then passes through
  `cancelNeverStartedTask`, which allows a run cancelled before a session.

Each commit carries one value card, wrapped under 100 characters, with
`why_new=undo removes Board rows (data loss)`.

## Done when

- Both tests pass, and were proved red.
- `vitest related src/shape/undo.ts src/shape/view.ts --run --maxWorkers=2` passes.
- `make precheck` is green.
