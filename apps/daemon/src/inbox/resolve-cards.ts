import {
  CARD_RESOLVES_WHEN,
  CardResolvesWhen,
  InboxState,
  type InboxItemDto,
  type ProjectId,
} from '@10db/contracts';
import { listInbox, type DbReader } from '@10db/db';
import type { InboxService } from './service';

/** The open flags of `projectId` (every project when null) that said what makes them stale. */
function cardsResolvedByEvent(
  db: DbReader,
  projectId: ProjectId | null,
): { readonly item: InboxItemDto; readonly when: CardResolvesWhen }[] {
  const found: { item: InboxItemDto; when: CardResolvesWhen }[] = [];
  for (const item of listInbox(db, {
    states: [InboxState.Open],
    ...(projectId ? { projectId } : {}),
  })) {
    // The detail is JSON read back from the database: a boundary, so parse it.
    const when = CardResolvesWhen.safeParse(item.detail?.[CARD_RESOLVES_WHEN]);
    if (when.success) found.push({ item, when: when.data });
  }
  return found;
}

/**
 * Closes every open card whose stated cause `reasonFor` says is gone, as resolved by 10db with the
 * reason it returns; null leaves a card open. Returns how many it closed.
 */
export function resolveStaleCards(
  db: DbReader,
  inbox: Pick<InboxService, 'resolve'>,
  projectId: ProjectId | null,
  reasonFor: (when: CardResolvesWhen, item: InboxItemDto) => string | null,
): number {
  let closed = 0;
  for (const { item, when } of cardsResolvedByEvent(db, projectId)) {
    const reason = reasonFor(when, item);
    if (reason === null) continue;
    inbox.resolve(item.id, reason);
    closed += 1;
  }
  return closed;
}
