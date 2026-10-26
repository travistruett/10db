import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, waitFor } from './fixtures';
import { alive } from './orphan-gate';

/** A pre-push hook in `repo` that runs `script` (shell) and exits with its status. */
export function writePrePushHook(repo: string, script: string): void {
  const hooks = join(repo, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  const hook = join(hooks, 'pre-push');
  writeFileSync(hook, `#!/bin/sh\n${script}\n`);
  chmodSync(hook, 0o755);
}

/**
 * A pre-push hook in `repo` that starts `sleep <seconds>` as its own child and waits for it, as a
 * hook running `make check` waits for its tools. The child's pid is recorded, so a test can tell
 * whether stopping the push stopped the hook's children too.
 */
export function installPrePushHook(repo: string, seconds: number) {
  const dir = tempDir('hook');
  const pidFile = join(dir.path, 'hook-child.pid');
  const hooks = join(repo, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  const hook = join(hooks, 'pre-push');
  writeFileSync(hook, `#!/bin/sh\nsleep ${String(seconds)} &\necho $! > '${pidFile}'\nwait\n`);
  chmodSync(hook, 0o755);
  const read = (): number | undefined => {
    try {
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    /** The hook's child, once the hook has started it. */
    childPid: () => waitFor(read),
    cleanup() {
      const pid = read();
      if (pid !== undefined && alive(pid)) process.kill(pid, 'SIGKILL');
      dir.cleanup();
    },
  };
}
