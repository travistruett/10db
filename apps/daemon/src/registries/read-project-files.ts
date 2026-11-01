import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** A package file bigger than this counts as absent; the biggest lockfiles are a few megabytes. */
export const MAX_FILE_BYTES = 16 * 1024 * 1024;

/**
 * The real path of `folder` (a path from the project root, `''` for the root itself), or null when
 * it isn't the folder of that name under the root's real path: a link anywhere below the root, as
 * in `.cargo` linked to `~/.cargo`, makes the two differ. The root's own path may run through a link.
 */
async function realFolder(root: string, folder: string): Promise<string | null> {
  try {
    const realRoot = await realpath(root);
    const expected = folder === '' ? realRoot : join(realRoot, folder);
    const real = await realpath(join(root, folder));
    return real === expected ? real : null;
  } catch {
    return null;
  }
}

/**
 * The text of the file at `file` (a path from the project root, such as `.cargo/config.toml`), or
 * null when it is absent, is not a regular file under the root (a link, in the file's name or in any
 * folder on its way, counts as absent and is never followed), is over the size cap, or can't be read.
 * A repository's files are written by lanes, so nothing here follows a link or waits on a pipe.
 */
export async function readRegularFile(root: string, file: string): Promise<string | null> {
  const folder = dirname(file) === '.' ? '' : dirname(file);
  const real = await realFolder(root, folder);
  if (real === null) return null;
  const path = join(real, basename(file));
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.size > MAX_FILE_BYTES) return null;
    // The file may be swapped for a link or a pipe after the lstat: never follow, never block.
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > MAX_FILE_BYTES) return null;
      return await handle.readFile({ encoding: 'utf8' });
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * The names of the real folders (never links) directly inside `folder` (a path from the project
 * root), or none when it can't be listed or is not that folder under the root's real path.
 */
export async function realSubfolders(root: string, folder: string): Promise<string[]> {
  const real = await realFolder(root, folder);
  if (real === null) return [];
  try {
    const entries = await readdir(real, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}
