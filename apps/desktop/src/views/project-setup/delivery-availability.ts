import type { FolderInspection } from '@10db/contracts';

/** Why "Open a pull request" can't be chosen for this folder, or null when it can. */
export function pullRequestBlock(input: {
  /** gh's login; null when gh is missing or signed out. */
  readonly ghLogin: string | null;
  readonly inspection: FolderInspection;
}): string | null {
  if (input.ghLogin === null) return 'Needs the GitHub CLI, signed in.';
  if (input.inspection.github === null) return 'This folder has no GitHub remote.';
  if (input.inspection.branches.length === 0) return 'This repository has no commits yet.';
  return null;
}
