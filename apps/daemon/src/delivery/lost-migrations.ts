import {
  BatchId,
  InvalidError,
  type InboxAnswer,
  type InboxItemDto,
  type Notice,
} from '@10db/contracts';
import { findOpenByFoldKey, getBatch } from '@10db/db';
import { z } from 'zod';
import { baseRegenerateKey, LOST_MIGRATIONS_DETAIL, LostChoice } from './cards';
import { hideNotices, type DeliveryContext } from './context';
import { NOTICE_KEY, uncarriedIn } from './notices';

const Offer = z.object({ batchId: BatchId });

/**
 * Acts on the answer of a card about a lost-migrations notice whose list could not be read, before the
 * inbox records it. Clear the notice is the builder's word that the batch's journal holds every
 * migration the base merge lost, which no gate can check without the list: the notice and the
 * regenerate card go, and the next gate runs. It is the one way short of abandoning the batch, and
 * it is only ever asked of the builder; no gate reads an unreadable list as all carried.
 *
 * A notice that reads is refused (the card is stale: the journal clears it at the next gate, and an
 * answer must not drop a list that still stands guard), and so is a batch with no notice left to
 * clear, which keeps the card open and tells the builder why. Any other answer changes nothing.
 */
export function createLostMigrationsAnswers(
  ctx: DeliveryContext,
): (item: InboxItemDto, answer: InboxAnswer) => void {
  return (item, answer) => {
    // The detail is JSON read back from the database: a boundary, so parse it.
    const offer = Offer.safeParse(item.detail?.[LOST_MIGRATIONS_DETAIL]);
    if (!offer.success || answer.choice !== LostChoice.Clear) return;
    const batch = getBatch(ctx.state.db, offer.data.batchId);
    const notice: Notice | undefined = batch.notices.find(
      (n) => n.key === NOTICE_KEY.migrationsUncarried,
    );
    if (notice === undefined) return;
    if (uncarriedIn(notice) !== null)
      throw new InvalidError(
        "This batch's lost-migrations list can be read again, so the next gate checks it against the journal; it can't be cleared by hand",
      );
    hideNotices(ctx.state, batch.id, [NOTICE_KEY.migrationsUncarried]);
    // The card answered closes with its answer; the regenerate card, when it is another one, goes now.
    const regenerate = findOpenByFoldKey(
      ctx.state.db,
      batch.projectId,
      baseRegenerateKey(batch.id),
    );
    if (regenerate !== undefined && regenerate.id !== item.id) ctx.inbox.withdraw(regenerate.id);
    ctx.logger.info({ batchId: batch.id }, 'lost migrations notice cleared by the builder');
  };
}
