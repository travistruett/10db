import {
  EventType,
  mintId,
  NotFoundError,
  TaskMessageAuthor,
  TaskMessageKind,
  type TaskFileDto,
  type TaskFileId,
  type TaskId,
  type TaskMessageDto,
  type TaskMessageId,
  type TaskPictureKind,
} from '@10db/contracts';
import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';
import { getTask } from './tasks';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §4.3, §6.3, §11. A task's
// thread as rows. The daemon keeps a picture's bytes on disk before it calls these; they keep the rows.

export type TaskFileRow = typeof schema.taskFiles.$inferSelect;
type MessageRow = typeof schema.taskMessages.$inferSelect;

/** A message of a thread as the daemon reads it: with its pictures and where each is kept. */
export type TaskMessageRow = MessageRow & { readonly files: readonly TaskFileRow[] };

/** A pasted picture already written to disk, by its hash, at `storedPath`. */
export interface StoredPicture {
  readonly name: string;
  readonly mediaType: TaskPictureKind;
  readonly size: number;
  readonly sha256: string;
  readonly storedPath: string;
}

const toFileDto = (row: TaskFileRow): TaskFileDto => ({
  id: row.id,
  taskId: row.taskId,
  messageId: row.messageId,
  name: row.name,
  mediaType: row.mediaType,
  size: row.size,
  sha256: row.sha256,
  inlineSent: row.inlineSent,
  createdAt: row.createdAt,
});

const toMessageDto = (row: MessageRow, files: readonly TaskFileRow[]): TaskMessageDto => ({
  id: row.id,
  taskId: row.taskId,
  author: row.author,
  kind: row.kind,
  body: row.body,
  createdAt: row.createdAt,
  pushedAt: row.pushedAt,
  deliveredAt: row.deliveredAt,
  files: files.map(toFileDto),
});

/** Appends the builder's message and its pictures to a task's thread, in the caller's write. */
export function insertBuilderMessage(
  ctx: WriteContext,
  taskId: TaskId,
  input: { readonly body: string; readonly files: readonly StoredPicture[] },
): TaskMessageDto {
  const task = getTask(ctx.tx, taskId);
  const message: MessageRow = {
    id: mintId('TaskMessage'),
    taskId,
    author: TaskMessageAuthor.Builder,
    kind: TaskMessageKind.Message,
    body: input.body,
    createdAt: ctx.now,
    pushedAt: null,
    deliveredAt: null,
  };
  ctx.tx.insert(schema.taskMessages).values(message).run();
  const files = input.files.map((file): TaskFileRow => ({
    id: mintId('TaskFile'),
    taskId,
    messageId: message.id,
    ...file,
    inlineSent: false,
    createdAt: ctx.now,
  }));
  if (files.length > 0) ctx.tx.insert(schema.taskFiles).values(files).run();
  ctx.emit({
    type: EventType.TaskMessageAdded,
    entityType: 'task',
    entityId: taskId,
    data: { projectId: task.projectId, messageId: message.id },
  });
  return toMessageDto(message, files);
}

/** A task's thread, oldest first, each message with its pictures and where they are kept. */
export function listTaskThreadRows(db: DbReader, taskId: TaskId): TaskMessageRow[] {
  const files = listTaskFileRows(db, taskId);
  return db
    .select()
    .from(schema.taskMessages)
    .where(eq(schema.taskMessages.taskId, taskId))
    .orderBy(asc(schema.taskMessages.id))
    .all()
    .map((row) => ({ ...row, files: files.filter((f) => f.messageId === row.id) }));
}

/** A task's thread, oldest first, each message with its pictures. */
export function listTaskThread(db: DbReader, taskId: TaskId): TaskMessageDto[] {
  return listTaskThreadRows(db, taskId).map((row) => toMessageDto(row, row.files));
}

/** Every picture pasted into a task's thread, oldest first. */
export function listTaskFileRows(db: DbReader, taskId: TaskId): TaskFileRow[] {
  return db
    .select()
    .from(schema.taskFiles)
    .where(eq(schema.taskFiles.taskId, taskId))
    .orderBy(asc(schema.taskFiles.id))
    .all();
}

/** One message with its pictures and where they are kept. */
export function getTaskMessageRow(db: DbReader, id: TaskMessageId): TaskMessageRow {
  const row = db.select().from(schema.taskMessages).where(eq(schema.taskMessages.id, id)).get();
  if (!row) throw new NotFoundError('task message', id);
  const files = db
    .select()
    .from(schema.taskFiles)
    .where(eq(schema.taskFiles.messageId, id))
    .orderBy(asc(schema.taskFiles.id))
    .all();
  return { ...row, files };
}

/**
 * Notes that these messages were handed to a session now. That proves nothing reached a turn: a crash
 * loses what was pushed, so a message stays undelivered until a turn is seen to take it.
 */
export function markTaskMessagesPushed(ctx: WriteContext, ids: readonly TaskMessageId[]): void {
  if (ids.length === 0) return;
  ctx.tx
    .update(schema.taskMessages)
    .set({ pushedAt: ctx.now })
    .where(inArray(schema.taskMessages.id, [...ids]))
    .run();
}

/**
 * Marks delivered the messages of this task among `ids` that a turn was seen to take, once each, and
 * answers those it marked now. An id of another task, or one already delivered, is left as it is.
 */
export function markTaskMessagesDelivered(
  ctx: WriteContext,
  taskId: TaskId,
  ids: readonly TaskMessageId[],
): TaskMessageId[] {
  if (ids.length === 0) return [];
  const where = and(
    eq(schema.taskMessages.taskId, taskId),
    inArray(schema.taskMessages.id, [...ids]),
    isNull(schema.taskMessages.deliveredAt),
  );
  const marked = ctx.tx
    .select({ id: schema.taskMessages.id })
    .from(schema.taskMessages)
    .where(where)
    .orderBy(asc(schema.taskMessages.id))
    .all()
    .map((row) => row.id);
  if (marked.length > 0)
    ctx.tx.update(schema.taskMessages).set({ deliveredAt: ctx.now }).where(where).run();
  return marked;
}

/** A task's messages handed to a session that no turn has taken yet, oldest first: each is sent again. */
export function listUndeliveredTaskMessages(db: DbReader, taskId: TaskId): TaskMessageRow[] {
  const rows = db
    .select()
    .from(schema.taskMessages)
    .where(
      and(
        eq(schema.taskMessages.taskId, taskId),
        isNotNull(schema.taskMessages.pushedAt),
        isNull(schema.taskMessages.deliveredAt),
      ),
    )
    .orderBy(asc(schema.taskMessages.id))
    .all();
  if (rows.length === 0) return [];
  const files = listTaskFileRows(db, taskId);
  return rows.map((row) => ({ ...row, files: files.filter((f) => f.messageId === row.id) }));
}

/**
 * Marks the pictures a session was sent as image blocks. A `fresh` session holds no earlier block, so
 * its start clears the task's other marks first: the marks say what the live session's history holds.
 */
export function markTaskFilesInline(
  ctx: WriteContext,
  taskId: TaskId,
  ids: readonly TaskFileId[],
  fresh: boolean,
): void {
  if (fresh)
    ctx.tx
      .update(schema.taskFiles)
      .set({ inlineSent: false })
      .where(eq(schema.taskFiles.taskId, taskId))
      .run();
  if (ids.length === 0) return;
  ctx.tx
    .update(schema.taskFiles)
    .set({ inlineSent: true })
    .where(and(eq(schema.taskFiles.taskId, taskId), inArray(schema.taskFiles.id, [...ids])))
    .run();
}

/** Appends a line 10db itself writes to a task's thread, such as that a fresh session started. */
export function insertSystemNotice(
  ctx: WriteContext,
  taskId: TaskId,
  body: string,
): TaskMessageDto {
  const task = getTask(ctx.tx, taskId);
  const message: MessageRow = {
    id: mintId('TaskMessage'),
    taskId,
    author: TaskMessageAuthor.System,
    kind: TaskMessageKind.Notice,
    body,
    createdAt: ctx.now,
    pushedAt: null,
    deliveredAt: null,
  };
  ctx.tx.insert(schema.taskMessages).values(message).run();
  ctx.emit({
    type: EventType.TaskMessageAdded,
    entityType: 'task',
    entityId: taskId,
    data: { projectId: task.projectId, messageId: message.id },
  });
  return toMessageDto(message, []);
}

/** One pasted picture's row, with where its bytes are kept. */
export function getTaskFile(db: DbReader, id: TaskFileId): TaskFileRow {
  const row = db.select().from(schema.taskFiles).where(eq(schema.taskFiles.id, id)).get();
  if (!row) throw new NotFoundError('task file', id);
  return row;
}
