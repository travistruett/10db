import type { Clock } from '../clock';

/** How long a stopped sign-in process gets to exit before it is killed outright. */
export const STOP_GRACE_MS = 2_000;

/**
 * Stops the process an agent's sign-in runs in and resolves once it has exited, so whatever it held (a
 * local callback port, the account's login files) is free. A process that is still there after
 * `STOP_GRACE_MS` is sent SIGKILL, which cannot be ignored, and the wait ends.
 */
export async function stopLoginProcess(
  proc: {
    kill(signal: NodeJS.Signals): void;
    /** Settles when the process has exited, however it ended. */
    readonly exited: Promise<unknown>;
  },
  clock: Clock,
): Promise<void> {
  proc.kill('SIGTERM');
  let timer: { cancel(): void } = { cancel: () => undefined };
  const grace = new Promise<'late'>((resolve) => {
    timer = clock.setTimeout(() => {
      resolve('late');
    }, STOP_GRACE_MS);
  });
  const first = await Promise.race([proc.exited.then(() => 'exited' as const), grace]);
  timer.cancel();
  if (first === 'late') proc.kill('SIGKILL');
}
