import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { StartDirtEntry } from '@10db/db';
import type { Git } from '../git';

/**
 * A file's size, change times and inode, read with lstat: it never opens the file or follows a link,
 * so a pipe or a link an agent left in the checkout can't stall or redirect it. Null when it is gone.
 */
export function fileFingerprint(checkout: string, path: string): string | null {
  const found = lstatSync(join(checkout, path), { throwIfNoEntry: false });
  if (found === undefined) return null;
  return `${String(found.ino)}:${String(found.size)}:${String(found.mtimeMs)}:${String(found.ctimeMs)}`;
}

/** Every path the checkout holds uncommitted, as it is now. */
export async function readStartDirt(
  git: Pick<Git, 'changedPaths'>,
  checkout: string,
): Promise<StartDirtEntry[]> {
  const paths = await git.changedPaths(checkout);
  return paths.map((path) => ({ path, fingerprint: fileFingerprint(checkout, path) }));
}

/** `paths` less those still exactly as the task's checkout held them when it first launched. */
export function withoutStartDirt(
  paths: readonly string[],
  checkout: string,
  start: readonly StartDirtEntry[] | null,
): string[] {
  if (start === null || start.length === 0) return [...paths];
  const before = new Map(start.map((entry) => [entry.path, entry.fingerprint]));
  return paths.filter(
    (path) => !before.has(path) || before.get(path) !== fileFingerprint(checkout, path),
  );
}
