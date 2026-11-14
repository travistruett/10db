import { kindsOfTask, Ships, type ProjectDto } from '@10db/contracts';
import type { DbReader } from '@10db/db';
import { rowProcess } from '../routing';
import { playbookInputs } from '../team';
import type { GoalShipping } from './goal-batches';
import { taskTarget } from './landing';

/**
 * Reads the playbook and the kinds as they are now: a task ships with its goal when it has one, its
 * effective rigor's row ships with its goal, and none of its kinds has its own copy. Computed at each
 * start, so a resize or a kind change before the start takes effect.
 */
export function goalShipping(
  db: DbReader,
  project: Pick<ProjectDto, 'id' | 'baseBranch'>,
): GoalShipping {
  const { kinds, playbook } = playbookInputs(db, project.id);
  return {
    ships: (task) =>
      task.goalId !== null &&
      task.goalId !== undefined &&
      rowProcess(task.effectiveRigor, playbook).ships === Ships.WithGoal &&
      !kindsOfTask(task.kinds, kinds).some((kind) => kind.ownCopy),
    target: (task) => taskTarget(project, task),
  };
}
