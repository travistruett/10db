// Workbench spec §5.4 (D8): commands a card shows for the builder to copy. Git allows `$`, `;`, `&`,
// backticks and parentheses in a branch name, so each name is one shell word when pasted.

/** `ref` as one word of a POSIX shell: as it is when plain, else single-quoted. */
export function shellWord(ref: string): string {
  return /^[A-Za-z0-9._/-]+$/.test(ref) ? ref : `'${ref.replaceAll("'", `'\\''`)}'`;
}

/** The command that brings branch `from` into branch `into` in Your folder. */
export function branchMergeCommand(into: string, from: string): string {
  return `git switch ${shellWord(into)} && git merge ${shellWord(from)}`;
}
