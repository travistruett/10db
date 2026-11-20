# Task 2: Undo Accept

**Spec:** §5 Accept ("Undo Accept is new … while none of its tasks has started. An Accept that also changed or
removed existing Board tasks says so in its confirm and offers no undo for those changes"); §1 (the Accepted
state); §1.1 (the row "Undo Accept | The scheduler starts one of its tasks").
**Track:** A, core (data loss, claims). Read `apps/daemon/src/shape/AGENTS.md` once. Needs Task 1 on the branch.

## What Undo may remove: exactly this, nothing else

Undo reads only the Accept's record: `listAcceptedProposals(db, acceptId)` and the landing groups with its
`accept_id`. For each proposal, it takes the links Convert wrote under that proposal (`shape_links` with its
`proposal_id`):

| Proposal kind | Undo does | Refuses when |
| --- | --- | --- |
| `goal` | `removeDraftGoalOf` (the goal, its tasks including later additions, its attachments rekeyed, its questions released, its links) | any task has a run (`startedRun`), an outside open task waits on one, the goal is not a draft |
| `task` (loose, or an addition to a goal) | rekey its attachments to the proposal (`rekeyShapeAttachmentsToProposal`), `cancelNeverStartedTask`, delete its links | the task has a run; an open task outside this Accept waits on it |
| `decision` with a link | `withdrawDecision(ctx, id, { by: 'builder', reason: 'Undo Accept' })`, delete its links | it is not the head of its chain |
| `decision` without a link (not lasting) | nothing beyond the proposal | — |
| `principle` | `withdrawPrincipleRecord(ctx, id, 'Undo Accept', undefined)`, delete its links | a later principle replaced it (409) |
| `question` | delete the stored question and its link. Add `releaseShapeQuestion(ctx, questionId)` beside `releaseDetachedShapeQuestions` in `packages/db/src/store/shape-state.ts` if there is none. | — |
| `landing` | `deleteLandingGroupOf` for each group with this `accept_id` | — |
| `change_task`, `remove_task` | **nothing**: the change to the Board task stays, and the proposal stays accepted under the Accept. Counted in `kept`. | — |

Then every proposal Undo took back is set `{ state: Pending, acceptId: null }`, the plan is set
`{ state: Proposed }`, `markShapeAcceptUndone(ctx, acceptId)` runs, and one transcript note is written, as
Convert writes one: `insertShapeMessage(ctx, shapeId, { author: Note, kind: Event, body })`, with a body such as
"Undid Accept: 1 goal, 2 tasks; withdrew 1 decision".

**Never:**
- a task with any run, queued included;
- a task, goal or record not linked under one of this Accept's proposals;
- a task another Accept made;
- a workstream, batch or worktree. A task with a run is refused, never cancelled through its run.

## Files

### `apps/daemon/src/shape/undo.ts`

```ts
export interface UndoneAccept {
  readonly goals: number;
  readonly tasks: number;
  readonly decisions: number;
  readonly principles: number;
  readonly questions: number;
  /** Changes and removals of Board tasks this Accept made, which stay. */
  readonly kept: number;
}
export function undoAccept(ctx: WriteContext, shapeId: ShapeId, acceptId: ShapeAcceptId): UndoneAccept;
```

- **Refusals:**
  - an Accept not of this shape: `InvalidError`;
  - one already undone: `InvalidError` "This Accept was undone";
  - one that is not `latestShapeAccept(ctx.tx, shapeId)`: `InvalidError` "Undo the later Accept first".
- **Order, so no removal is refused by a dependent this Accept also removes:**
  - first remove units whose tasks nothing else remaining in the Accept waits on;
  - a unit is a goal, as a whole, or a loose task;
  - repeat until none are left, as `removeDraftGoal`'s loop does for one goal;
  - a cycle can't be written, but end with a `ConflictError` rather than loop.
- **A task already cancelled** (removed from the Board since) is skipped and its links deleted. A goal no longer
  draft (`removeDraftGoal`'s refusal) refuses the Undo.
- Every refusal is a typed error thrown inside the caller's write, so the whole Undo rolls back. Keep the store's
  own `TaskStartedError` and `ConflictError` messages, which already name the task.
- Update the module comment: it lists "these three"; there are four now.

### `apps/daemon/src/shape/service.ts` and `apps/daemon/src/shape/index.ts`

- `ShapeService.undoAccept(shapeId: ShapeId, acceptId: ShapeAcceptId): UndoneAccept` runs `undoAccept` in one
  `state.write`. Like Convert, it never waits on or stops a running turn.

### `apps/daemon/src/shape/view.ts`

- `buildShapeView` adds `lastAccept`, the newest Accept not undone, or null. It counts the Accept's links:
  - `goals` are the goal links;
  - `tasks` are the task links not under a goal proposal;
  - `records` are the decision and principle links;
  - `kept` is the number of `change_task` and `remove_task` proposals it accepted.

### `packages/contracts/src/shape-view.ts`

`ShapeAcceptDto`, `ShapeViewDto.lastAccept` and `ShapeUndoAcceptResult`, as in the index's Interfaces. Run the
contracts generator if `packages/contracts/generated/` drifts (`make precheck` says so).

### Route: `apps/daemon/src/api/app.ts`, `api/services.ts`, `daemon/shape-services.ts`

- `POST /shapes/:shapeId/accepts/:acceptId/undo` → `deps.services.undoShapeAccept(shapeId, acceptId)`, answering
  200 with `ShapeUndoAcceptResult`.
- `ConflictError` and `TaskStartedError` map to 409 and `InvalidError` to 400, as the API's error mapping already
  does. Check `TaskStartedError`'s status there.
- Add `'undoShapeAccept'` to `ShapeApiServices`. It is a POST, so it needs no token-list entry.

## State-table rows

Every Undo row of the index's table.

## Tests (core, red first, real SQLite: `createTestStore`, `seedProject`, a chat and its plan through the store,
proposals accepted through `convertProposals`; no mocks of 10db's code)

In `apps/daemon/src/shape/undo.test.ts`:

1. **"Undo Accept takes back only what this Accept wrote".** Setup:
   - Accept 1 accepts goal A (two tasks) and a lasting decision;
   - an Accept of another plan in the same project makes task X;
   - Accept 2, on the first plan, accepts loose task B, a `change_task` on X, and a question.

   Undo Accept 2. Then:
   - B is cancelled and its proposal is pending with no `accept_id`;
   - the question row is gone;
   - X keeps the change and its proposal stays accepted;
   - goal A, its tasks and the decision stand;
   - Accept 2 has `undone_at` set;
   - undoing Accept 1 next works, and withdraws the decision (read back through `listDecisions` or search, as
     testing.md asks for a knowledge write).
2. **"Undo Accept refuses and writes nothing when one of its tasks has a run, or an outside task waits on one".**
   Three cases on a fresh Accept, each followed by a check that every row is as before (proposal states, task
   statuses, `undone_at` null):
   - a queued run on one of its tasks (insert it through the store's workstream insert);
   - an open task outside the Accept that depends on one of its tasks;
   - an Accept that is not the latest.

Prove each red first: 1 against an `undoAccept` that cancels every task of the plan, and 2 against one that skips
the started check. Each commit carries one value card, wrapped under 100 characters, with
`why_new=undo removes Board rows (data loss)`.

## Done when

- Both tests pass, and were proved red.
- `vitest related src/shape/undo.ts src/shape/view.ts --run --maxWorkers=2` passes.
- `make precheck` is green.
