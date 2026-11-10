import {
  AbandonStep,
  AreaRole,
  BatchState,
  ConflictError,
  EventType,
  NotFoundError,
  OPEN_PASS_STATES,
  PassState,
  passHeldAreas,
  passHoldsFolder,
  passHoldsTasks,
  TaskStatus,
  type BatchDto,
  type PassDirtEntry,
  type PassDto,
  type PassId,
  type ProjectId,
  type TaskDto,
  type TaskId,
} from '@10db/contracts';
import { and, asc, eq, inArray, lt, ne, notInArray, or } from 'drizzle-orm';
import * as schema from '../schema';
import { findUnfinishedBatch, insertBatch, transitionBatch } from './batches';
import { getProject } from './projects';
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
  const pass = findPass(db, id);
  if (!pass) throw new NotFoundError('pass', id);
  return pass;
}

/** The pass with this id, or undefined when no row has it. */
export function findPass(db: DbReader, id: PassId): PassDto | undefined {
  const row = db.select().from(schema.passes).where(eq(schema.passes.id, id)).get();
  return row ? toPassDto(row) : undefined;
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

/**
 * Every project's passes the Workbench shows, oldest first: each that still holds Your folder, so an
 * open, closing or abandoning one, and a closed one whose work is not yet in the base.
 */
export function listLivePasses(db: DbReader): PassDto[] {
  const done = Object.values(PassState).filter((s) => !passHoldsFolder(s));
  return db
    .select()
    .from(schema.passes)
    .where(notInArray(schema.passes.state, done))
    .orderBy(asc(schema.passes.openedAt), asc(schema.passes.id))
    .all()
    .map(toPassDto);
}

/**
 * The pass that still holds `task` as a pass task (`passHoldsTasks`), or undefined: a task of a
 * closed, settled or abandoned pass is ordinary work again.
 */
export function passHoldingTask(db: DbReader, task: Pick<TaskDto, 'passId'>): PassDto | undefined {
  if (task.passId == null) return undefined;
  const pass = getPass(db, task.passId);
  return passHoldsTasks(pass.state) ? pass : undefined;
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
 * dirt and each task's `pass_id`, in the caller's write. Refused for a task of another project or one
 * a pass still holds, and while the project has a pass open, closing or abandoning, or an unfinished
 * batch in Your folder.
 */
export function insertPass(
  ctx: WriteContext,
  input: PassInsert,
): { readonly pass: PassDto; readonly batch: BatchDto } {
  for (const taskId of input.taskIds) {
    const task = getTask(ctx.tx, taskId);
    if (task.projectId !== input.projectId)
      throw new ConflictError(`Task ${task.title} belongs to another project`);
    const holding = passHoldingTask(ctx.tx, task);
    if (holding) throw new ConflictError(`Task ${task.title} is already in pass "${holding.name}"`);
  }
  const open = findOpenPass(ctx.tx, input.projectId);
  if (open) throw new ConflictError(`Pass "${open.name}" is still ${open.state.toLowerCase()}`);
  const unfinished = findUnfinishedBatch(ctx.tx, input.projectId);
  if (unfinished)
    throw new ConflictError(
      `Batch "${unfinished.title}" in Your folder is still ${unfinished.state.toLowerCase()}`,
    );
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

/** The tasks in the pass now, oldest first: a task that left it is not one. */
export function listPassTasks(db: DbReader, passId: PassId): TaskDto[] {
  return db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.passId, passId), ne(schema.tasks.status, TaskStatus.Cancelled)))
    .orderBy(asc(schema.tasks.createdAt), asc(schema.tasks.id))
    .all()
    .map((row) => getTask(db, row.id));
}

/**
 * Adds open tasks to an open pass (Add Page), in the caller's write: each task's `pass_id`, and one
 * `pass.changed` naming them. Refused for a pass that is not open, a task of another project or one a
 * pass still holds; the caller makes each task's run in the pass's batch.
 */
export function joinPass(ctx: WriteContext, passId: PassId, taskIds: readonly TaskId[]): void {
  const pass = getPass(ctx.tx, passId);
  if (pass.state !== PassState.Open)
    throw new ConflictError(
      `Pass "${pass.name}" is ${pass.state.toLowerCase()}: a page joins only an open pass`,
    );
  for (const taskId of taskIds) {
    const task = getTask(ctx.tx, taskId);
    if (task.projectId !== pass.projectId)
      throw new ConflictError(`Task ${task.title} belongs to another project`);
    const holding = passHoldingTask(ctx.tx, task);
    if (holding) throw new ConflictError(`Task ${task.title} is already in pass "${holding.name}"`);
    ctx.tx
      .update(schema.tasks)
      .set({ passId, updatedAt: ctx.now })
      .where(eq(schema.tasks.id, taskId))
      .run();
    ctx.emit({ type: EventType.TaskChanged, entityType: 'task', entityId: taskId });
  }
  ctx.emit({
    type: EventType.PassChanged,
    entityType: 'pass',
    entityId: passId,
    data: { joined: [...taskIds] },
  });
}

/**
 * Names the pass anew, and its batch, whose title its pull request takes, in the caller's write; the
 * pass's branch keeps the name it was made with. Refused once the pass is settled or abandoned.
 */
export function renamePass(ctx: WriteContext, passId: PassId, name: string): PassDto {
  const pass = getPass(ctx.tx, passId);
  if (!passHoldsFolder(pass.state))
    throw new ConflictError(
      `Pass "${pass.name}" is ${pass.state.toLowerCase()}: it keeps its name`,
    );
  ctx.tx
    .update(schema.passes)
    .set({ name, updatedAt: ctx.now })
    .where(eq(schema.passes.id, passId))
    .run();
  ctx.tx
    .update(schema.batches)
    .set({ title: name, updatedAt: ctx.now })
    .where(eq(schema.batches.id, pass.batchId))
    .run();
  ctx.emit({ type: EventType.PassChanged, entityType: 'pass', entityId: passId, data: { name } });
  return getPass(ctx.tx, passId);
}

/**
 * Ends the task's membership of its pass (a take-out, an Abandon, a close): the pass no longer holds
 * it, so the scheduler, `countLanes` and the guard treat it as ordinary work. A task in no pass is left
 * as it is.
 */
export function leavePass(ctx: WriteContext, taskId: TaskId): void {
  const task = getTask(ctx.tx, taskId);
  if (task.passId == null) return;
  ctx.tx
    .update(schema.tasks)
    .set({ passId: null, updatedAt: ctx.now })
    .where(eq(schema.tasks.id, taskId))
    .run();
  ctx.emit({
    type: EventType.TaskChanged,
    entityType: 'task',
    entityId: taskId,
    data: { leftPassId: task.passId },
  });
}

/**
 * The areas that are pages in the pass (spec §7.1, §7.3): every page area of the project, and each area
 * with no role that a task of the pass holds. A file under one belongs to the task holding it alone.
 */
export function passPageAreas(db: DbReader, passId: PassId): string[] {
  const pass = getPass(db, passId);
  const { areas } = getProject(db, pass.projectId);
  const pages = new Set(areas.filter((a) => a.role === AreaRole.Page).map((a) => a.name));
  for (const task of listPassTasks(db, passId))
    for (const name of passHeldAreas(areas, task)) pages.add(name);
  return [...pages].sort();
}

/** The last step of the pass's Abandon that finished, or null while it is not abandoning. */
export function getAbandonStep(db: DbReader, passId: PassId): AbandonStep | null {
  const row = db
    .select({ step: schema.passes.abandonStep })
    .from(schema.passes)
    .where(eq(schema.passes.id, passId))
    .get();
  if (!row) throw new NotFoundError('pass', passId);
  return row.step;
}

/**
 * Records a finished step of the pass's Abandon (spec §5.4), so a restart goes on from the next. The
 * first step moves an open pass to `ABANDONING`; a step is never recorded below the last one. The last,
 * the folder's index refreshed, follows step 7's `abandonPassAndBatch` and leaves the pass `ABANDONED`.
 */
export function setAbandonStep(ctx: WriteContext, passId: PassId, step: AbandonStep): void {
  const pass = getPass(ctx.tx, passId);
  const last = getAbandonStep(ctx.tx, passId);
  const from: readonly PassState[] =
    step === AbandonStep.Abandoning
      ? [PassState.Open, PassState.Abandoning]
      : step === AbandonStep.IndexRefreshed
        ? [PassState.Abandoned]
        : [PassState.Abandoning];
  const state = step === AbandonStep.IndexRefreshed ? PassState.Abandoned : PassState.Abandoning;
  if (!from.includes(pass.state))
    throw new ConflictError(`Pass "${pass.name}" is ${pass.state.toLowerCase()}`);
  if (last !== null && step < last)
    throw new ConflictError(
      `Pass "${pass.name}" has finished step ${String(last)} of its Abandon, past step ${String(step)}`,
    );
  ctx.tx
    .update(schema.passes)
    .set({ state, abandonStep: step, updatedAt: ctx.now })
    .where(eq(schema.passes.id, passId))
    .run();
  ctx.emit({
    type: EventType.PassChanged,
    entityType: 'pass',
    entityId: passId,
    data: { projectId: pass.projectId, state, abandonStep: step },
  });
}

/**
 * Every pass whose Abandon has not finished, oldest first: `ABANDONING`, or `ABANDONED` before the
 * folder's index was refreshed. Start-up goes on with each.
 */
export function listUnfinishedAbandons(db: DbReader): PassDto[] {
  return db
    .select()
    .from(schema.passes)
    .where(
      or(
        eq(schema.passes.state, PassState.Abandoning),
        and(
          eq(schema.passes.state, PassState.Abandoned),
          lt(schema.passes.abandonStep, AbandonStep.IndexRefreshed),
        ),
      ),
    )
    .orderBy(asc(schema.passes.openedAt))
    .all()
    .map((row) => getPass(db, row.id));
}

/**
 * Step 7 of an Abandon: the pass and its batch both become `ABANDONED` in the caller's write, or neither
 * does. The batch moves from `OPEN` or `FAILED`, the edges that exist.
 */
export function abandonPassAndBatch(ctx: WriteContext, passId: PassId): void {
  const pass = getPass(ctx.tx, passId);
  if (pass.state !== PassState.Abandoning)
    throw new ConflictError(`Pass "${pass.name}" is ${pass.state.toLowerCase()}, not abandoning`);
  ctx.tx
    .update(schema.passes)
    .set({ state: PassState.Abandoned, abandonStep: AbandonStep.Abandoned, updatedAt: ctx.now })
    .where(eq(schema.passes.id, passId))
    .run();
  transitionBatch(ctx, pass.batchId, { to: BatchState.Abandoned, reason: 'pass abandoned' });
  ctx.emit({
    type: EventType.PassChanged,
    entityType: 'pass',
    entityId: passId,
    data: { projectId: pass.projectId, state: PassState.Abandoned },
  });
}
