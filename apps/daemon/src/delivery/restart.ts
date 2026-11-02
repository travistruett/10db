import {
  BatchState,
  WorkstreamState,
  type BatchDto,
  type TaskId,
  type WorkstreamDto,
} from '@10db/contracts';
import { getBatch, getTask, getWorkstream, listWorkstreams } from '@10db/db';
import type { StateStore } from '../events';
import type { InboxService } from '../inbox';
import { retryWorkstream } from '../team';
import type { BatchStarter } from './start';
import type { Shipper } from './ship';

export interface FailedRestarts {
  /**
   * Runs the task's failed latest run again in its open or failed batch, as the failure card's Retry
   * does, so the commits its earlier attempt made stay. Null when the task has no such run.
   */
  continueRun(taskId: TaskId): WorkstreamDto | null;
  /**
   * Before a task starts over from the base branch: abandons the batch that holds only the task's
   * failed attempt, so no open batch is left holding work nothing will finish. A batch that holds
   * other tasks' work stays. Refuses while a run in the batch is live, and, before it abandons
   * anything, when the start that follows would be refused, so the attempt stays to be retried.
   */
  supersede(taskId: TaskId): void;
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

  return {
    continueRun(taskId) {
      const failed = failedRun(taskId);
      if (!failed) return null;
      const retried = retryWorkstream(deps.state, failed.workstream.id);
      deps.starter.reopen(failed.batch.id);
      // The run is going again: the card that offered Retry for its failure has been answered.
      deps.inbox.cancelForWorkstream(failed.workstream.id);
      return retried;
    },
    supersede(taskId) {
      const failed = failedRun(taskId);
      if (!failed) return;
      const members = listWorkstreams(db, { batchId: failed.batch.id });
      if (members.some((w) => w.taskId !== taskId)) return;
      deps.starter.refuseStart(taskId, failed.batch.id);
      deps.shipper.abandon(failed.batch.id);
      // abandon cancels only unfinished runs' cards; this run is FAILED, which is terminal.
      deps.inbox.cancelForWorkstream(failed.workstream.id);
    },
  };
}
