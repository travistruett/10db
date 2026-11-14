import { ConversationId, type ChatDto, type InboxItemDto } from '@10db/contracts';
import { Anchor, Badge, Text } from '@mantine/core';
import { useOpenChats, useRecentChats } from '../../daemon/chat-queries';
import { useOpenSession } from '../sessions/open-session';

/** The chat a card was raised by, when its detail names a chat's conversation. */
export function useSessionOfCard(item: InboxItemDto): ChatDto | null {
  const conversationId = ConversationId.safeParse(item.detail?.['conversationId']);
  const open = useOpenChats().data ?? [];
  const recent = useRecentChats(conversationId.success ? item.projectId : null);
  if (!conversationId.success) return null;
  return [...open, ...recent].find((chat) => chat.conversationId === conversationId.data) ?? null;
}

/** "Chat" and the session's title, for a card a chat raised: what names the session on the card. */
export function SessionBadge({ chat }: { readonly chat: ChatDto }) {
  return (
    <>
      <Badge size="sm" variant="outline" style={{ flexShrink: 0 }}>
        Chat
      </Badge>
      <Text size="sm" c="dimmed" lineClamp={1} style={{ minWidth: 0 }}>
        {chat.title}
      </Text>
    </>
  );
}

/** Open Session: selects the chat's tab, reopening it where it was when it is closed. */
export function OpenSessionLink({ chat }: { readonly chat: ChatDto }) {
  const openSession = useOpenSession();
  return (
    <Anchor
      component="button"
      type="button"
      size="sm"
      onClick={() => {
        void openSession(chat.id, chat.projectId);
      }}
    >
      Open Session
    </Anchor>
  );
}
