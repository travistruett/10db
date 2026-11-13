import { describe, expect, it } from 'vitest';
import { paretoFrontier, type ParetoPoint } from './pareto';

const at = (model: string, cost: number, intelligence: number, effort = 'high'): ParetoPoint => ({
  model,
  effort,
  cost,
  intelligence,
});
const names = (points: readonly ParetoPoint[]) =>
  paretoFrontier(points).map((p) => `${p.model}@${p.effort}`);

describe('paretoFrontier', () => {
  it.each([
    { name: 'no points', points: [], want: [] },
    { name: 'one point', points: [at('a', 1, 30)], want: ['a@high'] },
    {
      name: 'a dominated point dropped',
      points: [at('a', 1, 30), at('b', 2, 20), at('c', 3, 50)],
      want: ['a@high', 'c@high'],
    },
    {
      name: 'a dearer point that scores no more dropped',
      points: [at('a', 1, 30), at('b', 2, 30)],
      want: ['a@high'],
    },
    {
      name: 'equal cost with the higher score kept',
      points: [at('a', 2, 30), at('b', 2, 40)],
      want: ['b@high'],
    },
    {
      name: 'equal score with the cheaper kept',
      points: [at('a', 3, 40), at('b', 2, 40)],
      want: ['b@high'],
    },
    {
      name: 'exact duplicates keep the first by model and effort',
      points: [at('b', 2, 40, 'low'), at('b', 2, 40, 'high'), at('a', 2, 40, 'max')],
      want: ['a@max'],
    },
    {
      name: 'an unsorted input comes back cheapest first',
      points: [at('c', 9, 60), at('a', 1, 20), at('b', 4, 45)],
      want: ['a@high', 'b@high', 'c@high'],
    },
  ])('$name', ({ points, want }) => {
    expect(names(points)).toEqual(want);
  });
});
