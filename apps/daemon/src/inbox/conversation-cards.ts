import { InboxKind, InboxState } from '@10db/contracts';
import { listInbox, type DbReader } from '@10db/db';
import type { InboxService } from './service';

/**
 * Withdraws every open permission and question card a conversation's session raised (a chat's or Plan's).
 * The call that raised each ended with the daemon and the next session asks again, so an answer to one
 * would reach nothing. Run at start, before any session does, so a card a new session raises is never swept.
 * Every other kind stays, the work-place flag card included.
 */
export function withdrawStaleConversationCards(db: DbReader, inbox: InboxService): void {
  for (const item of listInbox(db, { states: [InboxState.Open] }))
    if (
      (item.kind === InboxKind.Permission || item.kind === InboxKind.Question) &&
      item.detail?.['conversationId'] !== undefined
    )
      inbox.withdraw(item.id);
}
