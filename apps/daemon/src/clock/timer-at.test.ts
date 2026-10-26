import { describe, expect, it } from 'vitest';
import { ManualClock, MAX_TIMER_MS, timerAt } from './index';

/** Records each delay asked for, as Node would see it. */
class RecordingClock extends ManualClock {
  readonly delays: number[] = [];
  override setTimeout(fn: () => void, ms: number) {
    this.delays.push(ms);
    return super.setTimeout(fn, ms);
  }
}

const DAY_MS = 24 * 60 * 60_000;

describe('timerAt', () => {
  it('fires at the time, in steps no longer than Node accepts, and not before', () => {
    const clock = new RecordingClock();
    const at = new Date(clock.now().getTime() + 30 * DAY_MS);
    let fired = 0;
    timerAt(clock, at, () => {
      fired += 1;
    });
    expect(clock.delays).toEqual([MAX_TIMER_MS]);
    clock.advance(MAX_TIMER_MS);
    expect(fired).toBe(0);
    clock.advance(30 * DAY_MS - MAX_TIMER_MS - 1);
    expect(fired).toBe(0);
    clock.advance(1);
    expect(fired).toBe(1);
    expect(clock.delays.every((ms) => ms <= MAX_TIMER_MS)).toBe(true);
    expect(clock.pendingTimers()).toBe(0);
  });

  it('fires once a time already past comes round, and stops when cancelled', () => {
    const clock = new RecordingClock();
    let fired = 0;
    timerAt(clock, new Date(clock.now().getTime() - 1), () => {
      fired += 1;
    });
    clock.advance(0);
    expect(fired).toBe(1);
    const cancelled = timerAt(clock, new Date(clock.now().getTime() + 40 * DAY_MS), () => {
      fired += 1;
    });
    clock.advance(MAX_TIMER_MS);
    cancelled.cancel();
    clock.advance(40 * DAY_MS);
    expect(fired).toBe(1);
  });
});
