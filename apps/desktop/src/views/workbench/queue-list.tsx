import { Box, Group } from '@mantine/core';
import type { PassId, TaskId } from '@10db/contracts';
import { useOpenPage } from './open-page';
import { OpenPageIcon } from './open-page-button';
import { PageStatus } from './page-status';
import { QueueRow } from './queue-row';
import { RowMenu } from './row-menu';
import type { QueueRow as Row } from './queue-rows';

export interface QueueListProps {
  readonly passId: PassId;
  /** The project's app address, which a row's link opens its page's route on. */
  readonly appUrl: string | null;
  readonly rows: readonly Row[];
  /** The page the thread shows. */
  readonly current: TaskId | null;
  readonly onSelect: (taskId: TaskId) => void;
  /** Discard on a row's menu; null when pages can't be discarded now. */
  readonly onDiscard: ((taskId: TaskId) => void) | null;
}

/** Marks the queue, so the page shown leaves the cursor on a row picked by the queue's keys. */
export const QUEUE_ATTRIBUTE = 'data-workbench-queue';

/** A row's link to its page in the browser; none while there is no address or route to open. */
function RowOpen({ passId, appUrl, row }: { passId: PassId; appUrl: string | null; row: Row }) {
  const open = useOpenPage({
    passId,
    taskId: row.page.taskId,
    route: row.page.route,
    appUrl,
  });
  return appUrl === null || row.page.route === null ? null : (
    <OpenPageIcon label={row.page.label} control={open} />
  );
}

/** The queue: a labelled list of the pass's pages, one button each, the shown page `aria-current`. */
export function QueueList({ passId, appUrl, rows, current, onSelect, onDiscard }: QueueListProps) {
  return (
    <Box
      component="ul"
      aria-label="Open pages"
      m={0}
      p={0}
      style={{ listStyle: 'none', display: 'flex', flexDirection: 'column' }}
      {...{ [QUEUE_ATTRIBUTE]: true }}
    >
      {rows.map((row) => (
        <li key={row.page.taskId}>
          <QueueRow
            row={row}
            current={row.page.taskId === current}
            onSelect={() => {
              onSelect(row.page.taskId);
            }}
            menu={
              <Group gap={2} wrap="nowrap">
                <RowOpen passId={passId} appUrl={appUrl} row={row} />
                {/* A committed page stays: its work is in the pass's pull request. */}
                {onDiscard === null || row.status === PageStatus.SignedOff ? null : (
                  <RowMenu
                    label={row.page.label}
                    onDiscard={() => {
                      onDiscard(row.page.taskId);
                    }}
                  />
                )}
              </Group>
            }
          />
        </li>
      ))}
    </Box>
  );
}
