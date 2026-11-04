# A reused complete_step opId records the new verdict but files no follow-up twice

- **Date:** 2026-11-04
- **Amends:** `decisions/2026-11-04-complete-step-follow-ups-are-bounded-per-step.md`

## Decision

That decision said a session reusing an `opId` an earlier session used files its `followUps` again, so they
count against the same list. This replaces that rule. The rest stands: the verdict and notes are still recorded
(`decisions/2026-10-30-a-reviews-verdict-is-recorded-under-a-reused-opid.md`), and a step's total is still the
lines in its current result.

- **What is matched.** A follow-up whose title equals one the stored reply of that `opId` lists is that follow-up,
  and it is not filed, even when its description differs. A task filed under another `opId` is never matched.
  Each stored follow-up matches at most one follow-up of the call, so of two inputs with one title the second
  files.
- **The reply names every filing under the `opId`.** The stored reply holds the earlier filings and this call's,
  whatever the step's result lists, so a third call under that `opId` still matches the first call's. The list
  in the reply is not bounded by the step's total.
- **The bound counts only what this call files.** A call is refused when the result's list plus the tasks it
  would newly file pass `MAX_FOLLOW_UPS`. A matched follow-up is not counted, so a call that files nothing is
  never refused, even on a full list.
- **The result's list is the step's current run.** A call writes the list its result already holds plus what
  it newly files. It does not add earlier filings of the `opId` that the list no longer holds. Inside one run
  the list already holds them. When the step was entered again between the calls (a rejection's rework, a
  restart), its result moved to `earlier` and keeps naming them there, and the new run's list and total start
  again as the amended decision says.
- A round therefore gets a full allowance whether or not it reuses an `opId`.

## Why

The task "A later session reusing a complete_step opId does not file the step's follow-ups twice" found that a
session that lost the answer and retried from a new session, or a rerun reusing its `opId`, created duplicate
Icebox tasks, and `replaceToolOp` overwrote the record of the first filing.

The `opId`'s stored reply is the only record of what that call filed, and it holds each task's id and title, not
its description. A rerun writes its follow-ups afresh, so comparing whole bodies would also file a duplicate for
a reworded description.

Adding the earlier filings to the current result was tried first and was wrong. An `opId` reused across rounds
carried the last round's list into a fresh result, so a result could list more than `MAX_FOLLOW_UPS`, and every
later call was refused, including one with no `followUps`. A sent-back review that cannot record a verdict ends
with none. Basing the check on the longer list and refusing only calls that file something would keep the verdict
but not the bound, because a call filing nothing can still carry a list past it, and it would also give a
round that reuses an `opId` a smaller allowance than one that does not.

## Not done

- Follow-ups of earlier rounds under a different `opId` are not matched. A reviewer who files the same finding
  again in a later round under a new `opId` files a second task; the review rounds rule already says a later round
  reports only what is new, and nothing has been seen to get past it.
