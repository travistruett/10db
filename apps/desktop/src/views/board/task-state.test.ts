import {
  INSTALL_REPAIRED_NOTICE_KEY,
  LEFT_OUT_NOTICE_KEY,
  mintId,
  PARKED_NOTICE_KEY,
  REVERTED_NOTICE_KEY,
  type BatchDto,
} from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { batchDto, stepDto, taskDto, workstreamDto } from '../../test/fixtures';
import { canRetryRun, failureLine, taskHistory, taskNotices, taskState } from './task-state';

const AT = '2026-11-02T10:00:00.000Z';
const SESSION = mintId('Session');

/** A build step, then a review on `review`'s terms: the step the run failed on. */
function reviewFlow(review: Parameters<typeof stepDto>[0]) {
  return {
    steps: [
      stepDto({ status: 'done' }),
      stepDto({ role: 'review', tools: 'read_only', status: 'failed', ...review }),
    ],
    stepIndex: 1,
  };
}

const rejected = {
  result: { summary: 'Missing tests.', verdict: 'reject', sessionId: SESSION, at: AT },
} as const;

describe('failureLine', () => {
  it.each([
    {
      kind: 'no_result',
      ...reviewFlow({}),
      line: 'The review session stopped without reporting a result. Retry runs the review step again.',
    },
    {
      kind: 'gate_failed',
      steps: [stepDto({ status: 'failed' })],
      stepIndex: 0,
      line: 'The checks kept failing and the build step ran out of fix attempts. Retry runs the build step again with its fix attempts reset.',
    },
    {
      kind: 'session_failed',
      steps: [stepDto({ status: 'failed' })],
      stepIndex: 0,
      line: 'The build session kept crashing or could not start. Retry runs the build step again in a new session.',
    },
    {
      kind: 'retry_limit',
      steps: [stepDto({ status: 'failed' })],
      stepIndex: 0,
      line: 'The build step ran out of fix attempts. Retry runs the build step again with its fix attempts reset.',
    },
    {
      kind: 'rejected_at_limit',
      ...reviewFlow(rejected),
      line: 'The review step rejected the work with no fix attempts left. Retry sends the work back to the build step with the review findings, and the review runs after it.',
    },
    {
      // With no earlier step to do the rework, retryWorkstream reruns the review itself.
      kind: 'rejected_at_limit',
      steps: [
        stepDto({ role: 'review', tools: 'read_only', status: 'failed', result: rejected.result }),
      ],
      stepIndex: 0,
      line: 'The review step rejected the work with no fix attempts left. Retry runs the review step again.',
    },
    {
      kind: 'rejected_at_limit',
      steps: [
        stepDto({ role: 'plan', status: 'done' }),
        stepDto({ role: 'plan_review', tools: 'read_only', status: 'failed', ...rejected }),
      ],
      stepIndex: 1,
      line: 'The plan review step rejected the work with no fix attempts left. Retry sends the work back to the plan step with the plan review findings, and the plan review runs after it.',
    },
    {
      kind: null,
      steps: [stepDto({ status: 'failed' })],
      stepIndex: 0,
      line: 'The build step failed. Retry runs the build step again.',
    },
    {
      kind: 'a_kind_from_a_newer_daemon',
      steps: [stepDto({ status: 'failed' })],
      stepIndex: 0,
      line: 'The build step failed. Retry runs the build step again.',
    },
    {
      kind: null,
      steps: [],
      stepIndex: 0,
      line: 'The run failed. Retry runs it again.',
    },
    {
      kind: 'no_result',
      steps: [],
      stepIndex: 0,
      line: 'The session stopped without reporting a result. Retry runs it again.',
    },
  ])('says $kind on step $stepIndex in plain words', ({ kind, steps, stepIndex, line }) => {
    expect(failureLine({ failureKind: kind, steps, stepIndex }, true)).toBe(line);
  });

  describe('a run whose commits were reverted', () => {
    const revertSha = 'a'.repeat(40);
    const notice = (key: string, body: string) => ({
      key,
      tone: 'info' as const,
      line: 'x',
      body,
    });
    const flow = reviewFlow({});

    it('says Retry goes to the build step when the run was left out with a revert', () => {
      const line = failureLine(
        {
          failureKind: 'no_result',
          ...flow,
          notice: notice(LEFT_OUT_NOTICE_KEY, `Left out.\n\nRevert commit: ${revertSha}`),
        },
        true,
      );
      expect(line).toBe(
        'The review session stopped without reporting a result. Retry sends the work back to the build step and tells it its commits were reverted, and the review runs after it.',
      );
    });

    it('does not promise the build step for a run left out with nothing reverted', () => {
      expect(
        failureLine(
          {
            failureKind: 'no_result',
            ...flow,
            notice: notice(LEFT_OUT_NOTICE_KEY, 'It had no commits.'),
          },
          true,
        ),
      ).toBe(
        'The review session stopped without reporting a result. Retry runs the review step again.',
      );
    });

    it('hedges for a retried run, which is sent back only if it has not committed since', () => {
      const line = failureLine(
        {
          failureKind: 'no_result',
          ...flow,
          notice: notice(REVERTED_NOTICE_KEY, `Reverted.\n\nRevert commit: ${revertSha}`),
        },
        true,
      );
      expect(line).toContain('Retry sends the work back to the build step');
      expect(line).toContain('unless the run has committed since');
    });
  });

  it.each([
    {
      kind: 'gate_failed',
      steps: [stepDto({ status: 'failed' })],
      line: 'The checks kept failing and the build step ran out of fix attempts.',
    },
    {
      kind: 'rejected_at_limit',
      ...reviewFlow(rejected),
      line: 'The review step rejected the work with no fix attempts left.',
    },
    { kind: null, steps: [], line: 'The run failed.' },
  ])('says only what happened for $kind when Retry would be refused', ({ kind, steps, line }) => {
    const stepIndex = Math.max(steps.length - 1, 0);
    const said = failureLine({ failureKind: kind, steps, stepIndex }, false);
    expect(said).toBe(line);
    expect(said).not.toContain('Retry');
  });

  it('is the failed card’s line, with the raw reason as its detail', () => {
    const ws = workstreamDto({
      state: 'FAILED',
      failureKind: 'gate_failed',
      failureReason: 'The gate failed 4 times (last exit 2)',
      steps: [stepDto({ status: 'failed' })],
    });
    expect(taskState(ws, undefined, 'make gate')).toEqual({
      line: failureLine(ws, true),
      color: 'red',
      detail: 'The gate failed 4 times (last exit 2)',
    });
  });

  it('says only what happened on the card when the batch shipped without a pull request', () => {
    const ws = workstreamDto({ state: 'FAILED', failureKind: 'gate_failed' });
    const shipped = batchDto({ state: 'SHIPPED', prUrl: null });
    expect(taskState(ws, shipped, 'make gate')?.line).toBe(failureLine(ws, false));
  });

  it.each([
    { name: 'closed', task: { status: 'cancelled' as const } },
    { name: 'parked', task: { boardColumnId: mintId('BoardColumn') } },
    { name: 'replaced by a newer run', task: { workstreamId: mintId('Workstream') } },
  ])('says only what happened on the card when the task is $name', ({ task: over }) => {
    const ws = workstreamDto({ state: 'FAILED', failureKind: 'gate_failed' });
    const task = taskDto({ workstreamId: ws.id, ...over });
    const line = taskState(ws, undefined, null, undefined, undefined, task)?.line;
    expect(line).toBe(failureLine(ws, false));
    expect(line).not.toContain('Retry');
  });

  it('says only what happened on the card while the run’s batch is not known', () => {
    const ws = workstreamDto({
      state: 'FAILED',
      failureKind: 'gate_failed',
      batchId: mintId('Batch'),
    });
    const task = taskDto({ workstreamId: ws.id });
    expect(taskState(ws, undefined, null)?.line).toBe(failureLine(ws, false));
    expect(taskState(ws, undefined, null, undefined, undefined, task)?.line).toBe(
      failureLine(ws, false),
    );
  });

  it('keeps promising Retry on the card when the task is retryable', () => {
    const ws = workstreamDto({ state: 'FAILED', failureKind: 'gate_failed' });
    const task = taskDto({ workstreamId: ws.id });
    const open = batchDto({ state: 'OPEN' });
    expect(taskState(ws, open, null, undefined, undefined, task)?.line).toBe(failureLine(ws, true));
  });

  it('gives a run that failed before kinds were kept the generic line and no detail without a reason', () => {
    const ws = workstreamDto({ state: 'FAILED', failureReason: null });
    expect(taskState(ws, undefined, 'make gate')).toEqual({
      line: 'The run failed. Retry runs it again.',
      color: 'red',
      detail: null,
    });
  });
});

describe('canRetryRun', () => {
  const failed = workstreamDto({ state: 'FAILED' });
  const own = taskDto({ workstreamId: failed.id });

  it('accepts what retryWorkstream accepts: a failed latest run of an open task in an open or failed batch', () => {
    expect(canRetryRun(own, failed, undefined)).toBe(true);
    expect(canRetryRun(own, failed, batchDto({ state: 'OPEN' }))).toBe(true);
    expect(canRetryRun(own, failed, batchDto({ state: 'FAILED' }))).toBe(true);
  });

  it.each(['SHIPPED', 'SHIPPING', 'ABANDONED', 'CLOSED', 'CUTTING'] as const)(
    'refuses a run whose batch is %s',
    (state) => {
      expect(canRetryRun(own, failed, batchDto({ state }))).toBe(false);
    },
  );

  it('does not promise a retry of a run whose batch is not known, which may refuse it', () => {
    const open = batchDto({ state: 'OPEN' });
    const batched = workstreamDto({ state: 'FAILED', batchId: open.id });
    const task = taskDto({ workstreamId: batched.id });
    expect(canRetryRun(task, batched, undefined)).toBe(false);
    expect(canRetryRun(task, batched, open)).toBe(true);
  });

  it('refuses a run that is not failed, and a task that is closed, parked or has a newer run', () => {
    expect(canRetryRun(own, workstreamDto({ id: failed.id, state: 'RUNNING' }), undefined)).toBe(
      false,
    );
    expect(canRetryRun({ ...own, status: 'cancelled' }, failed, undefined)).toBe(false);
    expect(canRetryRun({ ...own, boardColumnId: mintId('BoardColumn') }, failed, undefined)).toBe(
      false,
    );
    expect(canRetryRun({ ...own, workstreamId: mintId('Workstream') }, failed, undefined)).toBe(
      false,
    );
  });
});

describe('taskState', () => {
  it.each([
    {
      name: 'a running first step',
      ws: workstreamDto({ state: 'RUNNING', steps: [stepDto(), stepDto()] }),
      line: 'Building · step 1 of 2',
      color: 'blue',
    },
    {
      name: 'the second step',
      ws: workstreamDto({
        state: 'RUNNING',
        stepIndex: 1,
        steps: [stepDto(), stepDto()],
      }),
      line: 'Building · step 2 of 2',
      color: 'blue',
    },
    {
      name: 'a run with no step plan',
      ws: workstreamDto({ state: 'RUNNING', steps: [] }),
      line: 'Building',
      color: 'blue',
    },
    {
      name: 'a gate check',
      ws: workstreamDto({ state: 'VERIFYING' }),
      line: 'Checking: make gate',
      color: 'blue',
    },
    {
      name: 'waiting on the builder',
      ws: workstreamDto({ state: 'WAITING_HUMAN' }),
      line: 'Waiting on you: answer in Inbox',
      color: 'yellow',
    },
    {
      name: 'a usage limit',
      ws: workstreamDto({ state: 'PAUSED_LIMIT' }),
      line: 'Paused: usage limit',
      color: 'orange',
    },
    { name: 'a queued run', ws: workstreamDto({ state: 'QUEUED' }), line: 'Queued', color: 'gray' },
    {
      name: 'a held run',
      ws: workstreamDto({ state: 'HELD' }),
      line: 'Held: not in the queue',
      color: 'gray',
    },
  ] as const)('says $name in one line', ({ ws, line, color }) => {
    expect(taskState(ws, undefined, 'make gate')).toEqual({ line, color });
  });

  it.each([
    { place: undefined, line: 'Queued' },
    { place: 1, line: 'Queued · next in line' },
    { place: 3, line: 'Queued · 3rd in line' },
  ])('says a queued run in place $place as "$line"', ({ place, line }) => {
    expect(taskState(workstreamDto({ state: 'QUEUED' }), undefined, null, place)).toEqual({
      line,
      color: 'gray',
    });
  });

  it('says Checking alone when the project has no gate command', () => {
    expect(taskState(workstreamDto({ state: 'VERIFYING' }), undefined, null)?.line).toBe(
      'Checking',
    );
  });

  it.each([
    {
      name: 'finished work whose ship failed',
      batch: batchDto({ state: 'FAILED', failure: 'gate_failed' }),
      line: 'Not shipped: the gate failed',
      color: 'red',
    },
    {
      name: 'finished work being shipped',
      batch: batchDto({ state: 'SHIPPING' }),
      line: 'Shipping',
      color: 'blue',
    },
  ])('says $name', ({ batch, line, color }) => {
    expect(taskState(workstreamDto({ state: 'DONE' }), batch, 'make gate')).toEqual({
      line,
      color,
    });
  });

  const PR = 'https://github.com/acme/widgets/pull/9';
  const shipped = (pr: Partial<NonNullable<BatchDto['pr']>> | null) =>
    batchDto({
      state: 'SHIPPED',
      prUrl: PR,
      pr:
        pr === null
          ? null
          : {
              state: 'open',
              checks: 'pending',
              failingChecks: [],
              checkedAt: '2026-10-29T12:00:00.000Z',
              unknownReason: null,
              ...pr,
            },
    });

  it.each([
    {
      name: 'an open pull request not yet read',
      batch: shipped(null),
      line: 'Pull request open',
      color: 'blue',
    },
    {
      name: 'an open pull request with checks pending',
      batch: shipped({ checks: 'pending' }),
      line: 'Pull request open · checks pending',
      color: 'blue',
    },
    {
      name: 'an open pull request with checks passing',
      batch: shipped({ checks: 'passing' }),
      line: 'Pull request open · checks passing',
      color: 'green',
    },
    {
      name: 'an open pull request with checks failing',
      batch: shipped({
        checks: 'failing',
        failingChecks: [{ name: 'build', url: null }],
      }),
      line: 'Pull request open · checks failing: build',
      color: 'red',
    },
    {
      name: 'an open pull request with no checks',
      batch: shipped({ checks: 'none' }),
      line: 'Pull request open · no checks',
      color: 'gray',
    },
    {
      name: 'a pull request whose state could not be read',
      batch: shipped({ state: 'unknown', checks: 'passing', unknownReason: 'gh is signed out' }),
      line: 'Pull request status unknown: gh is signed out',
      color: 'orange',
    },
    {
      name: 'a pull request closed without merging',
      batch: shipped({ state: 'closed', checks: 'passing' }),
      line: 'Pull request closed without merging',
      color: 'red',
    },
  ] as const)('says $name', ({ batch, line, color }) => {
    expect(taskState(workstreamDto({ state: 'DONE' }), batch, 'make gate')).toEqual({
      line,
      color,
    });
  });

  it('says nothing once the pull request merged', () => {
    expect(
      taskState(workstreamDto({ state: 'DONE' }), shipped({ state: 'merged' }), 'make gate'),
    ).toBeNull();
  });

  it('judges a failed run that shipped anyway by its pull request', () => {
    expect(
      taskState(workstreamDto({ state: 'FAILED' }), shipped({ checks: 'passing' }), null)?.line,
    ).toBe('Pull request open · checks passing');
  });

  it.each(['DONE', 'CANCELLED'] as const)('says nothing for a %s run in an open batch', (state) => {
    expect(taskState(workstreamDto({ state }), batchDto({ state: 'OPEN' }), null)).toBeNull();
  });

  it('says nothing without a workstream', () => {
    expect(taskState(undefined, undefined, null)).toBeNull();
  });

  describe('notices', () => {
    const waiting = {
      key: 'claim-wait:hazard:migrations',
      tone: 'info',
      line: 'Waiting for hazard migrations: task "Beta" holds it',
      body: 'Task "Beta" holds hazard migrations.',
    } as const;
    const conflict = {
      key: 'base-conflict',
      tone: 'warning',
      line: 'Conflicts with main: README.md',
      body: 'x',
    } as const;

    it("adds the run's own notice to what it is doing, naming the other task", () => {
      expect(
        taskState(workstreamDto({ state: 'RUNNING', notice: waiting }), undefined, null),
      ).toEqual({
        line: `Building · ${waiting.line}`,
        color: 'blue',
      });
    });

    it("adds a batch's conflict to each of its tasks, in orange", () => {
      const batch = batchDto({ state: 'OPEN', notices: [conflict] });
      expect(taskState(workstreamDto({ state: 'RUNNING' }), batch, null)).toEqual({
        line: `Building · ${conflict.line}`,
        color: 'orange',
      });
      expect(taskState(workstreamDto({ state: 'QUEUED' }), batch, null)).toEqual({
        line: `Queued · ${conflict.line}`,
        color: 'orange',
      });
    });

    it('says a finished task in a batch that conflicts has the conflict, though it has nothing else to say', () => {
      const batch = batchDto({ state: 'OPEN', notices: [conflict] });
      expect(taskState(workstreamDto({ state: 'DONE' }), batch, null)).toEqual({
        line: conflict.line,
        color: 'orange',
      });
    });

    it('keeps the color of a task that needs the builder or has failed', () => {
      const batch = batchDto({ state: 'OPEN', notices: [conflict] });
      expect(taskState(workstreamDto({ state: 'WAITING_HUMAN' }), batch, null)?.color).toBe(
        'yellow',
      );
      expect(taskState(workstreamDto({ state: 'PAUSED_LIMIT' }), batch, null)?.color).toBe(
        'orange',
      );
    });

    it('says nothing of a notice on a cancelled or failed run', () => {
      const batch = batchDto({ state: 'OPEN', notices: [conflict] });
      expect(taskState(workstreamDto({ state: 'CANCELLED' }), batch, null)).toBeNull();
      expect(
        taskState(workstreamDto({ state: 'FAILED', failureReason: null }), batch, null),
      ).toEqual({ line: 'The run failed. Retry runs it again.', color: 'red', detail: null });
    });

    it('shows a pull request that waits for the builder beside what its checks say, until it merges or closes', () => {
      const notice = { ...conflict, key: 'pull-request-merge', line: 'Pull request waits for you' };
      expect(
        taskState(
          workstreamDto({ state: 'DONE' }),
          { ...shipped({ checks: 'passing' }), notices: [notice] },
          null,
        ),
      ).toEqual({
        line: 'Pull request open · checks passing · Pull request waits for you',
        color: 'orange',
      });
      for (const state of ['merged', 'closed'] as const)
        expect(
          taskState(
            workstreamDto({ state: 'DONE' }),
            { ...shipped({ state }), notices: [notice] },
            null,
          )?.line ?? '',
        ).not.toContain('waits for you');
    });

    it('says nothing of a batch that ended without shipping', () => {
      for (const state of ['ABANDONED', 'CLOSED'] as const)
        expect(
          taskState(
            workstreamDto({ state: 'DONE' }),
            batchDto({ state, notices: [conflict] }),
            null,
          ),
        ).toBeNull();
    });

    it('lists the notices a task shows, the run’s first', () => {
      const batch = batchDto({ state: 'OPEN', notices: [conflict] });
      expect(taskNotices(workstreamDto({ state: 'RUNNING', notice: waiting }), batch)).toEqual([
        waiting,
        conflict,
      ]);
      expect(taskNotices(undefined, batch)).toEqual([]);
    });

    it('keeps the notice of a failed run its batch shipped without, and no other', () => {
      const leftOut = {
        key: LEFT_OUT_NOTICE_KEY,
        tone: 'info' as const,
        line: 'Left out of the pull request: its commit was reverted',
        body: 'This run failed, and you chose Ship without it.',
      };
      const batch = batchDto({ state: 'SHIPPED', notices: [conflict] });
      expect(taskNotices(workstreamDto({ state: 'FAILED', notice: leftOut }), batch)).toEqual([
        leftOut,
      ]);
      expect(taskNotices(workstreamDto({ state: 'FAILED', notice: waiting }), batch)).toEqual([]);
    });

    it('keeps the reverted-work notice of a retried run that failed again', () => {
      const reverted = {
        key: REVERTED_NOTICE_KEY,
        tone: 'warning' as const,
        line: 'Its earlier commits were reverted: only new commits are in the pull request',
        body: 'You chose Ship without it for this run.',
      };
      const batch = batchDto({ state: 'OPEN', notices: [conflict] });
      expect(taskNotices(workstreamDto({ state: 'FAILED', notice: reverted }), batch)).toEqual([
        reverted,
      ]);
    });

    describe('history', () => {
      const repaired = {
        key: INSTALL_REPAIRED_NOTICE_KEY,
        tone: 'info' as const,
        line: 'The install in this copy was repaired at 2026-11-03 10:00 UTC',
        body: 'x',
      };

      it('keeps the install repair on a failed run and on finished work in a closed batch', () => {
        expect(
          taskHistory(
            workstreamDto({ state: 'FAILED' }),
            batchDto({ state: 'OPEN', notices: [conflict, repaired] }),
          ),
        ).toEqual([repaired]);
        for (const state of ['CLOSED', 'ABANDONED'] as const)
          expect(
            taskHistory(
              workstreamDto({ state: 'DONE' }),
              batchDto({ state, notices: [conflict, repaired] }),
            ),
          ).toEqual([repaired]);
        expect(
          taskHistory(workstreamDto({ state: 'DONE' }), {
            ...shipped({ state: 'merged' }),
            notices: [repaired],
          }),
        ).toEqual([repaired]);
      });

      it('lists it once: not again where the live notices already show it', () => {
        expect(
          taskHistory(
            workstreamDto({ state: 'RUNNING' }),
            batchDto({ state: 'OPEN', notices: [repaired] }),
          ),
        ).toEqual([]);
      });

      it('has nothing without a repair or a batch', () => {
        expect(
          taskHistory(workstreamDto({ state: 'FAILED' }), batchDto({ notices: [conflict] })),
        ).toEqual([]);
        expect(taskHistory(workstreamDto({ state: 'FAILED' }), undefined)).toEqual([]);
        expect(taskHistory(undefined, batchDto({ notices: [repaired] }))).toEqual([]);
      });

      it('leaves the card’s state line as it is', () => {
        expect(
          taskState(
            workstreamDto({ state: 'DONE' }),
            batchDto({ state: 'CLOSED', notices: [repaired] }),
            null,
          ),
        ).toBeNull();
      });
    });

    it('keeps the question and answer of a run the builder parked, though it was cancelled', () => {
      const parked = {
        key: PARKED_NOTICE_KEY,
        tone: 'info' as const,
        line: 'Parked after your answer to: Can you capture the checks?',
        body: 'Question: Can you capture the checks?\n\nYour answer: Park the task',
      };
      expect(taskNotices(workstreamDto({ state: 'CANCELLED', notice: parked }), undefined)).toEqual(
        [parked],
      );
      // Any other notice of a cancelled run is stale.
      expect(
        taskNotices(workstreamDto({ state: 'CANCELLED', notice: waiting }), undefined),
      ).toEqual([]);
    });
  });
});
