import { slugOf } from '@10db/contracts';
import { chatBranchName } from './git-names';

/** What is already claimed: git's branches, and the paths on disk or recorded for other sessions. */
export interface TakenNames {
  readonly branches: readonly string[];
  readonly paths: readonly string[];
}

/** The slug is cut well short of a ref's limits, so a `-<n>` suffix always fits. */
const FALLBACK = 'session';

/** Names compare folded, since a case-insensitive volume keeps `Fix` and `fix` as one ref file or folder. */
const folded = (text: string): string => text.normalize('NFC').toLowerCase();

/**
 * The branch and worktree path a session's move claims: the title as a slug (a `10db/` prefix or any other text
 * is made safe by `slugOf`, and the name is checked by `chatBranchName`), then `-2`, `-3`… until neither the
 * branch nor its path is taken. `pathOf` is where a branch's worktree goes, so the lanes' layout stays in one
 * place.
 */
export function branchFor(
  title: string,
  taken: TakenNames,
  pathOf: (branch: string) => string,
): { readonly branch: string; readonly path: string } {
  const branches = new Set(taken.branches.map(folded));
  const paths = new Set(taken.paths.map(folded));
  const stem = slugOf(title, FALLBACK);
  for (let n = 1; ; n += 1) {
    const branch = chatBranchName(n === 1 ? stem : `${stem}-${String(n)}`);
    const path = pathOf(branch);
    if (!branches.has(folded(branch)) && !paths.has(folded(path))) return { branch, path };
  }
}
