import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
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

/** The directory as approved: a run may swap it, so a sweep first checks it is still this one. */
export interface PnpmLockDir {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

/**
 * Makes pnpm's lock directory when it is missing, and refuses one that is not a plain directory this
 * user alone can use: a run is about to be allowed to write in it. Returns the directory's identity.
 */
export function openPnpmLockDir(dir: string): PnpmLockDir {
  if (lstatSync(dir, { throwIfNoEntry: false }) === undefined) mkdirSync(dir, { mode: 0o700 });
  const found = lstatSync(dir);
  if (!found.isDirectory() || found.uid !== userInfo().uid || (found.mode & 0o077) !== 0) {
    throw new SandboxProfileError(
      'packageInstall',
      `pnpm's lock directory can't be opened to a package install: ${dir} is a link, is not a directory, or is open to other users`,
    );
  }
  return { path: dir, dev: found.dev, ino: found.ino };
}

/**
 * Removes everything in pnpm's lock directory that is not a regular file with a single name. A run
 * that could write there might have left a symbolic link for a later pnpm, outside any sandbox, to
 * follow, or a hard link to a file it could read. Every entry is looked at as a link, never followed;
 * pnpm's own lock files are made again when it needs them.
 *
 * The run may also have replaced the directory itself (its write grant covers the path), so nothing
 * is touched unless the path is still the directory that was approved. The directory's mode is set
 * back to private and any ACL a run added is removed. Every entry is tried; the first failure is
 * thrown at the end.
 */
export function sweepPnpmLockDir(dir: PnpmLockDir): void {
  const now = lstatSync(dir.path, { throwIfNoEntry: false });
  if (!now?.isDirectory() || now.dev !== dir.dev || now.ino !== dir.ino)
    throw new SandboxProfileError(
      'packageInstall',
      `pnpm's lock directory ${dir.path} was replaced during a package install; it was left alone`,
    );
  chmodSync(dir.path, 0o700);
  // macOS only; a run could grant other users access with an ACL, which the mode does not show.
  try {
    execFileSync('/bin/chmod', ['-N', dir.path], { stdio: 'ignore' });
  } catch {
    // No ACL support here, or none set.
  }
  let failure: Error | null = null;
  for (const name of readdirSync(dir.path)) {
    const path = join(dir.path, name);
    try {
      const entry = lstatSync(path, { throwIfNoEntry: false });
      if (entry !== undefined && (!entry.isFile() || entry.nlink > 1))
        rmSync(path, { recursive: true, force: true });
    } catch (error) {
      failure ??=
        error instanceof Error ? error : new Error('a lock directory entry could not be swept');
    }
  }
  if (failure !== null) throw failure;
}
