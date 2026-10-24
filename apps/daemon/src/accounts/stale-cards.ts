import {
  ACCOUNT_CARD_DETAIL,
  AccountCardDetail,
  AccountProblem,
  InboxState,
  type AccountId,
  type InboxItemId,
} from '@10db/contracts';
import { listInbox, updateInboxItem } from '@10db/db';
import type { StateStore } from '../events';

const PREPARING = new Set<AccountProblem>([
  AccountProblem.SignedOut,
  AccountProblem.Unconfirmed,
  AccountProblem.SecretMissing,
  AccountProblem.WrongCredentials,
]);

/**
 * Closes the account's open cards that ask the builder to make it ready (sign in, confirm, set the secret,
 * fix the credentials), in every project. Answering one later would act on an account that has since moved on.
 * `except` is the card being answered right now, which the inbox closes itself.
 */
export function closeSettledCards(
  state: StateStore,
  accountId: AccountId,
  except: InboxItemId | null = null,
): void {
  const stale = listInbox(state.db, { states: [InboxState.Open] }).filter((item) => {
    if (item.id === except) return false;
    const card = AccountCardDetail.safeParse(item.detail?.[ACCOUNT_CARD_DETAIL]);
    return (
      card.success &&
      card.data.accountId === accountId &&
      card.data.reason === null &&
      card.data.problem !== null &&
      PREPARING.has(card.data.problem)
    );
  });
  if (stale.length === 0) return;
  state.write((ctx) => {
    for (const item of stale) updateInboxItem(ctx, item.id, { state: InboxState.Resolved });
  });
}
