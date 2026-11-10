import {
  BatchState,
  EventType,
  BatchId,
  WorkstreamId,
  WorkstreamState,
  type TaskId,
  type WorkstreamDto,
} from '@10db/contracts';
import {
  getBatch,
  getProject,
  getTask,
  getTaskKeptWork,
  getWorkstream,
  getWorkstreamRow,
  listWorkstreams,
  passHoldingFolder,
  passHoldingTask,
  type DbReader,
} from '@10db/db';
import type { EventBus } from '../events';
import { checkoutOf } from './checkout';
import type { DeliveryContext } from './context';
import { jobKey, JobQueue } from './jobs';

// Workbench spec §5.4, call 33: an ordinary start of a task taken out of a pass puts its saved work
// back in the checkout it runs in before its lane can launch; a file that does not go back is named
// on its thread. From there it is an ordinary task, and the saved work's ref goes once its work lands.

/** Where taken-out tasks' saved work is kept, one ref each (the pass module's `keptRef`). */
const KEPT_PREFIX = 'refs/10db/kept/';
const keptWorkRef = (taskId: TaskId): string => `${KEPT_PREFIX}${taskId}`;

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Puts each task's saved Workbench work back in `checkout`. A put-back that fails is logged: the work stays saved. */
export async function putBackForStart(
  ctx: DeliveryContext,
  taskIds: Iterable<TaskId>,
  checkout: string,
): Promise<void> {
  for (const taskId of taskIds) {
    if (getTaskKeptWork(ctx.state.db, taskId) === null) continue;
    try {
      const done = await ctx.putBack({ repo: checkout, taskId });
      ctx.logger.info(
        { taskId, checkout, applied: done.applied, left: done.left },
        'saved work put back for a start',
      );
    } catch (error) {
      ctx.logger.warn({ taskId, checkout, err: message(error) }, 'saved work not put back');
    }
  }
}

/** What the scheduler asks, last, before it launches a run. */
export interface KeptWorkGate {
  /**
   * Whether the run may launch as far as its task's saved Workbench work goes. The scheduler asks it
   * of a run every other check would launch now. A run whose task has saved work waits while a job
   * puts the work back in the checkout it runs in (its batch's copy, or Your folder), once for that
   * run, and launches on the tick after. Runs of a pass, runs of a batch that is not open, and runs
   * W9 holds pass: their own rules hold them. A restart asks again; the put-back is idempotent.
   */
  ready(run: WorkstreamDto): boolean;
}

/**
 * Whether `run` waits for its task's saved work: it is queued, its task has saved work and no pass
 * holds the task, its batch, if it has one, is open, and no pass holds the Your folder it runs in.
 */
function waitsForPutBack(db: DbReader, run: WorkstreamDto): boolean {
  if (run.state !== WorkstreamState.Queued) return false;
  const task = getTask(db, run.taskId);
  if (getTaskKeptWork(db, task.id) === null || passHoldingTask(db, task) !== undefined)
    return false;
  const batch = run.batchId === null ? null : getBatch(db, run.batchId);
  if (batch !== null && batch.state !== BatchState.Open) return false;
  // In Your folder while a pass holds it, W9 holds the run; its work goes back after.
  return !(batch?.worktreePath == null && passHoldingFolder(db, run.projectId) !== undefined);
}

/**
 * Call 33's launch rule, the one invariant for every start: a run never launches before its task's
 * saved work is back in its checkout, whether it was started, started again, joined a batch or was
 * found queued after a restart. The put-back's job asks again as it runs, since the run, its batch
 * or Your folder may have changed since the scheduler asked: a run no longer waiting gets nothing
 * written, and is asked again if it comes to wait once more.
 */
export function createKeptWorkGate(ctx: DeliveryContext): KeptWorkGate {
  const db = ctx.state.db;
  /** Runs whose put-back has run. */
  const back = new Set<WorkstreamId>();
  /** Runs whose put-back is queued or running. */
  const putting = new Set<WorkstreamId>();
  return {
    ready(run) {
      if (back.has(run.id) || !waitsForPutBack(db, run)) return true;
      if (putting.has(run.id)) return false;
      putting.add(run.id);
      const batch = run.batchId === null ? null : getBatch(db, run.batchId);
      ctx.jobs.run(
        jobKey(batch ?? { projectId: run.projectId, worktreePath: null }, JobQueue.Cut),
        async () => {
          const now = getWorkstream(db, run.id);
          if (!waitsForPutBack(db, now)) {
            putting.delete(run.id);
            return;
          }
          await putBackForStart(ctx, [now.taskId], checkoutOf(db, now));
          putting.delete(run.id);
          back.add(run.id);
          ctx.onWorkQueued();
        },
      );
      return false;
    },
  };
}

/** Deletes the saved-work refs of these tasks, in the project's queue; a failure is logged. */
function dropKeptRefs(
  ctx: DeliveryContext,
  key: string,
  repo: string,
  tasks: readonly TaskId[],
): void {
  ctx.jobs.run(key, async () => {
    try {
      const kept = new Set(await ctx.git.keptRefs(repo, KEPT_PREFIX));
      for (const taskId of tasks)
        if (kept.has(keptWorkRef(taskId))) await ctx.git.deleteKeptRef(repo, keptWorkRef(taskId));
    } catch (error) {
      ctx.logger.warn({ tasks, err: message(error) }, 'saved work refs not deleted');
    }
  });
}

/**
 * Deletes the saved-work ref of each task whose work landed, once nothing of it is still recorded as
 * saved: the finished runs of a batch that shipped or landed, and a finished run of a project with no
 * batches (local delivery), whose work is committed in Your folder.
 */
export function subscribeKeptWorkLanding(bus: EventBus, ctx: DeliveryContext): () => void {
  const db = ctx.state.db;
  const unsaved = (taskId: TaskId): boolean => getTaskKeptWork(db, taskId) === null;
  return bus.subscribe((event) => {
    if (event.type === EventType.WorkstreamChanged) {
      if (event.data['to'] !== WorkstreamState.Done) return;
      const id = WorkstreamId.safeParse(event.entityId);
      if (!id.success) return;
      const run = getWorkstreamRow(db, id.data);
      if (run.batchId !== null || !unsaved(run.taskId)) return;
      dropKeptRefs(
        ctx,
        jobKey({ projectId: run.projectId, worktreePath: null }, JobQueue.Cut),
        getProject(db, run.projectId).repoPath,
        [run.taskId],
      );
      return;
    }
    if (event.type !== EventType.BatchUpdated) return;
    const to = event.data['to'];
    if (to !== BatchState.Shipped && to !== BatchState.Closed) return;
    const id = BatchId.safeParse(event.entityId);
    if (!id.success) return;
    const batch = getBatch(db, id.data);
    const tasks = listWorkstreams(db, { batchId: batch.id })
      .filter((ws) => ws.state === WorkstreamState.Done)
      .map((ws) => ws.taskId)
      .filter(unsaved);
    if (tasks.length === 0) return;
    dropKeptRefs(
      ctx,
      jobKey(batch, JobQueue.Ship),
      getProject(db, batch.projectId).repoPath,
      tasks,
    );
  });
}
