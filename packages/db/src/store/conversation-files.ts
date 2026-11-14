import {
  mintId,
  NotFoundError,
  type ConversationFileId,
  type ConversationId,
  type ConversationItemId,
} from '@10db/contracts';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

// Sessions spec §9.1. A conversation's files: a Plan file belongs to the conversation, a pasted picture
// to its message. They list by `created_at`, then id, since a migrated file keeps its older id.

export type ConversationFileRow = typeof schema.conversationFiles.$inferSelect;

/** A file already kept on disk, at `storedPath`; `sha256` is null where the owner never hashed one. */
export interface NewConversationFile {
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string | null;
  readonly storedPath: string;
}

const order = [asc(schema.conversationFiles.createdAt), asc(schema.conversationFiles.id)];

/** The files' rows, in the caller's write. */
export function insertFiles(
  ctx: WriteContext,
  conversationId: ConversationId,
  itemId: ConversationItemId | null,
  files: readonly NewConversationFile[],
): ConversationFileRow[] {
  const rows = files.map((file): ConversationFileRow => ({
    id: mintId('ConversationFile'),
    conversationId,
    itemId,
    ...file,
    inlineSent: false,
    toldAt: null,
    unreadableToldAt: null,
    createdAt: ctx.now,
  }));
  if (rows.length > 0) ctx.tx.insert(schema.conversationFiles).values(rows).run();
  return rows;
}

/** The conversation's files, oldest first. */
export function listFiles(db: DbReader, conversationId: ConversationId): ConversationFileRow[] {
  return db
    .select()
    .from(schema.conversationFiles)
    .where(eq(schema.conversationFiles.conversationId, conversationId))
    .orderBy(...order)
    .all();
}

/** The files of these items, oldest first. */
export function listItemFiles(
  db: DbReader,
  itemIds: readonly ConversationItemId[],
): ConversationFileRow[] {
  if (itemIds.length === 0) return [];
  return db
    .select()
    .from(schema.conversationFiles)
    .where(inArray(schema.conversationFiles.itemId, [...itemIds]))
    .orderBy(...order)
    .all();
}

export function getFile(db: DbReader, id: ConversationFileId): ConversationFileRow {
  const row = db
    .select()
    .from(schema.conversationFiles)
    .where(eq(schema.conversationFiles.id, id))
    .get();
  if (!row) throw new NotFoundError('conversation file', id);
  return row;
}

/**
 * Marks the files a session was sent as image blocks. A `fresh` session holds no earlier block, so it
 * first clears the conversation's other marks: the marks say what the live session's history holds.
 */
export function markFilesInline(
  ctx: WriteContext,
  conversationId: ConversationId,
  ids: readonly ConversationFileId[],
  fresh: boolean,
): void {
  const ofConversation = eq(schema.conversationFiles.conversationId, conversationId);
  if (fresh)
    ctx.tx.update(schema.conversationFiles).set({ inlineSent: false }).where(ofConversation).run();
  if (ids.length === 0) return;
  ctx.tx
    .update(schema.conversationFiles)
    .set({ inlineSent: true })
    .where(and(ofConversation, inArray(schema.conversationFiles.id, [...ids])))
    .run();
}

/** Records that a turn carried these files to the agent; one already told keeps its first time. */
export function markFilesTold(ctx: WriteContext, ids: readonly ConversationFileId[]): void {
  if (ids.length === 0) return;
  ctx.tx
    .update(schema.conversationFiles)
    .set({ toldAt: ctx.now })
    .where(
      and(inArray(schema.conversationFiles.id, [...ids]), isNull(schema.conversationFiles.toldAt)),
    )
    .run();
}

/** Records that a notice named these images as unreadable; one already named keeps its first time. */
export function markFilesUnreadableTold(
  ctx: WriteContext,
  ids: readonly ConversationFileId[],
): void {
  if (ids.length === 0) return;
  ctx.tx
    .update(schema.conversationFiles)
    .set({ unreadableToldAt: ctx.now })
    .where(
      and(
        inArray(schema.conversationFiles.id, [...ids]),
        isNull(schema.conversationFiles.unreadableToldAt),
      ),
    )
    .run();
}

/** The conversation's files no turn has carried to the agent yet, oldest first. */
export function listUntoldFiles(
  db: DbReader,
  conversationId: ConversationId,
): ConversationFileRow[] {
  return db
    .select()
    .from(schema.conversationFiles)
    .where(
      and(
        eq(schema.conversationFiles.conversationId, conversationId),
        isNull(schema.conversationFiles.toldAt),
      ),
    )
    .orderBy(...order)
    .all();
}
