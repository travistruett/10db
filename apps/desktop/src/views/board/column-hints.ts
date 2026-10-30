import { BoardStatus } from '@10db/contracts';
import type { LayoutColumn } from './board-layout';

/** What lands in each derived column, from `deriveBoardStatus`. */
export const SYSTEM_HINT: Readonly<Record<BoardStatus, string>> = {
  [BoardStatus.Backlog]: 'Waiting on another task to finish.',
  [BoardStatus.Ready]: 'Next up. Start Ready Tasks picks from here.',
  [BoardStatus.InProgress]: 'Being worked on now, or being shipped.',
  [BoardStatus.InReview]:
    'Pull request open: waiting on its checks and your review. Done once it merges.',
  [BoardStatus.Blocked]:
    'Waiting on you, paused at a limit, failed, not shipped, or its pull request closed.',
  [BoardStatus.Done]: 'Finished and merged, or cancelled.',
};

/** What a human column holds: work parked until the builder moves it. */
export const HUMAN_HINT = "Parked. 10db won't start these until you move them.";

/** One line on what a column holds, shown while it is empty. */
export function columnHint(column: LayoutColumn): string {
  return column.key.kind === 'system' ? SYSTEM_HINT[column.key.status] : HUMAN_HINT;
}
