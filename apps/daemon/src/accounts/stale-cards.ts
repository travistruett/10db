import {
  ACCOUNT_CARD_DETAIL,
  AccountCardDetail,
  AccountPauseReason,
  AccountProblem,
  InboxState,
  type AccountId,
  type InboxItemId,
} from '@10db/contracts';
import { listInbox, updateInboxItem, type WriteContext } from '@10db/db';
import type { StateStore } from '../events';

const PREPARING: ReadonlySet<AccountProblem> = new Set([
  AccountProblem.SignedOut,
  AccountProblem.Unconfirmed,
  AccountProblem.SecretMissing,
  AccountProblem.WrongCredentials,
]);
/** The cards a probe raises when it finds no login a subscription can run on. */
const NO_LOGIN: ReadonlySet<AccountProblem> = new Set([
  AccountProblem.SignedOut,
  AccountProblem.WrongCredentials,
]);

/** Resolves the account's open preparing cards about one of `problems`, in every project, but `except`. */
function closePreparingCards(
  state: StateStore,
  accountId: AccountId,
  problems: ReadonlySet<AccountProblem>,
  except: InboxItemId | null,
): void {
  const stale = listInbox(state.db, { states: [InboxState.Open] }).filter((item) => {
    if (item.id === except) return false;
    const card = AccountCardDetail.safeParse(item.detail?.[ACCOUNT_CARD_DETAIL]);
    return (
      card.success &&
      card.data.accountId === accountId &&
      card.data.reason === null &&
      card.data.problem !== null &&
      problems.has(card.data.problem)
    );
  });
  if (stale.length === 0) return;
  state.write((ctx) => {
    for (const item of stale) updateInboxItem(ctx, item.id, { state: InboxState.Resolved });
  });
}

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
  closePreparingCards(state, accountId, PREPARING, except);
}

/**
 * A probe found a login to confirm: the account's sign-in and credentials cards from earlier probes no
 * longer apply, whether the builder then confirms it or answers Later.
 */
export function closeNoLoginCards(state: StateStore, accountId: AccountId): void {
  closePreparingCards(state, accountId, NO_LOGIN, null);
}

/**
 * Closes the account's open pause cards, in every project, once no pause holds it. A usage-limit card
 * offered moves for a limit that is over, so it is withdrawn; a cap or refusal card's problem is over,
 * so it is resolved. `except` is the card being answered right now, which the inbox closes itself.
 */
export function closePauseCards(
  ctx: WriteContext,
  accountId: AccountId,
  except: InboxItemId | null = null,
): void {
  for (const item of listInbox(ctx.tx, { states: [InboxState.Open] })) {
    if (item.id === except) continue;
    const card = AccountCardDetail.safeParse(item.detail?.[ACCOUNT_CARD_DETAIL]);
    if (!card.success || card.data.accountId !== accountId || card.data.reason === null) continue;
    switch (card.data.reason) {
      case AccountPauseReason.UsageLimit:
        updateInboxItem(ctx, item.id, { state: InboxState.Cancelled });
        break;
      case AccountPauseReason.MonthlyCap:
      case AccountPauseReason.Refused:
        updateInboxItem(ctx, item.id, { state: InboxState.Resolved });
        break;
    }
  }
}
