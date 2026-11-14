import type { ChatDto, ProjectViewDto, ToolCallView } from '@10db/contracts';
import { Alert, Box, Button, Group, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useEffect, useRef, useState } from 'react';
import { ConversationList, toolDoing, WorkingLine } from '../../conversation';
import { Composer } from '../../conversation/composer';
import { composerPhase } from '../../conversation/composer-phase';
import { EMPTY_DRAFT, hasContent, type Draft } from '../../conversation/drafts';
import { escapeHasOwner, escapeIsTaken } from '../../conversation/escape';
import { itemEntries } from '../../conversation/item-entries';
import { PermissionRequest, useConversationCards } from '../../conversation/permission-request';
import type { Streaming } from '../../conversation/working-line';
import { fetchConversationFiles, usePatchChat } from '../../daemon/chat-queries';
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
import { useDaemon, useDaemonStatus } from '../../daemon/provider';
import { useResolvedInbox } from '../../daemon/queries';
import { chatEntries } from './chat-entries';
import { SessionBar } from './session-bar';
import { draftKey, sessionDrafts, useSessionDraft } from './session-drafts';

const NARROW_QUERY = '(max-width: 639px)';

/** The message File as Tasks sends, as the builder's own turn (sessions design spec §7.2). */
export const FILE_AS_TASKS_MESSAGE = 'File the work we agreed on as tasks on the Board.';

/** After this long without the transcript, three static dim lines say it is on its way. */
const LOADING_LINES_AFTER_MS = 300;

/** A turn is under way in these states. */
const WORKING_STATES: ReadonlySet<string> = new Set([
  'starting',
  'running',
  'waiting_card',
  'stopping',
]);

/** Three static dim lines, with no shimmer: what the column shows while a long transcript loads. */
function LoadingLines({ loading }: { readonly loading: boolean }) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => {
      setLate(true);
    }, LOADING_LINES_AFTER_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [loading]);
  if (!loading || !late) return null;
  return (
    <Box px="md" pt="md" aria-hidden="true" data-loading-lines>
      {[0.9, 0.7, 0.8].map((width) => (
        <Box
          key={width}
          h={12}
          mb={10}
          w={`${String(width * 100)}%`}
          bg="var(--mantine-color-default-hover)"
          style={{ borderRadius: 'var(--mantine-radius-sm)' }}
        />
      ))}
    </Box>
  );
}

export interface ChatTabProps {
  readonly chat: ChatDto;
  /** The chat's project; undefined once the project was removed from 10db. */
  readonly project: ProjectViewDto | undefined;
  /** Says something to the screen's one polite live region. */
  readonly onAnnounce?: (message: string) => void;
}

/**
 * A chat's tab (sessions UI spec §4, §12): the session bar, the conversation in a 720 px column, the
 * cards it waits on pinned above the composer, and the composer. Each state M5a reaches has its words.
 */
export function ChatTab({ chat, project, onAnnounce }: ChatTabProps) {
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
  const bar = useRef<HTMLDivElement>(null);
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
  useEffect(() => {
    input.current?.focus();
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

  // A card that has just arrived is said once, so a screen reader hears it without the focus moving.
  const seenCards = useRef(open.length);
  useEffect(() => {
    if (open.length > seenCards.current) {
      onAnnounce?.(
        `${caps.label} needs an answer: ${open[open.length - 1]?.title ?? ''}. Answer it above the message box.`,
      );
    }
    seenCards.current = open.length;
  }, [open, caps.label, onAnnounce]);

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

  const changeModel = (model: string | null): void => {
    setModelRefusal(null);
    patch.mutate(
      { chatId: chat.id, model },
      {
        onError: (error) => {
          setModelRefusal(error.message);
        },
      },
    );
  };

  return (
    <Box style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div ref={bar} style={{ flex: 'none' }}>
        <SessionBar
          chat={chat}
          conversation={conversation}
          projectName={project?.name ?? ''}
          loading={loading}
          working={working}
          modelPending={patch.isPending}
          modelError={null}
          onModel={changeModel}
          fileDisabledReason={removed ? 'This project was removed from 10db.' : disabledReason}
          onFileAsTasks={() => {
            send.mutate({ conversationId: chat.conversationId, text: FILE_AS_TASKS_MESSAGE });
          }}
        />
      </div>
      <Box
        maw={720}
        w="100%"
        mx="auto"
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
      >
        <LoadingLines loading={loading} />
        <ConversationList
          entries={shown}
          highlight={null}
          loadFull={loadFull}
          onAllow={allow}
          agentLabel={caps.label}
          busy={streaming !== null}
        />
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
          <>
            {modelRefusal === null ? null : (
              <Alert color="red" mx="md" mb="xs" title="Not available on this account">
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <Text size="sm">{modelRefusal}</Text>
                  <Button
                    size="compact-sm"
                    variant="default"
                    onClick={() => {
                      setModelRefusal(null);
                      bar.current
                        ?.querySelector<HTMLInputElement>('input[aria-label="Model"]')
                        ?.focus();
                    }}
                  >
                    Choose Another Model
                  </Button>
                </Group>
              </Alert>
            )}
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
              onSend={post}
              onStop={stopNow}
              onRedo={async (d) => {
                await redo.mutateAsync({ conversationId: chat.conversationId, text: d.text });
              }}
            />
          </>
        )}
      </Box>
    </Box>
  );
}
