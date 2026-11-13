import type { ModelRowDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { modelRowDto } from '../../test/model-fixtures';
import { groupByFamily } from './model-families';

const row = (model: string, over: Partial<ModelRowDto> = {}): ModelRowDto =>
  modelRowDto({ model, ...over });

/** Each family as its lead's ID, then its older rows' IDs. */
const shape = (rows: readonly ModelRowDto[]) =>
  groupByFamily(rows).map((f) => [f.lead.model, f.older.map((r) => r.model)]);

describe('groupByFamily', () => {
  it.each<[string, ModelRowDto[], [string, string[]][]]>([
    [
      'one family of three, led by its current model',
      [row('a-3'), row('a-2', { status: 'superseded' }), row('a-1', { status: 'superseded' })],
      [['a-3', ['a-2', 'a-1']]],
    ],
    [
      'two interleaved families, in the order each first appears',
      [row('a-2'), row('b-1', { family: 'family-b' }), row('a-1', { status: 'superseded' })],
      [
        ['a-2', ['a-1']],
        ['b-1', []],
      ],
    ],
    [
      'a superseded row sorted above its current sibling still follows it',
      [row('a-1', { status: 'superseded' }), row('a-2')],
      [['a-2', ['a-1']]],
    ],
    [
      'a family whose current model was filtered out is led by its first older row',
      [row('a-2', { status: 'superseded' }), row('a-1', { status: 'superseded' })],
      [['a-2', ['a-1']]],
    ],
    [
      'two current models of one family each lead; older rows go under the first',
      [row('a-big'), row('a-small'), row('a-1', { status: 'superseded' })],
      [
        ['a-big', ['a-1']],
        ['a-small', []],
      ],
    ],
    [
      'families rank by their best member, so a cheap older version is never buried',
      [row('x-1', { status: 'superseded' }), row('y-1', { family: 'family-y' }), row('x-2')],
      [
        ['x-2', ['x-1']],
        ['y-1', []],
      ],
    ],
    [
      'models with no family stand alone, never merged',
      [row('x', { family: null }), row('y', { family: null })],
      [
        ['x', []],
        ['y', []],
      ],
    ],
    [
      'the same family name from two makers is two families',
      [row('a', { maker: 'lab-a' }), row('b', { maker: 'lab-b' })],
      [
        ['a', []],
        ['b', []],
      ],
    ],
  ])('groups %s', (_case, rows, expected) => {
    expect(shape(rows)).toEqual(expected);
  });
});
