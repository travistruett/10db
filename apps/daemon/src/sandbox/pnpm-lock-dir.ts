import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
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

/** What the sweep moves a lock directory to in the temp root; never a lane temp dir's name. */
const MOVED = /^pnpm-sweep-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Removes pnpm's lock directory and all it holds. A run that could write there might have swapped the
 * directory for a link, or left links in it, for a later pnpm outside any sandbox to follow, and the
 * run's grant covers the directory's own path, so a swap can happen while this runs; every ChatGPT
 * lane can write the system temp dir it lies in, too. So the path is never looked into: it is first
 * renamed into `privateRoot` (the lane temp root, on the system's data volume like the system temp
 * dir and closed to every sandbox), which moves a link rather than following it, and only the name
 * it was moved to is walked, by tools that never follow a link. When it can't be moved there,
 * nothing is walked. Each sweep first removes every moved tree left there. A failure is thrown
 * after the rest was tried.
 */
export function sweepPnpmLockDir(dir: string, privateRoot: string): void {
  const failures: Error[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(privateRoot);
  } catch (error) {
    failures.push(asError(error));
  }
  for (const name of names) {
    if (!MOVED.test(name)) continue;
    try {
      removeTree(join(privateRoot, name));
    } catch (error) {
      failures.push(asError(error));
    }
  }
  try {
    sweep(dir, privateRoot);
  } catch (error) {
    failures.push(asError(error));
  }
  const [first] = failures;
  if (first !== undefined) {
    throw new SandboxProfileError(
      'packageInstall',
      `pnpm's lock directory ${dir} could not be cleared: ${first.message}`,
    );
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** The tools that walk a moved tree, with a fixed PATH. */
const TOOL_ENV = { PATH: '/usr/bin:/bin' };

/**
 * Removes a moved lock directory and all it holds. `find` opens each directory in it for its owner
 * first, since a run may have locked one; it and `rm -rf` walk by directory descriptor and never
 * follow a link, so a link's target and a hard link's other name are left as they are.
 */
function removeTree(path: string): void {
  try {
    execFileSync('/usr/bin/find', [path, '-type', 'd', '-exec', '/bin/chmod', 'u+rwx', '{}', ';'], {
      env: TOOL_ENV,
      stdio: 'pipe',
    });
  } catch {
    // What it could not open, `rm` fails on, and that is what is reported.
  }
  try {
    execFileSync('/bin/rm', ['-rf', '--', path], { env: TOOL_ENV, stdio: 'pipe' });
  } catch {
    throw new Error(`${path} could not be removed`);
  }
  if (existsSync(path)) throw new Error(`${path} could not be removed`);
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
  if (!lstatSync(aside).isDirectory()) {
    unlinkSync(aside);
    return;
  }
  removeTree(aside);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
