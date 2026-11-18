import {
  ConversationState,
  FolderHolderKind,
  FolderWhileHeld,
  INBOX_PAGE_SIZE_MAX,
  WorkPlace,
  InboxListState,
  type ChatDto,
  type Effort,
  type ProjectViewDto,
  type ToolCallView,
} from '@10db/contracts';
import { Alert, Box, Button, Group, Text } from '@mantine/core';
import { useClipboard, useElementSize } from '@mantine/hooks';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PageLoading, PageLoadingShape } from '../../shell/page-loading';
import { ConversationList, toolDoing, WorkingLine } from '../../conversation';
import { Composer } from '../../conversation/composer';
import { ConversationLayout } from '../../conversation/conversation-layout';
import { composerPhase } from '../../conversation/composer-phase';
import { afterFailedSend, EMPTY_DRAFT, hasContent, type Draft } from '../../conversation/drafts';
import { escapeHasOwner, escapeIsTaken } from '../../conversation/escape';
import { itemEntries } from '../../conversation/item-entries';
import { ModelMenu } from '../../conversation/model-menu';
import { nameOf } from '../../conversation/model-menu-options';
import { BackgroundTasks } from '../../conversation/background-tasks';
import { latestTodos, TodoList } from '../../conversation/todo-list';
import { PermissionRequest, useConversationCards } from '../../conversation/permission-request';
import type { Streaming } from '../../conversation/working-line';
import { fetchConversationFiles, useChatModels, usePatchChat } from '../../daemon/chat-queries';
import { useChatChanges } from '../../daemon/chat-changes-queries';
import { useChatWork, useChooseWork, type ChoseWork } from '../../daemon/chat-work-queries';
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
import { useProjectFolder } from '../../daemon/project-folder-queries';
import { useDaemon, useDaemonStatus } from '../../daemon/provider';
import { useInboxPage } from '../../daemon/queries';
import { useHandBack, useTakeover, useTakeoverCommand } from '../../daemon/takeover-queries';
import dayjs from 'dayjs';
import { chatEntries } from './chat-entries';
import { FolderWait } from './folder-wait';
import { keepingWords } from './folder-holders';
import { useOpenTask } from './open-session';
import { useTaskSession } from '../../daemon/task-session-queries';
import { sessionAnnouncement, type SessionEvent } from './session-announcements';
import { JudgeLine } from '../../conversation';
import { SessionTitle } from './session-title';
import { settledWords, WorkBar } from './work-bar';
import { ChangesDrawer, BESIDE_PX, DRAWER_WIDTH } from './changes-drawer';
import { barHidden } from './bar-hidden';
import { changesChoice } from './changes-choice';
import { changesTotals, withQuote } from './changes-files';
import { GitStepButton } from './git-step-button';
import { useSessionKeys } from './use-session-keys';
import { sessionMeta } from './session-meta';
import type { SessionActions } from './session-menu';
import { TerminalBanner } from './terminal-banner';
import { draftKey, sessionDrafts, useSessionDraft } from './session-drafts';

/** Under this width of the tab itself the composer drops its long labels. */
const NARROW_PX = 640;

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
  /** The ⌄ beside the title. */
  readonly switcher: ReactNode;
  /** What the title row's ⋯ menu does besides renaming and File as Tasks. */
  readonly actions: Omit<SessionActions, 'onRename' | 'onFileAsTasks' | 'onOpenInTerminal'>;
  readonly renaming?: boolean;
  readonly onRenamed?: () => void;
  /** The builder asked to open the chat in a terminal from the strip. */
  readonly openingTerminal?: boolean;
  readonly onTerminalAsked?: () => void;
}

/** What stands where a sealed chat's composer was: its work moved to a task, which the line opens. */
function HandedOffLine({ chat }: { readonly chat: ChatDto }) {
  const session = useTaskSession(chat.taskId).data;
  const openTask = useOpenTask();
  return (
    <Group
      mx="md"
      my="sm"
      px="sm"
      py="xs"
      gap="sm"
      wrap="nowrap"
      justify="space-between"
      style={{
        border: '1px solid var(--mantine-color-default-border)',
        borderRadius: 'var(--mantine-radius-md)',
      }}
    >
      <Text size="sm" role="status">
        This chat handed its work to <b>{session?.title ?? 'a task'}</b>. It&apos;s read-only now.
      </Text>
      {session === undefined ? null : (
        <Button
          size="xs"
          variant="default"
          onClick={() => {
            void openTask({ taskId: session.taskId, projectId: chat.projectId });
          }}
        >
          Open Task
        </Button>
      )}
    </Group>
  );
}

/**
 * A chat's tab (sessions UI spec §4, §12): the session bar, then the kit's conversation column: the
 * conversation, the cards it waits on pinned above the composer, and the composer. Each state M5a reaches has its words.
 */
export function ChatTab({
  chat,
  project,
  onAnnounce,
  switcher,
  actions,
  renaming,
  onRenamed,
  openingTerminal,
  onTerminalAsked,
}: ChatTabProps) {
  const conversationQuery = useConversation(chat.conversationId);
  const conversation = conversationQuery.data ?? chat.conversation;
  const { items, loading } = useConversationItemsState(chat.conversationId);
  const live = useConversationLive(chat.conversationId);
  const loadFull = useToolCallFull(chat.conversationId, items);
  // The tab's own width, not the window's; an unmeasured tab reads 0 and is not narrow.
  const { ref: sizeRef, width } = useElementSize();
  const narrow = width > 0 && width < NARROW_PX;
  const daemon = useDaemonStatus();
  const { client } = useDaemon();
  const key = draftKey.chat(chat.id);
  const [draft, setDraft] = useSessionDraft(key);
  const send = useSendConversationMessage();
  const stop = useStopConversation();
  const redo = useRedoConversation();
  const sendNow = useSendNow();
  const patch = usePatchChat();
  // The chat's project's latest resolved cards, so a card answered in the transcript still shows its answer.
  const resolved = useInboxPage({
    state: InboxListState.Resolved,
    project: chat.projectId,
    page: 1,
    pageSize: INBOX_PAGE_SIZE_MAX,
  });
  const openTask = useOpenTask();
  const open = useConversationCards(chat.conversationId);
  const [sendError, setSendError] = useState<string | null>(null);
  const inTerminal = conversation.state === ConversationState.TakenOver;
  const takeover = useTakeover(chat.conversationId, inTerminal);
  const handBack = useHandBack();
  const takeoverCommand = useTakeoverCommand();
  const clipboard = useClipboard({ timeout: 1500 });
  // A command the clipboard refused, which the banner shows to copy by hand: the open's, or Copy Command's.
  const [uncopied, setUncopied] = useState<string | null>(null);
  const [lastCommand, setLastCommand] = useState<string | null>(null);
  const [modelRefusal, setModelRefusal] = useState<string | null>(null);
  // A git step the daemon refused or that failed, until the builder dismisses it.
  const [gitError, setGitError] = useState<string | null>(null);
  const models = useChatModels(chat.projectId);
  const folder = useProjectFolder(chat.projectId);
  const work = useChatWork(chat.id);
  const choose = useChooseWork();
  // Changes: the button shows once anything changed; the builder's choice to open or close it holds for the session.
  // A session that has not chosen where to work, or is moving, has no root to read yet: the daemon refuses.
  const placed = chat.work?.place === WorkPlace.Here || chat.work?.place === WorkPlace.Branch;
  const changes = useChatChanges(chat.id, placed);
  const totals = changes.data === undefined ? null : changesTotals(changes.data.files);
  const hasChanges = totals !== null && totals.files > 0;
  // A session whose worktree is gone has no diff to read; its pull request has the changes, which the drawer links.
  const offersChanges =
    hasChanges || (changes.isError && (work.data?.pullRequest ?? null) !== null);
  const [changesOpen, setChangesOpen] = useState(() => changesChoice.get(chat.id) === true);
  const toggleChanges = (): void => {
    changesChoice.set(chat.id, !changesOpen);
    setChangesOpen(!changesOpen);
  };
  useSessionKeys((key) => {
    if (key.kind !== 'changes' || (!offersChanges && !changesOpen)) return false;
    toggleChanges();
    return true;
  });
  // Esc hides the bar until a refused change asks again, which changes `askedAt`.
  const [hiddenFor, setHiddenFor] = useState<string | null | undefined>(() =>
    barHidden.get(chat.id),
  );
  const [settled, setSettled] = useState<{
    readonly work: ChoseWork['work'];
    readonly askedAt: string | null;
  } | null>(null);
  const place = chat.work?.place ?? null;
  const askedAt = chat.work?.askedAt ?? null;
  const asking = place === WorkPlace.Choosing && hiddenFor !== askedAt;
  // The branch the checkout is on, as the work state read it; Your folder's read stands in until it arrives.
  const checkoutBranch = work.data?.branch ?? folder?.branch ?? null;
  // What a lost choice said is kept until the next question is asked, which the bar's own line cannot do.
  const shownSettled =
    settled !== null && (askedAt === null || settled.askedAt === askedAt) ? settled.work : null;
  const movingTo = place === WorkPlace.Moving ? (chat.work?.branch ?? null) : null;
  // Holders that keep this chat's turn from writing: Send asks before a message runs.
  const keeping = keepingWords(chat, folder);
  // A message that chose to wait is listed by the daemon as this chat waiting, whoever still holds the folder.
  const waiting = (folder?.holders ?? []).some(
    (h) => h.kind === FolderHolderKind.WaitingChat && h.chatId === chat.id,
  );
  // A send that names no folder would cancel the wait, so while the chat waits it asks to keep waiting.
  const whileWaiting: FolderWhileHeld | undefined = waiting ? FolderWhileHeld.Wait : undefined;
  const modelRows = useModels(null);
  const offered = models.data?.offered ?? [];
  const named = conversation.model ?? models.data?.default ?? null;
  const input = useRef<HTMLTextAreaElement | HTMLInputElement>(null);
  const asked = useRef(asking);
  useEffect(() => {
    asked.current = asking;
  });
  const caps = conversation.capabilities;
  const working = WORKING_STATES.has(conversation.state);
  const removed = project === undefined;

  const post = async (d: Draft): Promise<void> => {
    const chosen = whileWaiting;
    await send.mutateAsync({
      conversationId: chat.conversationId,
      text: d.text,
      mentions: d.mentions,
      pictures: d.pictures,
      ...(chosen === undefined ? {} : { folder: chosen }),
    });
  };

  // The composer takes the cursor when the tab is shown (a chat made from a fresh tab keeps typing).
  // The caret goes to the end of what was typed before the tab was a chat, which WebKit leaves at the start.
  useEffect(() => {
    const field = input.current;
    // A chat in the terminal puts the focus on Hand Back, the likely next act; a bar asking where the work
    // happens takes it, so 1, 2 and Esc work at once.
    if (field === null || inTerminal || asked.current) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
    // The focus moves when the tab is shown, not each time the chat changes state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.id]);

  // A chat made by a send in a fresh tab sends what the fresh tab sent as soon as it is drawn; a failure
  // puts it back in this tab's input, so the next send goes to this conversation and never to a second chat.
  useEffect(() => {
    const request = sessionDrafts.takeSendRequest(key);
    if (request === null) return;
    post(request.draft).catch((error: unknown) => {
      sessionDrafts.set(key, afterFailedSend(sessionDrafts.get(key), request.draft));
      setSendError(error instanceof Error ? error.message : String(error));
    });
    // The request is taken once per tab; `post` is the tab's own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Esc is Stop, unless it belongs to something open on top, a form that keeps it or a waiting card.
  const stopNow = (): void => {
    stop.mutate(chat.conversationId);
  };
  const closeChanges = (): void => {
    changesChoice.set(chat.id, false);
    setChangesOpen(false);
  };
  const latest = useRef({ working, stopNow, changesOpen, closeChanges });
  useEffect(() => {
    latest.current = { working, stopNow, changesOpen, closeChanges };
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // The Changes drawer is a dialog that is not modal: Esc closes it wherever focus is, before it can
      // read as a layer that owns the key or as a Stop.
      if (latest.current.changesOpen && !event.defaultPrevented && !escapeHasOwner(event)) {
        const others = [...document.querySelectorAll('[role="dialog"]')].some(
          (d) => d.getAttribute('aria-modal') !== 'false',
        );
        if (!others && document.querySelector('[role="menu"]') === null) {
          event.preventDefault();
          latest.current.closeChanges();
          return;
        }
      }
      if (!latest.current.working) return;
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

  // The go-ahead is a message like any other.
  const allow = (call: ToolCallView): void => {
    void post({ ...EMPTY_DRAFT, text: `Go ahead: ${call.title}` }).catch((error: unknown) => {
      setSendError(error instanceof Error ? error.message : String(error));
    });
  };

  const entries = chatEntries(
    itemEntries(items, live, {
      sendNow: () => {
        sendNow.mutate(chat.conversationId);
      },
      label: caps.label,
      receipts: caps.receipts,
      working,
      inTerminal,
      cards: [...(resolved.data?.items ?? []), ...open],
      openTask: (task) => {
        void openTask({ taskId: task.taskId, projectId: chat.projectId });
      },
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
    movingTo,
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
    <Box
      ref={sizeRef}
      style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      {/* The measured box keeps its width; this one gives the drawer's share of the surface up. */}
      <Box
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          paddingRight: changesOpen && width >= BESIDE_PX ? DRAWER_WIDTH : 0,
        }}
      >
        <SessionTitle
          chat={chat}
          conversation={conversation}
          meta={sessionMeta({
            projectName: project?.name ?? '',
            place,
            movingTo,
            state: work.data,
            terminalSince:
              takeover.data === undefined ? null : dayjs(takeover.data.since).format('HH:mm'),
            inTerminal,
          })}
          steps={
            <>
              {offersChanges || changesOpen ? (
                <Button
                  size="compact-sm"
                  variant="default"
                  aria-pressed={changesOpen}
                  onClick={toggleChanges}
                >
                  {totals === null || !hasChanges
                    ? 'Changes'
                    : `Changes +${String(totals.added)} −${String(totals.removed)}`}
                </Button>
              ) : null}
              {work.data === undefined || removed ? null : (
                <GitStepButton
                  chatId={chat.id}
                  state={work.data}
                  title={chat.title}
                  turnRunning={working}
                  onError={setGitError}
                />
              )}
            </>
          }
          switcher={switcher}
          projectPath={project?.repoPath ?? null}
          actions={{
            ...actions,
            ...(removed || reconnecting
              ? {}
              : {
                  onFileAsTasks: () => {
                    void post({ ...EMPTY_DRAFT, text: FILE_AS_TASKS_MESSAGE }).catch(
                      (error: unknown) => {
                        setSendError(error instanceof Error ? error.message : String(error));
                      },
                    );
                  },
                }),
          }}
          {...(renaming === undefined ? {} : { renaming })}
          {...(onRenamed === undefined ? {} : { onRenamed })}
          {...(openingTerminal === undefined ? {} : { openingTerminal })}
          {...(onTerminalAsked === undefined ? {} : { onTerminalAsked })}
          onTerminalUncopied={setUncopied}
        />
        {gitError === null ? null : (
          <Alert
            role="alert"
            color="red"
            mx="md"
            mt="xs"
            py={6}
            withCloseButton
            closeButtonLabel="Dismiss"
            onClose={() => {
              setGitError(null);
            }}
          >
            {gitError}
          </Alert>
        )}
        <ConversationLayout
          label="Conversation"
          header={<JudgeLine judge={caps.judge} />}
          footer={
            <>
              {caps.plan ? (
                <TodoList
                  steps={latestTodos(items)}
                  working={working}
                  cardWaiting={open.length > 0}
                />
              ) : null}
              <WorkingLine
                conversation={conversation}
                streaming={streaming}
                {...(tool === undefined ? {} : { tool })}
              />
              <PermissionRequest items={open} />
              <BackgroundTasks
                capabilities={caps}
                tasks={conversation.backgroundTasks}
                cardWaiting={open.length > 0}
              />
              {inTerminal ? (
                <TerminalBanner
                  label={caps.label}
                  since={takeover.data?.since ?? null}
                  notes={takeover.data?.notes ?? []}
                  onHandBack={() => {
                    setUncopied(null);
                    setLastCommand(null);
                    handBack.mutate(chat.conversationId);
                  }}
                  handingBack={handBack.isPending}
                  onCopyCommand={() => {
                    takeoverCommand.mutate(chat.conversationId, {
                      onSuccess: ({ line }) => {
                        setLastCommand(line);
                        clipboard.copy(line);
                      },
                    });
                  }}
                  copied={clipboard.copied}
                  line={uncopied ?? (clipboard.error === null ? null : lastCommand)}
                  error={handBack.error?.message ?? takeoverCommand.error?.message ?? null}
                />
              ) : null}
              {waiting ? (
                <FolderWait holders={keeping} branch={checkoutBranch} onStop={stopNow} />
              ) : null}
              {asking && !removed && conversation.state !== 'sealed' ? (
                <WorkBar
                  key={askedAt ?? 'asked'}
                  agentLabel={caps.label}
                  branch={checkoutBranch}
                  state={work.data}
                  pending={choose.isPending}
                  settled={shownSettled}
                  error={choose.error?.message ?? null}
                  onHide={() => {
                    barHidden.set(chat.id, askedAt);
                    setHiddenFor(askedAt);
                    input.current?.focus();
                  }}
                  onChoose={(next) => {
                    choose.mutate(
                      { chatId: chat.id, place: next },
                      {
                        onSuccess: (answer) => {
                          setSettled(answer.chosen ? null : { work: answer.work, askedAt });
                          // The bar goes with the answer, and the focus it held goes to the composer.
                          input.current?.focus();
                        },
                      },
                    );
                  }}
                />
              ) : null}
              {!asking && shownSettled !== null ? (
                <Text size="xs" c="dimmed" px="md" role="status">
                  {settledWords(shownSettled)}
                </Text>
              ) : null}
              {conversation.state === 'sealed' ? (
                <HandedOffLine chat={chat} />
              ) : removed ? (
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
                            {nameOf(
                              named,
                              new Map((modelRows.data ?? []).map((r) => [r.model, r])),
                            )}
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
      </Box>
      <ChangesDrawer
        opened={changesOpen}
        onClose={() => {
          changesChoice.set(chat.id, false);
          setChangesOpen(false);
        }}
        changes={changes}
        pullRequest={work.data?.pullRequest?.url ?? null}
        onQuote={(text) => {
          setDraft({ ...draft, text: withQuote(draft.text, text) });
        }}
      />
    </Box>
  );
}
