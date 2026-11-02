# 10db merges the base into a shipped pull request that conflicts with it, and lands it

- **Date:** 2026-11-01
- **Amends:** `decisions/2026-10-29-pull-request-watch.md` (the watch hands a conflict to the shipper),
  `decisions/2026-10-31-notices-not-cards.md` (a conflict 10db can't settle in an open pull request is one card)

## Decision

- **Who.** A shipped batch that opened its pull request, not a CI fix's, and that merges by itself (`autoMerge`).
  A pull request held for the builder stays the builder's: its tasks keep the notice "Pull request conflicts with
  <base>" and 10db pushes nothing to it.
- **When.** The pull request watch reads the open pull request. GitHub's `mergeStateStatus` `DIRTY` or `mergeable`
  `CONFLICTING` asks the shipper to `catchUp` the batch (`PullRequestLanding`), which queues in the project's ship
  queue. One attempt per pull request head, again after 30 minutes at the same head, and at once when the head moves.
- **How.** A worktree is made for the batch from its branch (as GitHub has it: the commit is fetched and the local
  branch fast-forwarded to it), and then the same steps as before a gate: the base update merges `origin/<base>`
  (settling added-line conflicts and regenerating generated directories), the install follows the lockfile, the
  project's gate or pre-check runs on the result, and the branch is pushed, never forced. The worktree is retired
  again whatever happened. With no gate or pre-check the merge is pushed unchecked, as a first ship is.
- **What it says.** On success the batch notice `pull-request-update` (info): "10db merged <base> into the pull
  request", with the files the merge settled and how. When it can't (a conflict it can't settle, a gate that fails on
  the merged branch, a push GitHub refuses, a worktree it can't make) it raises one card, `pr-catch-up:<batch>`, that
  names the files or the failing check, and takes the batch's `base-conflict` and `pull-request-merge` notices off,
  so the builder reads one thing, not two. The watch withdraws the card once GitHub says the pull request merges.
- **Landing.** A merge GitHub refused ("the merge commit cannot be cleanly created") is retried, not left to the
  builder: when the watch reads the pull request clean (`MERGEABLE`, no `mergeStateStatus` block) and the batch carries
  the `pull-request-merge` notice, or 10db just pushed to it or gave up on it, the shipper asks for auto-merge again
  or, where the base has no required checks, merges at once, as at the first ship. At most once every 10 minutes while
  the notice stands.

## Why

On 2026-11-01 PR #217 shipped into `next` as #216 merged. GitHub refused the immediate merge, and the batch showed two
notices that sent the builder to GitHub; the orchestrator merged the base in by hand. GitHub's auto-merge never merges
a conflicted pull request either, so with `next` retired the same happens to two overlapping pull requests into `main`.
10db already does the merge before every gate and already pushes; it only lacked a worktree for a batch that shipped.

Turned down: merging with `Git.mergedCommit` and no worktree (no way to settle conflicts, regenerate or run the
gate on the result); calling GitHub's "update branch" API (a merge commit nobody checked, no conflict settling);
catching up pull requests held for the builder (it pushes to a branch the builder may be working on).
