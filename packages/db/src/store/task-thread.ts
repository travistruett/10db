import {
  ConversationItemAuthor,
  ConversationItemKind,
  ConversationOwnerKind,
  ConversationProfile,
  EventType,
  NotFoundError,
  TaskId,
  TaskMessageAuthor,
  TaskMessageKind,
  TaskPictureKind,
  type TaskFileDto,
  type TaskFileId,
  type PassTurnId,
  type TaskMessageDto,
  type TaskMessageId,
} from '@10db/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '../schema';
import {
  getFile,
  insertFiles,
  listFiles,
  listItemFiles,
  markFilesInline,
  type ConversationFileRow,
} from './conversation-files';
import {
  deleteItem,
  findItemByPushUuid,
  getItem,
  insertItem,
  listItems,
  listUndeliveredMessages,
  markItemPushedUnder,
  markItemsDelivered,
  markItemsHandedBack,
  markItemsTakenUnder,
  type ConversationItemRow,
} from './conversation-items';
import {
  conversationOf,
  getConversation,
  insertConversation,
  type ConversationRow,
} from './conversations';
import { deleteAppSetting, getAppSetting, setAppSetting } from './settings';
import type { DbReader, WriteContext } from './store';
import { getTask } from './tasks';
import { taskItemOf, taskMessageOf } from './transcript-kinds';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §4.3, §6.3, §11. A task's
// thread as rows: its conversation's items (decision
// 2026-11-13-one-conversation-store-keeps-ids-and-orders-by-seq.md), in `seq` order. The daemon keeps
// a picture's bytes on disk before it calls these; they keep the rows.

/** A picture pasted into a task's thread, with where it is kept. */
export interface TaskFileRow {
  readonly id: TaskFileId;
  readonly taskId: TaskId;
  readonly messageId: TaskMessageId;
  readonly name: string;
  readonly mediaType: TaskPictureKind;
  readonly size: number;
  readonly sha256: string;
  readonly storedPath: string;
  /** Whether the live session's history holds it as an image block. */
  readonly inlineSent: boolean;
  readonly createdAt: string;
}

/** A message of a thread as the daemon reads it: with its pictures and where each is kept. */
export interface TaskMessageRow {
  readonly id: TaskMessageId;
  readonly taskId: TaskId;
  readonly author: TaskMessageAuthor;
  readonly kind: TaskMessageKind;
  readonly body: string;
  readonly createdAt: string;
  /** When it was handed to the session; that alone proves nothing reached a turn. */
  readonly pushedAt: string | null;
  /** When a turn took it in; a message pushed and not delivered is sent again. */
  readonly deliveredAt: string | null;
  /** Every client uuid a push of it went under, oldest first. */
  readonly pushUuids: readonly string[];
  /** The pass turn the message started, or the turn whose reply it is. */
  readonly turnId: PassTurnId | null;
  readonly files: readonly TaskFileRow[];
}

/** A pasted picture already written to disk, by its hash, at `storedPath`. */
export interface StoredPicture {
  readonly name: string;
  readonly mediaType: TaskPictureKind;
  readonly size: number;
  readonly sha256: string;
  readonly storedPath: string;
}

const PictureRow = z.object({ itemId: z.string(), mediaType: TaskPictureKind, sha256: z.string() });

/** A conversation file as a thread's picture; a thread's file always has its message, kind and hash. */
function toTaskFile(taskId: TaskId, row: ConversationFileRow): TaskFileRow {
  // Read from the database: parsed, as at every boundary.
  const picture = PictureRow.parse(row);
  return {
    id: row.id,
    taskId,
    messageId: getItemId(row.itemId),
    name: row.name,
    mediaType: picture.mediaType,
    size: row.size,
    sha256: picture.sha256,
    storedPath: row.storedPath,
    inlineSent: row.inlineSent,
    createdAt: row.createdAt,
  };
}

function getItemId(id: ConversationFileRow['itemId']): TaskMessageId {
  if (id === null) throw new NotFoundError('task message', 'of a picture');
  return id;
}

/** An item as a thread message with its pictures; null for an item a thread has no word for. */
function toTaskMessage(
  taskId: TaskId,
  item: ConversationItemRow,
  files: readonly ConversationFileRow[],
): TaskMessageRow | null {
  const message = taskMessageOf(item);
  if (message === null) return null;
  return {
    id: item.id,
    taskId,
    ...message,
    createdAt: item.createdAt,
    pushedAt: item.pushedAt,
    deliveredAt: item.deliveredAt,
    pushUuids: item.pushUuids,
    turnId: item.turnId,
    files: files.filter((f) => f.itemId === item.id).map((f) => toTaskFile(taskId, f)),
  };
}

const toTaskMessages = (
  db: DbReader,
  taskId: TaskId,
  items: readonly ConversationItemRow[],
): TaskMessageRow[] => {
  const files = listItemFiles(
    db,
    items.map((i) => i.id),
  );
  return items.flatMap((item) => toTaskMessage(taskId, item, files) ?? []);
};

/** The task's thread's conversation, or null while nothing was said on it. */
export function taskConversationOf(db: DbReader, taskId: TaskId): ConversationRow | null {
  return conversationOf(db, { kind: ConversationOwnerKind.Task, id: taskId });
}

/**
 * The task's thread's conversation, made by its first item or by a lane whose session streams into it,
 * in the caller's write.
 */
export function ensureTaskConversation(ctx: WriteContext, taskId: TaskId): ConversationRow {
  const task = getTask(ctx.tx, taskId);
  return (
    taskConversationOf(ctx.tx, taskId) ??
    insertConversation(ctx, {
      projectId: task.projectId,
      owner: { kind: ConversationOwnerKind.Task, id: taskId },
      profile: ConversationProfile.Lane,
      state: null,
    })
  );
}

/** The task whose thread holds the conversation; throws for any other owner. */
function threadTask(db: DbReader, conversationId: ConversationRow['id'], what: string, id: string) {
  const conversation = getConversation(db, conversationId);
  if (conversation.ownerKind !== ConversationOwnerKind.Task) throw new NotFoundError(what, id);
  // A task's conversation names the task as its owner; parsed, as text read from the database.
  return TaskId.parse(conversation.ownerId);
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
  row: TaskMessageRow,
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
  files: row.files.map(toFileDto),
  sendable: offer.sendable,
  allowThis: offer.allowThis,
});

/** Appends a row to the task's thread and announces it, in the caller's write. */
function appendToThread(
  ctx: WriteContext,
  taskId: TaskId,
  message: {
    readonly author: TaskMessageAuthor;
    readonly kind: TaskMessageKind;
    readonly body: string;
    readonly turnId?: PassTurnId;
    readonly files?: readonly StoredPicture[];
  },
): TaskMessageRow {
  const task = getTask(ctx.tx, taskId);
  const conversation = ensureTaskConversation(ctx, taskId);
  const item = insertItem(ctx, conversation.id, {
    ...taskItemOf(message),
    turnId: message.turnId ?? null,
  });
  const files = insertFiles(ctx, conversation.id, item.id, message.files ?? []);
  ctx.emit({
    type: EventType.TaskMessageAdded,
    entityType: 'task',
    entityId: taskId,
    data: { projectId: task.projectId, messageId: item.id },
  });
  const row = toTaskMessage(taskId, item, files);
  if (row === null) throw new NotFoundError('task message', item.id);
  return row;
}

/** Appends the builder's message and its pictures to a task's thread, in the caller's write. */
export function insertBuilderMessage(
  ctx: WriteContext,
  taskId: TaskId,
  input: { readonly body: string; readonly files: readonly StoredPicture[] },
): TaskMessageDto {
  return toMessageDto(
    appendToThread(ctx, taskId, {
      author: TaskMessageAuthor.Builder,
      kind: TaskMessageKind.Message,
      body: input.body,
      files: input.files,
    }),
  );
}

/** This task's thread message `id`, or NotFoundError for another task's or none. */
function threadItem(db: DbReader, taskId: TaskId, id: TaskMessageId): ConversationItemRow {
  const conversation = taskConversationOf(db, taskId);
  const item = db
    .select()
    .from(schema.conversationItems)
    .where(eq(schema.conversationItems.id, id))
    .get();
  if (conversation === null || item?.conversationId !== conversation.id)
    throw new NotFoundError('task message', id);
  return item;
}

/**
 * Takes back a builder message no session was handed, with its pictures' rows, in the caller's write:
 * a page that refused it keeps nothing of it. Answers the pictures' stored paths, which the caller
 * removes once no other row names them; null, removing nothing, for a message a session was handed
 * or a turn took. Its `seq` is not given out again.
 */
export function deleteUnsentBuilderMessage(
  ctx: WriteContext,
  taskId: TaskId,
  id: TaskMessageId,
): string[] | null {
  const message = threadItem(ctx.tx, taskId, id);
  if (
    message.author !== ConversationItemAuthor.Builder ||
    message.kind !== ConversationItemKind.Message ||
    message.pushedAt !== null ||
    message.pushUuids.length > 0 ||
    message.deliveredAt !== null ||
    message.turnId !== null
  )
    return null;
  const files = listItemFiles(ctx.tx, [id]);
  deleteItem(ctx, id);
  const task = getTask(ctx.tx, taskId);
  ctx.emit({
    type: EventType.TaskChanged,
    entityType: 'task',
    entityId: taskId,
    data: { projectId: task.projectId, removedMessageId: id },
  });
  const stillNamed = new Set(listTaskFileRows(ctx.tx, taskId).map((f) => f.storedPath));
  return files.map((f) => f.storedPath).filter((path) => !stillNamed.has(path));
}

/** A task's thread, oldest first, each message with its pictures and where they are kept. */
export function listTaskThreadRows(db: DbReader, taskId: TaskId): TaskMessageRow[] {
  const conversation = taskConversationOf(db, taskId);
  return conversation === null ? [] : toTaskMessages(db, taskId, listItems(db, conversation.id));
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
    return toMessageDto(row, {
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
  const notices = taskIds.flatMap((taskId) =>
    listTaskThreadRows(ctx.tx, taskId).filter((m) => m.kind === TaskMessageKind.Notice),
  );
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
  const conversation = taskConversationOf(db, taskId);
  return conversation === null
    ? []
    : listFiles(db, conversation.id).map((row) => toTaskFile(taskId, row));
}

/** One message with its pictures and where they are kept. */
export function getTaskMessageRow(db: DbReader, id: TaskMessageId): TaskMessageRow {
  const item = getItem(db, id);
  const taskId = threadTask(db, item.conversationId, 'task message', id);
  const row = toTaskMessage(taskId, item, listItemFiles(db, [id]));
  if (row === null) throw new NotFoundError('task message', id);
  return row;
}

/** The thread message of this task a push went under `uuid`, or whose own uuid it is; null for none. */
export function findTaskMessageByUuid(
  db: DbReader,
  taskId: TaskId,
  uuid: string,
): TaskMessageId | null {
  const conversation = taskConversationOf(db, taskId);
  return conversation === null ? null : findItemByPushUuid(db, conversation.id, uuid);
}

/**
 * Notes that these messages were handed to a session now. That proves nothing reached a turn: a crash
 * loses what was pushed, so a message stays undelivered until a turn is seen to take it.
 */
export function markTaskMessagesPushed(ctx: WriteContext, ids: readonly TaskMessageId[]): void {
  if (ids.length === 0) return;
  ctx.tx
    .update(schema.conversationItems)
    .set({ pushedAt: ctx.now, updatedAt: ctx.now })
    .where(inArray(schema.conversationItems.id, [...ids]))
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
  markItemPushedUnder(ctx, id, uuid);
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
  const conversation = taskConversationOf(ctx.tx, taskId);
  return conversation === null ? [] : markItemsHandedBack(ctx, conversation.id, ids);
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
  const conversation = taskConversationOf(ctx.tx, taskId);
  return conversation === null ? [] : markItemsTakenUnder(ctx, conversation.id, held);
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
  const conversation = taskConversationOf(ctx.tx, taskId);
  return conversation === null ? [] : markItemsDelivered(ctx, conversation.id, ids);
}

/** A task's messages handed to a session that no turn has taken yet, oldest first: each is sent again. */
export function listUndeliveredTaskMessages(db: DbReader, taskId: TaskId): TaskMessageRow[] {
  const conversation = taskConversationOf(db, taskId);
  if (conversation === null) return [];
  const ids = listUndeliveredMessages(db, conversation.id).map((m) => m.id);
  return toTaskMessages(
    db,
    taskId,
    listItems(db, conversation.id).filter((item) => ids.includes(item.id)),
  );
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
  const conversation = taskConversationOf(ctx.tx, taskId);
  if (conversation !== null) markFilesInline(ctx, conversation.id, ids, fresh);
}

/** Appends a line 10db itself writes to a task's thread, such as that a fresh session started. */
export function insertSystemNotice(
  ctx: WriteContext,
  taskId: TaskId,
  body: string,
): TaskMessageDto {
  return toMessageDto(
    appendToThread(ctx, taskId, {
      author: TaskMessageAuthor.System,
      kind: TaskMessageKind.Notice,
      body,
    }),
  );
}

/**
 * The agent's reply at the end of a pass turn, naming the turn, in the caller's write. `itemId` is the
 * reply the session already streamed into the thread, which the turn's text only abbreviates (trimmed,
 * capped): that item is marked as the turn's and nothing is stored. With none, `body` is stored.
 */
export function insertAgentReply(
  ctx: WriteContext,
  taskId: TaskId,
  input: {
    readonly body: string;
    readonly turnId: PassTurnId;
    readonly itemId?: TaskMessageId;
  },
): TaskMessageDto {
  if (input.itemId !== undefined) {
    const item = threadItem(ctx.tx, taskId, input.itemId);
    markTaskMessageTurn(ctx, taskId, item.id, input.turnId);
    const task = getTask(ctx.tx, taskId);
    ctx.emit({
      type: EventType.TaskMessageAdded,
      entityType: 'task',
      entityId: taskId,
      data: { projectId: task.projectId, messageId: item.id },
    });
    const row = toTaskMessage(taskId, getItem(ctx.tx, item.id), []);
    if (row === null) throw new NotFoundError('task message', item.id);
    return toMessageDto(row);
  }
  return toMessageDto(
    appendToThread(ctx, taskId, {
      author: TaskMessageAuthor.Agent,
      kind: TaskMessageKind.Reply,
      body: input.body,
      turnId: input.turnId,
    }),
  );
}

/** One pasted picture's row, with where its bytes are kept. */
export function getTaskFile(db: DbReader, id: TaskFileId): TaskFileRow {
  const row = getFile(db, id);
  return toTaskFile(threadTask(db, row.conversationId, 'task file', id), row);
}

/** Stamps the turn a message started on it, within the task's thread, in the caller's write. */
export function markTaskMessageTurn(
  ctx: WriteContext,
  taskId: TaskId,
  messageId: TaskMessageId,
  turnId: PassTurnId,
): void {
  const conversation = taskConversationOf(ctx.tx, taskId);
  if (conversation === null) return;
  ctx.tx
    .update(schema.conversationItems)
    .set({ turnId, updatedAt: ctx.now })
    .where(
      and(
        eq(schema.conversationItems.id, messageId),
        eq(schema.conversationItems.conversationId, conversation.id),
      ),
    )
    .run();
}
