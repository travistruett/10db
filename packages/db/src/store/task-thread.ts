import {
  EventType,
  mintId,
  NotFoundError,
  TaskMessageAuthor,
  TaskMessageKind,
  type TaskFileDto,
  type TaskFileId,
  type PassTurnId,
  type TaskId,
  type TaskMessageDto,
  type TaskMessageId,
  type TaskPictureKind,
} from '@10db/contracts';
import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '../schema';
import { deleteAppSetting, getAppSetting, setAppSetting } from './settings';
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

/** Where the text Send to Agent sends for a notice is kept, by the notice's id. */
const sendToAgentKey = (id: TaskMessageId): string => `send_to_agent.${id}`;

/** Whether the offer on a notice is the builder's go-ahead for a denied call, by the notice's id. */
const allowThisKey = (id: TaskMessageId): string => `allow-this.${id}`;

const toMessageDto = (
  row: MessageRow,
  files: readonly TaskFileRow[],
  offer: { readonly sendable: boolean; readonly allowThis: boolean } = {
    sendable: false,
    allowThis: false,
  },
): TaskMessageDto => ({
  id: row.id,
  taskId: row.taskId,
  author: row.author,
  kind: row.kind,
  body: row.body,
  createdAt: row.createdAt,
  pushedAt: row.pushedAt,
  deliveredAt: row.deliveredAt,
  files: files.map(toFileDto),
  sendable: offer.sendable,
  allowThis: offer.allowThis,
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
    pushUuids: [],
    turnId: null,
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

/**
 * Takes back a builder message no session was handed, with its pictures' rows, in the caller's write:
 * a page that refused it keeps nothing of it. Answers the pictures' stored paths, which the caller
 * removes once no other row names them; null, removing nothing, for a message a session was handed
 * or a turn took.
 */
export function deleteUnsentBuilderMessage(
  ctx: WriteContext,
  taskId: TaskId,
  id: TaskMessageId,
): string[] | null {
  const message = ctx.tx
    .select()
    .from(schema.taskMessages)
    .where(and(eq(schema.taskMessages.id, id), eq(schema.taskMessages.taskId, taskId)))
    .get();
  if (!message) throw new NotFoundError('task message', id);
  if (
    message.author !== TaskMessageAuthor.Builder ||
    message.pushedAt !== null ||
    message.pushUuids.length > 0 ||
    message.deliveredAt !== null ||
    message.turnId !== null
  )
    return null;
  const files = ctx.tx
    .select()
    .from(schema.taskFiles)
    .where(eq(schema.taskFiles.messageId, id))
    .all();
  ctx.tx.delete(schema.taskFiles).where(eq(schema.taskFiles.messageId, id)).run();
  ctx.tx.delete(schema.taskMessages).where(eq(schema.taskMessages.id, id)).run();
  const task = getTask(ctx.tx, taskId);
  ctx.emit({
    type: EventType.TaskChanged,
    entityType: 'task',
    entityId: taskId,
    data: { projectId: task.projectId, removedMessageId: id },
  });
  const stillNamed = new Set(
    ctx.tx
      .select({ storedPath: schema.taskFiles.storedPath })
      .from(schema.taskFiles)
      .where(eq(schema.taskFiles.taskId, taskId))
      .all()
      .map((f) => f.storedPath),
  );
  return files.map((f) => f.storedPath).filter((path) => !stillNamed.has(path));
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

/** A task's thread, oldest first, each message with its pictures and whether it offers Send to Agent. */
export function listTaskThread(db: DbReader, taskId: TaskId): TaskMessageDto[] {
  const rows = listTaskThreadRows(db, taskId);
  const keys = rows
    .filter((r) => r.kind === TaskMessageKind.Notice)
    .flatMap((r) => [sendToAgentKey(r.id), allowThisKey(r.id)]);
  const offered = new Set(
    keys.length === 0
      ? []
      : db
          .select({ key: schema.appSettings.key })
          .from(schema.appSettings)
          .where(inArray(schema.appSettings.key, keys))
          .all()
          .map((s) => s.key),
  );
  return rows.map((row) => {
    const sendable = offered.has(sendToAgentKey(row.id));
    // Allow this is a kind of offer: without the offer's text there is nothing to allow.
    return toMessageDto(row, row.files, {
      sendable,
      allowThis: sendable && offered.has(allowThisKey(row.id)),
    });
  });
}

/**
 * Offers thread notice `id` with Send to Agent (spec §8.1, §8.3, D19), which will send `text` as the
 * builder's message, in the caller's write.
 */
export function offerToAgent(ctx: WriteContext, id: TaskMessageId, text: string): void {
  setAppSetting(ctx, sendToAgentKey(id), text);
}

/**
 * Offers thread notice `id` with Allow this, in the caller's write: Send to Agent's offer of `text`,
 * which is the builder's go-ahead for the call auto mode denied, marked so the button reads so.
 */
export function offerAllowThis(ctx: WriteContext, id: TaskMessageId, text: string): void {
  offerToAgent(ctx, id, text);
  setAppSetting(ctx, allowThisKey(id), true);
}

/** Whether thread notice `id`'s standing offer is an Allow this. */
export function isAllowThisOffer(db: DbReader, id: TaskMessageId): boolean {
  return offeredText(db, id) !== null && getAppSetting(db, allowThisKey(id)) === true;
}

/**
 * Takes thread notice `id`'s Send to Agent offer, in the caller's write: answers the text it sends
 * and drops the offer, an Allow this mark with it, so the notice is sent once; null when it offers none.
 */
export function takeOffer(ctx: WriteContext, id: TaskMessageId): string | null {
  const text = offeredText(ctx.tx, id);
  if (text !== null) {
    deleteAppSetting(ctx, sendToAgentKey(id));
    deleteAppSetting(ctx, allowThisKey(id));
  }
  return text;
}

/**
 * Drops every Allow this offer on these tasks' notices, in the caller's write: the go-ahead of a pass
 * that has closed has no page to go to. Other offers on the same notices stay.
 */
export function dropAllowThisOffers(ctx: WriteContext, taskIds: readonly TaskId[]): void {
  if (taskIds.length === 0) return;
  const notices = ctx.tx
    .select({ id: schema.taskMessages.id })
    .from(schema.taskMessages)
    .where(
      and(
        inArray(schema.taskMessages.taskId, [...taskIds]),
        eq(schema.taskMessages.kind, TaskMessageKind.Notice),
      ),
    )
    .all();
  for (const { id } of notices) {
    if (getAppSetting(ctx.tx, allowThisKey(id)) === undefined) continue;
    deleteAppSetting(ctx, allowThisKey(id));
    deleteAppSetting(ctx, sendToAgentKey(id));
  }
}

/** The text Send to Agent sends for thread notice `id`; null when it offers none. */
export function offeredText(db: DbReader, id: TaskMessageId): string | null {
  // Read from the database: parsed, as at every boundary.
  const stored = z
    .string()
    .min(1)
    .safeParse(getAppSetting(db, sendToAgentKey(id)));
  return stored.success ? stored.data : null;
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
 * Notes that the message was handed to a session now under the client uuid `uuid`, which it keeps
 * beside every earlier one: a conversation read back after a restart is matched against them.
 */
export function markTaskMessagePushedUnder(
  ctx: WriteContext,
  id: TaskMessageId,
  uuid: string,
): void {
  const { pushUuids } = getTaskMessageRow(ctx.tx, id);
  ctx.tx
    .update(schema.taskMessages)
    .set({ pushedAt: ctx.now, pushUuids: [...pushUuids, uuid] })
    .where(eq(schema.taskMessages.id, id))
    .run();
}

/**
 * Hands back to 10db's queue this task's messages among `ids` that a session was handed and dropped
 * without a turn taking them (a Codex turn that ended first): they are no longer pushed, so none is in
 * doubt, and they keep every uuid they went under. Answers those handed back; a delivered one, or
 * another task's, is left.
 */
export function markTaskMessagesHandedBack(
  ctx: WriteContext,
  taskId: TaskId,
  ids: readonly TaskMessageId[],
): TaskMessageId[] {
  if (ids.length === 0) return [];
  const where = and(
    eq(schema.taskMessages.taskId, taskId),
    inArray(schema.taskMessages.id, [...ids]),
    isNotNull(schema.taskMessages.pushedAt),
    isNull(schema.taskMessages.deliveredAt),
  );
  const handed = ctx.tx
    .select({ id: schema.taskMessages.id })
    .from(schema.taskMessages)
    .where(where)
    .orderBy(asc(schema.taskMessages.id))
    .all()
    .map((row) => row.id);
  if (handed.length > 0)
    ctx.tx.update(schema.taskMessages).set({ pushedAt: null }).where(where).run();
  return handed;
}

/**
 * Marks delivered, once each, this task's messages pushed and not delivered that a conversation took:
 * one of the client uuids it was pushed under is among `held`, the uuids the conversation's user
 * messages carry. Answers those it marked, oldest first. A message pushed under no uuid is never
 * taken here.
 */
export function markTaskMessagesTakenUnder(
  ctx: WriteContext,
  taskId: TaskId,
  held: readonly string[],
): TaskMessageId[] {
  const holds = new Set(held);
  const taken = listUndeliveredTaskMessages(ctx.tx, taskId)
    .filter((m) => m.pushUuids.some((uuid) => holds.has(uuid)))
    .map((m) => m.id);
  return markTaskMessagesDelivered(ctx, taskId, taken);
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
    pushUuids: [],
    turnId: null,
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

/** Appends the agent's reply at the end of a pass turn, naming the turn, in the caller's write. */
export function insertAgentReply(
  ctx: WriteContext,
  taskId: TaskId,
  input: { readonly body: string; readonly turnId: PassTurnId },
): TaskMessageDto {
  const task = getTask(ctx.tx, taskId);
  const message: MessageRow = {
    id: mintId('TaskMessage'),
    taskId,
    author: TaskMessageAuthor.Agent,
    kind: TaskMessageKind.Reply,
    body: input.body,
    createdAt: ctx.now,
    pushedAt: null,
    deliveredAt: null,
    pushUuids: [],
    turnId: input.turnId,
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
