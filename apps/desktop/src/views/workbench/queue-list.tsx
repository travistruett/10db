import { Box } from '@mantine/core';
import type { TaskId } from '@10db/contracts';
import { QueueRow } from './queue-row';
import { RowMenu } from './row-menu';
import type { QueueRow as Row } from './queue-rows';

export interface QueueListProps {
  readonly rows: readonly Row[];
  /** The page the thread shows. */
  readonly current: TaskId | null;
  readonly onSelect: (taskId: TaskId) => void;
  /** Take Out… on a row's menu; null when pages can't be taken out now. */
  readonly onTakeOut: ((taskId: TaskId) => void) | null;
}

/** The queue: a labelled list of the pass's pages, one button each, the shown page `aria-current`. */
export function QueueList({ rows, current, onSelect, onTakeOut }: QueueListProps) {
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
            menu={
              onTakeOut === null ? null : (
                <RowMenu
                  area={row.page.area}
                  onTakeOut={() => {
                    onTakeOut(row.page.taskId);
                  }}
                />
              )
            }
          />
        </li>
      ))}
    </Box>
  );
}
