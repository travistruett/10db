# What a left-out revert undid is read from the branch, and only from a revert 10db wrote

- **Date:** 2026-11-04
- **Amends:** `decisions/2026-11-04-a-kept-revert-is-read-from-the-batchs-open-left-out-card.md`

## Decision

Ship without it writes each commit it undoes into the revert's message as `- <sha> (<title>)`. A later
Ship without it (`leaveOut`) reads those lines from the branch (`undoneOnBranch`, `git.ownCommitsWithSubject`),
whichever card was answered. A failed run's commit is skipped, and counted in its run's notice under the newest
revert that listed it, only if a revert lists it. Every other commit is reverted as usual, whether or not it is an
ancestor of a revert.

A listing counts only when all of these hold:

- **10db wrote the commit.** `git.commit` stamps every commit a session makes with the `10db-Op` trailer, and
  `revertCommits` does not. `ownCommitsWithSubject` drops any message with a `10db-Op:` line, so a message is
  never enough on its own.
- **The listed commit is in the repository**, checked with `hasCommit` first, and **in the revert's own history**.
  A listing that fails either is ignored. It does not stop the answer.

The log is read with NUL between its fields. A session writes messages, and a message can hold any other
separator, which would let it forge a whole record.

This supersedes the part of `decisions/2026-11-04-a-kept-revert-is-read-from-the-batchs-open-left-out-card.md`
that skips commits because of the revert on a card. The card's revert now only feeds the cards the answer raises.

The cards keep the two kinds of revert apart. With no card's revert standing, a revert read from the branch is
carried onto the stop cards only if no failed run's record names it: that is the one whose notices were lost, so
the cards offer no Retry and speak of finishing it. A revert a record names is finished, and the commits this
answer could not revert are not in it, so the ordinary card stays: Retry is offered, and it warns that Ship anyway
puts the commits in the pull request. Only a run's newest revert is asked about, because a record holds the latest
one alone.

## Why

- An ancestor of a revert is not a commit it undid: a finished task's commit from before the revert is one, and
  counting it shipped that commit under a notice saying it was reverted.
- A card or a notice may be missing after a failed write, and Later drops a card with no way back. The branch is
  the one record that cannot be lost, and it holds exactly what is on it.
- Reverting commits that built on each other a second time conflicts, so without this reading any answer on a card
  with no revert stopped at a conflict and lost the id.
- A session's commit message is unchecked text, so the trailer decides. It needs no record lookup, and a session
  cannot leave it off: the git dir is read-only to a lane, and the commit tool is the only way it commits.

## Known limits

- The search reads the 200 most recent commits mentioning the subject, sessions' included. A session that makes
  that many hides an older revert. The commits it undid are then reverted again, which conflicts or does nothing:
  a stop on a card, never a false report.
- A task title is copied into the revert's message unchanged, so a title holding a newline could add a line.
- A revert undone by hand on the branch still reads as having undone its commits. The commits are then on the
  branch under a notice saying they were reverted.
