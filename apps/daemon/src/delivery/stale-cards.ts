import type { BatchDto, ProjectId, TaskId } from '@10db/contracts';
import { getTask, getWorkstreamRow, type DbReader } from '@10db/db';
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

/** Closes the batch's open "not shipped" cards: a later ship of the batch succeeded. */
export function resolveShipCards(db: DbReader, inbox: InboxService, batch: BatchDto): void {
  resolveStaleCards(db, inbox, batch.projectId, (when) =>
    when.event === 'batch_shipped' && when.batchId === batch.id
      ? `Batch "${batch.title}" shipped`
      : null,
  );
}
