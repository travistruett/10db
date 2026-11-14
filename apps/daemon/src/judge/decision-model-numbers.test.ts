import type { JudgeCallModelStat } from '@10db/db';
import { describe, expect, it } from 'vitest';
import {
  TYPICAL_TOKENS_FALLBACK,
  decisionModelNumbers,
  typicalDecisionTokens,
} from './decision-model-numbers';

const stat = (over: Partial<JudgeCallModelStat> = {}): JudgeCallModelStat => ({
  model: 'liquid/d1',
  calls: 10,
  costedCalls: 10,
  totalCostUsd: 0.01,
  medianLatencyMs: 400,
  ...over,
});

describe('typicalDecisionTokens', () => {
  const prices: Record<string, number | null> = {
    'a/priced': 2,
    'b/priced': 4,
    'c/free': 0,
    'd/unknown': null,
  };
  it.each([
    {
      name: 'one priced model: its cost over the price of a token',
      stats: [stat({ model: 'a/priced', costedCalls: 10, totalCostUsd: 0.008 })],
      expected: 400,
      assumed: false,
    },
    {
      name: 'a measured size that equals the guess is still measured',
      stats: [stat({ model: 'a/priced', costedCalls: 10, totalCostUsd: 0.006 })],
      expected: 300,
      assumed: false,
    },
    {
      name: 'two priced models are summed, not averaged',
      stats: [
        stat({ model: 'a/priced', costedCalls: 10, totalCostUsd: 0.006 }),
        stat({ model: 'b/priced', costedCalls: 10, totalCostUsd: 0.036 }),
      ],
      expected: 700,
      assumed: false,
    },
    {
      name: 'a free model is skipped, not divided by',
      stats: [
        stat({ model: 'c/free', costedCalls: 10, totalCostUsd: 0 }),
        stat({ model: 'a/priced', costedCalls: 10, totalCostUsd: 0.01 }),
      ],
      expected: 500,
      assumed: false,
    },
    {
      name: 'only a free model: the fallback',
      stats: [stat({ model: 'c/free', totalCostUsd: 0 })],
      expected: TYPICAL_TOKENS_FALLBACK,
      assumed: true,
    },
    {
      name: 'a model with no price: the fallback',
      stats: [stat({ model: 'd/unknown' })],
      expected: TYPICAL_TOKENS_FALLBACK,
      assumed: true,
    },
    {
      name: 'a priced model with no costed call: the fallback',
      stats: [stat({ model: 'a/priced', costedCalls: 0, totalCostUsd: 0 })],
      expected: TYPICAL_TOKENS_FALLBACK,
      assumed: true,
    },
    {
      name: 'no calls at all: the fallback',
      stats: [],
      expected: TYPICAL_TOKENS_FALLBACK,
      assumed: true,
    },
  ])('$name', ({ stats, expected, assumed }) => {
    const typical = typicalDecisionTokens(stats, (m) => prices[m] ?? null);
    expect(typical.tokens).toBeCloseTo(expected, 6);
    expect(typical.assumed).toBe(assumed);
  });
});

describe('decisionModelNumbers', () => {
  const model = { inputUsdPerMillion: 0.5 };
  it.each([
    {
      name: 'your calls give the cost and the time',
      stat: stat({ costedCalls: 4, totalCostUsd: 0.002, medianLatencyMs: 250 }),
      openRouterMs: 900,
      fallback: false,
      expected: {
        costPerMillionUsd: 500,
        costSource: 'your_calls',
        secondsPerDecision: 0.25,
        timeSource: 'your_calls',
      },
    },
    {
      name: 'a free model with calls costs nothing, from your calls',
      stat: stat({ costedCalls: 3, totalCostUsd: 0 }),
      openRouterMs: null,
      fallback: false,
      expected: {
        costPerMillionUsd: 0,
        costSource: 'your_calls',
        secondsPerDecision: 0.4,
        timeSource: 'your_calls',
      },
    },
    {
      name: 'a free model with answered calls that logged no cost still costs nothing, from your calls',
      stat: stat({ costedCalls: 0, totalCostUsd: 0 }),
      openRouterMs: null,
      fallback: false,
      free: true,
      expected: {
        costPerMillionUsd: 0,
        costSource: 'your_calls',
        secondsPerDecision: 0.4,
        timeSource: 'your_calls',
      },
    },
    {
      name: 'no calls: the price over your typical size, and OpenRouter’s latency',
      stat: undefined,
      openRouterMs: 900,
      fallback: false,
      expected: {
        costPerMillionUsd: 150,
        costSource: 'openrouter_price',
        secondsPerDecision: 0.9,
        timeSource: 'openrouter',
      },
    },
    {
      name: 'no calls and no sample: the assumed size, and no time',
      stat: undefined,
      openRouterMs: null,
      fallback: true,
      expected: {
        costPerMillionUsd: 150,
        costSource: 'assumed',
        secondsPerDecision: null,
        timeSource: null,
      },
    },
    {
      name: 'calls with no cost logged take the price, and keep their own time',
      stat: stat({ costedCalls: 0, totalCostUsd: 0, medianLatencyMs: 100 }),
      openRouterMs: 900,
      fallback: false,
      expected: {
        costPerMillionUsd: 150,
        costSource: 'openrouter_price',
        secondsPerDecision: 0.1,
        timeSource: 'your_calls',
      },
    },
  ])('$name', ({ stat: s, openRouterMs, fallback, expected, ...rest }) => {
    const priced = 'free' in rest ? { inputUsdPerMillion: 0 } : model;
    expect(decisionModelNumbers(priced, s, 300, openRouterMs, fallback)).toEqual(expected);
  });
});
