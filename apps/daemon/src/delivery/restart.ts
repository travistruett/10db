import {
  BatchState,
  WorkspaceMode,
  WorkstreamState,
  type BatchDto,
  type BatchId,
  type TaskId,
  type WorkstreamDto,
} from '@10db/contracts';
import { getBatch, getTask, getWorkstream, listWorkstreams } from '@10db/db';
import type { StateStore } from '../events';
import type { InboxService } from '../inbox';
import type { BatchStarter } from './start';
import type { Shipper } from './ship';

export interface FailedRestarts {
  /**
   * Runs the task's failed latest run again in its open or failed batch, as the failure card's Retry
   * does, so the commits its earlier attempt made stay. Null when the task has no such run.
   */
  continueRun(taskId: TaskId): WorkstreamDto | null;
  /**
   * Whether the task's failed run sits in a batch that works somewhere other than where the task
   * now runs (Your folder or a separate copy). A retry would stay in that batch, so Start starts
   * the task over instead (`supersede`, then a new run in its placement). False without such a run.
   */
  placementMoved(taskId: TaskId): boolean;
  /**
   * Before a task starts over from the base branch: abandons the batch that holds only the task's
   * failed attempt, so no open batch is left holding work nothing will finish. A batch that holds
   * other tasks' work stays, and its id is returned: once the task has started again the batch no
   * longer waits on the superseded attempt, so the caller checks it for shipping (`Shipper.checkBatch`).
   * Refuses while a run in the batch is live, and, before it abandons anything, when the start that
   * follows would be refused, so the attempt stays to be retried.
   */
  supersede(taskId: TaskId): BatchId | null;
}

export function createFailedRestarts(deps: {
  readonly state: StateStore;
  readonly starter: BatchStarter;
  readonly shipper: Shipper;
  readonly inbox: Pick<InboxService, 'cancelForWorkstream'>;
}): FailedRestarts {
  const db = deps.state.db;

  /** The task's latest run when it failed, is still the task's current one and sits in a batch that can run it. */
  function failedRun(taskId: TaskId): { workstream: WorkstreamDto; batch: BatchDto } | null {
    const task = getTask(db, taskId);
    if (task.workstreamId === null) return null;
    const workstream = getWorkstream(db, task.workstreamId);
    if (workstream.state !== WorkstreamState.Failed || workstream.batchId === null) return null;
    const batch = getBatch(db, workstream.batchId);
    if (batch.state !== BatchState.Open && batch.state !== BatchState.Failed) return null;
    return { workstream, batch };
  }

  /** Whether the task's placement is no longer the one the batch works in (a copy has a worktree path). */
  function placementMovedFrom(taskId: TaskId, batch: BatchDto): boolean {
    const inBatch = batch.worktreePath !== null ? WorkspaceMode.Worktree : WorkspaceMode.Shared;
    return getTask(db, taskId).workspaceMode !== inBatch;
  }

  return {
    placementMoved(taskId) {
      const failed = failedRun(taskId);
      return failed !== null && placementMovedFrom(taskId, failed.batch);
    },
    continueRun(taskId) {
      const failed = failedRun(taskId);
      // A retry stays in its batch, so it can't run where the task now says it should.
      if (!failed || placementMovedFrom(taskId, failed.batch)) return null;
      const retried = deps.starter.retry(failed.workstream.id);
      // The run is going again: the card that offered Retry for its failure has been answered.
      deps.inbox.cancelForWorkstream(failed.workstream.id);
      return retried;
    },
    supersede(taskId) {
      const failed = failedRun(taskId);
      if (!failed) return null;
      const members = listWorkstreams(db, { batchId: failed.batch.id });
      if (members.some((w) => w.taskId !== taskId)) return failed.batch.id;
      deps.starter.refuseStart(taskId, failed.batch.id);
      deps.shipper.abandon(failed.batch.id);
      // abandon cancels only unfinished runs' cards; this run is FAILED, which is terminal.
      deps.inbox.cancelForWorkstream(failed.workstream.id);
      return null;
    },
  };
}
