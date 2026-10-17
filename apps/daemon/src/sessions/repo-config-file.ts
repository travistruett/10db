import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

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

/**
 * Reads a config file the repo commits, or returns null when there is none. Only a regular file of at most
 * `REPO_CONFIG_MAX_BYTES` is read: a FIFO or a device (`/dev/stdin`) would block the daemon, and `/dev/zero`
 * would exhaust its memory. A symlink is refused even when it points at a regular file, because its target
 * can sit outside the repo and change after the check. The file is opened without following a link and
 * without blocking, and checked on the open descriptor, so a file swapped between the check and the read
 * changes nothing.
 */
export function readRepoConfigFile(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    if (code === 'ELOOP') throw new RepoConfigFileError('it must be a regular file, not a link');
    throw new RepoConfigFileError(code ?? 'error');
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile())
      throw new RepoConfigFileError('it must be a regular file, not a directory, FIFO or device');
    if (stat.size > REPO_CONFIG_MAX_BYTES)
      throw new RepoConfigFileError(
        `it is larger than ${String(REPO_CONFIG_MAX_BYTES / 1024)} KiB`,
      );
    // One byte over the cap shows a file that grew after the check.
    const buffer = Buffer.alloc(REPO_CONFIG_MAX_BYTES + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > REPO_CONFIG_MAX_BYTES)
        throw new RepoConfigFileError(
          `it is larger than ${String(REPO_CONFIG_MAX_BYTES / 1024)} KiB`,
        );
    }
    return buffer.toString('utf8', 0, length);
  } catch (error) {
    if (error instanceof RepoConfigFileError) throw error;
    throw new RepoConfigFileError(errorCode(error) ?? 'error');
  } finally {
    closeSync(fd);
  }
}
