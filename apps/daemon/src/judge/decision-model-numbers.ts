import { DecisionNumberSource, type DecisionModelDto } from '@10db/contracts';
import type { JudgeCallModelStat } from '@10db/db';

/** The size of a decision, in input tokens, assumed when the builder's own calls cannot say. */
export const TYPICAL_TOKENS_FALLBACK = 300;

/**
 * The input tokens of a typical decision: as this builder's calls show them, the cost logged over the price of
 * a token, summed over the models that charge and logged a cost; else a fixed guess, said to be assumed. A model
 * priced at nothing says nothing about size, and is skipped rather than divided by.
 */
export function typicalDecisionTokens(
  stats: readonly JudgeCallModelStat[],
  inputPricePerMillion: (model: string) => number | null,
): { readonly tokens: number; readonly assumed: boolean } {
  let cost = 0;
  let pricedTokensWorth = 0;
  for (const stat of stats) {
    const price = inputPricePerMillion(stat.model);
    if (price === null || price <= 0 || stat.costedCalls === 0) continue;
    cost += stat.totalCostUsd;
    pricedTokensWorth += (price / 1_000_000) * stat.costedCalls;
  }
  return pricedTokensWorth > 0 && cost > 0
    ? { tokens: cost / pricedTokensWorth, assumed: false }
    : { tokens: TYPICAL_TOKENS_FALLBACK, assumed: true };
}

/**
 * What a decision model costs per million decisions and takes per decision, each with where it comes from.
 * Cost is the builder's own mean logged cost when the model has costed calls, else its input price over a
 * typical decision's tokens. Time is the builder's median latency, else OpenRouter's, else unknown.
 */
export function decisionModelNumbers(
  model: Pick<DecisionModelDto, 'inputUsdPerMillion'>,
  stat: JudgeCallModelStat | undefined,
  typicalTokens: number,
  openRouterLatencyMs: number | null,
  tokensAreFallback: boolean,
): Pick<
  DecisionModelDto,
  'costPerMillionUsd' | 'costSource' | 'secondsPerDecision' | 'timeSource'
> {
  const cost =
    stat !== undefined && stat.costedCalls > 0
      ? {
          costPerMillionUsd: (stat.totalCostUsd / stat.costedCalls) * 1_000_000,
          costSource: DecisionNumberSource.YourCalls,
        }
      : {
          costPerMillionUsd: model.inputUsdPerMillion * typicalTokens,
          costSource: tokensAreFallback
            ? DecisionNumberSource.Assumed
            : DecisionNumberSource.OpenRouterPrice,
        };
  if (stat?.medianLatencyMs != null)
    return {
      ...cost,
      secondsPerDecision: stat.medianLatencyMs / 1000,
      timeSource: DecisionNumberSource.YourCalls,
    };
  if (openRouterLatencyMs !== null)
    return {
      ...cost,
      secondsPerDecision: openRouterLatencyMs / 1000,
      timeSource: DecisionNumberSource.OpenRouter,
    };
  return { ...cost, secondsPerDecision: null, timeSource: null };
}
