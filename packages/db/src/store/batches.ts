import {
  BatchState,
  canBatchTransition,
  ConflictError,
  EventType,
  mintId,
  NotFoundError,
  UNFINISHED_BATCH_STATES,
  type BatchDto,
  type BatchFailure,
  type BatchId,
  type ProjectId,
} from '@10db/contracts';
import { and, asc, desc, eq, inArray, type SQL } from 'drizzle-orm';
import type { Json } from '../json';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

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
}

/** The gate pid stays internal: only recovery reads it. */
function toBatchDto(row: BatchRow): BatchDto {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    state: row.state,
    branch: row.branch,
    baseBranch: row.baseBranch,
    baseSha: row.baseSha,
    repo: row.repo,
    prUrl: row.prUrl,
    gateExitCode: row.gateExitCode,
    gateLogPath: row.gateLogPath,
    failure: row.failure,
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

export function findUnfinishedBatch(db: DbReader, projectId: ProjectId): BatchDto | undefined {
  const row = db
    .select()
    .from(schema.batches)
    .where(
      and(
        eq(schema.batches.projectId, projectId),
        inArray(schema.batches.state, [...UNFINISHED_BATCH_STATES]),
      ),
    )
    .get();
  return row ? toBatchDto(row) : undefined;
}

/** The batch a project view shows: the unfinished one, else the latest. */
export function currentBatch(db: DbReader, projectId: ProjectId): BatchDto | null {
  const unfinished = findUnfinishedBatch(db, projectId);
  if (unfinished) return unfinished;
  const latest = db
    .select()
    .from(schema.batches)
    .where(eq(schema.batches.projectId, projectId))
    .orderBy(desc(schema.batches.createdAt), desc(schema.batches.id))
    .limit(1)
    .get();
  return latest ? toBatchDto(latest) : null;
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
  input: { readonly projectId: ProjectId; readonly title: string; readonly baseBranch: string },
): BatchDto {
  const unfinished = findUnfinishedBatch(ctx.tx, input.projectId);
  if (unfinished) {
    throw new ConflictError(
      `Batch "${unfinished.title}" is still ${unfinished.state.toLowerCase()}; a project runs one batch at a time`,
    );
  }
  const row: BatchRow = {
    id: mintId('Batch'),
    projectId: input.projectId,
    title: input.title,
    state: BatchState.Cutting,
    branch: null,
    baseBranch: input.baseBranch,
    baseSha: null,
    repo: null,
    prUrl: null,
    gateExitCode: null,
    gateLogPath: null,
    gatePid: null,
    gatePidStart: null,
    failure: null,
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

/** A refused or interrupted cut leaves nothing behind: nothing references a CUTTING row. */
export function deleteCuttingBatch(ctx: WriteContext, id: BatchId, reason: string): void {
  const row = getBatchRow(ctx.tx, id);
  if (row.state !== BatchState.Cutting)
    throw new ConflictError(
      `Batch "${row.title}" is ${row.state}; only a cutting batch is deleted`,
    );
  ctx.tx.delete(schema.batches).where(eq(schema.batches.id, id)).run();
  emitBatch(ctx, id, { from: BatchState.Cutting, to: null, reason });
}
