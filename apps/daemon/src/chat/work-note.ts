/** What a session on its own branch is told at every start, built from its row so a restart keeps it. */
export function workNote(
  chat: {
    readonly worktreePath: string | null;
    readonly branch: string | null;
    readonly baseHead: string | null;
  },
  checkout: string,
  moved: boolean,
): string | null {
  if (chat.worktreePath === null || chat.branch === null) return null;
  const base = chat.baseHead === null ? '' : `, made from ${chat.baseHead.slice(0, 7)}`;
  const lines = [
    `You work in ${chat.worktreePath} on the branch ${chat.branch}${base}. The builder's checkout at ${checkout} is off limits.`,
  ];
  // Said once, from memory: a restart before the next turn drops it, and the standing note above stays.
  if (moved)
    lines.push(
      'You moved here before your last change. Redo it here, and read a file again before you edit it.',
    );
  return lines.join(' ');
}
