import { basename, dirname, join } from 'node:path';

/** The suffix of the folder beside a checkout where its builder keeps worktrees made by hand. */
const HAND_MADE_SUFFIX = '-worktrees';

/**
 * The folder beside `repo` where worktrees made by hand live: `10db-worktrees` beside `10db`. It
 * need not exist.
 */
export function handMadeWorktreeFolder(repo: string): string {
  return join(dirname(repo), `${basename(repo)}${HAND_MADE_SUFFIX}`);
}
