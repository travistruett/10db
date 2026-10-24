import {
  ACCOUNT_CARD_DETAIL,
  AccountCardChoice,
  AccountCardDetail,
  ConflictError,
  type AccountId,
  type InboxAnswer,
  type InboxItemDto,
} from '@10db/contracts';

/** Acts on an account card's answer before the inbox records it; other cards pass through untouched. */
export function createAccountCardAnswers(deps: {
  resume(accountId: AccountId): void;
  confirm(accountId: AccountId, identity: string): void;
}): (item: InboxItemDto, answer: InboxAnswer) => void {
  return (item, answer) => {
    const card = AccountCardDetail.safeParse(item.detail?.[ACCOUNT_CARD_DETAIL]);
    if (!card.success) return;
    if (answer.choice === AccountCardChoice.Confirm) {
      if (card.data.seenIdentity === null)
        throw new ConflictError('This card names no identity to confirm');
      deps.confirm(card.data.accountId, card.data.seenIdentity);
    }
    if (answer.choice === AccountCardChoice.Resume) deps.resume(card.data.accountId);
  };
}
