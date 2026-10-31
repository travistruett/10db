# One merged branch that can't be swept never holds back the others

- **Date:** 2026-10-30
- **Amends:** decisions/2026-10-30-finished-tasks-leave-no-local-branch.md

## Decision

- **A failure is about one branch.** `removeMergedBranches` sweeps each merged task in its own `try`. A failure
  that is not gh being down (`ghDown`: signed out, not installed, timed out, unreachable, aborted) is logged
  as `merged branch not swept` with the batch and branch, and the sweep goes on to the next. gh being down
  still ends the run, as every later read would fail the same way.
- **The sweep runs after a failed round too.** The watch runs `afterRound` even when the round threw (it logs
  both), so a pull request that breaks the round does not keep the merged ones' branches for ever.
- **A head this repository lacks is fetched.** A merged pull request's head can be a commit GitHub made (a
  branch update, auto-merge keeping the branch current) that no clone holds. `Git.hasCommit` asks, and
  `Git.fetchCommit` fetches the one commit from origin's pinned fetch URL into the object store, naming no
  ref and writing no `FETCH_HEAD`. With the head here, the rule is unchanged: the branch goes only when its
  tip is that head or an ancestor of it. When the head can't be had, the branch stays with a warning, and the
  next round tries again.
- **Nothing else changes.** The signal is still the watch's recorded `merged` state, whatever merged the pull
  request (auto-merge, 10db, or by hand with `gh` or on GitHub), into `main` or into another branch such as
  `next`; a branch that moved past the merged head is still kept.

## Why

- The sweep went through the merged batches oldest first inside one `try` for the whole project. The first
  failure, such as `git merge-base --is-ancestor` exiting 128 on a head object the repository lacks, ended the
  run, and it failed the same way every two minutes, so the oldest merged branch with that problem kept every
  later merged branch too: the builder's repository kept the branches of #166, #167 and #168, and of older
  pull requests, with nothing in the Inbox, because the failure was only a log line.
- A round that threw skipped the sweep, so a break anywhere in the watch also stopped the cleanup.
- Fetching the head is the only exact test for a head GitHub made. Treating "head unknown" as "branch
  contains nothing extra" would delete a branch that holds commits the pull request never carried.
