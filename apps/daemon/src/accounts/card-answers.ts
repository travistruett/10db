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
  type ProjectId,
} from '@10db/contracts';
import { MoveCause, type MoveWhy } from './moves';

/** Acts on an account card's answer before the inbox records it; other cards pass through untouched. */
export function createAccountCardAnswers(deps: {
  resume(accountId: AccountId): void;
  /** `answering` is the card being answered, which the inbox closes itself. */
  confirm(accountId: AccountId, identity: string, answering: InboxItemId): void;
  /** Moves the project as `PATCH` does; `answering` is the card being answered. */
  move(projectId: ProjectId, to: AccountId, why: MoveWhy, answering: InboxItemId): void;
  stay(projectId: ProjectId): void;
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
      (answer.choice === AccountCardChoice.Confirm ||
        answer.choice === AccountCardChoice.Resume ||
        answer.choice === AccountCardChoice.Stay) &&
      !offered
    )
      throw new InvalidError(`This card does not offer ${answer.choice}`);
    if (answer.choice === AccountCardChoice.Confirm) {
      if (card.data.seenIdentity === null)
        throw new ConflictError('This card names no identity to confirm');
      deps.confirm(card.data.accountId, card.data.seenIdentity, item.id);
    }
    if (answer.choice === AccountCardChoice.Resume) deps.resume(card.data.accountId);
    if (answer.choice === AccountCardChoice.Stay) deps.stay(item.projectId);
    const target = card.data.moves?.find((m) => m.choice === answer.choice);
    if (target)
      deps.move(
        item.projectId,
        target.accountId,
        card.data.moveBack === true
          ? { cause: MoveCause.Builder }
          : { cause: MoveCause.UsageLimit, resetsAt: null },
        item.id,
      );
  };
}
