import {
  BundleOrigin,
  ChatTitleSource,
  CHAT_DEFAULT_TITLE,
  ConversationOwnerKind,
  ConversationProfile,
  ConversationState,
  EventType,
  idOfUuid,
  idUuid,
  mintId,
  NotFoundError,
  ShapeState,
  type ChatId,
  type ConversationId,
  type Effort,
  type ProjectId,
  type ShapeDto,
  type ShapeId,
  type ShapeOrigin,
} from '@10db/contracts';
import { and, asc, eq, getTableColumns, sql } from 'drizzle-orm';
import * as schema from '../schema';
import { getChat, insertChat, setChatTitle, type ChatRow } from './chats';
import {
  getConversation,
  insertConversation,
  patchConversation,
  type ConversationRow,
} from './conversations';
import { getProject } from './projects';
import type { DbReader, WriteContext } from './store';

// Shape spec docs/superpowers/specs/2026-11-02-10db-brainstorm-chat-design.md §13. The daemon's
// shape module owns the conversation's state; these are its rows.

type ShapeRow = typeof schema.shapes.$inferSelect & {
  readonly model: string | null;
  readonly effort: Effort | null;
};

/** A plan's title until its session is named. */
export const DEFAULT_SHAPE_TITLE = 'New conversation';

/** A shape's row with the model and effort its chat's conversation holds. */
const shapeColumns = {
  ...getTableColumns(schema.shapes),
  model: schema.conversations.model,
  effort: schema.conversations.effort,
};
const selectShapes = (db: DbReader) =>
  db
    .select(shapeColumns)
    .from(schema.shapes)
    .leftJoin(schema.chats, eq(schema.chats.id, schema.shapes.chatId))
    .leftJoin(schema.conversations, eq(schema.conversations.id, schema.chats.conversationId));

const toShapeDto = (row: ShapeRow): ShapeDto => ({
  id: row.id,
  projectId: row.projectId,
  title: row.title,
  state: row.state,
  origin: row.origin,
  round: row.round,
  model: row.model,
  effort: row.effort,
  importedAt: row.importedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export class PlanIdError extends Error {
  override readonly name = 'PlanIdError';
}

/** A chat's plan id: the chat's uuid under the Shape prefix, so a chat's plan id is known before its row exists. */
export function planIdOfChat(chatId: ChatId): ShapeId {
  const id = idOfUuid('Shape', idUuid(chatId));
  if (id === null) throw new PlanIdError(`Chat ${chatId} has no uuid to derive a plan id from`);
  return id;
}

/** Writes a plan over its chat: listening, no proposal yet. An imported plan gives its state, round and bundle. */
export function insertShape(
  ctx: WriteContext,
  projectId: ProjectId,
  input: {
    readonly chatId: ChatId;
    readonly title: string;
    readonly origin: ShapeOrigin;
    readonly state?: ShapeState;
    readonly round?: number;
    readonly bundleId?: string | null;
    readonly bundleOrigin?: BundleOrigin | null;
    readonly importedAt?: string | null;
  },
): ShapeDto {
  getProject(ctx.tx, projectId);
  const row: typeof schema.shapes.$inferSelect = {
    id: planIdOfChat(input.chatId),
    projectId,
    title: input.title,
    state: input.state ?? ShapeState.Listening,
    origin: input.origin,
    round: input.round ?? 0,
    chatId: input.chatId,
    bundleId: input.bundleId ?? null,
    bundleOrigin: input.bundleOrigin ?? null,
    importedAt: input.importedAt ?? null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.shapes).values(row).run();
  ctx.emit({
    type: EventType.ShapeChanged,
    entityType: 'shape',
    entityId: row.id,
    data: { projectId },
  });
  return toShapeDto({ ...row, model: null, effort: null });
}

/** A new session with its Plan: the conversation, the chat row and the shape, in the caller's write. */
export function insertPlanSession(
  ctx: WriteContext,
  input: {
    readonly projectId: ProjectId;
    /** Null: the chat is titled from its first message, and the plan follows it. */
    readonly title: string | null;
    readonly origin: ShapeOrigin;
    readonly tabPosition: number | null;
    readonly model?: string | null;
    readonly effort?: Effort | null;
    readonly state?: ShapeState;
    readonly round?: number;
    readonly bundleId?: string | null;
    readonly bundleOrigin?: BundleOrigin | null;
    readonly importedAt?: string | null;
  },
): { readonly chat: ChatRow; readonly shape: ShapeDto } {
  const chatId = mintId('Chat');
  const conversation = insertConversation(ctx, {
    projectId: input.projectId,
    owner: { kind: ConversationOwnerKind.Chat, id: chatId },
    profile: ConversationProfile.Explore,
    state: ConversationState.IdleCold,
  });
  const model = input.model ?? null;
  const effort = input.effort ?? null;
  if (model !== null || effort !== null) patchConversation(ctx, conversation.id, { model, effort });
  insertChat(ctx, {
    id: chatId,
    projectId: input.projectId,
    conversationId: conversation.id,
    title: input.title ?? CHAT_DEFAULT_TITLE,
    tabPosition: input.tabPosition,
  });
  if (input.title !== null) setChatTitle(ctx, chatId, input.title, ChatTitleSource.Builder);
  const shape = insertShape(ctx, input.projectId, {
    chatId,
    title: input.title ?? DEFAULT_SHAPE_TITLE,
    origin: input.origin,
    ...(input.state === undefined ? {} : { state: input.state }),
    ...(input.round === undefined ? {} : { round: input.round }),
    ...(input.bundleId === undefined ? {} : { bundleId: input.bundleId }),
    ...(input.bundleOrigin === undefined ? {} : { bundleOrigin: input.bundleOrigin }),
    ...(input.importedAt === undefined ? {} : { importedAt: input.importedAt }),
  });
  return { chat: getChat(ctx.tx, chatId), shape: { ...shape, model, effort } };
}

/** The chat a plan belongs to. */
export function chatOfShape(db: DbReader, id: ShapeId): ChatId {
  const row = db
    .select({ chatId: schema.shapes.chatId })
    .from(schema.shapes)
    .where(eq(schema.shapes.id, id))
    .get();
  if (!row) throw new NotFoundError('shape', id);
  return row.chatId;
}

/** The conversation a plan's session holds; every plan has one. */
export function shapeConversation(db: DbReader, id: ShapeId): ConversationRow {
  const row = db
    .select({ conversationId: schema.chats.conversationId })
    .from(schema.shapes)
    .innerJoin(schema.chats, eq(schema.chats.id, schema.shapes.chatId))
    .where(eq(schema.shapes.id, id))
    .get();
  if (!row) throw new NotFoundError('shape conversation', id);
  return getConversation(db, row.conversationId);
}

/** The plan of a chat, or null. */
export function planOfChat(db: DbReader, id: ChatId): ShapeId | null {
  return (
    db
      .select({ id: schema.shapes.id })
      .from(schema.shapes)
      .where(eq(schema.shapes.chatId, id))
      .get()?.id ?? null
  );
}

/** The plan of a conversation's chat, or null. */
export function planOfConversation(db: DbReader, id: ConversationId): ShapeId | null {
  return (
    db
      .select({ id: schema.shapes.id })
      .from(schema.shapes)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.shapes.chatId))
      .where(eq(schema.chats.conversationId, id))
      .get()?.id ?? null
  );
}

/** The Plan a bundle id was imported into in a project, if any. */
export function getShapeByBundle(
  db: DbReader,
  projectId: ProjectId,
  bundleId: string,
): ShapeDto | undefined {
  const row = selectShapes(db)
    .where(and(eq(schema.shapes.projectId, projectId), eq(schema.shapes.bundleId, bundleId)))
    .get();
  return row ? toShapeDto(row) : undefined;
}

/** Where an imported Plan's bundle was made; null for a conversation. */
export function getShapeBundleOrigin(db: DbReader, id: ShapeId): BundleOrigin | null {
  const row = db
    .select({ bundleOrigin: schema.shapes.bundleOrigin })
    .from(schema.shapes)
    .where(eq(schema.shapes.id, id))
    .get();
  return row?.bundleOrigin == null ? null : BundleOrigin.parse(row.bundleOrigin);
}

export function getShape(db: DbReader, id: ShapeId): ShapeDto {
  const row = selectShapes(db).where(eq(schema.shapes.id, id)).get();
  if (!row) throw new NotFoundError('shape', id);
  return toShapeDto(row);
}

/**
 * The tokens a conversation has used so far (§4): input and output summed over every session it has
 * run, the same rows per-project usage reads. Cache reads are left out although they are not part of the
 * input (the daemon stores them apart, so adding them would be valid): Settings usage and the goal digest
 * leave them out too, and repeated cache reads across turns would swamp the number.
 */
export function shapeTokens(db: DbReader, id: ShapeId): number {
  const row = db
    .select({
      total: sql<number>`coalesce(sum(${schema.sessions.inputTokens} + ${schema.sessions.outputTokens}), 0)`,
    })
    .from(schema.sessions)
    .innerJoin(schema.chats, eq(schema.chats.conversationId, schema.sessions.conversationId))
    .innerJoin(schema.shapes, eq(schema.shapes.chatId, schema.chats.id))
    .where(eq(schema.shapes.id, id))
    .get();
  return row?.total ?? 0;
}

/** The project's conversations, oldest first. */
export function listShapes(db: DbReader, projectId: ProjectId): ShapeDto[] {
  return selectShapes(db)
    .where(eq(schema.shapes.projectId, projectId))
    .orderBy(asc(schema.shapes.createdAt), asc(schema.shapes.id))
    .all()
    .map(toShapeDto);
}

/** The chat's plan, made over the chat when it has none yet. `made` says whether this call wrote it. */
export function ensurePlanOfChat(
  ctx: WriteContext,
  chatId: ChatId,
  origin: ShapeOrigin,
): { readonly shapeId: ShapeId; readonly made: boolean } {
  const existing = planOfChat(ctx.tx, chatId);
  if (existing !== null) return { shapeId: existing, made: false };
  const chat = getChat(ctx.tx, chatId);
  const shape = insertShape(ctx, chat.projectId, {
    chatId,
    title:
      chat.title === null || chat.title === CHAT_DEFAULT_TITLE ? DEFAULT_SHAPE_TITLE : chat.title,
    origin,
  });
  ctx.emit({
    type: EventType.ChatChanged,
    entityType: 'chat',
    entityId: chatId,
    data: { projectId: chat.projectId },
  });
  return { shapeId: shape.id, made: true };
}
