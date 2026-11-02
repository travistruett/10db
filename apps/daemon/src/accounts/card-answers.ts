import {
  ACCOUNT_CARD_DETAIL,
  AccountCardChoice,
  AccountCardDetail,
  AccountId,
  AccountPauseReason,
  ConflictError,
  InvalidError,
  type InboxAnswer,
  type InboxItemId,
  type InboxItemDto,
  type ProjectId,
} from '@10db/contracts';
import { z } from 'zod';
import { CAP_RAISE_DETAIL } from './cards';
import { MoveCause, type MoveWhy } from './moves';

/** What a cap card's detail holds for its Raise cap option (`CapRaise` in cards.ts). */
const CapRaise = z.object({ accountId: AccountId, choice: z.string(), toUsd: z.number() });

/** Whether a card with this pause reason is the usage-limit card, raised after the pause stopped its lanes. */
function raisedByUsageLimit(reason: AccountPauseReason | null): boolean {
  if (reason === null) return false;
  switch (reason) {
    case AccountPauseReason.UsageLimit:
      return true;
    case AccountPauseReason.MonthlyCap:
    case AccountPauseReason.Refused:
      return false;
  }
}

/** Acts on an account card's answer before the inbox records it; other cards pass through untouched. */
export function createAccountCardAnswers(deps: {
  /** Lifts the pause while it is the kind the card is about; `answering` is the card being answered. */
  resume(
    accountId: AccountId,
    about: { readonly only: AccountPauseReason | null; readonly answering: InboxItemId },
  ): void;
  /** `answering` is the card being answered, which the inbox closes itself. */
  confirm(accountId: AccountId, identity: string, answering: InboxItemId): void;
  /** Moves the project as `PATCH` does; `answering` is the card being answered. */
  move(projectId: ProjectId, to: AccountId, why: MoveWhy, answering: InboxItemId): void;
  stay(projectId: ProjectId): void;
  /**
   * Looks at an account that waits for a fix again now, not at the next minute's probe. A sign-in,
   * credentials or secret card that still holds throws, which keeps the card open and says why;
   * `forgetIdentity` is the recorded login's Record again. `answering` is the card being answered.
   */
  recheck(
    accountId: AccountId,
    projectId: ProjectId,
    answering: InboxItemId,
    forgetIdentity: boolean,
  ): void;
  /** Sets the account's monthly cap to `toUsd` and lifts the cap pause; `answering` is the card being answered. */
  raiseCap(accountId: AccountId, toUsd: number, answering: InboxItemId): void;
}): (item: InboxItemDto, answer: InboxAnswer) => void {
  return (item, answer) => {
    const raise = CapRaise.safeParse(item.detail?.[CAP_RAISE_DETAIL]);
    if (raise.success && answer.choice === raise.data.choice) {
      if (!item.options.some((o) => o.label === answer.choice))
        throw new InvalidError(`Choose one of: ${item.options.map((o) => o.label).join(', ')}`);
      deps.raiseCap(raise.data.accountId, raise.data.toUsd, item.id);
      return;
    }
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
        answer.choice === AccountCardChoice.CheckAgain ||
        answer.choice === AccountCardChoice.RecordAgain ||
        answer.choice === AccountCardChoice.Stay) &&
      !offered
    )
      throw new InvalidError(`This card does not offer ${answer.choice}`);
    if (
      answer.choice === AccountCardChoice.CheckAgain ||
      answer.choice === AccountCardChoice.RecordAgain
    )
      deps.recheck(
        card.data.accountId,
        item.projectId,
        item.id,
        answer.choice === AccountCardChoice.RecordAgain,
      );
    if (answer.choice === AccountCardChoice.Confirm) {
      if (card.data.seenIdentity === null)
        throw new ConflictError('This card names no identity to confirm');
      deps.confirm(card.data.accountId, card.data.seenIdentity, item.id);
    }
    if (answer.choice === AccountCardChoice.Resume)
      deps.resume(card.data.accountId, { only: card.data.reason, answering: item.id });
    if (answer.choice === AccountCardChoice.Stay) deps.stay(item.projectId);
    const limitCard = raisedByUsageLimit(card.data.reason);
    const target = card.data.moves?.find((m) => m.choice === answer.choice);
    if (target)
      deps.move(
        item.projectId,
        target.accountId,
        card.data.moveBack === true
          ? { cause: MoveCause.Builder }
          : {
              cause: MoveCause.UsageLimit,
              resetsAt: card.data.usage?.resetsAt ? new Date(card.data.usage.resetsAt) : null,
              // The usage-limit card's lanes were stopped by the pause; a threshold card's still run.
              handOff: !limitCard,
              answersLimitCard: limitCard,
            },
        item.id,
      );
  };
}
