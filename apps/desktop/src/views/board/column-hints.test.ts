import { BoardStatus, type BoardColumnId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import type { LayoutColumn } from './board-layout';
import { columnHint } from './column-hints';

const system = (status: BoardStatus): LayoutColumn => ({
  key: { kind: 'system', status },
  label: status,
  tasks: [],
});

describe('columnHint', () => {
  it.each([
    ['Backlog', system(BoardStatus.Backlog), 'Waiting on another task to finish.'],
    ['Ready', system(BoardStatus.Ready), 'Next up. Start Ready Tasks picks from here.'],
    ['In progress', system(BoardStatus.InProgress), 'Being worked on now.'],
    ['Blocked', system(BoardStatus.Blocked), 'Waiting on you, paused at a limit, or failed.'],
    ['Done', system(BoardStatus.Done), 'Finished or cancelled.'],
    [
      'a human column',
      {
        key: { kind: 'human', id: 'col_1' as BoardColumnId },
        label: 'Icebox',
        tasks: [],
      } satisfies LayoutColumn,
      "Parked. 10db won't start these until you move them.",
    ],
  ])('%s', (_name, column, hint) => {
    expect(columnHint(column)).toBe(hint);
  });
});
