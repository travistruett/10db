import { execFile } from 'node:child_process';
import { accessSync, closeSync, constants, openSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const under = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

/** Directory names of version managers, whose `pnpm` picks a version from the project it runs in. */
const VERSION_MANAGER_DIRS = [
  'shims',
  'corepack',
  '.volta',
  'volta',
  'fnm',
  'fnm_multishells',
  'asdf',
];

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** A script (`#!`) needs an interpreter found through PATH, which a project's own config can steer. */
function isScript(path: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(2);
    return readSync(fd, head, 0, 2, 0) === 2 && head.toString('latin1') === '#!';
  } catch {
    return true;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The `pnpm` a worktree install runs, as an absolute path to a real pnpm program the daemon found
 * itself, or null. It lies outside every checkout, is not a script, and neither it nor the path it
 * is reached by is a version manager's (corepack, Volta, fnm, asdf and mise shims all choose the
 * version from the directory they run in). A mise shim is the one exception: it is asked, from the
 * builder's home directory so no project config applies, which program it stands for, and that
 * answer must pass the same checks. Null means no trustworthy pnpm: the caller refuses and does not
 * fall back to whatever `PATH` would run.
 */
export async function resolvePnpm(
  env: Readonly<Record<string, string>>,
  checkouts: readonly string[],
): Promise<string | null> {
  const roots = checkouts.map((checkout) => realpathOrSelf(checkout));
  const outside = (path: string): boolean =>
    !roots.some((root) => under(realpathOrSelf(path), root));
  const managed = (path: string): boolean =>
    [path, realpathOrSelf(path)].some((candidate) =>
      candidate.split('/').some((part) => VERSION_MANAGER_DIRS.includes(part)),
    );
  const trustworthy = (path: string): boolean =>
    isAbsolute(path) &&
    basename(realpathOrSelf(path)) === 'pnpm' &&
    executable(path) &&
    outside(path) &&
    !managed(path) &&
    !isScript(path);
  const onPath = (name: string): string[] =>
    (env['PATH'] ?? '')
      .split(delimiter)
      .filter((dir) => isAbsolute(dir) && outside(dir))
      .map((dir) => join(dir, name))
      .filter((path) => executable(path) && outside(path));
  for (const candidate of onPath('pnpm')) {
    if (trustworthy(candidate)) return realpathOrSelf(candidate);
    if (!candidate.split('/').includes('shims')) continue;
    for (const mise of onPath('mise')) {
      try {
        const { stdout } = await run(mise, ['which', 'pnpm'], {
          cwd: homedir(),
          env,
          encoding: 'utf8',
          timeout: 15_000,
        });
        const answer = stdout.trim();
        if (trustworthy(answer)) return realpathOrSelf(answer);
      } catch {
        // mise could not say; the next one, or the next pnpm, may.
      }
    }
  }
  return null;
}
