import {
  ConflictError,
  NotFoundError,
  TakeOutStep,
  type PassId,
  type TaskId,
} from '@10db/contracts';
import { and, asc, desc, eq, lt } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

// Workbench spec §5.4, §12: a take-out of a task from a pass records each step it finishes, so a
// restart goes on from the next one.

/** A take-out as its row holds it; `step` is the last step that finished. */
export type PassTakeOutRow = typeof schema.passTakeOuts.$inferSelect;

/** Which take-out: one per task and pass. */
export interface TakeOutKey {
  readonly taskId: TaskId;
  readonly passId: PassId;
}

const keyed = (key: TakeOutKey) =>
  and(eq(schema.passTakeOuts.taskId, key.taskId), eq(schema.passTakeOuts.passId, key.passId));

/** The task's take-out from the pass, finished or not, or undefined when it has none. */
export function findTakeOut(db: DbReader, key: TakeOutKey): PassTakeOutRow | undefined {
  return db.select().from(schema.passTakeOuts).where(keyed(key)).get();
}

function getTakeOut(db: DbReader, key: TakeOutKey): PassTakeOutRow {
  const row = findTakeOut(db, key);
  if (!row) throw new NotFoundError('take-out of task', key.taskId);
  return row;
}

/**
 * Writes a take-out before its first step, with the shared changes chosen Drop. A task Add Page put
 * back into the same pass is taken out again on a fresh row: the finished one told of a take-out
 * whose saved work the put-back has already used. Refused while the task's take-out is unfinished,
 * which goes on from its own row.
 */
export function insertTakeOut(
  ctx: WriteContext,
  input: TakeOutKey & { readonly drops: readonly number[] },
): PassTakeOutRow {
  const earlier = findTakeOut(ctx.tx, input);
  if (earlier && earlier.step < TakeOutStep.Done)
    throw new ConflictError(`A take-out of task ${input.taskId} is already under way`);
  if (earlier) ctx.tx.delete(schema.passTakeOuts).where(keyed(input)).run();
  const row: PassTakeOutRow = {
    taskId: input.taskId,
    passId: input.passId,
    step: TakeOutStep.Written,
    tries: 0,
    keptSha: null,
    keptBaseSha: null,
    left: [],
    drops: [...input.drops],
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.passTakeOuts).values(row).run();
  return row;
}

/**
 * Records a finished step, with what it found: the tries so far, the kept commit, the files the put-back
 * left. A step is never recorded below the last one; the same step again (another try) is allowed.
 */
export function advanceTakeOut(
  ctx: WriteContext,
  key: TakeOutKey,
  patch: {
    readonly step: TakeOutStep;
    readonly tries?: number;
    readonly keptSha?: string | null;
    readonly keptBaseSha?: string | null;
    readonly left?: readonly string[];
  },
): PassTakeOutRow {
  const row = getTakeOut(ctx.tx, key);
  if (patch.step < row.step)
    throw new ConflictError(
      `The take-out has finished step ${String(row.step)}, past step ${String(patch.step)}`,
    );
  const { left, ...rest } = patch;
  ctx.tx
    .update(schema.passTakeOuts)
    .set({ ...rest, ...(left === undefined ? {} : { left: [...left] }), updatedAt: ctx.now })
    .where(keyed(key))
    .run();
  return getTakeOut(ctx.tx, key);
}

/**
 * Removes a take-out's row: a take-out asked for alone that stopped leaves none of its own, and the
 * finished one it replaced, `earlier`, is written back, so a later put-back still reads how that
 * take-out left each file.
 */
export function deleteTakeOut(
  ctx: WriteContext,
  key: TakeOutKey,
  earlier: PassTakeOutRow | null = null,
): void {
  ctx.tx.delete(schema.passTakeOuts).where(keyed(key)).run();
  if (earlier !== null) ctx.tx.insert(schema.passTakeOuts).values(earlier).run();
}

/** Every take-out that has not finished its last step, oldest first: start-up goes on with each. */
export function listUnfinishedTakeOuts(db: DbReader): PassTakeOutRow[] {
  return db
    .select()
    .from(schema.passTakeOuts)
    .where(lt(schema.passTakeOuts.step, TakeOutStep.Done))
    .orderBy(asc(schema.passTakeOuts.createdAt))
    .all();
}

/** Every take-out of the pass, oldest first: what an Abandon put back and left. */
export function listPassTakeOuts(db: DbReader, passId: PassId): PassTakeOutRow[] {
  return db
    .select()
    .from(schema.passTakeOuts)
    .where(eq(schema.passTakeOuts.passId, passId))
    .orderBy(asc(schema.passTakeOuts.createdAt))
    .all();
}

/** The task's latest take-out, from any pass, or undefined when it has none. */
export function lastTakeOut(db: DbReader, taskId: TaskId): PassTakeOutRow | undefined {
  return db
    .select()
    .from(schema.passTakeOuts)
    .where(eq(schema.passTakeOuts.taskId, taskId))
    .orderBy(desc(schema.passTakeOuts.createdAt), desc(schema.passTakeOuts.updatedAt))
    .limit(1)
    .get();
}
