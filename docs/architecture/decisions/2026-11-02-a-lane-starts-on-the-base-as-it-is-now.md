# A lane starts on its base branch as it is when the lane launches, not as it was when the task started

- **Date:** 2026-11-02
- **Builds on:** `decisions/2026-10-29-gate-with-base.md` (the base merge before a gate)

## Problem

A worktree batch's copy is cut when the task is started, at the base as it is then. A task that waits in the queue
launches on that copy later. Whatever merged into the base meanwhile is not in it, and a lane cannot merge the base
itself (its git dir is read-only). On 2026-11-02 a lane whose task extended #228 launched on a copy still at #227 and
offered the builder to reimplement #228.

## Decision

`BaseUpdates.atLaunch(batchId, signal)` (`delivery/base-update.ts`) is `beforeGate` taking its turn among the batch's
gates (`gate`), with `BeforeGateOptions.atLaunch`. The runner calls it from `run` (`baseFirst`), before the
migrations-hazard base and before the first session, for a lane that has no `baseHead` yet: one that has run a session
keeps its copy, because its own changes are in it and a merge under a resumed conversation would surprise it.

- It fetches the base, then `Git.mergeIntoBranch` does what it does before a gate: a copy with no commits of its own
  is fast-forwarded to the base, a copy with commits takes a merge commit with the base as its second parent. The copy
  is never reset. The install and the generators run as before a gate, and `moveBase` moves the batch's base and the
  start of each task.
- A fetch that fails starts the lane on the copy as it is. A `base-fetch` notice (`baseNotices.fetchFailed`) is shown
  on the batch's tasks, because no gate note will say it; the next fetch that works clears it.
- A conflict, uncommitted changes in the way, or files git does not track leave the copy as before a gate and show the
  same notices. It does not pass `inSession`: the lane's prompt does not ask it to resolve markers, so none are left in
  its tree.
- A batch in the builder's own checkout is never merged into, and a CI fix batch is left on the pull request's head
  (`ciFixHead`), so neither calls the base.
- Nothing stops the lane: whatever `atLaunch` answers, or throws, the session starts (a stop still wins).

## Why

- The lane cannot merge the base itself (its git directory is read-only), so the launch is the last moment anything can
  bring in what merged since the task started. Doing it there reuses the merge a gate already does, not a second path.
- A lane that has run a session keeps its copy: its own changes are in it, and a merge under a resumed conversation
  would surprise it. Only a lane with no `baseHead` yet is brought up to date.
- Never stopping the lane means a failed fetch or a conflict costs the lane a stale copy, which is what it had before,
  and the notices tell the builder, instead of leaving the task blocked on a base problem.
