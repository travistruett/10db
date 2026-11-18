import { describe, expect, it } from 'vitest';
import { nextSelection } from './inbox-selection';

const rows: readonly {
  readonly name: string;
  readonly keys: readonly string[];
  readonly selected: string | null;
  readonly lastIndex: number;
  readonly expected: { readonly key: string | null; readonly index: number };
}[] = [
  {
    name: 'the key is present, it stays',
    keys: ['a', 'b', 'c'],
    selected: 'b',
    lastIndex: 0,
    expected: { key: 'b', index: 1 },
  },
  {
    name: 'left the middle, the next row',
    keys: ['a', 'c', 'd'],
    selected: 'b',
    lastIndex: 1,
    expected: { key: 'c', index: 1 },
  },
  {
    name: 'left the end, the new last row',
    keys: ['a', 'b'],
    selected: 'c',
    lastIndex: 2,
    expected: { key: 'b', index: 1 },
  },
  {
    name: 'the list is empty',
    keys: [],
    selected: 'a',
    lastIndex: 0,
    expected: { key: null, index: 0 },
  },
  {
    name: 'nothing selected yet, the first row',
    keys: ['a', 'b'],
    selected: null,
    lastIndex: 0,
    expected: { key: 'a', index: 0 },
  },
  {
    name: 'a new list without the key, at index 0',
    keys: ['x', 'y'],
    selected: 'a',
    lastIndex: 0,
    expected: { key: 'x', index: 0 },
  },
];

describe('nextSelection', () => {
  it.each(rows)('$name', ({ keys, selected, lastIndex, expected }) => {
    expect(nextSelection(keys, selected, lastIndex)).toEqual(expected);
  });
});
