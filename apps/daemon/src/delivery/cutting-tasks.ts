import { TaskId, type BatchId } from '@10db/contracts';
import {
  deleteAppSetting,
  getAppSetting,
  listWorkstreams,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import { z } from 'zod';

/**
 * Where a daemon before task placement kept the tasks of a CUTTING shared batch, whose workstreams
 * it inserted only once the branch was cut. Every start now inserts them with the row, so nothing
 * records here; recovery still reads and drops a record such a daemon left mid-cut.
 */
export const cuttingTasksKey = (batchId: BatchId): string => `cutting_tasks.${batchId}`;

/** Drops a record an earlier daemon left, once its batch is deleted. */
export function forgetCuttingTasks(w: WriteContext, batchId: BatchId): void {
  deleteAppSetting(w, cuttingTasksKey(batchId));
}

/**
 * The tasks a CUTTING batch was started for: its workstreams' and any an earlier daemon recorded.
 * Read before the row is deleted, which detaches its workstreams. A record that doesn't parse names
 * none.
 */
export function cuttingTasks(db: DbReader, batchId: BatchId): TaskId[] {
  const ids = new Set(listWorkstreams(db, { batchId }).map((w) => w.taskId));
  const recorded = z.array(TaskId).safeParse(getAppSetting(db, cuttingTasksKey(batchId)));
  if (recorded.success) for (const id of recorded.data) ids.add(id);
  return [...ids];
}
