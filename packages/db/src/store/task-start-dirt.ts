import type { TaskId } from '@10db/contracts';
import { eq } from 'drizzle-orm';
import * as schema from '../schema';
import type { StartDirtEntry } from '../schema';

export type { StartDirtEntry } from '../schema';
import type { DbReader, WriteContext } from './store';

/** What the task's checkout held uncommitted when it first launched, or null before that. */
export function getTaskStartDirt(db: DbReader, taskId: TaskId): readonly StartDirtEntry[] | null {
  const row = db
    .select({ entries: schema.taskStartDirt.entries })
    .from(schema.taskStartDirt)
    .where(eq(schema.taskStartDirt.taskId, taskId))
    .get();
  return row?.entries ?? null;
}

/** Records it once: a task that already has a record keeps its first. */
export function recordTaskStartDirt(
  ctx: WriteContext,
  taskId: TaskId,
  entries: readonly StartDirtEntry[],
): void {
  ctx.tx
    .insert(schema.taskStartDirt)
    .values({ taskId, entries: [...entries], createdAt: ctx.now })
    .onConflictDoNothing()
    .run();
}
