import { DecisionNumberSource, ModelSource } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { decisionSourceText, modelSourceText } from './number-source';

const FIELDS = ['intelligence', 'coding', 'agentic', 'costPerTask'] as const;

describe('modelSourceText', () => {
  it.each(
    FIELDS.flatMap((field) => [
      { source: ModelSource.Aa, field, expected: 'Artificial Analysis' },
      {
        source: ModelSource.AaViaOpenRouter,
        field,
        expected: 'Artificial Analysis, via OpenRouter',
      },
      { source: ModelSource.OpenRouter, field, expected: 'OpenRouter' },
    ]),
  )('names $source for $field', ({ source, field, expected }) => {
    expect(modelSourceText(source, field, null)).toBe(expected);
  });

  it.each([
    { name: 'AA speed', source: ModelSource.Aa, provider: null, expected: 'Artificial Analysis' },
    {
      name: 'relayed speed',
      source: ModelSource.AaViaOpenRouter,
      provider: null,
      expected: 'Artificial Analysis, via OpenRouter',
    },
    {
      name: 'OpenRouter on a provider',
      source: ModelSource.OpenRouter,
      provider: 'Amazon Bedrock',
      expected: 'OpenRouter, measured on Amazon Bedrock',
    },
    {
      name: 'OpenRouter with no provider',
      source: ModelSource.OpenRouter,
      provider: null,
      expected: 'OpenRouter, median across providers',
    },
  ])('names speed from $name', ({ source, provider, expected }) => {
    expect(modelSourceText(source, 'speed', provider)).toBe(expected);
  });
});

describe('decisionSourceText', () => {
  it.each([
    { source: DecisionNumberSource.YourCalls, expected: 'Your calls, last 30 days' },
    {
      source: DecisionNumberSource.OpenRouterPrice,
      expected: "OpenRouter's price for your typical decision",
    },
    { source: DecisionNumberSource.OpenRouter, expected: 'OpenRouter, measured' },
    {
      source: DecisionNumberSource.Assumed,
      expected: "OpenRouter's price for a 300-token decision",
    },
  ])('names $source', ({ source, expected }) => {
    expect(decisionSourceText(source)).toBe(expected);
  });
});
