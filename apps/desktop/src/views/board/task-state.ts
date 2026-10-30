import {
  BatchState,
  FIX_ATTEMPT_LIMIT,
  rejectionsSentBack,
  WorkstreamState,
  type BatchDto,
  type WorkstreamDto,
} from '@10db/contracts';
import type { MantineColor } from '@mantine/core';
import { FAILURE_LABELS } from './batch-labels';

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
): TaskState | null {
  if (!workstream) return null;
  switch (workstream.state) {
    case S.Queued:
      return { line: 'Queued', color: 'gray' };
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
      return batch?.state === BatchState.Shipping ? { line: 'Shipping', color: 'blue' } : null;
    case S.Cancelled:
      return null;
  }
}
