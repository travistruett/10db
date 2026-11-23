import {
  CHAT_DEFAULT_TITLE,
  ChatMode,
  ChatTitleSource,
  ConversationItemAuthor,
  ConversationItemKind,
  HandedToNotice,
  InvalidError,
  ConversationState,
  EventType,
  mintId,
  NotFoundError,
  TaskStatus,
  WorkPlace,
  WorkstreamState,
  type ChatId,
  type ChatWork,
  type ConversationId,
  type PassId,
  type ProjectId,
  type TaskId,
} from '@10db/contracts';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import * as schema from '../schema';
import { insertItem, listItems } from './conversation-items';
import { ofActiveProject } from './projects';
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
  readonly work: ChatWork | null;
}

/** What the Sessions screen reads of a row's place; null while the session only reads. */
function workOf(row: ChatRow): ChatWork | null {
  if (row.workPlace === null) return null;
  return {
    place: row.workPlace,
    branch: row.branch,
    base: row.baseHead,
    worktree: row.worktreePath,
    askedAt: row.workAskedAt,
  };
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

/** The project's chats whose conversation has an agent session starting, running, waiting on a card or stopping. */
export function chatsWithLiveSession(db: DbReader, projectId: ProjectId): ChatRow[] {
  return db
    .select({ chat: schema.chats })
    .from(schema.chats)
    .innerJoin(schema.conversations, eq(schema.conversations.id, schema.chats.conversationId))
    .where(
      and(
        eq(schema.chats.projectId, projectId),
        isNull(schema.chats.archivedAt),
        inArray(schema.conversations.state, [
          ConversationState.Starting,
          ConversationState.Running,
          ConversationState.WaitingCard,
          ConversationState.Stopping,
        ]),
      ),
    )
    .all()
    .map((r) => r.chat);
}

/** The project's open chats whose conversation is taken over, so their agent runs in the builder's terminal. */
export function takenOverChats(db: DbReader, projectId: ProjectId): ChatRow[] {
  return db
    .select({ chat: schema.chats })
    .from(schema.chats)
    .innerJoin(schema.conversations, eq(schema.conversations.id, schema.chats.conversationId))
    .where(
      and(
        eq(schema.chats.projectId, projectId),
        eq(schema.conversations.state, ConversationState.TakenOver),
        // An archived chat holds nothing, whatever its conversation says.
        isNull(schema.chats.archivedAt),
        // A branch session's terminal runs in its own worktree and holds nothing; one with no worktree
        // runs in the checkout and holds it.
        sql`(${schema.chats.workPlace} IS NOT ${WorkPlace.Branch} OR ${schema.chats.worktreePath} IS NULL)`,
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
    /** Null writes a closed tab. */
    readonly tabPosition: number | null;
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
    workPlace: null,
    worktreePath: null,
    branch: null,
    baseHead: null,
    workAskedAt: null,
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
  // A chat's plan is titled as the chat is.
  const plan = ctx.tx
    .select({ id: schema.shapes.id, projectId: schema.shapes.projectId })
    .from(schema.shapes)
    .where(eq(schema.shapes.chatId, chatId))
    .get();
  if (plan !== undefined) {
    ctx.tx
      .update(schema.shapes)
      .set({ title, updatedAt: ctx.now })
      .where(eq(schema.shapes.id, plan.id))
      .run();
    ctx.emit({
      type: EventType.ShapeChanged,
      entityType: 'shape',
      entityId: plan.id,
      data: { projectId: plan.projectId },
    });
  }
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

/** Chats whose work Do It handed to a task in a separate copy: linked to a task with no pass of their own. */
export function chatsHandedToCopies(db: DbReader): ChatRow[] {
  return db
    .select()
    .from(schema.chats)
    .where(
      and(
        eq(schema.chats.mode, ChatMode.HandsOn),
        isNull(schema.chats.passId),
        isNotNull(schema.chats.taskId),
      ),
    )
    .all();
}

/** The chat Do It made the task from: the latest to file it, or undefined for a task no chat filed. */
export function chatThatMadeTask(db: DbReader, taskId: TaskId): ChatRow | undefined {
  const link = db
    .select({ chatId: schema.chatTasks.chatId })
    .from(schema.chatTasks)
    .where(eq(schema.chatTasks.taskId, taskId))
    .orderBy(desc(schema.chatTasks.createdAt))
    .limit(1)
    .get();
  return link === undefined ? undefined : getChat(db, link.chatId);
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
    work: workOf(row),
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

/**
 * Moves the chat's place from `expect` to `next`, only if the row is still at `expect`; returns whether it was.
 * The row and its `ChatChanged` event go in the caller's write, and nothing is emitted when another writer won.
 * A field `next` leaves out keeps its value; pass null to clear it.
 */
export function setChatWork(
  ctx: WriteContext,
  id: ChatId,
  expect: WorkPlace | null,
  next: {
    readonly place: WorkPlace | null;
    readonly worktreePath?: string | null;
    readonly branch?: string | null;
    readonly baseHead?: string | null;
    readonly askedAt?: string | null;
  },
): boolean {
  const row = getChat(ctx.tx, id);
  const result = ctx.tx
    .update(schema.chats)
    .set({
      workPlace: next.place,
      ...(next.worktreePath !== undefined && { worktreePath: next.worktreePath }),
      ...(next.branch !== undefined && { branch: next.branch }),
      ...(next.baseHead !== undefined && { baseHead: next.baseHead }),
      ...(next.askedAt !== undefined && { workAskedAt: next.askedAt }),
      updatedAt: ctx.now,
    })
    .where(and(eq(schema.chats.id, id), sql`${schema.chats.workPlace} IS ${expect}`))
    .run();
  if (result.changes === 0) return false;
  changed(ctx, row);
  return true;
}

/** The chat whose worktree is at `path`, or undefined when none records it. */
export function findChatByWorktreePath(db: DbReader, path: string): ChatRow | undefined {
  return db.select().from(schema.chats).where(eq(schema.chats.worktreePath, path)).get();
}

/** The worktree paths chats have recorded: a worktree a chat owns is its own until the row lets it go. */
export function chatWorktreePaths(db: DbReader): string[] {
  return db
    .select({ path: schema.chats.worktreePath })
    .from(schema.chats)
    .where(isNotNull(schema.chats.worktreePath))
    .all()
    .flatMap((row) => (row.path === null ? [] : [row.path]));
}

/** Every chat in `place`, archived ones included, oldest first. */
export function chatsInPlace(db: DbReader, place: WorkPlace): ChatRow[] {
  return db
    .select()
    .from(schema.chats)
    .where(eq(schema.chats.workPlace, place))
    .orderBy(asc(schema.chats.createdAt), asc(schema.chats.id))
    .all();
}

/** The branches and worktree paths the project's chats have recorded, archived chats' branches included. */
export function takenBranchesAndPaths(
  db: DbReader,
  projectId: ProjectId,
): { branches: string[]; paths: string[] } {
  const rows = db
    .select({ branch: schema.chats.branch, path: schema.chats.worktreePath })
    .from(schema.chats)
    .where(eq(schema.chats.projectId, projectId))
    .all();
  return {
    branches: rows.flatMap((r) => (r.branch === null ? [] : [r.branch])),
    paths: rows.flatMap((r) => (r.path === null ? [] : [r.path])),
  };
}

export interface ChatPage {
  readonly rows: ChatRow[];
  /** The cursor for the page after this one, or null on the last. */
  readonly next: string | null;
}

const CURSOR_SEPARATOR = '|';

/** A title search across open, closed and archived chats, newest activity first, chats with none last. */
export function searchChats(
  db: DbReader,
  q: { readonly text: string; readonly after: string | null; readonly limit: number },
): ChatPage {
  const title = sql`coalesce(${schema.chats.title}, ${CHAT_DEFAULT_TITLE})`;
  const escaped = q.text.replace(/[\\%_]/g, (c) => `\\${c}`);
  const match = sql`${title} LIKE ${`%${escaped}%`} ESCAPE '\\'`;
  const at = schema.chats.lastActivityAt;
  let after = sql`1`;
  if (q.after !== null) {
    const cut = q.after.indexOf(CURSOR_SEPARATOR);
    if (cut < 0) throw new InvalidError('The search cursor is not one this search made');
    const cursorAt = q.after.slice(0, cut);
    const cursorId = q.after.slice(cut + 1);
    after =
      cursorAt === ''
        ? sql`(${at} IS NULL AND ${schema.chats.id} < ${cursorId})`
        : sql`(${at} IS NULL OR ${at} < ${cursorAt} OR (${at} = ${cursorAt} AND ${schema.chats.id} < ${cursorId}))`;
  }
  const rows = db
    .select()
    .from(schema.chats)
    .where(and(match, after, ofActiveProject(schema.chats.projectId)))
    .orderBy(sql`${at} IS NULL`, desc(at), desc(schema.chats.id))
    .limit(q.limit + 1)
    .all();
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  const next =
    rows.length > q.limit && last !== undefined
      ? `${last.lastActivityAt ?? ''}${CURSOR_SEPARATOR}${last.id}`
      : null;
  return { rows: page, next };
}
