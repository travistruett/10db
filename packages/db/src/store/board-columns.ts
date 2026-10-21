import {
  BoardColumnDelete,
  BoardColumnInput,
  BoardColumnPatch,
  ConflictError,
  EventType,
  InvalidError,
  mintId,
  NotFoundError,
  type BoardColumnDto,
  type BoardColumnId,
  type ProjectId,
} from '@10db/contracts';
import { and, asc, eq, ne } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

export function listBoardColumns(db: DbReader, projectId: ProjectId): BoardColumnDto[] {
  return db
    .select()
    .from(schema.boardColumns)
    .where(eq(schema.boardColumns.projectId, projectId))
    .orderBy(asc(schema.boardColumns.position), asc(schema.boardColumns.id))
    .all();
}

export function getBoardColumn(db: DbReader, id: BoardColumnId): BoardColumnDto {
  const row = db.select().from(schema.boardColumns).where(eq(schema.boardColumns.id, id)).get();
  if (!row) throw new NotFoundError('board column', id);
  return row;
}

function refuseDuplicate(
  db: DbReader,
  projectId: ProjectId,
  name: string,
  except: BoardColumnId | null,
): void {
  const clash = db
    .select({ id: schema.boardColumns.id })
    .from(schema.boardColumns)
    .where(
      and(
        eq(schema.boardColumns.projectId, projectId),
        eq(schema.boardColumns.name, name),
        ...(except ? [ne(schema.boardColumns.id, except)] : []),
      ),
    )
    .get();
  if (clash) throw new ConflictError(`This project already has a column named "${name}"`);
}

/** Writes positions 0…n-1 in the given order; each changed column announces it. */
function writePositions(ctx: WriteContext, ordered: readonly BoardColumnDto[]): void {
  ordered.forEach((column, position) => {
    if (column.position === position) return;
    ctx.tx
      .update(schema.boardColumns)
      .set({ position, updatedAt: ctx.now })
      .where(eq(schema.boardColumns.id, column.id))
      .run();
    ctx.emit({
      type: EventType.BoardColumnSaved,
      entityType: 'board_column',
      entityId: column.id,
      data: { position },
    });
  });
}

export function insertBoardColumn(
  ctx: WriteContext,
  projectId: ProjectId,
  input: BoardColumnInput,
): BoardColumnDto {
  const { name } = BoardColumnInput.parse(input);
  refuseDuplicate(ctx.tx, projectId, name, null);
  const row: BoardColumnDto = {
    id: mintId('BoardColumn'),
    projectId,
    name,
    position: listBoardColumns(ctx.tx, projectId).length,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.boardColumns).values(row).run();
  ctx.emit({
    type: EventType.BoardColumnSaved,
    entityType: 'board_column',
    entityId: row.id,
    data: { projectId },
  });
  return row;
}

export function patchBoardColumn(
  ctx: WriteContext,
  id: BoardColumnId,
  patch: BoardColumnPatch,
): BoardColumnDto[] {
  const changes = BoardColumnPatch.parse(patch);
  const column = getBoardColumn(ctx.tx, id);
  if (changes.name !== undefined && changes.name !== column.name) {
    refuseDuplicate(ctx.tx, column.projectId, changes.name, id);
    ctx.tx
      .update(schema.boardColumns)
      .set({ name: changes.name, updatedAt: ctx.now })
      .where(eq(schema.boardColumns.id, id))
      .run();
    ctx.emit({
      type: EventType.BoardColumnSaved,
      entityType: 'board_column',
      entityId: id,
      data: { name: changes.name },
    });
  }
  if (changes.position !== undefined) {
    const rest = listBoardColumns(ctx.tx, column.projectId).filter((c) => c.id !== id);
    const at = Math.min(changes.position, rest.length);
    writePositions(ctx, [...rest.slice(0, at), column, ...rest.slice(at)]);
  }
  return listBoardColumns(ctx.tx, column.projectId);
}

/** Moves the column's tasks to another human column or to planned, then deletes it. */
export function deleteBoardColumn(
  ctx: WriteContext,
  id: BoardColumnId,
  del: BoardColumnDelete,
): BoardColumnDto[] {
  const { moveTasksTo } = BoardColumnDelete.parse(del);
  const column = getBoardColumn(ctx.tx, id);
  if (moveTasksTo !== null) {
    if (moveTasksTo === id)
      throw new InvalidError("A column's tasks can't move to the column being deleted");
    if (getBoardColumn(ctx.tx, moveTasksTo).projectId !== column.projectId)
      throw new InvalidError('The tasks must move to a column in the same project');
  }
  const parked = ctx.tx
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(eq(schema.tasks.boardColumnId, id))
    .all();
  for (const task of parked) {
    ctx.tx
      .update(schema.tasks)
      .set({ boardColumnId: moveTasksTo, updatedAt: ctx.now })
      .where(eq(schema.tasks.id, task.id))
      .run();
    ctx.emit({
      type: EventType.TaskChanged,
      entityType: 'task',
      entityId: task.id,
      data: { boardColumnId: moveTasksTo },
    });
  }
  ctx.tx.delete(schema.boardColumns).where(eq(schema.boardColumns.id, id)).run();
  ctx.emit({
    type: EventType.BoardColumnDeleted,
    entityType: 'board_column',
    entityId: id,
    data: { projectId: column.projectId },
  });
  writePositions(ctx, listBoardColumns(ctx.tx, column.projectId));
  return listBoardColumns(ctx.tx, column.projectId);
}
