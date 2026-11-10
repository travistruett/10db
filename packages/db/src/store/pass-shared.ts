import {
  ConflictError,
  EventType,
  NotFoundError,
  type ClaimId,
  type PassHoldDto,
  type PassId,
  type PassSharedChangeDto,
  type SharedPathBlob,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import { and, asc, eq, isNull, max } from 'drizzle-orm';
import * as schema from '../schema';
import { getPass } from './passes';
import type { DbReader, WriteContext } from './store';

// Workbench spec §7.2, §11, §12: a pass task's holds on shared areas and the pass's shared chain. A
// hold is numbered in its grant's own write, and its change is kept in the write that closes it, so a
// restart finds every hold and change as it was.

type HoldRow = typeof schema.passHolds.$inferSelect;
type ChangeRow = typeof schema.passSharedChanges.$inferSelect;

function toHoldDto(row: HoldRow): PassHoldDto {
  return {
    claimId: row.claimId,
    passId: row.passId,
    taskId: row.taskId,
    workstreamId: row.workstreamId,
    area: row.area,
    seq: row.seq,
    recordSha: row.recordSha,
    grantedAt: row.grantedAt,
    closedAt: row.closedAt,
    empty: row.empty,
  };
}

function toChangeDto(row: ChangeRow): PassSharedChangeDto {
  return {
    passId: row.passId,
    seq: row.seq,
    taskId: row.taskId,
    sha: row.sha,
    paths: row.paths,
    blobs: row.blobs,
    dirtyKept: row.dirtyKept,
    landedSha: row.landedSha,
    droppedBy: row.droppedBy,
    dropOf: row.dropOf,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function emitPass(ctx: WriteContext, passId: PassId, data: Record<string, string | number>): void {
  ctx.emit({ type: EventType.PassChanged, entityType: 'pass', entityId: passId, data });
}

/**
 * The highest number given on the pass's chain, to a hold or to a drop, or null with none: a turn's
 * kept work records it, since a page was built with every change granted so far, open holds included.
 */
export function maxGrantedSeq(db: DbReader, passId: PassId): number | null {
  const held = db
    .select({ seq: max(schema.passHolds.seq) })
    .from(schema.passHolds)
    .where(eq(schema.passHolds.passId, passId))
    .get()?.seq;
  const changed = db
    .select({ seq: max(schema.passSharedChanges.seq) })
    .from(schema.passSharedChanges)
    .where(eq(schema.passSharedChanges.passId, passId))
    .get()?.seq;
  const highest = Math.max(held ?? 0, changed ?? 0);
  return highest === 0 ? null : highest;
}

export interface HoldInsert {
  /** The claim the area was granted as, in the same write. */
  readonly claimId: ClaimId;
  readonly passId: PassId;
  readonly taskId: TaskId;
  readonly workstreamId: WorkstreamId;
  readonly area: string;
  /** The unsigned commit holding the content of the record's paths. */
  readonly recordSha: string;
  /** Each path of the area that differs from the chain's tip, with the hash of its content on disk. */
  readonly record: readonly SharedPathBlob[];
}

/**
 * Writes a hold and its record in the grant's write, numbered after every hold and drop of the pass.
 * The unique index on the pass and the number refuses a second writer that numbered from a stale read.
 */
export function insertHold(ctx: WriteContext, input: HoldInsert): PassHoldDto {
  const row: HoldRow = {
    claimId: input.claimId,
    passId: input.passId,
    taskId: input.taskId,
    workstreamId: input.workstreamId,
    area: input.area,
    seq: (maxGrantedSeq(ctx.tx, input.passId) ?? 0) + 1,
    recordSha: input.recordSha,
    grantedAt: ctx.now,
    closedAt: null,
    empty: false,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.passHolds).values(row).run();
  for (const entry of input.record)
    ctx.tx
      .insert(schema.passHoldPaths)
      .values({ claimId: input.claimId, path: entry.path, blob: entry.blob, createdAt: ctx.now })
      .run();
  emitPass(ctx, input.passId, { holdSeq: row.seq, taskId: input.taskId, area: input.area });
  return toHoldDto(row);
}

export function getHold(db: DbReader, claimId: ClaimId): PassHoldDto {
  const row = db.select().from(schema.passHolds).where(eq(schema.passHolds.claimId, claimId)).get();
  if (!row) throw new NotFoundError('shared hold', claimId);
  return toHoldDto(row);
}

/** The record taken at the hold's grant, by path. */
export function holdRecord(db: DbReader, claimId: ClaimId): SharedPathBlob[] {
  return db
    .select({ path: schema.passHoldPaths.path, blob: schema.passHoldPaths.blob })
    .from(schema.passHoldPaths)
    .where(eq(schema.passHoldPaths.claimId, claimId))
    .orderBy(asc(schema.passHoldPaths.path))
    .all();
}

/** Closes an open hold once its turn's end has kept it; `empty` when it changed nothing. */
export function closeHold(
  ctx: WriteContext,
  claimId: ClaimId,
  input: { readonly empty: boolean },
): PassHoldDto {
  const hold = getHold(ctx.tx, claimId);
  if (hold.closedAt !== null)
    throw new ConflictError(`Shared hold ${String(hold.seq)} is already closed`);
  ctx.tx
    .update(schema.passHolds)
    .set({ closedAt: ctx.now, empty: input.empty, updatedAt: ctx.now })
    .where(eq(schema.passHolds.claimId, claimId))
    .run();
  emitPass(ctx, hold.passId, { holdSeq: hold.seq, closed: 1 });
  return getHold(ctx.tx, claimId);
}

/** Every hold of the pass, open and closed, by number. */
export function listHolds(db: DbReader, passId: PassId): PassHoldDto[] {
  return db
    .select()
    .from(schema.passHolds)
    .where(eq(schema.passHolds.passId, passId))
    .orderBy(asc(schema.passHolds.seq))
    .all()
    .map(toHoldDto);
}

/** The pass's holds whose turn has not kept them, by number. */
export function openHolds(db: DbReader, passId: PassId): PassHoldDto[] {
  return db
    .select()
    .from(schema.passHolds)
    .where(and(eq(schema.passHolds.passId, passId), isNull(schema.passHolds.closedAt)))
    .orderBy(asc(schema.passHolds.seq))
    .all()
    .map(toHoldDto);
}

function changeRow(db: DbReader, passId: PassId, seq: number): ChangeRow | undefined {
  return db
    .select()
    .from(schema.passSharedChanges)
    .where(and(eq(schema.passSharedChanges.passId, passId), eq(schema.passSharedChanges.seq, seq)))
    .get();
}

/** The paths sorted, and their content by path. */
function pathsAndBlobs(files: readonly SharedPathBlob[]): {
  paths: string[];
  blobs: Record<string, string | null>;
} {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  return {
    paths: sorted.map((f) => f.path),
    blobs: Object.fromEntries(sorted.map((f) => [f.path, f.blob])),
  };
}

function emitShared(ctx: WriteContext, change: PassSharedChangeDto): void {
  ctx.emit({
    type: EventType.PassSharedChanged,
    entityType: 'pass',
    entityId: change.passId,
    data: { passId: change.passId, seq: change.seq, taskId: change.taskId, paths: change.paths },
  });
}

export interface SharedChangeUpsert {
  readonly passId: PassId;
  /** The hold's number: the change keeps it. */
  readonly seq: number;
  /** The chain commit that keeps the change. */
  readonly sha: string;
  readonly files: readonly SharedPathBlob[];
  /** A file already dirty at the grant was kept whole with the agent's edits. */
  readonly dirtyKept: boolean;
}

/**
 * Writes the shared change of an open hold, or replaces its commit, paths and content: the commit tool
 * keeps a hold early and its turn's end keeps it again. Refused once the hold is closed.
 */
export function upsertSharedChange(
  ctx: WriteContext,
  input: SharedChangeUpsert,
): PassSharedChangeDto {
  const hold = ctx.tx
    .select()
    .from(schema.passHolds)
    .where(and(eq(schema.passHolds.passId, input.passId), eq(schema.passHolds.seq, input.seq)))
    .get();
  if (!hold) throw new NotFoundError('shared hold', `${input.passId}#${String(input.seq)}`);
  if (hold.closedAt !== null)
    throw new ConflictError(`Shared hold ${String(input.seq)} is closed; its change is kept`);
  const { paths, blobs } = pathsAndBlobs(input.files);
  const existing = changeRow(ctx.tx, input.passId, input.seq);
  if (existing)
    ctx.tx
      .update(schema.passSharedChanges)
      .set({ sha: input.sha, paths, blobs, dirtyKept: input.dirtyKept, updatedAt: ctx.now })
      .where(
        and(
          eq(schema.passSharedChanges.passId, input.passId),
          eq(schema.passSharedChanges.seq, input.seq),
        ),
      )
      .run();
  else
    ctx.tx
      .insert(schema.passSharedChanges)
      .values({
        passId: input.passId,
        seq: input.seq,
        taskId: hold.taskId,
        sha: input.sha,
        paths,
        blobs,
        dirtyKept: input.dirtyKept,
        landedSha: null,
        droppedBy: null,
        dropOf: null,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .run();
  const change = getSharedChange(ctx.tx, input.passId, input.seq);
  emitShared(ctx, change);
  return change;
}

export function getSharedChange(db: DbReader, passId: PassId, seq: number): PassSharedChangeDto {
  const row = changeRow(db, passId, seq);
  if (!row) throw new NotFoundError('shared change', `${passId}#${String(seq)}`);
  return toChangeDto(row);
}

/** The pass's shared chain, drops included, by number: the order it lands in. */
export function listSharedChanges(db: DbReader, passId: PassId): PassSharedChangeDto[] {
  return db
    .select()
    .from(schema.passSharedChanges)
    .where(eq(schema.passSharedChanges.passId, passId))
    .orderBy(asc(schema.passSharedChanges.seq))
    .all()
    .map(toChangeDto);
}

/**
 * Appends a drop of change `of` (spec §7.2), numbered after every hold and drop of the pass, naming
 * the task whose change it puts back, and marks the change dropped by it. Refused for a change that is
 * a drop itself, already dropped, or landed.
 */
export function insertDrop(
  ctx: WriteContext,
  input: {
    readonly passId: PassId;
    readonly of: number;
    /** The chain commit that puts the paths back. */
    readonly sha: string;
    /** What each path is put back to; null for a file removed. */
    readonly files: readonly SharedPathBlob[];
  },
): PassSharedChangeDto {
  const dropped = getSharedChange(ctx.tx, input.passId, input.of);
  if (dropped.dropOf !== null)
    throw new ConflictError(`Shared change ${String(input.of)} is a drop`);
  if (dropped.droppedBy !== null)
    throw new ConflictError(`Shared change ${String(input.of)} is already dropped`);
  if (dropped.landedSha !== null)
    throw new ConflictError(`Shared change ${String(input.of)} has landed`);
  const seq = (maxGrantedSeq(ctx.tx, input.passId) ?? 0) + 1;
  const { paths, blobs } = pathsAndBlobs(input.files);
  ctx.tx
    .insert(schema.passSharedChanges)
    .values({
      passId: input.passId,
      seq,
      taskId: dropped.taskId,
      sha: input.sha,
      paths,
      blobs,
      dirtyKept: false,
      landedSha: null,
      droppedBy: null,
      dropOf: input.of,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .run();
  ctx.tx
    .update(schema.passSharedChanges)
    .set({ droppedBy: seq, updatedAt: ctx.now })
    .where(
      and(
        eq(schema.passSharedChanges.passId, input.passId),
        eq(schema.passSharedChanges.seq, input.of),
      ),
    )
    .run();
  const drop = getSharedChange(ctx.tx, input.passId, seq);
  emitShared(ctx, drop);
  return drop;
}

/**
 * Records that the pass's branch has landed its chain up to `seq` (spec §7.2: always a prefix): the
 * commit that landed the change, or null for a number passed over (an empty hold, a dropped change, a
 * drop). Running it again for the same number changes nothing; a number below the last is refused.
 */
export function markLanded(
  ctx: WriteContext,
  input: { readonly passId: PassId; readonly seq: number; readonly landedSha: string | null },
): void {
  const pass = getPass(ctx.tx, input.passId);
  const landed = ctx.tx
    .select({ sharedLanded: schema.passes.sharedLanded })
    .from(schema.passes)
    .where(eq(schema.passes.id, input.passId))
    .get()?.sharedLanded;
  if (landed === undefined) throw new NotFoundError('pass', input.passId);
  if (input.seq < landed)
    throw new ConflictError(
      `Pass "${pass.name}" has landed its shared changes up to ${String(landed)}, past ${String(input.seq)}`,
    );
  if (input.landedSha !== null)
    ctx.tx
      .update(schema.passSharedChanges)
      .set({ landedSha: input.landedSha, updatedAt: ctx.now })
      .where(
        and(
          eq(schema.passSharedChanges.passId, input.passId),
          eq(schema.passSharedChanges.seq, input.seq),
          isNull(schema.passSharedChanges.landedSha),
        ),
      )
      .run();
  ctx.tx
    .update(schema.passes)
    .set({ sharedLanded: input.seq, updatedAt: ctx.now })
    .where(eq(schema.passes.id, input.passId))
    .run();
  emitPass(ctx, input.passId, { sharedLanded: input.seq });
}
