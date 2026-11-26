import {
  approvalOf,
  Approval,
  ConflictError,
  EventType,
  mintId,
  SkipKind,
  SkipSource,
  TaskStatus,
  type LimitName,
  type ProjectId,
  type SessionId,
  type SkippedActionDto,
  type SkippedActionId,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import { and, asc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

// Trust line §5: what an unattended lane skipped, one row per call in a run, and the
// skips the builder approved for a follow-up, read only until that follow-up is done.

export interface SkipInput {
  readonly workstreamId: WorkstreamId;
  readonly sessionId: SessionId | null;
  readonly toolName: string;
  readonly toolUseId: string | null;
  readonly callKey: string | null;
  readonly summary: string;
  /** The summary was cut to fit; the builder never sees the whole call. */
  readonly summaryCut?: boolean;
  readonly kind: SkipKind;
  readonly limit: LimitName | null;
  readonly reason: string;
  readonly source: SkipSource;
  /** The program the shell call runs (`trust/program-key.ts`); null for a call with no key. */
  readonly programKey?: string | null;
}

type SkipRow = typeof schema.skippedActions.$inferSelect;

const dtoOf = (row: SkipRow): SkippedActionDto => ({
  id: row.id,
  workstreamId: row.workstreamId,
  toolName: row.toolName,
  summary: row.summary,
  kind: row.kind,
  limit: row.limitName,
  reason: row.reason,
  source: row.source,
  approval: approvalOf(row.kind, row.summaryCut),
  programKey: row.programKey,
  createdAt: row.createdAt,
});

/**
 * Records a skip in the caller's write; a second one of the same call in the run adds no row and
 * answers null, keeping the stricter of the two. A written skip changes its run's task,
 * so the task's views follow.
 */
export function recordSkip(ctx: WriteContext, input: SkipInput): SkippedActionId | null {
  const id = mintId('SkippedAction');
  const written = ctx.tx
    .insert(schema.skippedActions)
    .values({
      id,
      workstreamId: input.workstreamId,
      sessionId: input.sessionId,
      toolName: input.toolName,
      toolUseId: input.toolUseId,
      callKey: input.callKey,
      summary: input.summary,
      summaryCut: input.summaryCut ?? false,
      kind: input.kind,
      limitName: input.limit,
      reason: input.reason,
      source: input.source,
      programKey: input.programKey ?? null,
      createdAt: ctx.now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.skippedActions.id })
    .all();
  if (written.length === 0) {
    tighten(ctx, input);
    return null;
  }
  const run = ctx.tx
    .select({ taskId: schema.workstreams.taskId })
    .from(schema.workstreams)
    .where(eq(schema.workstreams.id, input.workstreamId))
    .get();
  if (run !== undefined)
    ctx.emit({
      type: EventType.TaskChanged,
      entityType: 'task',
      entityId: run.taskId,
      data: { skipped: id },
    });
  return id;
}

/**
 * A second report of a call already recorded keeps the stricter of the two: a kind nothing approves
 * replaces one that could be approved, and a summary cut in either report counts as cut, so a looser
 * first report can't be what Run these now approves.
 */
function tighten(ctx: WriteContext, input: SkipInput): void {
  if (input.toolUseId === null) return;
  const kept = ctx.tx
    .select()
    .from(schema.skippedActions)
    .where(
      and(
        eq(schema.skippedActions.workstreamId, input.workstreamId),
        eq(schema.skippedActions.toolUseId, input.toolUseId),
      ),
    )
    .get();
  if (kept === undefined) return;
  const summaryCut = kept.summaryCut || (input.summaryCut ?? false);
  const stricter =
    approvalOf(kept.kind, summaryCut) !== Approval.None &&
    approvalOf(input.kind, summaryCut) === Approval.None;
  ctx.tx
    .update(schema.skippedActions)
    .set({
      summaryCut,
      ...(stricter
        ? {
            kind: input.kind,
            limitName: input.limit,
            reason: input.reason,
            source: input.source,
            programKey: input.programKey ?? null,
          }
        : {}),
    })
    .where(eq(schema.skippedActions.id, kept.id))
    .run();
}

/** The run's skips in the order they were recorded; with `after`, only those recorded later. */
export function listSkipsForWorkstream(
  db: DbReader,
  workstreamId: WorkstreamId,
  after?: SkippedActionId,
): SkippedActionDto[] {
  const from =
    after === undefined
      ? undefined
      : sql`rowid > (SELECT rowid FROM skipped_actions WHERE id = ${after})`;
  return db
    .select()
    .from(schema.skippedActions)
    .where(and(eq(schema.skippedActions.workstreamId, workstreamId), from))
    .orderBy(asc(sql`rowid`))
    .all()
    .map(dtoOf);
}

/** A skip 10db's judge made because it doubted a call, with the program it ran and the run it came from. */
export interface DoubtSkip {
  readonly id: SkippedActionId;
  readonly programKey: string;
  readonly summary: string;
  readonly limitName: LimitName | null;
  readonly workstreamId: WorkstreamId;
  readonly taskId: TaskId;
  /** The run was in a separate copy. */
  readonly inCopy: boolean;
  readonly createdAt: string;
}

/**
 * The project's skips by 10db's judge's classifier since `since`, each with a program key and its whole summary,
 * oldest first: the calls a precedent could have answered. A skip is the project's through its run.
 */
export function listDoubtSkips(db: DbReader, projectId: ProjectId, since: string): DoubtSkip[] {
  return db
    .select({
      id: schema.skippedActions.id,
      programKey: schema.skippedActions.programKey,
      summary: schema.skippedActions.summary,
      limitName: schema.skippedActions.limitName,
      workstreamId: schema.workstreams.id,
      taskId: schema.workstreams.taskId,
      copy: schema.localCopies.batchId,
      createdAt: schema.skippedActions.createdAt,
    })
    .from(schema.skippedActions)
    .innerJoin(schema.workstreams, eq(schema.workstreams.id, schema.skippedActions.workstreamId))
    .leftJoin(schema.localCopies, eq(schema.localCopies.batchId, schema.workstreams.batchId))
    .where(
      and(
        eq(schema.workstreams.projectId, projectId),
        eq(schema.skippedActions.source, SkipSource.TendbJudge),
        eq(schema.skippedActions.kind, SkipKind.Classifier),
        eq(schema.skippedActions.summaryCut, false),
        isNotNull(schema.skippedActions.programKey),
        gte(schema.skippedActions.createdAt, since),
      ),
    )
    .orderBy(asc(schema.skippedActions.createdAt), asc(sql`skipped_actions.rowid`))
    .all()
    .flatMap((row) =>
      row.programKey === null
        ? []
        : [
            {
              id: row.id,
              programKey: row.programKey,
              summary: row.summary,
              limitName: row.limitName,
              workstreamId: row.workstreamId,
              taskId: row.taskId,
              inCopy: row.copy !== null,
              createdAt: row.createdAt,
            },
          ],
    );
}

/** The ids among `ids` that the builder approved for a follow-up with Run these now, at any time. */
export function approvedSkipIds(
  db: DbReader,
  ids: readonly SkippedActionId[],
): Set<SkippedActionId> {
  if (ids.length === 0) return new Set();
  return new Set(
    db
      .select({ id: schema.skipApprovals.skippedActionId })
      .from(schema.skipApprovals)
      .where(inArray(schema.skipApprovals.skippedActionId, [...ids]))
      .all()
      .map((row) => row.id),
  );
}

/**
 * Approves skips for a follow-up task. Every one must be its project's and approvable; otherwise
 * nothing is written and ConflictError says which.
 */
export function approveSkips(
  ctx: WriteContext,
  followUp: TaskId,
  ids: readonly SkippedActionId[],
): void {
  if (ids.length === 0) return;
  const task = ctx.tx
    .select({ projectId: schema.tasks.projectId })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, followUp))
    .get();
  if (task === undefined) throw new ConflictError(`No task ${followUp} to approve skips for`);
  const rows = ctx.tx
    .select({ skip: schema.skippedActions, projectId: schema.workstreams.projectId })
    .from(schema.skippedActions)
    .innerJoin(schema.workstreams, eq(schema.workstreams.id, schema.skippedActions.workstreamId))
    .where(inArray(schema.skippedActions.id, [...ids]))
    .all();
  const found = new Map(rows.map((r) => [r.skip.id, r]));
  for (const id of ids) {
    const row = found.get(id);
    if (row?.projectId !== task.projectId)
      throw new ConflictError(`Skip ${id} is not this project's`);
    if (approvalOf(row.skip.kind, row.skip.summaryCut) === Approval.None)
      throw new ConflictError(`Skip ${id} is not one Run these now can approve`);
  }
  ctx.tx
    .insert(schema.skipApprovals)
    .values(ids.map((skippedActionId) => ({ taskId: followUp, skippedActionId })))
    .onConflictDoNothing()
    .run();
}

function approvedRows(db: DbReader, taskId: TaskId): SkipRow[] {
  return db
    .select({ skip: schema.skippedActions })
    .from(schema.skipApprovals)
    .innerJoin(
      schema.skippedActions,
      eq(schema.skippedActions.id, schema.skipApprovals.skippedActionId),
    )
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.skipApprovals.taskId))
    .where(
      and(
        eq(schema.skipApprovals.taskId, taskId),
        sql`${schema.tasks.status} <> ${TaskStatus.Done}`,
      ),
    )
    .orderBy(asc(sql`skipped_actions.rowid`))
    .all()
    .map((r) => r.skip);
}

/** The skips approved for a follow-up, oldest first; none once it is done. */
export function approvedSkipsForTask(db: DbReader, taskId: TaskId): SkippedActionDto[] {
  return approvedRows(db, taskId).map(dtoOf);
}

/** The keys of the calls approved for a follow-up, matched exactly; none once it is done. */
export function approvedCallKeys(db: DbReader, taskId: TaskId): string[] {
  return approvedRows(db, taskId).flatMap((row) => (row.callKey === null ? [] : [row.callKey]));
}
