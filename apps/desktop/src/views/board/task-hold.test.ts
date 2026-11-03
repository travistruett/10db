import { describe, expect, it } from 'vitest';
import { taskDto, workstreamDto } from '../../test/fixtures';
import { holdOption, isHeld } from './task-hold';

const task = taskDto({ title: 'Alpha' });
const fresh = { sessionCount: 0, attempt: 0, recoveryAttempts: 0 } as const;

describe('holdOption', () => {
  it('offers Hold for a queued run that has not run', () => {
    expect(holdOption(task, workstreamDto({ state: 'QUEUED', ...fresh }))).toEqual({
      kind: 'hold',
    });
  });

  it.each([
    { name: 'a lane granted', state: 'STARTING' },
    { name: 'a run in progress', state: 'RUNNING' },
    { name: 'a hand-off', state: 'HANDING_OFF' },
    { name: 'a gate check', state: 'VERIFYING' },
    { name: 'a session waiting on the builder', state: 'WAITING_HUMAN' },
    { name: 'a usage pause', state: 'PAUSED_LIMIT' },
    { name: 'a recovery', state: 'RECOVERING' },
    { name: 'a taken-over run', state: 'TAKEN_OVER' },
  ] as const)('refuses $name, saying it is running and how to stop it', ({ state }) => {
    expect(holdOption(task, workstreamDto({ state }))).toEqual({
      kind: 'refused',
      reason: 'It is running: cancel it first.',
    });
  });

  it('never names the task in a reason, since the builder is already looking at it', () => {
    for (const state of ['RUNNING', 'QUEUED'] as const) {
      const option = holdOption(task, workstreamDto({ state, sessionCount: 1 }));
      expect(option?.kind).toBe('refused');
      expect(JSON.stringify(option)).not.toContain('Alpha');
    }
  });

  it.each([
    { name: 'a session behind it', over: { sessionCount: 1 } },
    { name: 'an attempt behind it', over: { attempt: 1 } },
    { name: 'a recovery behind it', over: { recoveryAttempts: 1 } },
  ] as const)('refuses a queued run with $name, saying it has already run', ({ over }) => {
    expect(holdOption(task, workstreamDto({ state: 'QUEUED', ...fresh, ...over }))).toEqual({
      kind: 'refused',
      reason: 'It has already run: cancel it first.',
    });
  });

  it.each(['HELD', 'DONE', 'FAILED', 'CANCELLED'] as const)(
    'offers nothing for a %s run',
    (state) => {
      expect(holdOption(task, workstreamDto({ state }))).toBeNull();
    },
  );

  it('offers nothing for a task with no run, or a task that is no longer open', () => {
    expect(holdOption(task, undefined)).toBeNull();
    expect(
      holdOption(taskDto({ status: 'cancelled' }), workstreamDto({ state: 'QUEUED', ...fresh })),
    ).toBeNull();
  });
});

describe('isHeld', () => {
  it('is true only for a held run', () => {
    expect(isHeld(workstreamDto({ state: 'HELD' }))).toBe(true);
    expect(isHeld(workstreamDto({ state: 'QUEUED' }))).toBe(false);
    expect(isHeld(undefined)).toBe(false);
  });
});
