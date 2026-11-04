import { ConflictError, EventType, GoalState, TaskStatus, type GoalId } from '@10db/contracts';
import { eq } from 'drizzle-orm';
import * as schema from '../schema';
import { getGoal, listGoalTasks } from './goals';
import { releaseShapeLinksOfGoal } from './shape-state';
import type { WriteContext } from './store';
import { cancelNeverStartedTask } from './tasks';

/**
 * Removes a draft goal that nothing has started (Shape spec §11): its tasks are removed as any
 * unstarted task is, then its criteria and the goal itself. What counts as started is `startedRun`
 * over all a task's runs, which is how the goal digest reads a goal as not started. A task that has
 * started, or that a task outside the goal waits on, refuses the whole removal; the caller's
 * transaction leaves nothing behind.
 * The removed tasks keep their rows with status cancelled and no goal. A question converted under the
 * goal or one of its tasks goes back to its pending proposal.
 */
export function removeDraftGoal(ctx: WriteContext, goalId: GoalId): void {
  const goal = getGoal(ctx.tx, goalId);
  if (goal.state !== GoalState.Draft)
    throw new ConflictError(
      `Goal ${goal.title} is ${goal.state}, not a draft; only a draft goal is removed`,
    );
  const tasks = listGoalTasks(ctx.tx, goalId);
  // Questions and links are released while the tasks are still open: cancelling a task detaches the
  // questions stored under it, which would hide them from this lookup. A refusal below rolls it back.
  releaseShapeLinksOfGoal(
    ctx,
    goalId,
    tasks.map((t) => t.id),
  );
  // Tasks that nothing else in the goal waits on go first, so none is refused for its dependents.
  let remaining = tasks.filter((t) => t.status !== TaskStatus.Cancelled);
  while (remaining.length > 0) {
    const open = remaining;
    const leaves = open.filter((t) => !open.some((other) => other.dependsOn.includes(t.id)));
    // A dependency cycle cannot be written, but a loop with no way out must not be possible.
    if (leaves.length === 0)
      throw new ConflictError(`Goal ${goal.title} has tasks that wait on each other`);
    for (const task of leaves) cancelNeverStartedTask(ctx, task.id);
    remaining = open.filter((t) => !leaves.includes(t));
  }
  ctx.tx.update(schema.tasks).set({ goalId: null }).where(eq(schema.tasks.goalId, goalId)).run();
  ctx.tx.delete(schema.goalCriteria).where(eq(schema.goalCriteria.goalId, goalId)).run();
  ctx.tx.delete(schema.goalViews).where(eq(schema.goalViews.goalId, goalId)).run();
  ctx.tx.delete(schema.goals).where(eq(schema.goals.id, goalId)).run();
  ctx.emit({
    type: EventType.GoalChanged,
    entityType: 'goal',
    entityId: goalId,
    data: { projectId: goal.projectId, removed: true },
  });
}
