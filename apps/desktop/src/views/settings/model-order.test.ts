import { ModelStatus, ModelTier } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { modelRowDto, someAccountId } from '../../test/model-fixtures';
import {
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
    tier: ModelTier.Fast,
    availableOn: [A],
    intelligence: 20,
    coding: 30,
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
    coding: 10,
    outputTokensPerSecond: 100,
    inputPrice: 3,
    outputPrice: 4,
    stepsRun: 5,
  }),
  modelRowDto({
    model: 'm-top',
    tier: ModelTier.Strongest,
    availableOn: [B],
    intelligence: 60,
    coding: 20,
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
    { column: ModelColumn.AvailableOn, up: ['m-blank', 'm-low', 'm-top', 'm-mid'] },
    { column: ModelColumn.Intelligence, up: ['m-low', 'm-mid', 'm-top', 'm-blank'] },
    { column: ModelColumn.Coding, up: ['m-mid', 'm-top', 'm-low', 'm-blank'] },
    { column: ModelColumn.Speed, up: ['m-top', 'm-mid', 'm-low', 'm-blank'] },
    { column: ModelColumn.InputPrice, up: ['m-low', 'm-mid', 'm-top', 'm-blank'] },
    { column: ModelColumn.OutputPrice, up: ['m-low', 'm-mid', 'm-top', 'm-blank'] },
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
    { name: 'no filter keeps all', tier: null, account: null, expected: 5 },
    { name: 'a tier keeps only that tier', tier: ModelTier.Fast, account: null, expected: 1 },
    { name: 'an account keeps what it offers', tier: null, account: A, expected: 2 },
    { name: 'both narrow together', tier: ModelTier.Balanced, account: B, expected: 1 },
    { name: 'a tier nothing has is empty', tier: ModelTier.Strongest, account: A, expected: 0 },
  ])('$name', ({ tier, account, expected }) => {
    expect(filterModels(rows, { tier, accountId: account })).toHaveLength(expected);
  });
});

describe('what counts as new', () => {
  const now = Date.parse('2026-11-07T00:00:00.000Z');
  it.each([
    { name: 'a day old', age: 24 * 3600_000, expected: true },
    { name: 'just inside seven days', age: NEW_WINDOW_MS - 1, expected: true },
    { name: 'exactly seven days', age: NEW_WINDOW_MS, expected: false },
    { name: 'a month old', age: 30 * 24 * 3600_000, expected: false },
  ])('$name: $expected', ({ age, expected }) => {
    const row = modelRowDto({ model: 'x', firstSeenAt: new Date(now - age).toISOString() });
    expect(isNewModel(row, now)).toBe(expected);
  });
});
