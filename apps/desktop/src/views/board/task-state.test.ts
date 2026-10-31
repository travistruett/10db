import type { BatchDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { batchDto, stepDto, workstreamDto } from '../../test/fixtures';
import { taskNotices, taskState } from './task-state';

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
    {
      name: 'a failure with a reason',
      ws: workstreamDto({
        state: 'FAILED',
        failureReason: 'The gate failed 3 times (last exit 2)',
      }),
      line: 'Failed: the gate failed 3 times (last exit 2)',
      color: 'red',
    },
    {
      name: 'a failure with no reason',
      ws: workstreamDto({ state: 'FAILED', failureReason: null }),
      line: 'Failed',
      color: 'red',
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
      ).toEqual({ line: 'Failed', color: 'red' });
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
  });
});
