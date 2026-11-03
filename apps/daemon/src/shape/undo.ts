import {
  InvalidError,
  ShapeProposalState,
  ShapeState,
  type DecisionId,
  type GoalId,
  type ShapeId,
} from '@10db/contracts';
import {
  deleteShapeLinksOf,
  listShapeLinks,
  patchShape,
  patchShapeProposal,
  removeDraftGoal,
  withdrawDecision,
  type WriteContext,
} from '@10db/db';

// Shape spec §11, Undo. Convert has no undo of its own beyond these two.

/**
 * Remove Draft Goal: the goal this conversation made goes with its tasks, while every one is
 * unstarted, and its proposal is pending again so it can be edited and converted anew.
 */
export function removeDraftGoalOf(ctx: WriteContext, shapeId: ShapeId, goalId: GoalId): void {
  const link = listShapeLinks(ctx.tx, shapeId).find((l) => l.goalId === goalId);
  if (link === undefined) throw new InvalidError(`${goalId} is not a goal this conversation made`);
  // The links name the goal, so they go first; a refusal below rolls the whole write back.
  deleteShapeLinksOf(ctx, link.proposalId);
  removeDraftGoal(ctx, goalId);
  patchShapeProposal(ctx, link.proposalId, { state: ShapeProposalState.Pending });
  patchShape(ctx, shapeId, { state: ShapeState.Proposed });
}

/**
 * Withdraw Decision…: a decision this conversation wrote becomes a tombstone with the builder's
 * reason, and leaves searches and context packs. Only the head of a supersede chain can be withdrawn.
 */
export function withdrawConvertedDecision(
  ctx: WriteContext,
  shapeId: ShapeId,
  decisionId: DecisionId,
  reason: string,
): void {
  if (!listShapeLinks(ctx.tx, shapeId).some((l) => l.decisionId === decisionId))
    throw new InvalidError(`${decisionId} is not a decision this conversation wrote`);
  withdrawDecision(ctx, decisionId, { by: 'builder', reason });
}
