# A pass has a batch of its own kind, made at the folder's HEAD, which the scheduler and the ship trigger leave alone

- **Date:** 2026-11-09
- **Amends:** `decisions/2026-10-29-workspace-per-task.md`; sits beside the batch delivery spec

## Decision

A Workbench pass (`docs/superpowers/specs/2026-11-09-10db-workbench-design.md` §5) is a `passes` row with one
batch, `batches.pass_id` set and no worktree. Its tasks carry `tasks.pass_id`. One pass per project is `OPEN`,
`CLOSING` or `ABANDONING` (partial unique index `passes_one_open`).

**Opening** (`openPass`, `apps/daemon/src/delivery/pass-open.ts`) runs in the project's delivery queue. Under
the checkout's repo lock (`Git.openPassBranch`) it records every path whose content on disk differs from HEAD's
commit, untracked ones git does not ignore included, with the blob of that content, or null for a deleted file
(`pass_dirt`), keeps the content in an unsigned commit on that commit at `refs/10db/passes/<pass id>/dirt`,
makes the branch `10db/<slug>-<6 hex>` at HEAD's commit and points HEAD at it. No file and no index entry is
written, so a dirty folder opens as it is. The pass records `return_branch` and `start_sha`; its batch is
`OPEN` from the start, `base_sha` the start, `repo` from origin's pinned push URL or null with no origin, on any
delivery. Each task gets a `QUEUED` workstream in the batch and takes its page areas, and its areas with no
role, through the scheduler's `acquireClaims`; a page another task holds makes that task wait with a notice
naming the holder. The answer says how many commits HEAD has that origin's base, as last fetched, lacks.

Opening is refused with nothing written for a project with no page area, a task naming none, two tasks holding
one area or pages whose globs can share a file (`passPagesProblem`), more tasks than the page cap (4 by
default, 6 at most), a parked, running, finished or already-passed task, a second open pass, an unfinished
batch or a running lane in Your folder, and a detached HEAD. A batch start written while git works makes the
pass's write fail, and the branch and the dirt ref are taken back (`Git.undoPassBranch`).

**The built rules leave a pass's batch alone.** The scheduler never launches a pass task's workstream. The ship
trigger and startup's check never ship the batch, and Ship, Ship anyway and Ship without it refuse it. These are
keyed on `pass_id`, not on the batch's state, so a pass batch a failed close leaves `FAILED` is read as open.

**Lanes.** A pass's lanes are counted for the pass (`LaneCounts.byPass`), not for the project's `maxLanes`, and
are held to its page cap; they still count against the account's limit and the daemon-wide cap
(`roomForLane`, `apps/daemon/src/scheduler/lane-room.ts`).

**Your folder is the pass's (W9)** while any pass of the project is neither `SETTLED` nor `ABANDONED`. A start
sends a task set to Your folder to a separate copy with the reason "Your folder is in a Workbench pass", the
placement rule's proposal (`proposePlacement`'s `passHoldsFolder`); one the builder placed in the folder is
refused, saying so; no shared batch is joined or cut. A `local` project has no copies, so the scheduler leaves
its folder task queued with the notice "Waits for the Workbench pass to close" and no card.

Not yet built: the route that opens a pass and the turns that launch its tasks (the next slice), the close,
watching its pull request, and a warm session yielding its lane, which needs the warm sessions that slice adds.

## Why

The pass works live in the builder's folder, so it cannot start from the base with a clean checkout as a
shared cut does; recording the dirt with its content is what lets later steps tell work that was already there
from work made in the pass, and put a file back exactly. A batch is reused for its branch, push, pull request
and cards, but its tasks are spoken to one turn at a time, so the queue and the ship trigger, which act on
their own, must not touch it. Pass lanes are outside `maxLanes` because a pass holds up to six pages by design;
the account and daemon caps still bound the Mac.

Turned down: making the pass batch through the batch-start route (it answers 400 in a `local` project and cuts
from the base); a new batch state for passes (every built reader of batch states would need a case); keying
the skips on `OPEN` alone, which a failed close's `FAILED` would slip past.
