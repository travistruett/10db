# Task 6: retirement and recovery

**Size inside the plan:** Core (recovery, worktrees). **Read:** the index's brief and Global Constraints; spec §3
"The copy's life" (Retire), §8 "Recovery".

## Files

- `apps/daemon/src/delivery/copy-retire.ts` (new): `retireCopy`, `teardownRef`.
- `apps/daemon/src/delivery/worktree-cleanup.ts`: a local copy's worktree, branch and teardown ref go only after
  `retireCopy`'s teardown succeeds.
- `apps/daemon/src/delivery/recover.ts`: step 3 sends a SHIPPING local copy to `shipper.resume` as today (card 5
  routes it to the landing); step 5 retires a SHIPPED, CLOSED or ABANDONED local copy through `retireCopy`; step 3's own FAILED write for
  a copy off its branch (`:219-227`) fails a live-promoting copy as `interrupted_landing`, journal kept; a copy whose
  journal is at `promoting` with no live job runs `classifyFolder` and acts on its row per spec §8; a surviving
  gate process for a `gating` copy is ended by step 2 as for SHIPPING batches.
- ABANDONED and CLOSED: the batch's Abandon (`ship.ts`) and ship step 1's close of a copy with no commits set
  `step: retiring` and call `retireCopy`.
- `apps/daemon/src/delivery/AGENTS.md`: the retirement note.

## Interfaces it implements or calls

```ts
export function retireCopy(
  ctx: DeliveryContext,
  batchId: BatchId,
  signal: AbortSignal,
): Promise<'retired' | 'failed'>;
export function teardownRef(batchId: BatchId): string; // refs/10db/copies/<batch id>/teardown
// calls: getLocalCopy, patchLocalCopy (card 1); classifyFolder, finishPromotion (card 2); copyIdForBatch (card 3)
```

## Behavior

- `retireCopy` with `teardownSha` null (a cut that never reached OPEN, so no lane ran and no database exists): the
  worktree and row go, no teardown runs.
- `retireCopy`: `step: retiring`; a fresh scratch worktree of `teardown_sha` (no seed, no install) under the made
  worktree root, as `scratch-gate.ts` makes one; the pinned `teardown_command` through the unslotted gate runner,
  as the dev login runs (`pictures/sign-in.ts`), with `copyId`; the scratch worktree goes whatever the outcome.
  Exit 0: the copy's worktree, branch and teardown ref go, `step: retired`. Otherwise one card with the log path
  and a Retry that calls `retireCopy` again; the step stays `retiring`.
- Recovery never writes the folder except `finishPromotion` for row D.

## State-table rows

`retiring` → teardown outcomes; `open` (ABANDONED) → `retiring`; "any / daemon restart" → spec §8's table.

## Tests

None new: the classifier's table test (card 2) covers recovery's decisions on the folder, and the e2e (card 8)
retires a landed copy. The existing `recover` tests stay green.

## Done when

Typecheck, lint, related tests, `make precheck`.
