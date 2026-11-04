import {
  BatchState,
  FIX_ATTEMPT_LIMIT,
  LEFT_OUT_NOTICE_KEY,
  PARKED_NOTICE_KEY,
  PullRequestChecks,
  PullRequestState,
  rejectionsSentBack,
  retryTargetAfterRejection,
  StepRole,
  TaskStatus,
  WorkstreamFailure,
  WorkstreamState,
  type BatchDto,
  type WorkstreamStep,
  type ShippedAtLimit,
  type Notice,
  type TaskDto,
  type WorkstreamDto,
} from '@10db/contracts';
import type { MantineColor } from '@mantine/core';
import { canClose, canRetry } from '../factory/workstream-state';
import { FAILURE_LABELS } from './batch-labels';
import { ciLine, type CiLink } from './ci-line';
import { ordinal } from './queue-place';

const S = WorkstreamState;

/** A task's state as the board says it: one plain line and the DESIGN.md status color. */
export interface TaskState {
  readonly line: string;
  readonly color: MantineColor;
  /** Where the line's CI result lives: a job's page or the pull request's checks. */
  readonly link?: CiLink | null;
  /** A failure's raw reason, behind the plain line: the card's tooltip. */
  readonly detail?: string | null;
}

/** "The gate failed" reads mid-sentence as "the gate failed"; an acronym keeps its capitals. */
function lowerFirst(text: string): string {
  const [first = '', second = ''] = text;
  return second === second.toLowerCase() ? first.toLowerCase() + text.slice(1) : text;
}

/** A step as a failure line names it. */
const STEP_NAME: Readonly<Record<StepRole, string>> = {
  [StepRole.Plan]: 'plan',
  [StepRole.PlanReview]: 'plan review',
  [StepRole.Implement]: 'build',
  [StepRole.Review]: 'review',
  [StepRole.Qa]: 'QA',
};

/**
 * What happened, by the failure kind the daemon recorded. `step` names the step the run failed on, or
 * is null for a run with no step plan. A kind this build doesn't know, or none, gets the generic line.
 */
function whatHappened(kind: string | null, step: string | null): string {
  switch (kind) {
    case WorkstreamFailure.NoResult:
      return `The ${step ? `${step} ` : ''}session stopped without reporting a result.`;
    case WorkstreamFailure.GateFailed:
      return `The checks kept failing and the ${step ?? 'run'}${step ? ' step' : ''} ran out of fix attempts.`;
    case WorkstreamFailure.SessionFailed:
      return `The ${step ? `${step} ` : ''}session kept crashing or could not start.`;
    case WorkstreamFailure.RetryLimit:
      return `The ${step ? `${step} step` : 'run'} ran out of fix attempts.`;
    case WorkstreamFailure.RejectedAtLimit:
      return `The ${step ? `${step} step` : 'review'} rejected the work with no fix attempts left.`;
    case WorkstreamFailure.InstallBroken:
      return 'The copy’s installed packages are broken, so the checks could not start. Nothing in the task’s code was at fault.';
    case null:
    default:
      return `The ${step ? `${step} step` : 'run'} failed.`;
  }
}

/**
 * What Retry will do, read from the same rules `retryWorkstream` follows: after a reviewer's rejection
 * it sends the work back to the step the rejection goes to, otherwise it restarts the failed step, and
 * either way it starts the fix attempts over.
 */
function whatRetryDoes(
  kind: string | null,
  steps: readonly WorkstreamStep[],
  stepIndex: number,
  step: string | null,
): string {
  const target = retryTargetAfterRejection(steps, stepIndex);
  const rework = target === null ? undefined : steps[target];
  if (step && rework)
    return `Retry sends the work back to the ${STEP_NAME[rework.role]} step with the ${step} findings, and the ${step} runs after it.`;
  if (!step) return 'Retry runs it again.';
  switch (kind) {
    case WorkstreamFailure.GateFailed:
    case WorkstreamFailure.RetryLimit:
      return `Retry runs the ${step} step again with its fix attempts reset.`;
    case WorkstreamFailure.SessionFailed:
      return `Retry runs the ${step} step again in a new session.`;
    case WorkstreamFailure.InstallBroken:
      return `Retry installs the packages again, then runs the ${step} step again.`;
    case null:
    default:
      return `Retry runs the ${step} step again.`;
  }
}

/**
 * A failed run in plain words: what happened, then what Retry will do. The Board card, the task drawer
 * and Factory's rows all say this line; the raw `failureReason` stays beside it. `retryable` is
 * whether `retryWorkstream` would accept a retry (`canRetryRun`): when it would refuse, the line says
 * only what happened and never promises a Retry.
 */
export function failureLine(
  workstream: Pick<WorkstreamDto, 'steps' | 'stepIndex'> & { readonly failureKind: string | null },
  retryable: boolean,
): string {
  const failed = workstream.steps[workstream.stepIndex];
  const step = failed ? STEP_NAME[failed.role] : null;
  const happened = whatHappened(workstream.failureKind, step);
  if (!retryable) return happened;
  return `${happened} ${whatRetryDoes(workstream.failureKind, workstream.steps, workstream.stepIndex, step)}`;
}

function building(workstream: WorkstreamDto): string {
  const total = workstream.steps.length;
  return total > 0
    ? `Building · step ${String(workstream.stepIndex + 1)} of ${String(total)}`
    : 'Building';
}

const CHECKS_LINE: Readonly<Record<PullRequestChecks, TaskState | null>> = {
  [PullRequestChecks.Pending]: { line: ' · checks pending', color: 'blue' },
  [PullRequestChecks.Passing]: { line: ' · checks passing', color: 'green' },
  [PullRequestChecks.Failing]: { line: ' · checks failing', color: 'red' },
  [PullRequestChecks.None]: { line: ' · no checks', color: 'gray' },
  [PullRequestChecks.Unknown]: { line: ' · checks unknown', color: 'orange' },
};

/**
 * What a shipped pull request says about its tasks: for one with required checks, where CI stands
 * (CI-decides spec §5, `ciLine`, which also says "Merged · CI passed"); else open with its checks,
 * closed without merging, or unreadable. Null before the batch has a pull request, and once one with
 * no required checks has merged (the task is then in Done and has nothing to say). `batches` is every
 * batch of the project, for a CI fix batch to find the root that holds the required checks.
 */
export function pullRequestState(
  batch: BatchDto | undefined,
  batches: readonly BatchDto[] = batch ? [batch] : [],
): TaskState | null {
  if (batch?.state !== BatchState.Shipped || !batch.prUrl) return null;
  const ci = ciLine(batch, batches);
  if (ci) return ci;
  const pr = batch.pr;
  if (pr === null) return { line: 'Pull request open', color: 'blue' };
  switch (pr.state) {
    case PullRequestState.Merged:
      return null;
    case PullRequestState.Closed:
      return { line: 'Pull request closed without merging', color: 'red' };
    case PullRequestState.Unknown:
      return {
        line: pr.unknownReason
          ? `Pull request status unknown: ${pr.unknownReason}`
          : 'Pull request status unknown',
        color: 'orange',
      };
    case PullRequestState.Open: {
      const checks = CHECKS_LINE[pr.checks];
      const failing = pr.failingChecks[0];
      const named = pr.checks === PullRequestChecks.Failing && failing ? `: ${failing.name}` : '';
      return {
        line: `Pull request open${checks?.line ?? ''}${named}`,
        color: checks?.color ?? 'blue',
      };
    }
  }
}

/** Whether the batch's pull request closed without merging, so its tasks go back to the builder. */
export function pullRequestClosed(batch: BatchDto | undefined): boolean {
  return batch?.state === BatchState.Shipped && batch.pr?.state === PullRequestState.Closed;
}

/** The task fields `retryWorkstream` reads before it accepts a retry. */
export type RetryTask = Pick<TaskDto, 'status' | 'boardColumnId' | 'workstreamId'>;

/**
 * Whether the batch lets a retry through: only an open or failed one reopens, and a run with no batch
 * has none to refuse. A run with a batch that is not loaded yet, or failed to, is not known to pass.
 */
function batchAllowsRetry(workstream: WorkstreamDto, batch: BatchDto | undefined): boolean {
  if (!batch) return workstream.batchId === null;
  return batch.state === BatchState.Open || batch.state === BatchState.Failed;
}

/**
 * Whether `retryWorkstream` would accept a retry of this run: it failed, its task was not closed or
 * parked and has no newer run, and its batch is still open or failed (retry reopens it; a batch shipped
 * anyway never reopens, so that run is run again with a fresh Start instead). Every line or button that
 * offers Retry asks this, so none promises what the daemon refuses.
 */
export function canRetryRun(
  task: RetryTask,
  workstream: WorkstreamDto,
  batch: BatchDto | undefined,
): boolean {
  return (
    canRetry(workstream.state) &&
    task.status !== TaskStatus.Cancelled &&
    task.boardColumnId === null &&
    task.workstreamId === workstream.id &&
    batchAllowsRetry(workstream, batch)
  );
}

/**
 * Whether a failed run can be started over instead of retried: its batch is still open or failed, so
 * Retry continues in it, and starting over cuts the task a new batch from the base branch. A parked
 * task is never started, as Start says too.
 */
export function canStartOver(
  task: Pick<TaskDto, 'boardColumnId'>,
  workstream: WorkstreamDto,
  batch: BatchDto | undefined,
): boolean {
  return (
    task.boardColumnId === null &&
    canRetry(workstream.state) &&
    (batch?.state === BatchState.Open || batch?.state === BatchState.Failed)
  );
}

/**
 * Whether a failed run's task can be closed. One shipped anyway is judged by its pull request, as
 * the daemon does: refused while it is open or merged, allowed once it closed without merging.
 */
export function canCloseRun(workstream: WorkstreamDto, batch: BatchDto | undefined): boolean {
  if (!canClose(workstream.state)) return false;
  return batch?.state !== BatchState.Shipped || !batch.prUrl || pullRequestClosed(batch);
}

/** A failed run shipped anyway whose pull request closed without merging: Start runs it afresh. */
export function shippedAnywayAndClosed(
  workstream: WorkstreamDto | undefined,
  batch: BatchDto | undefined,
): boolean {
  return workstream?.state === S.Failed && pullRequestClosed(batch);
}

/**
 * How often the review sent the work back, against the limit that fails the task; null when it
 * never did, or a retry has started the count over.
 */
export function reviewSentBackLine(workstream: WorkstreamDto | undefined): string | null {
  if (!workstream) return null;
  const sentBack = rejectionsSentBack(workstream);
  return sentBack > 0
    ? `Review sent back ${String(sentBack)} of ${String(FIX_ATTEMPT_LIMIT)}`
    : null;
}

/**
 * The follow-up tasks filed when the work shipped at the retry limit with findings still open, in
 * step order: one per step that rejected past the limit (a review, then the QA after it). Empty
 * otherwise.
 */
export function shippedAtLimit(workstream: WorkstreamDto | undefined): ShippedAtLimit[] {
  return (workstream?.steps ?? []).flatMap((s) => (s.shippedAtLimit ? [s.shippedAtLimit] : []));
}

/** The sentence a card and the drawer say of work that shipped at the retry limit; null when it did not. */
export function shippedAtLimitLine(workstream: WorkstreamDto | undefined): string | null {
  const shipped = shippedAtLimit(workstream);
  if (shipped.length === 0) return null;
  const titles = shipped.map((s) => s.followUpTitle).join('; ');
  return `Shipped at the retry limit with open findings. ${shipped.length === 1 ? 'Follow-up task' : 'Follow-up tasks'}: ${titles}`;
}

/**
 * Whether what a batch stands for is still going: not ended without shipping, and a shipped one not
 * yet merged or closed. Only then do its notices still say something true.
 */
function batchStands(batch: BatchDto): boolean {
  switch (batch.state) {
    case BatchState.Abandoned:
    case BatchState.Closed:
      return false;
    case BatchState.Shipped:
      return (
        batch.pr?.state !== PullRequestState.Merged && batch.pr?.state !== PullRequestState.Closed
      );
    case BatchState.Cutting:
    case BatchState.Open:
    case BatchState.Shipping:
    case BatchState.Failed:
      return true;
  }
}

/**
 * The notices a task's card and drawer show besides its state: what its run waits for, such as another
 * task's hazard, then what its batch stands in, such as a conflict with its base. These ask the builder
 * nothing, so none is an Inbox card. None for a cancelled or failed run, which have their own say, but
 * a run the builder parked keeps the question they answered and what they said, and a failed run the
 * batch shipped without keeps the notice that it was left out of the pull request.
 */
export function taskNotices(
  workstream: WorkstreamDto | undefined,
  batch: BatchDto | undefined,
): Notice[] {
  if (!workstream) return [];
  if (workstream.state === S.Cancelled)
    return workstream.notice?.key === PARKED_NOTICE_KEY ? [workstream.notice] : [];
  // A failed run has its own say, except where the builder shipped the batch without it.
  if (workstream.state === S.Failed)
    return workstream.notice?.key === LEFT_OUT_NOTICE_KEY ? [workstream.notice] : [];
  return [
    ...(workstream.notice ? [workstream.notice] : []),
    ...(batch && batchStands(batch) ? batch.notices : []),
  ];
}

/** The colors a notice's warning turns orange: the ones that say nothing needs the builder yet. */
const CALM: ReadonlySet<MantineColor> = new Set(['blue', 'gray', 'green']);

/**
 * What a task is doing right now, from its latest workstream and the batch it ships in, with the
 * notices that stand beside it. Null when there is nothing to say: no run, a cancelled one, or finished
 * work that is not being shipped and has no notice. A failed run says what Retry will do only when
 * `retryWorkstream` would accept it; pass `task` so a closed, parked or replaced run is judged too
 * (without it only the batch is).
 */
export function taskState(
  workstream: WorkstreamDto | undefined,
  batch: BatchDto | undefined,
  gateCommand: string | null,
  place?: number,
  batches?: readonly BatchDto[],
  task?: RetryTask,
): TaskState | null {
  const state = stateOf(workstream, batch, gateCommand, place, batches, task);
  const notices = taskNotices(workstream, batch);
  if (notices.length === 0) return state;
  const text = notices.map((n) => n.line).join(' · ');
  const warns = notices.some((n) => n.tone === 'warning');
  if (!state) return { line: text, color: warns ? 'orange' : 'blue' };
  return {
    ...state,
    line: `${state.line} · ${text}`,
    color: warns && CALM.has(state.color) ? 'orange' : state.color,
  };
}

function stateOf(
  workstream: WorkstreamDto | undefined,
  batch: BatchDto | undefined,
  gateCommand: string | null,
  place?: number,
  batches?: readonly BatchDto[],
  task?: RetryTask,
): TaskState | null {
  if (!workstream) return null;
  switch (workstream.state) {
    case S.Queued:
      if (place === undefined) return { line: 'Queued', color: 'gray' };
      return {
        line: place === 1 ? 'Queued · next in line' : `Queued · ${ordinal(place)} in line`,
        color: 'gray',
      };
    case S.Held:
      return { line: 'Held: not in the queue', color: 'gray' };
    case S.Starting:
    case S.Running:
    case S.HandingOff:
    case S.TakenOver:
      return { line: building(workstream), color: 'blue' };
    case S.Verifying:
      return { line: gateCommand ? `Checking: ${gateCommand}` : 'Checking', color: 'blue' };
    case S.WaitingHuman:
      return { line: 'Waiting on you: answer in Inbox', color: 'yellow' };
    case S.PausedLimit:
      return { line: 'Paused: usage limit', color: 'orange' };
    case S.Recovering:
      return { line: 'Recovering', color: 'orange' };
    case S.Failed:
      // A failed run the builder shipped anyway is judged by its pull request.
      if (batch?.state === BatchState.Shipped && batch.prUrl)
        return pullRequestState(batch, batches);
      return {
        line: failureLine(
          workstream,
          task ? canRetryRun(task, workstream, batch) : batchAllowsRetry(workstream, batch),
        ),
        color: 'red',
        detail: workstream.failureReason,
      };
    case S.Done:
      if (batch?.state === BatchState.Failed) {
        return {
          line: batch.failure
            ? `Not shipped: ${lowerFirst(FAILURE_LABELS[batch.failure])}`
            : 'Not shipped',
          color: 'red',
        };
      }
      if (batch?.state === BatchState.Shipping) return { line: 'Shipping', color: 'blue' };
      return pullRequestState(batch, batches);
    case S.Cancelled:
      return null;
  }
}
