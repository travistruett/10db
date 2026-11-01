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
import { forgetCuttingTasks, recordCuttingTasks } from './cutting-tasks';
import { unfinishedDependencies, unmergedDependencies, type BlockedTask } from './deps';
import { groupByDependency } from './grouping';
import { jobKey, JobQueue } from './jobs';
import { resolveStartCards } from './stale-cards';
import { joinsLanding, missingLandingBranch, sharedLanding } from './landing';
import { cutWorktree, type Plans } from './worktree-cut';
import { madeWorktreeRoot, worktreePathFor } from './worktree-path';
import { reopenWhenWhole, reopenWorktreeBatch } from './worktree-repair';

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
  /**
   * After a workstream Retry: a FAILED worktree batch reopens in the cut queue once its worktree is
   * whole. Any other batch is left as it is.
   */
  reopen(batchId: BatchId): void;
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
    // Refused here, with the request, so nothing is cut for tasks that can't share a pull request.
    if (existing) joinsLanding(project, existing, tasks);
    const target = existing ? null : sharedLanding(project, tasks, 'branch');
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
    const batch = ctx.state.write((w) => {
      const inserted = insertBatch(w, {
        projectId: project.id,
        title: input.title,
        ...(target ?? { baseBranch: project.baseBranch, autoMerge: true }),
      });
      recordCuttingTasks(w, inserted.id, plans.keys());
      return inserted;
    });
    ctx.jobs.run(queue, (signal) => cut(batch.id, tasks, plans, inBatch, signal));
    return batch;
  }

  /**
   * One batch per dependency group, so tasks that build on each other share a worktree and the rest
   * run apart: each inserted CUTTING with its worktree path and its workstreams QUEUED in its own
   * transaction, once every group passed the request's checks.
   */
  function startWorktrees(project: ProjectDto, tasks: readonly TaskDto[]): BatchDto[] {
    const groups = groupByDependency(tasks);
    // Tasks that share a worktree share a pull request, so they must land alike; checked for every
    // group before any batch is made.
    const targets = groups.map((group) => sharedLanding(project, group.tasks, 'worktree'));
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
    const root = madeWorktreeRoot(ctx.worktreeRoot);
    return groups.map((group, i) => {
      const groupPlans = plans[i] ?? new Map<TaskId, StepPlanDto>();
      const target = targets[i] ?? { baseBranch: project.baseBranch, autoMerge: true };
      const batch = ctx.state.write((w) => {
        const id = mintId('Batch');
        const inserted = insertBatch(w, {
          id,
          projectId: project.id,
          title: group.title,
          ...target,
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

  /** A fix task joins the OPEN worktree batch it names, or reopens the FAILED one it names. */
  function joinWorktree(
    project: ProjectDto,
    batchId: BatchId,
    tasks: readonly TaskDto[],
  ): BatchDto {
    const batch = batchOf(project, batchId);
    if (batch.state !== BatchState.Open && batch.state !== BatchState.Failed)
      throw new ConflictError(
        `Batch "${batch.title}" is ${batch.state.toLowerCase()}; add fix tasks to it once it is open`,
      );
    joinsLanding(project, batch, tasks);
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
    // Names the blocked tasks, so it folds on a repeat and closes once they start.
    const card = forTasks(
      startCards.unfinishedDependencies(blocked),
      blocked.map((b) => b.task.id),
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
        forgetCuttingTasks(w, batchId);
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
        transitionBatch(w, batchId, { to: BatchState.Open, reason: 'branch cut' });
        for (const [taskId, plan] of plans) insertPlannedWorkstream(w, taskId, plan, batchId);
        forgetCuttingTasks(w, batchId);
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
      raise(ctx.inbox, project.id, forTasks(card, plans.keys()));
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
          for (const [taskId, plan] of plans) insertPlannedWorkstream(w, taskId, plan, batchId);
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
        for (const [taskId, plan] of plans) insertPlannedWorkstream(w, taskId, plan, batchId);
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
    reopen(batchId) {
      const batch = getBatch(db, batchId);
      if (batch.state === BatchState.Failed && batch.worktreePath !== null)
        reopenWorktreeBatch(ctx, batchId, 'a workstream was retried');
    },
  };
}
