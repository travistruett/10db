import {
  CHAT_DEFAULT_TITLE,
  ChatMode,
  ChatTitleSource,
  ConversationItemAuthor,
  ConversationItemKind,
  HandedToNotice,
  ConversationState,
  EventType,
  mintId,
  NotFoundError,
  TaskStatus,
  WorkstreamState,
  type ChatId,
  type ConversationId,
  type PassId,
  type ProjectId,
  type TaskId,
} from '@10db/contracts';
import { and, asc, desc, eq, gte, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import * as schema from '../schema';
import { insertItem, listItems } from './conversation-items';
import type { DbReader, WriteContext } from './store';

// Sessions spec §7.1, §9.1: a chat's row (a tab of its own over a conversation), its place in the
// strip, its title, and the tasks it filed. Every write announces `chat.changed`.

export type ChatRow = typeof schema.chats.$inferSelect;

/** A chat as the screen reads it, all but the conversation, which only the engine can describe. */
export interface ChatRowView {
  readonly id: ChatId;
  readonly projectId: ProjectId;
  readonly conversationId: ConversationId;
  readonly title: string;
  readonly titleSource: ChatTitleSource;
  readonly mode: ChatMode;
  readonly taskId: TaskId | null;
  readonly passId: ChatRow['passId'];
  readonly tabPosition: number | null;
  readonly createdAt: string;
  readonly lastActivityAt: string | null;
  readonly archivedAt: string | null;
  readonly lastReplyAt: string | null;
  readonly tasksFiled: number;
}

const changed = (ctx: WriteContext, row: Pick<ChatRow, 'id' | 'projectId'>): void => {
  ctx.emit({
    type: EventType.ChatChanged,
    entityType: 'chat',
    entityId: row.id,
    data: { projectId: row.projectId },
  });
};

export function getChat(db: DbReader, id: ChatId): ChatRow {
  const row = db.select().from(schema.chats).where(eq(schema.chats.id, id)).get();
  if (!row) throw new NotFoundError('chat', id);
  return row;
}

/** The chat a conversation belongs to, or null for another owner's. */
export function chatOfConversation(db: DbReader, conversationId: ConversationId): ChatRow | null {
  return (
    db.select().from(schema.chats).where(eq(schema.chats.conversationId, conversationId)).get() ??
    null
  );
}

/** The project's chats whose conversation is taken over, so their agent runs in the builder's terminal. */
export function takenOverChats(db: DbReader, projectId: ProjectId): ChatRow[] {
  return db
    .select({ chat: schema.chats })
    .from(schema.chats)
    .innerJoin(schema.conversations, eq(schema.conversations.id, schema.chats.conversationId))
    .where(
      and(
        eq(schema.chats.projectId, projectId),
        eq(schema.conversations.state, ConversationState.TakenOver),
      ),
    )
    .orderBy(asc(schema.chats.createdAt), asc(schema.chats.id))
    .all()
    .map((r) => r.chat);
}

/** Every open tab, by its place in the strip, across every project. */
export function openChats(db: DbReader): ChatRow[] {
  return db
    .select()
    .from(schema.chats)
    .where(isNotNull(schema.chats.tabPosition))
    .orderBy(asc(schema.chats.tabPosition), asc(schema.chats.id))
    .all();
}

/** Numbers `ids` 0..n-1 in order. */
function renumber(ctx: WriteContext, ids: readonly ChatId[]): void {
  ids.forEach((id, position) => {
    ctx.tx
      .update(schema.chats)
      .set({ tabPosition: position })
      .where(and(eq(schema.chats.id, id), sql`${schema.chats.tabPosition} IS NOT ${position}`))
      .run();
  });
}

/** The open tabs but `except`, with `id` placed at `position` (clamped to the strip), renumbered. */
function placeTab(ctx: WriteContext, id: ChatId, position: number | null): void {
  const others = openChats(ctx.tx)
    .map((c) => c.id)
    .filter((other) => other !== id);
  if (position === null) {
    ctx.tx
      .update(schema.chats)
      .set({ tabPosition: null, updatedAt: ctx.now })
      .where(eq(schema.chats.id, id))
      .run();
    renumber(ctx, others);
    return;
  }
  const at = Math.max(0, Math.min(position, others.length));
  // Cleared first, so the renumbering never leaves two tabs on one place even for a moment.
  ctx.tx
    .update(schema.chats)
    .set({ tabPosition: null, updatedAt: ctx.now })
    .where(eq(schema.chats.id, id))
    .run();
  renumber(ctx, [...others.slice(0, at), id, ...others.slice(at)]);
}

/** A new chat, its tab at `tabPosition`: the tabs at or after it move right by one. */
export function insertChat(
  ctx: WriteContext,
  input: {
    /** Minted first when the conversation is made before the chat, since it names its owner. */
    readonly id?: ChatId;
    readonly projectId: ProjectId;
    readonly conversationId: ConversationId;
    readonly title: string;
    readonly tabPosition: number;
  },
): ChatRow {
  const row: ChatRow = {
    id: input.id ?? mintId('Chat'),
    projectId: input.projectId,
    conversationId: input.conversationId,
    title: input.title,
    titleSource: ChatTitleSource.Agent,
    mode: ChatMode.Explore,
    taskId: null,
    passId: null,
    tabPosition: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    lastActivityAt: null,
    archivedAt: null,
  };
  ctx.tx.insert(schema.chats).values(row).run();
  placeTab(ctx, row.id, input.tabPosition);
  changed(ctx, row);
  return getChat(ctx.tx, row.id);
}

/** Opens a tab at `position`, moves it there, or with null closes it; the strip stays 0..n-1. */
export function moveChatTab(ctx: WriteContext, chatId: ChatId, position: number | null): void {
  const row = getChat(ctx.tx, chatId);
  placeTab(ctx, chatId, position);
  changed(ctx, row);
}

/** Names the chat; an agent's name never replaces the builder's, and then nothing is written. */
export function setChatTitle(
  ctx: WriteContext,
  chatId: ChatId,
  title: string,
  source: ChatTitleSource,
): boolean {
  const row = getChat(ctx.tx, chatId);
  if (source === ChatTitleSource.Agent && row.titleSource === ChatTitleSource.Builder) return false;
  ctx.tx
    .update(schema.chats)
    .set({ title, titleSource: source, updatedAt: ctx.now })
    .where(eq(schema.chats.id, chatId))
    .run();
  changed(ctx, row);
  return true;
}

/** Archives the chat and closes its tab. */
export function archiveChat(ctx: WriteContext, chatId: ChatId, at: string): void {
  const row = getChat(ctx.tx, chatId);
  placeTab(ctx, chatId, null);
  ctx.tx
    .update(schema.chats)
    .set({ archivedAt: at, updatedAt: ctx.now })
    .where(eq(schema.chats.id, chatId))
    .run();
  changed(ctx, row);
}

/** Brings an archived chat back; its tab is placed by the caller. */
export function unarchiveChat(ctx: WriteContext, chatId: ChatId): void {
  const row = getChat(ctx.tx, chatId);
  ctx.tx
    .update(schema.chats)
    .set({ archivedAt: null, updatedAt: ctx.now })
    .where(eq(schema.chats.id, chatId))
    .run();
  changed(ctx, row);
}

/** The builder sent, or the agent ended a turn: Recent orders by this. */
export function touchChat(ctx: WriteContext, chatId: ChatId, at: string): void {
  const row = getChat(ctx.tx, chatId);
  ctx.tx
    .update(schema.chats)
    .set({ lastActivityAt: at, updatedAt: ctx.now })
    .where(eq(schema.chats.id, chatId))
    .run();
  changed(ctx, row);
}

/** Records a task the chat filed; recording it twice is one row. */
export function recordChatTask(ctx: WriteContext, chatId: ChatId, taskId: TaskId): void {
  const row = getChat(ctx.tx, chatId);
  ctx.tx
    .insert(schema.chatTasks)
    .values({ chatId, taskId, createdAt: ctx.now })
    .onConflictDoNothing()
    .run();
  changed(ctx, row);
}

/**
 * Hands the chat's work to a task (Do It), in the caller's write: the chat's `task_id` (and `pass_id` for a pass
 * of one), its mode, and a `chat_tasks` row, so Recent counts the task as filed and the chat's `edit_task`
 * reaches it. Called again with the same task, it changes nothing more.
 */
export function linkChatToTask(
  ctx: WriteContext,
  chatId: ChatId,
  input: { readonly taskId: TaskId; readonly passId: PassId | null },
): void {
  const row = getChat(ctx.tx, chatId);
  ctx.tx
    .update(schema.chats)
    .set({
      mode: ChatMode.HandsOn,
      taskId: input.taskId,
      passId: input.passId,
      updatedAt: ctx.now,
    })
    .where(eq(schema.chats.id, chatId))
    .run();
  ctx.tx
    .insert(schema.chatTasks)
    .values({ chatId, taskId: input.taskId, createdAt: ctx.now })
    .onConflictDoNothing()
    .run();
  changed(ctx, row);
}

/**
 * Puts a chat back as it was before `linkChatToTask`, for a start that was refused: explore mode, no task, no
 * pass. The `chat_tasks` row goes too, since the task it names is removed with it.
 */
export function unlinkChatFromTask(ctx: WriteContext, chatId: ChatId, taskId: TaskId): void {
  const row = getChat(ctx.tx, chatId);
  ctx.tx
    .update(schema.chats)
    .set({ mode: ChatMode.Explore, taskId: null, passId: null, updatedAt: ctx.now })
    .where(eq(schema.chats.id, chatId))
    .run();
  ctx.tx
    .delete(schema.chatTasks)
    .where(and(eq(schema.chatTasks.chatId, chatId), eq(schema.chatTasks.taskId, taskId)))
    .run();
  changed(ctx, row);
}

/**
 * Stores the notice that Do It handed the chat's work to a task, in the caller's write, and with `closeTab`
 * takes the chat's tab away, since the task's tab takes its place. Stored once per task.
 */
export function storeHandedTo(
  ctx: WriteContext,
  chatId: ChatId,
  notice: HandedToNotice,
  closeTab: boolean,
): void {
  const row = getChat(ctx.tx, chatId);
  const stored = listItems(ctx.tx, row.conversationId).some((item) => {
    if (item.kind !== ConversationItemKind.Notice) return false;
    const parsed = HandedToNotice.safeParse(item.body);
    return parsed.success && parsed.data.taskId === notice.taskId;
  });
  if (!stored)
    insertItem(ctx, row.conversationId, {
      author: ConversationItemAuthor.System,
      kind: ConversationItemKind.Notice,
      body: notice,
    });
  if (closeTab) placeTab(ctx, chatId, null);
  changed(ctx, row);
}

export function chatMadeTask(db: DbReader, chatId: ChatId, taskId: TaskId): boolean {
  return (
    db
      .select({ taskId: schema.chatTasks.taskId })
      .from(schema.chatTasks)
      .where(and(eq(schema.chatTasks.chatId, chatId), eq(schema.chatTasks.taskId, taskId)))
      .get() !== undefined
  );
}

/** A project's chats that have had a message and are not archived, newest activity first. */
export function recentChats(db: DbReader, projectId: ProjectId, limit: number): ChatRow[] {
  return db
    .select()
    .from(schema.chats)
    .where(
      and(
        eq(schema.chats.projectId, projectId),
        isNull(schema.chats.archivedAt),
        isNotNull(schema.chats.lastActivityAt),
      ),
    )
    .orderBy(desc(schema.chats.lastActivityAt), desc(schema.chats.id))
    .limit(limit)
    .all();
}

export function chatView(db: DbReader, chatId: ChatId): ChatRowView {
  const row = getChat(db, chatId);
  const reply = db
    .select({ at: schema.conversationItems.createdAt })
    .from(schema.conversationItems)
    .where(
      and(
        eq(schema.conversationItems.conversationId, row.conversationId),
        eq(schema.conversationItems.kind, ConversationItemKind.AgentMessage),
      ),
    )
    .orderBy(desc(schema.conversationItems.seq))
    .limit(1)
    .get();
  const filed = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.chatTasks)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.chatTasks.taskId))
    .where(and(eq(schema.chatTasks.chatId, chatId), ne(schema.tasks.status, TaskStatus.Cancelled)))
    .get();
  return {
    id: row.id,
    projectId: row.projectId,
    conversationId: row.conversationId,
    title: row.title ?? CHAT_DEFAULT_TITLE,
    titleSource: row.titleSource ?? ChatTitleSource.Agent,
    mode: row.mode,
    taskId: row.taskId,
    passId: row.passId,
    tabPosition: row.tabPosition,
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt,
    archivedAt: row.archivedAt,
    lastReplyAt: reply?.at ?? null,
    tasksFiled: filed?.n ?? 0,
  };
}

/** The title of the project's task whose run failed most recently since `since`, for Start from. */
export function latestFailedTaskTitle(
  db: DbReader,
  projectId: ProjectId,
  since: string,
): string | null {
  const row = db
    .select({ title: schema.tasks.title })
    .from(schema.workstreams)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.workstreams.taskId))
    .where(
      and(
        eq(schema.tasks.projectId, projectId),
        eq(schema.workstreams.state, WorkstreamState.Failed),
        gte(schema.workstreams.updatedAt, since),
      ),
    )
    .orderBy(desc(schema.workstreams.updatedAt))
    .limit(1)
    .get();
  return row?.title ?? null;
}
