import { InvalidError, ShapeReviewer, type ConversationItemId } from '@10db/contracts';

// A session that runs no subagents does Plan's reviews itself, in a turn the daemon sends it for the
// purpose. That turn is the only time its own `report_finding` is allowed, and the review it belongs to,
// not the model, says whose findings they are.

/** The kind of review a live review turn is. */
export const ReviewTurnKind = { PlanReview: 'review', CheckForQuestions: 'rehearse' } as const;
export type ReviewTurnKind = (typeof ReviewTurnKind)[keyof typeof ReviewTurnKind];

/** A review turn that is running: the item that started it, and which review it is. */
export interface ShapeReviewTurn {
  readonly id: ConversationItemId;
  readonly kind: ReviewTurnKind;
}

/**
 * The input of a finding the main session reports during `review`, with `reviewer` set from the review.
 * A Check for Questions reports as the rehearsal; a Plan review names the lens it reads through, scope or
 * engineering, which is bookkeeping and no limit.
 */
export function stampReview(
  review: ShapeReviewTurn,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (review.kind === ReviewTurnKind.CheckForQuestions)
    return { ...input, reviewer: ShapeReviewer.Rehearsal };
  const lens = input['reviewer'];
  if (lens === ShapeReviewer.Scope || lens === ShapeReviewer.Engineering)
    return { ...input, reviewer: lens };
  throw new InvalidError(
    `A plan review reports each finding as reviewer "${ShapeReviewer.Scope}" or "${ShapeReviewer.Engineering}".`,
  );
}
