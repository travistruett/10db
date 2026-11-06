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
 * run's grant covers the directory's own path, so a swap can happen while this runs; every ChatGPT
 * lane can write the system temp dir it lies in, too. So the path is never looked into: it is first
 * renamed into `privateRoot` (the files root, which no sandbox writes), which moves a link rather
 * than following it, and only the name it was moved to is read. When it can't be moved there,
 * nothing is walked. A link there is unlinked; a directory's entries are unlinked or, for a
 * directory, removed when empty, never followed or removed recursively. Anything that could not be
 * removed is thrown after the rest was tried.
 */
export function sweepPnpmLockDir(dir: string, privateRoot: string): void {
  try {
    sweep(dir, privateRoot);
  } catch (error) {
    throw new SandboxProfileError(
      'packageInstall',
      `pnpm's lock directory ${dir} could not be cleared: ${asError(error).message}`,
    );
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function sweep(dir: string, privateRoot: string): void {
  const aside = join(privateRoot, `pnpm-sweep-${randomUUID()}`);
  try {
    renameSync(dir, aside);
  } catch (error) {
    // Nothing there is nothing to sweep; a rename that failed with something there walks nothing.
    if (isMissing(error) && lstatSync(dir, { throwIfNoEntry: false }) === undefined) return;
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
      failures.push(asError(error));
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
