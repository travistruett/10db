# A started copy task waits for the copy in progress instead of being refused

- **Date:** 2026-11-25
- **Amends:** `decisions/2026-11-24-a-commit-directly-project-may-use-separate-copies.md`

## Decision

Starting a task in a separate copy while another copy of the project is unfinished is accepted. The start writes
the CUTTING batch, its journal row (`local_copies.step = 'queued'`, `CopyStep.Queued`) and the QUEUED run in the
one write a start makes today, and queues no cut. When no copy of the project is in progress (`copyInProgressOf`:
unfinished, not queued), `advanceCopyQueue` (`delivery/start.ts`) cuts the oldest waiting copy (`queuedCopiesOf`):
it asks the start's checks again (`refuseLocalCopy`), sets the journal to `open` with the project's current
teardown command, and queues the cut as a restart's recut does. A copy those checks refuse is deleted with a card
naming its tasks, as a refused cut is, and the next goes on. It runs on every batch and run change
(`subscribeCopyQueue`) and once at startup after recovery, so a landing, an abandon, a refused cut, a cancel or a
restart all move the queue. Still one copy of a project is cut or unfinished at a time, and the landing rules are
unchanged.

A task whose unfinished dependencies are all in one waiting copy joins that copy, as a dependent joins its
dependency's copy, so both land together. A waiting task is cancelled like any queued run; a waiting copy none of
whose runs is left is deleted. Its card says what it waits for through the scheduler's `copy` wait: "for the copy
in progress (<title>) to ship or be abandoned, then its turn as the next copy". It is not endless, so the stall
sweep raises nothing however long it waits, and a drain does not wait on it (`countBatchesInFlight`).

## Why

An unattended run stalled after every landing until someone started the next copy, and a builder could not queue a
day's work before leaving. The journal already is the copy's persisted state, so the queue needs no table and no
migration: `step` is text, and recovery leaves a queued row alone because no cut began for it. A queued copy is a
CUTTING batch so the run's task is already "started" everywhere (board, dependencies, cancel); the places that read
CUTTING as "a cut is running" (recovery, the stall sweep, the drain count, removing an unstarted task) skip a
queued row. Provider parity: nothing here reads the account.

Tasks started together and independent of each other become separate copies, cut one after another, rather than
one shared copy: a copy lands as one gated change, and the pilot keeps copies small. Only dependency groups share a
copy.
