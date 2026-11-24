# Task 5: the landing

**Size inside the plan:** Core (git, recovery). **Read:** the index's brief and Global Constraints; spec §5
"Landing" (all of it), §2 (admission, for the preconditions).

## Files

- `apps/daemon/src/delivery/copy-landing.ts` (new): `createCopyLanding`.
- `apps/daemon/src/delivery/copy-landing-cards.ts` (new): the wait cards, the failure cards and the migrations card,
  each keyed by batch and kind so a rerun raises it once and the landing withdraws it when it goes on.
- `apps/daemon/src/delivery/ship.ts`: `shipSteps` hands a batch that `isLocalCopy` to `CopyLanding.land` after
  step 0 (branch and clean checkout) and before any push; the ship flow's FAILED and OPEN transitions for such a
  batch call `resetLocalCopy`, except the row-G failure; `ship`'s Abandon refuses a batch whose journal is at
  `promoting`. Retry (`:1400-1403`) is unchanged: `toShipping` then `resume`, which reaches `land` and resumes at
  the journal's step.
- `apps/daemon/src/delivery/base-update.ts`: for a local copy, `from` is `refs/heads/<base>` and no fetch runs
  (`:1287-1297`, `:1615`); a conflict returns to the caller rather than gating without the base.
- The wiring in `daemon/start.ts`: the folder watcher's HEAD, base-ref and path events, and a one-minute timer on
  the injected clock, call `recheck(projectId)`.
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
  and the private-index status is clean; otherwise FAILED (`gate_changed_copy`). The last passing gate's commit is
  read from the batch's gate evidence.
- Waits: `patchLocalCopy({ wait, waitDetail, retryAt })` and one card; `recheck` runs `land` again through the ship
  queue for each waiting copy of the project whose `retry_at` has passed or whose wait an event may have ended.
  `base_moving`'s `retry_at` moves to the newest base change + 10 minutes on each base event. `index_locked` rechecks
  every 30 s and raises its card only after 10 minutes.
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
