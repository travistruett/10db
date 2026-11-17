import { describe, expect, it } from 'vitest';
import { branchFor } from './chat-worktree';

// The branch and path a session's move claims: one name per session, never one another session or git holds.

const pathOf = (branch: string): string => `/root/p-abc123/chat-${branch}`;
const none = { branches: [], paths: [] };

describe('branchFor', () => {
  it.each([
    {
      name: 'a title becomes a slug',
      title: 'Add the QA notes',
      taken: none,
      branch: 'add-the-qa-notes',
    },
    { name: 'an empty title falls back', title: '', taken: none, branch: 'session' },
    {
      name: 'unicode is folded to ASCII',
      title: 'Überprüfung der Straße',
      taken: none,
      branch: 'uberprufung-der-stra-e',
    },
    {
      name: 'a 10db/ prefix is flattened, never 10db’s own',
      title: '10db/batch',
      taken: none,
      branch: '10db-batch',
    },
    {
      name: 'a taken branch takes -2',
      title: 'fix login',
      taken: { branches: ['fix-login'], paths: [] },
      branch: 'fix-login-2',
    },
    {
      name: 'a taken branch compares folded',
      title: 'fix login',
      taken: { branches: ['Fix-Login'], paths: [] },
      branch: 'fix-login-2',
    },
    {
      name: 'a taken path takes -2 though the branch is free',
      title: 'fix login',
      taken: { branches: [], paths: ['/root/p-abc123/chat-fix-login'] },
      branch: 'fix-login-2',
    },
    {
      name: 'another session’s recorded names count the same',
      title: 'fix login',
      taken: { branches: ['fix-login', 'fix-login-2'], paths: ['/root/p-abc123/chat-fix-login-3'] },
      branch: 'fix-login-4',
    },
  ])('$name', ({ title, taken, branch }) => {
    const picked = branchFor(title, taken, pathOf);
    expect(picked).toEqual({ branch, path: pathOf(branch) });
  });
});
