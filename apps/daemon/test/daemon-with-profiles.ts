import { startDaemon, type RunningDaemon } from '../src/daemon';
import { seedProfiles } from './seed-profiles';

/**
 * Starts a daemon and gives it the model profiles an account lists after a catalogue fetch. A test daemon
 * fetches nothing, and a task has no model to run on without them.
 */
export async function startDaemonWithProfiles(
  options: Parameters<typeof startDaemon>[0],
): Promise<RunningDaemon> {
  const running = await startDaemon(options);
  seedProfiles(running.state);
  return running;
}
