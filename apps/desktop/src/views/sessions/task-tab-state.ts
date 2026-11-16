import { BoardStatus } from '@10db/contracts';
import { TabState } from './tab-state';

/**
 * What a task's tab shows (sessions UI §8.4): working while it is in progress, a red ring while it is
 * blocked, nothing otherwise. Where it stands before it is read shows nothing.
 */
export function taskTabState(board: BoardStatus | null): TabState {
  switch (board) {
    case BoardStatus.InProgress:
      return TabState.Working;
    case BoardStatus.Blocked:
      return TabState.Error;
    case BoardStatus.Backlog:
    case BoardStatus.Ready:
    case BoardStatus.InReview:
    case BoardStatus.Done:
    case null:
      return TabState.Idle;
  }
}
