import { shellWord } from '../git';

// Workbench spec §5.4 (D8): the merge command the folder card shows for the builder to copy, each
// branch name one shell word.

/** The command that brings branch `from` into branch `into` in Your folder. */
export function branchMergeCommand(into: string, from: string): string {
  return `git switch ${shellWord(into)} && git merge ${shellWord(from)}`;
}
