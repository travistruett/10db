import { BoardStatus } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import type { LayoutColumn } from './board-layout';
import { boardColumnDto } from '../../test/fixtures';
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
    ['In progress', system(BoardStatus.InProgress), 'Being worked on now, or being shipped.'],
    [
      'In review',
      system(BoardStatus.InReview),
      'Pull request open: waiting on its checks and your review. Done once it merges.',
    ],
    [
      'Blocked',
      system(BoardStatus.Blocked),
      'Waiting on you, paused at a limit, held, failed, not shipped, or its pull request closed.',
    ],
    ['Done', system(BoardStatus.Done), 'Finished and merged, or cancelled.'],
    [
      'a human column',
      {
        key: { kind: 'human', id: boardColumnDto().id },
        label: 'Icebox',
        tasks: [],
      } satisfies LayoutColumn,
      "Parked. 10db won't start these until you move them.",
    ],
  ])('%s', (_name, column, hint) => {
    expect(columnHint(column)).toBe(hint);
  });
});
