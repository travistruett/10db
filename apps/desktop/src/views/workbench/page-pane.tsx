import {
  ConversationState,
  type PassId,
  type PassTurnId,
  type ToolCallView,
} from '@10db/contracts';
import { Anchor, Box, Text, Title } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { toolDoing, WorkingLine } from '../../conversation';
import type { Draft } from '../../conversation/drafts';
import { streamingOf } from '../../conversation/live-items';
import { useConversationItems, useConversationLive } from '../../daemon/conversation-queries';
import { useMarkOpened, useTurns } from '../../daemon/pass-queries';
import { liveLine } from './live-line';
import { useOpenPage } from './open-page';
import { OpenPageButton } from './open-page-button';
import { PageAsk } from './page-ask';
import { usePageActions } from './page-actions';
import { PageComposer } from './page-composer';
import { PageStatus } from './page-status';
import { QUEUE_ATTRIBUTE } from './queue-list';
import type { QueueRow } from './queue-rows';
import { RetryTurn } from './retry-turn';
import { PageThread } from './page-thread';
import { SignOffLine } from './sign-off-line';
import { TurnLogDrawer } from './turn-log-drawer';
import { useWorkbenchKeys } from './use-workbench-keys';
import { WorkbenchKey } from './workbench-keys';

export interface PagePaneProps {
  readonly passId: PassId;
  /** The project's app address, which Open Page opens the page's route on. */
  readonly appUrl: string | null;
  readonly row: QueueRow;
  /** The pass is open: while it closes or is abandoned, nothing can be sent to a page. */
  readonly passOpen: boolean;
  /** When the builder first opened the page's latest turn; null while it never has. */
  readonly openedAt: string | null;
  /** Counts the window gaining focus: each time, the composer takes the cursor. */
  readonly composerFocus: number;
  readonly draft: Draft;
  readonly onDraft: (draft: Draft) => void;
}

/**
 * The shown page: its thread on the kit's list, the kit's working line while a turn works, and its
 * composer fixed at the foot. What the page's session streams reaches it live.
 */
export function PagePane(props: PagePaneProps) {
  const { passId, appUrl, row, passOpen, openedAt, composerFocus, draft, onDraft } = props;
  const { page, status } = row;
  const actions = usePageActions(passId, page.taskId, page.conversationId);
  const turns = useTurns(page.taskId).data ?? [];
  const live = useConversationLive(page.conversationId);
  const stored = useConversationItems(page.conversationId);
  const streaming = streamingOf(live, new Set(stored.map((item) => item.id)));
  // The working turn's line: what streams names the tool, else the turn's last report does.
  const working =
    status === PageStatus.Working && page.turn !== null && page.turn.endedAt === null
      ? { id: page.turn.id, startedAt: page.turn.startedAt, line: liveLine(page.turn) }
      : null;
  const tool = streaming.call === null ? (working?.line.tool ?? null) : toolDoing(streaming.call);
  // A Ready page shown is a page the builder has looked at: its turn is marked opened, once.
  const markOpened = useMarkOpened(page.taskId);
  const readyTurn =
    (status === PageStatus.Ready || status === PageStatus.PreviewBroken) && openedAt === null
      ? (page.turn?.id ?? null)
      : null;
  const marked = useRef<string | null>(null);
  useEffect(() => {
    if (readyTurn === null || marked.current === readyTurn) return;
    marked.current = readyTurn;
    markOpened.mutate(readyTurn);
  }, [readyTurn, markOpened]);
  // Show Log's turn: the log stays open as the turn ends, and closes once another turn is the page's
  // or another page is shown, so coming back to the page never opens it unasked.
  const [logTurn, setLogTurn] = useState<PassTurnId | null>(null);
  const [logPage, setLogPage] = useState(page.taskId);
  if (logPage !== page.taskId) {
    setLogPage(page.taskId);
    setLogTurn(null);
  }
  const open = useOpenPage({ passId, taskId: page.taskId, route: page.route, appUrl });
  const openPage = <OpenPageButton control={open} />;
  useWorkbenchKeys({
    [WorkbenchKey.CopyLink]: () => {
      void open.copy();
    },
  });
  // The cursor goes to the composer of each page the builder shows, so they can paste and type at
  // once; not to the page the Workbench opens on, nor away from a row picked by the queue's keys, so J
  // and K keep working.
  const input = useRef<HTMLTextAreaElement | HTMLInputElement>(null);
  const shownBefore = useRef(page.taskId);
  const focusAsked = useRef(composerFocus);
  useEffect(() => {
    // The window gaining focus, a notification's click among its ways, asks for the composer outright.
    const asked = focusAsked.current !== composerFocus;
    focusAsked.current = composerFocus;
    const moved = shownBefore.current !== page.taskId;
    shownBefore.current = page.taskId;
    if (asked || (moved && !document.activeElement?.closest(`[${QUEUE_ATTRIBUTE}]`)))
      input.current?.focus();
  }, [page.taskId, composerFocus]);
  return (
    <Box
      component="section"
      aria-label={page.area}
      style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      <Title order={2} size="h4" px="md" pt="sm">
        {page.area}
      </Title>
      <Box style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <PageThread
          page={page}
          turns={turns}
          live={live}
          busy={streaming.streaming === 'text'}
          canSend={passOpen}
          onAllow={(call: ToolCallView) => {
            void actions.send({ text: `Go ahead: ${call.title}`, mentions: [], pictures: [] });
          }}
        />
      </Box>
      {working === null ? null : (
        <WorkingLine
          conversation={{ state: ConversationState.Running, pausedUntil: null }}
          streaming={streaming.streaming}
          startedAt={working.startedAt}
          {...(tool === null ? {} : { tool })}
          extra={
            <>
              {working.line.files === null ? null : (
                <Text size="xs" c="dimmed" style={{ flex: 'none' }}>
                  {working.line.files}
                </Text>
              )}
              <Anchor
                component="button"
                type="button"
                size="xs"
                style={{ flex: 'none' }}
                onClick={() => {
                  setLogTurn(working.id);
                }}
              >
                Show Log
              </Anchor>
            </>
          }
        />
      )}
      {page.turn === null ? null : (
        <TurnLogDrawer
          turnId={page.turn.id}
          title={`${page.area} · Turn ${String(page.turn.seq)}`}
          opened={logTurn === page.turn.id}
          onClose={() => {
            setLogTurn(null);
          }}
        />
      )}
      {status === PageStatus.Asks && row.ask !== null ? (
        <PageAsk key={row.ask.id} item={row.ask} />
      ) : null}
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
      <PageComposer
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
