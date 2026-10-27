import {
  ACTIVE_STATES,
  BatchStartInput,
  BatchState,
  ConflictError,
  Delivery,
  InvalidError,
  TaskStatus,
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
import { ghCall, networkCall, raise, type DeliveryContext } from './context';
import { unfinishedDependencies, unmergedDependencies } from './deps';

export interface BatchStarter {
  /**
   * Starts the tasks as a new batch, or adds them to the project's OPEN batch (or, as fix tasks,
   * its FAILED one). Answers at once; git and gh checks finish in the background, and their
   * refusals are cards (batch delivery spec §5).
   */
  startBatch(projectId: ProjectId, input: BatchStartInput): BatchDto;
  /** One task in a pull-request project: a batch of one titled after it, or a member of the open batch. */
  startTask(taskId: TaskId): BatchDto;
}

/** What a start hands its background job: the plans resolved in the request, by task. */
type Plans = ReadonlyMap<TaskId, StepPlanDto>;

export function createBatchStarter(ctx: DeliveryContext): BatchStarter {
  const db = ctx.state.db;

  function startBatch(projectId: ProjectId, raw: BatchStartInput): BatchDto {
    const input = BatchStartInput.parse(raw);
    const project = getProject(db, projectId);
    if (project.delivery !== Delivery.PullRequest)
      throw new InvalidError(`${project.name} delivers locally; start its tasks one at a time`);
    const tasks = input.taskIds.map((id) => getTask(db, id));
    for (const task of tasks) checkStartable(project, task);
    const existing = findUnfinishedBatch(db, projectId) ?? null;
    if (existing?.state === BatchState.Cutting || existing?.state === BatchState.Shipping)
      throw new ConflictError(
        `Batch "${existing.title}" is ${existing.state.toLowerCase()}; start again once it is open or has shipped`,
      );
    const plans: Plans = new Map(tasks.map((t) => [t.id, planForStart(db, t.id)]));
    const inBatch = new Set<TaskId>([
      ...input.taskIds,
      ...(existing ? listWorkstreams(db, { batchId: existing.id }).map((w) => w.taskId) : []),
    ]);
    const blocked = unfinishedDependencies(db, tasks, inBatch);
    if (blocked.length > 0) {
      const card = startCards.unfinishedDependencies(blocked);
      raise(ctx.inbox, projectId, card);
      throw new ConflictError(`${card.title}. ${card.body}`);
    }
    if (existing) {
      ctx.jobs.run(projectId, (signal) => join(existing.id, tasks, plans, inBatch, signal));
      return existing;
    }
    const batch = ctx.state.write((w) =>
      insertBatch(w, { projectId, title: input.title, baseBranch: project.baseBranch }),
    );
    ctx.jobs.run(projectId, (signal) => cut(batch.id, tasks, plans, inBatch, signal));
    return batch;
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
      const current = await ctx.git.currentBranch(project.repoPath);
      if (current !== batch.branch) {
        refuse(wrongBranchCard(batch, current, project.repoPath, 'not_joined'));
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
        if (now.state === BatchState.Failed)
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
      return startBatch(task.projectId, { title: task.title, taskIds: [taskId] });
    },
  };
}
