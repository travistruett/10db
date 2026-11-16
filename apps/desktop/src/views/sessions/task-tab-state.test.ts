import { BoardStatus } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { TabState } from './tab-state';
import { taskTabState } from './task-tab-state';

describe('taskTabState', () => {
  it.each([
    { board: BoardStatus.InProgress, want: TabState.Working },
    { board: BoardStatus.Blocked, want: TabState.Error },
    { board: BoardStatus.InReview, want: TabState.Idle },
    { board: BoardStatus.Done, want: TabState.Idle },
    { board: BoardStatus.Ready, want: TabState.Idle },
    { board: null, want: TabState.Idle },
  ])('$board is $want', ({ board, want }) => {
    expect(taskTabState(board)).toBe(want);
  });
});
