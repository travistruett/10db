import { WorkPlace } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { chatRoot } from './work-root';

// The one function that picks a session's folder: the checkout, or the worktree on a branch.

const project = { repoPath: '/work/checkout' };
const worktree = '/root/p-abc123/chat-fix';

describe('chatRoot', () => {
  it.each([
    { name: 'reading', place: null, path: null, root: project.repoPath, writes: false },
    {
      name: 'choosing',
      place: WorkPlace.Choosing,
      path: null,
      root: project.repoPath,
      writes: false,
    },
    {
      name: 'moving',
      place: WorkPlace.Moving,
      path: worktree,
      root: project.repoPath,
      writes: false,
    },
    { name: 'here', place: WorkPlace.Here, path: null, root: project.repoPath, writes: true },
    { name: 'a branch', place: WorkPlace.Branch, path: worktree, root: worktree, writes: true },
    {
      name: 'a branch with no worktree',
      place: WorkPlace.Branch,
      path: null,
      root: project.repoPath,
      writes: false,
    },
  ])('$name', ({ place, path, root, writes }) => {
    expect(chatRoot({ workPlace: place, worktreePath: path }, project)).toEqual({ root, writes });
  });
});
