# 10db starts CI again on a shipped pull request whose head never got its required checks

- **Date:** 2026-11-02
- **Amends:** `decisions/2026-11-01-a-conflicting-pull-request-gets-its-base-merged-in.md` (the same merge, for a second cause)

## Decision

- **What is noticed.** The pull request watch reads an open pull request (a batch's own, not a CI fix's) whose head has
  no check at all (`statusCheckRollup` empty, `checks: none`), that does not conflict, and that GitHub holds as
  `mergeStateStatus` `BLOCKED` with no review pending (`reviewDecision` neither `REVIEW_REQUIRED` nor
  `CHANGES_REQUESTED`), while `gh pr checks --required` also reports none. `PullRequestStatus.blockedOnChecks` is that
  `BLOCKED` reading. The `BLOCKED` is what tells a base that requires checks whose runs never started from a base with
  no CI, which is `CLEAN`; 10db reads no rulesets or branch protection for it.
- **When.** The head has 10 minutes from when the watch first saw it so. A head that gets any check, running or
  finished, is never touched, and the count and the notice end with it. A new head starts its own 10 minutes.
- **Start CI again.** For a batch that merges by itself, the watch asks the shipper once (`PullRequestLanding.restartCi`)
  to do the catch-up of a conflict for this cause: a worktree from the branch as GitHub has it, the base merged in, the
  gate or pre-check on the result, a push that is never forced, the worktree retired. A new head makes GitHub build the
  merge ref again and start the workflows. The shipper reads the pull request again first and pushes only while the head
  still has no check. It raises no card when it stops (the branch already holds the base, a conflict it cannot settle, a
  failed gate, a checkout in the way): a card about conflicts would be wrong, and the notice below says what matters. On
  success the batch carries the info notice `pull-request-update`, "10db merged <base> into the pull request to start its
  checks".
- **If it does not work.** Another 10 minutes with no check on the head, whether or not 10db pushed, and the batch gets
  the warning notice `checks-never-started`, "Checks never started on pull request #N", with the link, on every task of
  the batch. It goes when any check appears on the head. A pull request held for the builder gets the notice after the
  first 10 minutes and nothing is pushed to it.
- **State.** The count and whether 10db asked are in memory; a restart counts the 10 minutes again and asks once more.

## Why

On 2026-11-02 PR #315 sat BLOCKED for about three hours after 10db's catch-up pushed a merge of main onto it: no
workflow ever started for that head (`gh pr checks` said "no checks"), and auto-merge waits for checks that never come.
GitHub skips `pull_request` workflows when it cannot build the merge ref at push time. The orchestrator merged main in
again by hand. The catch-up already does that merge, safely, so it is the one way tried.

Turned down: an empty commit when the branch already holds the base (a new git operation on the pushed branch for a
rare case; the notice tells the builder to push one); closing and reopening the pull request (the watch reads a closed
pull request as ended, which abandons the batch's fixes, and the reopen turns auto-merge off); reading the base's
rulesets to learn that checks are required (needs rights and misses classic protection; `BLOCKED` covers both).
A pull request that waits for a review in a repository with no required checks reads the same as one whose checks
never ran, except that a pending review decision is excluded; an approved one that GitHub still blocks for another
reason gets one merge of the base and then the notice.
