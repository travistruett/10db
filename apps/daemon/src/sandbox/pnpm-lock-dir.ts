import { randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
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
  if (lstatSync(dir, { throwIfNoEntry: false }) === undefined) mkdirSync(dir, { mode: 0o700 });
  const found = lstatSync(dir);
  if (!found.isDirectory() || found.uid !== userInfo().uid || (found.mode & 0o077) !== 0) {
    throw new SandboxProfileError(
      'packageInstall',
      `pnpm's lock directory can't be opened to a package install: ${dir} is a link, is not a directory, or is open to other users`,
    );
  }
}

/**
 * Removes pnpm's lock directory and all it holds. A run that could write there might have swapped the
 * directory for a link, or left links in it, for a later pnpm outside any sandbox to follow, and the
 * run's grant covers the directory's own path, so a swap can happen while this runs. So the path is
 * never looked into: it is first renamed, which moves a link rather than following it, to a name no
 * run can write beside or guess, and only that name is read. A link there is unlinked; a directory's
 * entries are unlinked or, for a directory, removed when empty, never followed or removed
 * recursively. Anything that could not be removed is thrown after the rest was tried.
 */
export function sweepPnpmLockDir(dir: string): void {
  const aside = `${dir}.sweep-${randomUUID()}`;
  try {
    renameSync(dir, aside);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  const moved = lstatSync(aside);
  if (!moved.isDirectory()) {
    unlinkSync(aside);
    return;
  }
  const failures: Error[] = [];
  const attempt = (remove: () => void): void => {
    try {
      remove();
    } catch (error) {
      if (isMissing(error)) return;
      failure ??=
        error instanceof Error
          ? error
          : new SandboxProfileError(
              'packageInstall',
              'a lock directory entry could not be removed',
            );
    }
  };
  for (const name of readdirSync(aside)) {
    const path = join(aside, name);
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (entry === undefined) continue;
    attempt(() => {
      if (entry.isDirectory()) rmdirSync(path);
      else unlinkSync(path);
    });
  }
  attempt(() => {
    rmdirSync(aside);
  });
  const [first] = failures;
  if (first !== undefined) throw first;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
