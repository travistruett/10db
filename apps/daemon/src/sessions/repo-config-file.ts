import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { LinkInPathError, openInRoot } from './open-in-root';

/** A committed config file larger than this is not a config; it is refused unread. */
export const REPO_CONFIG_MAX_BYTES = 256 * 1024;

/** A repo config file that 10db will not read. The message says why, without the file's content. */
export class RepoConfigFileError extends Error {
  override readonly name = 'RepoConfigFileError';
}

/** The `code` of a Node file-system error, or undefined for anything else. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

/** A checkout file read whole, with the descriptor's mode and identity. */
export interface RepoFileBytes {
  readonly bytes: Buffer;
  readonly mode: number;
  /** The opened file's device and inode, for a caller that checks the path still names it. */
  readonly dev: number;
  readonly ino: number;
}

function kib(bytes: number): string {
  return `it is larger than ${String(bytes / 1024)} KiB`;
}

/**
 * Reads a file a checkout holds, or returns null when there is none. Only a regular file of at most
 * `maxBytes` is read: a FIFO or a device (`/dev/stdin`) would block the daemon, and `/dev/zero` would exhaust
 * its memory. A symlink is refused even when it points at a regular file, because its target can sit outside
 * the repo and change after the check. The file is opened without following a link and without blocking,
 * and checked on the open descriptor, so a file swapped between the check and the read changes nothing.
 */
export function readRepoFileBytes(path: string, maxBytes: number): RepoFileBytes | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    if (code === 'ELOOP') throw new RepoConfigFileError('it must be a regular file, not a link');
    throw new RepoConfigFileError(code ?? 'error');
  }
  return readOpened(fd, maxBytes);
}

/**
 * `readRepoFileBytes` for `relative` under a checkout's real path, opened by `openInRoot`: a link
 * anywhere on the way is refused at the open itself, so a folder a lane swaps for a link and back
 * between checks by path is never read through.
 */
export function readRepoFileBytesIn(
  realRoot: string,
  relative: string,
  maxBytes: number,
): RepoFileBytes | null {
  let fd: number;
  try {
    fd = openInRoot(realRoot, relative);
  } catch (error) {
    if (error instanceof LinkInPathError)
      // Only the wording turns on which part is the link; the open refused either way.
      throw new RepoConfigFileError(
        isLink(join(realRoot, relative)) ? 'it must be a regular file, not a link' : error.message,
      );
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new RepoConfigFileError(code ?? 'error');
  }
  return readOpened(fd, maxBytes);
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Reads a descriptor whole, if it is a regular file of at most `maxBytes`, and closes it. */
function readOpened(fd: number, maxBytes: number): RepoFileBytes {
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile())
      throw new RepoConfigFileError('it must be a regular file, not a directory, FIFO or device');
    if (stat.size > maxBytes) throw new RepoConfigFileError(kib(maxBytes));
    // One byte over the cap shows a file that grew after the check.
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > maxBytes) throw new RepoConfigFileError(kib(maxBytes));
    }
    return { bytes: buffer.subarray(0, length), mode: stat.mode, dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if (error instanceof RepoConfigFileError) throw error;
    throw new RepoConfigFileError(errorCode(error) ?? 'error');
  } finally {
    closeSync(fd);
  }
}

/** A config file the repo commits, as UTF-8, through `readRepoFileBytes` at `REPO_CONFIG_MAX_BYTES`. */
export function readRepoConfigFile(path: string): string | null {
  return readRepoFileBytes(path, REPO_CONFIG_MAX_BYTES)?.bytes.toString('utf8') ?? null;
}

/**
 * A config file the repo commits, at `relative` under the checkout `root`, as UTF-8, opened by `openInRoot`
 * at `REPO_CONFIG_MAX_BYTES`: a link anywhere below the root is refused at the open. The root is resolved to
 * its real path first; a lane can write inside a checkout but not swap the checkout itself.
 */
export function readRepoConfigFileIn(root: string, relative: string): string | null {
  let realRoot: string;
  try {
    realRoot = realpathSync.native(root);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new RepoConfigFileError(code ?? 'error');
  }
  return (
    readRepoFileBytesIn(realRoot, relative, REPO_CONFIG_MAX_BYTES)?.bytes.toString('utf8') ?? null
  );
}
