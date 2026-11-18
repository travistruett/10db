import type { ChatDto } from '@10db/contracts';
import { useOpenChats } from '../../daemon/chat-queries';
import { useInbox } from '../../daemon/queries';
import { openCardsByConversation } from './needs-you';
import { needsYou } from './tab-state';
import { chatInfo } from './tab-info';

/**
 * The open sessions that wait on the builder, in the panel's order: an open Inbox card names their
 * conversation, or they stopped on an error (UI spec §5.7, §20). Read from the same queries the tabs
 * read, so the badge, a tab's ring and the Inbox never disagree.
 */
export function useSessionsNeedingYou(): readonly ChatDto[] {
  const chats = useOpenChats().data;
  const inbox = useInbox().data;
  const cards = openCardsByConversation(inbox ?? []);
  return [...(chats ?? [])]
    .sort((a, b) => (a.tabPosition ?? 0) - (b.tabPosition ?? 0))
    .filter((chat) => needsYou(chatInfo(chat, cards, {}).state));
}
