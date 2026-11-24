import { basename, dirname, join } from 'node:path';

/**
 * The suffix of the folder beside a checkout where its builder keeps worktrees made by hand. A
 * folder name ending in `.noindex` is one Spotlight skips, so it needs no marker file.
 */
const HAND_MADE_SUFFIX = '-worktrees.noindex';

/** The folder the builder used before the `.noindex` one; still read while its worktrees drain. */
const DRAINING_SUFFIX = '-worktrees';

/**
 * The folders beside `repo` where worktrees made by hand live, the current one first:
 * `10db-worktrees.noindex`, then the older `10db-worktrees`, both beside `10db`. Neither need exist.
 */
export function handMadeWorktreeFolders(repo: string): string[] {
  const name = basename(repo);
  return [HAND_MADE_SUFFIX, DRAINING_SUFFIX].map((suffix) =>
    join(dirname(repo), `${name}${suffix}`),
  );
}

/** Whether Spotlight already skips `folder` by its name. */
export function skippedBySpotlightByName(folder: string): boolean {
  return folder.endsWith('.noindex');
}
