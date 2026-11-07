import {
  ConflictError,
  BatchState,
  EvidenceKind,
  InvalidError,
  lastRevertTold,
  LEFT_OUT_NOTICE_KEY,
  McpToolName,
  McpToolOutputs,
  NEW_TASK_NO_AREAS,
  revertCommitIn,
  StepRole,
  TaskStatus,
  ToolAccess,
  WorkstreamState,
  type BatchId,
  type NextAction,
  type Notice,
  type StepPlanDto,
  type TaskId,
  type WorkstreamDto,
  type WorkstreamId,
  type WorkstreamStep,
} from '@10db/contracts';
import {
  findFlowByName,
  getBatch,
  getEvidence,
  getFlow,
  getProject,
  getTask,
  getTeam,
  getWorkstream,
  getWorkstreamRow,
  insertEvidence,
  insertWorkstream,
  latestHandoffForStep,
  listEvidence,
  listSessions,
  listToolOpResults,
  listWorkstreams,
  listPersonas,
  patchWorkstream,
  setWorkstreamNotice,
  transitionBatch,
  transitionWorkstream,
  type DbReader,
  type WorkstreamRow,
  type WriteContext,
} from '@10db/db';
import type { StateStore } from '../events';
import { DEFAULT_PROJECT_FLOW, NoProfileError, planSteps } from '../routing';
import { routingInputs } from './routing-inputs';
import {
  commitCoveredByRevert,
  commitAdaptsMerge,
  lastRevertNoteAt,
  revertCommitOf,
  revertOfRun,
  revertOfRuns,
  revertedWorkNote,
  revertedWorkNotice,
} from './reverted-work';
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
      ...routingInputs(db, project),
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

/**
 * Inserts the run a task started again gets when it joins a batch that already holds earlier runs of
 * it. When an earlier run was left out by Ship without it, or was retried after it, the revert is
 * still on the batch's branch, so the new run's session is told as a retry would tell it: the same
 * builder note, as the step's fix. The new run is then one that was told, and a commit it makes after
 * the revert brings the task's work back in the pull request. Only a start puts a run here: a merge
 * run the shipping gate sends to a finished task goes through `insertPlannedWorkstream` and is not told.
 * A run that starts on a read-only plan step is told what happened, and `actionEntering` asks its
 * implement step to redo the work.
 */
export function insertJoinedWorkstream(
  ctx: WriteContext,
  taskId: TaskId,
  plan: StepPlanDto,
  batchId: BatchId,
): WorkstreamDto {
  const earlier = listWorkstreams(ctx.tx, { batchId }).filter((run) => run.taskId === taskId);
  const ws = insertPlannedWorkstream(ctx, taskId, plan, batchId);
  const revert = revertOfRuns(
    earlier.map((run) => ({ notice: run.notice, evidence: listEvidence(ctx.tx, run.id) })),
  );
  const [first] = plan.steps;
  if (revert === null || !first) return ws;
  const note = insertBuilderNote(ctx, ws.id, revertedWorkNote(revert, first));
  patchWorkstream(ctx, ws.id, null, { nextAction: { kind: 'fix', evidenceId: note.id } });
  return getWorkstream(ctx.tx, ws.id);
}

function insertBuilderNote(ctx: WriteContext, workstreamId: WorkstreamId, summary: string) {
  return insertEvidence(ctx, {
    workstreamId,
    kind: 'builder',
    command: null,
    exitCode: null,
    summary,
    logPath: null,
    commitShas: [],
  });
}

/**
 * What step `to` starts on when the run moves forward into it. An implement step that follows a plan
 * is entered long after the retry or start that told the run of a revert, and it is the step that has
 * to redo the work, so it gets the note as its fix, stamped in the write that enters it. Once an
 * implement step has started since the note, that step was told and any commit it made stands.
 */
export function actionEntering(ctx: WriteContext, row: WorkstreamRow, to: number): NextAction {
  const step = row.steps[to];
  if (step?.role !== StepRole.Implement) return { kind: 'start' };
  const evidence = listEvidence(ctx.tx, row.id);
  const revert = lastRevertTold(evidence);
  const since = lastRevertNoteAt(evidence);
  if (revert === null || since === null) return { kind: 'start' };
  const told = row.steps.some(
    (s) => s.role === StepRole.Implement && s.startedAt !== null && s.startedAt >= since,
  );
  if (told) return { kind: 'start' };
  const note = insertBuilderNote(ctx, row.id, revertedWorkNote(revert, step));
  return { kind: 'fix', evidenceId: note.id };
}

/** Starts a task in local delivery: its plan, then its workstream. */
export function startTaskWithPlan(state: StateStore, taskId: TaskId): WorkstreamDto {
  const plan = planForStart(state.db, taskId);
  return state.write((ctx) => insertPlannedWorkstream(ctx, taskId, plan, null));
}

/** The nearest implement step before a read-only step; null for any other step, or when none is before it. */
function implementBefore(steps: readonly WorkstreamStep[], index: number): number | null {
  const step = steps[index];
  if (!step || step.role === StepRole.Implement || step.role === StepRole.Plan) return null;
  for (let i = index - 1; i >= 0; i -= 1) if (steps[i]?.role === StepRole.Implement) return i;
  return null;
}

/**
 * The revert commit a retry must tell its session about: the run's commits are still reverted on the
 * batch's branch. A run left out holds a revert on its notice. A run retried before holds it in the
 * note its session was given, and is told again unless it has committed since: a commit after the
 * revert brings work back, and 10db never undoes a revert. A commit that resolved conflict markers of
 * a base merge, or one made fixing a failed gate, brings none back, as the pull request reads them too, and neither does a result that
 * made no new commit and handed the session a commit the revert covers (a reused opId). `kept` is a revert Ship without it
 * left on the branch without writing the run's notice (its write failed, and the batch's left-out
 * card holds it). It covers this run, and it is told of that one unless it is the revert the run was
 * told of already: a different revert undid what the run had by then. The card is never older than
 * the run's record, because the answer that writes the notices closes it. A run whose `left-out` notice
 * names no revert has none on the branch, whatever its notes say (`revertOfRun`), and neither has one
 * a Retry recorded that for, so only `kept` can apply to them.
 */
function revertStillOn(
  db: DbReader,
  row: { readonly id: WorkstreamId; readonly notice: Notice | null },
  kept: string | null,
): string | null {
  const named = row.notice?.key === LEFT_OUT_NOTICE_KEY ? revertCommitOf(row.notice) : null;
  if (named !== null) return named;
  const evidence = listEvidence(db, row.id);
  const record = revertOfRun({ notice: row.notice, evidence });
  if (record === null || (kept !== null && kept !== record.revert)) return kept;
  const since = lastRevertNoteAt(evidence);
  if (since !== null)
    for (const result of listToolOpResults(db, row.id, McpToolName.Commit, since))
      if (
        McpToolOutputs.commit.safeParse(result).success &&
        !commitAdaptsMerge(result) &&
        !commitCoveredByRevert(result)
      )
        return null;
  return record.revert;
}

/**
 * A failed workstream goes back to the queue; its current step restarts clean, from its own handoffs
 * only, except where a revert stands on the batch's branch (see `revertStillOn`). Then a read-only
 * step with an implement step before it is not what restarts: the nearest implement step before it
 * does, as after a reviewer's rejection, with the revert note as its fix, because only that step can
 * commit the work again. The note is written again on every Retry until the run has committed since
 * the revert (a second Retry of a run that committed nothing tells the session once more). A step
 * before the first implement step (a plan or plan review) restarts as usual with a note that says
 * only what happened, and the implement step gets the full note when the run enters it
 * (`actionEntering`). A parked task, or a workstream a newer one replaced, is not retried. In a batch it may retry
 * only while the batch is OPEN or FAILED, and a FAILED batch reopens (batch delivery spec §4), except
 * a worktree batch: it stays FAILED until delivery has made its worktree whole and reopens it. A run
 * left out of the batch's pull request (Ship without it) stops being left out in the same write.
 * When a reviewer's rejection failed it, the retry runs the step the rejection goes back to instead,
 * with the review's notes. The builder's `note`, when they give one, reaches the step that runs next
 * whatever failed it, and the retry starts the send-back count over
 * (decisions/2026-10-29-review-findings-on-the-builders-screens.md). `keptRevert` is the revert the
 * batch's open left-out card holds when it covers this run (see `revertStillOn`); the caller reads it.
 */
export function retryWorkstream(
  state: StateStore,
  id: WorkstreamId,
  note?: string,
  keptRevert: string | null = null,
): WorkstreamDto {
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
    // Its work may go in the pull request now, so "left out" is no longer true of this run. But the
    // revert commit is still on the branch: the run keeps a notice that says so (the pull request
    // lists its task as done only if the run commits again), and its session is told in the note below.
    const revert = revertStillOn(ctx.tx, row, keptRevert);
    if (revert) setWorkstreamNotice(ctx, id, revertedWorkNotice(revert));
    // No revert stands. That notice was the only thing saying so, and the old notes outlive it, so the
    // answer goes on the run's record, where every reader of the notes finds it.
    const noRevert = revert === null && row.notice?.key === LEFT_OUT_NOTICE_KEY;
    if (noRevert) {
      setWorkstreamNotice(ctx, id, null);
      insertEvidence(ctx, {
        workstreamId: id,
        kind: EvidenceKind.NoRevert,
        command: null,
        exitCode: null,
        summary: "Ship without it found no revert of this run on the batch's branch.",
        logPath: null,
        commitShas: [],
      });
    }
    // A revert note is for the step that can commit: a read-only step cannot redo the work, and its
    // rejection would send the work back to the implement step without the note. So a retry that
    // tells of a revert restarts the implement step before a read-only one, as a rejection would.
    // A step before the first implement step restarts as usual, told only what happened, and the
    // implement step gets the note when the run enters it (`actionEntering`).
    const reworkAt =
      retryTargetAfterRejection(row.steps, row.stepIndex) ??
      (revert ? implementBefore(row.steps, row.stepIndex) : null);
    const reworked = reworkAt === null ? undefined : row.steps[reworkAt];
    const runsNext = reworked ?? row.steps[row.stepIndex];
    // The builder's note is a fix for whichever step runs next, as when they send the work back. It
    // is stamped in the same write that starts that step, so a fresh session still finds it outstanding.
    const text = [
      note?.trim() ?? '',
      revert ? revertedWorkNote(revert, runsNext ?? { tools: ToolAccess.Edit }) : '',
    ]
      .filter((part) => part !== '')
      .join('\n\n');
    const evidence = text === '' ? null : insertBuilderNote(ctx, id, text);
    // The fix a restarted step keeps, unless it is the note of a revert that is gone.
    const keptFix =
      row.nextAction.kind === 'fix' &&
      !(noRevert && revertCommitIn(getEvidence(ctx.tx, row.nextAction.evidenceId).summary) !== null)
        ? row.nextAction
        : null;
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
          failureKind: null,
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
      keptFix && !evidence
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
        failureKind: null,
        steps,
        // A new note is the fix; otherwise work the builder sent back that ran out of attempts keeps
        // its note, and a gate failure its output, for the restarted step.
        nextAction: evidence
          ? { kind: 'fix', evidenceId: evidence.id }
          : (keptFix ??
            (latest ? { kind: 'continue_from_handoff', handoffId: latest.id } : { kind: 'start' })),
      },
      reason: 'retried by the builder',
    });
  });
}
