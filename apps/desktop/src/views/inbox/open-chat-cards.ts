import { InboxListState, type InboxItemDto } from '@10db/contracts';
import { useOpenChats } from '../../daemon/chat-queries';
import { useInboxRows } from '../../daemon/inbox-queries';

/** The detail key the daemon writes on a card a conversation's session asked. */
const CONVERSATION_DETAIL_KEY = 'conversationId';

/**
 * Whether a card belongs to a chat open in a tab. Such a card is answered in that chat, so the Inbox leaves it
 * out; a chat with no open tab keeps its cards here so nothing waits unseen.
 */
export function useInOpenChat(): (item: InboxItemDto) => boolean {
  const chats = useOpenChats().data ?? [];
  const open = new Set<string>(chats.map((chat) => chat.conversationId));
  return (item) => {
    const id = item.detail?.[CONVERSATION_DETAIL_KEY];
    return typeof id === 'string' && open.has(id);
  };
}

/**
 * How many open rows the Inbox leaves out: those whose every card belongs to a chat open in a tab, which is
 * what the Inbox page hides, so the badge subtracts exactly what the page does not show.
 */
export function useRowsInOpenChats(): number {
  const inOpenChat = useInOpenChat();
  return useInboxRows({ state: InboxListState.Open }).rows.filter((row) =>
    row.items.every(inOpenChat),
  ).length;
}
