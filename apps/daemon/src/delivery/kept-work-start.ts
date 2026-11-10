import {
  BatchState,
  EventType,
  BatchId,
  WorkstreamState,
  type TaskId,
  type WorkstreamDto,
  type WorkstreamId,
} from '@10db/contracts';
import {
  getBatch,
  getProject,
  getTask,
  getTaskKeptWork,
  listWorkstreams,
  passHoldingFolder,
  passHoldingTask,
} from '@10db/db';
import type { EventBus } from '../events';
import type { DeliveryContext } from './context';
import { jobKey, JobQueue } from './jobs';

// Workbench spec §5.4, call 33: an ordinary start of a task taken out of a pass puts its saved work
// back in the checkout it runs in, before its lane can launch; a file that does not go back is named
// on its thread. From there it is an ordinary task, and the saved work's ref goes once its work lands.

/** Where taken-out tasks' saved work is kept, one ref each (the pass module's `keptRef`). */
const KEPT_PREFIX = 'refs/10db/kept/';
const keptWorkRef = (taskId: TaskId): string => `${KEPT_PREFIX}${taskId}`;

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Puts each task's saved Workbench work back in `checkout`, in the start's job and before its batch
 * opens, so no lane launches without it. A put-back that fails is logged: the work stays saved.
 */
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

/** What the scheduler asks before it launches a run that belongs to no batch. */
export interface KeptWorkGate {
  /**
   * Whether the run may launch: always for a run of a batch (its cut put the work back before it
   * opened) or of a pass, and while a pass holds the folder (W9 holds the run). Otherwise a run whose
   * task has saved Workbench work waits while a job in the project's queue puts the work back, once
   * for that run, and launches on the tick after; a restart asks again, and the put-back is
   * idempotent.
   */
  ready(run: WorkstreamDto): boolean;
}

/**
 * The launch rule of call 33 for a run in Your folder of a project with no batches (local
 * delivery): it never launches before its task's saved work is back, whether it was started, started
 * again, or found queued after a restart.
 */
export function createKeptWorkGate(ctx: DeliveryContext): KeptWorkGate {
  const db = ctx.state.db;
  /** Runs whose put-back has run, or is running. */
  const back = new Set<WorkstreamId>();
  const putting = new Set<WorkstreamId>();
  return {
    ready(run) {
      if (run.batchId !== null || back.has(run.id)) return true;
      const task = getTask(db, run.taskId);
      if (getTaskKeptWork(db, task.id) === null || passHoldingTask(db, task) !== undefined)
        return true;
      if (passHoldingFolder(db, run.projectId) !== undefined) return true;
      if (putting.has(run.id)) return false;
      putting.add(run.id);
      ctx.jobs.run(
        jobKey({ projectId: run.projectId, worktreePath: null }, JobQueue.Cut),
        async () => {
          await putBackForStart(ctx, [task.id], getProject(db, run.projectId).repoPath);
          putting.delete(run.id);
          back.add(run.id);
          ctx.onWorkQueued();
        },
      );
      return false;
    },
  };
}

/**
 * Deletes the saved-work ref of each task of a batch that shipped or landed, once nothing of the
 * work is still recorded as saved: its work is on the batch's branch, pushed or landed.
 */
export function subscribeKeptWorkLanding(bus: EventBus, ctx: DeliveryContext): () => void {
  return bus.subscribe((event) => {
    if (event.type !== EventType.BatchUpdated) return;
    const to = event.data['to'];
    if (to !== BatchState.Shipped && to !== BatchState.Closed) return;
    const id = BatchId.safeParse(event.entityId);
    if (!id.success) return;
    const batch = getBatch(ctx.state.db, id.data);
    const repo = getProject(ctx.state.db, batch.projectId).repoPath;
    const tasks = listWorkstreams(ctx.state.db, { batchId: batch.id })
      .filter((ws) => ws.state === WorkstreamState.Done)
      .map((ws) => ws.taskId)
      .filter((taskId) => getTaskKeptWork(ctx.state.db, taskId) === null);
    if (tasks.length === 0) return;
    ctx.jobs.run(jobKey(batch, JobQueue.Ship), async () => {
      try {
        const kept = new Set(await ctx.git.keptRefs(repo, KEPT_PREFIX));
        for (const taskId of tasks)
          if (kept.has(keptWorkRef(taskId))) await ctx.git.deleteKeptRef(repo, keptWorkRef(taskId));
      } catch (error) {
        ctx.logger.warn({ batchId: batch.id, err: message(error) }, 'saved work refs not deleted');
      }
    });
  });
}
