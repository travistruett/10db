import type { TaskId } from '@10db/contracts';
import { Box, Flex } from '@mantine/core';
import { useViewportSize } from '@mantine/hooks';
import { useState } from 'react';
import { useNow } from '../../shell/relative';
import { EMPTY_DRAFT, type Draft } from './drafts';
import { PagePane } from './page-pane';
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
 * it. With no page selected the thread shows the queue's first page. Each page keeps its own draft.
 */
export function PassWorkspace({ view, inbox, project, selected, onSelect }: PassWorkspaceProps) {
  const now = useNow(CLOCK_TICK_MS);
  const layout = workbenchLayout(useViewportSize().width);
  const rows = queueRows(view, inbox, now);
  const shown = shownRow(rows, selected);
  const wide = layout === WorkbenchLayout.Wide;
  // Each page's unsent draft, kept while another page is shown.
  const [drafts, setDrafts] = useState<ReadonlyMap<TaskId, Draft>>(new Map());

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
        <PagePane
          passId={view.pass.id}
          appUrl={project.appUrl}
          row={shown}
          now={now}
          draft={drafts.get(shown.page.taskId) ?? EMPTY_DRAFT}
          onDraft={(draft) => {
            const taskId = shown.page.taskId;
            setDrafts((held) => new Map(held).set(taskId, draft));
          }}
        />
      )}
    </Flex>
  );
}
