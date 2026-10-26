import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  mkdtempSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Where lane temp directories live; the sandbox's Unix socket path limit needs a short prefix. */
export const LANE_TEMP_ROOT = '/private/tmp';

/** The longest temp directory path Claude Code's `CLAUDE_CODE_TMPDIR` can use under the sandbox. */
export const MAX_SANDBOX_TMP_BYTES = 44;

const PREFIX = '10db-';

export class SandboxTempDirError extends Error {
  override readonly name = 'SandboxTempDirError';
}

/** Creates a private (mode 0700) temp directory for one lane session and returns its real path. */
export function createLaneTempDir(root: string = LANE_TEMP_ROOT): string {
  let dir: string;
  try {
    dir = mkdtempSync(join(root, PREFIX));
  } catch {
    throw new SandboxTempDirError('Could not create the lane temp directory');
  }
  try {
    chmodSync(dir, 0o700);
    const real = realpathSync(dir);
    if (Buffer.byteLength(real) > MAX_SANDBOX_TMP_BYTES) {
      throw new SandboxTempDirError(
        `The lane temp directory path is over ${String(MAX_SANDBOX_TMP_BYTES)} bytes`,
      );
    }
    return real;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    if (error instanceof SandboxTempDirError) throw error;
    throw new SandboxTempDirError('Could not prepare the lane temp directory');
  }
}

/** Removes a directory made by `createLaneTempDir`; refuses any other path. */
export function removeLaneTempDir(dir: string, root: string = LANE_TEMP_ROOT): void {
  if (dirname(dir) !== root || !basename(dir).startsWith(PREFIX)) {
    throw new SandboxTempDirError('Not a lane temp directory');
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    try {
      unlockTree(dir, realpathSync(dir));
      rmSync(dir, { recursive: true, force: true });
    } catch {
      throw new SandboxTempDirError('Could not remove the lane temp directory');
    }
  }
}

/**
 * Makes every directory under `dir` owner-writable so a lane's read-only directory can be removed.
 * A lane process may still be running and can swap a directory for a link mid-walk, so each
 * directory is opened without following links and changed through its descriptor, and a directory
 * whose real path is no longer where the walk expects it is skipped.
 */
function unlockTree(dir: string, expected: string): void {
  let fd: number;
  try {
    fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    return; // gone, or no longer a directory
  }
  try {
    if (realpathSync(dir) !== expected) return;
    fchmodSync(fd, 0o700);
    for (const entry of readdirSync(dir)) unlockTree(join(dir, entry), join(expected, entry));
  } finally {
    closeSync(fd);
  }
}
