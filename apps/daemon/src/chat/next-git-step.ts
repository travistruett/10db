import { ChatGitStep, WorkPlace } from '@10db/contracts';

// The title row's next git step (sessions spec §4.6), decided from facts alone: one row per row of the spec's table,
// plus a session that is moving and a holder of the checkout. The facts are read by `work-state.ts`.

export interface NextStepFacts {
  readonly place: WorkPlace | null;
  /** The session has a folder it may change: Here, or a branch whose worktree exists. */
  readonly writes: boolean;
  /** The project delivers by merging locally, with no pull request. */
  readonly local: boolean;
  /** The project's origin is a GitHub repository, so a pull request can be opened. */
  readonly hasGithub: boolean;
  readonly baseBranch: string;
  /** The session's branch is the base branch itself (a Here session that has not branched). */
  readonly onBase: boolean;
  readonly dirtyFiles: number;
  /** Commits the session's branch has that its base lacks. */
  readonly ahead: number;
  /** Commits the branch has that its pushed copy lacks; they are on no pull request yet. */
  readonly unpushed: number;
  readonly pullRequest: {
    readonly checks: { readonly passed: number; readonly total: number; readonly failing: number };
    readonly mergeable: boolean | null;
    readonly merged: boolean;
  } | null;
  /** The builder's checkout, which a local merge lands in. */
  readonly checkout: { readonly branch: string | null; readonly dirtyFiles: number };
  /** Whoever refuses a step in a Here session's checkout, in words; null when nobody does. */
  readonly holder: string | null;
  /** Why the last move of a choosing session failed. */
  readonly moveFailure: string | null;
}

export interface NextStep {
  readonly next: ChatGitStep | null;
  /** Why `next` can't run now, or a failed move's words. */
  readonly refusal: string | null;
}

export const MOVING_WORDS = 'Wait for the move to finish.';

const none = (refusal: string | null = null): NextStep => ({ next: null, refusal });

function mergeRefusal(
  pr: NonNullable<NextStepFacts['pullRequest']>,
  baseBranch: string,
): string | null {
  const { checks } = pr;
  if (checks.failing > 0)
    return `Checks failing · ${String(checks.failing)} of ${String(checks.total)}`;
  if (checks.passed < checks.total)
    return `Checks running · ${String(checks.passed)}/${String(checks.total)}`;
  if (pr.mergeable === false) return `This pull request conflicts with \`${baseBranch}\`.`;
  if (pr.mergeable === null) return 'GitHub is still working out whether it can merge.';
  return null;
}

function localMergeRefusal(facts: NextStepFacts): string | null {
  const { checkout, baseBranch } = facts;
  if (checkout.dirtyFiles > 0)
    return 'Your checkout has uncommitted changes, so it can’t take a merge.';
  if (checkout.branch !== baseBranch)
    return `Your checkout is on ${checkout.branch === null ? 'no branch' : `\`${checkout.branch}\``}; it must be on \`${baseBranch}\` to take the merge.`;
  return null;
}

export function nextGitStep(facts: NextStepFacts): NextStep {
  if (facts.place === WorkPlace.Moving) return none(MOVING_WORDS);
  if (facts.place === WorkPlace.Choosing) return none(facts.moveFailure);
  if (facts.place === null || !facts.writes) return none();
  const step = (next: ChatGitStep, own: string | null = null): NextStep => ({
    next,
    // The holder's words come first: nothing runs until it lets go, whatever else is true.
    refusal: facts.holder ?? own,
  });
  if (facts.dirtyFiles > 0) return step(ChatGitStep.Commit);
  const pr = facts.pullRequest;
  if (pr?.merged === true) return none();
  // Commits the pull request lacks are pushed first, or Merge would land the pull request without them.
  if (pr !== null && facts.unpushed > 0) return step(ChatGitStep.OpenPullRequest);
  if (pr !== null) return step(ChatGitStep.Merge, mergeRefusal(pr, facts.baseBranch));
  if (facts.ahead === 0) return none();
  if (facts.local) {
    if (facts.onBase) return none();
    return step(ChatGitStep.MergeLocal, localMergeRefusal(facts));
  }
  return facts.hasGithub ? step(ChatGitStep.OpenPullRequest) : none();
}
