import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { SandboxProfileError } from './profile';

/**
 * Where pnpm keeps its store locks: a directory per user in the system temp dir. pnpm names it by
 * the literal `/tmp`, not `TMPDIR`, so a run's own temp dir can't hold it.
 */
export function defaultPnpmLockDir(): string {
  return join(realpathSync('/tmp'), `pnpm-store-operation-locks-${String(userInfo().uid)}`);
}

/**
 * Makes pnpm's lock directory when it is missing, and refuses one that is not a plain directory this
 * user alone can use: a run is about to be allowed to write in it.
 */
export function openPnpmLockDir(dir: string): void {
  const found = lstatSync(dir, { throwIfNoEntry: false });
  if (found === undefined) {
    mkdirSync(dir, { mode: 0o700 });
    return;
  }
  if (!found.isDirectory() || found.uid !== userInfo().uid || (found.mode & 0o077) !== 0) {
    throw new SandboxProfileError(
      'packageInstall',
      `pnpm's lock directory can't be opened to a package install: ${dir} is a link, is not a directory, or is open to other users`,
    );
  }
}

/**
 * Removes everything in pnpm's lock directory that is not a regular file. A run that could write
 * there might have left a link for a later pnpm, outside any sandbox, to follow.
 */
export function sweepPnpmLockDir(dir: string): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (!lstatSync(path).isFile()) rmSync(path, { recursive: true, force: true });
  }
}
