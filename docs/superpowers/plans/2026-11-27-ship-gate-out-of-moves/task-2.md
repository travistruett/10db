# Task 2: a failed ship gate files its fix task

Read the index's Brief and Global Constraints first. Size: Core (the shipper's state machine; a batch reopens).
Starts after task 1 has merged.

**Files:**

- `apps/daemon/src/delivery/ship.ts`: `runShipCheck` decides through `gateFailureAction`; new `sendToFix`.
- New `apps/daemon/src/delivery/gate-fix-text.ts`: the fix task's title, description and criterion, as
  `ci-fix-text.ts` does for CI.
- `apps/daemon/src/delivery/ship-gate-failures.test.ts`: extended.
- `apps/daemon/src/delivery/AGENTS.md`: the gate's failure path, as built.

**Calls** (index, Interfaces): `gateFailureAction`, `failureSignature`, `readGateFix`, `recordFix`,
`clearGateFix`, `DeliveryLimits.maxFixAttempts`.

**`runShipCheck`.** Both callers (the ship steps and the catch-up) go through the same code, so change it once.

- After the flaky rerun, on a failed first gate: read the steps, then
  `gateFailureAction({ outside, reran: false, eligible, signature, fix })`.
- `eligible = batch.passId == null && getLocalCopy(db, batch.id) === null`.
- `rerun`: today's second `gateOnce()`. If it fails, decide again with `reran: true` and the second run's steps.
- `fix`: `sendToFix(batch, steps, gate, signature)`; return false.
- `legacy_card`: today's `shipCards.gateFailedUnrelated` (outside twice) or `shipCards.gateFailed`.
- `out_of_moves`: until task 3, the same two cards as `legacy_card`, so this task ships alone.
- A timed-out gate keeps `gateTimedOut`.

**`sendToFix`**, modelled on `sendToMerge` beside it, in one `state.write`:

1. Return if the batch is no longer SHIPPING.
2. SHIPPING → FAILED (`BatchFailure.GateFailed`) → OPEN (`failure: null`), with `settleLeftOutCards` and
   `resetCopyJournal`, exactly as `sendToMerge` does.
3. Insert the fix task (`insertTask`) in the batch's project, with the batch's placement, and its workstream with
   `planForStart` and `insertPlannedWorkstream(w, task.id, plan, batch.id)`, as `ci-fix.ts` does. The description
   names each failing step, its tests, each test's reason (`failureReasons`) and the step's log path, and says
   which earlier fix tasks of this batch already tried.
4. `recordFix(w, batch.id, signature, limits.maxFixAttempts)`.
5. `withdrawIn(w, batch.projectId, [shipFailureFoldKey(batch.id)])`.

Then `onWorkQueued()`. When the write cannot file a task (it returns why, as `sendToMerge` does), fall back to
`fail(batch, shipCards.gateFailed(...))`. The batch ships again by `checkBatch` when the fix task is done.

`clearGateFix` runs in the write that moves a batch to SHIPPED and in `abandon`'s write.

**State-table rows:** order rows 1, 2 and 6, and the eligibility table. A daemon restart between the write and the
fix task's start loses nothing: the task and its queued workstream are rows.

**Test (extend, do not add a file).** In `ship-gate-failures.test.ts`, on its real shipper and real git repo:

- rewrite "doesn't run it again when a failing test is in a file the batch changed": no card is open under
  `shipFailureFoldKey`, the batch is OPEN, one new task with a queued workstream is in it, and `readGateFix` reads
  `count: 1`;
- the two "could not have caused" cases stay as they are until task 3;
- add a pass batch with the same failure: it still gets `gateFailed`.

Show the first red before `sendToFix` exists.

`Value: protects=a ship gate failing in the batch's own files reopens the batch with one fix task and no card;
fails_when=the card comes back, the batch stays FAILED, two fix tasks are filed, or a pass batch is reopened;
why_new=git merges and recovery (the shipper's state machine); no_claim=the fix session's work, or the
out-of-moves card`.

**Spec:** "3.2 What 10db does instead of asking", item 1, in the inbox-cards spec; the "Ship gate failed" row of
"3. The decision-rights table" in the what-reaches-the-builder spec.
