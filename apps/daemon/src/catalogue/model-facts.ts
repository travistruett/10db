import {
  AccountKind,
  ModelSource,
  type ModelEffortDto,
  type ModelProfileDto,
} from '@10db/contracts';
import { OpenRouterMeasureKind, type OpenRouterMeasure } from '@10db/db';

/** A speed row older than this, on the injected clock, is ignored. */
export const SPEED_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * The OpenRouter provider an account's own runs are served by, whose p50 speed describes the account. A gateway
 * or an OpenRouter account has no single provider.
 */
export function speedProviderFor(kind: AccountKind): string | null {
  switch (kind) {
    case AccountKind.ClaudeSubscription:
    case AccountKind.AnthropicApiKey:
      return 'Anthropic';
    case AccountKind.Bedrock:
      return 'Amazon Bedrock';
    case AccountKind.CodexSignin:
    case AccountKind.OpenaiApiKey:
      return 'OpenAI';
    case AccountKind.Gateway:
    case AccountKind.OpenRouter:
      return null;
  }
}

function median(values: readonly number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const high = sorted[mid];
  if (high === undefined) return null;
  const low = sorted[mid - 1];
  return sorted.length % 2 === 1 || low === undefined ? high : (low + high) / 2;
}

/** The median p50 latency across a model's providers' fresh speed rows that have one; null when none does. */
export function openRouterLatencyMs(rows: readonly OpenRouterMeasure[], now: Date): number | null {
  return median(
    rows.flatMap((m) =>
      m.kind === OpenRouterMeasureKind.Speed &&
      m.latencyMs !== null &&
      m.latencyMs > 0 &&
      now.getTime() - Date.parse(m.measuredAt) <= SPEED_STALE_MS
        ? [m.latencyMs]
        : [],
    ),
  );
}

export interface ModelSpeed {
  readonly tokensPerSecond: number | null;
  readonly source: ModelSource | null;
  readonly provider: string | null;
}

/**
 * A model's speed, which is the model's and not an effort's: the p50 on the account's provider, else the median
 * of the fresh providers that have one, else Artificial Analysis's. A provider without a throughput is skipped,
 * never read as zero.
 */
export function modelSpeed(input: {
  readonly openRouter: readonly OpenRouterMeasure[];
  readonly provider: string | null;
  readonly aaSpeed: number | null;
  readonly now: Date;
}): ModelSpeed {
  const fresh = input.openRouter.filter(
    (m) =>
      m.kind === OpenRouterMeasureKind.Speed &&
      m.tokensPerSecond !== null &&
      m.tokensPerSecond > 0 &&
      input.now.getTime() - Date.parse(m.measuredAt) <= SPEED_STALE_MS,
  );
  const own = input.provider === null ? undefined : fresh.find((m) => m.key === input.provider);
  if (own?.tokensPerSecond != null)
    return {
      tokensPerSecond: own.tokensPerSecond,
      source: ModelSource.OpenRouter,
      provider: input.provider,
    };
  const middle = median(
    fresh.flatMap((m) => (m.tokensPerSecond === null ? [] : [m.tokensPerSecond])),
  );
  if (middle !== null)
    return { tokensPerSecond: middle, source: ModelSource.OpenRouter, provider: null };
  return {
    tokensPerSecond: input.aaSpeed,
    source: input.aaSpeed === null ? null : ModelSource.Aa,
    provider: null,
  };
}

type EffortFacts = Pick<
  ModelEffortDto,
  | 'intelligence'
  | 'coding'
  | 'agentic'
  | 'costPerTaskUsd'
  | 'outputTokensPerSecond'
  | 'sources'
  | 'speedProvider'
>;

/** The first non-null of a score across OpenRouter's relayed Artificial Analysis rows. */
function relayed(
  rows: readonly OpenRouterMeasure[],
  field: 'intelligence' | 'coding' | 'agentic',
): number | null {
  for (const row of rows)
    if (row.kind === OpenRouterMeasureKind.ScoreAa && row[field] !== null) return row[field];
  return null;
}

/**
 * Each figure of one effort and where it came from. A score comes from Artificial Analysis for that effort, else
 * from Artificial Analysis through OpenRouter on the model's Max effort alone; cost per task comes from
 * Artificial Analysis alone (the profile's, already scaled to the account), and speed from `modelSpeed`.
 */
export function effortFacts(input: {
  readonly aa: ModelProfileDto;
  readonly isMax: boolean;
  readonly openRouter: readonly OpenRouterMeasure[];
  readonly provider: string | null;
  readonly now: Date;
  /** The profile's cost per task as the account is charged, which only Artificial Analysis supplies. */
  readonly costPerTaskUsd: number | null;
}): EffortFacts {
  const { aa, isMax } = input;
  const score = (own: number | null, field: 'intelligence' | 'coding' | 'agentic') => {
    if (own !== null) return { value: own, source: ModelSource.Aa };
    const other = isMax ? relayed(input.openRouter, field) : null;
    return other === null
      ? { value: null, source: null }
      : { value: other, source: ModelSource.AaViaOpenRouter };
  };
  const intelligence = score(aa.scores.intelligence, 'intelligence');
  // Artificial Analysis's own Coding and Agentic scores are not held on a profile.
  const coding = score(null, 'coding');
  const agentic = score(null, 'agentic');
  const speed = modelSpeed({
    openRouter: input.openRouter,
    provider: input.provider,
    aaSpeed: aa.outputTokensPerSecond,
    now: input.now,
  });
  return {
    intelligence: intelligence.value,
    coding: coding.value,
    agentic: agentic.value,
    costPerTaskUsd: input.costPerTaskUsd,
    outputTokensPerSecond: speed.tokensPerSecond,
    sources: {
      intelligence: intelligence.source,
      coding: coding.source,
      agentic: agentic.source,
      costPerTask: input.costPerTaskUsd === null ? null : ModelSource.Aa,
      speed: speed.source,
    },
    speedProvider: speed.provider,
  };
}
