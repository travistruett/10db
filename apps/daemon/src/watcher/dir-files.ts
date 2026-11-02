import { opendirSync, type Dir } from 'node:fs';
import { join } from 'node:path';
import { isInsideClaudeCodeBookkeeping } from '../git';

/** The most files a sensitive directory may hold and still be read as the base's own; more cards it. */
export const MAX_DIR_FILES = 500;
/**
 * The most entries (files, directories, bookkeeping) one listing reads before it gives up. A lane may fill a
 * directory with millions of entries, and the listing runs on the daemon's event loop, so the work it does
 * is fixed here, whatever the lane wrote.
 */
export const MAX_DIR_ENTRIES = 5000;

export interface DirFilesOptions {
  readonly maxFiles?: number;
  readonly maxEntries?: number;
  /** Opens a directory for reading one entry at a time. Tests count the reads through it. */
  readonly open?: (path: string) => Dir;
}

/**
 * The files under directory `rel`, relative to `root` with `/` separators, leaving out Claude Code's
 * bookkeeping; null when it holds anything but files and directories (a link, say), more than `maxFiles`
 * files or more than `maxEntries` entries, or can't be read. It reads one entry at a time and stops at the
 * first entry past a bound, so it never lists what it will not use.
 */
export function filesUnderBounded(
  root: string,
  rel: string,
  options: DirFilesOptions = {},
): string[] | null {
  const maxFiles = options.maxFiles ?? MAX_DIR_FILES;
  const maxEntries = options.maxEntries ?? MAX_DIR_ENTRIES;
  const open = options.open ?? ((path: string) => opendirSync(path));
  const files: string[] = [];
  const pending = [rel];
  let read = 0;
  for (let dirRel = pending.pop(); dirRel !== undefined; dirRel = pending.pop()) {
    let dir: Dir;
    try {
      dir = open(join(root, dirRel));
    } catch {
      return null;
    }
    try {
      for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
        read += 1;
        if (read > maxEntries) return null;
        const entryRel = `${dirRel}/${entry.name}`;
        if (entry.isDirectory()) {
          pending.push(entryRel);
          continue;
        }
        if (isInsideClaudeCodeBookkeeping(entryRel)) continue;
        if (!entry.isFile() || files.length >= maxFiles) return null;
        files.push(entryRel);
      }
    } catch {
      return null;
    } finally {
      try {
        dir.closeSync();
      } catch {
        // already closed
      }
    }
  }
  return files;
}
