import { z } from 'zod';

/** How many days back each of the two windows of the card-type report reaches, now included. */
export const CARD_TYPE_DAYS = { Week: 7, Month: 30 } as const;

/**
 * The answer choices that dismiss a card instead of choosing: the Inbox's Dismiss button sends the
 * first, and a card that offers a Dismiss option beside real ones sends the second.
 */
export const DISMISS_CHOICES: readonly string[] = ['dismissed', 'Dismiss'];

/**
 * A card type is called noisy when it was raised at least this many times in a window and at least
 * {@link NOISY_SHARE} of those were dismissed or withdrawn by 10db.
 */
export const NOISY_MIN_RAISED = 5;
export const NOISY_SHARE = 0.8;

/** Whether a window's counts make a card type noisy: it asked for attention that was rarely needed. */
export function isNoisyCardType(
  window: Pick<CardTypeWindowDto, 'raised' | 'dismissed' | 'withdrawn'>,
): boolean {
  return (
    window.raised >= NOISY_MIN_RAISED &&
    (window.dismissed + window.withdrawn) / window.raised >= NOISY_SHARE
  );
}

/**
 * What became of the cards of one type raised in a window. A card still open is in `raised` only, so
 * the other three never add up past it.
 */
export const CardTypeWindowDto = z.object({
  raised: z.int().nonnegative(),
  /** Answered with a real choice, by the builder or a stakeholder. */
  acted: z.int().nonnegative(),
  /** Closed by the builder's Dismiss. */
  dismissed: z.int().nonnegative(),
  /** Closed by 10db itself: withdrawn, expired or resolved because its cause was gone. */
  withdrawn: z.int().nonnegative(),
});
export type CardTypeWindowDto = z.infer<typeof CardTypeWindowDto>;

export const CardTypeDto = z.object({
  /**
   * The card's fold-key prefix (the text before its first colon); for a card with no fold key, a flag's
   * title up to its first colon, and any other kind the kind's name.
   */
  type: z.string().min(1),
  last7Days: CardTypeWindowDto,
  last30Days: CardTypeWindowDto,
  /** Either window makes the type noisy. */
  noisy: z.boolean(),
});
export type CardTypeDto = z.infer<typeof CardTypeDto>;

/** `GET /projects/:projectId/card-types`: noisy types first, then the most raised over 30 days. */
export const CardTypesDto = z.object({ types: z.array(CardTypeDto) });
export type CardTypesDto = z.infer<typeof CardTypesDto>;
