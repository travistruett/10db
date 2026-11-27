import type { Clock } from '../clock';

/**
 * How long a shutdown may take before the process exits anyway. The desktop shell kills a daemon it told
 * to stop after 30 s, so this only decides when nothing else will: the shell is gone (its stdin closed),
 * or the signal came from somewhere else.
 */
export const STOP_DEADLINE_MS = 60_000;

/**
 * Runs `stop` and calls `onStopped` when it ends, or `onLate` when it has not ended by the deadline. A
 * shutdown stuck on one step still answers /health with its scheduler stopped, so nothing would ever
 * replace it; exiting leaves the lock and `daemon.json` for the next daemon, which recovers as after a crash.
 * A `stop` that rejects is not caught here.
 */
export function stopWithin(
  stop: () => Promise<void>,
  opts: {
    readonly clock: Clock;
    readonly deadlineMs: number;
    onStopped(): void;
    onLate(): void;
  },
): void {
  const late = opts.clock.setTimeout(() => {
    opts.onLate();
  }, opts.deadlineMs);
  void stop().then(() => {
    late.cancel();
    opts.onStopped();
  });
}
