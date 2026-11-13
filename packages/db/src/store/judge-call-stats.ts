import { JudgeDecision, JudgeOutcome, type DecisionStatsDto } from '@10db/contracts';
import { and, asc, gte, inArray } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader } from './store';

/** What a model's answered calls came to. */
export interface JudgeCallModelStat {
  readonly model: string;
  readonly calls: number;
  /** Calls that logged a cost; a call on a model OpenRouter does not charge for may log none. */
  readonly costedCalls: number;
  readonly totalCostUsd: number;
  /** The median latency of the calls that logged one; null when none did. */
  readonly medianLatencyMs: number | null;
}

/** The outcomes of a call that got an answer; a fallback or a cut-short call has none. */
const ANSWERED: readonly JudgeOutcome[] = [
  JudgeOutcome.Acted,
  JudgeOutcome.BelowFloor,
  JudgeOutcome.Shadow,
];

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
      and(
        gte(schema.judgeCalls.createdAt, since),
        inArray(schema.judgeCalls.outcome, [...ANSWERED]),
      ),
    )
    .all();
  const byModel = new Map<string, typeof rows>();
  for (const row of rows) {
    const own = byModel.get(row.model);
    if (own) own.push(row);
    else byModel.set(row.model, [row]);
  }
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

/**
 * What each decision's calls since `since` came to, for the decisions that have any. `calls` counts every call;
 * a stopped call is counted apart from the fallbacks, since nothing failed. Cost sums every logged cost, and the
 * median latency and the answers come from the calls that got an answer, so a timeout does not stretch them.
 */
export function judgeDecisionStats(db: DbReader, since: string): DecisionStatsDto[] {
  const rows = db
    .select({
      decision: schema.judgeCalls.decision,
      model: schema.judgeCalls.model,
      outcome: schema.judgeCalls.outcome,
      confidence: schema.judgeCalls.confidence,
      latencyMs: schema.judgeCalls.latencyMs,
      costUsd: schema.judgeCalls.costUsd,
    })
    .from(schema.judgeCalls)
    .where(gte(schema.judgeCalls.createdAt, since))
    .orderBy(asc(schema.judgeCalls.createdAt), asc(schema.judgeCalls.id))
    .all();
  return Object.values(JudgeDecision).flatMap((decision) => {
    const own = rows.filter((r) => r.decision === decision);
    if (own.length === 0) return [];
    const count = (outcome: JudgeOutcome): number =>
      own.filter((r) => r.outcome === outcome).length;
    const answered = own.filter((r) => ANSWERED.includes(r.outcome));
    return [
      {
        decision,
        calls: own.length,
        acted: count(JudgeOutcome.Acted),
        belowFloor: count(JudgeOutcome.BelowFloor),
        shadow: count(JudgeOutcome.Shadow),
        stopped: count(JudgeOutcome.Stopped),
        fallbacks: {
          off: count(JudgeOutcome.FallbackOff),
          no_key: count(JudgeOutcome.FallbackNoKey),
          timeout: count(JudgeOutcome.FallbackTimeout),
          error: count(JudgeOutcome.FallbackError),
        },
        costUsd: own.reduce((sum, r) => sum + (r.costUsd ?? 0), 0),
        medianLatencyMs: median(
          answered.flatMap((r) => (r.latencyMs === null ? [] : [r.latencyMs])),
        ),
        answers: answered.flatMap((r) =>
          r.confidence === null ? [] : [{ model: r.model, confidence: r.confidence }],
        ),
      },
    ];
  });
}
