import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { foldPathCase, realPathOf } from '../guard';

/** Where worktrees go unless `TENDB_WORKTREE_ROOT` says otherwise. */
export const DEFAULT_WORKTREE_BASE = join(homedir(), '.10db', 'worktrees');

export class WorktreeRootError extends Error {
  override readonly name = 'WorktreeRootError';
}

function equalOrUnder(path: string, root: string): boolean {
  const p = foldPathCase(path);
  const r = foldPathCase(root);
  return p === r || p.startsWith(r.endsWith('/') ? r : `${r}/`);
}

/**
 * `<base>/<first 8 hex of sha256 of the data dir's real path>`, as a real path: the deepest existing
 * ancestor resolved through its links, the rest appended, so a worktree's path and the key git pins
 * it under never differ by a link such as `/var` and `/private/var`.
 */
export function worktreeRootFor(base: string, dataDir: string): string {
  const level = createHash('sha256').update(realPathOf(dataDir)).digest('hex').slice(0, 8);
  return realPathOf(join(resolve(base), level));
}

/**
 * Refuses a root at or under a checkout, the data dir or the lane temp root, by real path even
 * before it exists: a lane could write into the root there, or the daemon's own files would lie in
 * a place it hands to git as a worktree.
 */
export function assertWorktreeRootAllowed(
  root: string,
  forbidden: {
    readonly checkouts: readonly string[];
    readonly dataDir: string;
    readonly tempRoot: string | null;
  },
): void {
  const real = realPathOf(root);
  const places = [
    ...forbidden.checkouts.map((path) => ({ kind: 'a registered checkout', path })),
    { kind: 'the data directory', path: forbidden.dataDir },
    ...(forbidden.tempRoot === null
      ? []
      : [{ kind: 'the sandbox temp root', path: forbidden.tempRoot }]),
  ];
  for (const { kind, path } of places) {
    const realPlace = realPathOf(path);
    if (equalOrUnder(real, realPlace)) {
      throw new WorktreeRootError(
        `The worktree root ${real} lies at or under ${kind} (${realPlace}). Set TENDB_WORKTREE_ROOT to a directory outside it.`,
      );
    }
  }
}

/** True when a checkout and the worktree root overlap: either lies at or under the other, by real path. */
export function checkoutConflictsWithRoot(root: string, checkout: string): boolean {
  const realRoot = realPathOf(root);
  const realCheckout = realPathOf(checkout);
  return equalOrUnder(realRoot, realCheckout) || equalOrUnder(realCheckout, realRoot);
}
