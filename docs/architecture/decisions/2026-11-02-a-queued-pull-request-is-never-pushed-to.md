# A pull request in the base's merge queue is left alone, and one the queue removes is a failed required check

- **Date:** 2026-11-02
- **Amends:** `decisions/2026-10-29-pull-request-watch.md` (the watch reads whether the pull request is queued)

## Decision

- **Arming is unchanged.** `gh pr merge --auto --squash` (`prAutoMerge`, `prMerge`) stays as it is on a base protected
  by a merge queue. gh 2.83.2's binary carries "The merge strategy for %s is set by the merge queue": `--squash` is
  warned about and exits 0, and "will be added to the merge queue … when ready" is what it prints. The one flag it
  refuses with a queue is `-d`, which 10db never passes.
- **10db reads the queue.** `Gh.prInMergeQueue({ repo, url })` asks GraphQL for the pull request's `isInMergeQueue`
  (`gh api graphql`, owner, name and number each its own argument): gh 2.83.2's `pr view --json` has no merge queue
  field. It throws a `GhError`, never answers `false`, for a failed call, an answer without the field or a url that is
  no pull request of the repository, so an unread queue is not taken for an empty one.
- **Queued means hands off.** The watch reads the queue for each open pull request after its checks. While the pull
  request is queued, or the read gave no answer, the watch asks for no catch-up and no merge retry, counts nothing
  toward the no-CI watchdog (it drops the count and the notice), reruns no cancelled check and starts no CI fix.
  `ship.ts` reads the queue again just before a push, since the job runs after the watch's read: the catch-up and the
  no-CI restart push nothing when the pull request is queued or the queue cannot be read, and a CI fix batch ends
  `CLOSED` with nothing pushed ("its pull request is in the merge queue, where a push would remove it").
- **The CI line says it.** A queued pull request is stored as `prMergeBlocked: 'queued'` (a third value of
  `PullRequestMergeBlocked`, beside `conflicts` and `behind`; the column is text, so no migration) and the line reads
  "Pull request open · queued to merge", whatever its checks say. A read that gave no answer keeps the stored mark.
- **A removal is a failed check.** A pull request stored as queued that is open, not queued now and still at the head it
  was queued at was removed by the queue, as when its merge group failed. The watch reads its required checks as
  `failing` with one job, `Merge queue` (no job id, no run id), for as long as the head is that one. Nothing is
  pushed: with no Actions job there is no log, so `ciFailureAction` stops with `no_log`, the one `ci-stopped` card
  names `Merge queue`, and the task is Blocked. A new head, whoever pushed it, is read as its own checks say, and the
  stop lifts. A head that changed since it was queued is a push that took it out, not a failure. After a restart the
  stored mark has no head, so a dequeued pull request counts as removed.

## Why

A push to a pull request's branch removes it from the queue, and a queued pull request reads BLOCKED with its
checks pending, which the no-CI watchdog (checks never started), the cancelled-check rerun, the catch-up and a CI fix
could each take for stuck and push over. Reading the queue before each of them is the whole guard; the mark on the
batch is only what the CI line shows.

The queue's own group run is not a check of the pull request, so `gh pr checks` never lists its failure: the only sign
is the pull request leaving the queue unchanged, which is why the stored mark is the memory. The log of the group's run
is not read. It is a `merge_group` run on a ref `gh pr` does not name, and a fix made from a guess at it would push a
change nobody asked for; the card sends the builder to the run instead.

Turned down: an unreadable queue counting as not queued (a push could remove a queued pull request, so the safe answer
to no answer is to push nothing); a new column for the queued state (`prMergeBlocked` already carries what GitHub
will not merge as it stands, and the card line reads the one field).
