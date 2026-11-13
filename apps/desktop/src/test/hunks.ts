import type { ToolCallHunk } from '@10db/contracts';
import type { GutterLine } from '../conversation/hunk-gutter';

// Edit hunks and the gutter each draws, shared by the gutter's pure table and the rendered test
// that checks the gutter lines up with the rows Mantine's Diff draws.

/** A hunk from its starts and each side's lines. */
export function hunk(
  oldStart: number,
  newStart: number,
  before: readonly string[],
  after: readonly string[],
): ToolCallHunk {
  const text = (lines: readonly string[]) => lines.map((l) => `${l}\n`).join('');
  return {
    oldStart,
    oldLines: before.length,
    newStart,
    newLines: after.length,
    before: text(before),
    after: text(after),
  };
}

const C = 'context';
const A = 'added';
const R = 'removed';

/** Each row's hunk and the gutter it draws, as `[kind, number, text]`. */
export const GUTTER_ROWS: readonly [
  string,
  ToolCallHunk,
  readonly [GutterLine['kind'], number, string][],
][] = [
  [
    'one line changed',
    hunk(
      41,
      41,
      ['c1', 'c2', 'c3', 'a', 'c4', 'c5', 'c6'],
      ['c1', 'c2', 'c3', 'b', 'c4', 'c5', 'c6'],
    ),
    [
      [C, 41, 'c1'],
      [C, 42, 'c2'],
      [C, 43, 'c3'],
      [R, 44, 'a'],
      [A, 44, 'b'],
      [C, 45, 'c4'],
      [C, 46, 'c5'],
      [C, 47, 'c6'],
    ],
  ],
  [
    'deep in a file',
    hunk(1200, 1203, ['x', 'y', 'z'], ['x', 'y', 'z', 'new']),
    [
      [C, 1203, 'x'],
      [C, 1204, 'y'],
      [C, 1205, 'z'],
      [A, 1206, 'new'],
    ],
  ],
  [
    'a new file',
    hunk(0, 1, [], ['a', 'b', 'c']),
    [
      [A, 1, 'a'],
      [A, 2, 'b'],
      [A, 3, 'c'],
    ],
  ],
  [
    'a deleted file',
    hunk(1, 0, ['a', 'b'], []),
    [
      [R, 1, 'a'],
      [R, 2, 'b'],
    ],
  ],
  [
    'two changes in one hunk',
    hunk(10, 20, ['a', 'k', 'c'], ['b', 'k', 'd']),
    [
      [R, 10, 'a'],
      [A, 20, 'b'],
      [C, 21, 'k'],
      [R, 12, 'c'],
      [A, 22, 'd'],
    ],
  ],
];
