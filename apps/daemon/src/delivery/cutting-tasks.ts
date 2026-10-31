import { TaskId, type BatchId } from '@10db/contracts';
import {
  deleteAppSetting,
  getAppSetting,
  listWorkstreams,
  setAppSetting,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import { z } from 'zod';

/**
 * The tasks a shared batch's start asked for, kept beside its CUTTING row: a shared cut inserts its
 * workstreams only once the branch is cut, so without this a restart mid-cut couldn't say which
 * tasks didn't start. A worktree batch's workstreams are inserted with the row and name them.
 */
export const cuttingTasksKey = (batchId: BatchId): string => `cutting_tasks.${batchId}`;

/** Records the tasks of a CUTTING shared batch, in the write that inserts it. */
export function recordCuttingTasks(
  w: WriteContext,
  batchId: BatchId,
  taskIds: Iterable<TaskId>,
): void {
  setAppSetting(w, cuttingTasksKey(batchId), [...taskIds]);
}

/** Drops the record once the cut ended: the batch opened, or was deleted. */
export function forgetCuttingTasks(w: WriteContext, batchId: BatchId): void {
  deleteAppSetting(w, cuttingTasksKey(batchId));
}

/**
 * The tasks a CUTTING batch was started for: its workstreams' and the recorded ones. Read before the
 * row is deleted, which detaches its workstreams. A record that doesn't parse names none.
 */
export function cuttingTasks(db: DbReader, batchId: BatchId): TaskId[] {
  const ids = new Set(listWorkstreams(db, { batchId }).map((w) => w.taskId));
  const recorded = z.array(TaskId).safeParse(getAppSetting(db, cuttingTasksKey(batchId)));
  if (recorded.success) for (const id of recorded.data) ids.add(id);
  return [...ids];
}
