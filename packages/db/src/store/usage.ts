import { isMetered, type AccountId, type AccountUsageDto, type UsageTotals } from '@10db/contracts';
import { and, asc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import * as schema from '../schema';
import { getAccountRow } from './accounts';
import { getJudgeConfig } from './judge-config';
import type { DbReader } from './store';

/** A calendar month as ISO instants: `start` inclusive, `end` exclusive. The daemon computes it in local time. */
export interface UsageWindow {
  readonly month: string;
  readonly start: string;
  readonly end: string;
}

/** Sessions on the account that started in the window (accounts spec §6: usage is a query, not a ledger). */
function inWindow(id: AccountId, window: UsageWindow) {
  return and(
    eq(schema.sessions.accountId, id),
    gte(schema.sessions.startedAt, window.start),
    lt(schema.sessions.startedAt, window.end),
  );
}

export function accountSpendUsd(db: DbReader, id: AccountId, window: UsageWindow): number {
  const row = db
    .select({ total: sql<number | null>`sum(${schema.sessions.costUsd})` })
    .from(schema.sessions)
    .where(inWindow(id, window))
    .get();
  return (row?.total ?? 0) + decisionSpendUsd(db, id, window);
}

/**
 * The dollars of the decisions made on the account in the window: the judge's call log, kept 30 days. A call
 * records no account, so only the account decisions run on has a figure; any other account is 0.
 */
function decisionSpendUsd(db: DbReader, id: AccountId, window: UsageWindow): number {
  if (getJudgeConfig(db).accountId !== id) return 0;
  const row = db
    .select({ total: sql<number | null>`sum(${schema.judgeCalls.costUsd})` })
    .from(schema.judgeCalls)
    .where(
      and(
        gte(schema.judgeCalls.createdAt, window.start),
        lt(schema.judgeCalls.createdAt, window.end),
      ),
    )
    .get();
  return row?.total ?? 0;
}

export function accountUsage(db: DbReader, id: AccountId, window: UsageWindow): AccountUsageDto {
  const account = getAccountRow(db, id);
  const metered = isMetered(account.kind);
  const rows = db
    .select({
      projectId: schema.projects.id,
      projectName: schema.projects.name,
      tokensIn: sql<number>`coalesce(sum(${schema.sessions.inputTokens}), 0)`,
      tokensOut: sql<number>`coalesce(sum(${schema.sessions.outputTokens}), 0)`,
      tokensCached: sql<number>`coalesce(sum(${schema.sessions.cachedTokens}), 0)`,
      costUsd: sql<number | null>`sum(${schema.sessions.costUsd})`,
    })
    .from(schema.sessions)
    // A session works for a project through its workstream (a lane) or its conversation (Plan); a
    // lane that names both is one row, counted once, under its workstream's project.
    .leftJoin(schema.workstreams, eq(schema.workstreams.id, schema.sessions.workstreamId))
    .leftJoin(schema.conversations, eq(schema.conversations.id, schema.sessions.conversationId))
    .innerJoin(
      schema.projects,
      eq(
        schema.projects.id,
        sql`coalesce(${schema.workstreams.projectId}, ${schema.conversations.projectId})`,
      ),
    )
    .where(inWindow(id, window))
    .groupBy(schema.projects.id)
    .orderBy(asc(schema.projects.name))
    .all();
  const byProject = rows.map((r) => ({ ...r, costUsd: metered ? (r.costUsd ?? 0) : null }));
  const zero: UsageTotals = {
    tokensIn: 0,
    tokensOut: 0,
    tokensCached: 0,
    costUsd: metered ? 0 : null,
  };
  // A session whose plan was deleted has neither a workstream nor a conversation, so no project; it
  // still counts in the account's total, which is the sum of the projects' rows and this one.
  const unplaced = db
    .select({
      tokensIn: sql<number>`coalesce(sum(${schema.sessions.inputTokens}), 0)`,
      tokensOut: sql<number>`coalesce(sum(${schema.sessions.outputTokens}), 0)`,
      tokensCached: sql<number>`coalesce(sum(${schema.sessions.cachedTokens}), 0)`,
      costUsd: sql<number | null>`sum(${schema.sessions.costUsd})`,
    })
    .from(schema.sessions)
    .where(
      and(
        inWindow(id, window),
        isNull(schema.sessions.workstreamId),
        isNull(schema.sessions.conversationId),
      ),
    )
    .get();
  const total = [
    ...byProject,
    ...(unplaced ? [{ ...unplaced, costUsd: metered ? (unplaced.costUsd ?? 0) : null }] : []),
  ].reduce<UsageTotals>(
    (sum, r) => ({
      tokensIn: sum.tokensIn + r.tokensIn,
      tokensOut: sum.tokensOut + r.tokensOut,
      tokensCached: sum.tokensCached + r.tokensCached,
      costUsd: sum.costUsd === null || r.costUsd === null ? null : sum.costUsd + r.costUsd,
    }),
    zero,
  );
  // Decisions are not a project's: they join the account's total, and no project's row.
  const spent = total.costUsd === null ? null : total.costUsd + decisionSpendUsd(db, id, window);
  return {
    accountId: id,
    month: window.month,
    total: { ...total, costUsd: spent },
    monthlyCapUsd: account.monthlyCapUsd,
    byProject,
  };
}
