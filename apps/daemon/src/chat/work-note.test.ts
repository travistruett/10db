import { describe, expect, it } from 'vitest';
import { workNote } from './work-note';

const row = { worktreePath: '/wt/fix', branch: 'fix', baseHead: 'abcdef0123456' };

describe('workNote', () => {
  it.each([
    {
      name: 'a branch session',
      chat: row,
      moved: false,
      says: "You work in /wt/fix on the branch fix, made from abcdef0. The builder's checkout at /repo is off limits.",
    },
    {
      name: 'the first start after the move',
      chat: row,
      moved: true,
      says: 'Redo it here',
    },
    {
      name: 'a session with no worktree',
      chat: { ...row, worktreePath: null },
      moved: true,
      says: null,
    },
  ])('$name', ({ chat, moved, says }) => {
    const note = workNote(chat, '/repo', moved);
    if (says === null) expect(note).toBeNull();
    else expect(note).toContain(says);
  });
});
