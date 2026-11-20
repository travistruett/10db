# Task 3: Accept and Start, and the confirm's counts

**Spec:** §5 Accept ("Accept and Start … also starts the accepted tasks that are ready, through the same path as
Start Ready Tasks; the confirm says what starts and what waits"); §1.1 (the row "Accept and Start | Some tasks
can't start"); Brief ("It queues through the scheduler like Start Ready Tasks, within the project's
concurrency").
**Track:** A. Read `apps/daemon/src/delivery/AGENTS.md` (the starter) and `apps/daemon/src/shape/AGENTS.md`
(preview) once. Needs Task 2 on the branch.

## Which tasks start

Take the tasks this call **made**: `results` of kind `goal` (its `taskIds`) and `task`. Never take a
`change_task` or `remove_task` target. Then, in dependency order (a task after the tasks it waits on):

1. **Pull-request delivery.** A task starts when each task it waits on is finished, or is itself starting in
   this call. Otherwise it goes in `left` as "waits for <title>" (the first unfinished one outside).
2. **Local delivery.** A task starts only when it waits on nothing unfinished. One that waits on a task in this
   call goes in `left` as "waits for <title>", since a local start has no batch to queue it in.
3. **The cap.** Past 50 starting tasks (`BatchStartInput`'s cap), the rest go in `left` as "a start takes at most
   50". Their dependents go too, by rule 1.

"Finished" is `unfinishedDependencies`'s own rule (`delivery/deps.ts`), so the selection never sends the starter
a task it would refuse for that reason.

## Files

### `apps/daemon/src/shape/start-counts.ts` (new, pure)

```ts
export interface StartCountTask {
  readonly key: string;
  readonly title: string;
  /** Keys of other tasks in this start it waits on. */
  readonly waitsOnStart: readonly string[];
  /** Titles of unfinished tasks outside this start it waits on. */
  readonly waitsOutside: readonly string[];
}
export function startCounts(input: {
  readonly tasks: readonly StartCountTask[];
  /** Draft keys the lane simulation starts at hour 0. */
  readonly startsAtOnce: ReadonlySet<string>;
  readonly local: boolean;
  readonly cap: number;
}): ShapeStartCountsDto & { readonly startKeys: readonly string[] };
```

- It applies rules 1-3 in order: `stay` gets the left tasks with why, and `startKeys` the tasks that start.
- Among the starting tasks:
  - `forOthers` counts those with a non-empty `waitsOnStart`;
  - `now` counts the rest that are in `startsAtOnce`;
  - `forLane` counts every other starting task, including a task the simulation holds back for an area clash.
- The same function decides the start, through `startKeys` with ids in place of keys, and the confirm, so the
  confirm says what the start will do.

### `apps/daemon/src/shape/preview.ts`

- Add `buildStartCounts(db: DbReader, shapeId: ShapeId, proposalIds: readonly ShapeProposalId[], now: Date):
  ShapeStartCountsDto`.
  - It builds the same `existing` and `draft` items as `buildPreview`, with `draftItems` restricted to the given
    pending proposals (a new optional filter argument), and runs `simulateFactory(project.maxLanes, …)`.
  - `startsAtOnce` is every draft item whose bar has `startHours === 0`.
  - Then it calls `startCounts` with `local: project.delivery !== Delivery.PullRequest` and `cap: 50`.
  - `waitsOutside` resolves `dependsOnOutside` and converted keys to their tasks, and keeps those `finished`
    doesn't cover. Export or reuse that rule from `delivery/deps.ts` through the delivery module's entry point.
  - It writes nothing.

### Contracts: `packages/contracts/src/shape-view.ts`

`ShapeConvertInput.start`, `ShapeStartOutcome`, `ShapeConvertResult.start` and `ShapeStartCountsDto`, as in the
index's Interfaces.

### `apps/daemon/src/shape/service.ts`

- `convert(shapeId, proposalIds, options?: { cut?: readonly MilestoneCut[] })` keeps its signature. Accept and
  Start stays outside the shape service, which has no starter.
- Add `startCounts(shapeId, proposalIds): ShapeStartCountsDto`, the read above over `state.db`, with the
  service's clock.

### `apps/daemon/src/daemon/shape-services.ts` and `daemon/start.ts`

- `createShapeServices`'s deps gain:

  ```ts
  readonly startTasks: (
    projectId: ProjectId,
    title: string,
    taskIds: readonly TaskId[],
  ) => Promise<void>;
  ```

- `convertShape(id, input)`:
  - after a converted outcome with `input.start === true`, it computes the start set from the outcome's
    results. Use `startCounts` again, over the new tasks' `TaskDto`s read now, with `startsAtOnce` empty, since
    only `startKeys` and `stay` matter here.
  - Then it awaits `startTasks(projectId, getShape(state.db, id).title, startIds)` when the set is non-empty,
    and puts the outcome in `result.start`: `{ started, left, refused }`.
  - A thrown `ConflictError` or `InvalidError` from the starter becomes `refused: error.message`. Anything else is
    rethrown, but the Accept has already committed.
- In `start.ts`, wire `startTasks` as a closure that reads `services` at call time, as `startFollowUps` does
  (around line 2600):

  ```ts
  async (projectId, title, taskIds) => {
    await services.settleSizing(taskIds);
    const project = getProject(db, projectId);
    if (project.delivery === Delivery.PullRequest)
      services.startBatch(projectId, { title, taskIds: [...taskIds] });
    else for (const id of taskIds) services.startTask(id);
  }
  ```

  - A local start of several tasks stops at the first refusal, which `convertShape` reports as `refused`. The
    tasks before it have started; read `started` from what actually got a run, not from the set that was asked.
  - `startBatch` splits the tasks into a shared batch and per-group worktree batches by placement, as Start
    Ready Tasks' sheet does through the same route.

### Route: `GET /shapes/:shapeId/start-counts`

- The query is `proposalIds`, comma-separated, parsed with zod into `ShapeProposalId`s (one or more).
- `deps.services.shapeStartCounts(shapeId, ids)` answers `ShapeStartCountsDto`.
- Add `'/shapes/:shapeId/start-counts'` to `RENDER_REFUSED_READS` in `screens/render-access.ts`: "Accept's
  confirm is the app's own, and no screen draws it."
- Add it to `DEV_UI_REFUSED_READS` in `screens/dev-ui-access.ts` with the same reason.
- `api/render-reads.test.ts` must pass.

## State-table rows

Every "Accept and Start" row and the confirm rows of the index's table (the daemon half).

## Tests

In `apps/daemon/src/shape/start-counts.test.ts`, one test, a pure rule table: "start counts follow dependencies,
lanes, local delivery and the 50 cap". Rows:

- two independent tasks with both at once, giving `now: 2`;
- a task waiting on one in the start (pull request), giving `forOthers: 1`;
- the same in local delivery, giving `stay` "waits for …";
- a task waiting outside, giving `stay`;
- 51 independent tasks, giving one "a start takes at most 50";
- a task the simulation holds (not at once), giving `forLane: 1`.

Prove it red with the cap check removed. The commit carries one value card with `why_new=pure rule table`.

The start itself goes through the e2e (Task 6), through the real starter.

## Done when

- The test passes, and was proved red.
- `vitest related src/shape/start-counts.ts src/shape/preview.ts src/daemon/shape-services.ts --run
  --maxWorkers=2` passes, along with `api/render-reads.test.ts`.
- A dev daemon (`src/main.ts` on the fake adapter, a scratch data directory and repo, as Task 3 of slice 2 did)
  answers `GET …/start-counts` and a `convert` with `start: true`. Paste both responses in the report.
- `make precheck` is green.
