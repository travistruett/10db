import {
  EventType,
  mintId,
  NotFoundError,
  type AccountId,
  type ConversationId,
  type ConversationOwnerKind,
  type ConversationProfile,
  type ConversationState,
  type ProjectId,
} from '@10db/contracts';
import { and, eq } from 'drizzle-orm';
import * as schema from '../schema';
import { getProject } from './projects';
import type { DbReader, WriteContext } from './store';

// Sessions spec §9.1. A conversation's own row: its owner, the account and model its sessions run on,
// the agent session the next one resumes, and an explore conversation's state.

export type ConversationRow = typeof schema.conversations.$inferSelect;

/** What a conversation belongs to: a ShapeId, TaskId or ChatId, by `kind`. */
export interface ConversationOwner {
  readonly kind: ConversationOwnerKind;
  readonly id: string;
}

/** A new conversation, in the caller's write; its account is the project's unless one is named. */
export function insertConversation(
  ctx: WriteContext,
  input: {
    readonly projectId: ProjectId;
    readonly owner: ConversationOwner;
    readonly profile: ConversationProfile;
    readonly state: ConversationState | null;
    readonly accountId?: AccountId;
  },
): ConversationRow {
  const row: ConversationRow = {
    id: mintId('Conversation'),
    projectId: input.projectId,
    ownerKind: input.owner.kind,
    ownerId: input.owner.id,
    profile: input.profile,
    accountId: input.accountId ?? getProject(ctx.tx, input.projectId).accountId,
    model: null,
    effort: null,
    providerSessionId: null,
    state: input.state,
    contextPct: null,
    commands: null,
    nextSeq: 1,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.conversations).values(row).run();
  return row;
}

export function getConversation(db: DbReader, id: ConversationId): ConversationRow {
  const row = db.select().from(schema.conversations).where(eq(schema.conversations.id, id)).get();
  if (!row) throw new NotFoundError('conversation', id);
  return row;
}

/** The owner's conversation, or null while it has none. */
export function conversationOf(db: DbReader, owner: ConversationOwner): ConversationRow | null {
  return (
    db
      .select()
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.ownerKind, owner.kind),
          eq(schema.conversations.ownerId, owner.id),
        ),
      )
      .get() ?? null
  );
}

/** Every conversation of a profile: the explore ones, which the engine recovers at a start. */
export function listConversationsOfProfile(
  db: DbReader,
  profile: ConversationProfile,
): ConversationRow[] {
  return db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.profile, profile))
    .all();
}

export function patchConversation(
  ctx: WriteContext,
  id: ConversationId,
  patch: Partial<
    Pick<
      ConversationRow,
      'model' | 'effort' | 'providerSessionId' | 'state' | 'contextPct' | 'accountId' | 'commands'
    >
  >,
): ConversationRow {
  const before = getConversation(ctx.tx, id);
  ctx.tx
    .update(schema.conversations)
    .set({ ...patch, updatedAt: ctx.now })
    .where(eq(schema.conversations.id, id))
    .run();
  if (patch.state !== undefined && patch.state !== before.state)
    ctx.emit({
      type: EventType.ConversationState,
      entityType: 'conversation',
      entityId: id,
      data: { state: patch.state },
    });
  return getConversation(ctx.tx, id);
}
