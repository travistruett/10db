import type { Clock } from '../clock';

/** The work ran past its deadline and was told to stop. */
export class DeadlineError extends Error {
  override readonly name = 'DeadlineError';
}

/**
 * Runs `work` and settles within `ms`, or as soon as `signal` aborts, whatever the work does: it then
 * calls `stop` (which ends what the work waits on) and rejects, with a `DeadlineError` or the
 * signal's reason, without waiting for the work. A signal aborted already never starts it.
 */
export function withDeadline<T>(
  clock: Clock,
  ms: number,
  work: () => Promise<T>,
  stop: () => void,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const asError = (reason: unknown): Error =>
      reason instanceof Error ? reason : new Error(String(reason));
    if (signal?.aborted === true) {
      reject(asError(signal.reason));
      return;
    }
    let done = false;
    const finish = (): boolean => {
      if (done) return false;
      done = true;
      timer.cancel();
      signal?.removeEventListener('abort', aborted);
      return true;
    };
    const aborted = (): void => {
      if (!finish()) return;
      stop();
      reject(asError(signal?.reason));
    };
    const timer = clock.setTimeout(() => {
      if (!finish()) return;
      stop();
      reject(new DeadlineError(`ran past ${String(Math.round(ms / 1000))} s`));
    }, ms);
    signal?.addEventListener('abort', aborted, { once: true });
    work().then(
      (value) => {
        if (finish()) resolve(value);
      },
      (error: unknown) => {
        if (finish()) reject(asError(error));
      },
    );
  });
}
