import {
  ACTIVE_STATES,
  BoardStatus,
  type GoalId,
  InvalidError,
  type PickerProposalDto,
  type ProjectId,
  type StepPlanDto,
  type TaskId,
} from '@10db/contracts';
import {
  activeClaims,
  claimRequestsForTask,
  getGoal,
  getProject,
  getTask,
  listTasks,
  listWorkstreams,
  type DbReader,
} from '@10db/db';
import { pickCandidates } from '../picker';
import { resolveStepPlan } from './steps';

/** Claim names active work holds or will claim when it launches, each with its task's title. */
function heldClaims(db: DbReader, projectId: ProjectId): Map<string, string> {
  const held = new Map<string, string>();
  for (const ws of listWorkstreams(db, { states: ACTIVE_STATES, projectId })) {
    // A queued workstream holds no claims until it launches, so its task's areas count too.
    const names = [...getTask(db, ws.taskId).areas, ...activeClaims(db, ws.id).map((c) => c.name)];
    for (const name of names) if (!held.has(name)) held.set(name, ws.taskTitle);
  }
  return held;
}

/**
 * The approval sheet's input (spec §5.2.4): the picker's order and choices, with each candidate's plan.
 * With a `goalId` the pool is that goal's tasks alone (goals spec §9), cut before the picker counts
 * `size`, so the sheet fills with the goal's work; a goal of another project is refused.
 */
export function proposeCandidates(
  db: DbReader,
  projectId: ProjectId,
  size: number,
  goalId?: GoalId,
): PickerProposalDto {
  const project = getProject(db, projectId);
  if (goalId !== undefined && getGoal(db, goalId).projectId !== projectId) {
    throw new InvalidError(`Goal ${goalId} is not in this project`);
  }
  const tasks = listTasks(db, projectId).filter((t) => goalId === undefined || t.goalId === goalId);
  const plans = new Map<TaskId, StepPlanDto>();
  const planErrors = new Map<TaskId, string>();
  const ruledOut = new Map<TaskId, string>();
  for (const task of tasks) {
    if (task.boardStatus !== BoardStatus.Ready || task.boardColumnId !== null) continue;
    try {
      const plan = resolveStepPlan(db, task.id);
      plans.set(task.id, plan);
      if (plan.overBudget.length > 0) {
        const steps = plan.overBudget.map(
          (i) => `step ${String(i + 1)} (${plan.steps[i]?.role ?? 'unknown'})`,
        );
        ruledOut.set(task.id, `Over the budget ceiling: ${steps.join(', ')}`);
      }
    } catch (error) {
      if (!(error instanceof InvalidError)) throw error;
      planErrors.set(task.id, error.message);
      ruledOut.set(task.id, error.message);
    }
  }
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const picks = pickCandidates({
    tasks,
    held: heldClaims(db, projectId),
    hazards: new Set(project.hazards.map((h) => h.name)),
    ruledOut,
    size,
  });
  return {
    projectId,
    size,
    candidates: picks.flatMap(({ taskId, proposed, resumed, unblocks, conflict }) => {
      const task = byId.get(taskId);
      if (!task) return [];
      return [
        {
          task,
          proposed,
          resumed,
          unblocks,
          conflict,
          claims: claimRequestsForTask(task, project),
          plan: plans.get(taskId) ?? null,
          planError: planErrors.get(taskId) ?? null,
        },
      ];
    }),
  };
}
