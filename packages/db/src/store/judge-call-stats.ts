import { JudgeOutcome } from '@10db/contracts';
import { and, gte, inArray } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader } from './store';

/** What a model's answered calls came to. */
export interface JudgeCallModelStat {
  readonly model: string;
  readonly calls: number;
  /** Calls that logged a cost; a model OpenRouter does not charge for logs none. */
  readonly costedCalls: number;
  readonly totalCostUsd: number;
  /** The median latency of the calls that logged one; null when none did. */
  readonly medianLatencyMs: number | null;
}

/** The outcomes of a call that got an answer; a fallback or a cut-short call has none. */
const ANSWERED = [JudgeOutcome.Acted, JudgeOutcome.BelowFloor, JudgeOutcome.Shadow];

function median(values: readonly number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const high = sorted[mid];
  if (high === undefined) return null;
  const low = sorted[mid - 1];
  return sorted.length % 2 === 1 || low === undefined ? high : (low + high) / 2;
}

/** Each model's answered calls logged at or after `since`, by model. */
export function judgeCallModelStats(db: DbReader, since: string): JudgeCallModelStat[] {
  const rows = db
    .select({
      model: schema.judgeCalls.model,
      latencyMs: schema.judgeCalls.latencyMs,
      costUsd: schema.judgeCalls.costUsd,
    })
    .from(schema.judgeCalls)
    .where(
      and(gte(schema.judgeCalls.createdAt, since), inArray(schema.judgeCalls.outcome, ANSWERED)),
    )
    .all();
  const byModel = new Map<string, typeof rows>();
  for (const row of rows) byModel.set(row.model, [...(byModel.get(row.model) ?? []), row]);
  return [...byModel.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([model, calls]) => {
      const costs = calls.flatMap((c) => (c.costUsd === null ? [] : [c.costUsd]));
      return {
        model,
        calls: calls.length,
        costedCalls: costs.length,
        totalCostUsd: costs.reduce((sum, c) => sum + c, 0),
        medianLatencyMs: median(calls.flatMap((c) => (c.latencyMs === null ? [] : [c.latencyMs]))),
      };
    });
}
