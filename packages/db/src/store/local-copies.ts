import { createHash } from 'node:crypto';
import {
  CopyId,
  CopyStep,
  EventType,
  LocalCopyDto,
  NotFoundError,
  type BatchDto,
  type BatchId,
  type ProjectId,
} from '@10db/contracts';
import { eq, ne } from 'drizzle-orm';
import * as schema from '../schema';
import { listUnfinishedBatches } from './batches';
import type { DbReader, WriteContext } from './store';

/** The first 12 hex digits of the SHA-256 of the batch id (node:crypto, so it lives in db, not contracts). */
export function copyIdOf(batchId: BatchId): CopyId {
  return CopyId.parse(createHash('sha256').update(batchId).digest('hex').slice(0, 12));
}

/** The journal row is read back through zod: its waits and steps are text in the database. */
function toLocalCopy(row: typeof schema.localCopies.$inferSelect): LocalCopyDto {
  return LocalCopyDto.parse(row);
}

function emitCopy(ctx: WriteContext, copy: LocalCopyDto): void {
  ctx.emit({
    type: EventType.BatchUpdated,
    entityType: 'batch',
    entityId: copy.batchId,
    data: { copyStep: copy.step, copyWait: copy.wait },
  });
}

export function insertLocalCopy(
  w: WriteContext,
  row: {
    batchId: BatchId;
    teardownCommand: string;
    step?: typeof CopyStep.Open | typeof CopyStep.Queued;
  },
): LocalCopyDto {
  const copy = toLocalCopy({
    batchId: row.batchId,
    copyId: copyIdOf(row.batchId),
    step: row.step ?? CopyStep.Open,
    baseTip: null,
    candidate: null,
    attempt: 0,
    wait: null,
    waitDetail: [],
    retryAt: null,
    teardownCommand: row.teardownCommand,
    teardownSha: null,
    updatedAt: w.now,
  });
  w.tx
    .insert(schema.localCopies)
    .values({ ...copy, waitDetail: [...copy.waitDetail] })
    .run();
  emitCopy(w, copy);
  return copy;
}

export function getLocalCopy(db: DbReader, batchId: BatchId): LocalCopyDto | null {
  const row = db
    .select()
    .from(schema.localCopies)
    .where(eq(schema.localCopies.batchId, batchId))
    .get();
  return row ? toLocalCopy(row) : null;
}

/** A batch is a local copy exactly when it has a journal row. */
export function isLocalCopy(db: DbReader, batchId: BatchId): boolean {
  return getLocalCopy(db, batchId) !== null;
}

export type LocalCopyPatch = Partial<
  Pick<
    LocalCopyDto,
    | 'step'
    | 'baseTip'
    | 'candidate'
    | 'attempt'
    | 'wait'
    | 'waitDetail'
    | 'retryAt'
    | 'teardownSha'
    | 'teardownCommand'
  >
>;

function writeCopy(
  w: WriteContext,
  batchId: BatchId,
  set: Partial<typeof schema.localCopies.$inferInsert>,
): LocalCopyDto {
  const result = w.tx
    .update(schema.localCopies)
    .set({ ...set, updatedAt: w.now })
    .where(eq(schema.localCopies.batchId, batchId))
    .run();
  const copy = getLocalCopy(w.tx, batchId);
  if (result.changes === 0 || copy === null) throw new NotFoundError('local copy', batchId);
  emitCopy(w, copy);
  return copy;
}

export function patchLocalCopy(
  w: WriteContext,
  batchId: BatchId,
  patch: LocalCopyPatch,
): LocalCopyDto {
  const { waitDetail, ...rest } = patch;
  return writeCopy(w, batchId, {
    ...rest,
    ...(waitDetail === undefined ? {} : { waitDetail: [...waitDetail] }),
  });
}

/** Step promoting and wait null: the landing may have written the builder's folder. */
export function isLivePromoting(copy: LocalCopyDto): boolean {
  return copy.step === CopyStep.Promoting && copy.wait === null;
}

/** Step open, candidate and wait cleared, attempt 0; a no-op while live at promoting. */
export function resetLocalCopy(w: WriteContext, batchId: BatchId): LocalCopyDto {
  const copy = getLocalCopy(w.tx, batchId);
  if (copy === null) throw new NotFoundError('local copy', batchId);
  if (isLivePromoting(copy)) return copy;
  return writeCopy(w, batchId, {
    step: CopyStep.Open,
    candidate: null,
    wait: null,
    waitDetail: [],
    retryAt: null,
    attempt: 0,
  });
}

/** Every journal that has not been retired. */
export function listOpenLocalCopies(db: DbReader): LocalCopyDto[] {
  return db
    .select()
    .from(schema.localCopies)
    .where(ne(schema.localCopies.step, CopyStep.Retired))
    .all()
    .map(toLocalCopy);
}

/**
 * The project's copy batch in CUTTING, OPEN, SHIPPING or FAILED, if any, one waiting its turn
 * included: a copy that has been started is unfinished until it ships or is abandoned.
 */
export function unfinishedCopyOf(db: DbReader, projectId: ProjectId): BatchDto | null {
  return listUnfinishedBatches(db, projectId).find((b) => isLocalCopy(db, b.id)) ?? null;
}

/** The project's unfinished copy that has been cut, or is being cut: the one the others wait for. */
export function copyInProgressOf(db: DbReader, projectId: ProjectId): BatchDto | null {
  return (
    listUnfinishedBatches(db, projectId).find((b) => {
      const copy = getLocalCopy(db, b.id);
      return copy !== null && copy.step !== CopyStep.Queued;
    }) ?? null
  );
}

/** The project's copy batches still waiting for their turn, the one started first leading. */
export function queuedCopiesOf(db: DbReader, projectId: ProjectId): BatchDto[] {
  return listUnfinishedBatches(db, projectId)
    .filter((b) => getLocalCopy(db, b.id)?.step === CopyStep.Queued)
    .reverse();
}

/** Every batch, of any project, whose copy waits for its turn: no cut has begun for it. */
export function queuedCopyBatchIds(db: DbReader): BatchId[] {
  return db
    .select({ batchId: schema.localCopies.batchId })
    .from(schema.localCopies)
    .where(eq(schema.localCopies.step, CopyStep.Queued))
    .all()
    .map((row) => row.batchId);
}
