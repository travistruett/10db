import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class AlreadyRunningError extends Error {
  override readonly name = 'AlreadyRunningError';
  readonly pid: number;
  constructor(pid: number) {
    super(`Another 10db daemon is running (pid ${String(pid)})`);
    this.pid = pid;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasCode(error, 'EPERM');
  }
}

/** One daemon per data directory. A lock left by a dead process is taken over. */
export function acquireInstanceLock(dataDir: string): { release(): void } {
  const path = join(dataDir, 'daemon.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, String(process.pid), { flag: 'wx' });
      return {
        release() {
          try {
            if (readFileSync(path, 'utf8') === String(process.pid)) rmSync(path, { force: true });
          } catch {
            // Already gone.
          }
        },
      };
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
      const holder = Number(readFileSync(path, 'utf8'));
      // A live holder, including this process, keeps the lock; only a dead holder's lock is taken over.
      if (Number.isInteger(holder) && holder > 0 && alive(holder)) {
        throw new AlreadyRunningError(holder);
      }
      rmSync(path, { force: true });
    }
  }
  throw new Error(`Could not take the daemon lock at ${path}`);
}
