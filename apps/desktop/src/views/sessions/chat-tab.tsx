import type { ChatDto, Effort, ProjectViewDto, ToolCallView } from '@10db/contracts';
import { Box, Group, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useEffect, useRef, useState } from 'react';
import { PageLoading, PageLoadingShape } from '../../shell/page-loading';
import { ConversationList, toolDoing, WorkingLine } from '../../conversation';
import { Composer } from '../../conversation/composer';
import { ConversationLayout } from '../../conversation/conversation-layout';
import { composerPhase } from '../../conversation/composer-phase';
import { ContextRing } from '../../conversation/context-ring';
import { EMPTY_DRAFT, hasContent, type Draft } from '../../conversation/drafts';
import { escapeHasOwner, escapeIsTaken } from '../../conversation/escape';
import { itemEntries } from '../../conversation/item-entries';
import { ModelMenu } from '../../conversation/model-menu';
import { nameOf } from '../../conversation/model-menu-options';
import { PermissionRequest, useConversationCards } from '../../conversation/permission-request';
import type { Streaming } from '../../conversation/working-line';
import { fetchConversationFiles, useChatModels, usePatchChat } from '../../daemon/chat-queries';
import {
  useConversation,
  useConversationItemsState,
  useConversationLive,
  useRedoConversation,
  useSendConversationMessage,
  useSendNow,
  useStopConversation,
  useToolCallFull,
} from '../../daemon/conversation-queries';
import { useModels } from '../../daemon/model-queries';
import { useDaemon, useDaemonStatus } from '../../daemon/provider';
import { useResolvedInbox } from '../../daemon/queries';
import dayjs from 'dayjs';
import { chatEntries } from './chat-entries';
import { sessionAnnouncement, type SessionEvent } from './session-announcements';
import { SessionBar } from './session-bar';
import type { TabActions } from './tab-menu';
import { draftKey, sessionDrafts, useSessionDraft } from './session-drafts';

const CONTEXT_TIP = 'Past 70%, the next turn continues in a fresh session with a summary.';

const NARROW_QUERY = '(max-width: 639px)';

/** The message File as Tasks sends, as the builder's own turn (sessions design spec §7.2). */
export const FILE_AS_TASKS_MESSAGE = 'File the work we agreed on as tasks on the Board.';

/** A turn is under way in these states. */
const WORKING_STATES: ReadonlySet<string> = new Set([
  'starting',
  'running',
  'waiting_card',
  'stopping',
]);

export interface ChatTabProps {
  readonly chat: ChatDto;
  /** The chat's project; undefined once the project was removed from 10db. */
  readonly project: ProjectViewDto | undefined;
  /** Says something to the screen's one polite live region. */
  readonly onAnnounce?: (message: string) => void;
  /** What the session bar's ⋯ menu does; without it the menu only renames. */
  readonly actions?: Omit<TabActions, 'onRename'>;
  readonly renaming?: boolean;
  readonly onRenamed?: () => void;
}

/**
 * A chat's tab (sessions UI spec §4, §12): the session bar, then the kit's conversation column: the
 * conversation, the cards it waits on pinned above the composer, and the composer. Each state M5a reaches has its words.
 */
export function ChatTab({ chat, project, onAnnounce, actions, renaming, onRenamed }: ChatTabProps) {
  const conversationQuery = useConversation(chat.conversationId);
  const conversation = conversationQuery.data ?? chat.conversation;
  const { items, loading } = useConversationItemsState(chat.conversationId);
  const live = useConversationLive(chat.conversationId);
  const loadFull = useToolCallFull(chat.conversationId, items);
  const narrow = useMediaQuery(NARROW_QUERY);
  const daemon = useDaemonStatus();
  const { client } = useDaemon();
  const key = draftKey.chat(chat.id);
  const [draft, setDraft] = useSessionDraft(key);
  const send = useSendConversationMessage();
  const stop = useStopConversation();
  const redo = useRedoConversation();
  const sendNow = useSendNow();
  const patch = usePatchChat();
  const resolved = useResolvedInbox();
  const open = useConversationCards(chat.conversationId);
  const [sendError, setSendError] = useState<string | null>(null);
  const [modelRefusal, setModelRefusal] = useState<string | null>(null);
  const models = useChatModels(chat.projectId);
  const modelRows = useModels(null);
  const offered = models.data?.offered ?? [];
  const named = conversation.model ?? models.data?.default ?? null;
  const input = useRef<HTMLTextAreaElement | HTMLInputElement>(null);
  const caps = conversation.capabilities;
  const working = WORKING_STATES.has(conversation.state);
  const removed = project === undefined;

  const post = async (d: Draft): Promise<void> => {
    await send.mutateAsync({
      conversationId: chat.conversationId,
      text: d.text,
      mentions: d.mentions,
      pictures: d.pictures,
    });
  };

  // The composer takes the cursor when the tab is shown (a chat made from a fresh tab keeps typing).
  // The caret goes to the end of what was typed before the tab was a chat, which WebKit leaves at the start.
  useEffect(() => {
    const field = input.current;
    if (field === null) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, [chat.id]);

  // A chat made by a send in a fresh tab sends that draft as soon as it is drawn; a failure leaves the
  // draft here, so the next send goes to this conversation and never to a second chat.
  useEffect(() => {
    if (!sessionDrafts.takeSendRequest(key)) return;
    post(sessionDrafts.get(key))
      .then(() => {
        sessionDrafts.set(key, EMPTY_DRAFT);
      })
      .catch((error: unknown) => {
        setSendError(error instanceof Error ? error.message : String(error));
      });
    // The request is taken once per tab; `post` is the tab's own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Esc is Stop, unless it belongs to something open on top, a form that keeps it or a waiting card.
  const stopNow = (): void => {
    stop.mutate(chat.conversationId);
  };
  const latest = useRef({ working, stopNow });
  useEffect(() => {
    latest.current = { working, stopNow };
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !latest.current.working) return;
      if (escapeIsTaken(event) || escapeHasOwner(event)) return;
      event.preventDefault();
      latest.current.stopNow();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  // What the builder acts on is said once, in the screen's polite region, without the focus moving: a
  // card that has just arrived, a reply that finished, a stop and a pause. Streaming text never is.
  const say = (event: SessionEvent): void => {
    const message = sessionAnnouncement(event);
    if (message !== null) onAnnounce?.(message);
  };
  const seenCards = useRef(open.length);
  useEffect(() => {
    if (open.length > seenCards.current) say({ kind: 'asks', label: caps.label });
    seenCards.current = open.length;
    // `say` only reads `onAnnounce`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, caps.label, onAnnounce]);
  const lastState = useRef(conversation.state);
  useEffect(() => {
    const was = lastState.current;
    const now = conversation.state;
    lastState.current = now;
    if (was === now) return;
    if (now === 'ended_error') say({ kind: 'stopped' });
    else if (now === 'paused_account')
      say({
        kind: 'paused',
        resumes:
          conversation.pausedUntil === null
            ? null
            : dayjs(conversation.pausedUntil).format('HH:mm'),
      });
    else if (WORKING_STATES.has(was) && (now === 'idle_warm' || now === 'idle_cold')) {
      const reply = items.findLast((item) => item.kind === 'agent_message');
      say({
        kind: 'replied',
        label: caps.label,
        text: reply?.kind === 'agent_message' ? reply.text : '',
      });
    }
    // The transition is read once per state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.state]);

  const allow = (call: ToolCallView): void => {
    send.mutate({ conversationId: chat.conversationId, text: `Go ahead: ${call.title}` });
  };

  const entries = chatEntries(
    itemEntries(items, live, {
      sendNow: () => {
        sendNow.mutate(chat.conversationId);
      },
      label: caps.label,
      receipts: caps.receipts,
      working,
      cards: [...(resolved.data ?? []), ...open],
    }),
    { chatId: chat.id, projectId: chat.projectId },
  );
  const ended = conversation.state === 'ended_error';
  const shown = ended
    ? [
        ...entries,
        {
          kind: 'notice' as const,
          id: 'ended',
          text: 'The session stopped. Send a message to start it again.',
          tone: 'error' as const,
        },
      ]
    : entries;

  const lastLive = [...live.values()].at(-1);
  const streaming: Streaming =
    lastLive === undefined
      ? null
      : lastLive.kind === 'agent_message'
        ? 'text'
        : lastLive.kind === 'reasoning'
          ? 'reasoning'
          : 'tool';
  const tool =
    lastLive?.kind === 'tool_call' && lastLive.call !== null ? toolDoing(lastLive.call) : undefined;

  const phase = composerPhase({
    state: conversation.state,
    hasText: hasContent(draft),
    steer: caps.steer,
    project: project?.name ?? '',
    fresh: false,
    narrow,
    slashCommands: caps.slashCommands,
  });
  const reconnecting = daemon.kind === 'reconnecting';
  const disabledReason = reconnecting ? 'Reconnecting… your message stays here.' : null;

  const changeModel = (model: string | null, effort: Effort | null): void => {
    setModelRefusal(null);
    patch.mutate(
      { chatId: chat.id, model, effort },
      {
        onError: (error) => {
          setModelRefusal(error.message);
        },
      },
    );
  };

  return (
    <ConversationLayout
      label="Conversation"
      header={
        <SessionBar
          chat={chat}
          conversation={conversation}
          projectName={project?.name ?? ''}
          loading={loading}
          fileDisabledReason={removed ? 'This project was removed from 10db.' : disabledReason}
          {...(actions === undefined ? {} : { actions })}
          {...(renaming === undefined ? {} : { renaming })}
          {...(onRenamed === undefined ? {} : { onRenamed })}
          onFileAsTasks={() => {
            send.mutate({ conversationId: chat.conversationId, text: FILE_AS_TASKS_MESSAGE });
          }}
        />
      }
      footer={
        <>
          <WorkingLine
            conversation={conversation}
            streaming={streaming}
            {...(tool === undefined ? {} : { tool })}
          />
          <PermissionRequest items={open} />
          {removed ? (
            <Text size="sm" c="dimmed" px="md" py="md">
              This project was removed from 10db.
            </Text>
          ) : (
            <Composer
              draft={draft}
              onDraft={(next) => {
                setSendError(null);
                setDraft(next);
              }}
              capabilities={caps}
              mentions={{
                files: (q, signal) =>
                  fetchConversationFiles(client, chat.conversationId, q, signal),
                commands: conversation.commands,
              }}
              phase={phase}
              disabledReason={disabledReason}
              error={sendError}
              inputRef={input}
              modelControl={
                <Group gap={4} wrap="nowrap">
                  {caps.modelSwitch === 'none' || offered.length === 0 ? (
                    named === null ? null : (
                      <Text size="xs" c="dimmed">
                        {nameOf(named, new Map((modelRows.data ?? []).map((r) => [r.model, r])))}
                      </Text>
                    )
                  ) : (
                    <ModelMenu
                      offered={offered}
                      default={models.data?.default ?? null}
                      picked={conversation.model}
                      effort={conversation.effort}
                      busy={working}
                      pending={patch.isPending}
                      error={modelRefusal}
                      onPick={changeModel}
                    />
                  )}
                  <ContextRing
                    percent={conversation.contextPct}
                    more={[
                      CONTEXT_TIP,
                      ...(conversation.costUsd === null
                        ? []
                        : [`$${conversation.costUsd.toFixed(2)} so far`]),
                    ]}
                  />
                </Group>
              }
              onSend={post}
              onStop={stopNow}
              onRedo={async (d) => {
                await redo.mutateAsync({ conversationId: chat.conversationId, text: d.text });
              }}
            />
          )}
        </>
      }
    >
      {loading ? (
        <Box px="md" pt="md">
          <PageLoading shape={PageLoadingShape.Lines} label="Loading the conversation" />
        </Box>
      ) : null}
      <ConversationList
        entries={shown}
        highlight={null}
        loadFull={loadFull}
        onAllow={allow}
        agentLabel={caps.label}
        busy={streaming !== null}
      />
    </ConversationLayout>
  );
}
