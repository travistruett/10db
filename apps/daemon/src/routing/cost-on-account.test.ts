import { mintId, type AccountModelDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { costOnAccount } from './cost-on-account';
import { testCatalogue } from './test-catalogue';

// mid@high lists at $5 an output token in the test catalogue and costs $1 a task at that price.
const offer = (model: string, outputPrice: number | null): AccountModelDto => ({
  accountId: mintId('Account'),
  model,
  family: null,
  launchId: model,
  efforts: [],
  unusable: false,
  wordingMarkEndsAt: null,
  inputPrice: outputPrice === null ? null : outputPrice / 5,
  outputPrice,
  lastSeenAt: '2026-11-08T12:00:00.000Z',
});

const find = (model: string, effort: string, over: Record<string, unknown> = {}) => {
  const found = testCatalogue().find((p) => p.model === model && p.effort === effort);
  if (!found) throw new Error('no such profile');
  return { ...found, ...over };
};

describe('costOnAccount', () => {
  it.each([
    { name: 'the maker’s price', profile: find('mid', 'high'), models: [offer('mid', 5)], want: 1 },
    {
      name: 'a 10% dearer Bedrock copy',
      profile: find('mid', 'high'),
      models: [offer('mid', 5.5)],
      want: 1.1,
    },
    { name: 'half price', profile: find('mid', 'high'), models: [offer('mid', 2.5)], want: 0.5 },
    {
      name: 'a plan with no price',
      profile: find('mid', 'high'),
      models: [offer('mid', null)],
      want: 1,
    },
    {
      name: 'a model the account does not list',
      profile: find('mid', 'high'),
      models: [offer('big', 50)],
      want: 1,
    },
    {
      name: 'no account list at all',
      profile: find('mid', 'high'),
      models: undefined,
      want: 1,
    },
    {
      name: 'a profile with no maker price',
      profile: find('mid', 'high', { outputPrice: null }),
      models: [offer('mid', 7)],
      want: 1,
    },
    {
      name: 'a zero maker price',
      profile: find('mid', 'high', { outputPrice: 0 }),
      models: [offer('mid', 7)],
      want: 1,
    },
    {
      name: 'no cost per task',
      profile: find('mid', 'high', { costPerTaskUsd: null }),
      models: [offer('mid', 5.5)],
      want: null,
    },
  ])('$name', ({ profile, models, want }) => {
    const got = costOnAccount(profile, models);
    if (want === null) expect(got).toBeNull();
    else expect(got).toBeCloseTo(want, 10);
  });
});
