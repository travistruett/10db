import {
  ACCOUNT_CARD_DETAIL,
  AccountCardChoice,
  AccountCardDetail,
  ConflictError,
  InvalidError,
  type AccountId,
  type InboxAnswer,
  type InboxItemId,
  type InboxItemDto,
} from '@10db/contracts';

/** Acts on an account card's answer before the inbox records it; other cards pass through untouched. */
export function createAccountCardAnswers(deps: {
  resume(accountId: AccountId): void;
  /** `answering` is the card being answered, which the inbox closes itself. */
  confirm(accountId: AccountId, identity: string, answering: InboxItemId): void;
}): (item: InboxItemDto, answer: InboxAnswer) => void {
  return (item, answer) => {
    const card = AccountCardDetail.safeParse(item.detail?.[ACCOUNT_CARD_DETAIL]);
    if (!card.success) return;
    // The inbox checks this too, but only after this hook has acted.
    if (item.options.length > 0 && !item.options.some((o) => o.label === answer.choice))
      throw new InvalidError(`Choose one of: ${item.options.map((o) => o.label).join(', ')}`);
    // A card with no options (the recorded identity) offers neither: acting on it would undo a later change.
    const offered = item.options.some((o) => o.label === answer.choice);
    if (
      (answer.choice === AccountCardChoice.Confirm || answer.choice === AccountCardChoice.Resume) &&
      !offered
    )
      throw new InvalidError(`This card does not offer ${answer.choice}`);
    if (answer.choice === AccountCardChoice.Confirm) {
      if (card.data.seenIdentity === null)
        throw new ConflictError('This card names no identity to confirm');
      deps.confirm(card.data.accountId, card.data.seenIdentity, item.id);
    }
    if (answer.choice === AccountCardChoice.Resume) deps.resume(card.data.accountId);
  };
}
