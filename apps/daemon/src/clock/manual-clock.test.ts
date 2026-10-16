import { describe, expect, it } from 'vitest';
import { ManualClock, systemClock } from './index';

describe('ManualClock', () => {
  it('fires due timers in time order and leaves later ones pending', () => {
    const clock = new ManualClock(new Date('2026-10-13T12:00:00.000Z'));
    const fired: string[] = [];
    clock.setTimeout(() => fired.push('b'), 2000);
    clock.setTimeout(() => fired.push('a'), 1000);
    clock.setTimeout(() => fired.push('c'), 5000);
    clock.advance(2500);
    expect(fired).toEqual(['a', 'b']);
    expect(clock.now().toISOString()).toBe('2026-10-13T12:00:02.500Z');
    expect(clock.pendingTimers()).toBe(1);
  });

  it('does not fire a cancelled timer', () => {
    const clock = new ManualClock();
    let fired = false;
    clock
      .setTimeout(() => {
        fired = true;
      }, 10)
      .cancel();
    clock.advance(100);
    expect(fired).toBe(false);
    expect(clock.pendingTimers()).toBe(0);
  });
});

describe('systemClock', () => {
  it('reports the current time and fires a timer', async () => {
    const before = Date.now();
    expect(systemClock.now().getTime()).toBeGreaterThanOrEqual(before);
    await new Promise<void>((resolve) => {
      systemClock.setTimeout(resolve, 0);
    });
  });
});
