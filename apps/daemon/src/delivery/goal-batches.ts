import {
  BatchState,
  WorkspaceMode,
  type BatchDto,
  type LandingTarget,
  type TaskDto,
  type TaskId,
} from '@10db/contracts';
import { batchLanding, same } from './landing';
import { batchPlacement } from './placement';

/**
 * What decides whether a task ships with its goal, which the caller reads from the playbook and the
 * kinds: `ships` is true for a task with a goal whose row ships with its goal and none of whose kinds
 * has its own copy; `target` is where the task lands.
 */
export interface GoalShipping {
  ships(task: TaskDto): boolean;
  target(task: TaskDto): LandingTarget;
}

/** An open batch of the project and the tasks it holds. */
export interface OpenGoalBatch<B extends Pick<BatchDto, 'state' | 'worktreePath'> & LandingBatch> {
  readonly batch: B;
  readonly tasks: readonly TaskDto[];
}

type LandingBatch = Pick<BatchDto, 'baseBranch' | 'autoMerge'>;

/** A task in a Shape landing group keeps that group's rule for where it ships. */
const inLandingGroup = (task: TaskDto): boolean =>
  task.landingGroupId !== null && task.landingGroupId !== undefined;

/**
 * The links a start adds between tasks of one goal that ship with it, as pairs for `groupByDependency`:
 * each such task outside a landing group is linked to the first earlier one of its goal that lands the same way. Tasks that
 * land differently stay apart, so sharing a batch never refuses a start.
 */
export function goalPairs(
  tasks: readonly TaskDto[],
  shipping: GoalShipping,
): (readonly [TaskId, TaskId])[] {
  const pairs: (readonly [TaskId, TaskId])[] = [];
  const firstOf: { task: TaskDto; target: LandingTarget }[] = [];
  for (const task of tasks) {
    if (!shipping.ships(task) || inLandingGroup(task)) continue;
    const target = shipping.target(task);
    const first = firstOf.find((f) => f.task.goalId === task.goalId && same(f.target, target));
    if (first === undefined) firstOf.push({ task, target });
    else pairs.push([task.id, first.task.id]);
  }
  return pairs;
}

/**
 * The open batch a task started later joins, or null to start its own. The batch must be a copy that
 * is open (not cutting, shipping or failed), hold a task of the same goal, hold only tasks that ship
 * with their goal, and land the way the task does. A task in a landing group keeps that group's rule.
 */
export function goalJoin<B extends Pick<BatchDto, 'state' | 'worktreePath'> & LandingBatch>(
  task: TaskDto,
  open: readonly OpenGoalBatch<B>[],
  shipping: GoalShipping,
): B | null {
  if (!shipping.ships(task)) return null;
  if (inLandingGroup(task)) return null;
  const target = shipping.target(task);
  const found = open.find(
    ({ batch, tasks }) =>
      batch.state === BatchState.Open &&
      batchPlacement(batch) === WorkspaceMode.Worktree &&
      same(batchLanding(batch), target) &&
      tasks.every((t) => shipping.ships(t)) &&
      tasks.some((t) => t.goalId === task.goalId),
  );
  return found?.batch ?? null;
}
