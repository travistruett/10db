import { ModelStatus, ModelTier } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import type { CatalogueModel } from './source';
import { deriveTiers } from './tiers';

type Row = Partial<CatalogueModel> & { id: string };

const model = (row: Row): CatalogueModel => ({
  provider: 'anthropic',
  name: row.id,
  maker: 'anthropic',
  family: null,
  releaseDate: null,
  deprecated: false,
  inputPrice: 1,
  outputPrice: 1,
  efforts: [],
  ...row,
});

const { Strongest, Balanced, Fast } = ModelTier;
const { Current, Superseded, Retired, Unknown } = ModelStatus;

interface Case {
  name: string;
  models: Row[];
  /** Offered IDs; every model when absent. */
  offered?: string[];
  expected: Record<string, [ModelTier | null, ModelStatus]>;
}

const claude = (id: string, family: string, outputPrice: number, releaseDate: string): Row => ({
  id,
  family,
  outputPrice,
  releaseDate,
});

const CASES: Case[] = [
  {
    name: 'the Claude line on 2026-11-06 prices',
    models: [
      claude('fable-5-1', 'claude-fable', 50, '2026-09-01'),
      claude('opus-5-5', 'claude-opus', 20, '2026-09-22'),
      claude('sonnet-5-5', 'claude-sonnet', 10, '2026-09-28'),
      claude('haiku-5-5', 'claude-haiku', 0.5, '2026-10-07'),
    ],
    expected: {
      'fable-5-1': [Strongest, Current],
      'opus-5-5': [Strongest, Current],
      'sonnet-5-5': [Balanced, Current],
      'haiku-5-5': [Fast, Current],
    },
  },
  {
    name: 'the GPT line on the prices the design expected',
    models: [
      { id: 'astra', maker: 'openai', outputPrice: 50 },
      { id: 'sol', maker: 'openai', outputPrice: 20 },
      { id: 'terra', maker: 'openai', outputPrice: 12 },
      { id: 'luna', maker: 'openai', outputPrice: 1.2 },
    ],
    expected: {
      astra: [Strongest, Current],
      sol: [Strongest, Current],
      terra: [Balanced, Current],
      luna: [Fast, Current],
    },
  },
  {
    name: 'the GPT line on models.dev prices, where Terra is exactly 10% and counts as Fast',
    models: [
      { id: 'gpt-6-astra', maker: 'openai', outputPrice: 50 },
      { id: 'gpt-6.1-sol', maker: 'openai', outputPrice: 10 },
      { id: 'gpt-6.1-terra', maker: 'openai', outputPrice: 5 },
      { id: 'gpt-6-luna', maker: 'openai', outputPrice: 0.5 },
    ],
    expected: {
      'gpt-6-astra': [Strongest, Current],
      'gpt-6.1-sol': [Balanced, Current],
      'gpt-6.1-terra': [Fast, Current],
      'gpt-6-luna': [Fast, Current],
    },
  },
  {
    name: 'exactly 30% of the top is Strongest',
    models: [
      { id: 'top', outputPrice: 50 },
      { id: 'edge', outputPrice: 15 },
    ],
    expected: { top: [Strongest, Current], edge: [Strongest, Current] },
  },
  {
    name: 'exactly 10% of the top is Fast, on prices that are not whole numbers',
    models: [
      { id: 'top', outputPrice: 55 },
      { id: 'edge', outputPrice: 5.5 },
    ],
    expected: { top: [Strongest, Current], edge: [Fast, Current] },
  },
  {
    name: 'an older, dearer model is Superseded and does not set the top',
    models: [
      claude('opus-5', 'claude-opus', 25, '2026-07-24'),
      claude('opus-5-5', 'claude-opus', 20, '2026-09-22'),
      claude('haiku-5-5', 'claude-haiku', 2.2, '2026-10-07'),
    ],
    expected: {
      'opus-5': [null, Superseded],
      'opus-5-5': [Strongest, Current],
      'haiku-5-5': [Balanced, Current],
    },
  },
  {
    name: 'the newest model per family is found among the offered models only',
    models: [
      {
        id: 'gpt-5.6-sol',
        maker: 'openai',
        family: 'gpt-sol',
        releaseDate: '2026-07-01',
        outputPrice: 10,
      },
      {
        id: 'gpt-6.1-sol',
        maker: 'openai',
        family: 'gpt-sol',
        releaseDate: '2026-10-01',
        outputPrice: 10,
      },
    ],
    offered: ['gpt-5.6-sol'],
    expected: { 'gpt-5.6-sol': [Strongest, Current] },
  },
  {
    name: 'a model nobody offers does not set the top',
    models: [
      { id: 'offered', outputPrice: 10 },
      { id: 'unoffered', outputPrice: 100 },
    ],
    offered: ['offered'],
    expected: { offered: [Strongest, Current] },
  },
  {
    name: 'one model fills every tier',
    models: [{ id: 'only', outputPrice: 3 }],
    expected: { only: [Strongest, Current] },
  },
  {
    name: 'no price and a price of 0 are Unknown and do not set the top',
    models: [
      { id: 'none', outputPrice: null },
      { id: 'free', outputPrice: 0 },
      { id: 'priced', outputPrice: 8 },
    ],
    expected: {
      none: [null, Unknown],
      free: [null, Unknown],
      priced: [Strongest, Current],
    },
  },
  {
    name: 'a deprecated model is Retired and does not set the top',
    models: [
      { id: 'old', outputPrice: 60, deprecated: true },
      { id: 'new', outputPrice: 5 },
    ],
    expected: { old: [null, Retired], new: [Strongest, Current] },
  },
  {
    name: 'a model with no release date is never superseded',
    models: [
      { id: 'dated', family: 'f', releaseDate: '2026-10-01', outputPrice: 10 },
      { id: 'undated', family: 'f', releaseDate: null, outputPrice: 10 },
    ],
    expected: { dated: [Strongest, Current], undated: [Strongest, Current] },
  },
  {
    name: 'a model with no maker is Unknown and sets no top',
    models: [
      { id: 'stray', maker: null, outputPrice: 90 },
      { id: 'known', outputPrice: 10 },
    ],
    expected: { stray: [null, Unknown], known: [Strongest, Current] },
  },
  {
    name: 'a model with no family ranks by its own price and supersedes nothing',
    models: [
      { id: 'a', outputPrice: 10, releaseDate: '2026-10-01' },
      { id: 'b', outputPrice: 10, releaseDate: '2020-01-01' },
    ],
    expected: { a: [Strongest, Current], b: [Strongest, Current] },
  },
  {
    name: 'makers are ranked apart, so a gateway copy of Claude does not rank with GPT',
    models: [
      { id: 'claude', maker: 'anthropic', outputPrice: 20 },
      { id: 'gpt', maker: 'openai', outputPrice: 100 },
      { id: 'cheap-claude', maker: 'anthropic', outputPrice: 1 },
    ],
    expected: {
      claude: [Strongest, Current],
      gpt: [Strongest, Current],
      'cheap-claude': [Fast, Current],
    },
  },
  {
    name: 'two copies of one model released together are both current',
    models: [
      { id: 'direct', family: 'claude-opus', releaseDate: '2026-09-22', outputPrice: 20 },
      { id: 'bedrock', family: 'claude-opus', releaseDate: '2026-09-22', outputPrice: 22 },
    ],
    expected: { direct: [Strongest, Current], bedrock: [Strongest, Current] },
  },
];

describe('deriveTiers', () => {
  it.each(CASES)('$name', ({ models, offered, expected }) => {
    const all = models.map(model);
    const result = deriveTiers(all, new Set(offered ?? all.map((m) => m.id)));
    expect(Object.fromEntries([...result].map(([id, d]) => [id, [d.tier, d.status]]))).toEqual(
      expected,
    );
  });
});
