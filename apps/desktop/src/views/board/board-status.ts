import { BoardStatus } from '@10db/contracts';
import type { MantineColor } from '@mantine/core';

/** The label and color of each derived column. */
export const BOARD_STATUS: Readonly<
  Record<BoardStatus, { readonly label: string; readonly color: MantineColor }>
> = {
  [BoardStatus.Backlog]: { label: 'Backlog', color: 'gray' },
  [BoardStatus.Ready]: { label: 'Ready', color: 'teal' },
  [BoardStatus.InProgress]: { label: 'In progress', color: 'blue' },
  [BoardStatus.Blocked]: { label: 'Blocked', color: 'yellow' },
  [BoardStatus.Done]: { label: 'Done', color: 'green' },
};
