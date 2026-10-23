import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { systemProcesses } from '../src/recovery';
import { tempDir, waitFor } from './fixtures';

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A gate group: a detached leader plus a grandchild in the same group, whose pid it records. */
export async function orphanGateGroup() {
  const dir = tempDir('gate');
  const pidFile = join(dir.path, 'grandchild.pid');
  const leader = spawn('sh', ['-c', `sleep 60 & echo $! > '${pidFile}'; wait`], {
    detached: true,
    stdio: 'ignore',
  });
  const pid = leader.pid;
  if (pid === undefined) throw new Error('spawn failed');
  const exited = new Promise((r) => leader.once('exit', r));
  const grandchildPid = await waitFor(() => {
    try {
      const n = Number(readFileSync(pidFile, 'utf8').trim());
      return Number.isInteger(n) && n > 0 ? n : undefined;
    } catch {
      return undefined;
    }
  });
  const startedAt = await systemProcesses.identify(pid);
  if (startedAt === null) throw new Error('ps could not see the leader');
  return {
    leader,
    pid,
    startedAt,
    exited,
    grandchildPid,
    cleanup: () => {
      dir.cleanup();
    },
  };
}
