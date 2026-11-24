import {
  approvalOf,
  Approval,
  ConflictError,
  EventType,
  mintId,
  TaskStatus,
  type LimitName,
  type SessionId,
  type SkipKind,
  type SkippedActionDto,
  type SkippedActionId,
  type SkipSource,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '../schema';
import { skipFollowUpSourceTask } from './skip-follow-ups';
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

/**
 * The skips among `skips` that a follow-up already ran: their call key (the call's normalized tool and
 * arguments) was approved for `taskId` or for an earlier task of its follow-up chain, so a later run
 * skipping the same call again is not a new thing for the builder to approve.
 */
export function skipsAlreadyApproved(
  db: DbReader,
  taskId: TaskId,
  skips: readonly SkippedActionDto[],
): SkippedActionId[] {
  const chain: TaskId[] = [taskId];
  for (
    let source = skipFollowUpSourceTask(db, taskId);
    source !== null && !chain.includes(source);
    source = skipFollowUpSourceTask(db, source)
  )
    chain.push(source);
  const approved = new Set(
    db
      .select({ callKey: schema.skippedActions.callKey })
      .from(schema.skipApprovals)
      .innerJoin(
        schema.skippedActions,
        eq(schema.skippedActions.id, schema.skipApprovals.skippedActionId),
      )
      .where(inArray(schema.skipApprovals.taskId, chain))
      .all()
      .flatMap((r) => (r.callKey === null ? [] : [r.callKey])),
  );
  if (approved.size === 0) return [];
  return db
    .select({ id: schema.skippedActions.id })
    .from(schema.skippedActions)
    .where(
      and(
        inArray(
          schema.skippedActions.id,
          skips.map((s) => s.id),
        ),
        inArray(schema.skippedActions.callKey, [...approved]),
      ),
    )
    .all()
    .map((r) => r.id);
}
