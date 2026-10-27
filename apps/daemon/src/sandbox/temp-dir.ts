import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
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

/**
 * Runs every removal even when one fails, so one stuck file never leaves the rest behind; the first
 * failure is then thrown.
 */
export function removeAll(removals: readonly (() => void)[]): void {
  const failures: Error[] = [];
  for (const remove of removals) {
    try {
      remove();
    } catch (error) {
      failures.push(
        error instanceof Error ? error : new SandboxTempDirError('Could not remove a sandbox file'),
      );
    }
  }
  const [first] = failures;
  if (first !== undefined) throw first;
}

/** The system tools that walk a lane's tree without following links; see `removeLaneTempDir`. */
const TOOL_ENV = { PATH: '/usr/bin:/bin' };

function runTool(tool: string, args: readonly string[]): void {
  execFileSync(tool, args, { env: TOOL_ENV, stdio: 'pipe' });
}

/**
 * Removes a directory made by `createLaneTempDir`; refuses any other path. A lane can leave
 * directories it made unreadable or read-only, and a lane process may still be running and swap
 * a directory for a link mid-removal, so the daemon never walks the tree itself: `chmod -R` and
 * `rm -rf` walk it by directory descriptor and never follow a link.
 */
export function removeLaneTempDir(dir: string, root: string = LANE_TEMP_ROOT): void {
  if (dirname(dir) !== root || !basename(dir).startsWith(PREFIX)) {
    throw new SandboxTempDirError('Not a lane temp directory');
  }
  if (!existsSync(dir)) return;
  try {
    runTool('/bin/chmod', ['-R', '--', 'u+rwx', dir]);
    runTool('/bin/rm', ['-rf', '--', dir]);
  } catch {
    throw new SandboxTempDirError('Could not remove the lane temp directory');
  }
  if (existsSync(dir)) throw new SandboxTempDirError('Could not remove the lane temp directory');
}
