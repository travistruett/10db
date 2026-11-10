import { Box, Flex, Title } from '@mantine/core';
import { useViewportSize } from '@mantine/hooks';
import { useNow } from '../../shell/relative';
import type { PassWorkspaceProps } from './pass-workspace-props';
import { QueueList } from './queue-list';
import { queueRows, shownRow } from './queue-rows';
import { WorkbenchLayout, workbenchLayout } from './workbench-layout';

/** The queue's width beside the thread in the wide layout. */
const QUEUE_WIDTH_PX = 280;

/** A working line's minutes move once a minute; half that keeps them on time. */
const CLOCK_TICK_MS = 30_000;

/**
 * The open pass's queue and the shown page's thread (Workbench spec §4.3). Narrow: the queue is a strip
 * of rows across the top and the thread fills the rest. Wide: the queue on the left, the thread beside
 * it. With no page selected the thread shows the queue's first page.
 */
export function PassWorkspace({ view, inbox, selected, onSelect }: PassWorkspaceProps) {
  const now = useNow(CLOCK_TICK_MS);
  const layout = workbenchLayout(useViewportSize().width);
  const rows = queueRows(view, inbox, now);
  const shown = shownRow(rows, selected);
  const wide = layout === WorkbenchLayout.Wide;

  return (
    <Flex direction={wide ? 'row' : 'column'} style={{ flex: 1, minHeight: 0 }}>
      <Box
        style={{
          flex: 'none',
          width: wide ? QUEUE_WIDTH_PX : undefined,
          borderRight: wide ? '1px solid var(--mantine-color-default-border)' : undefined,
          overflowY: 'auto',
        }}
      >
        <QueueList rows={rows} current={shown?.page.taskId ?? null} onSelect={onSelect} />
      </Box>
      {shown === null ? null : (
        <Box
          component="section"
          aria-label={shown.page.area}
          style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}
        >
          <Title order={2} size="h4" px="md" pt="sm">
            {shown.page.area}
          </Title>
        </Box>
      )}
    </Flex>
  );
}
