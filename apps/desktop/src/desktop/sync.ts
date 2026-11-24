import {
  ChatId,
  ConversationId,
  EventType,
  InboxItemId,
  LANE_STATES,
  WorkstreamState,
  type ChatDto,
  type InboxItemDto,
} from '@10db/contracts';
import { useComputedColorScheme } from '@mantine/core';
import { CancelledError, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { chatKeys, useOpenChats } from '../daemon/chat-queries';
import { conversationQueryOptions, readConversationItems } from '../daemon/conversation-queries';
import { useEventStream } from '../daemon/events';
import { livePassesOptions } from '../daemon/pass-queries';
import { useDaemon } from '../daemon/provider';
import {
  inboxQueryOptions,
  queryKeys,
  useInbox,
  useKeepAwake,
  useWorkstreams,
} from '../daemon/queries';
import { useSessionsSettings } from '../daemon/sessions-settings-queries';
import { useSelectedProject } from '../shell/selected-project';
import { useOpenSession } from '../views/sessions/open-session';
import { useOpenInboxCount } from '../views/inbox/inbox-count';
import {
  firstLineOf,
  listenForChatClicks,
  notifyChatCard,
  notifyChatReplied,
  type ChatTarget,
} from './notify-chat';
import {
  listenForPassClicks,
  notifyPassReady,
  readyPageOf,
  type PassPageTarget,
} from './notify-pass';
import {
  answeredNotice,
  askedNotices,
  disagreementNotices,
  shouldNotifyOpened,
  triagedToBuilder,
} from './notify-card';
import {
  bringWindowForward,
  isTauri,
  notifyNewCard,
  notifyText,
  setWindowTheme,
  updateTray,
} from './tauri';

/** How often a card's read is asked again when an event's refetch of the Inbox cancels it. */
const INBOX_READ_ATTEMPTS = 3;

/** Workstreams that hold a lane or wait on the builder: what the menu bar counts as running. */
const BUSY_STATES: readonly WorkstreamState[] = [...LANE_STATES, WorkstreamState.WaitingHuman];

/**
 * The one event stream, the menu-bar counts, new-card notifications and the native window's theme.
 * Mounted once by AppLayout.
 */
export function useDesktopSync(): void {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { select } = useSelectedProject();
  const lanes =
    useWorkstreams({ active: true }).data?.filter((w) => BUSY_STATES.includes(w.state)).length ?? 0;
  const inbox = useOpenInboxCount();
  const keepAwake = useKeepAwake().data?.active ?? false;

  const scheme = useComputedColorScheme('dark');

  useEffect(() => {
    updateTray({ lanes, inbox, keepAwake });
  }, [lanes, inbox, keepAwake]);

  useEffect(() => {
    setWindowTheme(scheme).catch((error: unknown) => {
      console.warn('10db: could not set the window theme', error);
    });
  }, [scheme]);

  // A click on a ready notification selects its project and page and brings the window forward. The
  // listener is registered once, at mount: a notification sent before it would never report a click.
  const openPage = useRef<(target: PassPageTarget) => void>(() => undefined);
  useEffect(() => {
    openPage.current = (target) => {
      select(target.projectId);
      void navigate({ to: '/workbench', search: { task: target.taskId } });
      bringWindowForward().catch((error: unknown) => {
        console.warn('10db: could not bring the window forward', error);
      });
    };
  });
  useEffect(
    () =>
      listenForPassClicks((target) => {
        openPage.current(target);
      }),
    [],
  );

  // A click on a chat's notification opens its tab and brings the window forward.
  const openSession = useOpenSession();
  const openChat = useRef<(target: ChatTarget) => void>(() => undefined);
  useEffect(() => {
    openChat.current = (target) => {
      openSession(target.chatId).catch((error: unknown) => {
        console.warn('10db: could not open the session', error);
      });
      bringWindowForward().catch((error: unknown) => {
        console.warn('10db: could not bring the window forward', error);
      });
    };
  });
  useEffect(
    () =>
      listenForChatClicks((target) => {
        openChat.current(target);
      }),
    [],
  );

  // A chat that goes from working to idle has replied: while the window is behind another app, and the
  // builder wants it, the reply's first line is a notification.
  const chats = useOpenChats().data;
  const notifyReplies = useSessionsSettings().data?.notifyReplies ?? true;
  const states = useRef(new Map<string, string>());
  useEffect(() => {
    if (chats === undefined) return;
    const before = states.current;
    states.current = new Map(chats.map((chat) => [chat.id, chat.conversation.state]));
    if (!isTauri() || !notifyReplies) return;
    for (const chat of chats) {
      const was = before.get(chat.id);
      const now = chat.conversation.state;
      const replied =
        (was === 'running' || was === 'stopping') && (now === 'idle_warm' || now === 'idle_cold');
      if (!replied) continue;
      readConversationItems(client, chat.conversationId)
        .then((items) => {
          const reply = items.findLast((item) => item.kind === 'agent_message');
          return notifyChatReplied(
            { chatId: chat.id, projectId: chat.projectId },
            chat.title,
            reply?.kind === 'agent_message' ? firstLineOf(reply.text) : '',
          );
        })
        .catch((error: unknown) => {
          console.warn('10db: could not notify about a reply', error);
        });
    }
  }, [chats, notifyReplies, client]);

  /** The chat a card was raised by, from the open tabs or, for a closed one, the conversation's owner. */
  async function chatOfCard(item: InboxItemDto): Promise<(ChatTarget & { title: string }) | null> {
    const conversationId = ConversationId.safeParse(item.detail?.['conversationId']);
    if (!conversationId.success) return null;
    const open = queryClient.getQueryData<readonly ChatDto[]>(chatKeys.open);
    const chat = open?.find((c) => c.conversationId === conversationId.data);
    if (chat !== undefined)
      return { chatId: chat.id, projectId: chat.projectId, title: chat.title };
    const conversation = await queryClient.query(
      conversationQueryOptions(client, conversationId.data),
    );
    const owner = ChatId.safeParse(conversation.owner.id);
    return conversation.owner.kind === 'chat' && owner.success
      ? { chatId: owner.data, projectId: item.projectId, title: item.title }
      : null;
  }

  /** The open cards; a read cancelled by the next event's refetch of the Inbox is asked again. */
  async function openCards() {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await queryClient.query(inboxQueryOptions(client));
      } catch (error) {
        if (!(error instanceof CancelledError) || attempt >= INBOX_READ_ATTEMPTS) throw error;
      }
    }
  }

  async function notifyOpened(id: string): Promise<void> {
    const items = await openCards();
    const opened = InboxItemId.safeParse(id);
    if (!opened.success) return;
    const item = items.find((candidate) => candidate.id === opened.data);
    if (!item) return;
    const ready = readyPageOf(item);
    if (ready === null) {
      if (!shouldNotifyOpened(item)) return;
      // A chat's card is worded for its session and its click opens the tab: still the one notification.
      const chat = await chatOfCard(item);
      if (chat === null) await notifyNewCard(item);
      else await notifyChatCard(chat, chat.title, item);
      return;
    }
    // Without the passes the notification names the item, not the page: it is never dropped for them.
    const passes = await queryClient.query(livePassesOptions(client)).catch(() => []);
    await notifyPassReady(
      item,
      ready,
      passes.find((view) => view.pass.id === ready.passId),
    );
  }

  // A card whose recipients disagreed is the builder's again; the first refetch that shows it says so.
  const openBefore = useRef<readonly InboxItemDto[]>([]);
  const inboxItems = useInbox().data;
  useEffect(() => {
    if (inboxItems === undefined) return;
    for (const notice of [
      ...disagreementNotices(openBefore.current, inboxItems),
      ...askedNotices(openBefore.current, inboxItems),
    ])
      notifyText(notice.title, notice.body).catch((error: unknown) => {
        console.warn('10db: could not notify about a stakeholder', error);
      });
    openBefore.current = inboxItems;
  }, [inboxItems]);

  useEventStream((event) => {
    if (!isTauri()) return;
    if (event.type === EventType.StakeholderSendChanged) {
      // The refetch this event started has not replaced the Open cards yet, so the card is still there.
      const notice = answeredNotice(event.data, queryClient.getQueryData(queryKeys.inbox) ?? []);
      if (notice) {
        notifyText(notice.title, notice.body).catch((error: unknown) => {
          console.warn('10db: could not notify about an answer', error);
        });
      }
      return;
    }
    // A card placed with the builder after triage is as new to them as one that opened there.
    const triaged = event.type === EventType.InboxTriaged && triagedToBuilder(event.data);
    if (event.type !== EventType.InboxOpened && !triaged) return;
    notifyOpened(event.entityId).catch((error: unknown) => {
      console.warn('10db: could not notify about a new card', error);
    });
  });
}
