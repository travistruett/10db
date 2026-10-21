import {
  BoardStatus,
  ConflictError,
  EventType,
  InvalidError,
  isTerminal,
  mintId,
  NotFoundError,
  TaskInput,
  TaskMove,
  TaskPatch,
  TaskStatus,
  WorkstreamState,
  type ProjectId,
  type TaskDto,
  type TaskId,
} from '@10db/contracts';
import { and, asc, desc, eq, inArray, max, ne } from 'drizzle-orm';
import * as schema from '../schema';
import { getBoardColumn } from './board-columns';
import { getFlow } from './flows';
import { getProject } from './projects';
import type { DbReader, WriteContext } from './store';

export interface BoardStatusInput {
  readonly taskStatus: TaskStatus;
  readonly depsDone: boolean;
  readonly workstreamState: WorkstreamState | null;
}

/** Board column for a task (spec §5.1): Ready means deps done and nothing blocking. */
export function deriveBoardStatus({
  taskStatus,
  depsDone,
  workstreamState,
}: BoardStatusInput): BoardStatus {
  switch (taskStatus) {
    case TaskStatus.Done:
    case TaskStatus.Cancelled:
      return BoardStatus.Done;
    case TaskStatus.Open:
      break;
  }
  if (
    workstreamState === WorkstreamState.WaitingHuman ||
    workstreamState === WorkstreamState.PausedLimit ||
    workstreamState === WorkstreamState.Failed
  ) {
    return BoardStatus.Blocked;
  }
  if (workstreamState !== null && !isTerminal(workstreamState)) return BoardStatus.InProgress;
  return depsDone ? BoardStatus.Ready : BoardStatus.Backlog;
}

export function insertTask(ctx: WriteContext, projectId: ProjectId, input: TaskInput): TaskDto {
  const project = getProject(ctx.tx, projectId);
  const config = TaskInput.parse(input);
  if (config.flowId) getFlow(ctx.tx, config.flowId);
  const known = new Set([
    ...project.areas.map((a) => a.name),
    ...project.hazards.map((h) => h.name),
  ]);
  const unknown = config.areas.filter((a) => !known.has(a));
  if (unknown.length > 0)
    throw new InvalidError(`Unknown areas for project ${project.name}: ${unknown.join(', ')}`);
  if (config.dependsOn.length > 0) {
    const deps = ctx.tx
      .select({ id: schema.tasks.id, projectId: schema.tasks.projectId })
      .from(schema.tasks)
      .where(inArray(schema.tasks.id, config.dependsOn))
      .all();
    if (deps.length !== config.dependsOn.length || deps.some((d) => d.projectId !== projectId)) {
      throw new InvalidError('Every dependency must be an existing task in the same project');
    }
  }
  const order = ctx.tx
    .select({ value: max(schema.tasks.boardOrder) })
    .from(schema.tasks)
    .where(eq(schema.tasks.projectId, projectId))
    .get();
  const row = {
    id: mintId('Task'),
    projectId,
    title: config.title,
    description: config.description,
    acceptanceCriteria: config.acceptanceCriteria,
    areas: config.areas,
    riskTags: config.riskTags,
    flowId: config.flowId,
    status: TaskStatus.Open,
    boardOrder: (order?.value ?? 0) + 1,
    workspaceMode: 'shared' as const,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.tasks).values(row).run();
  for (const dependsOnId of config.dependsOn)
    ctx.tx.insert(schema.taskDeps).values({ taskId: row.id, dependsOnId }).run();
  ctx.emit({
    type: EventType.TaskCreated,
    entityType: 'task',
    entityId: row.id,
    data: { projectId },
  });
  return getTask(ctx.tx, row.id);
}

export function setTaskStatus(ctx: WriteContext, id: TaskId, status: TaskStatus): void {
  const result = ctx.tx
    .update(schema.tasks)
    .set({ status, updatedAt: ctx.now })
    .where(eq(schema.tasks.id, id))
    .run();
  if (result.changes === 0) throw new NotFoundError('task', id);
  ctx.emit({ type: EventType.TaskChanged, entityType: 'task', entityId: id, data: { status } });
}

export function dependenciesDone(db: DbReader, taskId: TaskId): boolean {
  const pending = db
    .select({ id: schema.tasks.id })
    .from(schema.taskDeps)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskDeps.dependsOnId))
    .where(and(eq(schema.taskDeps.taskId, taskId), ne(schema.tasks.status, TaskStatus.Done)))
    .all();
  return pending.length === 0;
}

function toTaskDto(db: DbReader, row: typeof schema.tasks.$inferSelect): TaskDto {
  const deps = db
    .select({ id: schema.taskDeps.dependsOnId })
    .from(schema.taskDeps)
    .where(eq(schema.taskDeps.taskId, row.id))
    .all();
  const latest = db
    .select({ id: schema.workstreams.id, state: schema.workstreams.state })
    .from(schema.workstreams)
    .where(eq(schema.workstreams.taskId, row.id))
    .orderBy(desc(schema.workstreams.createdAt), desc(schema.workstreams.id))
    .limit(1)
    .get();
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    acceptanceCriteria: row.acceptanceCriteria,
    areas: row.areas,
    riskTags: row.riskTags,
    flowId: row.flowId,
    status: row.status,
    boardOrder: row.boardOrder,
    boardColumnId: row.boardColumnId,
    dependsOn: deps.map((d) => d.id),
    boardStatus: deriveBoardStatus({
      taskStatus: row.status,
      depsDone: dependenciesDone(db, row.id),
      workstreamState: latest?.state ?? null,
    }),
    workstreamId: latest?.id ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function getTask(db: DbReader, id: TaskId): TaskDto {
  const row = db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
  if (!row) throw new NotFoundError('task', id);
  return toTaskDto(db, row);
}

export function listTasks(db: DbReader, projectId: ProjectId): TaskDto[] {
  return db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.projectId, projectId))
    .orderBy(schema.tasks.boardOrder)
    .all()
    .map((row) => toTaskDto(db, row));
}

export function patchTask(ctx: WriteContext, id: TaskId, patch: TaskPatch): TaskDto {
  const changes = TaskPatch.parse(patch);
  getTask(ctx.tx, id);
  if (changes.flowId) getFlow(ctx.tx, changes.flowId);
  ctx.tx
    .update(schema.tasks)
    .set({ ...changes, updatedAt: ctx.now })
    .where(eq(schema.tasks.id, id))
    .run();
  ctx.emit({ type: EventType.TaskChanged, entityType: 'task', entityId: id });
  return getTask(ctx.tx, id);
}

/** Below this gap between neighbours a midpoint loses precision, so the project is renumbered first. */
const MIN_ORDER_GAP = 1e-6;

/** Only planned and parked work moves; the rest follows its workstream. */
const MOVABLE: readonly BoardStatus[] = [BoardStatus.Backlog, BoardStatus.Ready];

/** Rewrites the project's orders as 1…n in their current order; each changed task announces it. */
function renumberBoard(ctx: WriteContext, projectId: ProjectId): void {
  const rows = ctx.tx
    .select({ id: schema.tasks.id, boardOrder: schema.tasks.boardOrder })
    .from(schema.tasks)
    .where(eq(schema.tasks.projectId, projectId))
    .orderBy(asc(schema.tasks.boardOrder), asc(schema.tasks.id))
    .all();
  rows.forEach((row, index) => {
    const boardOrder = index + 1;
    if (row.boardOrder === boardOrder) return;
    ctx.tx
      .update(schema.tasks)
      .set({ boardOrder, updatedAt: ctx.now })
      .where(eq(schema.tasks.id, row.id))
      .run();
    ctx.emit({
      type: EventType.TaskChanged,
      entityType: 'task',
      entityId: row.id,
      data: { boardOrder },
    });
  });
}

/** Places a task in a column, between its new neighbours there (spec §10: drag and drop sets priority). */
export function moveTask(ctx: WriteContext, id: TaskId, move: TaskMove): TaskDto {
  const { to, after, before } = TaskMove.parse(move);
  const task = getTask(ctx.tx, id);
  if (!MOVABLE.includes(task.boardStatus))
    throw new ConflictError(
      `${task.title} follows its workstream; only planned and parked tasks move`,
    );
  if (to !== null && getBoardColumn(ctx.tx, to).projectId !== task.projectId)
    throw new InvalidError('The column must belong to the same project');
  const orderOf = (neighbour: TaskId | null): number | null => {
    if (neighbour === null) return null;
    if (neighbour === id) throw new InvalidError('A task cannot be its own neighbour');
    const other = getTask(ctx.tx, neighbour);
    if (other.projectId !== task.projectId)
      throw new InvalidError('Both neighbours must be tasks in the same project');
    if (other.boardColumnId !== to)
      throw new InvalidError('A neighbour must be in the column the task moves to');
    return other.boardOrder;
  };
  const first = { lo: orderOf(after), hi: orderOf(before) };
  if (first.lo !== null && first.hi !== null) {
    if (first.lo >= first.hi)
      throw new ConflictError('The board changed while you were dragging; try again');
    if (first.hi - first.lo < MIN_ORDER_GAP) renumberBoard(ctx, task.projectId);
  }
  const lo = orderOf(after);
  const hi = orderOf(before);
  const boardOrder =
    lo !== null && hi !== null
      ? (lo + hi) / 2
      : lo !== null
        ? lo + 1
        : hi !== null
          ? hi - 1
          : task.boardOrder;
  ctx.tx
    .update(schema.tasks)
    .set({ boardOrder, boardColumnId: to, updatedAt: ctx.now })
    .where(eq(schema.tasks.id, id))
    .run();
  ctx.emit({
    type: EventType.TaskChanged,
    entityType: 'task',
    entityId: id,
    data: { boardOrder, boardColumnId: to },
  });
  return getTask(ctx.tx, id);
}
