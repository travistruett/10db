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
  type TaskPictureKind,
} from '@10db/contracts';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';
import { getTask } from './tasks';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §4.3, §6.3, §11. A task's
// thread as rows. The daemon keeps a picture's bytes on disk before it calls these; they keep the rows.

export type TaskFileRow = typeof schema.taskFiles.$inferSelect;
type MessageRow = typeof schema.taskMessages.$inferSelect;

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

/** A task's thread, oldest first, each message with its pictures. */
export function listTaskThread(db: DbReader, taskId: TaskId): TaskMessageDto[] {
  const files = db
    .select()
    .from(schema.taskFiles)
    .where(eq(schema.taskFiles.taskId, taskId))
    .orderBy(asc(schema.taskFiles.id))
    .all();
  return db
    .select()
    .from(schema.taskMessages)
    .where(eq(schema.taskMessages.taskId, taskId))
    .orderBy(asc(schema.taskMessages.id))
    .all()
    .map((row) =>
      toMessageDto(
        row,
        files.filter((f) => f.messageId === row.id),
      ),
    );
}

/** One pasted picture's row, with where its bytes are kept. */
export function getTaskFile(db: DbReader, id: TaskFileId): TaskFileRow {
  const row = db.select().from(schema.taskFiles).where(eq(schema.taskFiles.id, id)).get();
  if (!row) throw new NotFoundError('task file', id);
  return row;
}
