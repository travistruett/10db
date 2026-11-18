import { ChatGitStep, WorkPlace } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { nextGitStep, type NextStepFacts } from './next-git-step';

// The title row's next step, one row per row of the sessions spec's §4.6 table, plus moving and a holder.

const base: NextStepFacts = {
  place: WorkPlace.Branch,
  writes: true,
  local: false,
  hasGithub: true,
  baseBranch: 'main',
  onBase: false,
  dirtyFiles: 0,
  ahead: 0,
  unpushed: 0,
  pullRequest: null,
  checkout: { branch: 'main', dirtyFiles: 0 },
  holder: null,
  moveFailure: null,
};

const open = (over: Partial<NonNullable<NextStepFacts['pullRequest']>> = {}) => ({
  checks: { passed: 9, total: 9, failing: 0 },
  mergeable: true,
  merged: false,
  ...over,
});

describe('nextGitStep', () => {
  it.each<{
    name: string;
    facts: Partial<NextStepFacts>;
    next: ChatGitStep | null;
    refusal: string | null;
  }>([
    {
      name: 'a reading session has no git step',
      facts: { place: null },
      next: null,
      refusal: null,
    },
    {
      name: 'a choosing session has none',
      facts: { place: WorkPlace.Choosing, dirtyFiles: 3 },
      next: null,
      refusal: null,
    },
    {
      name: 'a choosing session after a failed move shows the failure',
      facts: { place: WorkPlace.Choosing, moveFailure: 'git could not cut the worktree' },
      next: null,
      refusal: 'git could not cut the worktree',
    },
    {
      name: 'a moving session waits for the move',
      facts: { place: WorkPlace.Moving, dirtyFiles: 3 },
      next: null,
      refusal: 'Wait for the move to finish.',
    },
    {
      name: 'a branch with no worktree reads only',
      facts: { writes: false, ahead: 2 },
      next: null,
      refusal: null,
    },
    {
      name: 'uncommitted changes are committed first',
      facts: { dirtyFiles: 2, ahead: 1 },
      next: ChatGitStep.Commit,
      refusal: null,
    },
    {
      name: 'commits not on a pull request, remote project, open one',
      facts: { ahead: 2 },
      next: ChatGitStep.OpenPullRequest,
      refusal: null,
    },
    {
      name: 'here on the base branch with commits, remote project, opens one',
      facts: { place: WorkPlace.Here, onBase: true, ahead: 1 },
      next: ChatGitStep.OpenPullRequest,
      refusal: null,
    },
    {
      name: 'no GitHub repository, so no pull request',
      facts: { hasGithub: false, ahead: 2 },
      next: null,
      refusal: null,
    },
    {
      name: 'nothing to do on a clean branch with no commits',
      facts: {},
      next: null,
      refusal: null,
    },
    {
      name: 'commits the open pull request lacks are pushed before it merges',
      facts: { ahead: 3, unpushed: 1, pullRequest: open() },
      next: ChatGitStep.OpenPullRequest,
      refusal: null,
    },
    {
      name: 'a pull request whose checks pass and that can merge, merges',
      facts: { ahead: 2, pullRequest: open() },
      next: ChatGitStep.Merge,
      refusal: null,
    },
    {
      name: 'checks still running disable Merge, with the count',
      facts: {
        ahead: 2,
        pullRequest: open({ checks: { passed: 3, total: 9, failing: 0 } }),
      },
      next: ChatGitStep.Merge,
      refusal: 'Checks running · 3/9',
    },
    {
      name: 'failing checks disable Merge',
      facts: {
        ahead: 2,
        pullRequest: open({ checks: { passed: 6, total: 9, failing: 2 } }),
      },
      next: ChatGitStep.Merge,
      refusal: 'Checks failing · 2 of 9',
    },
    {
      name: 'a pull request that conflicts disables Merge',
      facts: { ahead: 2, pullRequest: open({ mergeable: false }) },
      next: ChatGitStep.Merge,
      refusal: 'This pull request conflicts with `main`.',
    },
    {
      name: 'a pull request GitHub has not judged yet disables Merge',
      facts: { ahead: 2, pullRequest: open({ mergeable: null }) },
      next: ChatGitStep.Merge,
      refusal: 'GitHub is still working out whether it can merge.',
    },
    {
      name: 'a merged pull request leaves nothing',
      facts: { ahead: 2, pullRequest: open({ merged: true }) },
      next: null,
      refusal: null,
    },
    {
      name: 'new changes after a merge are committed',
      facts: { dirtyFiles: 1, pullRequest: open({ merged: true }) },
      next: ChatGitStep.Commit,
      refusal: null,
    },
    {
      name: 'local project, commits on the branch, a clean checkout on the base',
      facts: { local: true, ahead: 2 },
      next: ChatGitStep.MergeLocal,
      refusal: null,
    },
    {
      name: 'local project with no commits has nothing to merge',
      facts: { local: true, ahead: 0 },
      next: null,
      refusal: null,
    },
    {
      name: 'local merge says the checkout is dirty',
      facts: { local: true, ahead: 2, checkout: { branch: 'main', dirtyFiles: 3 } },
      next: ChatGitStep.MergeLocal,
      refusal: 'Your checkout has uncommitted changes, so it can’t take a merge.',
    },
    {
      name: 'local merge says the checkout is off the base',
      facts: { local: true, ahead: 2, checkout: { branch: 'feature', dirtyFiles: 0 } },
      next: ChatGitStep.MergeLocal,
      refusal: 'Your checkout is on `feature`; it must be on `main` to take the merge.',
    },
    {
      name: 'local merge says the checkout is on no branch',
      facts: { local: true, ahead: 2, checkout: { branch: null, dirtyFiles: 0 } },
      next: ChatGitStep.MergeLocal,
      refusal: 'Your checkout is on no branch; it must be on `main` to take the merge.',
    },
    {
      name: 'a holder refuses a here session’s step with its words',
      facts: {
        place: WorkPlace.Here,
        dirtyFiles: 1,
        holder: 'A Board task is changing files on `main`.',
      },
      next: ChatGitStep.Commit,
      refusal: 'A Board task is changing files on `main`.',
    },
    {
      name: 'a holder refuses before the pull request’s own reason',
      facts: {
        place: WorkPlace.Here,
        ahead: 1,
        pullRequest: open({ checks: { passed: 1, total: 3, failing: 0 } }),
        holder: 'The pass ‘Polish’ is changing files on `main`.',
      },
      next: ChatGitStep.Merge,
      refusal: 'The pass ‘Polish’ is changing files on `main`.',
    },
  ])('$name', ({ facts, next, refusal }) => {
    expect(nextGitStep({ ...base, ...facts })).toEqual({ next, refusal });
  });
});
