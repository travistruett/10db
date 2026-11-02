import type { InboxAnswer, InboxItemDto } from '@10db/contracts';
import { GH_CHECK_CHOICE, GH_CHECK_DETAIL } from './cards';
import type { PrWatch } from './pr-watch';

/**
 * Acts on the gh card's Check again before the inbox records it: the watch reads every followed pull
 * request now instead of at its next interval (`PrWatch.recheck`). The card closes with the answer;
 * if gh still fails, that round raises a fresh one, so the builder hears how gh fails now. Any other
 * answer, or a card that isn't the gh card, changes nothing.
 */
export function createGhCardAnswers(
  watch: Pick<PrWatch, 'recheck'>,
): (item: InboxItemDto, answer: InboxAnswer) => void {
  return (item, answer) => {
    if (item.detail?.[GH_CHECK_DETAIL] !== true || answer.choice !== GH_CHECK_CHOICE) return;
    watch.recheck();
  };
}
