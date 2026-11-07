import { describe, expect, it } from 'vitest';
import type { SeenModel } from './account-check';
import { seenModelsFrom } from './claude-model-list';

const ALL = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const row = (value: string, resolvedModel: string | undefined, efforts?: readonly string[]) => ({
  value,
  displayName: value,
  description: '',
  ...(resolvedModel === undefined ? {} : { resolvedModel }),
  ...(efforts === undefined ? {} : { supportsEffort: true, supportedEffortLevels: efforts }),
});

interface Case {
  name: string;
  rows: unknown;
  /** Null when the list is not used at all. */
  expected: readonly SeenModel[] | null;
}

const CASES: Case[] = [
  {
    name: 'a subscription: the default row repeats a model and goes, [1m] goes from the value and resolved ID',
    rows: [
      row('default', 'claude-opus-5-5', ALL),
      row('opus', 'claude-opus-5-5', ALL),
      row('claude-fable-5-1[1m]', 'claude-fable-5-1[1m]', ALL),
      row('haiku', 'claude-haiku-5-5', ALL),
    ],
    expected: [
      { id: 'opus', resolvedId: 'claude-opus-5-5', efforts: [...ALL] },
      { id: 'claude-fable-5-1', resolvedId: 'claude-fable-5-1', efforts: [...ALL] },
      { id: 'haiku', resolvedId: 'claude-haiku-5-5', efforts: [...ALL] },
    ],
  },
  {
    name: 'Bedrock: an alias keeps its resolved ID and a row with no efforts reports none',
    rows: [
      row(
        'us.anthropic.claude-opus-4-1-20250805-v1:0',
        'us.anthropic.claude-opus-4-1-20250805-v1:0',
      ),
      row('us.anthropic.claude-sonnet-4-6[1m]', 'us.anthropic.claude-sonnet-4-6[1m]', [
        'low',
        'medium',
        'high',
        'max',
      ]),
      row('haiku', 'us.anthropic.claude-haiku-4-5-20251001-v1:0'),
    ],
    expected: [
      {
        id: 'us.anthropic.claude-opus-4-1-20250805-v1:0',
        resolvedId: 'us.anthropic.claude-opus-4-1-20250805-v1:0',
        efforts: [],
      },
      {
        id: 'us.anthropic.claude-sonnet-4-6',
        resolvedId: 'us.anthropic.claude-sonnet-4-6',
        efforts: ['low', 'medium', 'high', 'max'],
      },
      { id: 'haiku', resolvedId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', efforts: [] },
    ],
  },
  {
    name: 'an effort 10db does not know is dropped',
    rows: [row('opus', 'claude-opus-5-5', ['low', 'ultra', 'max'])],
    expected: [{ id: 'opus', resolvedId: 'claude-opus-5-5', efforts: ['low', 'max'] }],
  },
  {
    name: 'a row that is not a model is skipped',
    rows: [{ displayName: 'no value' }, 'text', row('opus', 'claude-opus-5-5', ALL)],
    expected: [{ id: 'opus', resolvedId: 'claude-opus-5-5', efforts: [...ALL] }],
  },
  {
    name: 'a kind whose rows name no resolved model has no usable list',
    rows: [row('opus', undefined, ALL), row('sonnet', undefined, ALL)],
    expected: null,
  },
  { name: 'an empty list', rows: [], expected: null },
  { name: 'an answer that is not a list', rows: { models: [] }, expected: null },
];

describe('seenModelsFrom', () => {
  it.each(CASES)('reads $name', ({ rows, expected }) => {
    expect(seenModelsFrom(rows)).toEqual(expected ?? undefined);
  });
});
