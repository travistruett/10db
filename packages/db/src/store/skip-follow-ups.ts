import { TaskStatus, type BatchId, type TaskId, type WorkstreamId } from '@10db/contracts';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

// Trust line §5: a follow-up Run these now made, written once in the answer's own write
// and stamped once when it starts, so a crash between the press and the start loses neither.

export interface SkipFollowUp {
  readonly taskId: TaskId;
  readonly title: string;
  readonly sourceWorkstreamId: WorkstreamId;
  readonly sourceBatchId: BatchId | null;
  readonly startedAt: string | null;
}

export function insertSkipFollowUp(
  ctx: WriteContext,
  input: {
    readonly taskId: TaskId;
    readonly sourceWorkstreamId: WorkstreamId;
    readonly sourceBatchId: BatchId | null;
  },
): void {
  ctx.tx
    .insert(schema.skipFollowUps)
    .values({ ...input, startedAt: null, createdAt: ctx.now })
    .run();
}

/** A follow-up whose task is neither done nor removed: pending until it starts, then running. */
function live(db: DbReader, where: ReturnType<typeof and>): SkipFollowUp[] {
  return db
    .select({
      taskId: schema.skipFollowUps.taskId,
      title: schema.tasks.title,
      sourceWorkstreamId: schema.skipFollowUps.sourceWorkstreamId,
      sourceBatchId: schema.skipFollowUps.sourceBatchId,
      startedAt: schema.skipFollowUps.startedAt,
    })
    .from(schema.skipFollowUps)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.skipFollowUps.taskId))
    .where(and(where, sql`${schema.tasks.status} = ${TaskStatus.Open}`))
    .orderBy(asc(sql`skip_follow_ups.rowid`))
    .all();
}

/** The follow-ups not started yet, oldest first; a removed one is no longer pending. */
export function pendingSkipFollowUps(db: DbReader): SkipFollowUp[] {
  return live(db, and(isNull(schema.skipFollowUps.startedAt)));
}

/** Stamps the follow-up started, once. */
export function markSkipFollowUpStarted(ctx: WriteContext, taskId: TaskId): void {
  ctx.tx
    .update(schema.skipFollowUps)
    .set({ startedAt: ctx.now })
    .where(and(eq(schema.skipFollowUps.taskId, taskId), isNull(schema.skipFollowUps.startedAt)))
    .run();
}

/** The source run's follow-up while it is pending or running; null when it has none, or it ended. */
export function skipFollowUpOf(
  db: DbReader,
  sourceWorkstreamId: WorkstreamId,
): SkipFollowUp | null {
  return live(db, and(eq(schema.skipFollowUps.sourceWorkstreamId, sourceWorkstreamId)))[0] ?? null;
}

/** The task whose skipped calls `taskId` was made to run, whatever state either is in; null for any other task. */
export function skipFollowUpSourceTask(db: DbReader, taskId: TaskId): TaskId | null {
  const row = db
    .select({ taskId: schema.workstreams.taskId })
    .from(schema.skipFollowUps)
    .innerJoin(
      schema.workstreams,
      eq(schema.workstreams.id, schema.skipFollowUps.sourceWorkstreamId),
    )
    .where(eq(schema.skipFollowUps.taskId, taskId))
    .get();
  return row?.taskId ?? null;
}
