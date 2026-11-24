# Task 5: the landing

**Size inside the plan:** Core (git, recovery). **Read:** the index's brief and Global Constraints; spec §5
"Landing" (all of it), §2 (admission, for the preconditions).

## Files

- `apps/daemon/src/delivery/copy-landing.ts` (new): `createCopyLanding`.
- `apps/daemon/src/delivery/copy-landing-cards.ts` (new): the wait cards, the failure cards and the migrations card,
  each keyed by batch and kind so a rerun raises it once and the landing withdraws it when it goes on.
- `apps/daemon/src/delivery/ship.ts`:
  - `shipSteps` routes a batch that `isLocalCopy` to `CopyLanding.land` **before** step 0's `repo === null` check
    (`:1037`); a copy has no origin repo. `land` does its own branch and clean-copy check. Step 1's "nothing
    beyond the base" close (`:1088-1096`) runs for a copy inside `land`, then card 6 retires the CLOSED copy.
  - The ship flow's FAILED and OPEN transitions for a copy call `resetLocalCopy` (a no-op while live at
    promoting); the catch-all (`:1296`) and `failWith` (`:507-514`) fail a live-promoting copy as
    `interrupted_landing`.
  - Abandon (`:2354`) also accepts a SHIPPING copy whose journal has a wait set and isn't live at promoting.
    It refuses a live-promoting one.
  - Retry (`:1400-1403`) is unchanged: `toShipping`, then `resume`, which reaches `land` at the journal's step.
    Retry with unfinished work (`:1383-1398`) resets, and so is a no-op while live at promoting.
  - A new run of the task (a builder message, a fix) while the copy is live at promoting, or FAILED as
    `interrupted_landing`, is refused with "a landing is settling in your folder". While waiting but not live,
    the run moves the batch to OPEN and resets.
- `apps/daemon/src/delivery/base-update.ts`: for a local copy, `from` is `refs/heads/<base>` and no fetch runs
  (`:1287-1297`, `:1615`); a conflict returns to the caller rather than gating without the base.
- The wiring in `daemon/start.ts`: a one-minute timer on the injected clock calls `recheck` for every project with
  a waiting copy (index call 3: no watcher events).
- `apps/daemon/src/delivery/AGENTS.md`: the landing's note.

## Interfaces it implements or calls

```ts
export interface CopyLanding {
  land(batchId: BatchId, signal: AbortSignal): Promise<void>;
  recheck(projectId: ProjectId): void;
}
export function createCopyLanding(deps: CopyLandingDeps): CopyLanding;
// calls: getLocalCopy, patchLocalCopy, resetLocalCopy (card 1); promoteFastForward, classifyFolder,
// finishPromotion (card 2); copyIdForBatch (card 3); retireCopy (card 6; bridge with a TODO(local-copy) shim)
```

`CopyLandingDeps` holds the delivery context, the gate slots (`baseUpdates.gate`), `runGate`, `sendToMerge`, the
inbox and the clock. Keep it to what `land` calls.

## Behavior

Spec §5 steps 1 to 5, the reset rule ("Leaving and re-entering") and the outcome table. Specifics:

- Every entry at `gating`, `gated` or `promoting` first compares the copy's head with C, and goes to `merging` if
  they differ.
- The gate is the one `shipSteps` step 2 runs, in the copy, in the slot. Before and after it, the copy's head is C
  and the private-index status is clean; otherwise FAILED (`gate_changed_copy`). Batches store no gate commit
  (`schema.ts:351-352`), so the only skip is a resume at `step: gated` whose C equals the copy's head. Every other
  entry runs the gate.
- Waits: `patchLocalCopy({ wait, waitDetail, retryAt })` and one card, and `land` returns: the job ends, the batch
  stays SHIPPING, and nothing holds the ship queue. `recheck` queues one ship job per waiting copy, skipping a copy
  whose job is queued or running (an in-flight set keyed by batch), and doing nothing while `holdShips()` is true.
  `base_moving` keeps the last base it saw in `baseTip`; a tick that reads a different base moves `retry_at` to
  now + 10 minutes and records it; the job runs once `retry_at` has passed. `index_locked` sets `retry_at` 30 s
  out, and raises its card only once the wait is 10 minutes old.
- A stop or shutdown: each step checks the signal before it acts and returns with the batch SHIPPING; recovery
  resumes at the journal's step. `promoteFastForward`, once called, runs to its end and its outcome is written.
- A merge conflict: `sendToMerge`, the batch to OPEN, reset. There is no `conflict` wait.
- `landed`: one transaction with the batch's SHIPPED transition and `step: landed`; then the migrations card when
  T..C touches the project's `migrations` hazard globs; then `step: retiring` and `retireCopy`.
- `filters`, a `deps` hazard path in the diff, or a changed copy across the gate: FAILED with its `BatchFailure`,
  reset. Row G: FAILED (`interrupted_landing`), the journal kept.

## State-table rows

Every row of the index's state table marked card 5.

## Tests

None beyond cards 2 and 8. The landing composes card 2's tested git, today's gate and merge-fix paths, and the
journal; the e2e lands a copy through the real daemon. A bug the pilot finds gets its regression test then.

## Done when

Typecheck, lint, related tests (`ship`, `base-update`, `recover` suites stay green), `make precheck`.
