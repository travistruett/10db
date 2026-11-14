import { closeSync, constants, openSync, readlinkSync } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';

/**
 * macOS's `O_NOFOLLOW_ANY` (`<sys/fcntl.h>`, macOS 11 and later), which Node does not export: the
 * open fails with `ELOOP` when any component of the path is a link, the last one included. The
 * kernel refuses it beside `O_NOFOLLOW` (`EINVAL`).
 */
const O_NOFOLLOW_ANY = 0x20000000;

/** A path inside a root that 10db won't open: a link lies somewhere along it, or the platform can't tell. */
export class LinkInPathError extends Error {
  override readonly name = 'LinkInPathError';
}

/** The `node:fs` calls the open makes, so a caller can stand between them. */
export interface OpenFs {
  openSync(path: string, flags: number): number;
  closeSync(fd: number): void;
}

const nodeOpen: OpenFs = {
  openSync: (path, flags) => openSync(path, flags),
  closeSync: (fd) => {
    closeSync(fd);
  },
};

/**
 * Opens `relative` under `realRoot` (a real path, which the caller resolved) for reading, without
 * blocking, in one call that refuses a link at any component past the root. A folder a lane swaps
 * for a link and back between path checks is never read through: no sequence of checks by path can
 * see that, only the open itself. On macOS the kernel refuses the link (`O_NOFOLLOW_ANY`); on
 * Linux the descriptor's own path (`/proc/self/fd`) must be the one asked for. Elsewhere nothing is
 * opened. Throws `LinkInPathError` for a link, and the open's own error otherwise (`ENOENT`).
 */
export function openInRoot(realRoot: string, relative: string, fs: OpenFs = nodeOpen): number {
  const inside = normalize(relative);
  if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`) || inside === '.')
    throw new LinkInPathError('the path is not inside its root');
  const path = join(realRoot, inside);
  const read = constants.O_RDONLY | constants.O_NONBLOCK;
  if (process.platform === 'darwin') {
    try {
      return fs.openSync(path, read | O_NOFOLLOW_ANY);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ELOOP')
        throw new LinkInPathError('it lies behind a link');
      throw error;
    }
  }
  if (process.platform !== 'linux')
    throw new LinkInPathError('10db reads a checkout file only on macOS and Linux');
  let fd: number;
  try {
    fd = fs.openSync(path, read | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ELOOP')
      throw new LinkInPathError('it lies behind a link');
    throw error;
  }
  let opened: string | null = null;
  try {
    opened = readlinkSync(`/proc/self/fd/${String(fd)}`);
  } catch {
    // Unknown is refused below.
  }
  if (opened !== path) {
    fs.closeSync(fd);
    throw new LinkInPathError('it lies behind a link');
  }
  return fd;
}
