import type { Clock } from '../clock';

/** Resolves with the value, or undefined after `ms` or on rejection. Never rejects. */
export function settleWithin<T>(
  clock: Clock,
  promise: Promise<T>,
  ms: number,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = clock.setTimeout(() => {
      resolve(undefined);
    }, ms);
    promise.then(
      (value) => {
        timer.cancel();
        resolve(value);
      },
      () => {
        timer.cancel();
        resolve(undefined);
      },
    );
  });
}
