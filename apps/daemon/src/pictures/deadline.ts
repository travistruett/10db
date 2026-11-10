import type { Clock } from '../clock';

/** The work ran past its deadline and was told to stop. */
export class DeadlineError extends Error {
  override readonly name = 'DeadlineError';
}

/**
 * Runs `work` and settles within `ms` whatever it does: past the deadline it calls `stop` (which ends
 * what the work waits on) and rejects with a `DeadlineError`, without waiting for the work.
 */
export function withDeadline<T>(
  clock: Clock,
  ms: number,
  work: () => Promise<T>,
  stop: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = clock.setTimeout(() => {
      if (done) return;
      done = true;
      stop();
      reject(new DeadlineError(`ran past ${String(Math.round(ms / 1000))} s`));
    }, ms);
    work().then(
      (value) => {
        if (done) return;
        done = true;
        timer.cancel();
        resolve(value);
      },
      (error: unknown) => {
        if (done) return;
        done = true;
        timer.cancel();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
