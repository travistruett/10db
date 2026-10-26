import type { Clock, Timer } from './index';

/** Node treats a longer delay as 1 ms, so a far-off time is waited for in steps. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Runs `fire` at `at`, however far ahead that is. Each step waits at most `MAX_TIMER_MS` and looks
 * at the clock again, so a step that ends early never fires the callback early.
 */
export function timerAt(clock: Clock, at: Date, fire: () => void): Timer {
  let current: Timer;
  function step(): void {
    const remaining = Math.max(0, at.getTime() - clock.now().getTime());
    current = clock.setTimeout(
      () => {
        if (clock.now() >= at) fire();
        else step();
      },
      Math.min(remaining, MAX_TIMER_MS),
    );
  }
  step();
  return {
    cancel: () => {
      current.cancel();
    },
  };
}
