import { ConversationId, type InboxItemDto } from '@10db/contracts';

/** The detail key the daemon writes on a card a conversation's session asked. */
const CONVERSATION_DETAIL_KEY = 'conversationId';

/**
 * The open Inbox cards, by the conversation that raised them. A tab, the sidebar's badge and the
 * announcer read only this: Sessions keeps no queue of its own (UI spec §5.7). A detail that does not
 * parse as a conversation id is ignored, since it came from outside this module.
 */
export function openCardsByConversation(
  items: readonly InboxItemDto[],
): ReadonlyMap<ConversationId, InboxItemDto[]> {
  const byConversation = new Map<ConversationId, InboxItemDto[]>();
  for (const item of items) {
    if (item.state !== 'OPEN') continue;
    const id = ConversationId.safeParse(item.detail?.[CONVERSATION_DETAIL_KEY]);
    if (!id.success) continue;
    byConversation.set(id.data, [...(byConversation.get(id.data) ?? []), item]);
  }
  return byConversation;
}
