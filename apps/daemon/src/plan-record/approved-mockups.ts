import type { ApprovedMockup, TaskId } from '@10db/contracts';
import { listApprovedMockupsOfTask, type DbReader } from '@10db/db';

/** The mock-ups the builder approved for a task, as its lane's brief and drawer carry them. */
export function approvedMockupsOf(db: DbReader, taskId: TaskId): ApprovedMockup[] {
  return listApprovedMockupsOfTask(db, taskId).map((row) => ({
    id: row.id,
    key: row.key,
    html: row.body,
  }));
}
