import { firstExecutable, installCandidates } from '../git';

/**
 * The gh every `gh` call runs: the first in the fixed install prefixes, by the path it was found at,
 * which survives an upgrade; never one on the login PATH, where a lane could put one. Null when none
 * is installed there.
 */
export function resolveGh(candidates: readonly string[] = installCandidates('gh')): string | null {
  return firstExecutable(candidates);
}
