# Plan in Sessions, slice 3: Accept and Start, Undo Accept, live states

**Spec:** `docs/superpowers/specs/2026-11-19-10db-plan-in-sessions-design.md` §10 slice 3, built on §1 (the
Accepted and Running states), §1.1 (the rows for Accept and Start and Undo Accept), §2 ("After Accept"), §5 and §8
("New: an Accept record"). **Lands with** slice 2 in pull request #718, on `feat/plan-in-sessions-s2-s3`.

## Brief

**What changes for you.**
- The panel's Accept becomes **Accept ▾** with two items, **Accept** and **Accept and Start**.
- Accept and Start puts the ticked work on the Board and starts what is ready, as Start Ready Tasks does. Its
  confirm says first what will happen: "4 start now; 3 wait for a lane, 2 for other tasks".
- Each accepted row then reads **On the Board** with its live state, from the same events the Board uses: Ready,
  Waiting, Queued, Running, In review, Needs you, Done or Removed. A goal says how many of its tasks are in each,
  and the row's dot moves from Accepted to Running to Done. A click opens the task on the Board.
- The panel's ⋯ gains **Undo Accept**. It takes back the last Accept's new goals and tasks, withdraws its
  decisions and principles, and makes those rows proposed again, while none of its tasks has a run. Once one
  has, the item is shown disabled with the reason ("Drop the Abandon strip has started; cancel its run and
  remove it from the Board first").

**What it buys.** You plan, accept and start in one place, and watch the work run from the conversation that
planned it. An Accept you regret costs one click instead of removing each goal and record by hand.

**What could go wrong, and how we'd know.**
- Undo removes more than this Accept wrote. It reads only the Accept's own record, refuses whenever a task it
  would remove has any run, an open task outside it waits on one, or one of its goals holds a task it didn't
  make, and runs in one write. Two core tests on a real
  database check that another Accept's rows, a Board task this Accept changed, and another plan's rows survive,
  and that a refusal leaves everything as it was.
- Accept and Start floods the factory. It starts through the starter Start Ready Tasks uses, so the scheduler
  holds work to the project's lanes, and the confirm's counts come from the same lane simulation as the panel's
  preview.
- Accept succeeds and the start fails. The Accept stands: the tasks wait on the Board, and the modal says what
  refused the start, in the starter's own words for a refusal and in a plain line, with a log entry, for anything
  else. A failure after the answer, such as a dirty checkout at the
  cut, is a card, as for any start.

**Calls you might disagree with.**
1. **Undo takes back only the latest Accept.** An earlier one is undone by undoing the later ones first. An
   Accept that depends on an earlier one can't be left dangling, and the record stays a simple stack. Cost if
   wrong: one more click per Accept to reach an older one.
2. **Any run blocks Undo**, a queued, held or refused one included. Undo checks this before the store's own
   rule, so it never cancels a run and never leaves a branch, batch or worktree behind. Undo after Accept and
   Start therefore waits until each such task's run is cancelled and the task removed from the Board ("<title>
   has started; cancel its run and remove it from the Board first"); Undo then skips the removed task. Cost if
   wrong: you cancel and remove those tasks before you can undo.
3. **Some tasks aren't started, and stay on the Board:** any task the starter would refuse, rather than refusing
   the whole start. That covers:
   - a task waiting on unfinished work outside this start (`unfinishedDependencies`);
   - a task waiting on a task that runs in another place, Your folder against a separate copy
     (`refuseCrossPlacementDependency`);
   - in a project that delivers locally, a task waiting on another task in the same start, since a local start
     has no batch to queue it in.

   The confirm lists each one with why, and you start them from the Board later.
4. **The live words are the ones Factory's task list and the task drawer use for a task's state:** Ready,
   Waiting, Queued, Running, In review, Needs you, Done and Removed. The spec names four (Queued, Running, Ready,
   Done), but its "Ready" beside Done reads as "finished", while everywhere else in 10db Ready means "not started".
   The row's dot keeps to the spec's own dot states: Accepted, then Running while any task runs, then Done when
   all are done.
5. **At most 50 tasks start at once** (`BatchStartInput`'s cap). Past that, the confirm says how many stay on the
   Board.
6. **Accept and Start isn't atomic.** The Accept is one write and the start is the starter's own, so a refused
   start leaves the Accept standing. That matches Start Ready Tasks, whose refusal leaves the tasks on the Board.
7. **Accepts made before this slice can't be undone.** Their rows have no Accept record. Remove Draft Goal and the
   Withdraws still work on them.
8. **Undo leaves a record it can't take back, and says so.** A decision superseded since, a principle replaced
   since, and a landing group holding a task with a run are left as they are and counted as "stays". A record
   already withdrawn counts as taken back. None of these refuses the Undo, so an older Accept is never locked
   behind it.
9. Source-file links to goals (§8) and the approved mark on mock-ups wait for slice 4. The migration here adds
   only the Accept record.

**Needed from you:** nothing. Calls 1-4 and 8 are rulings logged in the run's ledger; screenshots of the Accept ▾
menu, the confirm with counts, live rows and the Undo confirm come with the e2e.

## Global constraints

- Root `AGENTS.md`, `.claude/rules/code-style.md` and `.claude/rules/testing.md` bind every card. Read the
  `AGENTS.md` of each directory you touch once, and keep notes in your scratch folder.
- **Tracks.**
  - **A, daemon:** `apps/daemon`, `packages/db` and `packages/contracts`.
  - **B, desktop:** `apps/desktop`.
  - Both tracks share the worktree `../10db-worktrees/plan-s23`. An agent stages only its own paths, by name.
- **At most two implementers at once, and a fresh implementer per card.** A card's fix rounds go to the
  implementer that wrote it.
- **Core cards** (Tasks 1 and 2: data loss, claims, migrations) go in small red-first steps on a real SQLite file
  (`createTestStore` or the shape test world), with no mocks of 10db's own code. Every other card is wiring and
  views: no unit tests beyond those it names, and it is checked by the e2e.
- **Migration.**
  - The schema change is one generated migration (`pnpm --filter @10db/db generate`), made in Task 1 so the code
    can run.
  - Migrations are forward-only since v0.1.0. Never edit a generated file by hand.
  - **After the branch's final merge of `main`, Task 7 always deletes this branch's migration and generates it
    again**, whether or not `main` gained one, and diffs the new SQL against Task 1's (saved in Task 1's scratch
    folder). It is unshipped, so this is the branch's own file. If `main` gained a migration, the merge takes
    `main`'s side of `meta/_journal.json` and its snapshots, with `git show origin/main:<path> > <path>`, since a
    subagent may not run `git checkout -- <path>`.
  - Before Task 1 and again in Task 7, `gh pr list` must show no other open pull request adding a file under
    `packages/db/drizzle/`.
- **Nothing here changes the trust surface.** Accept, Accept and Start and Undo Accept are 10db's own writes from
  the builder's app token. No agent tool reaches them, and `propose_plan` gains nothing.
- **Routes.**
  - Every new GET is named in `RENDER_REFUSED_READS` (`screens/render-access.ts`) and in `DEV_UI_READS` or
    `DEV_UI_REFUSED_READS` (`screens/dev-ui-access.ts`), each with a reason. `api/render-reads.test.ts` fails
    until it is.
  - POST routes need no entry.
- **knip:** `ignoreExportsUsedInFile` is on. A card that exports something only a later card uses names it under
  "Transitional exports", or that later card's push fails.
- Docs never cite a path under the decisions folder before its file exists. Value-card footer lines stay under
  100 characters. Never run `prettier --write` over `apps/daemon/src` as a whole.
- **Checks while working:** `vitest related <files> --run --maxWorkers=2` (for `chat/hooks.ts` and
  `daemon/start.ts`, run the module's directories instead), typecheck and lint of what changed. Before a push,
  `make precheck`. The suite runs in CI.
- **Run before review.** The daemon review starts when Task 3 lands, after Task 3's dev-daemon smoke has run on a
  local project and on a pull-request project. The desktop review starts after the e2e is green against the
  real daemon.
- **E2E:** extend the New Plan test in `apps/desktop/e2e/sessions.spec.ts`, never a new spec. Its `archive()`
  already waits for the screen to leave the session. A spec must leave no run active and no plan session open at
  its end.

## Provider parity

| Feature | Claude plan | Bedrock / API key | Codex plan |
| --- | --- | --- | --- |
| Accept ▾, Accept and Start, the confirm's counts | 10db's own writes and starter | same | same |
| The started tasks' lanes | run on the project's account, as Start Ready Tasks' do | same | same |
| Undo Accept | 10db's own write | same | same |
| Live states on accepted rows | the Board's task and run events | same | same |

No feature asks an agent anything. A lane that the provider can't run fails the same way a Board start fails
there.

## Interfaces

Quoted from the code on the branch. **New** marks what a card adds; its card owns the exact shape.

### Existing, called or changed

```ts
// apps/daemon/src/shape/convert.ts
export function convertProposals(
  ctx: WriteContext,
  shapeId: ShapeId,
  proposalIds: readonly ShapeProposalId[],
  joiningProblem: JoiningProblem = () => null,
  cut?: readonly MilestoneCut[],
): ConvertOutcome;
export interface ConvertedRow {
  readonly key: string;
  readonly kind: ShapeProposalKind;
  readonly goalId?: GoalId;
  readonly taskIds: readonly TaskId[];
  readonly decisionId?: DecisionId;
  readonly principleId?: PrincipleId;
  readonly questionId?: ShapeQuestionId;
}

// apps/daemon/src/shape/undo.ts
export function removeDraftGoalOf(ctx: WriteContext, shapeId: ShapeId, goalId: GoalId): void;

// apps/daemon/src/shape/service.ts (ShapeService)
convert(
  shapeId: ShapeId,
  proposalIds: readonly ShapeProposalId[],
  options?: { cut?: readonly MilestoneCut[] },
): Promise<ConvertOutcome>;

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

// apps/daemon/src/delivery/deps.ts, delivery/placement.ts, delivery/start.ts (BatchStarter)
export function unfinishedDependencies(
  db: DbReader,
  tasks: readonly TaskDto[],
  inBatch: ReadonlySet<TaskId>,
): BlockedTask[];
export function refuseCrossPlacementDependency(
  tasks: readonly TaskDto[],
  raise: (card: CardText, taskIds: readonly [TaskDto['id'], TaskDto['id']]) => void,
): void;
startBatch(projectId: ProjectId, input: BatchStartInput): BatchDto[];

// apps/daemon/src/placement/propose.ts
export function proposePlacement(project: ProjectPlacement, task: TaskTouches): PlacementProposal;

// packages/db/src/store/tasks.ts, goal-removal.ts, landing-groups.ts, shape-state.ts, decisions.ts
export function getTask(db: DbReader, id: TaskId): TaskDto;
export function cancelNeverStartedTask(ctx: WriteContext, id: TaskId): TaskDto;
export function removeDraftGoal(ctx: WriteContext, goalId: GoalId): void;
export function insertLandingGroup(
  ctx: WriteContext,
  input: {
    readonly projectId: ProjectId;
    readonly title: string;
    readonly taskIds: readonly TaskId[];
    readonly shapeId?: ShapeId;
  },
): LandingGroupDto;
export type ShapeProposalPatch = Partial<
  Pick<
    ShapeProposalRow,
    'state' | 'round' | 'createdRound' | 'pinned' | 'body' | 'taskHashes' | 'sourceMessageIds'
  >
>;
export function patchShapeProposal(
  ctx: WriteContext,
  id: ShapeProposalId,
  patch: ShapeProposalPatch,
): void;
export function deleteShapeLinksOf(ctx: WriteContext, proposalId: ShapeProposalId): void;
export function rekeyShapeAttachmentsToProposal(
  ctx: WriteContext,
  links: readonly Pick<ShapeLinkRow, 'shapeId' | 'key' | 'goalId' | 'taskId'>[],
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
export function withdrawDecision(
  ctx: WriteContext,
  id: DecisionId,
  input: { readonly by: string; readonly reason: string; readonly sourceId?: SourceId | null },
): void;

// apps/daemon/src/knowledge/records.ts
export function withdrawPrincipleRecord(
  ctx: WriteContext,
  id: PrincipleId,
  reason: string,
  source: KnowledgeSource | undefined,
): PrincipleItem;

// packages/contracts/src/shape-view.ts
export const ShapeConvertInput = z.object({
  proposalIds: z.array(ShapeProposalId).min(1),
  cut: z.array(MilestoneCut).optional(),
});
export const ShapeConvertResult = z.object({
  createdNow: z.int().min(0),
  results: z.array(ShapeConvertedRow),
});

// apps/desktop/src/daemon/events.ts
export const INVALIDATIONS: Readonly<Record<string, readonly QueryKey[]>>; // keyed by entity: task, workstream, …

// apps/desktop/src/daemon/shape-queries.ts, daemon/queries.ts
export function useConvertShape(shapeId: ShapeId); // mutation: { proposalIds, cut? } → ConvertShapeResult
export function useTasks(projectId: ProjectId | null);
export function useWorkstreams(filter: { readonly active: boolean });

// apps/desktop/src/views/board/task-state.ts
export function taskState(
  workstream: WorkstreamDto | undefined,
  batch: BatchDto | undefined,
  gateCommand: string | null,
  place?: number,
  batches?: readonly BatchDto[],
  task?: RetryTask,
): TaskState | null;
```

### New

```ts
// packages/contracts/src/ids.ts — prefix 'sac'
export const ShapeAcceptId; export type ShapeAcceptId;

// packages/db/src/schema.ts
// shape_accepts: id, shape_id → shapes, undone_at (null until undone), created_at, updated_at;
//   index on shape_id.
// shape_proposals.accept_id → shape_accepts, null: the Accept that accepted it. Meaningful only on a row whose
//   state is accepted; every path that makes a row pending again (Remove Draft Goal, Undo Accept) clears it,
//   and readers filter by state as listAcceptedProposals does.
// landing_groups.accept_id → shape_accepts, null: the Accept that made the group.

// packages/db/src/store/shape-accepts.ts (Task 1)
export type ShapeAcceptRow = typeof schema.shapeAccepts.$inferSelect;
export function insertShapeAccept(ctx: WriteContext, shapeId: ShapeId): ShapeAcceptRow;
/** The newest Accept of the plan that is not undone, or undefined. */
export function latestShapeAccept(db: DbReader, shapeId: ShapeId): ShapeAcceptRow | undefined;
export function markShapeAcceptUndone(ctx: WriteContext, id: ShapeAcceptId): void;
/** The proposals an Accept accepted that are still accepted under it. */
export function listAcceptedProposals(db: DbReader, id: ShapeAcceptId): ShapeProposalRow[];
// ShapeProposalPatch gains 'acceptId'; insertLandingGroup's input gains `readonly acceptId?: ShapeAcceptId`.

// packages/db/src/store/landing-groups.ts (Task 1)
/** Clears the group's tasks' landing_group_id, then deletes the group. */
export function deleteLandingGroupOf(ctx: WriteContext, id: LandingGroupId): void;
/** Takes one task out of its group (landing_group_id null); the group stays. */
export function leaveLandingGroup(ctx: WriteContext, taskId: TaskId): void;

// packages/db/src/store/shape-state.ts (Task 2)
/** Deletes a question Convert stored, and its link; its proposal is the caller's to reset. */
export function releaseShapeQuestion(ctx: WriteContext, questionId: ShapeQuestionId): void;

// apps/daemon/src/shape/convert.ts (Task 1): convertProposals's ok outcome gains the Accept it recorded.
//   | { readonly ok: true; readonly createdNow: number; readonly results: readonly ConvertedRow[];
//       readonly acceptId: ShapeAcceptId | null }   // null when createdNow is 0

// apps/daemon/src/shape/undo.ts (Task 2)
export interface UndoneAccept {
  readonly goals: number; readonly tasks: number; readonly decisions: number;
  readonly principles: number; readonly questions: number;
  /** What this Accept wrote that Undo leaves: changes and removals of Board tasks, a decision superseded or a
   *  principle replaced since, a landing group holding a task with a run. */
  readonly kept: number;
}
export function undoAccept(ctx: WriteContext, shapeId: ShapeId, acceptId: ShapeAcceptId): UndoneAccept;

// apps/daemon/src/shape/service.ts (ShapeService; Tasks 2-3)
undoAccept(shapeId: ShapeId, acceptId: ShapeAcceptId): UndoneAccept;
startCounts(shapeId: ShapeId, proposalIds: readonly ShapeProposalId[]): ShapeStartCountsDto;

// apps/daemon/src/api/services.ts (ApiServices; Tasks 2-3), in ShapeApiServices too
undoShapeAccept(shapeId: ShapeId, acceptId: ShapeAcceptId): ShapeUndoAcceptResult;
shapeStartCounts(shapeId: ShapeId, proposalIds: readonly ShapeProposalId[]): ShapeStartCountsDto;

// packages/contracts/src/shape-view.ts (Task 2)
export const ShapeAcceptDto = z.object({
  id: ShapeAcceptId,
  at: Timestamp,
  goals: z.int().min(0),
  /** Every task it made: a goal's tasks and loose tasks alike, so a goal-only Accept reads "1 goal, 2 tasks". */
  tasks: z.int().min(0),
  records: z.int().min(0),
  /** What Undo would leave, counted as undoAccept counts `kept`: change and remove_task proposals, superseded or
   *  replaced records, landing groups holding a task with a run or one it didn't make. */
  kept: z.int().min(0),
  /** Every task it made, so the app can tell from its cached runs whether Undo would be refused. */
  taskIds: z.array(TaskId),
});
// ShapeViewDto gains `lastAccept: ShapeAcceptDto.nullable()` — the newest Accept not undone.
export const ShapeUndoAcceptResult = z.object({
  goals: z.int().min(0), tasks: z.int().min(0), decisions: z.int().min(0),
  principles: z.int().min(0), questions: z.int().min(0), kept: z.int().min(0),
});
// POST /shapes/:shapeId/accepts/:acceptId/undo → 200 ShapeUndoAcceptResult; 409 with the refusal's words
//   (a task has a run, an outside task waits on one, a goal holds a task it didn't make, a batch is being cut);
//   400 for an Accept that is undone already or is not the latest.

// packages/contracts/src/shape-view.ts (Task 3)
// ShapeConvertInput gains `start: z.boolean().optional()`.
export const ShapeStartOutcome = z.object({
  /** Tasks that got a run from this start; their runs queue through the scheduler. */
  started: z.array(TaskId),
  /** Tasks left on the Board, with why: "waits for <title>", "waits for <title>, which runs in another place",
   *  "a start takes at most 50". */
  left: z.array(z.object({ taskId: TaskId, title: z.string(), why: z.string() })),
  /** Why the start stopped, when it did: a DomainError's message, or a plain line (the cause is logged).
   *  The Accept stands either way. */
  refused: z.string().nullable(),
});
// ShapeConvertResult gains `start: ShapeStartOutcome.optional()` (present when `start` was asked).
export const ShapeStartCountsDto = z.object({
  now: z.int().min(0),
  forLane: z.int().min(0),
  forOthers: z.int().min(0),
  /** Tasks this start leaves on the Board, with why, as `ShapeStartOutcome.left` will say. */
  stay: z.array(z.object({ title: z.string(), why: z.string() })),
});
// GET /shapes/:shapeId/start-counts?proposalIds=<id,id,…> → ShapeStartCountsDto

// apps/daemon/src/shape/start-counts.ts (Task 3), pure
export interface StartCountTask {
  readonly key: string;
  readonly title: string;
  /** Where it will run: WorkspaceMode, from its placement (or proposePlacement before Accept). */
  readonly place: WorkspaceMode;
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
  readonly cap: number; // 50
}): ShapeStartCountsDto & { readonly startKeys: readonly string[] };

// apps/daemon/src/shape/preview.ts (Task 3)
export function buildStartCounts(
  db: DbReader,
  shapeId: ShapeId,
  proposalIds: readonly ShapeProposalId[],
  now: Date,
): ShapeStartCountsDto;

// apps/daemon/src/daemon/shape-services.ts (Task 3): createShapeServices's deps gain
//   readonly startTasks: (
//     projectId: ProjectId, title: string, taskIds: readonly TaskId[],
//   ) => Promise<void>;   // throws what the starter throws; wired in daemon/start.ts over
//   services.settleSizing, services.startBatch (pull-request delivery) or services.startTask (local).

// apps/desktop/src/daemon/shape-queries.ts (Task 4)
export function useStartCounts(
  shapeId: ShapeId,
  proposalIds: readonly ShapeProposalId[],
  enabled: boolean,
): UseQueryResult<ShapeStartCountsDto>;
export function useUndoAccept(
  shapeId: ShapeId,
): UseMutationResult<ShapeUndoAcceptResult, Error, ShapeAcceptId>;
// useConvertShape's input gains `start?: boolean`.

// apps/desktop/src/views/sessions/plan/live-state.ts (Task 5), pure
export interface LiveWord { readonly word: string; readonly color: string }
export function taskLiveWord(task: TaskDto | undefined, workstream: WorkstreamDto | undefined): LiveWord;
export function goalLiveLine(words: readonly LiveWord[]): string; // "2 running · 1 queued · 1 done"
/** 'running' while any word is Running; 'done' when every task not Removed is Done; else null (Accepted). */
export function liveDot(words: readonly LiveWord[]): 'running' | 'done' | null;
```

## State × event table

Design, not a test list: only the core cards' named tests cover rows.

### Accept and Start

| State | Event | Outcome | Owner |
| --- | --- | --- | --- |
| Rows ticked, Accept ▾ → Accept and Start | Confirm opens | Counts from `GET …/start-counts` for the ticked rows: now, for a lane, for other tasks, and the stay list. They are fetched again when the ticks change, and on task and run events. | 3, 4 |
| Confirm open | A round lands | New rows arrive ticked, as Accept's do. The counts refetch for the new ids. | 4 |
| Confirm open | Nothing ticked would start | The counts line reads "Nothing to start", and the button reads "Accept n". | 4 |
| Accept and Start pressed | Free lanes fewer than the ready tasks | Accept writes. The starter takes every startable task; the scheduler runs as many as there are lanes, and the rest stay Queued. | 3 |
| Accept and Start | A task waits on another task in the start (pull request, same place) | It is started in its dependency group's batch and stays Queued until that task ends. | 3 |
| Accept and Start | A task waits on a task in the start that runs in another place | It isn't started, so the start isn't refused (`refuseCrossPlacementDependency`). It goes in `left` as "waits for <title>, which runs in another place". | 3 |
| Accept and Start | A task waits on unfinished work outside the start | It isn't started and goes in `left` as "waits for <title>". It stays Ready or Backlog on the Board. | 3 |
| Accept and Start, local delivery | A task waits on another task in the start | It isn't started and goes in `left`. The tasks with nothing to wait on start one by one through `startTask`. | 3 |
| Accept and Start | More than 50 startable | The first 50, in dependency order, start. Their dependencies are within them or finished. The rest go to `left` as "a start takes at most 50". | 3 |
| Accept and Start | The Convert made nothing new (`createdNow` 0, `acceptId` null) | No start is tried. `start` is `{ started: [], left: [], refused: null }`, and the modal says "Nothing new to start". | 3, 4 |
| Accept and Start | The starter throws a DomainError at once (a pass holds a task, a join pending, a task cancelled meanwhile) | The Accept stands. `start.refused` carries the message, and the modal shows it and closes on Done. The rows read On the Board · Ready. | 3, 4 |
| Accept and Start | Any other error after the Accept committed | The Accept stands. `refused` is "The start failed; the daemon's log says why", and the cause is logged. | 3 |
| Accept and Start | The cut fails later (dirty checkout, branch exists) | It becomes a card, as for any start. The rows show the run's state (Needs you, or Removed if the card's Cancel task removes it). | 5 |
| Accept and Start | A turn is running | As for Accept: the turn goes on, and the start runs after the Accept's write. | 3 |
| Accept and Start in flight | The builder archives the session | Archive retires the session only. The Accept and the start are 10db's own writes, so they finish, and the tasks run. Reopening shows the rows' live words. | — |
| Daemon restarts mid-Accept and Start | The Accept committed and the start had not | The rows wait on the Board. Nothing resumes the start; the builder uses Start Ready Tasks. | 3 |
| Daemon restarts mid-cut | — | As for any start: the CUTTING batch's queued runs are cancelled, and the tasks are Ready again. | — |

### Live states

| State | Event | Outcome | Owner |
| --- | --- | --- | --- |
| Rows accepted | Task or run event (`task.changed`, `workstream.changed`, `batch.changed`) | The row's word and dot follow from the cached tasks and workstreams. No polling, and no refetch of the shape view. | 5 |
| Accepted row | A task starts running | The dot goes from Accepted to Running; when every task not Removed is Done, it goes to Done. | 5 |
| Accepted row | Builder clicks Open on Board | The Board opens with the task's drawer (`/board?task=<id>`). A goal opens its first task that isn't done, else Factory's goal. | 5 |
| Accepted task | Removed from the Board | The row reads On the Board · Removed. Undo Accept skips it: its task is already cancelled. | 2, 5 |

### Undo Accept

| State | Event | Outcome | Owner |
| --- | --- | --- | --- |
| `lastAccept` present, none of its tasks has a run in the cache | ⋯ | Undo Accept is enabled. The confirm lists what goes ("1 goal, 2 tasks; withdraws 1 decision"), counting a goal's tasks, and what stays ("1 stays"). | 4 |
| `lastAccept` present, one of its tasks has a run | ⋯ | Undo Accept is shown disabled, with "<title> has started; cancel its run and remove it from the Board first" as its reason. | 4 |
| Undo pressed | Nothing it made has a run | In one write: goals and tasks removed, decisions and principles withdrawn, questions released. The proposals are pending again with `accept_id` cleared, the plan is Proposed, the Accept is marked undone, and the transcript gets a note. | 2 |
| Undo pressed | One of its tasks has any workstream row (queued, held, or cancelled before a session) | 409 "<title> has started; cancel its run and remove it from the Board first". Undo checks this itself, before the store's own rule, so no run is ever cancelled. Nothing changes. | 2 |
| Undo pressed | An open task outside this Accept waits on one of its tasks | 409 naming the dependent. Nothing changes. | 2 |
| Undo pressed | One of its goals holds a task, not cancelled, that isn't linked under this Accept's proposals (a pass's page, a task added on the Board) | 409 "<goal> holds <task>, which this Accept didn't make". Nothing changes. | 2 |
| Undo pressed | A decision it wrote was withdrawn since, or a principle withdrawn or retired | Counted as taken back: skipped, with its links deleted. | 2 |
| Undo pressed | A decision it wrote was superseded since, or a principle replaced | Left as it is and counted in `kept`. Never a refusal, so earlier Accepts are never locked behind it. | 2 |
| Undo pressed | A landing group it made holds a task with a run, or one not made by this Accept | The group stays and is counted in `kept`. This Accept's cancelled tasks leave it (`leaveLandingGroup`). | 2 |
| Undo pressed | The Accept is not the plan's latest not-undone one (another window accepted meanwhile) | 400 "Undo the later Accept first". The modal shows it, and the view refetches to the new `lastAccept`. | 2, 4 |
| Undo pressed | The Accept was undone already (two windows) | 400 "This Accept was undone". | 2 |
| Undo pressed | Remove Draft Goal already took one of its goals | That goal's proposal is pending with `accept_id` cleared (Task 1), so Undo skips it. | 1, 2 |
| Undo pressed | The Accept also changed or removed Board tasks | Those changes stay, and their proposals stay accepted under the Accept, which is still marked undone. `kept` counts them. | 2 |
| Undo pressed | An unrelated batch is being cut | The store refuses removing a task during a cut. Undo says "A batch is being cut; try Undo Accept again once it has started". Nothing changes. | 2 |
| Undo pressed | Accept and Start is waiting in `settleSizing`, before its start | Undo has nothing to refuse, so it removes the tasks. The start's `checkStartable` then refuses "Task <title> is cancelled", which becomes `start.refused`. | 2, 3 |
| Undo pressed | Its tasks' cut was refused earlier (runs cancelled before a session, a start-refused card open) | Refused by the workstream check, "<title> has started; cancel its run and remove it from the Board first". The card's Cancel task removes the task, and then Undo skips it. The card is not changed. | 2 |
| Undo pressed | The scheduler or a Board start runs at the same time | Writes are serialized and each start checks and writes in one synchronous step. Either the task already has its run, and Undo refuses, or Undo cancels it first, and the start refuses the cancelled task. | 2 |
| Undo pressed | A turn is running | It goes ahead, as Accept does. The next round sees the rows pending. | 2 |
| Undone | Accept again | New tasks and a new Accept record. Undo applies to the new one. | 1 |
| Two Accepts | Undo twice | The latest, then the one before it. | 2 |
| Session archived | Reopen | The plan, its Accepts and Undo are as they were. | — |

## Tracks

- **Track A, daemon:** Task 1 (core), then Task 2 (core), then Task 3.
- **Track B, desktop:** Task 5 needs nothing new from the daemon, so it starts beside Task 1. Task 4 starts once
  Task 3 is on the branch, since it uses both its contracts and Task 2's. Then Task 6, the e2e.
- **Reviews:** the daemon review starts when Task 3 lands, after its dev-daemon smoke on a local and a
  pull-request project, beside Task 4. The desktop review starts after Task 6 has run green against the real
  daemon.
- **Task 7** (docs, and the migration deleted and generated again after the final merge of `main`) comes last.

| # | Track | Task | Card |
| --- | --- | --- | --- |
| 1 | A, core | The Accept record: `shape_accepts`, `accept_id` on proposals and landing groups, the migration, Convert recording each Accept, Remove Draft Goal clearing it | `task-1.md` |
| 2 | A, core | Undo Accept: `undoAccept`, the route, `lastAccept` in the view; two core tests | `task-2.md` |
| 3 | A | Accept and Start: `start` on Convert, the starter wiring, `start-counts` (pure function, read, route, token lists); one rule-table test | `task-3.md` |
| 4 | B | Accept ▾ (Accept, Accept and Start with its counts), Undo Accept in ⋯ with its confirm and refusal | `task-4.md` |
| 5 | B | Live states and the live dot on accepted rows and goals, Open on Board | `task-5.md` |
| 6 | B | The e2e: Undo Accept, then Accept and Start with its counts, live words and Undo's refusal | `task-6.md` |
| 7 | — | Module notes, `db-storage.md`, the decision record, the spec's status, the final migration regeneration | `task-7.md` |
