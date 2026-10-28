import { mkdirSync, realpathSync } from 'node:fs';
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
  WorkspaceMode,
  type BatchDto,
  type BatchId,
  type ProjectDto,
  type ProjectId,
  type StepPlanDto,
  type TaskDto,
  type TaskId,
} from '@10db/contracts';
import {
  countLanes,
  deleteCuttingBatch,
  findUnfinishedBatch,
  getBatch,
  getBoardColumn,
  getProject,
  getTask,
  getWorkstreamRow,
  insertBatch,
  listWorkstreams,
  patchBatch,
  transitionBatch,
} from '@10db/db';
import { githubRepoOf } from '../github';
import { insertPlannedWorkstream, planForStart } from '../team';
import { batchBranchName } from './branch-name';
import { forTasks, startCards, wrongBranchCard, type Card } from './cards';
import { batchCheckout } from './checkout';
import { ghCall, networkCall, raise, type DeliveryContext } from './context';
import { unfinishedDependencies, unmergedDependencies, type BlockedTask } from './deps';
import { groupByDependency } from './grouping';
import { jobKey, JobQueue } from './jobs';
import { cutWorktree, type Plans } from './worktree-cut';
import { worktreePathFor } from './worktree-path';

export interface BatchStarter {
  /**
   * Starts the tasks as new batches (one in shared mode; one per dependency group in worktree mode),
   * or adds them to the batch `input.batchId` names. Shared mode without a `batchId` adds them to the
   * project's OPEN batch (or, as fix tasks, its FAILED one), as before. Answers at once with the
   * batches made or joined; git and gh checks finish in the background, and their refusals are cards
   * (batch delivery spec §5, worktree mode spec §5).
   */
  startBatch(projectId: ProjectId, input: BatchStartInput): BatchDto[];
  /**
   * One task in a pull-request project: a batch of one titled after it, or in shared mode a member of
   * the open batch. In worktree mode it never joins.
   */
  startTask(taskId: TaskId): BatchDto;
}

export function createBatchStarter(ctx: DeliveryContext): BatchStarter {
  const db = ctx.state.db;

  function startBatch(projectId: ProjectId, raw: BatchStartInput): BatchDto[] {
    const input = BatchStartInput.parse(raw);
    const project = getProject(db, projectId);
    if (project.delivery !== Delivery.PullRequest)
      throw new InvalidError(`${project.name} delivers locally; start its tasks one at a time`);
    const tasks = input.taskIds.map((id) => getTask(db, id));
    for (const task of tasks) checkStartable(project, task);
    switch (project.workspaceMode) {
      case WorkspaceMode.Shared:
        return [startShared(project, input, tasks)];
      case WorkspaceMode.Worktree:
        return input.batchId === undefined
          ? startWorktrees(project, tasks)
          : [joinWorktree(project, input.batchId, tasks)];
    }
  }

  function startShared(
    project: ProjectDto,
    input: BatchStartInput,
    tasks: readonly TaskDto[],
  ): BatchDto {
    const existing = findUnfinishedBatch(db, project.id) ?? null;
    if (input.batchId !== undefined && input.batchId !== existing?.id)
      throw new ConflictError(
        existing
          ? `Batch "${existing.title}" is the project's unfinished batch; add fix tasks to it`
          : 'The project has no unfinished batch to add these tasks to',
      );
    if (existing?.state === BatchState.Cutting || existing?.state === BatchState.Shipping)
      throw new ConflictError(
        `Batch "${existing.title}" is ${existing.state.toLowerCase()}; start again once it is open or has shipped`,
      );
    const plans: Plans = new Map(tasks.map((t) => [t.id, planForStart(db, t.id)]));
    const inBatch = new Set<TaskId>([
      ...input.taskIds,
      ...(existing ? listWorkstreams(db, { batchId: existing.id }).map((w) => w.taskId) : []),
    ]);
    refuseUnfinished(project.id, unfinishedDependencies(db, tasks, inBatch));
    const queue = jobKey(project, JobQueue.Cut);
    if (existing) {
      ctx.jobs.run(queue, (signal) => join(existing.id, tasks, plans, inBatch, signal));
      return existing;
    }
    const batch = ctx.state.write((w) =>
      insertBatch(w, { projectId: project.id, title: input.title, baseBranch: project.baseBranch }),
    );
    ctx.jobs.run(queue, (signal) => cut(batch.id, tasks, plans, inBatch, signal));
    return batch;
  }

  /**
   * W3: one batch per dependency group, each inserted CUTTING with its worktree path and its
   * workstreams QUEUED in its own transaction, once every group passed the request's checks.
   */
  function startWorktrees(project: ProjectDto, tasks: readonly TaskDto[]): BatchDto[] {
    const groups = groupByDependency(tasks);
    refuseUnfinished(
      project.id,
      groups.flatMap((group) =>
        unfinishedDependencies(db, group.tasks, new Set(group.tasks.map((t) => t.id))),
      ),
    );
    const plans = groups.map(
      (group): Plans => new Map(group.tasks.map((t) => [t.id, planForStart(db, t.id)])),
    );
    // The stored path is the one git makes the worktree at, so the pin store finds the batch by it.
    const root = madeWorktreeRoot();
    return groups.map((group, i) => {
      const groupPlans = plans[i] ?? new Map<TaskId, StepPlanDto>();
      const batch = ctx.state.write((w) => {
        const id = mintId('Batch');
        const inserted = insertBatch(w, {
          id,
          projectId: project.id,
          title: group.title,
          baseBranch: project.baseBranch,
          worktreePath: worktreePathFor(root, project, batchBranchName(group.title, id)),
        });
        for (const [taskId, plan] of groupPlans) insertPlannedWorkstream(w, taskId, plan, id);
        return inserted;
      });
      ctx.jobs.run(jobKey(project, JobQueue.Cut), (signal) =>
        cutWorktree(ctx, batch.id, groupPlans, signal),
      );
      return batch;
    });
  }

  /** The worktree root, made owner-only when missing, as a real path. */
  function madeWorktreeRoot(): string {
    try {
      mkdirSync(ctx.worktreeRoot, { recursive: true, mode: 0o700 });
      return realpathSync(ctx.worktreeRoot);
    } catch (error) {
      throw new InvalidError(
        `10db can't make its worktree root ${ctx.worktreeRoot}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** A fix task joins the OPEN worktree batch it names; a FAILED one waits for reopening. */
  function joinWorktree(
    project: ProjectDto,
    batchId: BatchId,
    tasks: readonly TaskDto[],
  ): BatchDto {
    const batch = batchOf(project, batchId);
    if (batch.state !== BatchState.Open)
      throw new ConflictError(
        `Batch "${batch.title}" is ${batch.state.toLowerCase()}; add fix tasks to it once it is open`,
      );
    const plans: Plans = new Map(tasks.map((t) => [t.id, planForStart(db, t.id)]));
    const inBatch = new Set<TaskId>([
      ...tasks.map((t) => t.id),
      ...listWorkstreams(db, { batchId }).map((w) => w.taskId),
    ]);
    refuseUnfinished(project.id, unfinishedDependencies(db, tasks, inBatch));
    ctx.jobs.run(jobKey(project, JobQueue.Cut), (signal) =>
      join(batchId, tasks, plans, inBatch, signal),
    );
    return batch;
  }

  /** The project's batch `batchId`; any other id, one naming no batch included, is a conflict. */
  function batchOf(project: ProjectDto, batchId: BatchId): BatchDto {
    const conflict = new ConflictError(`Batch ${batchId} is not a batch of ${project.name}`);
    let batch: BatchDto;
    try {
      batch = getBatch(db, batchId);
    } catch (error) {
      if (error instanceof NotFoundError) throw conflict;
      throw error;
    }
    if (batch.projectId !== project.id) throw conflict;
    return batch;
  }

  function refuseUnfinished(projectId: ProjectId, blocked: readonly BlockedTask[]): void {
    if (blocked.length === 0) return;
    const card = startCards.unfinishedDependencies(blocked);
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
    const latest = task.workstreamId ? getWorkstreamRow(db, task.workstreamId) : null;
    if (latest && ACTIVE_STATES.includes(latest.state))
      throw new ConflictError(`Task ${task.title} is already running`);
  }

  /** Cutting a branch (batch delivery spec §5): checks in order, then switch, then open. */
  async function cut(
    batchId: BatchId,
    tasks: readonly TaskDto[],
    plans: Plans,
    inBatch: ReadonlySet<TaskId>,
    signal: AbortSignal,
  ): Promise<void> {
    const batch = getBatch(db, batchId);
    const project = getProject(db, batch.projectId);
    const refuse = (card: Card): void => {
      ctx.state.write((w) => {
        deleteCuttingBatch(w, batchId, card.title);
      });
      raise(ctx.inbox, project.id, forTasks(card, plans.keys()));
    };
    // A shutdown mid-cut leaves the CUTTING row; startup deletes it and says so.
    const stopped = (): boolean => signal.aborted;
    if (stopped()) return;
    try {
      const lanes = countLanes(db).byProject.get(project.id) ?? 0;
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
        await ctx.git.fetch(project.repoPath, batch.baseBranch, networkCall(ctx, signal));
      } catch (error) {
        if (!stopped()) refuse(startCards.fetchFailed(batch.baseBranch, error));
        return;
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
      await ctx.git.switchNewBranch(project.repoPath, branch, `origin/${batch.baseBranch}`);
      const baseSha = await ctx.git.head(project.repoPath);
      ctx.state.write((w) => {
        patchBatch(w, batchId, { branch, baseSha, repo });
        transitionBatch(w, batchId, { to: BatchState.Open, reason: 'branch cut' });
        for (const [taskId, plan] of plans) insertPlannedWorkstream(w, taskId, plan, batchId);
      });
      ctx.logger.info(
        { batchId, projectId: project.id, branch, baseSha, repo },
        'batch branch cut',
      );
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
    // Every refusal names the tasks it refused; the API already answered 202 for them.
    const refuse = (card: Card): void => {
      raise(ctx.inbox, project.id, forTasks(card, plans.keys()));
    };
    // A function, so the checks after an await are not narrowed away by the one before it.
    const stopped = (): boolean => signal.aborted;
    if (stopped()) {
      refuse(startCards.joinInterrupted(batch));
      return;
    }
    try {
      const checkout = batchCheckout(db, batch);
      const current = await ctx.git.currentBranch(checkout);
      if (current !== batch.branch) {
        refuse(wrongBranchCard(batch, current, checkout, 'not_joined'));
        return;
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
      ctx.state.write((w) => {
        const now = getBatch(w.tx, batchId);
        // A worktree batch reopens only once its worktree is whole again, which a join doesn't check.
        if (now.state === BatchState.Failed && now.worktreePath === null)
          transitionBatch(w, batchId, {
            to: BatchState.Open,
            patch: { failure: null },
            reason: 'a fix task joined',
          });
        else if (now.state !== BatchState.Open)
          throw new ConflictError(`Batch "${now.title}" is ${now.state.toLowerCase()} now`);
        for (const [taskId, plan] of plans) insertPlannedWorkstream(w, taskId, plan, batchId);
      });
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
  };
}
