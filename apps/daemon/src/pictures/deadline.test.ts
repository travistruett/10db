import { describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { DeadlineError, withDeadline } from './deadline';

describe('withDeadline', () => {
  it('settles with a deadline error when the work never does, and tells the work to stop', async () => {
    const clock = new ManualClock();
    let stopped = 0;
    const settled = withDeadline(
      clock,
      1_000,
      () => new Promise<string>(() => undefined),
      () => {
        stopped += 1;
      },
    );
    clock.advance(999);
    expect(stopped).toBe(0);
    clock.advance(1);
    await expect(settled).rejects.toBeInstanceOf(DeadlineError);
    expect(stopped).toBe(1);
  });

  it('answers what the work answers in time, and leaves no timer behind', async () => {
    const clock = new ManualClock();
    let stopped = 0;
    const settled = withDeadline(
      clock,
      1_000,
      () => Promise.resolve('shot'),
      () => {
        stopped += 1;
      },
    );
    expect(await settled).toBe('shot');
    expect(clock.pendingTimers()).toBe(0);
    clock.advance(5_000);
    expect(stopped).toBe(0);
  });

  it('passes on the work’s own failure', async () => {
    const clock = new ManualClock();
    await expect(
      withDeadline(
        clock,
        1_000,
        () => Promise.reject(new Error('net::ERR_ABORTED')),
        () => undefined,
      ),
    ).rejects.toThrow('net::ERR_ABORTED');
    expect(clock.pendingTimers()).toBe(0);
  });
});
