# Task 3: the out-of-moves card, for the gate, a run and recovery

Read the index's Brief and Global Constraints first. Size: Core (answers that abandon a batch or revert commits).
Starts after task 2 has merged.

**Files:**

- New `apps/daemon/src/inbox/out-of-moves-card.ts`: `OUT_OF_MOVES_DETAIL`, `OutOfMovesChoice`, `OutOfMovesKind`,
  the zod detail, `outOfMovesFields`, `createOutOfMovesAnswers`. Exported through `inbox/index.ts`.
- `apps/daemon/src/delivery/cards.ts`: `shipCards.outOfMoves(batch, reason, steps, fix, note, check)`. It keeps
  `shipFailureFoldKey`, `stepsText` and `detail.logPath`; it has no `detail.actions`.
- `apps/daemon/src/delivery/ship.ts`: `out_of_moves` raises it. `gateFailed` and `gateFailedUnrelated` stay for
  `legacy_card` only; say so in their comments.
- `apps/daemon/src/runner/runner.ts`: the failures that say "the retry limit is used up" (five sites that test
  `attempt > opts.limits.maxFixAttempts`) pass `outOfMovesFields({ kind: Run, … })` to `flagFailed`.
- `apps/daemon/src/recovery/recover.ts`: "Recovery failed N times" passes `kind: Recovery`, N the recovery limit.
- `apps/daemon/src/daemon/start.ts`: wire `createOutOfMovesAnswers` beside `createBatchCardAnswers`.
- `apps/desktop/src/views/inbox/batch-card-actions.tsx`: check that a card without `detail.actions` draws no Retry
  or Abandon and still draws `StepLogLink`; change it only if it does not.
- `apps/desktop/e2e/inbox.spec.ts`: extended. `apps/daemon/src/inbox/AGENTS.md`: the card and who raises it.

**Implements** (index, Interfaces): `OUT_OF_MOVES_DETAIL`, `OutOfMovesChoice`, `OutOfMovesKind`,
`outOfMovesFields`, `createOutOfMovesAnswers`. **Calls:** `grantMore`, `readGateFix`.

**The gate card.** Title: `Out of moves: <gateFailureWords> · <batch title>`. The body's first line, by reason:

- `budget`: "N fix tasks did not get the gate green." (N is `fix.count`.)
- `same_failure`: "The same tests failed again after the fix."
- `outside_twice`: "The gate fails in files the batch did not change, and 10db ran it twice. Spend More Attempts
  starts a fix task in this batch anyway."

Then `stepsText(steps)`. Each option's description says what it does and its count: "Files up to N more fix
tasks", "Files one fix task with your note" and "Abandons the batch; nothing is merged".

**The answers** (the third table of the index's State table). The detail is JSON from the database: parse it.

- Gate, More: one write `grantMore(w, batchId, max, reason === outside_twice)`, then the shipper's retry.
- Gate, Change: refused without a note (throw, so the card stays, as `createBatchCardAnswers` refuses). With one:
  the batch reopens with a fix task whose description opens with the note; `allowed` grows by one first.
- Gate, Drop: `Shipper.abandon(batchId)`.
- Run and Recovery, More and Change: `retryWorkstream(id, note?)`. Change is refused without a note.
- Run and Recovery, Drop: in a batch with another finished task, `shipper.shipWithout(batchId, workstreamId)`;
  in a batch without one, cancel the workstream and abandon the batch; outside a batch, cancel the workstream.
- On a run's card the options replace `batchCardFields`' options; the detail keeps `BATCH_CARD_DETAIL` beside
  `OUT_OF_MOVES_DETAIL`, so `left-out-settle.ts` and the shipper's withdrawals still find the card.

**State-table rows:** order rows 3, 4 and 5, and the Gate, Run and Recovery rows of the card table.

**Test.** No unit test. Extend `apps/desktop/e2e/inbox.spec.ts` with one case; it seeds no gate card today. The
cheapest road through the real daemon is a project whose gate command always fails in the same test of a file the
batch changed: one fix task runs, the gate fails the same way, and the card is raised for `same_failure`. Assert
the card shows the three answers and no Retry or Abandon, and that Spend More Attempts closes it and leaves the
batch open with a fix task. Rewrite the "offers Retry and Abandon" case of `ship-gate-failures.test.ts` to expect
this card. Click it through against the real daemon before review.

**Spec:** "8. Where this departs from #953", item 5, and the "Ship gate failed" and "Failed run" rows of "3. The
decision-rights table" in the what-reaches-the-builder spec; "2.2 Answers" in the inbox-cards spec.
