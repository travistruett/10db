import {
  ConversationState,
  type ConversationDto,
  type ProjectId,
  type ShapeId,
  type ShapeViewDto,
  type ToolCallView,
} from '@10db/contracts';
import { ActionIcon, Button, Flex, Group, Loader, Text, Title, Tooltip } from '@mantine/core';
import { IconBooks, IconPlus } from '@tabler/icons-react';
import { Link, useNavigate } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { useEffect, useRef } from 'react';
import { JudgeLine, toolDoing, WorkingLine } from '../../conversation';
import { ConversationLayout } from '../../conversation/conversation-layout';
import { ContextRing } from '../../conversation/context-ring';
import { streamingOf } from '../../conversation/live-items';
import {
  useConversation,
  useConversationItems,
  useConversationLive,
  useSendConversationMessage,
  useSendNow,
  useStopConversation,
} from '../../daemon/conversation-queries';
import { usePlanRecord } from '../../daemon/plan-record-queries';
import {
  useCreateShape,
  useProposeShape,
  useShapeConversation,
  useUploadShapeFile,
} from '../../daemon/shape-queries';
import { formatTokens } from '../factory/format-tokens';
import { AgentsLine } from './agents-line';
import { PlanComposer } from './plan-composer';
import { addFiles } from '../../conversation/dropped-files';
import { HistoryButton } from './history-button';
import { PlanModelMenu } from './plan-model-menu';
import { keepBoth, leaveLate, takeLate, useLate } from './late-outcome';
import { PlanMeasures } from './plan-measures';
import { RecentConversations } from './recent-conversations';
import { Transcript, type TranscriptProps } from './transcript';
import { useShapeKeys } from './use-shape-keys';
import { WaitingPermissions } from './waiting-permissions';

export interface ConversationPaneProps {
  readonly projectId: ProjectId | null;
  /** The open conversation; null on the new-conversation screen, which makes one on the first send. */
  readonly shapeId: ShapeId | null;
  readonly view: ShapeViewDto | undefined;
  readonly loading: boolean;
  readonly error: string | null;
  /** Told the id of a conversation the first send made, to open it. */
  readonly onOpened: (shapeId: ShapeId) => void;
  /** The messages a row's Why? points at. */
  readonly why: TranscriptProps['why'];
}

/**
 * The conversation as the working line shows it: a send on its way wakes an idle session, and a Stop
 * on its way is stopping, before the daemon reports either.
 */
function shownState(
  conversation: ConversationDto,
  pending: { readonly sending: boolean; readonly stopping: boolean },
): ConversationDto {
  const { state } = conversation;
  if (
    pending.stopping &&
    (state === ConversationState.Running || state === ConversationState.WaitingCard)
  )
    return { ...conversation, state: ConversationState.Stopping };
  if (pending.sending && state === ConversationState.IdleCold)
    return { ...conversation, state: ConversationState.Starting };
  if (pending.sending && state === ConversationState.IdleWarm)
    return { ...conversation, state: ConversationState.Running };
  return conversation;
}

/** Left: the conversation's title, its transcript and the input. */
export function ConversationPane({
  projectId,
  shapeId,
  view,
  loading,
  error,
  onOpened,
  why,
}: ConversationPaneProps) {
  const late = useLate(shapeId);
  const navigate = useNavigate();
  // The Record is offered once the Plan holds something to read there: a document or an entry.
  const record = usePlanRecord(shapeId).data;
  const hasRecord =
    record !== undefined && (record.documents.length > 0 || record.counts.evidence > 0);
  const create = useCreateShape(projectId);
  const conversationOf = useShapeConversation();
  const send = useSendConversationMessage();
  const propose = useProposeShape();
  const stop = useStopConversation();
  const sendNow = useSendNow();
  const upload = useUploadShapeFile();
  // The transcript is the conversation's items, then what streams now (sessions spec §10).
  const conversationId = shapeId === null ? null : (view?.conversationId ?? null);
  const conversation = useConversation(conversationId).data;
  const items = useConversationItems(conversationId);
  const live = useConversationLive(conversationId);
  const now = streamingOf(live, new Set(items.map((item) => item.id)));

  // The conversation a first send or drop made, held as the promise of its create so a send and a
  // drop that overlap share one create instead of leaving an empty conversation behind. The screen
  // opens it only once the send succeeds, so a retry after a failure reuses it. A failed create is
  // forgotten, so the retry makes it again. It is remembered with its project: switching project
  // stays on this screen, and a send there must start that project's conversation, not post into
  // the old one.
  const created = useRef<{
    readonly projectId: ProjectId | null;
    readonly id: Promise<ShapeId>;
  } | null>(null);
  const ensureId = (): Promise<ShapeId> => {
    if (shapeId !== null) return Promise.resolve(shapeId);
    if (created.current?.projectId === projectId) return created.current.id;
    const id = create.mutateAsync().then((made) => made.id);
    const entry = { projectId, id };
    created.current = entry;
    id.catch(() => {
      if (created.current === entry) created.current = null;
    });
    return id;
  };

  // A send and a drop finish on their own, so the one that finishes second can find the screen
  // already gone: opened by the first, or left by the builder. `opened` is the conversation the
  // first one opened; only that one navigates, and only while the screen is still here, so a later
  // finish cannot pull the builder back from where they went.
  const here = useRef(true);
  useEffect(() => {
    here.current = true;
    return () => {
      here.current = false;
    };
  }, []);
  const opened = useRef<ShapeId | null>(null);
  // Why the last send on this screen failed, if it failed before anything opened the conversation:
  // a drop that opens it afterwards replaces the input, and this is what it would lose.
  const failedSend = useRef<string | null>(null);
  // What the input holds now. The input unmounts when the conversation opens, so this is what its
  // replacement is given, whatever the builder has typed, edited or cleared since a send failed.
  const typed = useRef('');
  // The text of the last send, unless it failed. The input empties as Send is pressed; one typed again
  // during the send is on its way, so carrying it too would put it back after the send succeeds. Edited, it is the
  // builder's again and is carried as it stands, since nothing can tell which part they meant to
  // keep. A failure clears this at once, so the input's text counts from that moment.
  const sent = useRef<string | null>(null);
  const open = (id: ShapeId): void => {
    if (opened.current !== null) return;
    // Taken once: after the builder has left, every later finish comes through here again.
    const input = typed.current.trim() === sent.current ? '' : typed.current;
    typed.current = '';
    // A send that failed first, with the screen still here, waits for a conversation to be left to.
    // Left too, it must still go: nothing else will, and opening the conversation later shows it.
    // Its text is not put back, since the input may have been edited since; and a builder who
    // cleared the input has dealt with the failure, so it stays behind with the text.
    const hasText = input.trim() !== '';
    if (failedSend.current !== null && hasText) leaveLate(id, { failure: failedSend.current });
    failedSend.current = null;
    if (hasText) leaveLate(id, { draft: input });
    if (!here.current) return;
    opened.current = id;
    onOpened(id);
  };

  const answering = view?.turn.running ?? false;
  // A round, or a proposal, means the builder has been heard, before the items have loaded.
  const heardBuilder =
    items.some((item) => item.kind === 'message') ||
    (view?.shape.round ?? 0) > 0 ||
    (view?.proposals.length ?? 0) > 0;
  // An imported Plan changes only by a re-import: a proposal round would replace what was imported, and
  // the daemon refuses one, so Propose is neither shown nor reached by ⌘⇧↩.
  const importedAt = view?.shape.importedAt ?? null;
  const imported =
    importedAt === null
      ? undefined
      : `Imported ${dayjs(importedAt).format('D MMM YYYY')}. Re-import to change its plan.`;
  const canPropose = shapeId !== null && heardBuilder && importedAt === null;

  const doPropose = (): void => {
    if (canPropose && !(view?.turn.proposing ?? false)) {
      // Only a refusal is cleared: resetting a pending Stop would lose its outcome.
      if (stop.isError) stop.reset();
      propose.mutate(shapeId);
    }
  };
  const queued = view?.turn.queued ?? 0;
  // The longest the queue has been since Stop was pressed. The view has no turn id and `running`
  // stays true from one queued turn to the next, so the queue falling is what says a turn ended.
  const queuedSinceStop = useRef(0);
  const doStop = (): void => {
    if (shapeId !== null) {
      if (propose.isError) propose.reset();
      queuedSinceStop.current = queued;
      if (conversationId !== null) stop.mutate(conversationId);
    }
  };
  // A refused Stop was about the turn that was running. Once that turn has ended the refusal is out
  // of date, so it goes without a send; one still pending is left alone, since resetting it would
  // detach the observer and lose its outcome.
  const stopRefused = stop.isError;
  const resetStop = stop.reset;
  useEffect(() => {
    if (queued > queuedSinceStop.current) queuedSinceStop.current = queued;
    if (stopRefused && (!answering || queued < queuedSinceStop.current)) resetStop();
  }, [stopRefused, answering, queued, resetStop]);
  // The latest mutations, for a send that started before they changed.
  const latest = useRef({ propose, stop });
  useEffect(() => {
    latest.current = { propose, stop };
  });

  // A load failure is what the screen is in now, so it comes first; a refused Propose or Stop is the
  // daemon's words in the same alert.
  const shownError =
    error ?? propose.error?.message ?? stop.error?.message ?? sendNow.error?.message ?? null;
  useShapeKeys({ onPropose: doPropose, onStop: doStop, answering });

  return (
    <ConversationLayout
      label="Conversation"
      h="100%"
      header={
        <Group
          px="md"
          pt="md"
          pb="xs"
          gap="sm"
          wrap="nowrap"
          justify="space-between"
          style={{ flex: 'none' }}
        >
          <Group gap="sm" wrap="nowrap" miw={0}>
            <Title order={2} size="h4">
              Plan
            </Title>
            {shapeId === null ? null : (
              <Text size="sm" fw={500} lineClamp={1}>
                {view?.shape.title}
              </Text>
            )}
            {shapeId !== null && (view?.tokens ?? 0) > 0 ? (
              <Text size="xs" c="dimmed" style={{ flex: 'none', whiteSpace: 'nowrap' }}>
                {formatTokens(view?.tokens ?? 0)} tokens
              </Text>
            ) : null}
            {loading && shapeId !== null ? (
              <Loader size="xs" aria-label="Loading the conversation" />
            ) : null}
          </Group>
          {shapeId === null ? null : (
            <Group gap="xs" wrap="nowrap" align="flex-start">
              {hasRecord ? (
                // An icon, so the header still fits beside the Proposed pane at its narrowest.
                <Tooltip label="Record" withArrow>
                  <ActionIcon
                    variant="default"
                    size={30}
                    aria-label="Record"
                    onClick={() => {
                      void navigate({ to: '/shape/$shapeId/record', params: { shapeId } });
                    }}
                  >
                    <IconBooks size={16} stroke={1.5} />
                  </ActionIcon>
                </Tooltip>
              ) : null}
              <Button
                component={Link}
                to="/shape"
                variant="default"
                size="xs"
                leftSection={<IconPlus size={14} stroke={1.5} />}
              >
                New
              </Button>
              <HistoryButton projectId={projectId} current={shapeId} />
            </Group>
          )}
        </Group>
      }
      footer={
        <>
          {conversation === undefined ? null : (
            <WorkingLine
              conversation={shownState(conversation, {
                sending: send.isPending || propose.isPending,
                stopping: stop.isPending,
              })}
              streaming={now.streaming}
              {...(now.call === null ? {} : { tool: toolDoing(now.call) })}
            />
          )}
          <WaitingPermissions shapeId={shapeId} />
          {view?.turn.waitingForUpdate === true ? (
            <Text role="status" size="sm" c="dimmed" px="md" py="xs" style={{ flex: 'none' }}>
              Waiting for an update to install. If 10db quits for it, this won’t run: send or press
              it again afterwards, even if the install then fails. If the update is called off
              before 10db quits, this runs.
            </Text>
          ) : null}
          <PlanComposer
            modelControl={
              view === undefined ? null : (
                <>
                  <PlanModelMenu view={view} />
                  <ContextRing percent={conversation?.contextPct ?? null} />
                </>
              )
            }
            firstRun={!heardBuilder}
            answering={answering}
            agentLabel={conversation?.capabilities.label ?? 'the agent'}
            proposing={(view?.turn.proposing ?? false) || propose.isPending}
            proposeLabel={(view?.shape.round ?? 0) > 0 ? 'Propose Again' : 'Propose'}
            canPropose={canPropose}
            nothingDecided={(view?.heard.length ?? 0) === 0 && (view?.proposals.length ?? 0) === 0}
            error={shownError}
            files={(view?.files ?? []).map((f) => f.name)}
            late={late}
            {...(imported === undefined ? {} : { imported })}
            onDraft={(text) => {
              typed.current = text;
            }}
            onLateTaken={() => {
              if (shapeId !== null) takeLate(shapeId);
            }}
            onFiles={async (dropped) => {
              // A drop into a conversation that doesn't exist yet starts it, as the first message does.
              const made: { id: ShapeId | null } = { id: shapeId };
              const problems = await addFiles(dropped, view?.files.length ?? 0, {
                ensureConversation: async () => {
                  made.id ??= await ensureId();
                },
                upload: (file) => {
                  if (made.id === null)
                    return Promise.reject(new Error('No conversation to add to.'));
                  return upload.mutateAsync({ shapeId: made.id, file });
                },
              });
              if (shapeId !== null || made.id === null) return problems;
              open(made.id);
              // This input is leaving for the conversation, so the reasons go to the one that replaces it.
              if (problems.length > 0) leaveLate(made.id, { refused: problems });
              return [];
            }}
            onSend={async (text) => {
              const before = latest.current;
              failedSend.current = null;
              sent.current = text;
              let id: ShapeId;
              // Set once the conversation exists, even if the send into it then fails.
              let made: ShapeId | null = null;
              try {
                id = await ensureId();
                made = id;
                await send.mutateAsync({ conversationId: await conversationOf(id), text });
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                sent.current = null;
                if (shapeId !== null) throw error;
                // Where the input went: the conversation a drop opened, or, when the builder left this
                // screen first, the one this send made, so opening it later still shows why.
                const gone = opened.current ?? (here.current ? null : made);
                if (gone === null) {
                  // The drop may still open the conversation and take this input with it. The composer
                  // puts the failed text back ahead of what was typed since; it is counted here at once,
                  // since the drop can open the conversation before the input redraws.
                  failedSend.current = message;
                  typed.current = keepBoth(typed.current, text);
                  throw error;
                }
                // Its input is gone, so the conversation's new one gets the reason and the text, beside
                // whatever the builder's edits left there.
                leaveLate(gone, { failure: message, draft: text });
                return;
              }
              // The daemon took the message, so a refusal of Propose or Stop from before the send is out
              // of date. Only that one is cleared: `mutateAsync` settles after the refetch, so a refusal
              // that arrived during the send is news, and a Propose or Stop still in flight keeps its
              // observer, so its loading state lasts and a refusal that comes later is shown.
              const { propose: nowPropose, stop: nowStop } = latest.current;
              if (nowPropose.isError && nowPropose.error === before.propose.error)
                nowPropose.reset();
              if (nowStop.isError && nowStop.error === before.stop.error) nowStop.reset();
              if (shapeId === null) open(id);
            }}
            onPropose={doPropose}
            onStop={doStop}
          />
        </>
      }
      after={
        shapeId === null ? (
          <Flex
            wrap="wrap"
            gap="md"
            align="flex-start"
            style={{ flex: 'none', maxHeight: '45%', overflowY: 'auto' }}
          >
            <RecentConversations projectId={projectId} />
            <PlanMeasures />
          </Flex>
        ) : null
      }
    >
      {conversation === undefined ? null : (
        <>
          <JudgeLine judge={conversation.capabilities.judge} />
          <AgentsLine
            subagents={conversation.capabilities.subagents}
            agentLabel={conversation.capabilities.label}
          />
        </>
      )}
      <Transcript
        // Its own per conversation, so another Plan from History opens at its newest message.
        key={shapeId ?? 'new'}
        shapeId={shapeId}
        conversation={conversation}
        items={items}
        live={live}
        why={why}
        busy={now.streaming === 'text'}
        onSendNow={() => {
          if (conversationId !== null) sendNow.mutate(conversationId);
        }}
        onAllow={(call: ToolCallView) => {
          if (conversationId !== null)
            send.mutate({ conversationId, text: `Go ahead: ${call.title}` });
        }}
      />
    </ConversationLayout>
  );
}
