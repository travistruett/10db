import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRuntimeInfo, type RuntimeInfo } from './files';

/** The ui-token file's text, without a trailing newline. */
export function readUiToken(dataDir: string): string {
  return readFileSync(join(dataDir, 'ui-token'), 'utf8').trim();
}

/** Whether a process with this pid exists; one owned by another user still counts. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

function readInfo(dataDir: string): RuntimeInfo | null {
  try {
    return readRuntimeInfo(dataDir);
  } catch {
    return null;
  }
}

/**
 * The daemon that is running now, with its UI token, or null: no `daemon.json`, one that doesn't
 * parse, a pid that has exited (a crashed daemon leaves the file), or no token.
 *
 * The token is read only once the pid is alive, so a stale file never leads a caller to send a
 * token. `daemon.json` is read again after the token, and must still name the same daemon: a
 * restart in between would otherwise pair the new token with the old port.
 */
export function runningDaemon(dataDir: string): { info: RuntimeInfo; token: string } | null {
  const before = readInfo(dataDir);
  if (before === null || !isAlive(before.pid)) return null;
  let token: string;
  try {
    token = readUiToken(dataDir);
  } catch {
    return null;
  }
  const after = readInfo(dataDir);
  if (after?.pid !== before.pid || after.startedAt !== before.startedAt) return null;
  return { info: after, token };
}
