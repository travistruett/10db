import { InvalidError, ShapeReviewer, type ConversationItemId } from '@10db/contracts';

// A session that runs no subagents does Plan's reviews itself, in a turn the daemon sends it for the
// purpose. That turn is the only time its own `report_finding` is allowed, and the review it belongs to,
// not the model, says whose findings they are.

/** The kind of review a live review turn is. */
export const ReviewTurnKind = {
  PlanReview: 'review',
  CheckForQuestions: 'rehearse',
  DesignReview: 'design_review',
} as const;
export type ReviewTurnKind = (typeof ReviewTurnKind)[keyof typeof ReviewTurnKind];

/** A review turn that is running: the item that started it, and which review it is. */
export interface ShapeReviewTurn {
  readonly id: ConversationItemId;
  readonly kind: ReviewTurnKind;
}

/**
 * The input of a finding the main session reports while the `reviews` it has been sent are live, with
 * `reviewer` set from them. A Find Open Questions reports as the rehearsal, which is the report that names
 * `rehearsal` or carries a `taskHash` (or the only one live); a Plan review names the lens it reads
 * through, scope or engineering, which is bookkeeping and no limit; a Design review reports as `design`.
 */
export function stampReview(
  reviews: readonly ShapeReviewTurn[],
  input: Record<string, unknown>,
): Record<string, unknown> {
  const checking = reviews.some((r) => r.kind === ReviewTurnKind.CheckForQuestions);
  const reviewing = reviews.some((r) => r.kind === ReviewTurnKind.PlanReview);
  const designing = reviews.some((r) => r.kind === ReviewTurnKind.DesignReview);
  if (!checking && !reviewing && !designing)
    throw new InvalidError(
      'Only a reviewer reports a finding; the main session cannot, outside a review turn.',
    );
  if (designing && (input['reviewer'] === ShapeReviewer.Design || (!checking && !reviewing)))
    return { ...input, reviewer: ShapeReviewer.Design };
  const asked = input['reviewer'] === ShapeReviewer.Rehearsal || input['taskHash'] !== undefined;
  if (checking && (asked || !reviewing)) return { ...input, reviewer: ShapeReviewer.Rehearsal };
  const lens = input['reviewer'];
  if (lens === ShapeReviewer.Scope || lens === ShapeReviewer.Engineering)
    return { ...input, reviewer: lens };
  throw new InvalidError(
    `A plan review reports each finding as reviewer "${ShapeReviewer.Scope}" or "${ShapeReviewer.Engineering}".`,
  );
}

/**
 * The reviews still live after a turn ends: one that turn took (a starter of it) or that was delivered
 * is done. An item injected into a running turn is no starter of it but is delivered by its receipt; one
 * handed to the next turn is not delivered yet, so it stays.
 */
export function reviewsAfterTurnEnd(
  live: readonly ShapeReviewTurn[],
  starters: readonly ConversationItemId[],
  delivered: (id: ConversationItemId) => boolean,
): ShapeReviewTurn[] {
  return live.filter((r) => !starters.includes(r.id) && !delivered(r.id));
}
