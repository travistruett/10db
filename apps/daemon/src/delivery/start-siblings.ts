import { BatchId, type TaskId } from '@10db/contracts';
import {
  deleteAppSetting,
  getAppSetting,
  listWorkstreams,
  setAppSetting,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import { z } from 'zod';
import type { SameStart } from './landing';

/**
 * Where a CUTTING batch keeps the batches its start made (itself included), so a cut a restart
 * repeats still knows which batches and tasks are the same start's, which are no use of the landing
 * branch to each other. It lives only while the cut runs; an app setting needs no migration.
 */
export const startSiblingsKey = (batchId: BatchId): string => `start_siblings.${batchId}`;

/** Records, for each batch of one start, every batch of it. A start of one batch records nothing. */
export function recordStartSiblings(w: WriteContext, batchIds: readonly BatchId[]): void {
  if (batchIds.length < 2) return;
  for (const id of batchIds) setAppSetting(w, startSiblingsKey(id), [...batchIds]);
}

/** Drops the record, once the batch's cut is done or its row is deleted. */
export function forgetStartSiblings(w: WriteContext, batchId: BatchId): void {
  deleteAppSetting(w, startSiblingsKey(batchId));
}

/**
 * What the start that made the batch made, read back after a restart: its batches and their tasks
 * (the workstreams they came with). Nothing but the batch itself when no record names others.
 */
export function startSiblings(db: DbReader, batchId: BatchId): SameStart {
  const recorded = z.array(BatchId).safeParse(getAppSetting(db, startSiblingsKey(batchId)));
  const batches = new Set<BatchId>(recorded.success ? recorded.data : []);
  batches.add(batchId);
  const tasks = new Set<TaskId>();
  for (const id of batches)
    for (const ws of listWorkstreams(db, { batchId: id })) tasks.add(ws.taskId);
  return { tasks, batches };
}
