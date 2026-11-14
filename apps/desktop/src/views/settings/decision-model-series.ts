import {
  JudgeDecision,
  type DecisionModelDto,
  type DecisionStatsListDto,
  type JudgeConfig,
} from '@10db/contracts';

/** One decision model placed by what a million of its decisions cost and how long one takes. */
export interface DecisionModelPoint {
  readonly id: string;
  readonly name: string;
  readonly costPerMillionUsd: number;
  /** A free model has no place on a log axis, so it is drawn at `x`, not at its cost. */
  readonly free: boolean;
  readonly x: number;
  readonly secondsPerDecision: number;
  /** The decisions whose model this is. */
  readonly usedBy: readonly JudgeDecision[];
}

/** Where a free model sits when no model charges anything. */
const FREE_X_WITHOUT_PAID = 0.01;

/**
 * The models the Time and cost chart draws. A model with no cost or no time (or a time a log axis cannot place) is
 * left out and counted; a free one is drawn a quarter of the cheapest paid cost along, or at 0.01 with none paid,
 * at `freeX`, which the chart's tick names "Free".
 */
export function decisionModelSeries(
  models: readonly DecisionModelDto[],
  config: JudgeConfig,
): {
  readonly points: readonly DecisionModelPoint[];
  readonly omitted: number;
  readonly freeX: number | null;
} {
  const placed = models.flatMap((m) =>
    m.costPerMillionUsd === null || m.secondsPerDecision === null || m.secondsPerDecision <= 0
      ? []
      : [{ model: m, cost: m.costPerMillionUsd, seconds: m.secondsPerDecision }],
  );
  const paid = placed.map((p) => p.cost).filter((c) => c > 0);
  const anyFree = placed.some((p) => p.cost === 0);
  const freeX = anyFree ? (paid.length === 0 ? FREE_X_WITHOUT_PAID : Math.min(...paid) / 4) : null;
  const decisions = Object.values(JudgeDecision).filter((d) => d in config.decisions);
  const points = placed.map(({ model, cost, seconds }): DecisionModelPoint => {
    const free = cost === 0;
    return {
      id: model.id,
      name: model.name,
      costPerMillionUsd: cost,
      free,
      x: free && freeX !== null ? freeX : cost,
      secondsPerDecision: seconds,
      usedBy: decisions.filter((d) => config.decisions[d].model === model.id),
    };
  });
  return { points, omitted: models.length - placed.length, freeX };
}

/** How many answers each model gave across the decisions in the stats. */
export function answersByModel(stats: DecisionStatsListDto): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const decision of stats.decisions)
    for (const answer of decision.answers)
      counts.set(answer.model, (counts.get(answer.model) ?? 0) + 1);
  return counts;
}
