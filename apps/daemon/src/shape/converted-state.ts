import { TaskStatus, type ShapeId } from '@10db/contracts';
import { getGoal, getTask, latestWorkstreamOf, listShapeLinks, type DbReader } from '@10db/db';

// Shape spec §12. What a reopened conversation is told about the rows Convert made: each as the goal
// or task it became, with where it stands now. Read-only: the session may only propose changes and
// removals for a task marked "not started".

/** One line per row a conversation converted, in the order Convert made them. */
export function convertedStateLines(db: DbReader, shapeId: ShapeId): string[] {
  return listShapeLinks(db, shapeId).map((link) => {
    if (link.goalId !== null) {
      const goal = getGoal(db, link.goalId);
      return `- ${link.key} → goal ${goal.id} "${goal.title}" — ${goal.state}`;
    }
    if (link.taskId !== null) {
      const task = getTask(db, link.taskId);
      const run = latestWorkstreamOf(db, task.id);
      const where =
        task.status !== TaskStatus.Open
          ? task.status
          : run === undefined
            ? 'not started'
            : `started (${run.state.toLowerCase()})`;
      return `- ${link.key} → task ${task.id} "${task.title}" — ${where}`;
    }
    return `- ${link.key} → decision ${link.decisionId ?? ''}`;
  });
}
