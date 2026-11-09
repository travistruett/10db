import {
  ConflictError,
  EventType,
  NotFoundError,
  OPEN_PASS_STATES,
  PassState,
  passHoldsFolder,
  type BatchDto,
  type PassDirtEntry,
  type PassDto,
  type PassId,
  type ProjectId,
  type TaskId,
} from '@10db/contracts';
import { and, asc, eq, inArray, notInArray } from 'drizzle-orm';
import * as schema from '../schema';
import { findUnfinishedBatch, insertBatch } from './batches';
import type { DbReader, WriteContext } from './store';
import { getTask } from './tasks';

type PassRow = typeof schema.passes.$inferSelect;

function toPassDto(row: PassRow): PassDto {
  // The batch is written in the pass's own insert, so a committed row always names one.
  if (row.batchId === null) throw new NotFoundError('batch of pass', row.id);
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    state: row.state,
    batchId: row.batchId,
    pageCap: row.pageCap,
    returnBranch: row.returnBranch,
    startSha: row.startSha,
    openedAt: row.openedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function getPass(db: DbReader, id: PassId): PassDto {
  const row = db.select().from(schema.passes).where(eq(schema.passes.id, id)).get();
  if (!row) throw new NotFoundError('pass', id);
  return toPassDto(row);
}

/** The project's pass that is open, closing or abandoning: at most one. */
export function findOpenPass(db: DbReader, projectId: ProjectId): PassDto | undefined {
  const row = db
    .select()
    .from(schema.passes)
    .where(
      and(
        eq(schema.passes.projectId, projectId),
        inArray(schema.passes.state, [...OPEN_PASS_STATES]),
      ),
    )
    .get();
  return row ? toPassDto(row) : undefined;
}

/**
 * The project's oldest pass that still holds Your folder (`passHoldsFolder`): while there is one, an
 * ordinary task that would run in the folder runs in a separate copy or waits (W9).
 */
export function passHoldingFolder(db: DbReader, projectId: ProjectId): PassDto | undefined {
  const done = Object.values(PassState).filter((s) => !passHoldsFolder(s));
  const row = db
    .select()
    .from(schema.passes)
    .where(and(eq(schema.passes.projectId, projectId), notInArray(schema.passes.state, done)))
    .orderBy(asc(schema.passes.createdAt))
    .get();
  return row ? toPassDto(row) : undefined;
}

/** The folder's dirt recorded when the pass opened, by path. */
export function listPassDirt(db: DbReader, passId: PassId): PassDirtEntry[] {
  return db
    .select({ path: schema.passDirt.path, blob: schema.passDirt.blob })
    .from(schema.passDirt)
    .where(eq(schema.passDirt.passId, passId))
    .orderBy(asc(schema.passDirt.path))
    .all();
}

export interface PassInsert {
  readonly id: PassId;
  readonly projectId: ProjectId;
  readonly name: string;
  readonly pageCap: number;
  /** The branch HEAD named and the commit it was at when the pass opened. */
  readonly returnBranch: string;
  readonly startSha: string;
  /** The pass's branch, made at `startSha`; its batch's branch. */
  readonly branch: string;
  /** The branch the pass's pull request targets: the project's base. */
  readonly baseBranch: string;
  /** The GitHub `owner/name` read from origin, or null when there is none. */
  readonly repo: string | null;
  readonly taskIds: readonly TaskId[];
  readonly dirt: readonly PassDirtEntry[];
}

/**
 * Writes an OPEN pass, its OPEN batch on the pass's branch with `base_sha` at the start, the folder's
 * dirt and each task's `pass_id`, in the caller's write. Refused while the project has a pass open,
 * closing or abandoning, or an unfinished batch in Your folder, and for a task of another project or
 * already in a pass.
 */
export function insertPass(
  ctx: WriteContext,
  input: PassInsert,
): { readonly pass: PassDto; readonly batch: BatchDto } {
  const open = findOpenPass(ctx.tx, input.projectId);
  if (open) throw new ConflictError(`Pass "${open.name}" is still ${open.state.toLowerCase()}`);
  const unfinished = findUnfinishedBatch(ctx.tx, input.projectId);
  if (unfinished)
    throw new ConflictError(
      `Batch "${unfinished.title}" in Your folder is still ${unfinished.state.toLowerCase()}`,
    );
  for (const taskId of input.taskIds) {
    const task = getTask(ctx.tx, taskId);
    if (task.projectId !== input.projectId)
      throw new ConflictError(`Task ${task.title} belongs to another project`);
    if (task.passId != null) throw new ConflictError(`Task ${task.title} is already in a pass`);
  }
  ctx.tx
    .insert(schema.passes)
    .values({
      id: input.id,
      projectId: input.projectId,
      name: input.name,
      state: PassState.Open,
      batchId: null,
      pageCap: input.pageCap,
      returnBranch: input.returnBranch,
      startSha: input.startSha,
      openedAt: ctx.now,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .run();
  const batch = insertBatch(ctx, {
    projectId: input.projectId,
    title: input.name,
    baseBranch: input.baseBranch,
    pass: { id: input.id, branch: input.branch, baseSha: input.startSha, repo: input.repo },
  });
  ctx.tx
    .update(schema.passes)
    .set({ batchId: batch.id })
    .where(eq(schema.passes.id, input.id))
    .run();
  for (const entry of input.dirt)
    ctx.tx
      .insert(schema.passDirt)
      .values({ passId: input.id, path: entry.path, blob: entry.blob, createdAt: ctx.now })
      .run();
  for (const taskId of input.taskIds) {
    ctx.tx
      .update(schema.tasks)
      .set({ passId: input.id, updatedAt: ctx.now })
      .where(eq(schema.tasks.id, taskId))
      .run();
    ctx.emit({ type: EventType.TaskChanged, entityType: 'task', entityId: taskId });
  }
  ctx.emit({
    type: EventType.PassOpened,
    entityType: 'pass',
    entityId: input.id,
    data: { projectId: input.projectId, batchId: batch.id },
  });
  return { pass: getPass(ctx.tx, input.id), batch };
}
