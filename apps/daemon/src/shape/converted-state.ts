import { TaskStatus, type ShapeId } from '@10db/contracts';
import {
  getGoal,
  getPrinciple,
  getTask,
  latestWorkstreamOf,
  listShapeLinks,
  listShapeQuestions,
  type DbReader,
} from '@10db/db';

// Shape spec §12. What a reopened conversation is told about the rows Convert made: each as the goal
// or task it became, with where it stands now. Read-only: the session may only propose changes and
// removals for a task marked "not started".

/** One line per row a conversation converted, in the order Convert made them. */
export function convertedStateLines(db: DbReader, shapeId: ShapeId): string[] {
  const questions = new Map(listShapeQuestions(db, shapeId).map((q) => [q.id, q]));
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
    if (link.principleId !== null) {
      const principle = getPrinciple(db, link.principleId);
      return `- ${link.key} → principle ${principle.id} "${principle.statement}" — ${principle.state}`;
    }
    if (link.questionId !== null) {
      const question = questions.get(link.questionId);
      return `- ${link.key} → question ${link.questionId} "${question?.text ?? ''}" for ${question?.forWho ?? ''} — stored, not sent`;
    }
    return `- ${link.key} → decision ${link.decisionId ?? ''}`;
  });
}
