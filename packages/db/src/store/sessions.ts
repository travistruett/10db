import {
  EventType,
  mintId,
  NotFoundError,
  type Effort,
  type Provider,
  type SessionId,
  type SessionMode,
  type WorkstreamId,
} from '@10db/contracts';
import { and, asc, count, desc, eq, isNull } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

export type SessionRow = typeof schema.sessions.$inferSelect;

export interface NewSession {
  readonly workstreamId: WorkstreamId;
  readonly provider: Provider;
  readonly model: string;
  readonly effort: Effort;
  readonly mode: SessionMode;
  readonly mcpTokenHash: string;
  /** Copied from the session a resumed session continues; see `sessions.briefingBaselinePct`. */
  readonly briefingBaselinePct?: number | null;
}

export function insertSession(ctx: WriteContext, input: NewSession): SessionRow {
  const prior = ctx.tx
    .select({ n: count() })
    .from(schema.sessions)
    .where(eq(schema.sessions.workstreamId, input.workstreamId))
    .get();
  const row: SessionRow = {
    id: mintId('Session'),
    ...input,
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
    costUsd: 0,
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
      'inputTokens' | 'outputTokens' | 'costUsd' | 'contextPct' | 'briefingBaselinePct'
    >
  >,
): void {
  ctx.tx
    .update(schema.sessions)
    .set({ ...patch, updatedAt: ctx.now })
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
