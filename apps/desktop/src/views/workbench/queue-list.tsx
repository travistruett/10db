import { Box } from '@mantine/core';
import type { TaskId } from '@10db/contracts';
import { QueueRow } from './queue-row';
import type { QueueRow as Row } from './queue-rows';

export interface QueueListProps {
  readonly rows: readonly Row[];
  /** The page the thread shows. */
  readonly current: TaskId | null;
  readonly onSelect: (taskId: TaskId) => void;
}

/** The queue: a labelled list of the pass's pages, one button each, the shown page `aria-current`. */
export function QueueList({ rows, current, onSelect }: QueueListProps) {
  return (
    <Box component="ul" aria-label="Pages in this pass" m={0} p={0} style={{ listStyle: 'none' }}>
      {rows.map((row) => (
        <li key={row.page.taskId}>
          <QueueRow
            row={row}
            current={row.page.taskId === current}
            onSelect={() => {
              onSelect(row.page.taskId);
            }}
          />
        </li>
      ))}
    </Box>
  );
}
