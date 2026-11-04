import {
  InvalidError,
  ShapeProposalState,
  ShapeState,
  type DecisionId,
  type GoalId,
  type PrincipleId,
  type ShapeId,
  type TaskId,
} from '@10db/contracts';
import {
  deleteShapeLinksOf,
  listGoalTasks,
  listShapeLinks,
  patchShape,
  patchShapeProposal,
  rekeyShapeAttachmentsToProposal,
  releaseDetachedShapeQuestions,
  removeDraftGoal,
  withdrawDecision,
  type WriteContext,
} from '@10db/db';
import { withdrawPrincipleRecord } from '../knowledge';

// Shape spec §11, Undo. Convert has no undo of its own beyond these three.

/**
 * Remove Draft Goal: the goal this conversation made goes with its tasks, while every one is
 * unstarted, and its proposal is pending again so it can be edited and converted anew.
 */
export function removeDraftGoalOf(ctx: WriteContext, shapeId: ShapeId, goalId: GoalId): void {
  const links = listShapeLinks(ctx.tx, shapeId);
  const link = links.find((l) => l.goalId === goalId);
  if (link === undefined) throw new InvalidError(`${goalId} is not a goal this conversation made`);
  // A diagram attached by the goal's or a task's id is keyed by that id; the links still say which
  // row it belongs to, so key it by the row before they go. The goal's tasks include any added in a
  // later round, whose links sit under their own proposal rows rather than the goal's.
  const taskIds = new Set<TaskId | null>(listGoalTasks(ctx.tx, goalId).map((t) => t.id));
  rekeyShapeAttachmentsToProposal(
    ctx,
    links.filter((l) => l.goalId === goalId || taskIds.has(l.taskId)),
  );
  // A task removal leaves its question stored under no task, which the goal's removal cannot find by
  // id; the question's proposal names the task key, which only these links still say.
  releaseDetachedShapeQuestions(
    ctx,
    shapeId,
    links.filter((l) => l.taskId !== null && taskIds.has(l.taskId)).map((l) => l.key),
  );
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

/**
 * Withdraw Principle…: a principle this conversation wrote becomes a tombstone with the builder's
 * reason, as the knowledge routes withdraw one, and leaves searches and context packs. A principle
 * a later one replaced cannot be withdrawn (409).
 */
export function withdrawConvertedPrinciple(
  ctx: WriteContext,
  shapeId: ShapeId,
  principleId: PrincipleId,
  reason: string,
): void {
  if (!listShapeLinks(ctx.tx, shapeId).some((l) => l.principleId === principleId))
    throw new InvalidError(`${principleId} is not a principle this conversation wrote`);
  withdrawPrincipleRecord(ctx, principleId, reason, undefined);
}
