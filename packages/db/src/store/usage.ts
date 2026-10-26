import { isMetered, type AccountId, type AccountUsageDto, type UsageTotals } from '@10db/contracts';
import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import * as schema from '../schema';
import { getAccountRow } from './accounts';
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
    .innerJoin(schema.workstreams, eq(schema.workstreams.id, schema.sessions.workstreamId))
    .innerJoin(schema.projects, eq(schema.projects.id, schema.workstreams.projectId))
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
  const total = byProject.reduce<UsageTotals>(
    (sum, r) => ({
      tokensIn: sum.tokensIn + r.tokensIn,
      tokensOut: sum.tokensOut + r.tokensOut,
      tokensCached: sum.tokensCached + r.tokensCached,
      costUsd: sum.costUsd === null || r.costUsd === null ? null : sum.costUsd + r.costUsd,
    }),
    zero,
  );
  return {
    accountId: id,
    month: window.month,
    total,
    monthlyCapUsd: account.monthlyCapUsd,
    byProject,
  };
}
