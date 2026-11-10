import {
  ConflictError,
  EventType,
  type ClaimId,
  type PassId,
  type PassSignOffWaitDto,
  type TaskId,
} from '@10db/contracts';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../schema';
import { getHold } from './pass-shared';
import type { DbReader, WriteContext } from './store';

// Workbench spec §9.2 step 0, §12: a sign-off that waits for another page's hold to close is a row,
// so a restart finds it and lands at once if the hold has closed, or waits again.

function emitWait(ctx: WriteContext, passId: PassId, taskId: TaskId, waiting: boolean): void {
  ctx.emit({
    type: EventType.PassChanged,
    entityType: 'pass',
    entityId: passId,
    data: { signOffWait: taskId, waiting },
  });
}

/** Writes the task's sign-off as waiting for an open hold. Refused for a hold already closed. */
export function insertSignOffWait(
  ctx: WriteContext,
  input: { readonly taskId: TaskId; readonly passId: PassId; readonly waitsFor: ClaimId },
): PassSignOffWaitDto {
  const hold = getHold(ctx.tx, input.waitsFor);
  if (hold.closedAt !== null)
    throw new ConflictError(`Shared hold ${String(hold.seq)} is closed; nothing to wait for`);
  ctx.tx
    .insert(schema.passSignOffs)
    .values({
      taskId: input.taskId,
      passId: input.passId,
      waitsFor: input.waitsFor,
      askedAt: ctx.now,
    })
    .run();
  emitWait(ctx, input.passId, input.taskId, true);
  return { ...input, waitsForTaskId: hold.taskId, askedAt: ctx.now };
}

/** Deletes the task's waiting sign-off; answers whether there was one. */
export function deleteSignOffWait(ctx: WriteContext, taskId: TaskId): boolean {
  const row = ctx.tx
    .select({ passId: schema.passSignOffs.passId })
    .from(schema.passSignOffs)
    .where(eq(schema.passSignOffs.taskId, taskId))
    .get();
  if (!row) return false;
  ctx.tx.delete(schema.passSignOffs).where(eq(schema.passSignOffs.taskId, taskId)).run();
  emitWait(ctx, row.passId, taskId, false);
  return true;
}

/** The pass's waiting sign-offs, or every pass's when none is named, oldest first. */
export function listSignOffWaits(db: DbReader, passId?: PassId): PassSignOffWaitDto[] {
  return db
    .select({
      taskId: schema.passSignOffs.taskId,
      passId: schema.passSignOffs.passId,
      waitsFor: schema.passSignOffs.waitsFor,
      waitsForTaskId: schema.passHolds.taskId,
      askedAt: schema.passSignOffs.askedAt,
    })
    .from(schema.passSignOffs)
    .innerJoin(schema.passHolds, eq(schema.passHolds.claimId, schema.passSignOffs.waitsFor))
    .where(passId === undefined ? undefined : eq(schema.passSignOffs.passId, passId))
    .orderBy(asc(schema.passSignOffs.askedAt), asc(schema.passSignOffs.taskId))
    .all();
}
