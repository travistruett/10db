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
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

/**
 * The longest path Claude Code's own dir in `CLAUDE_CODE_TMPDIR` may have (`claudeCodeTmpPath`): it
 * takes the variable only when that dir fits, and otherwise falls back to the shared
 * `/tmp/claude-<uid>` without a word. srt names the same dir.
 */
export const MAX_SANDBOX_TMP_BYTES = 44;

/** The dir Claude Code makes for itself in `CLAUDE_CODE_TMPDIR`, which it measures. */
export function claudeCodeTmpPath(dir: string): string {
  return join(dir, `claude-${String(process.getuid?.() ?? 'nouid')}`);
}

/**
 * What `createLaneTempDir` names a temp dir: mkdtemp's six random characters and nothing else, so
 * the dir and Claude Code's own in it fit the limit under `laneTempRoot()`.
 */
const LANE_TEMP_DIR = /^[A-Za-z0-9]{6}$/;

/**
 * What a daemon that made its lane temp dirs in a system temp dir named one, beside other software's
 * names there; only the sweep of those dirs looks for it.
 */
const SYSTEM_TEMP_DIR = /^10db-[A-Za-z0-9]{6}$/;

/** Whether `name` is one `createLaneTempDir` gives a temp dir in a sandbox root. */
export const isLaneTempDirName = (name: string): boolean => LANE_TEMP_DIR.test(name);

/** Whether `name` is one a lane temp dir had in a system temp dir. */
export const isSystemTempDirName = (name: string): boolean => SYSTEM_TEMP_DIR.test(name);

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
 * The system temp dirs Codex's base policy lets every ChatGPT lane read and write: lane-writable to
 * 10db, which makes nothing there and sweeps its own names from them at start.
 */
export const SYSTEM_TEMP_ROOTS: readonly string[] = ['/private/tmp', '/private/var/tmp'];

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

/** The file that keeps Spotlight out of the directory it is in and everything under it. */
const SPOTLIGHT_MARKER = '.metadata_never_index';

/**
 * Marks a sandbox root so Spotlight skips everything in it: every lane's package caches are there,
 * and nobody searches them. Run after `ensurePrivateRoot`. An existing entry is left as it is (`wx`
 * also never follows a link), and no sweep or claim removes it, since it has no name they match.
 * Best effort: a root that can't hold it costs indexing time, not a lane.
 */
export function keepSpotlightOut(root: string): void {
  try {
    writeFileSync(join(root, SPOTLIGHT_MARKER), '', { flag: 'wx', mode: 0o600 });
  } catch {
    // Already marked, or the marker can't be written.
  }
}

/** Asks Time Machine to skip a sandbox root; `signal` ends the ask. */
export type BackupExclusion = (root: string, signal: AbortSignal) => Promise<void>;

/**
 * `tmutil addexclusion` on macOS, a sticky exclusion that stays with the directory; nothing on
 * another system, which has no Time Machine.
 */
export const tmutilExclusion: BackupExclusion = async (root, signal) => {
  if (process.platform !== 'darwin') return;
  await execTool('/usr/bin/tmutil', ['addexclusion', root], { env: TOOL_ENV, signal });
};

/**
 * Creates a private (mode 0700) temp directory for one lane session, named by six random characters
 * in `root`, and returns its real path. Claude Code's own dir in it (`claudeCodeTmpPath`) must fit
 * `maxBytes`, `MAX_SANDBOX_TMP_BYTES` unless no Claude Code or srt runs in it (null): a longer one
 * is refused, never handed to Claude Code to fall back on the shared dir.
 */
export function createLaneTempDir(
  root: string,
  maxBytes: number | null = MAX_SANDBOX_TMP_BYTES,
): string {
  let dir: string;
  try {
    dir = mkdtempSync(`${root}/`);
  } catch {
    throw new SandboxTempDirError('Could not create the lane temp directory');
  }
  try {
    chmodSync(dir, 0o700);
    const real = realpathSync(dir);
    if (maxBytes !== null && Buffer.byteLength(claudeCodeTmpPath(real)) > maxBytes) {
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
  const name = basename(dir);
  if (dirname(dir) !== root || !(isLaneTempDirName(name) || isSystemTempDirName(name))) {
    throw new SandboxTempDirError('Not a lane temp directory');
  }
}

/**
 * Removes a directory made by `createLaneTempDir`, or one named as a lane temp dir in a system temp
 * dir was; refuses any other path. A lane can leave
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
