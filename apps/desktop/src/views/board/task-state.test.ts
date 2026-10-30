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

  it.each(['DONE', 'CANCELLED'] as const)('says nothing for a %s run in an open batch', (state) => {
    expect(taskState(workstreamDto({ state }), batchDto({ state: 'OPEN' }), null)).toBeNull();
  });

  it('says nothing without a workstream', () => {
    expect(taskState(undefined, undefined, null)).toBeNull();
  });
});
