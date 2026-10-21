import {
  ConflictError,
  InvalidError,
  WorkstreamState,
  type BatchId,
  type StepPlanDto,
  type TaskId,
  type WorkstreamDto,
  type WorkstreamId,
} from '@10db/contracts';
import {
  findFlowByName,
  getFlow,
  getProject,
  getTask,
  getTeam,
  getWorkstream,
  getWorkstreamRow,
  insertWorkstream,
  latestHandoffForStep,
  listModelProfiles,
  listPersonas,
  patchWorkstream,
  transitionWorkstream,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import type { StateStore } from '../events';
import { DEFAULT_PROJECT_FLOW, NoProfileError, planSteps } from '../routing';
import { restartStep } from './step-flow';

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

/** The plan a start would run; refuses one that no profile within the budget ceiling can run. */
export function planForStart(db: DbReader, taskId: TaskId): StepPlanDto {
  const plan = resolveStepPlan(db, taskId);
  if (plan.overBudget.length > 0) {
    const ceiling = getProject(db, getTask(db, taskId).projectId).budgetCeiling;
    const named = plan.overBudget.map((i) => {
      const step = plan.steps[i];
      const need = step ? `${String(step.need)} ${step.score}` : '?';
      return `Step ${String(i + 1)} (${step?.role ?? '?'}, need ${need}) has no profile within the budget ceiling of $${String(ceiling)}: ${step?.reason ?? 'unknown'}`;
    });
    throw new InvalidError(
      `${named.join('. ')}. Raise the ceiling, lower the need or pin a persona.`,
    );
  }
  if (plan.steps.length === 0) throw new InvalidError('The flow resolved to no steps');
  return plan;
}

/** Inserts the task's workstream on its plan; `batchId` is the batch it runs in, null in local delivery. */
export function insertPlannedWorkstream(
  ctx: WriteContext,
  taskId: TaskId,
  plan: StepPlanDto,
  batchId: BatchId | null,
): WorkstreamDto {
  const [first] = plan.steps;
  if (!first) throw new InvalidError('The flow resolved to no steps');
  const ws = insertWorkstream(ctx, taskId, { batchId });
  patchWorkstream(ctx, ws.id, null, {
    steps: plan.steps.map((s, i) =>
      i === 0 ? { ...s, status: 'running', startedAt: ctx.now } : s,
    ),
    stepIndex: 0,
    model: first.model,
    effort: first.effort,
  });
  return getWorkstream(ctx.tx, ws.id);
}

/** Starts a task in local delivery: its plan, then its workstream. */
export function startTaskWithPlan(state: StateStore, taskId: TaskId): WorkstreamDto {
  const plan = planForStart(state.db, taskId);
  return state.write((ctx) => insertPlannedWorkstream(ctx, taskId, plan, null));
}

/** A failed workstream goes back to the queue; its current step restarts clean, from its own handoffs only. */
export function retryWorkstream(state: StateStore, id: WorkstreamId): WorkstreamDto {
  const row = getWorkstreamRow(state.db, id);
  if (row.state !== WorkstreamState.Failed)
    throw new ConflictError('Only a failed workstream can be retried');
  return state.write((ctx) => {
    const steps = row.steps.length > 0 ? restartStep(row.steps, row.stepIndex, ctx.now) : row.steps;
    const latest = latestHandoffForStep(ctx.tx, { ...row, steps });
    return transitionWorkstream(ctx, id, {
      to: WorkstreamState.Queued,
      fence: null,
      patch: {
        attempt: 0,
        recoveryAttempts: 0,
        failureReason: null,
        steps,
        nextAction: latest
          ? { kind: 'continue_from_handoff', handoffId: latest.id }
          : { kind: 'start' },
      },
      reason: 'retried by the builder',
    });
  });
}
