import { WorkPlace } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { chatWorkStateDto } from '../../test/chat-work-fixtures';
import { sessionMeta, type SessionMetaInput } from './session-meta';

const base: SessionMetaInput = {
  projectName: '10db',
  place: null,
  movingTo: null,
  state: undefined,
  terminalSince: null,
  inTerminal: false,
};

const pr = (
  over: Partial<NonNullable<ReturnType<typeof chatWorkStateDto>['pullRequest']>> = {},
) => ({
  number: 652,
  url: 'https://github.com/o/r/pull/652',
  checks: { passed: 9, total: 9, failing: 0 },
  mergeable: true,
  merged: false,
  ...over,
});

describe('sessionMeta', () => {
  const rows: readonly {
    readonly name: string;
    readonly input: Partial<SessionMetaInput>;
    readonly want: string;
  }[] = [
    { name: 'reading', input: {}, want: '10db · no changes yet' },
    {
      name: 'choosing',
      input: { place: WorkPlace.Choosing },
      want: '10db · waiting for your choice',
    },
    {
      name: 'moving, with the branch',
      input: { place: WorkPlace.Moving, movingTo: 'fix-login' },
      want: 'moving to fix-login',
    },
    {
      name: 'moving, before the branch is read',
      input: { place: WorkPlace.Moving },
      want: 'moving to a new branch',
    },
    {
      name: 'in the terminal',
      input: { inTerminal: true, terminalSince: '09:41' },
      want: 'in your terminal since 09:41',
    },
    {
      name: 'here, files changed',
      input: { place: WorkPlace.Here, state: chatWorkStateDto({ place: 'here', dirtyFiles: 2 }) },
      want: 'on main · 2 files changed',
    },
    {
      name: 'here, one file',
      input: { place: WorkPlace.Here, state: chatWorkStateDto({ place: 'here', dirtyFiles: 1 }) },
      want: 'on main · 1 file changed',
    },
    {
      name: 'here, nothing changed yet',
      input: { place: WorkPlace.Here, state: chatWorkStateDto({ place: 'here' }) },
      want: 'on main · no changes yet',
    },
    {
      name: 'a branch, not committed',
      input: {
        place: WorkPlace.Branch,
        state: chatWorkStateDto({ place: 'branch', branch: 'add-the-qa-notes', dirtyFiles: 2 }),
      },
      want: 'on add-the-qa-notes · 2 files changed, not committed',
    },
    {
      name: 'a branch, committed and not in a pull request',
      input: {
        place: WorkPlace.Branch,
        state: chatWorkStateDto({ place: 'branch', branch: 'qa', ahead: 3 }),
      },
      want: 'on qa · 3 commits not in a pull request',
    },
    {
      name: 'a branch with nothing ahead of its base, as after a merge',
      input: {
        place: WorkPlace.Branch,
        state: chatWorkStateDto({ place: 'branch', branch: 'qa', baseBranch: 'main' }),
      },
      want: 'on qa · nothing ahead of main',
    },
    {
      name: 'a branch, committed, on a project that merges locally',
      input: {
        place: WorkPlace.Branch,
        state: chatWorkStateDto({
          place: 'branch',
          branch: 'qa',
          ahead: 1,
          next: 'merge_local',
          baseBranch: 'main',
        }),
      },
      want: 'on qa · 1 commit not merged into main',
    },
    {
      name: 'a pull request with checks passing',
      input: {
        place: WorkPlace.Branch,
        state: chatWorkStateDto({ place: 'branch', branch: 'qa', ahead: 1, pullRequest: pr() }),
      },
      want: 'on qa · pull request #652, checks passing',
    },
    {
      name: 'a pull request with checks running',
      input: {
        place: WorkPlace.Branch,
        state: chatWorkStateDto({
          place: 'branch',
          branch: 'qa',
          pullRequest: pr({ checks: { passed: 3, total: 9, failing: 0 } }),
        }),
      },
      want: 'on qa · pull request #652, checks running · 3/9',
    },
    {
      name: 'a pull request with checks failing',
      input: {
        place: WorkPlace.Branch,
        state: chatWorkStateDto({
          place: 'branch',
          branch: 'qa',
          pullRequest: pr({ checks: { passed: 5, total: 9, failing: 2 } }),
        }),
      },
      want: 'on qa · pull request #652, 2 checks failing',
    },
    {
      name: 'merged',
      input: {
        place: WorkPlace.Branch,
        state: chatWorkStateDto({
          place: 'branch',
          branch: 'qa',
          pullRequest: pr({ merged: true }),
        }),
      },
      want: 'on qa · merged into main',
    },
  ];
  it.each(rows)('$name', ({ input, want }) => {
    expect(sessionMeta({ ...base, ...input })).toBe(want);
  });
});
