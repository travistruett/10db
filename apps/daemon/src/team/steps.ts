import {
  ConflictError,
  BatchState,
  InvalidError,
  NEW_TASK_NO_AREAS,
  TaskStatus,
  WorkstreamState,
  type BatchId,
  type StepPlanDto,
  type TaskId,
  type WorkstreamDto,
  type WorkstreamId,
} from '@10db/contracts';
import {
  findFlowByName,
  getBatch,
  getFlow,
  getProject,
  getTask,
  getTeam,
  getWorkstream,
  getWorkstreamRow,
  insertEvidence,
  insertWorkstream,
  latestHandoffForStep,
  listSessions,
  getAccount,
  listModelProfiles,
  listPersonas,
  patchWorkstream,
  transitionBatch,
  transitionWorkstream,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import type { StateStore } from '../events';
import { DEFAULT_PROJECT_FLOW, NoProfileError, offeredProfiles, planSteps } from '../routing';
import { clearSendBacks, restartStep, retryTargetAfterRejection, sendBackSteps } from './step-flow';

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
      profiles: offeredProfiles(
        listModelProfiles(db),
        getAccount(db, project.accountId).settings.aliases,
      ),
    });
  } catch (error) {
    if (error instanceof NoProfileError) throw new InvalidError(error.message);
    throw error;
  }
}

/**
 * The plan a start would run. Refuses a task with no areas, as the New Task form does: the lane would
 * launch holding no claim, and everything it wrote before asking for one would be a write outside
 * every claim. Refuses a plan that no profile within the budget ceiling can run.
 */
export function planForStart(db: DbReader, taskId: TaskId): StepPlanDto {
  const task = getTask(db, taskId);
  if (task.areas.length === 0)
    throw new InvalidError(
      `${NEW_TASK_NO_AREAS} for "${task.title}" before it starts: set its areas on the task.`,
    );
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
  const ws = insertWorkstream(ctx, taskId, {
    batchId,
    first: { model: first.model, effort: first.effort },
  });
  patchWorkstream(ctx, ws.id, null, {
    steps: plan.steps.map((s, i) =>
      i === 0 ? { ...s, status: 'running', startedAt: ctx.now } : s,
    ),
    stepIndex: 0,
  });
  return getWorkstream(ctx.tx, ws.id);
}

/** Starts a task in local delivery: its plan, then its workstream. */
export function startTaskWithPlan(state: StateStore, taskId: TaskId): WorkstreamDto {
  const plan = planForStart(state.db, taskId);
  return state.write((ctx) => insertPlannedWorkstream(ctx, taskId, plan, null));
}

/**
 * A failed workstream goes back to the queue; its current step restarts clean, from its own handoffs
 * only. A parked task, or a workstream a newer one replaced, is not retried. In a batch it may retry
 * only while the batch is OPEN or FAILED, and a FAILED batch reopens (batch delivery spec §4), except
 * a worktree batch: it stays FAILED until delivery has made its worktree whole and reopens it.
 * When a reviewer's rejection failed it, the retry runs the step the rejection goes back to instead,
 * with the review's notes. The builder's `note`, when they give one, reaches the step that runs next
 * whatever failed it, and the retry starts the send-back count over
 * (decisions/2026-10-29-review-findings-on-the-builders-screens.md).
 */
export function retryWorkstream(state: StateStore, id: WorkstreamId, note?: string): WorkstreamDto {
  const row = getWorkstreamRow(state.db, id);
  if (row.state !== WorkstreamState.Failed)
    throw new ConflictError('Only a failed workstream can be retried');
  const task = getTask(state.db, row.taskId);
  if (task.status === TaskStatus.Cancelled)
    throw new ConflictError(`${task.title} was closed, so its run can't be retried`);
  if (task.boardColumnId !== null)
    throw new ConflictError(
      `${task.title} is parked; move it to Backlog or Ready before retrying it`,
    );
  if (task.workstreamId !== id)
    throw new ConflictError(
      `${task.title} has a newer workstream; retry that one or start the task`,
    );
  const batch = row.batchId ? getBatch(state.db, row.batchId) : null;
  if (batch && batch.state !== BatchState.Open && batch.state !== BatchState.Failed)
    throw new ConflictError(
      `Batch "${batch.title}" is ${batch.state.toLowerCase()}; start the task again to run it in a new batch`,
    );
  return state.write((ctx) => {
    if (batch?.state === BatchState.Failed && batch.worktreePath === null)
      transitionBatch(ctx, batch.id, {
        to: BatchState.Open,
        patch: { failure: null },
        reason: 'a workstream was retried',
      });
    // The builder's note is a fix for whichever step runs next, as when they send the work back. It
    // is stamped in the same write that starts that step, so a fresh session still finds it outstanding.
    const text = note?.trim() ?? '';
    const evidence =
      text === ''
        ? null
        : insertEvidence(ctx, {
            workstreamId: id,
            kind: 'builder',
            command: null,
            exitCode: null,
            summary: text,
            logPath: null,
            commitShas: [],
          });
    const reworkAt = retryTargetAfterRejection(row.steps, row.stepIndex);
    const reworked = reworkAt === null ? undefined : row.steps[reworkAt];
    if (reworkAt !== null && reworked) {
      // A reviewer's rejection used the attempts up: the step that did the work runs again, as when
      // the rejection sent it back, with the review's notes and the builder's note if they gave one.
      return transitionWorkstream(ctx, id, {
        to: WorkstreamState.Queued,
        fence: null,
        patch: {
          attempt: 0,
          recoveryAttempts: 0,
          failureReason: null,
          steps: clearSendBacks(
            sendBackSteps(row.steps, row.stepIndex, reworkAt, reworked, {
              now: ctx.now,
              sessions: getWorkstream(ctx.tx, id).sessionCount,
            }),
          ),
          stepIndex: reworkAt,
          model: reworked.model,
          effort: reworked.effort,
          nextAction: evidence
            ? { kind: 'fix', evidenceId: evidence.id }
            : { kind: 'revise', reviewStep: row.stepIndex },
        },
        reason: 'retried by the builder',
      });
    }
    // A step restarted to act on an earlier note keeps its start, which is how the note stays
    // outstanding for a session that starts fresh: the note was written after that start.
    const restarted =
      row.steps.length > 0
        ? clearSendBacks(
            restartStep(row.steps, row.stepIndex, ctx.now, listSessions(ctx.tx, id).length),
          )
        : row.steps;
    const steps =
      row.nextAction.kind === 'fix' && !evidence
        ? restarted.map((s, i) =>
            i === row.stepIndex ? { ...s, startedAt: row.steps[i]?.startedAt ?? s.startedAt } : s,
          )
        : restarted;
    const latest = latestHandoffForStep(ctx.tx, { ...row, steps });
    return transitionWorkstream(ctx, id, {
      to: WorkstreamState.Queued,
      fence: null,
      patch: {
        attempt: 0,
        recoveryAttempts: 0,
        failureReason: null,
        steps,
        // A new note is the fix; otherwise work the builder sent back that ran out of attempts keeps
        // its note, and a gate failure its output, for the restarted step.
        nextAction: evidence
          ? { kind: 'fix', evidenceId: evidence.id }
          : row.nextAction.kind === 'fix'
            ? row.nextAction
            : latest
              ? { kind: 'continue_from_handoff', handoffId: latest.id }
              : { kind: 'start' },
      },
      reason: 'retried by the builder',
    });
  });
}
