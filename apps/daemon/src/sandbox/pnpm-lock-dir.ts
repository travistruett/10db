import { execFile } from 'node:child_process';
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
import { promisify } from 'node:util';
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

/** The daemon's logger, as far as the sweep tells it what it could not remove. */
export interface SweepLog {
  warn(fields: object, message: string): void;
}

/**
 * Removes pnpm's lock directory and all it holds. A run that could write there might have swapped the
 * directory for a link, or left links in it, for a later pnpm outside any sandbox to follow, and the
 * run's grant covers the directory's own path, so a swap can happen while this runs; every ChatGPT
 * lane can write the system temp dir it lies in, too. So the path is never looked into: it is first
 * renamed into `privateRoot` (the lane temp root, on the system's data volume like the system temp
 * dir and closed to every sandbox), which moves a link rather than following it, and only the name
 * it was moved to is walked, by tools that never follow a link. When it can't be moved there,
 * nothing is walked and the run is refused. Each sweep first removes every moved tree left there.
 * What can't be removed there is told to `log` and left: no sandbox can reach it, and no later run
 * waits on it.
 */
export async function sweepPnpmLockDir(
  dir: string,
  privateRoot: string,
  log?: SweepLog,
): Promise<void> {
  let names: string[] = [];
  try {
    names = readdirSync(privateRoot);
  } catch {
    // The move below fails the same way, and says so.
  }
  const moved = names.filter((name) => MOVED.test(name)).map((name) => join(privateRoot, name));
  let aside: string | null;
  try {
    aside = moveAside(dir, privateRoot);
  } catch (error) {
    throw new SandboxProfileError(
      'packageInstall',
      `pnpm's lock directory ${dir} could not be cleared: ${asError(error).message}`,
    );
  }
  for (const path of aside === null ? moved : [...moved, aside]) {
    try {
      await removeTree(path);
    } catch (error) {
      log?.warn(
        { path, err: asError(error).message },
        "pnpm's lock directory, moved where no sandbox reaches it, could not be removed; it is left there",
      );
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** The tools that walk a moved tree, with a fixed PATH. */
const TOOL_ENV = { PATH: '/usr/bin:/bin' };
const run = promisify(execFile);

/** How many times the sweep opens the locked directories it can reach in a moved tree. */
const UNLOCK_PASSES = 16;

/**
 * Removes a moved lock directory and all it holds, off the event loop. Each pass of `find` opens
 * for their owner the directories it can reach that a run locked (one `chmod` per batch), so each
 * opens one more level; then the user flags a run can set are cleared, and `rm -rf` removes the
 * tree, with every ACL removed and a second try when the first fails. None follows a link, and only
 * directories have their mode changed, so a hard link's other name keeps its own.
 */
async function removeTree(path: string): Promise<void> {
  for (let pass = 0; pass < UNLOCK_PASSES; pass += 1) {
    const opened = await run(
      '/usr/bin/find',
      ['-P', path, '-type', 'd', '!', '-perm', '-u=rwx', '-exec', '/bin/chmod', 'u+rwx', '{}', '+'],
      { env: TOOL_ENV },
    ).then(
      () => true,
      () => false,
    );
    if (opened) break;
  }
  // macOS's user flags; elsewhere the tool is missing and there are none.
  await run('/usr/bin/chflags', ['-R', '-P', 'nouchg,nouappnd', path], { env: TOOL_ENV }).catch(
    () => undefined,
  );
  const removed = (): Promise<boolean> =>
    run('/bin/rm', ['-rf', '--', path], { env: TOOL_ENV }).then(
      () => !existsSync(path),
      () => false,
    );
  if (await removed()) return;
  await run('/bin/chmod', ['-R', '-N', path], { env: TOOL_ENV }).catch(() => undefined);
  if (!(await removed())) throw new Error(`${path} could not be removed`);
}

/**
 * Renames `dir` into `privateRoot` and returns where it went, or null when nothing was there. A
 * link or a file is unlinked there at once; a rename that fails with something at `dir` throws.
 */
function moveAside(dir: string, privateRoot: string): string | null {
  const aside = join(privateRoot, `pnpm-sweep-${randomUUID()}`);
  try {
    renameSync(dir, aside);
  } catch (error) {
    if (isMissing(error) && lstatSync(dir, { throwIfNoEntry: false }) === undefined) return null;
    throw error;
  }
  if (lstatSync(aside).isDirectory()) return aside;
  unlinkSync(aside);
  return null;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
