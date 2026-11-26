import {
  EventType,
  InvalidError,
  LinearPostState,
  mintId,
  type LinearEventKind,
  type LinearPostDto,
  type LinearPostId,
  type ProjectId,
  type ReportLinearPostInput,
  type SessionId,
  type TaskId,
} from '@10db/contracts';
import { and, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { Json } from '../json';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

type PostRow = typeof schema.linearPosts.$inferSelect;

function toDto(row: PostRow): LinearPostDto {
  return {
    id: row.id,
    taskId: row.taskId,
    event: row.event,
    attempt: row.attempt,
    detail: row.detail,
    state: row.state,
    tries: row.tries,
    dueAt: row.dueAt,
    lastError: row.lastError,
    withheldPattern: row.withheldPattern,
    sessionId: row.sessionId,
    commentIds: row.commentIds,
    statusSet: row.statusSet,
    attachmentUrl: row.attachmentUrl,
    dismissedAt: row.dismissedAt,
    createdAt: row.createdAt,
    recordedAt: row.recordedAt,
  };
}

function emitChanged(ctx: WriteContext, rows: readonly { taskId: TaskId; projectId: ProjectId }[]) {
  const seen = new Set<TaskId>();
  for (const row of rows) {
    if (seen.has(row.taskId)) continue;
    seen.add(row.taskId);
    ctx.emit({
      type: EventType.LinearPostChanged,
      entityType: 'task',
      entityId: row.taskId,
      data: { projectId: row.projectId },
    });
  }
}

function pendingByIds(ctx: WriteContext, ids: readonly LinearPostId[]): PostRow[] {
  if (ids.length === 0) return [];
  return ctx.tx
    .select()
    .from(schema.linearPosts)
    .where(
      and(
        inArray(schema.linearPosts.id, [...ids]),
        eq(schema.linearPosts.state, LinearPostState.Pending),
      ),
    )
    .all();
}

/** Inserts unless (taskId, dedupeKey) exists; returns the row or null for a repeat. */
export function enqueueLinearPost(
  ctx: WriteContext,
  input: {
    taskId: TaskId;
    projectId: ProjectId;
    event: LinearEventKind;
    dedupeKey: string;
    attempt: number;
    detail: Record<string, Json>;
    dueAt: string;
  },
): LinearPostDto | null {
  const row: PostRow = {
    id: mintId('LinearPost'),
    taskId: input.taskId,
    projectId: input.projectId,
    event: input.event,
    dedupeKey: input.dedupeKey,
    attempt: input.attempt,
    detail: input.detail,
    state: LinearPostState.Pending,
    tries: 0,
    dueAt: input.dueAt,
    lastError: null,
    withheldPattern: null,
    sessionId: null,
    commentIds: [],
    statusSet: null,
    attachmentUrl: null,
    dismissedAt: null,
    createdAt: ctx.now,
    recordedAt: null,
  };
  const inserted = ctx.tx
    .insert(schema.linearPosts)
    .values(row)
    .onConflictDoNothing({ target: [schema.linearPosts.taskId, schema.linearPosts.dedupeKey] })
    .returning({ id: schema.linearPosts.id })
    .all();
  if (inserted.length === 0) return null;
  emitChanged(ctx, [row]);
  return toDto(row);
}

/** A task's updates, newest first. */
export function listLinearPosts(db: DbReader, taskId: TaskId): LinearPostDto[] {
  return db
    .select()
    .from(schema.linearPosts)
    .where(eq(schema.linearPosts.taskId, taskId))
    .orderBy(desc(schema.linearPosts.createdAt), desc(schema.linearPosts.id))
    .all()
    .map(toDto);
}

/** Pending rows, oldest first, so a run reports in the order things happened. */
export function pendingLinearPosts(
  db: DbReader,
  filter: { taskId?: TaskId; projectId?: ProjectId } = {},
): LinearPostDto[] {
  const where: SQL[] = [eq(schema.linearPosts.state, LinearPostState.Pending)];
  if (filter.taskId !== undefined) where.push(eq(schema.linearPosts.taskId, filter.taskId));
  if (filter.projectId !== undefined)
    where.push(eq(schema.linearPosts.projectId, filter.projectId));
  return db
    .select()
    .from(schema.linearPosts)
    .where(and(...where))
    .orderBy(schema.linearPosts.createdAt, schema.linearPosts.id)
    .all()
    .map(toDto);
}

/** Notes the session that is writing these pending rows. */
export function takeLinearPosts(
  ctx: WriteContext,
  ids: readonly LinearPostId[],
  sessionId: SessionId,
): void {
  const rows = pendingByIds(ctx, ids);
  if (rows.length === 0) return;
  ctx.tx
    .update(schema.linearPosts)
    .set({ sessionId })
    .where(
      inArray(
        schema.linearPosts.id,
        rows.map((r) => r.id),
      ),
    )
    .run();
  emitChanged(ctx, rows);
}

/**
 * Settles pending rows as written or withheld; a row no longer pending is skipped. `dismissed` marks them seen at
 * once, for a row withheld that asks nothing of the builder.
 */
export function recordLinearPosts(
  ctx: WriteContext,
  ids: readonly LinearPostId[],
  outcome: Exclude<ReportLinearPostInput['outcome'], { state: 'failed' }>,
  opts: { readonly dismissed?: boolean } = {},
): void {
  const rows = pendingByIds(ctx, ids);
  if (rows.length === 0) return;
  const set: Partial<typeof schema.linearPosts.$inferInsert> =
    outcome.state === 'recorded'
      ? {
          state: LinearPostState.Recorded,
          commentIds: outcome.commentIds,
          statusSet: outcome.statusSet,
          attachmentUrl: outcome.attachmentUrl,
        }
      : { state: LinearPostState.Withheld, withheldPattern: outcome.pattern };
  ctx.tx
    .update(schema.linearPosts)
    .set({
      ...set,
      dueAt: null,
      lastError: null,
      recordedAt: ctx.now,
      ...(opts.dismissed === true ? { dismissedAt: ctx.now } : {}),
    })
    .where(
      inArray(
        schema.linearPosts.id,
        rows.map((r) => r.id),
      ),
    )
    .run();
  emitChanged(ctx, rows);
}

/** tries+1; at `maxTries` the row is failed, else due again at `dueAt`. Rows no longer pending are skipped. */
export function failLinearPosts(
  ctx: WriteContext,
  ids: readonly LinearPostId[],
  error: string,
  dueAt: string,
  maxTries: number,
): void {
  const rows = pendingByIds(ctx, ids);
  for (const row of rows) {
    const tries = row.tries + 1;
    const failed = tries >= maxTries;
    ctx.tx
      .update(schema.linearPosts)
      .set({
        tries,
        lastError: error,
        state: failed ? LinearPostState.Failed : LinearPostState.Pending,
        dueAt: failed ? null : dueAt,
      })
      .where(eq(schema.linearPosts.id, row.id))
      .run();
  }
  emitChanged(ctx, rows);
}

/**
 * Holds pending rows whose run never reached Linear, because the account's agent isn't signed in to it: no try
 * is spent (tries goes back to 0), the reason is kept and the row is due again at `dueAt`. A held row is a
 * pending row with tries 0 and a `lastError`. Rows no longer pending are skipped.
 */
export function holdLinearPosts(
  ctx: WriteContext,
  ids: readonly LinearPostId[],
  reason: string,
  dueAt: string,
): void {
  const rows = pendingByIds(ctx, ids);
  if (rows.length === 0) return;
  ctx.tx
    .update(schema.linearPosts)
    .set({ tries: 0, lastError: reason, dueAt })
    .where(
      inArray(
        schema.linearPosts.id,
        rows.map((r) => r.id),
      ),
    )
    .run();
  emitChanged(ctx, rows);
}

/** A held row: pending, no try spent, and the reason it is held. */
const HELD: SQL = sql`(${schema.linearPosts.state} = ${LinearPostState.Pending} and ${schema.linearPosts.tries} = 0 and ${schema.linearPosts.lastError} is not null)`;

/** Makes the project's held rows due at `dueAt`; answers their tasks. */
export function wakeHeldLinearPosts(
  ctx: WriteContext,
  projectId: ProjectId,
  dueAt: string,
): TaskId[] {
  const woken = ctx.tx
    .update(schema.linearPosts)
    .set({ dueAt })
    .where(and(eq(schema.linearPosts.projectId, projectId), HELD))
    .returning({ taskId: schema.linearPosts.taskId, projectId: schema.linearPosts.projectId })
    .all();
  emitChanged(ctx, woken);
  return [...new Set(woken.map((r) => r.taskId))];
}

/** Deletes pending rows of a task or project (the reporter was switched off); answers how many. */
export function dropPendingLinearPosts(
  ctx: WriteContext,
  filter: { taskId: TaskId; projectId?: never } | { projectId: ProjectId; taskId?: never },
): number {
  // Widened so the runtime check below covers callers that bypass the type.
  const { taskId, projectId }: { taskId?: TaskId; projectId?: ProjectId } = filter;
  const where: SQL[] = [eq(schema.linearPosts.state, LinearPostState.Pending)];
  if (taskId !== undefined) where.push(eq(schema.linearPosts.taskId, taskId));
  else if (projectId !== undefined) where.push(eq(schema.linearPosts.projectId, projectId));
  else throw new InvalidError('dropPendingLinearPosts needs a taskId or a projectId');
  const dropped = ctx.tx
    .delete(schema.linearPosts)
    .where(and(...where))
    .returning({ taskId: schema.linearPosts.taskId, projectId: schema.linearPosts.projectId })
    .all();
  emitChanged(ctx, dropped);
  return dropped.length;
}

/** Marks the project's failed and withheld rows as seen, so its Inbox count clears. */
export function dismissLinearPosts(ctx: WriteContext, projectId: ProjectId): void {
  const dismissed = ctx.tx
    .update(schema.linearPosts)
    .set({ dismissedAt: ctx.now })
    .where(
      and(
        eq(schema.linearPosts.projectId, projectId),
        inArray(schema.linearPosts.state, [LinearPostState.Failed, LinearPostState.Withheld]),
        isNull(schema.linearPosts.dismissedAt),
      ),
    )
    .returning({ taskId: schema.linearPosts.taskId, projectId: schema.linearPosts.projectId })
    .all();
  emitChanged(ctx, dismissed);
}

/**
 * The rows a project's Inbox card counts: pending with an error (on a retry, or held), and failed or withheld
 * and not dismissed.
 */
const needsBuilder = (projectId: ProjectId): SQL | undefined =>
  and(
    eq(schema.linearPosts.projectId, projectId),
    or(
      and(
        eq(schema.linearPosts.state, LinearPostState.Pending),
        isNotNull(schema.linearPosts.lastError),
      ),
      and(
        inArray(schema.linearPosts.state, [LinearPostState.Failed, LinearPostState.Withheld]),
        isNull(schema.linearPosts.dismissedAt),
      ),
    ),
  );

/** The card's group of a row it counts: held rows apart from the other pending ones. */
const cardGroup = sql<string>`case when ${HELD} then 'held' else ${schema.linearPosts.state} end`;

/**
 * waiting = pending on a retry (tries > 0); held = pending for a Linear sign-in (tries 0, an error); failed and
 * withheld count undismissed rows only.
 */
export function linearPostCounts(
  db: DbReader,
  projectId: ProjectId,
): { waiting: number; held: number; failed: number; withheld: number } {
  const rows = db
    .select({ group: cardGroup, n: sql<number>`count(*)` })
    .from(schema.linearPosts)
    .where(needsBuilder(projectId))
    .groupBy(cardGroup)
    .all();
  const count = (group: string): number => rows.find((r) => r.group === group)?.n ?? 0;
  return {
    waiting: count(LinearPostState.Pending),
    held: count('held'),
    failed: count(LinearPostState.Failed),
    withheld: count(LinearPostState.Withheld),
  };
}

/**
 * The rows `linearPostCounts` counts, held rows first and then the newest problem, at most `limit` of them; the
 * first is the reason the card leads with.
 */
export function linearPostProblems(
  db: DbReader,
  projectId: ProjectId,
  limit: number,
): LinearPostDto[] {
  return db
    .select()
    .from(schema.linearPosts)
    .where(needsBuilder(projectId))
    .orderBy(
      desc(sql<number>`case when ${HELD} then 1 else 0 end`),
      desc(
        sql`coalesce(${schema.linearPosts.recordedAt}, ${schema.linearPosts.dueAt}, ${schema.linearPosts.createdAt})`,
      ),
      desc(schema.linearPosts.id),
    )
    .limit(limit)
    .all()
    .map(toDto);
}
