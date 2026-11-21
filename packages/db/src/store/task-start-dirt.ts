import type { DeviationId, SessionId, TaskId } from '@10db/contracts';
import { eq } from 'drizzle-orm';
import * as schema from '../schema';
import type { StartDirtEntry } from '../schema';

export type { StartDirtEntry } from '../schema';
import type { DbReader, WriteContext } from './store';

/** What the task's checkout held uncommitted that is not its work, or null before it first launched. */
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
 * Adds `paths` to the task's record as named in deviation `left.by` by session `left.in`, keeping
 * every other entry. A path the record already holds is named again; a task with no record gets one
 * holding only these.
 */
export function leaveTaskPaths(
  ctx: WriteContext,
  taskId: TaskId,
  paths: readonly string[],
  left: { readonly by: DeviationId; readonly in: SessionId },
): void {
  if (paths.length === 0) return;
  const named = new Set(paths);
  const kept = (getTaskStartDirt(ctx.tx, taskId) ?? []).filter((entry) => !named.has(entry.path));
  const entries = [
    ...kept,
    ...[...named].map((path) => ({ path, fingerprint: null, leftBy: left.by, leftIn: left.in })),
  ];
  ctx.tx
    .insert(schema.taskStartDirt)
    .values({ taskId, entries, createdAt: ctx.now })
    .onConflictDoUpdate({ target: schema.taskStartDirt.taskId, set: { entries } })
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
