import {
  BatchState,
  NotFoundError,
  PullRequestState,
  type BatchDto,
  type ProjectId,
  type TaskId,
} from '@10db/contracts';
import { getBatch, getTask, getWorkstreamRow, type DbReader } from '@10db/db';
import { resolveStaleCards, type InboxService } from '../inbox';

/**
 * Whether the task has a run made at or after `since`: it started after the card that reported it
 * not started was raised.
 */
function startedSince(db: DbReader, taskId: TaskId, since: string): boolean {
  const { workstreamId } = getTask(db, taskId);
  return workstreamId !== null && getWorkstreamRow(db, workstreamId).createdAt >= since;
}

/**
 * Closes the project's open cards that report a refused start once every task they name has started
 * since: `started` are the tasks whose start just succeeded. A card that also names a task that has
 * not started stays open.
 */
export function resolveStartCards(
  db: DbReader,
  inbox: InboxService,
  projectId: ProjectId,
  started: Iterable<TaskId>,
): void {
  const now = new Set(started);
  resolveStaleCards(db, inbox, projectId, (when, item) => {
    if (when.event !== 'tasks_started' || !when.taskIds.some((id) => now.has(id))) return null;
    const settled = when.taskIds.every((id) => now.has(id) || startedSince(db, id, item.createdAt));
    if (!settled) return null;
    const titles = when.taskIds.map((id) => getTask(db, id).title);
    return `${titles.join(', ')} started`;
  });
}

/** Why a batch is over, or null while it is not: its pull request merged, or it was closed or abandoned. */
function overBecause(batch: BatchDto): string | null {
  if (batch.pr?.state === PullRequestState.Merged)
    return `Its pull request merged (${batch.title})`;
  if (batch.state === BatchState.Closed || batch.state === BatchState.Abandoned)
    return `Its batch "${batch.title}" is ${batch.state === BatchState.Closed ? 'closed' : 'gone'}`;
  return null;
}

/**
 * Closes every open card that waits on a batch (a failed run's) once the batch is over: its pull request
 * merged, or it was closed or abandoned. Returns how many it closed.
 */
export function resolveOverBatchCards(db: DbReader, inbox: InboxService): number {
  return resolveStaleCards(db, inbox, null, (when) => {
    if (when.event !== 'batch_over') return null;
    try {
      return overBecause(getBatch(db, when.batchId));
    } catch (error) {
      if (error instanceof NotFoundError) return 'Its batch no longer exists';
      throw error;
    }
  });
}

/** Closes the batch's open "not shipped" cards: a later ship of the batch succeeded. */
export function resolveShipCards(db: DbReader, inbox: InboxService, batch: BatchDto): void {
  resolveStaleCards(db, inbox, batch.projectId, (when) =>
    when.event === 'batch_shipped' && when.batchId === batch.id
      ? `Batch "${batch.title}" shipped`
      : null,
  );
}
