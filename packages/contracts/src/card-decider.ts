import { z } from 'zod';
import { InboxKind } from './states';

/**
 * Who answers a card's question (`docs/superpowers/specs/2026-11-27-what-reaches-the-builder-design.md` §2), cheapest
 * first. Only a `builder` card holds the Inbox's Open list, is pushed to the phone and is never folded or expired.
 */
export const CardDecider = {
  /** A rule: the answer follows from facts 10db holds and the move can be undone. */
  Rule: 'rule',
  /** 10db's judge, at or above its floor, on a move that can be undone. */
  Judge: 'judge',
  /** The person the project routes the question to. */
  Stakeholder: 'stakeholder',
  /** The builder: one of the seven things only they own. */
  Builder: 'builder',
} as const;
export type CardDecider = (typeof CardDecider)[keyof typeof CardDecider];

/** The seven things only the builder owns (§1); a builder card names which. */
export const BuilderOwns = {
  Money: 'money',
  OneWayDoor: 'one_way_door',
  Guardrails: 'guardrails',
  ProductAndTaste: 'product_and_taste',
  Promise: 'promise',
  YourHands: 'your_hands',
  OutOfMoves: 'out_of_moves',
} as const;
export type BuilderOwns = (typeof BuilderOwns)[keyof typeof BuilderOwns];

/** What a builder card says its owner is, in the words the Inbox shows. */
export const BUILDER_OWNS_LABELS: Record<BuilderOwns, string> = {
  [BuilderOwns.Money]: 'Money',
  [BuilderOwns.OneWayDoor]: 'A One-Way Door',
  [BuilderOwns.Guardrails]: 'Your Guardrails',
  [BuilderOwns.ProductAndTaste]: 'Product and Taste',
  [BuilderOwns.Promise]: 'A Promise in Your Name',
  [BuilderOwns.YourHands]: 'Your Hands',
  [BuilderOwns.OutOfMoves]: 'Out of Moves',
};

/**
 * A decision a plan needs from the builder: which of the seven it is, and the call in a line. A plan step names
 * the ones its brief declares; a plan review names the ones the plan makes that its brief does not.
 */
export const BuilderCall = z.strictObject({
  owns: z.enum(BuilderOwns),
  call: z.string().min(1).max(300),
});
export type BuilderCall = z.infer<typeof BuilderCall>;

/** The most builder calls one step result names: one per thing the builder owns. */
export const MAX_BUILDER_CALLS = 7;

/** The `detail` keys a card's declared decider is stored under. */
export const CARD_DECIDER = 'decider';
export const CARD_OWNS = 'owns';

/**
 * What a card builder declares. A builder card says which of the seven it is; any other decider says who
 * settles it, and a card of one is not in Open.
 */
export const CardDecision = z.discriminatedUnion('decider', [
  z.strictObject({
    decider: z.enum([CardDecider.Rule, CardDecider.Judge, CardDecider.Stakeholder]),
  }),
  z.strictObject({ decider: z.literal(CardDecider.Builder), owns: z.enum(BuilderOwns) }),
]);
export type CardDecision = z.infer<typeof CardDecision>;

/** What a stored card's `detail` reads as. */
interface StoredCard {
  readonly detail: Record<string, unknown> | null;
}

/**
 * The declared decision a stored card carries, or null for a card with none: one raised before a decider
 * was declared, or a lane's question. A card with none is the builder's, because a kind with no row is the
 * builder's and doubt goes up.
 */
export function declaredDecision(card: StoredCard): CardDecision | null {
  const detail = card.detail;
  if (detail?.[CARD_DECIDER] === undefined) return null;
  const parsed = CardDecision.safeParse({
    decider: detail[CARD_DECIDER],
    ...(detail[CARD_OWNS] === undefined ? {} : { owns: detail[CARD_OWNS] }),
  });
  return parsed.success ? parsed.data : null;
}

/** Whether a stored card is the builder's: only these reach Open and the phone. */
export function isBuilderCard(card: StoredCard): boolean {
  const decision = declaredDecision(card);
  return decision === null || decision.decider === CardDecider.Builder;
}

/** The two `detail` entries a declared decision is stored as. */
export function decisionDetail(decision: CardDecision): Record<string, string> {
  return decision.decider === CardDecider.Builder
    ? { [CARD_DECIDER]: decision.decider, [CARD_OWNS]: decision.owns }
    : { [CARD_DECIDER]: decision.decider };
}

/**
 * Which of the seven a builder card names. A lane's question is product and taste, and its permission asks for a
 * move the limits judge could not clear, a one-way door; any other card names its own, or none.
 */
export function builderOwnsOf(
  card: StoredCard & { readonly kind?: InboxKind },
): BuilderOwns | null {
  const decision = declaredDecision(card);
  if (decision !== null) return decision.decider === CardDecider.Builder ? decision.owns : null;
  if (card.kind === InboxKind.Question) return BuilderOwns.ProductAndTaste;
  return card.kind === InboxKind.Permission ? BuilderOwns.OneWayDoor : null;
}
