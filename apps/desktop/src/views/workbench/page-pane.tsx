import {
  ConversationState,
  type PassId,
  type ProjectId,
  type PassTurnId,
  type ToolCallView,
} from '@10db/contracts';
import { Anchor, Group, Text } from '@mantine/core';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toolDoing, WorkingLine } from '../../conversation';
import { ConversationLayout } from '../../conversation/conversation-layout';
import type { Draft, DraftChange } from '../../conversation/drafts';
import { streamingOf } from '../../conversation/live-items';
import { useConversationItems, useConversationLive } from '../../daemon/conversation-queries';
import { useMarkOpened, useTurns } from '../../daemon/pass-queries';
import { useSignOff } from '../../daemon/pass-close-queries';
import { CodeSpans } from '../../shell/code-spans';
import { useFrameSlots } from '../../shell/frame-slots';
import { TitleRow } from '../../shell/title-row';
import { hasTyped } from '../../conversation/drafts';
import { liveLine } from './live-line';
import { useOpenPage } from './open-page';
import { OpenPageRefusal } from './open-page-button';
import { PageAsk } from './page-ask';
import { usePageActions } from './page-actions';
import { PageComposer } from './page-composer';
import { pageComposerPhase, pagePhase } from './page-composer-phase';
import { PageTitleActions } from './page-title-actions';
import { PageStatus } from './page-status';
import { QUEUE_ATTRIBUTE } from './queue-list';
import type { QueueRow } from './queue-rows';
import { RetryTurn } from './retry-turn';
import { PageThread } from './page-thread';
import { SignOffLine } from './sign-off-line';
import { TurnLogDrawer } from './turn-log-drawer';
import { focusIsPreviews } from './preview-focus';
import { useWorkbenchKeys } from './use-workbench-keys';
import { WorkbenchKey } from './workbench-keys';

export interface PagePaneProps {
  readonly passId: PassId;
  /** The project's app address, which Open in Browser opens the page's route on. */
  readonly appUrl: string | null;
  /** The page's project and its folder, for its Preview window. */
  readonly projectId: ProjectId;
  readonly repoPath: string;
  /** Counts the Preview bringing the window forward on this page: its picks take the cursor. */
  readonly picksFocus: number;
  readonly row: QueueRow;
  /** The pass is open: while it closes or is abandoned, nothing can be sent to a page. */
  readonly passOpen: boolean;
  /** When the builder first opened the page's latest turn; null while it never has. */
  readonly openedAt: string | null;
  /** Counts the window gaining focus: each time, the composer takes the cursor. */
  readonly composerFocus: number;
  readonly draft: Draft;
  readonly onDraft: (change: DraftChange) => void;
  /** The pass's pull request control, shown under a signed-off page as its next step. */
  readonly pullRequest?: ReactNode;
  /** The pane's own header, in place of the page's label. */
  readonly header?: ReactNode;
}

/**
 * The shown page: its thread on the kit's list, the kit's working line while a turn works, and its
 * composer fixed at the foot. What the page's session streams reaches it live.
 */
export function PagePane(props: PagePaneProps) {
  const { passId, appUrl, row, passOpen, openedAt, composerFocus, draft, onDraft, pullRequest } =
    props;
  const { header, projectId, repoPath, picksFocus } = props;
  const { panelShown } = useFrameSlots();
  const { page, status } = row;
  const actions = usePageActions(page.taskId, page.conversationId);
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
  const open = useOpenPage({
    passId,
    taskId: page.taskId,
    route: page.route,
    appUrl,
    preview: { projectId, repoPath, label: page.label },
  });
  // Commit's variant follows the composer's phase: the primary once the page is ready and nothing is typed.
  const { commit: commitVariant } = pageComposerPhase(pagePhase(status), {
    typed: hasTyped(draft),
    picks: (draft.picks?.length ?? 0) > 0,
    label: page.label,
    firstMessage: !page.spokenTo,
  });
  const signOff = useSignOff();
  const pageActions = (
    <PageTitleActions
      open={open}
      commit={commitVariant}
      commitDisabled={!passOpen}
      committing={signOff.isPending && signOff.variables.taskId === page.taskId}
      onCommit={() => {
        signOff.mutate({ passId, taskId: page.taskId });
      }}
    />
  );
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
    // A page the Preview asked for takes the cursor on its picks, never in its input.
    if (focusIsPreviews()) return;
    if (asked || (moved && !document.activeElement?.closest(`[${QUEUE_ATTRIBUTE}]`)))
      input.current?.focus();
  }, [page.taskId, composerFocus]);
  return (
    <>
      {panelShown ? (
        <TitleRow
          title={page.label}
          meta={
            <CodeSpans
              text={page.route === null ? row.state.line : `${row.state.line} · ${page.route}`}
            />
          }
          actions={pageActions}
        />
      ) : null}
      <ConversationLayout
        label={page.label}
        // While the panel is drawn the page's actions are the title row's; otherwise they are the pane's bar.
        header={
          header ??
          (panelShown ? undefined : (
            <Group px="md" py={6} gap="xs" justify="space-between" wrap="wrap">
              <Text size="sm" fw={600} truncate="end" style={{ minWidth: 0 }}>
                {page.label}
              </Text>
              {pageActions}
            </Group>
          ))
        }
        footer={
          <>
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
                title={`${page.label} · Turn ${String(page.turn.seq)}`}
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
            {passOpen && status === PageStatus.SignedOff && pullRequest !== undefined ? (
              // The next step sits where the builder signed off, not only in the header above the thread.
              <Group px="md" py="xs" gap="sm" justify="space-between" wrap="wrap">
                {pullRequest}
              </Group>
            ) : null}
            {open.refusal === null ? null : (
              <Group px="md" pb="xs">
                <OpenPageRefusal refusal={open.refusal} />
              </Group>
            )}
            <PageComposer
              // Its own per page: a send that settles after a switch clears the page that sent it.
              key={page.taskId}
              label={page.label}
              status={status}
              firstMessage={!page.spokenTo}
              draft={draft}
              onDraft={onDraft}
              actions={actions}
              error={
                signOff.variables?.taskId === page.taskId ? (signOff.error?.message ?? null) : null
              }
              inputRef={input}
              disabled={!passOpen}
              projectId={projectId}
              route={page.route}
              picksFocus={picksFocus}
            />
          </>
        }
      >
        <PageThread
          // Its own per page, so each page opens at its newest message.
          key={page.taskId}
          page={page}
          turns={turns}
          live={live}
          busy={streaming.streaming === 'text'}
          canSend={passOpen}
          onAllow={(call: ToolCallView) => {
            void actions.send({ text: `Go ahead: ${call.title}`, mentions: [], pictures: [] });
          }}
        />
      </ConversationLayout>
    </>
  );
}
