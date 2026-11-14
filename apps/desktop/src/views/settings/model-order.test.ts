import { ModelStatus, ModelTier } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { modelRowDto, someAccountId } from '../../test/model-fixtures';
import {
  earliestFirstSeen,
  filterModels,
  isNewModel,
  ModelColumn,
  NEW_WINDOW_MS,
  SortDirection,
  sortModels,
} from './model-order';

const A = someAccountId();
const B = someAccountId();

const rows = [
  modelRowDto({
    model: 'm-low',
    tier: ModelTier.Efficient,
    availableOn: [A],
    intelligence: 20,
    costPerTaskUsd: 0.1,
    outputTokensPerSecond: 200,
    inputPrice: 1,
    outputPrice: 2,
    stepsRun: 9,
  }),
  modelRowDto({
    model: 'm-mid',
    tier: ModelTier.Balanced,
    availableOn: [A, B],
    intelligence: 40,
    costPerTaskUsd: 1,
    outputTokensPerSecond: 100,
    inputPrice: 3,
    outputPrice: 4,
    stepsRun: 5,
  }),
  modelRowDto({
    model: 'm-top',
    tier: ModelTier.Capable,
    availableOn: [B],
    intelligence: 60,
    costPerTaskUsd: 5,
    outputTokensPerSecond: 50,
    inputPrice: 5,
    outputPrice: 6,
    stepsRun: 1,
  }),
  modelRowDto({ model: 'm-blank', tier: null }),
  modelRowDto({ model: 'm-unknown', tier: null, status: ModelStatus.Unknown, intelligence: 99 }),
];
const order = (column: Parameters<typeof sortModels>[1]['column'], direction: SortDirection) =>
  sortModels(rows, { column, direction }).map((r) => r.model);

describe('sorting the model list', () => {
  it.each([
    { column: ModelColumn.Name, up: ['m-blank', 'm-low', 'm-mid', 'm-top'] },
    { column: ModelColumn.Tier, up: ['m-low', 'm-mid', 'm-top', 'm-blank'] },
    { column: ModelColumn.Intelligence, up: ['m-low', 'm-mid', 'm-top', 'm-blank'] },
    { column: ModelColumn.CostPerTask, up: ['m-low', 'm-mid', 'm-top', 'm-blank'] },
    { column: ModelColumn.StepsRun, up: ['m-blank', 'm-top', 'm-mid', 'm-low'] },
  ])('orders by $column, no data after the data, Unknown after everything', ({ column, up }) => {
    expect(order(column, SortDirection.Ascending)).toEqual([...up, 'm-unknown']);
    // Descending reverses the models that have data; a blank cell stays after them either way.
    const blankAtEnd = up.filter((m) => m !== 'm-blank');
    const descending = order(column, SortDirection.Descending);
    expect(descending.slice(0, blankAtEnd.length)).toEqual([...blankAtEnd].reverse());
    expect(descending.at(-1)).toBe('m-unknown');
  });

  it('puts Unknown last even when it has the highest score and the sort is descending', () => {
    expect(order(ModelColumn.Intelligence, SortDirection.Descending).at(-1)).toBe('m-unknown');
  });
});

describe('filtering the model list', () => {
  it.each([
    { name: 'no filter keeps all', query: '', tiers: [], account: null, expected: 5 },
    {
      name: 'a tier keeps only that tier',
      query: '',
      tiers: [ModelTier.Efficient],
      account: null,
      expected: 1,
    },
    {
      name: 'several tiers keep each',
      query: '',
      tiers: [ModelTier.Efficient, ModelTier.Capable],
      account: null,
      expected: 2,
    },
    { name: 'an account keeps what it offers', query: '', tiers: [], account: A, expected: 2 },
    {
      name: 'both narrow together',
      query: '',
      tiers: [ModelTier.Balanced],
      account: B,
      expected: 1,
    },
    {
      name: 'a tier nothing has is empty',
      query: '',
      tiers: [ModelTier.Capable],
      account: A,
      expected: 0,
    },
    { name: 'a search matches the model ID', query: 'm-to', tiers: [], account: null, expected: 1 },
    {
      name: 'a search ignores case and spaces around it',
      query: ' M-LOW ',
      tiers: [],
      account: null,
      expected: 1,
    },
    { name: 'a blank search keeps all', query: '   ', tiers: [], account: null, expected: 5 },
  ])('$name', ({ query, tiers, account, expected }) => {
    expect(filterModels(rows, { query, tiers, accountId: account })).toHaveLength(expected);
  });

  it('matches a search on the name too', () => {
    const named = [
      modelRowDto({ model: 'x-1', name: 'Zephyr Large' }),
      modelRowDto({ model: 'x-2' }),
    ];
    expect(
      filterModels(named, { query: 'zephyr', tiers: [], accountId: null }).map((r) => r.model),
    ).toEqual(['x-1']);
  });
});

describe('what counts as new', () => {
  const now = Date.parse('2026-11-07T00:00:00.000Z');
  const DAY = 24 * 3600_000;
  const at = (ago: number) => new Date(now - ago).toISOString();
  // The first batch a builder sees all share one first-seen time, and none of it is news.
  const OLDEST = at(30 * DAY);
  const oldest = modelRowDto({ model: 'oldest', firstSeenAt: OLDEST });

  it.each([
    { name: 'two days old, a month after the first batch', age: 2 * DAY, expected: true },
    { name: 'just inside seven days', age: NEW_WINDOW_MS - 1, expected: true },
    { name: 'exactly seven days', age: NEW_WINDOW_MS, expected: false },
    { name: 'a month old', age: 30 * DAY, expected: false },
  ])('$name: $expected', ({ age, expected }) => {
    const row = modelRowDto({ model: 'x', firstSeenAt: at(age) });
    expect(isNewModel(row, now, earliestFirstSeen([oldest, row]))).toBe(expected);
  });

  it.each([
    { name: 'on a fresh install, where every model arrived together', gap: 0, expected: false },
    { name: 'within a day of the first batch', gap: DAY - 1, expected: false },
    { name: 'more than a day after the first batch', gap: DAY + 1, expected: true },
  ])('$name: $expected', ({ gap, expected }) => {
    const first = Date.parse(at(3 * DAY));
    const early = modelRowDto({ model: 'a', firstSeenAt: new Date(first).toISOString() });
    const later = modelRowDto({ model: 'b', firstSeenAt: new Date(first + gap).toISOString() });
    const earliest = earliestFirstSeen([early, later]);
    expect(isNewModel(later, now, earliest)).toBe(expected);
    expect(isNewModel(early, now, earliest)).toBe(false);
  });

  it('is never new for a model with no first-seen time', () => {
    const row = modelRowDto({ model: 'x', firstSeenAt: null });
    expect(isNewModel(row, now, earliestFirstSeen([oldest, row]))).toBe(false);
  });
});
