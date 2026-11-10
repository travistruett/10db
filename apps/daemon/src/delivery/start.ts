import {
  ACTIVE_STATES,
  BatchStartInput,
  BatchState,
  ConflictError,
  Delivery,
  InvalidError,
  mintId,
  NotFoundError,
  TaskStatus,
  UNFINISHED_BATCH_STATES,
  WorkspaceMode,
  WorkstreamState,
  type BatchDto,
  type BatchId,
  type LandingGroupId,
  type ProjectDto,
  type ProjectId,
  type StepPlanDto,
  type TaskDto,
  type TaskId,
  type WorkstreamDto,
  type WorkstreamId,
} from '@10db/contracts';
import {
  BUILDER_CHOSE_PLACEMENT,
  deleteCuttingBatch,
  findUnfinishedBatch,
  getBatch,
  getBoardColumn,
  getProject,
  getTask,
  getWorkstream,
  getWorkstreamRow,
  insertBatch,
  listWorkstreams,
  patchBatch,
  passHoldingFolder,
  passHoldingTask,
  patchTask,
  placeTaskByRule,
  setBatchNotice,
  transitionBatch,
  type WriteContext,
} from '@10db/db';
import { githubRepoOf } from '../github';
import { proposePlacement, type PlacementProposal } from '../placement';
import {
  insertJoinedWorkstream,
  insertPlannedWorkstream,
  planForStart,
  retryWorkstream,
} from '../team';
import { batchBranchName } from './branch-name';
import { forTasks, startCards, wrongBranchCard, type Card, type StartRequest } from './cards';
import { batchCheckout, lanesInProjectCheckout } from './checkout';
import { ghCall, networkCall, raise, showNotice, type DeliveryContext } from './context';
import { unfinishedDependencies, unmergedDependencies, type BlockedTask } from './deps';
import { groupByDependency } from './grouping';
import { jobKey, JobQueue } from './jobs';
import { landingHold, planLandings, shippedLandingNotice } from './landing-join';
import { keptRevertOf } from './left-out-settle';
import { batchPlacement, placementWords, refuseCrossPlacementDependency } from './placement';
import { resolveStartCards } from './stale-cards';
import { forgetStartSiblings, recordStartSiblings, startSiblings } from './start-siblings';
import {
  joinsLanding,
  landingWarnings,
  missingLandingBranch,
  sharedLanding,
  type SameStart,
} from './landing';
import { cutWorktree, type CutTasks, type Plans } from './worktree-cut';
import { madeWorktreeRoot, worktreePathFor } from './worktree-path';
import { reopenWhenWhole, reopenWorktreeBatch } from './worktree-repair';

export interface BatchStarter {
  /**
   * Starts the tasks by each one's placement: the tasks in Your folder join the project's OPEN shared
   * batch (or, as fix tasks, its FAILED one), or else make it; the tasks in separate copies make one
   * new batch per dependency group. A `batchId` adds every task to that batch instead, in its
   * placement. Answers at once with the batches made or joined; git and gh checks finish in the
   * background, and their refusals are cards (batch delivery spec §5, task placement spec §5).
   */
  startBatch(projectId: ProjectId, input: BatchStartInput): BatchDto[];
  /**
   * One task in a pull-request project: in Your folder, a member of the open shared batch or a new
   * one titled after it; in a separate copy, always a new batch of its own.
   */
  startTask(taskId: TaskId): BatchDto;
  /**
   * Refuses while a join of the task is pending, from its start until the join writes or refuses: its
   * placement is the one the join will use (task placement spec §5). The store checks the rest.
   */
  refuseIfJoining(taskId: TaskId): void;
  /** What `refuseIfJoining` would refuse with, for a caller that reports refusals together. */
  joiningProblem(taskId: TaskId): string | null;
  /**
   * Throws what `startTask` would refuse, as if the batch `ending` had already ended, and writes
   * nothing (a refusal's card is raised as the start's own would be). Starting over checks this
   * before it abandons the failed attempt's batch, so a refused start leaves that batch as it was.
   */
  refuseStart(taskId: TaskId, ending: BatchId): void;
  /**
   * Cuts a CUTTING batch again, as the start that made it would have: the daemon stopped mid-cut and
   * startup recovery has cleared what that cut left (`recoverBatches`). Its tasks keep their
   * workstreams. A refusal raises its card as a first cut's does.
   */
  recut(batchId: BatchId): void;
  /**
   * Every Retry of a failed workstream, whichever screen asked: the run goes back to the queue and
   * its batch reopens (`reopen`). Refused while a join of its task is pending, since the join writes
   * a new run for the task and one-active-workstream would then refuse the join. Refused too when the
   * task moved to a placement its batch doesn't work in, saying why: a retry stays in the batch.
   */
  retry(id: WorkstreamId, note?: string): WorkstreamDto;
  /**
   * After a workstream Retry: a FAILED worktree batch reopens in the cut queue once its worktree is
   * whole. Any other batch is left as it is.
   */
  reopen(batchId: BatchId): void;
}

export function createBatchStarter(ctx: DeliveryContext): BatchStarter {
  const db = ctx.state.db;
  /**
   * The tasks of every join not yet written or refused. A join can't insert its workstreams with the
   * request, since its batch is open and the scheduler would launch them before the join's checks
   * finish, so this closes the window instead. It ends with the process, as the join's job does.
   */
  const joining = new Set<TaskId>();

  /** Queues a join, holding its tasks in `joining` until it writes or refuses. */
  function queueJoin(
    batch: BatchDto,
    tasks: readonly TaskDto[],
    plans: Plans,
    inBatch: ReadonlySet<TaskId>,
  ): void {
    for (const task of tasks) joining.add(task.id);
    ctx.jobs.run(jobKey(batch, JobQueue.Cut), async (signal) => {
      try {
        await join(batch.id, tasks, plans, inBatch, signal);
      } finally {
        for (const task of tasks) joining.delete(task.id);
      }
    });
  }

  /**
   * Runs a batch's cut as its job. The record of the batches of its start goes in the write that
   * opens or deletes the row, so a crash can't leave it; a shutdown mid-cut leaves both for `recut`.
   */
  function runCut(batch: BatchDto, run: (signal: AbortSignal) => Promise<void>): void {
    ctx.jobs.run(jobKey(batch, JobQueue.Cut), run);
  }

  const joiningText = (task: TaskDto): string =>
    `${task.title} is joining a batch; where it works and its areas can't change, and it can't start again, until it has joined or been refused`;

  function joiningRefusal(task: TaskDto): ConflictError {
    return new ConflictError(joiningText(task));
  }

  function refuseIfJoining(taskId: TaskId): void {
    if (joining.has(taskId)) throw joiningRefusal(getTask(db, taskId));
  }

  function joiningProblem(taskId: TaskId): string | null {
    return joining.has(taskId) ? joiningText(getTask(db, taskId)) : null;
  }

  /**
   * A retry stays in its batch, so it can't run where a task that moved says it will. Only a retry the
   * store would otherwise take is refused here; `retryWorkstream` answers the rest in its own words.
   */
  function refuseMovedRetry(id: WorkstreamId): void {
    const row = getWorkstreamRow(db, id);
    const task = getTask(db, row.taskId);
    if (row.state !== WorkstreamState.Failed || row.batchId === null) return;
    // A closed or parked task can't start over either, so `retryWorkstream` says why, as it checks first.
    if (task.status === TaskStatus.Cancelled || task.boardColumnId !== null) return;
    if (task.workstreamId !== id) return;
    const batch = getBatch(db, row.batchId);
    if (batch.state !== BatchState.Open && batch.state !== BatchState.Failed) return;
    if (batchPlacement(batch) === task.workspaceMode) return;
    const from = placementWords(batchPlacement(batch));
    const to = placementWords(task.workspaceMode);
    throw new ConflictError(
      landingHold(db, task, batch) ??
        `${task.title} is set to work in ${to}, but its failed run is in batch "${batch.title}" in ${from}, and a retry stays in its batch. Start over to run it in ${to}, or set it back to ${from} to retry it there.`,
    );
  }

  function reopen(batchId: BatchId): void {
    const batch = getBatch(db, batchId);
    if (batch.state === BatchState.Failed && batch.worktreePath !== null)
      reopenWorktreeBatch(ctx, batchId, 'a workstream was retried');
  }

  /** One part of a start: what it writes, in the start's one transaction, and the job it queues after. */
  interface StartStep {
    write(w: WriteContext): BatchDto;
    launch(batch: BatchDto): void;
  }

  function startBatch(projectId: ProjectId, raw: BatchStartInput): BatchDto[] {
    const input = BatchStartInput.parse(raw);
    const project = getProject(db, projectId);
    if (project.delivery !== Delivery.PullRequest)
      throw new InvalidError(`${project.name} delivers locally; start its tasks one at a time`);
    const tasks = input.taskIds.map((id) => getTask(db, id));
    for (const task of tasks) checkStartable(project, task);
    // Phase 1: every part is checked before any is written, so a refused start leaves no batch.
    const { steps, placement, proposals } = prepare(project, input, tasks, undefined);
    // Phase 2: one transaction writes each task's placement and every batch, then the jobs queue.
    const batches = ctx.state.write((w) => {
      for (const task of tasks) {
        const proposal = proposals.get(task.id);
        // The placement rule moved it, so the task says why, as a task the rule placed at its making.
        if (proposal) {
          placeTaskByRule(w, task.id, proposal);
          continue;
        }
        const mode = placement(task);
        if (task.workspaceMode !== mode) patchTask(w, task.id, { workspaceMode: mode });
      }
      const written = steps.map((step) => step.write(w));
      // A join returns a batch that is already open; only the CUTTING ones are this start's cuts.
      recordStartSiblings(
        w,
        written.filter((b) => b.state === BatchState.Cutting).map((b) => b.id),
      );
      return written;
    });
    steps.forEach((step, i) => {
      const batch = batches[i];
      if (batch) step.launch(batch);
    });
    return batches;
  }

  /**
   * Splits the tasks by placement (one shared part, one copy part per dependency group) or, for a
   * fix task sent with `batchId`, gives them that batch's placement. Each part is checked here; none
   * writes.
   */
  function prepare(
    project: ProjectDto,
    input: BatchStartInput,
    tasks: readonly TaskDto[],
    ending: BatchId | undefined,
  ): {
    steps: StartStep[];
    placement: (task: TaskDto) => WorkspaceMode;
    /** Tasks the placement rule moves out of Your folder at this start, with why. */
    proposals: ReadonlyMap<TaskId, PlacementProposal>;
  } {
    if (input.batchId !== undefined) {
      const copy = copyBatchOf(project, input.batchId);
      if (copy)
        return {
          steps: [prepareJoinWorktree(project, copy, tasks)],
          placement: () => WorkspaceMode.Worktree,
          proposals: new Map(),
        };
      // Anything else is the shared batch's join, or a refusal saying why it can't be.
      return {
        steps: [prepareShared(project, input.title, input.batchId, tasks, ending)],
        placement: () => WorkspaceMode.Shared,
        proposals: new Map(),
      };
    }
    refuseCrossPlacementDependency(tasks, (card, taskIds) => {
      raise(
        ctx.inbox,
        project.id,
        forTasks(card, taskIds, input.title ? { title: input.title } : {}),
      );
    });
    // A task of a landing whose batch is open joins it (Shape spec §10.4), where that batch works.
    const landings = planLandings(db, tasks, ending);
    const joinedMode = new Map<TaskId, WorkspaceMode>();
    const joinSteps = landings.joins.map(({ batch, tasks: joining }): StartStep => {
      const mode = batchPlacement(batch);
      for (const task of joining) joinedMode.set(task.id, mode);
      return mode === WorkspaceMode.Worktree
        ? prepareJoinWorktree(project, batch, joining)
        : prepareShared(project, batch.title, batch.id, joining, ending);
    });
    const proposals = passProposals(project, landings.rest);
    const inFolder = landings.rest.filter(
      (task) => task.workspaceMode === WorkspaceMode.Shared && !proposals.has(task.id),
    );
    const inCopies = landings.rest.filter(
      (task) => task.workspaceMode === WorkspaceMode.Worktree || proposals.has(task.id),
    );
    // Everything this request makes, so no batch of it counts another's tasks as use of its branch.
    const sameStart: SameStart = { tasks: new Set(tasks.map((t) => t.id)), batches: new Set() };
    return {
      steps: [
        ...joinSteps,
        ...(inFolder.length > 0
          ? [prepareShared(project, input.title, undefined, inFolder, ending, sameStart)]
          : []),
        ...prepareWorktrees(project, inCopies, sameStart, landings.titles),
      ],
      placement: (task) =>
        joinedMode.get(task.id) ?? proposals.get(task.id)?.workspaceMode ?? task.workspaceMode,
      proposals,
    };
  }

  /**
   * While a Workbench pass holds Your folder (W9), the tasks set to work there that the builder did
   * not place there go to a separate copy instead, as the placement rule proposes. One the builder
   * placed in the folder stays, and the shared start refuses it saying why.
   */
  function passProposals(
    project: ProjectDto,
    tasks: readonly TaskDto[],
  ): Map<TaskId, PlacementProposal> {
    const proposals = new Map<TaskId, PlacementProposal>();
    if (passHoldingFolder(db, project.id) === undefined) return proposals;
    for (const task of tasks) {
      if (task.workspaceMode !== WorkspaceMode.Shared) continue;
      if (task.placementReason === BUILDER_CHOSE_PLACEMENT) continue;
      const proposal = proposePlacement(
        { ...project, passHoldsFolder: true },
        { areas: task.areas, riskTags: task.riskTags, workspaceMode: WorkspaceMode.Shared },
      );
      if (proposal.workspaceMode === WorkspaceMode.Worktree) proposals.set(task.id, proposal);
    }
    return proposals;
  }

  /**
   * The project's batch `batchId` when it is a separate copy's; none when it is the shared batch's
   * or names no batch (the shared join answers for those). A batch of another project, or one that
   * has finished, is refused here saying so, since the shared join can't tell what is wrong with it.
   */
  function copyBatchOf(project: ProjectDto, batchId: BatchId): BatchDto | undefined {
    let batch: BatchDto;
    try {
      batch = getBatch(db, batchId);
    } catch (error) {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    }
    if (batch.projectId !== project.id)
      throw new ConflictError(`Batch "${batch.title}" is not a batch of ${project.name}`);
    // A finished copy may keep its worktree path (retiring keeps a worktree holding unseeded
    // ignored files), so the state alone decides; a shared batch's path is always null.
    if (!UNFINISHED_BATCH_STATES.includes(batch.state))
      throw new ConflictError(
        `Batch "${batch.title}" has finished; start these tasks again on their own`,
      );
    return batch.worktreePath !== null ? batch : undefined;
  }

  function prepareShared(
    project: ProjectDto,
    title: string,
    batchId: BatchId | undefined,
    tasks: readonly TaskDto[],
    ending: BatchId | undefined,
    sameStart?: SameStart,
  ): StartStep {
    // Nothing else starts in Your folder while a pass holds it (W9), its own batch included.
    const pass = passHoldingFolder(db, project.id);
    if (pass) {
      const titles = tasks.map((t) => t.title).join(', ');
      throw new ConflictError(
        `Your folder is in the Workbench pass "${pass.name}", so ${titles} can't start there until the pass closes. Set ${tasks.length === 1 ? 'it' : 'them'} to a separate copy, or start ${tasks.length === 1 ? 'it' : 'them'} once the pass has closed.`,
      );
    }
    const unfinished = findUnfinishedBatch(db, project.id) ?? null;
    // A dry run before starting over treats the batch it will abandon as already gone.
    const existing = unfinished?.id === ending ? null : unfinished;
    if (batchId !== undefined && batchId !== existing?.id)
      throw new ConflictError(
        existing
          ? `Batch "${existing.title}" is the project's unfinished batch; add fix tasks to it`
          : 'The project has no unfinished batch to add these tasks to',
      );
    if (existing?.state === BatchState.Cutting || existing?.state === BatchState.Shipping)
      throw new ConflictError(
        `Batch "${existing.title}" is ${existing.state.toLowerCase()}; start again once it is open or has shipped`,
      );
    // Refused here, with the request, so nothing is cut for tasks that can't share a pull request.
    if (existing) joinsLanding(project, existing, tasks);
    const target = existing ? null : sharedLanding(project, tasks, 'branch');
    const shipped = existing ? null : shippedLandingNotice(db, tasks);
    const plans: Plans = new Map(tasks.map((t) => [t.id, planForStart(db, t.id)]));
    const inBatch = new Set<TaskId>([
      ...tasks.map((t) => t.id),
      ...(existing ? listWorkstreams(db, { batchId: existing.id }).map((w) => w.taskId) : []),
    ]);
    refuseUnfinished(
      project.id,
      { title, ...(batchId ? { batchId } : {}) },
      unfinishedDependencies(db, tasks, inBatch),
    );
    if (existing)
      return {
        write: () => existing,
        launch: (batch) => {
          queueJoin(batch, tasks, plans, inBatch);
        },
      };
    return {
      // Its workstreams come QUEUED with the CUTTING row, so each task is running from the moment
      // Start answers and its placement can't change under the cut. The scheduler waits while the
      // batch is not OPEN; a refused cut or a restart mid-cut cancels them with the row.
      write: (w) => {
        const inserted = insertBatch(w, {
          projectId: project.id,
          title,
          ...(target ?? { baseBranch: project.baseBranch, autoMerge: true }),
        });
        for (const [taskId, plan] of plans) insertPlannedWorkstream(w, taskId, plan, inserted.id);
        if (shipped) setBatchNotice(w, inserted.id, shipped);
        sameStart?.batches.add(inserted.id);
        return inserted;
      },
      launch: (batch) => {
        runCut(batch, (signal) => cut(batch.id, tasks, plans, inBatch, signal, sameStart));
      },
    };
  }

  /**
   * One batch per dependency group, so tasks that build on each other share a worktree and the rest
   * run apart: each inserted CUTTING with its worktree path and its workstreams QUEUED, once every
   * group passed the request's checks.
   */
  function prepareWorktrees(
    project: ProjectDto,
    tasks: readonly TaskDto[],
    sameStart: SameStart,
    landingTitles: ReadonlyMap<LandingGroupId, string>,
  ): StartStep[] {
    if (tasks.length === 0) return [];
    const groups = groupByDependency(tasks, landingTitles);
    // Tasks that share a worktree share a pull request, so they must land alike; checked for every
    // group before any batch is made.
    const targets = groups.map((group) => sharedLanding(project, group.tasks, 'worktree'));
    // Each group is titled after its own tasks, so a retry is too (the card keeps no title).
    refuseUnfinished(
      project.id,
      {},
      groups.flatMap((group) =>
        unfinishedDependencies(db, group.tasks, new Set(group.tasks.map((t) => t.id))),
      ),
    );
    const plans = groups.map(
      (group): Plans => new Map(group.tasks.map((t) => [t.id, planForStart(db, t.id)])),
    );
    // The stored path is the one git makes the worktree at, so the pin store finds the batch by it.
    const root = madeWorktreeRoot(ctx.worktreeRoot);
    return groups.map((group, i): StartStep => {
      const groupPlans = plans[i] ?? new Map<TaskId, StepPlanDto>();
      const target = targets[i] ?? { baseBranch: project.baseBranch, autoMerge: true };
      const shipped = shippedLandingNotice(db, group.tasks);
      return {
        write: (w) => {
          const id = mintId('Batch');
          const inserted = insertBatch(w, {
            id,
            projectId: project.id,
            title: group.title,
            ...target,
            worktreePath: worktreePathFor(root, project, batchBranchName(group.title, id)),
          });
          for (const [taskId, plan] of groupPlans) insertPlannedWorkstream(w, taskId, plan, id);
          if (shipped) setBatchNotice(w, id, shipped);
          sameStart.batches.add(id);
          return inserted;
        },
        launch: (batch) => {
          runCut(batch, (signal) => cutWorktree(ctx, batch.id, groupPlans, signal, sameStart));
        },
      };
    });
  }

  /** A fix task joins the OPEN worktree batch it names, or reopens the FAILED one it names. */
  function prepareJoinWorktree(
    project: ProjectDto,
    batch: BatchDto,
    tasks: readonly TaskDto[],
  ): StartStep {
    if (batch.state !== BatchState.Open && batch.state !== BatchState.Failed)
      throw new ConflictError(
        `Batch "${batch.title}" is ${batch.state.toLowerCase()}; add fix tasks to it once it is open`,
      );
    joinsLanding(project, batch, tasks);
    const plans: Plans = new Map(tasks.map((t) => [t.id, planForStart(db, t.id)]));
    const inBatch = new Set<TaskId>([
      ...tasks.map((t) => t.id),
      ...listWorkstreams(db, { batchId: batch.id }).map((w) => w.taskId),
    ]);
    refuseUnfinished(
      project.id,
      { title: batch.title, batchId: batch.id },
      unfinishedDependencies(db, tasks, inBatch),
    );
    return {
      write: () => batch,
      launch: () => {
        queueJoin(batch, tasks, plans, inBatch);
      },
    };
  }

  /** `request` is what Retry start repeats: the start's title, and the batch a join named. */
  function refuseUnfinished(
    projectId: ProjectId,
    request: Partial<StartRequest>,
    blocked: readonly BlockedTask[],
  ): void {
    if (blocked.length === 0) return;
    // Names the blocked tasks, so it folds on a repeat and closes once they start.
    const card = forTasks(
      startCards.unfinishedDependencies(blocked),
      blocked.map((b) => b.task.id),
      request,
    );
    raise(ctx.inbox, projectId, card);
    throw new ConflictError(`${card.title}. ${card.body}`);
  }

  function checkStartable(project: ProjectDto, task: TaskDto): void {
    if (task.projectId !== project.id)
      throw new InvalidError(`Task ${task.title} belongs to another project`);
    if (task.status !== TaskStatus.Open)
      throw new ConflictError(`Task ${task.title} is ${task.status}`);
    // Checked here, before the cut, so a parked task never leaves a fresh branch checked out.
    if (task.boardColumnId !== null)
      throw new ConflictError(
        `Task ${task.title} is parked in ${getBoardColumn(db, task.boardColumnId).name}; move it to Backlog or Ready to start it`,
      );
    if (joining.has(task.id)) throw joiningRefusal(task);
    const latest = task.workstreamId ? getWorkstreamRow(db, task.workstreamId) : null;
    if (latest && ACTIVE_STATES.includes(latest.state))
      throw new ConflictError(`Task ${task.title} is already running`);
    // Checked here too, before the cut, so a pass task never leaves a fresh branch checked out.
    const pass = passHoldingTask(db, task);
    if (pass)
      throw new ConflictError(
        `Task ${task.title} is in the Workbench pass "${pass.name}"; it runs there until the pass takes it out or ends`,
      );
  }

  /** Cutting a branch (batch delivery spec §5): checks in order, then switch, then open. */
  function cut(
    batchId: BatchId,
    tasks: readonly TaskDto[],
    plans: CutTasks,
    inBatch: ReadonlySet<TaskId>,
    signal: AbortSignal,
    sameStart?: SameStart,
  ): Promise<void> {
    // One operation: the checkout's git dirs are read once for the cut, not once per git call.
    return ctx.git.operation(() => cutSteps(batchId, tasks, plans, inBatch, signal, sameStart));
  }

  async function cutSteps(
    batchId: BatchId,
    tasks: readonly TaskDto[],
    plans: CutTasks,
    inBatch: ReadonlySet<TaskId>,
    signal: AbortSignal,
    sameStart?: SameStart,
  ): Promise<void> {
    const batch = getBatch(db, batchId);
    const project = getProject(db, batch.projectId);
    const refuse = (card: Card): void => {
      // Cancels the workstreams the start inserted with the row, so its tasks can start again.
      ctx.state.write((w) => {
        deleteCuttingBatch(w, batchId, card.title);
        forgetStartSiblings(w, batchId);
      });
      raise(ctx.inbox, project.id, forTasks(card, plans.keys(), { title: batch.title }));
    };
    // A shutdown mid-cut leaves the CUTTING row; startup cuts it again (`recoverBatches`).
    const stopped = (): boolean => signal.aborted;
    if (stopped()) return;
    try {
      // Only lanes in the project's own checkout: the cut moves its branch under their files. A
      // lane in a separate copy edits other files.
      const lanes = lanesInProjectCheckout(db, project);
      if (lanes > 0) {
        refuse(startCards.lanesRunning(project, lanes));
        return;
      }
      const filters = await ctx.git.filtersIn(project.repoPath, 'HEAD');
      if (filters.length > 0) {
        refuse(startCards.usesFilters(project, filters));
        return;
      }
      const dirty = await ctx.git.changedPaths(project.repoPath);
      if (dirty.length > 0) {
        refuse(startCards.dirtyCheckout(project, dirty));
        return;
      }
      if ((await ctx.git.remoteUrl(project.repoPath, 'origin')) === null) {
        refuse(startCards.noOrigin(project));
        return;
      }
      // The repository gh is told about comes from origin's pinned push URL, never from gh reading
      // the checkout's remotes. An origin added or changed since the pin is refused here with a card
      // that offers it for trust.
      const repo = githubRepoOf(await ctx.git.pinnedPushUrl(project.repoPath));
      if (repo === null) {
        refuse(startCards.repoUnknown(project));
        return;
      }
      try {
        const missing = await missingLandingBranch(ctx, project, batch, signal);
        if (missing) {
          refuse(missing);
          return;
        }
        await ctx.git.fetch(project.repoPath, batch.baseBranch, networkCall(ctx, signal));
      } catch (error) {
        if (!stopped()) refuse(startCards.fetchFailed(batch.baseBranch, error));
        return;
      }
      // Not a refusal: the builder may mean to land in a branch that is behind, or that nothing
      // else uses. A notice on the batch's tasks names it.
      for (const notice of await landingWarnings(ctx, project, batch, inBatch, signal, sameStart)) {
        if (stopped()) break;
        try {
          showNotice(ctx.state, batchId, notice);
        } catch (error) {
          ctx.logger.warn({ batchId, err: error }, 'landing notice not written');
        }
      }
      const call = ghCall(ctx, signal);
      try {
        await ctx.gh.authStatus(call);
      } catch (error) {
        if (!stopped()) refuse(startCards.ghUnavailable(error));
        return;
      }
      const unmerged = await unmergedDependencies({
        db,
        gh: ctx.gh,
        call,
        tasks,
        inBatch,
        batchId,
      });
      if (unmerged.length > 0) {
        refuse(startCards.unmergedDependencies(unmerged));
        return;
      }
      if (stopped()) return;
      const branch = batchBranchName(batch.title, batch.id);
      // Where the checkout was, so it goes back there when the batch ends (returnCheckout).
      const from = await ctx.git.switchNewBranch(
        project.repoPath,
        branch,
        `origin/${batch.baseBranch}`,
      );
      const baseSha = await ctx.git.head(project.repoPath);
      ctx.state.write((w) => {
        patchBatch(w, batchId, {
          branch,
          baseSha,
          repo,
          returnBranch: from?.branch ?? null,
          returnSha: from?.sha ?? null,
        });
        // Its workstreams came QUEUED with the row; opening the batch lets the scheduler launch them.
        transitionBatch(w, batchId, { to: BatchState.Open, reason: 'branch cut' });
        forgetStartSiblings(w, batchId);
      });
      ctx.logger.info(
        { batchId, projectId: project.id, branch, baseSha, repo },
        'batch branch cut',
      );
      resolveStartCards(db, ctx.inbox, project.id, plans.keys());
      ctx.onWorkQueued();
    } catch (error) {
      if (!stopped()) refuse(startCards.notStarted(error));
    }
  }

  /** Joining or reopening (batch delivery spec §5): only the branch is checked; the rest holds by construction. */
  async function join(
    batchId: BatchId,
    tasks: readonly TaskDto[],
    plans: Plans,
    inBatch: ReadonlySet<TaskId>,
    signal: AbortSignal,
  ): Promise<void> {
    const batch = getBatch(db, batchId);
    const project = getProject(db, batch.projectId);
    // A FAILED worktree batch reopens once its worktree is whole, which replaces the branch check.
    const reopening = batch.state === BatchState.Failed && batch.worktreePath !== null;
    // Every refusal names the tasks it refused; the API already answered 202 for them.
    const refuse = (card: Card): void => {
      raise(ctx.inbox, project.id, forTasks(card, plans.keys(), { title: batch.title, batchId }));
    };
    // A function, so the checks after an await are not narrowed away by the one before it.
    const stopped = (): boolean => signal.aborted;
    if (stopped()) {
      refuse(startCards.joinInterrupted(batch));
      return;
    }
    try {
      if (!reopening) {
        const checkout = batchCheckout(db, batch);
        const current = await ctx.git.currentBranch(checkout);
        if (current !== batch.branch) {
          refuse(wrongBranchCard(batch, current, checkout, 'not_joined'));
          return;
        }
      }
      const call = ghCall(ctx, signal);
      const unmerged = await unmergedDependencies({
        db,
        gh: ctx.gh,
        call,
        tasks,
        inBatch,
        batchId,
      });
      if (unmerged.length > 0) {
        refuse(startCards.unmergedDependencies(unmerged));
        return;
      }
      if (stopped()) {
        refuse(startCards.joinInterrupted(batch));
        return;
      }
      if (reopening) {
        const opened = await reopenWhenWhole(ctx, batchId, 'a fix task joined', signal, (w) => {
          for (const [taskId, plan] of plans) insertJoinedWorkstream(w, taskId, plan, batchId);
        });
        if (opened) resolveStartCards(db, ctx.inbox, project.id, plans.keys());
        else
          refuse(
            stopped()
              ? startCards.joinInterrupted(batch)
              : startCards.notJoined(batch, 'the batch did not reopen'),
          );
        return;
      }
      ctx.state.write((w) => {
        const now = getBatch(w.tx, batchId);
        // A worktree batch reopens only once its worktree is whole again, which `reopening` does.
        if (now.state === BatchState.Failed && now.worktreePath === null)
          transitionBatch(w, batchId, {
            to: BatchState.Open,
            patch: { failure: null },
            reason: 'a fix task joined',
          });
        else if (now.state !== BatchState.Open)
          throw new ConflictError(`Batch "${now.title}" is ${now.state.toLowerCase()} now`);
        for (const [taskId, plan] of plans) insertJoinedWorkstream(w, taskId, plan, batchId);
      });
      resolveStartCards(db, ctx.inbox, project.id, plans.keys());
      ctx.onWorkQueued();
    } catch (error) {
      refuse(stopped() ? startCards.joinInterrupted(batch) : startCards.notJoined(batch, error));
    }
  }

  return {
    startBatch,
    startTask(taskId) {
      const task = getTask(db, taskId);
      const [batch] = startBatch(task.projectId, { title: task.title, taskIds: [taskId] });
      if (!batch) throw new InvalidError(`Task ${task.title} did not start`);
      return batch;
    },
    refuseIfJoining,
    joiningProblem,
    refuseStart(taskId, ending) {
      const task = getTask(db, taskId);
      const project = getProject(db, task.projectId);
      checkStartable(project, task);
      if (project.delivery !== Delivery.PullRequest) return;
      // The steps are only built, never written or launched.
      prepare(
        project,
        BatchStartInput.parse({ title: task.title, taskIds: [taskId] }),
        [task],
        ending,
      );
    },
    recut(batchId) {
      const batch = getBatch(db, batchId);
      if (batch.state !== BatchState.Cutting) return;
      // The workstreams came QUEUED with the row and are still its own, so the tasks keep their place.
      const tasks = listWorkstreams(db, { batchId }).map((ws) => getTask(db, ws.taskId));
      const ids = new Map(tasks.map((task) => [task.id, null]));
      // What the start that made this batch made, so a sibling cut again with it is no use of the branch.
      const sameStart = startSiblings(db, batchId);
      runCut(batch, (signal) =>
        batch.worktreePath === null
          ? cut(batchId, tasks, ids, new Set(ids.keys()), signal, sameStart)
          : cutWorktree(ctx, batchId, ids, signal, sameStart),
      );
    },
    retry(id, note) {
      refuseIfJoining(getWorkstreamRow(db, id).taskId);
      refuseMovedRetry(id);
      // A revert a stopped Ship without it left on the branch is known only to the batch's left-out
      // card, so the run's session is told of it from there when the revert covers the run.
      const run = getWorkstream(db, id);
      const kept = run.batchId === null ? null : keptRevertOf(db, getBatch(db, run.batchId));
      const retried = retryWorkstream(
        ctx.state,
        id,
        note,
        kept?.covers.includes(id) ? kept.revert : null,
      );
      if (retried.batchId !== null) reopen(retried.batchId);
      return retried;
    },
    reopen,
  };
}
