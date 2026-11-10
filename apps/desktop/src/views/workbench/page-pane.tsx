import { Box, Title } from '@mantine/core';
import { Composer } from './composer';
import type { Draft } from './drafts';
import { liveLine } from './live-line';
import { usePageActions } from './page-actions';
import { PageStatus } from './page-status';
import type { QueueRow } from './queue-rows';
import { Thread } from './thread';
import { WorkingLine } from './working-line';

export interface PagePaneProps {
  readonly row: QueueRow;
  /** The workspace's clock, in epoch ms. */
  readonly now: number;
  readonly draft: Draft;
  readonly onDraft: (draft: Draft) => void;
}

/** The shown page: its thread, the live line while a turn works, and its composer fixed at the foot. */
export function PagePane({ row, now, draft, onDraft }: PagePaneProps) {
  const { page, status } = row;
  const actions = usePageActions(page.taskId);
  return (
    <Box
      component="section"
      aria-label={page.area}
      style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      <Title order={2} size="h4" px="md" pt="sm">
        {page.area}
      </Title>
      <Box style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <Thread page={page} turns={[]} />
        {status === PageStatus.Working && page.turn?.endedAt === null ? (
          <WorkingLine line={liveLine(page.turn, now)} />
        ) : null}
      </Box>
      <Composer
        area={page.area}
        status={status}
        firstMessage={!page.spokenTo}
        draft={draft}
        onDraft={onDraft}
        actions={actions}
        openPage={null}
      />
    </Box>
  );
}
