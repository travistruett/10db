import { AreaRole, type AreaDef } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { withGuessedLabels } from './guessed-labels';

const shape: AreaDef = {
  name: 'shape',
  globs: ['src/views/shape/**'],
  role: AreaRole.Page,
  route: '/shape',
};
const board: AreaDef = {
  name: 'board',
  globs: ['src/views/board/**'],
  role: AreaRole.Page,
  route: '/board',
};
const shared: AreaDef = { name: 'ui', globs: ['src/ui/**'], role: AreaRole.Shared };

describe('withGuessedLabels', () => {
  it.each<[string, readonly AreaDef[], readonly AreaDef[], AreaDef[] | null]>([
    [
      'gives an unlabelled page the guess for its name',
      [shape, board],
      [{ ...shape, label: 'Plan' }, board],
      [{ ...shape, label: 'Plan' }, board],
    ],
    [
      'keeps a label the page already has',
      [{ ...shape, label: 'Shape it' }],
      [{ ...shape, label: 'Plan' }],
      null,
    ],
    ['answers null when the setup guessed nothing', [shape, board], [shape, board], null],
    [
      'takes no guess from an area that is not a page',
      [shape],
      [{ ...shape, role: AreaRole.Shared, label: 'Plan' }],
      null,
    ],
    [
      'labels no area that is not a page',
      [shared],
      [{ ...shared, role: AreaRole.Page, label: 'Ui' }],
      null,
    ],
    [
      'changes nothing but the label, and leaves areas the setup lacks',
      [shape, shared],
      [{ ...shape, globs: ['elsewhere/**'], route: '/plan', label: 'Plan' }],
      [{ ...shape, label: 'Plan' }, shared],
    ],
  ])('%s', (_name, areas, proposed, expected) => {
    expect(withGuessedLabels(areas, proposed)).toEqual(expected);
  });
});
