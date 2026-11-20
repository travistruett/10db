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

/**
 * Whether any session has run for the task, in any of its workstreams, a pass page's included: once
 * one has, what the checkout holds uncommitted may be the task's own work.
 */
export function taskHasRunASession(db: DbReader, taskId: TaskId): boolean {
  const row = db
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .innerJoin(schema.workstreams, eq(schema.workstreams.id, schema.sessions.workstreamId))
    .where(eq(schema.workstreams.taskId, taskId))
    .limit(1)
    .get();
  return row !== undefined;
}
