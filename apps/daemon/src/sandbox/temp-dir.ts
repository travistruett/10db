import { execFile, execFileSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

/** The longest temp directory path Claude Code's `CLAUDE_CODE_TMPDIR` can use under the sandbox. */
export const MAX_SANDBOX_TMP_BYTES = 44;

const PREFIX = '10db-';

/** A sandbox root is this user's alone. */
const ROOT_MODE = 0o700;

export class SandboxTempDirError extends Error {
  override readonly name = 'SandboxTempDirError';
}

/**
 * Where the temp dirs of Claude lanes, gates and MCP servers are made: short enough for the sandbox's
 * Unix socket path limit, and outside `/private/tmp`, which Codex's base policy opens to every
 * ChatGPT lane. Named for this user, since every macOS user can write `/Users/Shared`.
 */
export function laneTempRoot(): string {
  return `/Users/Shared/10db-${String(process.getuid?.() ?? 'nouid')}`;
}

/** Where a ChatGPT lane's temp dir is made, apart from Claude lanes'. */
export function codexLaneTempRoot(home: string): string {
  return join(home, '.10db', 'lanes');
}

/**
 * Where sealed files, env files and process ledgers are made: outside every temp dir, so no sandbox
 * reads one but through a grant naming it, and none writes one.
 */
export function sandboxFilesRoot(home: string): string {
  return join(home, '.10db', 'run');
}

/**
 * The system temp dir: where an earlier 10db kept every sandbox file, and which Codex's base policy
 * lets every ChatGPT lane read and write.
 */
export const SYSTEM_TEMP_ROOT = '/private/tmp';

/**
 * Makes `path` a private (mode 0700) directory of this user's, with its missing parents, and returns
 * its real path. Refuses a link, anything but a directory, and another user's directory: lanes' temp
 * dirs or the files that hold their sandboxes would be made there.
 */
export function ensurePrivateRoot(path: string): string {
  try {
    mkdirSync(path, { recursive: true, mode: ROOT_MODE });
  } catch {
    // Whatever is there is judged below.
  }
  let fd: number;
  try {
    // Opened as itself, never through a link, so the checks and the mode are of what is there.
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    throw new SandboxTempDirError(
      `The sandbox root ${path} could not be made, or is a link or not a directory`,
    );
  }
  try {
    if (fstatSync(fd).uid !== process.getuid?.()) {
      throw new SandboxTempDirError(`The sandbox root ${path} belongs to another user`);
    }
    fchmodSync(fd, ROOT_MODE);
    return realpathSync(path);
  } catch (error) {
    if (error instanceof SandboxTempDirError) throw error;
    throw new SandboxTempDirError(`The sandbox root ${path} could not be made private`);
  } finally {
    closeSync(fd);
  }
}

/**
 * Creates a private (mode 0700) temp directory for one lane session and returns its real path. Its
 * path must fit `maxBytes`, `MAX_SANDBOX_TMP_BYTES` unless no Claude Code or srt runs in it (null).
 */
export function createLaneTempDir(
  root: string,
  maxBytes: number | null = MAX_SANDBOX_TMP_BYTES,
): string {
  let dir: string;
  try {
    dir = mkdtempSync(join(root, PREFIX));
  } catch {
    throw new SandboxTempDirError('Could not create the lane temp directory');
  }
  try {
    chmodSync(dir, 0o700);
    const real = realpathSync(dir);
    if (maxBytes !== null && Buffer.byteLength(real) > maxBytes) {
      throw new SandboxTempDirError(
        `The lane temp directory path is over ${String(maxBytes)} bytes`,
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

const execTool = promisify(execFile);

/** The steps that remove a lane temp dir: see `removeLaneTempDir`. */
function removalSteps(dir: string): readonly (readonly [string, readonly string[]])[] {
  return [
    ['/bin/chmod', ['-R', '--', 'u+rwx', dir]],
    ['/bin/rm', ['-rf', '--', dir]],
  ];
}

function checkLaneTempDir(dir: string, root: string): void {
  if (dirname(dir) !== root || !basename(dir).startsWith(PREFIX)) {
    throw new SandboxTempDirError('Not a lane temp directory');
  }
}

/**
 * Removes a directory made by `createLaneTempDir`; refuses any other path. A lane can leave
 * directories it made unreadable or read-only, and a lane process may still be running and swap
 * a directory for a link mid-removal, so the daemon never walks the tree itself: `chmod -R` and
 * `rm -rf` walk it by directory descriptor and never follow a link.
 */
export function removeLaneTempDir(dir: string, root: string): void {
  checkLaneTempDir(dir, root);
  if (!existsSync(dir)) return;
  try {
    for (const [tool, args] of removalSteps(dir)) runTool(tool, args);
  } catch {
    throw new SandboxTempDirError('Could not remove the lane temp directory');
  }
  if (existsSync(dir)) throw new SandboxTempDirError('Could not remove the lane temp directory');
}

/** `removeLaneTempDir` with the tools run as child processes the event loop doesn't wait on. */
export async function removeLaneTempDirAsync(dir: string, root: string): Promise<void> {
  checkLaneTempDir(dir, root);
  if (!existsSync(dir)) return;
  try {
    for (const [tool, args] of removalSteps(dir)) await execTool(tool, args, { env: TOOL_ENV });
  } catch {
    throw new SandboxTempDirError('Could not remove the lane temp directory');
  }
  if (existsSync(dir)) throw new SandboxTempDirError('Could not remove the lane temp directory');
}
