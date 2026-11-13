import {
  ConversationItemAuthor,
  ConversationItemKind,
  InvalidError,
  mintId,
  NotFoundError,
  noticeText,
  parseItemBody,
  type ConversationId,
  type ConversationItemId,
  type PassTurnId,
} from '@10db/contracts';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Json } from '../json';
import * as schema from '../schema';
import { listItemFiles, type ConversationFileRow } from './conversation-files';
import { getConversation } from './conversations';
import type { DbReader, WriteContext } from './store';

// Sessions spec §6.2, §9.1. A conversation's items, numbered by `seq` and never ordered by id: a
// migrated row keeps its older `shm_` or `tmg_` id, which sorts after every new `cvi_` one as text.
// The delivery marks keep the threads' meaning (Workbench spec §6.3, §12), keyed by conversation.

export type ConversationItemRow = typeof schema.conversationItems.$inferSelect;

/** A message-like item (message, agent_message, notice, digest) with its text and files. */
export interface ConversationMessageRow extends Omit<ConversationItemRow, 'body'> {
  readonly body: string;
  readonly files: readonly ConversationFileRow[];
}

const MESSAGE_KINDS = [
  ConversationItemKind.Message,
  ConversationItemKind.AgentMessage,
  ConversationItemKind.Notice,
  ConversationItemKind.Digest,
] as const;
type MessageKind = (typeof MESSAGE_KINDS)[number];
const isMessageKind = (kind: ConversationItemKind): kind is MessageKind =>
  MESSAGE_KINDS.some((k) => k === kind);

const bySeq = asc(schema.conversationItems.seq);
const ofConversation = (id: ConversationId) => eq(schema.conversationItems.conversationId, id);

/**
 * Appends an item at the conversation's `next_seq`, in the caller's write, and moves `next_seq` on.
 * The body is checked as its kind's.
 */
export function insertItem(
  ctx: WriteContext,
  conversationId: ConversationId,
  input: {
    readonly author: ConversationItemAuthor;
    readonly kind: ConversationItemKind;
    readonly body: Json;
    readonly partial?: boolean;
    readonly deliveredAt?: string | null;
    readonly turnId?: PassTurnId | null;
  },
): ConversationItemRow {
  parseItemBody(input.kind, input.body);
  const { nextSeq } = getConversation(ctx.tx, conversationId);
  const row: ConversationItemRow = {
    id: mintId('ConversationItem'),
    conversationId,
    seq: nextSeq,
    author: input.author,
    kind: input.kind,
    body: input.body,
    turnId: input.turnId ?? null,
    partial: input.partial ?? false,
    pushedAt: null,
    pushUuids: [],
    deliveredAt: input.deliveredAt ?? null,
    handedBackAt: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.conversationItems).values(row).run();
  ctx.tx
    .update(schema.conversations)
    .set({ nextSeq: nextSeq + 1, updatedAt: ctx.now })
    .where(eq(schema.conversations.id, conversationId))
    .run();
  return row;
}

/** The conversation's items in `seq` order; `afterSeq` skips up to and including that one. */
export function listItems(
  db: DbReader,
  conversationId: ConversationId,
  opts: { readonly afterSeq?: number } = {},
): ConversationItemRow[] {
  const where =
    opts.afterSeq === undefined
      ? ofConversation(conversationId)
      : and(ofConversation(conversationId), gt(schema.conversationItems.seq, opts.afterSeq));
  return db.select().from(schema.conversationItems).where(where).orderBy(bySeq).all();
}

/** The newest `count` items, oldest first. */
export function lastItems(
  db: DbReader,
  conversationId: ConversationId,
  count: number,
): ConversationItemRow[] {
  return db
    .select()
    .from(schema.conversationItems)
    .where(ofConversation(conversationId))
    .orderBy(desc(schema.conversationItems.seq))
    .limit(count)
    .all()
    .reverse();
}

export function getItem(db: DbReader, id: ConversationItemId): ConversationItemRow {
  const row = db
    .select()
    .from(schema.conversationItems)
    .where(eq(schema.conversationItems.id, id))
    .get();
  if (!row) throw new NotFoundError('conversation item', id);
  return row;
}

/** Removes an item and its files' rows, in the caller's write; its `seq` is not given out again. */
export function deleteItem(ctx: WriteContext, id: ConversationItemId): void {
  ctx.tx.delete(schema.conversationFiles).where(eq(schema.conversationFiles.itemId, id)).run();
  ctx.tx.delete(schema.conversationItems).where(eq(schema.conversationItems.id, id)).run();
}

/** A message-like item's text; throws `InvalidError` for an item of another kind. */
function messageText(row: ConversationItemRow): string {
  if (!isMessageKind(row.kind)) throw new InvalidError(`${row.id} is a ${row.kind}, not a message`);
  return row.kind === ConversationItemKind.Notice
    ? noticeText(parseItemBody(row.kind, row.body))
    : parseItemBody(row.kind, row.body).text;
}

function withFiles(db: DbReader, rows: readonly ConversationItemRow[]): ConversationMessageRow[] {
  const files = listItemFiles(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((row) => ({
    ...row,
    body: messageText(row),
    files: files.filter((f) => f.itemId === row.id),
  }));
}

/** One message-like item with its files. */
export function getMessageRow(db: DbReader, id: ConversationItemId): ConversationMessageRow {
  const [row] = withFiles(db, [getItem(db, id)]);
  if (row === undefined) throw new NotFoundError('conversation item', id);
  return row;
}

const builderMessage = and(
  eq(schema.conversationItems.author, ConversationItemAuthor.Builder),
  eq(schema.conversationItems.kind, ConversationItemKind.Message),
);

/** The builder's messages no turn has taken, pushed or not, in `seq` order. */
export function listUntakenMessageIds(
  db: DbReader,
  conversationId: ConversationId,
): ConversationItemId[] {
  return db
    .select({ id: schema.conversationItems.id })
    .from(schema.conversationItems)
    .where(
      and(
        ofConversation(conversationId),
        builderMessage,
        isNull(schema.conversationItems.deliveredAt),
      ),
    )
    .orderBy(bySeq)
    .all()
    .map((r) => r.id);
}

/** The messages handed to a session that no turn has taken yet, in `seq` order: each is sent again. */
export function listUndeliveredMessages(
  db: DbReader,
  conversationId: ConversationId,
): ConversationMessageRow[] {
  return withFiles(
    db,
    db
      .select()
      .from(schema.conversationItems)
      .where(
        and(
          ofConversation(conversationId),
          isNotNull(schema.conversationItems.pushedAt),
          isNull(schema.conversationItems.deliveredAt),
        ),
      )
      .orderBy(bySeq)
      .all(),
  );
}

/**
 * The item of this conversation a push went under `uuid`, or, for a row that was never pushed under one
 * (a message pushed before push uuids were kept), whose own id's UUID is `uuid`; null for neither.
 */
export function findItemByPushUuid(
  db: DbReader,
  conversationId: ConversationId,
  uuid: string,
): ConversationItemId | null {
  const pushed = db
    .select({ id: schema.conversationItems.id })
    .from(schema.conversationItems)
    .where(
      and(
        ofConversation(conversationId),
        sql`EXISTS (SELECT 1 FROM json_each(${schema.conversationItems.pushUuids}) WHERE value = ${uuid})`,
      ),
    )
    .orderBy(bySeq)
    .get();
  if (pushed) return pushed.id;
  const own = db
    .select({ id: schema.conversationItems.id })
    .from(schema.conversationItems)
    .where(
      and(
        ofConversation(conversationId),
        sql`substr(${schema.conversationItems.id}, instr(${schema.conversationItems.id}, '_') + 1) = ${uuid}`,
      ),
    )
    .get();
  return own?.id ?? null;
}

/**
 * Notes that the item was handed to a session now under the client uuid `uuid`, kept beside every
 * earlier one: a conversation read back after a restart is matched against them.
 */
export function markItemPushedUnder(ctx: WriteContext, id: ConversationItemId, uuid: string): void {
  const { pushUuids } = getItem(ctx.tx, id);
  ctx.tx
    .update(schema.conversationItems)
    .set({ pushedAt: ctx.now, pushUuids: [...pushUuids, uuid], updatedAt: ctx.now })
    .where(eq(schema.conversationItems.id, id))
    .run();
}

/** The ids among `where`'s items, in `seq` order, then `set` on them; answers the ids. */
function markWhere(
  ctx: WriteContext,
  where: ReturnType<typeof and>,
  set: Partial<ConversationItemRow>,
): ConversationItemId[] {
  const ids = ctx.tx
    .select({ id: schema.conversationItems.id })
    .from(schema.conversationItems)
    .where(where)
    .orderBy(bySeq)
    .all()
    .map((row) => row.id);
  if (ids.length > 0)
    ctx.tx
      .update(schema.conversationItems)
      .set({ ...set, updatedAt: ctx.now })
      .where(where)
      .run();
  return ids;
}

/**
 * Marks delivered, once each, this conversation's items among `ids`; answers those marked now. An id
 * of another conversation, or one already delivered, is left as it is.
 */
export function markItemsDelivered(
  ctx: WriteContext,
  conversationId: ConversationId,
  ids: readonly ConversationItemId[],
): ConversationItemId[] {
  if (ids.length === 0) return [];
  return markWhere(
    ctx,
    and(
      ofConversation(conversationId),
      inArray(schema.conversationItems.id, [...ids]),
      isNull(schema.conversationItems.deliveredAt),
    ),
    { deliveredAt: ctx.now },
  );
}

/**
 * Hands back to 10db's queue this conversation's items among `ids` that a session was handed and
 * dropped untaken: no longer pushed, marked handed back, keeping every uuid they went under. Answers
 * those handed back; a delivered one, or another conversation's, is left.
 */
export function markItemsHandedBack(
  ctx: WriteContext,
  conversationId: ConversationId,
  ids: readonly ConversationItemId[],
): ConversationItemId[] {
  if (ids.length === 0) return [];
  return markWhere(
    ctx,
    and(
      ofConversation(conversationId),
      inArray(schema.conversationItems.id, [...ids]),
      isNotNull(schema.conversationItems.pushedAt),
      isNull(schema.conversationItems.deliveredAt),
    ),
    { pushedAt: null, handedBackAt: ctx.now },
  );
}

/**
 * Marks delivered, once each, this conversation's items pushed and not delivered that a session took:
 * one of the uuids each was pushed under is among `held`. Answers those marked, in `seq` order. An
 * item pushed under no uuid is never taken here.
 */
export function markItemsTakenUnder(
  ctx: WriteContext,
  conversationId: ConversationId,
  held: readonly string[],
): ConversationItemId[] {
  const holds = new Set(held);
  const taken = ctx.tx
    .select({ id: schema.conversationItems.id, pushUuids: schema.conversationItems.pushUuids })
    .from(schema.conversationItems)
    .where(
      and(
        ofConversation(conversationId),
        isNotNull(schema.conversationItems.pushedAt),
        isNull(schema.conversationItems.deliveredAt),
      ),
    )
    .orderBy(bySeq)
    .all()
    .filter((m) => m.pushUuids.some((uuid) => holds.has(uuid)))
    .map((m) => m.id);
  return markItemsDelivered(ctx, conversationId, taken);
}
