# Task 1: the deadlock rule and the pair's record

Read the index's Brief and Global Constraints first. Size: Core (a pure rule table that decides who loses a
claim). Nothing calls this code until task 2, so behavior does not change.

**Files:**

- New `apps/daemon/src/mcp/claim-deadlock-rule.ts`: `DEADLOCK_YIELD_AFTER_MS`, `DeadlockMove`, `deadlockMove`.
  Pure; no database.
- New `apps/daemon/src/mcp/claim-deadlock-pairs.ts`: the `claim_deadlocks` setting and its functions.
- New `apps/daemon/src/mcp/claim-deadlock-rule.test.ts`.
- `packages/contracts/src/activity.ts`: `DecisionRule.ClaimDeadlock`, its `DECISION_RULE_NAMES` entry, the
  `forget_claim_deadlock` kind of `UndoAction`. Regenerate `packages/contracts/generated/` with the package's
  script; never edit it by hand.
- `packages/contracts/src/queue-wait.ts`: `QueueWaitKind.Turn`.
- `apps/daemon/src/inbox/activity-actions.ts`: `perform` becomes a switch over `action.kind`, as its comment says;
  `UndoMoves` gains `forgetClaimDeadlock(a: WorkstreamId, b: WorkstreamId): void`, wired in task 2. Until then the
  daemon's wiring throws a `ConflictError` ("not built"); no row carries the action yet.
- Every exhaustive switch or record over `QueueWaitKind` and `DecisionRule` (typecheck finds them), the desktop's
  labels included: `Turn` reads "Waits its turn".
- `apps/daemon/src/mcp/AGENTS.md`: a note naming the two modules and the order of the rule.

**Implements**, exactly (index, Interfaces): `deadlockMove`, `DeadlockMove`, `DEADLOCK_YIELD_AFTER_MS`,
`CLAIM_DEADLOCKS_KEY`, `DeadlockPair`, `readPair`, `recordBreak`, `markReported`, `dropPair`, `queuedBehind`,
`turnOver`, `endTurn`, `forgetEndedPairs`, `CLAIMS_TAKEN_KEY`, `TakenClaims`, `recordTaken`, `takenFrom`.

**The setting.**

- One key holds `z.array(DeadlockPair)`. Unset or unreadable reads as no pairs. A pair is stored with `a < b`
  (string order), so `readPair(x, y)` and `readPair(y, x)` find the same record.
- `recordBreak`: `breaks + 1`; `contested` is the union of what was there and what is given, each claim once;
  `queued` is `{ yielder, behind: other }` when `queue`, else left as it was.
- `queuedBehind(db, id)`: the `behind` of the first pair whose `queued.yielder` is `id` and for which `turnOver`
  is false; null otherwise. It reads only. The writer that finds a turn over calls `endTurn` (task 3).
- `turnOver`: the other task's row is terminal (`isTerminal`), or `activeClaims(db, other)` holds none of
  `contested`. A task parked on a person lets its claims go, so it does not hold the yielder.
- `dropPair` and `forgetEndedPairs` rewrite the array without the pair; an empty array deletes the key.
- A second key, `CLAIMS_TAKEN_KEY`, holds `z.array(TakenClaims)`, read and written the same way. `recordTaken`
  adds the claim to the record for (`from`, `to`), each claim once. `takenFrom(db, id)` answers the records whose
  `from` is `id`, without the claims `activeClaims(db, id)` holds again and without records left empty; it reads
  only. `forgetEndedPairs` also drops the records whose `from` is terminal. `dropPair` leaves them: an Undo must
  not hide a taken claim from the task that lost it.

**State-table rows:** the five rows of the order table; "Undo on a row" (the record's part); "Either task of a
pair reaches a terminal state" (the function; task 2 subscribes it).

**Test (one file, a pure table).** `claim-deadlock-rule.test.ts`: one `it.each` over the five moves, with the two
cases that show the order matters (a rule set to ask gives `card` before 2 minutes too; nothing to give up gives
`wait` at any count). Show it red first by swapping rows 1 and 2.

`Value: protects=when a claim deadlock is left to wait, carded, or broken by a yield, a queue or a report;
fails_when=a task loses a claim before 2 minutes, with the rule set to ask, or with nothing to give up;
why_new=claims (a pure rule table); no_claim=the wait's wiring, the pair's record or the queue`.

**Spec:** the "Claim deadlock" row of "3. The decision-rights table", and "5. How self-healing fails, and its
guards" (Loops), in the what-reaches-the-builder spec.
