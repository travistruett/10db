# Task 4: start and cut

**Size inside the plan:** Core (git: branches and worktrees). **Read:** the index's brief and Global Constraints;
spec §2 (start routing, admission), §3 "The copy's life" (Cut).

## Files

- `apps/daemon/src/daemon/services.ts:547-551`: route by the task's placement: a task placed `worktree` in a local
  project goes through `deps.starter.startTask`; everything else as today.
- `apps/daemon/src/delivery/start.ts`: `startTask` accepts a local project's copy task. While `unfinishedCopyOf`
  answers a batch, it refuses with `ConflictError`: "Another task is in a separate copy (<title>); start this one
  when that one ships or is abandoned" (index call 5). In the CUTTING insert (`:578-591`), in the same write, call
  `insertLocalCopy` with `teardownCommand` = the project's `copyTeardownCommand`. `startBatchApart`'s refusal of
  several local tasks stays.
- `apps/daemon/src/delivery/worktree-cut.ts`: for a local copy, start the branch at `refs/heads/<base>`, record it
  as `base_sha`, and skip the origin, fetch and `gh` checks (`:102-162`); `repo` stays null. Create (or, on a recut, overwrite)
  `teardownRef(batchId)` at `base_sha` right after `addWorktree` (`:196`), and in the OPEN write (`:261-265`) set
  the journal's `teardownSha` to `base_sha` with `patchLocalCopy`. A cut refused before OPEN (`:83-97`) deletes the
  ref if it made one (card 6 exports `teardownRef`; bridge it here with a
  `// TODO(local-copy)` shim if card 6 hasn't landed).
- `apps/daemon/src/scheduler/scheduler.ts`: the missing-worktree and wrong-branch checks (`:534-554`) and the branch
  snapshot (`:640-649`) run for any batch with a worktree, read from the pinned batch, not only for pull-request
  projects.
- `apps/daemon/src/delivery/recover.ts:140`: `cuttableAgain` tests against `refs/heads/<base>` when the batch
  `isLocalCopy`.
- `apps/daemon/src/delivery/worktree-sweep.ts:279` and `branch-sweep.ts:40,187`: sweep a local project's copy
  worktrees and branches that no batch names, as for pull-request projects, and `refs/10db/copies/*` refs whose
  batch is gone.
- `apps/daemon/src/delivery/AGENTS.md` and `scheduler/AGENTS.md`: notes.

## Interfaces it calls

`insertLocalCopy`, `patchLocalCopy`, `isLocalCopy`, `unfinishedCopyOf` (card 1); `teardownRef(batchId: BatchId): string` (card 6).

## State-table rows

`(cut)` → `open`.

## Tests

None new: the e2e (card 8) runs start, cut and launch in the copy through the real daemon. Existing worktree-cut
and recover tests must stay green.

## Done when

Typecheck, lint, related tests, `make precheck`.
