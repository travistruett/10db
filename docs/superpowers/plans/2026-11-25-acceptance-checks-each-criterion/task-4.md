# Task 4: a `fix` that can resume its session

**Size: Core** (recovery). Read the index's Brief and Global Constraints first. Needs task 1.

## Files

- `apps/daemon/src/runner/next-action.ts`:
  - `resumedSessionOf` returns `fix.providerSessionId`;
  - `nextActionAfterCrash` turns a resumed `fix` into the same `fix` with `providerSessionId: null`, as it does for
    `revise`;
  - `nextActionOnAnotherAccount` clears it.
- `apps/daemon/src/runner/runner.ts`:
  - `reviseAfterModelDrift` and `withFreshFixEscalated` handle a `fix` that has a `providerSessionId` the same way
    they handle `revise`, using `fixFresh: Pending`;
  - wherever a `fix` action starts a session, resume `providerSessionId` when it is set.
- `apps/daemon/src/runner/fix-evidence.ts`: `outstandingFixEvidence` also reads `EvidenceKind.Acceptance` rows whose
  `detail.sentBack === true`, under the Builder rule (outstanding until the current step's `startedAt` passes it).
  It ignores every other Acceptance row.
- `apps/daemon/src/briefing/prompts.ts`: the `fix` case words by evidence kind. For Acceptance it reads "10db's
  acceptance check read these criteria as not met:", followed by each criterion with its note. It never says "the
  builder sent the work back". A resumed session gets the notes inline. A fresh one gets them the same way a gate
  failure's text reaches it.
- `apps/daemon/src/recovery/recover.ts`: a crash during an acceptance fix recovers to a fresh `fix` with the same
  `evidenceId`.

## Interfaces

- Uses the `fix` variant (`providerSessionId: z.string().min(1).nullable().default(null)`), `EvidenceKind.Acceptance`
  and `AcceptanceDetail`, as the index quotes them.

## State-table rows

- Crash during a resumed acceptance fix.
- Project moved to another account during a fix.
- "Acceptance row written as the Review starts (no send-back)": a record only.

## Spec sections

"Send-back": the Fix rule, Notes and The prompt bullets.

## Tests

- Extend `runner/next-action.test.ts` with rows for a `fix` that has a `providerSessionId`: after a crash, on another
  account, and through `resumedSessionOf`. Add no new file.
- Value card: `why_new=recovery (core)`.
