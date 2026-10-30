import {
  BatchState,
  canBatchTransition,
  ConflictError,
  EventType,
  isTerminal,
  mintId,
  NotFoundError,
  PullRequestState,
  UNFINISHED_BATCH_STATES,
  WorkstreamState,
  type BatchDto,
  type BatchFailure,
  type BatchId,
  type ProjectId,
  type PullRequestStatusDto,
} from '@10db/contracts';
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, type SQL } from 'drizzle-orm';
import type { Json } from '../json';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';
import { detachFromBatch, listWorkstreams, transitionWorkstream } from './workstreams';

export type BatchRow = typeof schema.batches.$inferSelect;

export interface BatchPatch {
  readonly branch?: string;
  readonly baseSha?: string;
  readonly repo?: string;
  readonly prUrl?: string;
  readonly gateExitCode?: number | null;
  readonly gateLogPath?: string | null;
  readonly gatePid?: number | null;
  readonly gatePidStart?: string | null;
  readonly failure?: BatchFailure | null;
  readonly worktreePath?: string | null;
  readonly returnBranch?: string | null;
  readonly returnSha?: string | null;
}

/** The pull request status a batch row holds; null until the watcher has read it once. */
function toPullRequestStatus(row: BatchRow): PullRequestStatusDto | null {
  if (row.prCheckedAt === null || row.prState === null || row.prChecks === null) return null;
  return {
    state: row.prState,
    checks: row.prChecks,
    failingChecks: row.prFailingChecks ?? [],
    checkedAt: row.prCheckedAt,
    unknownReason: row.prUnknownReason,
  };
}

/** The gate pid and the checkout's return place stay internal: only delivery reads them. */
function toBatchDto(row: BatchRow): BatchDto {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    state: row.state,
    branch: row.branch,
    baseBranch: row.baseBranch,
    autoMerge: row.autoMerge,
    baseSha: row.baseSha,
    repo: row.repo,
    prUrl: row.prUrl,
    pr: toPullRequestStatus(row),
    gateExitCode: row.gateExitCode,
    gateLogPath: row.gateLogPath,
    failure: row.failure,
    worktreePath: row.worktreePath,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function emitBatch(ctx: WriteContext, id: BatchId, data: Record<string, Json>): void {
  ctx.emit({ type: EventType.BatchUpdated, entityType: 'batch', entityId: id, data });
}

export function getBatchRow(db: DbReader, id: BatchId): BatchRow {
  const row = db.select().from(schema.batches).where(eq(schema.batches.id, id)).get();
  if (!row) throw new NotFoundError('batch', id);
  return row;
}

export function getBatch(db: DbReader, id: BatchId): BatchDto {
  return toBatchDto(getBatchRow(db, id));
}

const unfinished = inArray(schema.batches.state, [...UNFINISHED_BATCH_STATES]);

/**
 * The project's unfinished shared batch. A worktree batch holds its path from its CUTTING insert
 * until it has finished, so an unfinished row without a path is a shared one.
 */
export function findUnfinishedBatch(db: DbReader, projectId: ProjectId): BatchDto | undefined {
  const row = db
    .select()
    .from(schema.batches)
    .where(
      and(eq(schema.batches.projectId, projectId), unfinished, isNull(schema.batches.worktreePath)),
    )
    .get();
  return row ? toBatchDto(row) : undefined;
}

/** Every unfinished batch of the project in any mode, newest first. */
export function listUnfinishedBatches(db: DbReader, projectId: ProjectId): BatchDto[] {
  return db
    .select()
    .from(schema.batches)
    .where(and(eq(schema.batches.projectId, projectId), unfinished))
    .orderBy(desc(schema.batches.createdAt), desc(schema.batches.id))
    .all()
    .map(toBatchDto);
}

/** The batch a project view shows: the newest unfinished one, else the latest. */
export function currentBatch(db: DbReader, projectId: ProjectId): BatchDto | null {
  const newest = listUnfinishedBatches(db, projectId)[0];
  if (newest) return newest;
  const latest = db
    .select()
    .from(schema.batches)
    .where(eq(schema.batches.projectId, projectId))
    .orderBy(desc(schema.batches.createdAt), desc(schema.batches.id))
    .limit(1)
    .get();
  return latest ? toBatchDto(latest) : null;
}

/** Batches whose worktree path is still set, in any state: the worktrees the daemon still owns. */
export function listLiveWorktrees(db: DbReader): BatchDto[] {
  return db
    .select()
    .from(schema.batches)
    .where(isNotNull(schema.batches.worktreePath))
    .orderBy(asc(schema.batches.createdAt), asc(schema.batches.id))
    .all()
    .map(toBatchDto);
}

/**
 * Finished batches whose checkout still waits to be switched back, newest first: a batch cut while
 * the checkout was on an earlier one's branch goes back there before the earlier one goes back.
 */
export function listCheckoutReturns(db: DbReader): BatchRow[] {
  return db
    .select()
    .from(schema.batches)
    .where(
      and(
        isNotNull(schema.batches.returnSha),
        inArray(schema.batches.state, [
          BatchState.Shipped,
          BatchState.Closed,
          BatchState.Abandoned,
        ]),
      ),
    )
    .orderBy(desc(schema.batches.createdAt), desc(schema.batches.id))
    .all();
}

export function findBatchByWorktreePath(db: DbReader, path: string): BatchDto | undefined {
  const row = db.select().from(schema.batches).where(eq(schema.batches.worktreePath, path)).get();
  return row ? toBatchDto(row) : undefined;
}

export function listBatches(
  db: DbReader,
  filter: { readonly projectId?: ProjectId; readonly states?: readonly BatchState[] } = {},
): BatchDto[] {
  const where: SQL[] = [];
  if (filter.projectId) where.push(eq(schema.batches.projectId, filter.projectId));
  if (filter.states) where.push(inArray(schema.batches.state, [...filter.states]));
  return db
    .select()
    .from(schema.batches)
    .where(and(...where))
    .orderBy(asc(schema.batches.createdAt), asc(schema.batches.id))
    .all()
    .map(toBatchDto);
}

/** A new batch is CUTTING: the row exists before any git side effect (batch delivery spec §5). */
export function insertBatch(
  ctx: WriteContext,
  input: {
    readonly projectId: ProjectId;
    readonly title: string;
    readonly baseBranch: string;
    /** Whether the pull request merges by itself once its checks pass; absent means it does. */
    readonly autoMerge?: boolean;
    readonly id?: BatchId;
    /** A worktree batch names its worktree here; a shared batch leaves it out and runs alone. */
    readonly worktreePath?: string;
  },
): BatchDto {
  if (input.worktreePath === undefined) {
    const open = findUnfinishedBatch(ctx.tx, input.projectId);
    if (open) {
      throw new ConflictError(
        `Batch "${open.title}" is still ${open.state.toLowerCase()}; a project runs one batch at a time`,
      );
    }
  }
  const row: BatchRow = {
    id: input.id ?? mintId('Batch'),
    projectId: input.projectId,
    title: input.title,
    state: BatchState.Cutting,
    branch: null,
    baseBranch: input.baseBranch,
    autoMerge: input.autoMerge ?? true,
    baseSha: null,
    repo: null,
    prUrl: null,
    gateExitCode: null,
    gateLogPath: null,
    gatePid: null,
    gatePidStart: null,
    failure: null,
    worktreePath: input.worktreePath ?? null,
    returnBranch: null,
    returnSha: null,
    prState: null,
    prChecks: null,
    prFailingChecks: null,
    prCheckedAt: null,
    prUnknownReason: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.batches).values(row).run();
  emitBatch(ctx, row.id, { from: null, to: BatchState.Cutting, reason: null });
  return toBatchDto(row);
}

export function transitionBatch(
  ctx: WriteContext,
  id: BatchId,
  opts: { readonly to: BatchState; readonly patch?: BatchPatch; readonly reason?: string },
): BatchDto {
  const row = getBatchRow(ctx.tx, id);
  if (!canBatchTransition(row.state, opts.to))
    throw new ConflictError(`Cannot move batch "${row.title}" from ${row.state} to ${opts.to}`);
  ctx.tx
    .update(schema.batches)
    .set({ ...opts.patch, state: opts.to, updatedAt: ctx.now })
    .where(eq(schema.batches.id, id))
    .run();
  emitBatch(ctx, id, { from: row.state, to: opts.to, reason: opts.reason ?? null });
  return getBatch(ctx.tx, id);
}

export function patchBatch(ctx: WriteContext, id: BatchId, patch: BatchPatch): BatchDto {
  getBatchRow(ctx.tx, id);
  ctx.tx
    .update(schema.batches)
    .set({ ...patch, updatedAt: ctx.now })
    .where(eq(schema.batches.id, id))
    .run();
  emitBatch(ctx, id, { changed: Object.keys(patch) });
  return getBatch(ctx.tx, id);
}

/** What the PR watcher read of a pull request; stored whole, so a read is never half a status. */
export type PullRequestStatusInput = PullRequestStatusDto;

/** Whether a read says anything the stored status does not, `checkedAt` aside. */
function prStatusChanged(row: BatchRow, status: PullRequestStatusInput): boolean {
  return (
    row.prState !== status.state ||
    row.prChecks !== status.checks ||
    row.prUnknownReason !== status.unknownReason ||
    JSON.stringify(row.prFailingChecks ?? []) !== JSON.stringify(status.failingChecks)
  );
}

/**
 * Stores the latest read of a batch's pull request. A read that changes the status bumps
 * `updatedAt` and tells the UI with `batch.updated {changed:['pr']}`; one that changes nothing
 * only advances `checkedAt`, so a poll every two minutes leaves no event row behind.
 */
export function recordPullRequestStatus(
  ctx: WriteContext,
  id: BatchId,
  status: PullRequestStatusInput,
): BatchDto {
  const row = getBatchRow(ctx.tx, id);
  if (row.prCheckedAt !== null && !prStatusChanged(row, status)) {
    ctx.tx
      .update(schema.batches)
      .set({ prCheckedAt: status.checkedAt })
      .where(eq(schema.batches.id, id))
      .run();
    return getBatch(ctx.tx, id);
  }
  ctx.tx
    .update(schema.batches)
    .set({
      prState: status.state,
      prChecks: status.checks,
      prFailingChecks: status.failingChecks,
      prCheckedAt: status.checkedAt,
      prUnknownReason: status.unknownReason,
      updatedAt: ctx.now,
    })
    .where(eq(schema.batches.id, id))
    .run();
  emitBatch(ctx, id, { changed: ['pr'] });
  return getBatch(ctx.tx, id);
}

/**
 * The shipped batches whose pull request the watcher still follows, oldest first: one with a
 * pull request url whose state was never read, or reads open or unknown. Merged and closed are final.
 */
export function listWatchedPullRequests(db: DbReader): BatchDto[] {
  return db
    .select()
    .from(schema.batches)
    .where(
      and(
        eq(schema.batches.state, BatchState.Shipped),
        isNotNull(schema.batches.prUrl),
        or(
          isNull(schema.batches.prState),
          inArray(schema.batches.prState, [PullRequestState.Open, PullRequestState.Unknown]),
        ),
      ),
    )
    .orderBy(asc(schema.batches.createdAt), asc(schema.batches.id))
    .all()
    .map(toBatchDto);
}

/** Forgets the worktree of a finished batch, so the daemon stops treating it as live. */
export function clearWorktreePath(ctx: WriteContext, id: BatchId): BatchDto {
  return patchBatch(ctx, id, { worktreePath: null });
}

/**
 * A refused or interrupted cut leaves nothing behind: its workstreams are cancelled and detached,
 * so nothing references the row.
 */
export function deleteCuttingBatch(ctx: WriteContext, id: BatchId, reason: string): void {
  const row = getBatchRow(ctx.tx, id);
  if (row.state !== BatchState.Cutting)
    throw new ConflictError(
      `Batch "${row.title}" is ${row.state}; only a cutting batch is deleted`,
    );
  for (const ws of listWorkstreams(ctx.tx, { batchId: id })) {
    if (!isTerminal(ws.state))
      transitionWorkstream(ctx, ws.id, { to: WorkstreamState.Cancelled, fence: null, reason });
  }
  detachFromBatch(ctx, id);
  ctx.tx.delete(schema.batches).where(eq(schema.batches.id, id)).run();
  emitBatch(ctx, id, { from: BatchState.Cutting, to: null, reason });
}
