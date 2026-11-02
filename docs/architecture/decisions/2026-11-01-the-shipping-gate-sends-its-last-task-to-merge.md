# The shipping gate sends the batch's last task to resolve a base conflict, and runs no gate on the stale branch

- **Date:** 2026-11-01
- **Amends:** `decisions/2026-11-01-a-session-resolves-the-conflicts-of-the-base-merge.md` (closes its first "Left
  open" bullet)

## Decision

The shipping gate asks for the same merge a task's verify gate does (`BeforeGateOptions.inSession`). When
`beforeGate` answers `conflicted` (it merged the base and git's markers are in the files, or an earlier gate's
markers are still there) the shipper:

- runs **no gate** and pushes nothing: the gate's `beforeStart` answers false for `conflicted`, as for `aborted`;
- in one write moves the batch SHIPPING → FAILED → OPEN (the transitions a fix task's reopening goes through, with
  no card between), opens the batch's **last finished task** again (`task.status` done → open; a pull request has
  not merged, so nothing else depends on it being done) and inserts a new workstream for it in the batch: one
  step, the last implement step of the finished run reset, `nextAction: { kind: 'merge', base, paths }`;
- raises no card. The runner's `merge` handling is unchanged: the session resolves the markers, commits through the
  commit tool, and calls `ask_human` only for a resolution that changes what a side does. That is the one card, and
  it names the files and why. The workstream's own verify gate then answers `merged` and the batch ships itself once
  the task is done again.

The last task is the batch's Done workstream with the newest `updatedAt`. When no task can take the conflict (no
finished task, the task was closed, its run had no implement step) the batch fails with **one** `base_conflict`
card (`BatchFailure.BaseConflict`) that lists the files and says why no session could resolve them, and Retry ships
it again once the builder has resolved them.

A conflict no session can see in markers (both sides added a file, a lockfile, a binary file) is still the
`base-conflict` notice with the gate on the branch as it is: `leaveMarkers` is never asked for it, so `conflicted` is
never answered.

## Why

The shipping gate fails on markers an earlier gate left (the gate-failed card), and on a conflict that first appears
there it tested the stale branch and shipped a pull request that conflicts. A new workstream rather than a revived
one because a Done workstream has no way out (`WORKSTREAM_TRANSITIONS`), and a Done run's claims, lease and
handoffs are spent. A bounded loop: the new workstream counts its own sessions against `maxFixAttempts` in
`sendToMerge` of the runner, so a session that leaves the markers again fails the workstream and the batch with the
runner's card, and only a base that moved again sends the last task back a second time.
