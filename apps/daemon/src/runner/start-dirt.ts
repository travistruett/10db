import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { StartDirtEntry } from '@10db/db';
import type { Git } from '../git';

/** What a path that lstat can't read fingerprints as: it matches nothing recorded, so it counts as changed. */
const UNREADABLE = 'unreadable';

/**
 * A file's size, change times and inode, read with lstat: it never opens the file or follows a link,
 * so a pipe or a link an agent left in the checkout can't stall or redirect it. Null when it is gone.
 */
export function fileFingerprint(checkout: string, path: string): string | null {
  try {
    const found = lstatSync(join(checkout, path), { throwIfNoEntry: false });
    if (found === undefined) return null;
    return `${String(found.ino)}:${String(found.size)}:${String(found.mtimeMs)}:${String(found.ctimeMs)}`;
  } catch {
    // A parent that is now a file (ENOTDIR) or closed to this user: not as it was.
    return UNREADABLE;
  }
}

/** Every path the checkout holds uncommitted, as it is now. */
export async function readStartDirt(
  git: Pick<Git, 'changedPaths'>,
  checkout: string,
): Promise<StartDirtEntry[]> {
  const paths = await git.changedPaths(checkout);
  return paths.map((path) => ({ path, fingerprint: fileFingerprint(checkout, path) }));
}

/**
 * `paths` less those still exactly as the task's checkout held them when it first launched, and
 * less those a session of the task named as someone else's.
 */
export function withoutStartDirt(
  paths: readonly string[],
  checkout: string,
  start: readonly StartDirtEntry[] | null,
): string[] {
  if (start === null || start.length === 0) return [...paths];
  const before = new Map(start.map((entry) => [entry.path, entry]));
  return paths.filter((path) => {
    const entry = before.get(path);
    if (entry === undefined) return true;
    if (entry.leftBy !== undefined) return false;
    const now = fileFingerprint(checkout, path);
    return now === UNREADABLE || entry.fingerprint !== now;
  });
}

/** How many times a task's sessions can name another writer's edits and have the send-back after it not count. */
export const FREE_LEFT_ROUNDS = 5;

/**
 * Whether a send-back of `paths` is another writer's new edits, which the step's retry limit does not
 * count: the session just sent back for `previous` committed or named every one of them, named some
 * as someone else's, and every path now is new. A task's sessions get `FREE_LEFT_ROUNDS` such rounds.
 */
export function anotherWritersRound(input: {
  readonly previous: readonly string[] | null;
  readonly paths: readonly string[];
  readonly record: readonly StartDirtEntry[] | null;
  readonly lastSession: string | null;
}): boolean {
  const { previous, paths, record, lastSession } = input;
  if (previous === null || lastSession === null || record === null) return false;
  if (paths.some((path) => previous.includes(path))) return false;
  const rounds = new Set(
    record.flatMap((entry) => (entry.leftBy === undefined ? [] : [entry.leftBy])),
  );
  if (rounds.size > FREE_LEFT_ROUNDS) return false;
  return record.some((entry) => entry.leftIn === lastSession);
}
