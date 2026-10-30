import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';

/** A package file bigger than this counts as absent; the biggest lockfiles are a few megabytes. */
const MAX_FILE_BYTES = 16 * 1024 * 1024;

/**
 * The text of the file at `path`, or null when it is absent, is not a regular file (a link counts as
 * absent and is never followed), is over the size cap, or can't be read. A repository's files are
 * written by lanes, so nothing here follows a link or waits on a pipe.
 */
export async function readRegularFile(path: string): Promise<string | null> {
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

/** The names of the real folders (never links) directly inside `dir`, or none when it can't be listed. */
export async function realSubfolders(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}
