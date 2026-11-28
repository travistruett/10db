# A claim deadlock is broken by the later asker yielding, and a repeat queues it

- **Date:** 2026-11-27

## Decision

Designed, not built; the plan is `docs/superpowers/plans/2026-11-27-claim-deadlock-yield-then-queue.md`.

- Two tasks that each wait for a claim the other holds raise no card. After 2 minutes the task whose wait found
  the cycle (the later asker) gives up the claims the other waits for. The other task gets committed work only;
  the yielder's uncommitted edits stay its own, as
  `decisions/2026-11-27-a-task-that-gives-up-a-claim-in-a-shared-checkout-keeps-its-edits.md` has it.
- A second deadlock between the same two tasks also queues the yielder behind the other. Its turn comes when the
  other task is terminal or holds none of the claims the two contested.
- A third files one defect task in 10db's own project, by a signature of the contested claim names, and still
  yields and queues.
- A claim leaves a task in two ways only: released from a task that is told through its live wait, or taken from
  a task that is queued behind the asker, in state Queued, with no lease, all checked in the write that takes it.
  That write records the take in its own `app_settings` key, and the queued task's next brief names the claim
  until the task holds it again: it has no session to tell, and a wait's memory would not survive a restart.
- The pair's count, queue and contested claims live in one `app_settings` key and are dropped when either task
  ends. The record of a taken claim is dropped only when the task it was taken from ends.
- Each yield and queueing is an Activity row under the rule `claim-deadlock`. Undo drops the pair's record; it
  never moves a claim. Ask Me Next Time brings back the card.

## Why

- Every one of the 30 deadlock cards in the spec's 7-day count was answered the same way, and the move can be
  taken back by asking again, so a rule decides it.
- The later asker yields because it is the one whose wait sees the cycle, so it is told in the same call, and it
  has usually done less in the claim it asked for last.
- Yield alone lets two tasks pass one claim back and forth; a queue ends that without cancelling either.
- The turn ends on "holds none of the contested claims" as well as "terminal", because a task parked on a person
  lets its claims go and would otherwise hold the yielder for days.
- Claims do not lapse by themselves, so a queued task's claim must be taken; requiring Queued and no lease in the
  same write means it is never taken from a task that is running.
- `app_settings` survives the restarts a self-update causes, which an in-memory count would not, and needs no
  migration.
- Turned down: an Undo that takes the claim back (two tasks could edit one area); cancelling the yielder on a
  repeat (loses work); a card on the third repeat (the builder can do nothing a queue has not done; the defect is
  10db's to fix).
