# Task 1: the gate failure rule and its state

Read the index's Brief and Global Constraints first. Size: Core (a pure rule table that decides a recovery move).
Nothing calls this code until task 2, so behavior does not change.

**Files:**

- New `apps/daemon/src/delivery/gate-failure-action.ts`: `failureSignature`, `OutOfMovesReason`,
  `GateFailureAction`, `gateFailureAction`. Pure; no database, no git.
- New `apps/daemon/src/delivery/gate-fix.ts`: the `gate_fix.<batch id>` setting.
- New `apps/daemon/src/delivery/gate-failure-action.test.ts`.
- `apps/daemon/src/delivery/context.ts`: `DeliveryLimits.maxFixAttempts`, and
  `DEFAULT_DELIVERY_LIMITS.maxFixAttempts = FIX_ATTEMPT_LIMIT` from `@10db/contracts`, as `runner.ts` sets its own.
  Fix every place that builds a `DeliveryLimits` by hand (typecheck finds them).
- `apps/daemon/src/delivery/gate-failures.ts`: export `WORRYING`'s reading as
  `firstWorryingLine(tail: string): string | null` (colour codes stripped, lifecycle lines dropped, as
  `gateTailLines` does), so the signature and the card read the tail the same way.
- `apps/daemon/src/delivery/AGENTS.md`: a note naming the two modules and the order of the rule.

**Implements**, exactly (index, Interfaces): `failureSignature`, `OutOfMovesReason`, `GateFailureAction`,
`gateFailureAction`, `gateFixKey`, `GateFix`, `readGateFix`, `recordFix`, `grantMore`, `clearGateFix`.

**The signature.**

- Some step names tests: the sorted, de-duplicated lines `<step>\0<file>\0<test name or ''>` of every failing
  test, plus `<step>` alone for a failing step that names none, joined by `\n`. The error line is left out.
- No step names a test: `firstWorryingLine(tail)`, or null when there is none.
- Null equals nothing: two unreadable failures are never "the same", so only the count bounds them.

**The setting.**

- `readGateFix` parses with `GateFix.safeParse`; unset or unreadable reads as
  `{ count: 0, allowed: maxFixAttempts, signature: null, forceInside: false }`.
- `recordFix`: `count + 1`, `signature` as given, `forceInside: false`.
- `grantMore`: `allowed + max`, `signature: null`, `forceInside` as given. The null lets the next failure get a fix
  even when it is the one that stopped the loop: the builder asked for it.
- `clearGateFix`: `deleteAppSetting`. Task 2 calls it where the batch ships or is abandoned.

**State-table rows:** the six rows of the order table, and the "signature" bullets above.

**Test (one file, a pure table).** `gate-failure-action.test.ts`: one `it.each` over the six rows of the order
table, with the two cases that show the order matters (an outside failure of a batch that is not eligible reruns
first; `forceInside` skips row 3 and reaches row 6), and one `it` for the signature: the same tests in another
order and with another error line give the same string; a different test gives a different one; no tests and no
worrying line gives null. Show it red first by swapping rows 4 and 5.

`Value: protects=the order in which a failed ship gate is rerun, fixed or handed to the builder, and when two
failures count as the same; fails_when=a fix is filed past the budget, after the same failure, or for a failure
outside the batch; why_new=recovery (a pure rule table); no_claim=the ship wiring or the card`.

**Spec:** "5. How self-healing fails, and its guards" (Loops) and the "Ship gate failed" row of "3. The
decision-rights table" in the what-reaches-the-builder spec.
