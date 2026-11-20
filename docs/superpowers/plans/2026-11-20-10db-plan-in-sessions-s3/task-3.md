# Task 3: Accept and Start, and the confirm's counts

**Spec:** §5 Accept ("Accept and Start … also starts the accepted tasks that are ready, through the same path as
Start Ready Tasks; the confirm says what starts and what waits"); §1.1 (the row "Accept and Start | Some tasks
can't start"); Brief ("It queues through the scheduler like Start Ready Tasks, within the project's
concurrency").
**Track:** A. Read `apps/daemon/src/delivery/AGENTS.md` (the starter) and `apps/daemon/src/shape/AGENTS.md`
(preview) once. Needs Task 2 on the branch.

## Interfaces it implements or calls (quoted)

```ts
// apps/daemon/src/shape/preview.ts, preview-schedule.ts
export function buildPreview(db: DbReader, shapeId: ShapeId, now: Date): ShapePreviewDto;
export function simulateFactory(laneCap: number, items: readonly ScheduleItem[]): Schedule;
export interface ScheduleItem {
  readonly key: string;
  readonly title: string;
  readonly hours: number;
  readonly areas: readonly string[];
  readonly dependsOn: readonly string[];
  readonly existing: 'running' | 'queued' | null;
}
// apps/daemon/src/delivery/deps.ts, delivery/placement.ts
export function unfinishedDependencies(
  db: DbReader,
  tasks: readonly TaskDto[],
  inBatch: ReadonlySet<TaskId>,
): BlockedTask[];
export function refuseCrossPlacementDependency(
  tasks: readonly TaskDto[],
  raise: (card: CardText, taskIds: readonly [TaskDto['id'], TaskDto['id']]) => void,
): void;
// apps/daemon/src/placement/propose.ts
export function proposePlacement(project: ProjectPlacement, task: TaskTouches): PlacementProposal;
// apps/daemon/src/api/services.ts (ApiServices)
settleSizing(taskIds: readonly TaskId[]): Promise<void>;
startTask(taskId: TaskId, input?: StartTaskInput): TaskStarted;
startBatch(projectId: ProjectId, input: BatchStartInput): BatchDto[];
convertShape(id: ShapeId, input: ShapeConvertInput): Promise<ShapeConvertOutcome>;
// apps/daemon/src/daemon/shape-services.ts
export function createShapeServices(deps: {
  readonly shape: ShapeService;
  readonly state: StateStore;
  readonly clock: Clock;
}): ShapeApiServices;
// Task 1
export function listAcceptedProposals(db: DbReader, id: ShapeAcceptId): ShapeProposalRow[];
```

**Implements**, as the index's Interfaces (New) quote them:
- `startCounts`, `StartCountTask` and `buildStartCounts`;
- `ShapeService.startCounts`;
- `ApiServices.shapeStartCounts`;
- `ShapeConvertInput.start`, `ShapeStartOutcome`, `ShapeConvertResult.start` and `ShapeStartCountsDto`;
- `createShapeServices`'s `startTasks` dep.

## Which tasks start

Take the tasks this Accept **made**: the task links under the proposals whose `accept_id` is the outcome's
`acceptId` (`listAcceptedProposals(state.db, acceptId)`, with their `shape_links`), and only goal and task
proposals. A `change_task` or `remove_task` target is never one. With `acceptId` null (`createdNow` 0), nothing
starts.

Then, in dependency order (a task after the tasks it waits on), each task is judged by these rules in turn:

1. **Pull-request delivery.** A task starts when each task it waits on is finished, or is itself starting in
   this call and runs **in the same place** (`workspaceMode`).
   - A dependency on an unfinished task outside the start: it goes in `left` as "waits for <title>".
   - A dependency in the start that runs in another place: it goes in `left` as "waits for <title>, which runs in
     another place". `refuseCrossPlacementDependency` would refuse the whole start otherwise.
2. **Local delivery.** A task starts only when it waits on nothing unfinished. One that waits on a task in this
   call goes in `left` as "waits for <title>", since a local start has no batch to queue it in.
3. **The cap.** Past 50 starting tasks (`BatchStartInput`'s cap), the rest go in `left` as "a start takes at most
   50". Their dependents go too, by rule 1.

"Finished" is `unfinishedDependencies`'s own rule (`delivery/deps.ts`), so the selection never sends the starter
a task it would refuse for that reason. Reach it through the delivery module's entry point.

## Files

### `apps/daemon/src/shape/start-counts.ts` (new, pure)

`startCounts` applies rules 1-3 in order, using each task's `place`:
- `stay` gets the left tasks, with why;
- `startKeys` gets the tasks that start.

Among the starting tasks:
- `forOthers` counts those with a non-empty `waitsOnStart`;
- `now` counts the rest that are in `startsAtOnce`;
- `forLane` counts every other starting task, including one the simulation holds back for an area clash.

The same function decides the start, through `startKeys` with ids in place of keys, and the confirm. So the
confirm says what the start will do.

### `apps/daemon/src/shape/preview.ts`

`buildStartCounts(db, shapeId, proposalIds, now)`:
- builds the same `existing` and `draft` items as `buildPreview`, with `draftItems` restricted to the given
  pending proposals (a new optional filter argument);
- runs `simulateFactory(project.maxLanes, …)`;
- `startsAtOnce` is every draft item whose bar has `startHours === 0`;
- each draft task's `place` is `proposePlacement(project, { areas, kinds: [] }).workspaceMode`, as Convert will
  place it;
- `waitsOutside` resolves `dependsOnOutside` and converted keys to their tasks, keeping the unfinished ones;
- calls `startCounts` with `local: project.delivery !== Delivery.PullRequest` and `cap: 50`;
- writes nothing.

### Contracts: `packages/contracts/src/shape-view.ts`

The four contract changes named under Implements.

### `apps/daemon/src/shape/service.ts`

- `convert(shapeId, proposalIds, options?: { cut?: readonly MilestoneCut[] })` keeps its signature. Accept and
  Start stays outside the shape service, which has no starter.
- Add `startCounts(shapeId, proposalIds): ShapeStartCountsDto`, `buildStartCounts` over `state.db` with the
  service's clock.

### `apps/daemon/src/daemon/shape-services.ts`

The deps gain the `startTasks` closure:

```ts
readonly startTasks: (
  projectId: ProjectId,
  title: string,
  taskIds: readonly TaskId[],
) => Promise<void>;
```

After a converted outcome with `input.start === true`, `convertShape(id, input)`:
- with `acceptId` null, answers `start: { started: [], left: [], refused: null }`;
- otherwise computes the start set from the Accept's made tasks, read now as `TaskDto`s with their placements.
  It runs `startCounts` with `startsAtOnce` empty, since only `startKeys` and `stay` matter here;
- awaits `startTasks(projectId, getShape(state.db, id).title, startIds)` when the set is non-empty;
- answers `result.start` as `{ started, left, refused }`:
  - `started` is read afterwards as the tasks of the set that now have a run, so a local start stopped part-way
    reports truly;
  - **every error after the Accept committed becomes `refused`.** A `DomainError` gives its message. Anything
    else gives "The start failed; the daemon's log says why", and the error is logged with the shape and task
    ids. Nothing is rethrown, because the Accept stands.

### `apps/daemon/src/daemon/start.ts`

Wire `startTasks` as a closure that reads `services` at call time, as `startFollowUps` does (around line 2600):

```ts
async (projectId, title, taskIds) => {
  await services.settleSizing(taskIds);
  const project = getProject(db, projectId);
  if (project.delivery === Delivery.PullRequest)
    services.startBatch(projectId, { title, taskIds: [...taskIds] });
  else for (const id of taskIds) services.startTask(id);
}
```

`startBatch` splits the tasks into a shared batch and per-group worktree batches by placement, as Start Ready
Tasks' sheet does through the same route.

### Route: `GET /shapes/:shapeId/start-counts`

- The query is `proposalIds`, comma-separated, parsed with zod into `ShapeProposalId`s (one or more).
- `deps.services.shapeStartCounts(shapeId, ids)` answers `ShapeStartCountsDto`.
- `RENDER_REFUSED_READS` (`screens/render-access.ts`): "Only the 10db app's Accept confirm reads it."
- `DEV_UI_REFUSED_READS` (`screens/dev-ui-access.ts`): "Only the 10db app's Accept confirm reads it."
- `api/render-reads.test.ts` must pass.

## State-table rows

Every row of the index's "Accept and Start" table with owner 3, and the Undo row "Accept and Start is waiting in
`settleSizing`" (its start half).

## Tests

In `apps/daemon/src/shape/start-counts.test.ts`, one test, a pure rule table: "start counts follow dependencies,
places, lanes, local delivery and the 50 cap". Rows:

- two independent tasks with both at once, giving `now: 2`;
- a task waiting on one in the start in the same place (pull request), giving `forOthers: 1`;
- the same in another place, giving `stay` "…, which runs in another place";
- the same-place pair in local delivery, giving `stay` "waits for …";
- a task waiting outside, giving `stay`;
- 51 independent tasks, giving one "a start takes at most 50";
- a task the simulation holds (not at once), giving `forLane: 1`.

Prove it red with the place check removed. The commit carries one value card with `why_new=pure rule table`.

The start itself goes through the e2e (Task 6), through the real starter.

## Done when (the run before the daemon review)

- The test passes, and was proved red. `vitest related src/shape/start-counts.ts src/shape/preview.ts
  src/daemon/shape-services.ts --run --maxWorkers=2` and `api/render-reads.test.ts` pass.
- **A dev-daemon smoke on two projects.** Run `src/main.ts` on the fake adapter, with a scratch data directory and
  repositories, as Task 3 of slice 2 did, and drive it with curl:
  - **a local-delivery project:** `GET …/start-counts`, then `convert` with `start: true`;
  - **a pull-request-delivery project:**
    - a plan with a dependent pair in the same place, which should start as one batch;
    - a task that waits on an unfinished Board task, which should be in `left`;
    - then `convert` with `start: true`, and `GET /projects/:id/batches` showing the batch `startBatch` made.

  Paste every response in the report.
- `make precheck` is green.
