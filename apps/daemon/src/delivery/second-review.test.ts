import { mintId, WorkstreamFailure, WorkstreamState } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { batchCardFields, BatchCardChoice } from './batch-card';
import { secondReviewsDue, shipAnywayOffered } from './second-review';

const taskA = mintId('Task');
const taskB = mintId('Task');
const run = (taskId: typeof taskA, state: WorkstreamState, failureKind: string | null = null) => ({
  id: mintId('Workstream'),
  taskId,
  state,
  failureKind,
});

describe('the second review before Ship Anyway', () => {
  it('is due for a reviewer-rejected run once every other task has settled, and only once', () => {
    const rejected = run(taskA, WorkstreamState.Failed, WorkstreamFailure.RejectedAtLimit);
    const none = (): boolean => false;
    expect(secondReviewsDue([rejected, run(taskB, WorkstreamState.Done)], none)).toEqual([
      rejected,
    ]);
    expect(secondReviewsDue([rejected, run(taskB, WorkstreamState.Running)], none)).toEqual([]);
    expect(secondReviewsDue([rejected], (id) => id === rejected.id)).toEqual([]);
    const crashed = run(taskA, WorkstreamState.Failed, WorkstreamFailure.SessionFailed);
    expect(secondReviewsDue([crashed], none)).toEqual([]);
  });

  it('offers Ship Anyway for rejected work only after the second review, and for other work always', () => {
    const rejected = {
      state: WorkstreamState.Failed,
      failureKind: WorkstreamFailure.RejectedAtLimit,
    };
    expect(shipAnywayOffered(rejected, false)).toBe(false);
    expect(shipAnywayOffered(rejected, true)).toBe(true);
    expect(
      shipAnywayOffered(
        { state: WorkstreamState.Failed, failureKind: WorkstreamFailure.Blocked },
        false,
      ),
    ).toBe(true);
    const row = { id: mintId('Workstream'), batchId: mintId('Batch') };
    const labels = (offered: boolean) =>
      batchCardFields(row, null, undefined, offered)?.options.map((o) => o.label);
    expect(labels(false)).not.toContain(BatchCardChoice.ShipAnyway);
    expect(labels(true)).toContain(BatchCardChoice.ShipAnyway);
  });
});
