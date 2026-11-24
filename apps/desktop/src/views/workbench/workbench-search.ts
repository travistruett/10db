import { GoalId, TaskId } from '@10db/contracts';
import { z } from 'zod';

/**
 * The Workbench's address (spec §4.2): `task` selects a page in the pass; `tasks` comes from the Board's
 * Work on These and ticks those tasks in the picker; `goal` comes from Factory's Work on This.
 */
export interface WorkbenchSearch {
  readonly task?: TaskId;
  readonly tasks?: readonly TaskId[];
  readonly goal?: GoalId;
}

const TaskIds = z.array(TaskId).min(1);

/** What a link to the Workbench says, each part kept only when it parses. */
export function workbenchSearch(search: Record<string, unknown>): WorkbenchSearch {
  const task = TaskId.safeParse(search['task']);
  const tasks = TaskIds.safeParse(search['tasks']);
  const goal = GoalId.safeParse(search['goal']);
  return {
    ...(task.success ? { task: task.data } : {}),
    ...(tasks.success ? { tasks: tasks.data } : {}),
    ...(goal.success ? { goal: goal.data } : {}),
  };
}
