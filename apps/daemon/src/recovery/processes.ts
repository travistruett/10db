import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const run = promisify(execFile);

const StartTime = z.string().min(1);

/** How long a process gets to exit after SIGTERM before SIGKILL. */
const GRACE_MS = 2000;
const POLL_MS = 100;

export interface ProcessTerminator {
  /** The OS start time of `pid`, or null when no such process runs. */
  identify(pid: number): Promise<string | null>;
  /** Signals `pid` (or its process group) only while its start time still equals `startedAt`. */
  terminate(target: {
    readonly pid: number;
    readonly startedAt: string;
    readonly group?: boolean;
  }): Promise<'terminated' | 'not_running'>;
}

async function identify(pid: number): Promise<string | null> {
  try {
    const { stdout } = await run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      env: { LC_ALL: 'C' },
    });
    const parsed = StartTime.safeParse(stdout.trim());
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // ps exits 1 when the pid does not exist
  }
}

/** Sends a signal; false when the target already exited (ESRCH), so callers never throw on a race. */
function signal(target: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(target, sig);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ends processes left by a crashed daemon: SIGTERM, then SIGKILL after 2 s. After a reboot a stored
 * pid can belong to an unrelated process, so the start time recorded with the pid must still match.
 */
export const systemProcesses: ProcessTerminator = {
  identify,
  async terminate({ pid, startedAt, group = false }) {
    if ((await identify(pid)) !== startedAt) return 'not_running';
    const target = group ? -pid : pid;
    if (!signal(target, 'SIGTERM')) return 'not_running';
    for (let waited = 0; waited < GRACE_MS; waited += POLL_MS) {
      if ((await identify(pid)) !== startedAt) return 'terminated';
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    signal(target, 'SIGKILL');
    return 'terminated';
  },
};
