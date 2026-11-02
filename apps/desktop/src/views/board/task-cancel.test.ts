import { describe, expect, it } from 'vitest';
import { taskDto, workstreamDto } from '../../test/fixtures';
import { canCancelRun } from './task-cancel';

const task = taskDto({ title: 'Alpha' });

describe('canCancelRun', () => {
  it.each([
    'QUEUED',
    'STARTING',
    'RUNNING',
    'HANDING_OFF',
    'VERIFYING',
    'TAKEN_OVER',
    'WAITING_HUMAN',
    'PAUSED_LIMIT',
    'RECOVERING',
  ] as const)('is true for a %s run of an open task', (state) => {
    expect(canCancelRun(task, workstreamDto({ state }))).toBe(true);
  });

  it.each(['DONE', 'FAILED', 'CANCELLED'] as const)('is false for a %s run', (state) => {
    expect(canCancelRun(task, workstreamDto({ state }))).toBe(false);
  });

  it('is false for a held run, which Start and Remove handle', () => {
    expect(canCancelRun(task, workstreamDto({ state: 'HELD' }))).toBe(false);
  });

  it('is false for a task with no run, or one that is no longer open', () => {
    expect(canCancelRun(task, undefined)).toBe(false);
    expect(
      canCancelRun(taskDto({ status: 'cancelled' }), workstreamDto({ state: 'RUNNING' })),
    ).toBe(false);
  });
});
