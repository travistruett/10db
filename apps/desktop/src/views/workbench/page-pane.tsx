import type { PassId } from '@10db/contracts';
import { Box, Title } from '@mantine/core';
import { Composer } from './composer';
import type { Draft } from './drafts';
import { liveLine } from './live-line';
import { useOpenPage } from './open-page';
import { OpenPageButton } from './open-page-button';
import { usePageActions } from './page-actions';
import { PageStatus } from './page-status';
import type { QueueRow } from './queue-rows';
import { Thread } from './thread';
import { WorkingLine } from './working-line';

export interface PagePaneProps {
  readonly passId: PassId;
  /** The project's app address, which Open Page opens the page's route on. */
  readonly appUrl: string | null;
  readonly row: QueueRow;
  /** The workspace's clock, in epoch ms. */
  readonly now: number;
  readonly draft: Draft;
  readonly onDraft: (draft: Draft) => void;
}

/** The shown page: its thread, the live line while a turn works, and its composer fixed at the foot. */
export function PagePane({ passId, appUrl, row, now, draft, onDraft }: PagePaneProps) {
  const { page, status } = row;
  const actions = usePageActions(page.taskId);
  const open = useOpenPage({ passId, taskId: page.taskId, route: page.route, appUrl });
  const openPage = <OpenPageButton control={open} />;
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
        <Thread page={page} turns={[]} openPage={openPage} />
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
        openPage={openPage}
      />
    </Box>
  );
}
