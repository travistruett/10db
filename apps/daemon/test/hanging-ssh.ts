import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, waitFor } from './fixtures';
import { alive } from './orphan-gate';

/** An ssh address git reaches through `GIT_SSH_COMMAND`, so nothing leaves the machine. */
export const HANGING_SSH_URL = 'git@example.invalid:hang.git';

/**
 * Environment for a git network call whose ssh starts `sleep <seconds>` as its own child and waits
 * for it, as a slow transport would. The child's pid is recorded, so a test can tell whether
 * stopping the call stopped the transport's children too.
 */
export function hangingSsh(seconds: number) {
  const dir = tempDir('ssh');
  const pidFile = join(dir.path, 'ssh-child.pid');
  const read = (): number | undefined => {
    try {
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    /** git appends the host and the remote command as arguments; `true` swallows them. */
    env: {
      GIT_SSH_COMMAND: `sleep ${String(seconds)} & echo $! > '${pidFile}'; wait; true`,
      GIT_SSH_VARIANT: 'simple',
    },
    /** The transport's child, once it has started it. */
    childPid: () => waitFor(read),
    cleanup() {
      const pid = read();
      if (pid !== undefined && alive(pid)) process.kill(pid, 'SIGKILL');
      dir.cleanup();
    },
  };
}
