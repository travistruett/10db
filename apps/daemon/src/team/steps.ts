import { InvalidError, type StepPlanDto, type TaskId, type WorkstreamDto } from '@10db/contracts';
import {
  findFlowByName,
  getFlow,
  getProject,
  getTask,
  getTeam,
  getWorkstream,
  insertWorkstream,
  listModelProfiles,
  listPersonas,
  patchWorkstream,
  type DbReader,
} from '@10db/db';
import type { StateStore } from '../events';
import { DEFAULT_PROJECT_FLOW, NoProfileError, planSteps } from '../routing';

/** What starting this task would run: its flow resolved against the project's team and the catalogue. */
export function resolveStepPlan(db: DbReader, taskId: TaskId): StepPlanDto {
  const task = getTask(db, taskId);
  const project = getProject(db, task.projectId);
  const flowId = task.flowId ?? project.flowId;
  const flow = flowId ? getFlow(db, flowId) : findFlowByName(db, DEFAULT_PROJECT_FLOW);
  if (!flow)
    throw new InvalidError(`The ${DEFAULT_PROJECT_FLOW} flow is missing; restart 10db to seed it`);
  try {
    return planSteps({
      flow,
      task,
      project,
      personas: listPersonas(db),
      bindings: getTeam(db, project.id).bindings,
      profiles: listModelProfiles(db),
    });
  } catch (error) {
    if (error instanceof NoProfileError) throw new InvalidError(error.message);
    throw error;
  }
}

/** Starts a task on its resolved plan, refusing one that no profile within the budget ceiling can run. */
export function startTaskWithPlan(state: StateStore, taskId: TaskId): WorkstreamDto {
  const plan = resolveStepPlan(state.db, taskId);
  if (plan.overBudget.length > 0) {
    const ceiling = getProject(state.db, getTask(state.db, taskId).projectId).budgetCeiling;
    const named = plan.overBudget.map((i) => {
      const step = plan.steps[i];
      const need = step ? `${String(step.need)} ${step.score}` : '?';
      return `Step ${String(i + 1)} (${step?.role ?? '?'}, need ${need}) has no profile within the budget ceiling of $${String(ceiling)}`;
    });
    throw new InvalidError(
      `${named.join('. ')}. Raise the ceiling, lower the need or pin a persona.`,
    );
  }
  const first = plan.steps[0];
  if (!first) throw new InvalidError('The flow resolved to no steps');
  return state.write((ctx) => {
    const ws = insertWorkstream(ctx, taskId);
    patchWorkstream(ctx, ws.id, null, {
      steps: plan.steps.map((s, i) =>
        i === 0 ? { ...s, status: 'running', startedAt: ctx.now } : s,
      ),
      stepIndex: 0,
      model: first.model,
      effort: first.effort,
    });
    return getWorkstream(ctx.tx, ws.id);
  });
}
