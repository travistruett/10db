import { BoardStatus } from '@10db/contracts';
import { Badge, type MantineColor } from '@mantine/core';

export const BOARD_STATUS: Readonly<
  Record<BoardStatus, { readonly label: string; readonly color: MantineColor }>
> = {
  [BoardStatus.Backlog]: { label: 'Backlog', color: 'gray' },
  [BoardStatus.Ready]: { label: 'Ready', color: 'teal' },
  [BoardStatus.InProgress]: { label: 'In progress', color: 'blue' },
  [BoardStatus.Blocked]: { label: 'Blocked', color: 'yellow' },
  [BoardStatus.Done]: { label: 'Done', color: 'green' },
};

export function BoardStatusBadge({ status }: { readonly status: BoardStatus }) {
  const { label, color } = BOARD_STATUS[status];
  return (
    <Badge color={color} variant="light" size="sm">
      {label}
    </Badge>
  );
}
