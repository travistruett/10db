import type { BatchDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { batchDto, stepDto, workstreamDto } from '../../test/fixtures';
import { taskState } from './task-state';

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
  ] as const)('says $name in one line', ({ ws, line, color }) => {
    expect(taskState(ws, undefined, 'make gate')).toEqual({ line, color });
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
});
