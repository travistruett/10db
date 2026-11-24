import type { TaskId } from '@10db/contracts';
import { isLocalCopy, latestWorkstreamOf, type TendbDatabase } from '@10db/db';

/** Whether the task's newest workstream runs in a local copy's batch. */
export function taskInLocalCopy(db: TendbDatabase, taskId: TaskId): boolean {
  const batchId = latestWorkstreamOf(db, taskId)?.batchId ?? null;
  return batchId !== null && isLocalCopy(db, batchId);
}
