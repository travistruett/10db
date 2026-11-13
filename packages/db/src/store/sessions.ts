import {
  EventType,
  isMetered,
  mintId,
  NotFoundError,
  type AccountId,
  type Effort,
  type Provider,
  type SessionId,
  type SessionMode,
  ConversationOwnerKind,
  ShapeId,
  type ConversationId,
  type WorkstreamId,
} from '@10db/contracts';
import { and, asc, count, desc, eq, isNull, sql } from 'drizzle-orm';
import * as schema from '../schema';
import { getAccountRow } from './accounts';
import { getConversation } from './conversations';
import type { DbReader, WriteContext } from './store';

export type SessionRow = typeof schema.sessions.$inferSelect;

/** A lane's session: the session runs its workstream. */
export type LaneSessionRow = SessionRow & { readonly workstreamId: WorkstreamId };

/** Whether the session runs a lane's workstream, rather than only a conversation. */
export function isLaneSession(row: SessionRow): row is LaneSessionRow {
  return row.workstreamId !== null;
}

/**
 * A session is inserted for a workstream (a lane) or for a conversation (Plan's). A lane of a task
 * with a thread also names its task's conversation, which is set apart from the insert.
 */
type SessionOwner =
  | { readonly workstreamId: WorkstreamId; readonly conversationId?: undefined }
  | { readonly conversationId: ConversationId; readonly workstreamId?: undefined };

export type NewSession = SessionOwner & NewSessionFields;

interface NewSessionFields {
  readonly provider: Provider;
  readonly model: string;
  readonly effort: Effort;
  readonly mode: SessionMode;
  readonly mcpTokenHash: string;
  /** See `sessions.briefed`; a resumed session copies it from the session it continues. */
  readonly briefed?: boolean;
  /** Copied from the session a resumed session continues; see `sessions.briefingBaselinePct`. */
  readonly briefingBaselinePct?: number | null;
  /** The account the session launches on; absent, the project's current account. */
  readonly accountId?: AccountId;
}

/** The account of the project the session works for: through its workstream, or its conversation. */
function projectOwner(ctx: WriteContext, input: SessionOwner) {
  const columns = { accountId: schema.projects.accountId, kind: schema.accounts.kind };
  if (input.workstreamId !== undefined) {
    const owner = ctx.tx
      .select(columns)
      .from(schema.workstreams)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.workstreams.projectId))
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.projects.accountId))
      .where(eq(schema.workstreams.id, input.workstreamId))
      .get();
    if (!owner) throw new NotFoundError('workstream', input.workstreamId);
    return owner;
  }
  const owner = ctx.tx
    .select(columns)
    .from(schema.conversations)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.conversations.projectId))
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.projects.accountId))
    .where(eq(schema.conversations.id, input.conversationId))
    .get();
  if (!owner) throw new NotFoundError('conversation', input.conversationId);
  return owner;
}

/** The shape whose conversation the session runs; null for a session of no Plan conversation. */
export function sessionShapeId(db: DbReader, row: SessionRow): ShapeId | null {
  if (row.conversationId === null) return null;
  const conversation = getConversation(db, row.conversationId);
  // The owner id of a shape's conversation is a ShapeId; parsed, as text read from the database.
  return conversation.ownerKind === ConversationOwnerKind.Shape
    ? ShapeId.parse(conversation.ownerId)
    : null;
}

export function insertSession(ctx: WriteContext, input: NewSession): SessionRow {
  const { workstreamId, conversationId, ...fields } = input;
  const prior = ctx.tx
    .select({ n: count() })
    .from(schema.sessions)
    .where(
      workstreamId !== undefined
        ? eq(schema.sessions.workstreamId, workstreamId)
        : eq(schema.sessions.conversationId, conversationId),
    )
    .get();
  // A project can move while a session waits for its start, so the runner names the account it launched on.
  const owner =
    input.accountId === undefined
      ? projectOwner(ctx, input)
      : { accountId: input.accountId, kind: getAccountRow(ctx.tx, input.accountId).kind };
  const row: SessionRow = {
    id: mintId('Session'),
    ...fields,
    workstreamId: workstreamId ?? null,
    conversationId: conversationId ?? null,
    accountId: owner.accountId,
    briefed: input.briefed ?? false,
    briefingBaselinePct: input.briefingBaselinePct ?? null,
    sequence: (prior?.n ?? 0) + 1,
    providerSessionId: null,
    pid: null,
    pidStart: null,
    startedAt: ctx.now,
    endedAt: null,
    exitReason: null,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    // A subscription's dollars are not real money, so its cost stays null.
    costUsd: isMetered(owner.kind) ? 0 : null,
    contextPct: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.sessions).values(row).run();
  return row;
}

/** `pidStart` is the OS start time of `pid`; recovery signals the pid only while it still matches. */
export function markSessionStarted(
  ctx: WriteContext,
  id: SessionId,
  providerSessionId: string,
  pid: number | null,
  pidStart: string | null = null,
): void {
  ctx.tx
    .update(schema.sessions)
    .set({ providerSessionId, pid, pidStart, updatedAt: ctx.now })
    .where(eq(schema.sessions.id, id))
    .run();
  ctx.emit({
    type: EventType.SessionStarted,
    entityType: 'session',
    entityId: id,
    data: { providerSessionId },
  });
}

export function updateSessionUsage(
  ctx: WriteContext,
  id: SessionId,
  patch: Partial<
    Pick<
      SessionRow,
      'inputTokens' | 'outputTokens' | 'cachedTokens' | 'contextPct' | 'briefingBaselinePct'
    >
  > & { readonly costUsd?: number },
): void {
  const { costUsd, ...rest } = patch;
  ctx.tx
    .update(schema.sessions)
    .set({
      ...rest,
      // The cost never lands on a session whose cost is null (a subscription).
      ...(costUsd === undefined
        ? {}
        : {
            costUsd: sql`case when ${schema.sessions.costUsd} is null then null else ${costUsd} end`,
          }),
      updatedAt: ctx.now,
    })
    .where(eq(schema.sessions.id, id))
    .run();
}

export function endSession(ctx: WriteContext, id: SessionId, exitReason: string): void {
  const result = ctx.tx
    .update(schema.sessions)
    .set({ endedAt: ctx.now, exitReason, updatedAt: ctx.now })
    .where(and(eq(schema.sessions.id, id), isNull(schema.sessions.endedAt)))
    .run();
  if (result.changes > 0)
    ctx.emit({
      type: EventType.SessionEnded,
      entityType: 'session',
      entityId: id,
      data: { exitReason },
    });
}

export function getSession(db: DbReader, id: SessionId): SessionRow {
  const row = db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get();
  if (!row) throw new NotFoundError('session', id);
  return row;
}

/** The session an MCP token belongs to, if that session is still live. */
export function getLiveSessionByTokenHash(db: DbReader, hash: string): SessionRow | undefined {
  return db
    .select()
    .from(schema.sessions)
    .where(and(eq(schema.sessions.mcpTokenHash, hash), isNull(schema.sessions.endedAt)))
    .get();
}

/** The latest session of the workstream that ran the provider conversation `providerSessionId`. */
export function getSessionByProviderId(
  db: DbReader,
  workstreamId: WorkstreamId,
  providerSessionId: string,
): SessionRow | undefined {
  return db
    .select()
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.workstreamId, workstreamId),
        eq(schema.sessions.providerSessionId, providerSessionId),
      ),
    )
    .orderBy(desc(schema.sessions.sequence))
    .get();
}

export function listSessions(db: DbReader, workstreamId: WorkstreamId): SessionRow[] {
  return db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.workstreamId, workstreamId))
    .orderBy(asc(schema.sessions.sequence))
    .all();
}
