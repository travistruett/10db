import { BoardStatus } from '@10db/contracts';
import { PageStatus } from '../workbench/page-status';
import { TabState } from './tab-state';

/** What the strip reads of a task to give its tab a mark (sessions UI §5.3). */
export interface TaskTabFacts {
  /** Where the task stands on the Board, once read. */
  readonly board: BoardStatus | null;
  /** The task's run (a separate copy) failed. */
  readonly failed: boolean;
  /** The one page of a pass of one, while its pass is live. */
  readonly page: PageStatus | null;
  /** The pass of one has closed and waits on its pull request. */
  readonly passClosed: boolean;
}

/**
 * What a task's tab shows: the first that holds. Only a failure is red; a task or page waiting on the
 * builder is yellow, and a ready page adds the ring too. In review, signed off and done are glyphs.
 */
export function taskTabState({ board, failed, page, passClosed }: TaskTabFacts): TabState {
  if (failed || page === PageStatus.Failed || page === PageStatus.PreviewBroken)
    return TabState.Error;
  if (page === PageStatus.Asks || board === BoardStatus.Blocked) return TabState.NeedsYou;
  if (page === PageStatus.Ready) return TabState.Ready;
  if (page === PageStatus.Paused) return TabState.Paused;
  if (
    board === BoardStatus.InProgress ||
    page === PageStatus.Working ||
    page === PageStatus.SigningOff ||
    page === PageStatus.Waiting
  )
    return TabState.Working;
  if (page === PageStatus.SignedOff && !passClosed) return TabState.SignedOff;
  if (board === BoardStatus.InReview || passClosed) return TabState.InReview;
  if (board === BoardStatus.Done) return TabState.Done;
  return TabState.Idle;
}
