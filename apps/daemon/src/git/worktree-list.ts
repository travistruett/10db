/** One entry of `git worktree list --porcelain -z`. */
export interface WorktreeEntry {
  /** As git recorded it. */
  readonly path: string;
  readonly head: string | null;
  /** Without `refs/heads/`; null for a detached or bare entry. */
  readonly branch: string | null;
  /** The lock reason; `''` when locked with none; null when unlocked. */
  readonly locked: string | null;
  readonly prunable: boolean;
  readonly bare: boolean;
}

/** What a 10db worktree's lock reason starts with; the rest is the batch's id. */
export const WORKTREE_LOCK_PREFIX = '10db ';

const LOCK_REASON = /^10db (bat_[0-9a-f-]+)$/;
const HEADS = 'refs/heads/';

/**
 * Reads `git worktree list --porcelain -z`: each field ends in a NUL and a record ends in one more,
 * so a lock reason that holds a newline stays whole.
 */
export function parseWorktreeList(porcelainZ: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: { -readonly [K in keyof WorktreeEntry]: WorktreeEntry[K] } | null = null;
  for (const field of porcelainZ.split('\0')) {
    if (field === '') {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    const space = field.indexOf(' ');
    const key = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? '' : field.slice(space + 1);
    if (key === 'worktree') {
      if (current) entries.push(current);
      current = {
        path: value,
        head: null,
        branch: null,
        locked: null,
        prunable: false,
        bare: false,
      };
      continue;
    }
    if (!current) continue;
    switch (key) {
      case 'HEAD':
        current.head = value;
        break;
      case 'branch':
        current.branch = value.startsWith(HEADS) ? value.slice(HEADS.length) : value;
        break;
      case 'locked':
        current.locked = value;
        break;
      case 'prunable':
        current.prunable = true;
        break;
      case 'bare':
        current.bare = true;
        break;
      default:
        break;
    }
  }
  if (current) entries.push(current);
  return entries;
}

/** The batch id a 10db lock reason names, or null. */
export function lockedBatchId(entry: WorktreeEntry): string | null {
  return entry.locked === null ? null : (LOCK_REASON.exec(entry.locked)?.[1] ?? null);
}
