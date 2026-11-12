import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readRepoFileBytes, RepoConfigFileError, type RepoFileBytes } from '../sessions';

const BEHIND_A_LINK = 'it lies behind a link';

function realDir(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

/**
 * Reads `relative` under a checkout a lane can write, or returns null when it is absent. The file's folder
 * must have, before and after the read, the real path its spelling has under the checkout's real path, and
 * the path must still name the opened file after that: a folder swapped for a link at any point is refused,
 * never read through. Throws `RepoConfigFileError` with why.
 */
export function readCheckoutFile(
  checkoutReal: string,
  relative: string,
  maxBytes: number,
): RepoFileBytes | null {
  const path = join(checkoutReal, relative);
  const expected = dirname(path);
  const before = realDir(expected);
  if (before === null) return null;
  if (before !== expected) throw new RepoConfigFileError(BEHIND_A_LINK);
  const read = readRepoFileBytes(path, maxBytes);
  if (read === null) return null;
  if (realDir(expected) !== expected) throw new RepoConfigFileError(BEHIND_A_LINK);
  let now;
  try {
    now = lstatSync(path);
  } catch {
    throw new RepoConfigFileError(BEHIND_A_LINK);
  }
  if (now.dev !== read.dev || now.ino !== read.ino) throw new RepoConfigFileError(BEHIND_A_LINK);
  return read;
}
