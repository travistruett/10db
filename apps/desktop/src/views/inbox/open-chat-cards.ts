import type { InboxItemDto } from '@10db/contracts';
import { useOpenChats } from '../../daemon/chat-queries';
import { useInbox } from '../../daemon/queries';

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

/** How many open cards the Inbox leaves out because their chat is open in a tab. */
export function useCardsInOpenChats(): number {
  const inOpenChat = useInOpenChat();
  return (useInbox().data ?? []).filter((item) => item.state === 'OPEN' && inOpenChat(item)).length;
}
