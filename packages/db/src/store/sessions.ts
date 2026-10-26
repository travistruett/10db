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
  type WorkstreamId,
} from '@10db/contracts';
import { and, asc, count, desc, eq, isNull, sql } from 'drizzle-orm';
import * as schema from '../schema';
import { getAccountRow } from './accounts';
import type { DbReader, WriteContext } from './store';

export type SessionRow = typeof schema.sessions.$inferSelect;

export interface NewSession {
  readonly workstreamId: WorkstreamId;
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

function projectOwner(ctx: WriteContext, workstreamId: WorkstreamId) {
  const owner = ctx.tx
    .select({ accountId: schema.projects.accountId, kind: schema.accounts.kind })
    .from(schema.workstreams)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.workstreams.projectId))
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.projects.accountId))
    .where(eq(schema.workstreams.id, workstreamId))
    .get();
  if (!owner) throw new NotFoundError('workstream', workstreamId);
  return owner;
}

export function insertSession(ctx: WriteContext, input: NewSession): SessionRow {
  const prior = ctx.tx
    .select({ n: count() })
    .from(schema.sessions)
    .where(eq(schema.sessions.workstreamId, input.workstreamId))
    .get();
  // A project can move while a session waits for its start, so the runner names the account it launched on.
  const owner =
    input.accountId === undefined
      ? projectOwner(ctx, input.workstreamId)
      : { accountId: input.accountId, kind: getAccountRow(ctx.tx, input.accountId).kind };
  const row: SessionRow = {
    id: mintId('Session'),
    ...input,
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
