import {
  BatchState,
  FIX_ATTEMPT_LIMIT,
  PullRequestChecks,
  PullRequestState,
  rejectionsSentBack,
  WorkstreamState,
  type BatchDto,
  type WorkstreamDto,
} from '@10db/contracts';
import type { MantineColor } from '@mantine/core';
import { canClose, canRetry } from '../factory/workstream-state';
import { FAILURE_LABELS } from './batch-labels';
import { ordinal } from './queue-place';

const S = WorkstreamState;

/** A task's state as the board says it: one plain line and the DESIGN.md status color. */
export interface TaskState {
  readonly line: string;
  readonly color: MantineColor;
}

/** "The gate failed" reads mid-sentence as "the gate failed"; an acronym keeps its capitals. */
function lowerFirst(text: string): string {
  const [first = '', second = ''] = text;
  return second === second.toLowerCase() ? first.toLowerCase() + text.slice(1) : text;
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
 * What a shipped pull request says about its tasks: open with its checks, closed without merging,
 * or unreadable. Null before the batch has a pull request, and once it has merged (the task is then
 * in Done and has nothing to say).
 */
export function pullRequestState(batch: BatchDto | undefined): TaskState | null {
  if (batch?.state !== BatchState.Shipped || !batch.prUrl) return null;
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

/**
 * Whether a failed run can be retried: retry reopens its batch, and a batch shipped anyway never
 * reopens, so a run whose batch shipped is run again with a fresh Start instead.
 */
export function canRetryRun(workstream: WorkstreamDto, batch: BatchDto | undefined): boolean {
  return canRetry(workstream.state) && batch?.state !== BatchState.Shipped;
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
 * What a task is doing right now, from its latest workstream and the batch it ships in. Null when
 * there is nothing to say: no run, a cancelled one, or finished work that is not being shipped.
 */
export function taskState(
  workstream: WorkstreamDto | undefined,
  batch: BatchDto | undefined,
  gateCommand: string | null,
  place?: number,
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
      if (batch?.state === BatchState.Shipped && batch.prUrl) return pullRequestState(batch);
      return {
        line: workstream.failureReason
          ? `Failed: ${lowerFirst(workstream.failureReason)}`
          : 'Failed',
        color: 'red',
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
      return pullRequestState(batch);
    case S.Cancelled:
      return null;
  }
}
