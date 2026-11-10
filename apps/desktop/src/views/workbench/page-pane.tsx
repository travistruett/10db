import type { PassId } from '@10db/contracts';
import { Box, Title } from '@mantine/core';
import { useEffect, useRef } from 'react';
import { useMarkOpened, useTurns } from '../../daemon/pass-queries';
import { Composer } from './composer';
import type { Draft } from './drafts';
import { liveLine } from './live-line';
import { useOpenPage } from './open-page';
import { OpenPageButton } from './open-page-button';
import { usePageActions } from './page-actions';
import { PageStatus } from './page-status';
import type { QueueRow } from './queue-rows';
import { RetryTurn } from './retry-turn';
import { SignOffLine } from './sign-off-line';
import { Thread } from './thread';
import { useWorkbenchKeys } from './use-workbench-keys';
import { WorkbenchKey } from './workbench-keys';
import { WorkingLine } from './working-line';

export interface PagePaneProps {
  readonly passId: PassId;
  /** The project's app address, which Open Page opens the page's route on. */
  readonly appUrl: string | null;
  readonly row: QueueRow;
  /** The pass is open: while it closes or is abandoned, nothing can be sent to a page. */
  readonly passOpen: boolean;
  /** When the builder first opened the page's latest turn; null while it never has. */
  readonly openedAt: string | null;
  /** The workspace's clock, in epoch ms. */
  readonly now: number;
  readonly draft: Draft;
  readonly onDraft: (draft: Draft) => void;
}

/** The shown page: its thread, the live line while a turn works, and its composer fixed at the foot. */
export function PagePane(props: PagePaneProps) {
  const { passId, appUrl, row, passOpen, openedAt, now, draft, onDraft } = props;
  const { page, status } = row;
  const actions = usePageActions(passId, page.taskId);
  const turns = useTurns(page.taskId).data ?? [];
  // A Ready page shown is a page the builder has looked at: its turn is marked opened, once.
  const markOpened = useMarkOpened(page.taskId);
  const readyTurn =
    status === PageStatus.Ready && openedAt === null ? (page.turn?.id ?? null) : null;
  const marked = useRef<string | null>(null);
  useEffect(() => {
    if (readyTurn === null || marked.current === readyTurn) return;
    marked.current = readyTurn;
    markOpened.mutate(readyTurn);
  }, [readyTurn, markOpened]);
  const open = useOpenPage({ passId, taskId: page.taskId, route: page.route, appUrl });
  const openPage = <OpenPageButton control={open} />;
  useWorkbenchKeys({
    [WorkbenchKey.CopyLink]: () => {
      void open.copy();
    },
  });
  // The cursor goes to the composer of each page shown, so the builder can paste and type at once.
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, [page.taskId]);
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
        <Thread page={page} turns={turns} openPage={openPage} />
        {status === PageStatus.Working && page.turn?.endedAt === null ? (
          <WorkingLine
            line={liveLine(page.turn, now)}
            turnId={page.turn.id}
            logTitle={`${page.area} · Turn ${String(page.turn.seq)}`}
          />
        ) : null}
      </Box>
      {passOpen && status === PageStatus.Failed && page.failure !== null ? (
        <RetryTurn itemId={page.failure.retryItemId} line={row.state.line} />
      ) : null}
      {status === PageStatus.SigningOff || status === PageStatus.Waiting ? (
        <SignOffLine
          passId={passId}
          taskId={page.taskId}
          line={row.state.line}
          waiting={passOpen && status === PageStatus.Waiting}
        />
      ) : null}
      <Composer
        area={page.area}
        status={status}
        firstMessage={!page.spokenTo}
        draft={draft}
        onDraft={onDraft}
        actions={actions}
        openPage={openPage}
        inputRef={input}
        disabled={!passOpen}
      />
    </Box>
  );
}
