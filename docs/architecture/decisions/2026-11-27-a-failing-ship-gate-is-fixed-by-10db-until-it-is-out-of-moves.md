# A failing ship gate is fixed by 10db until it is out of moves

- **Date:** 2026-11-27

Designed, not built: `docs/superpowers/plans/2026-11-27-ship-gate-out-of-moves.md` is the plan.

## Decision

- A ship gate that fails only in tests the batch did not change is run again once. One that fails in the batch's
  own files reopens the batch with a fix task. Neither raises a card.
- The builder gets one card, "Out of moves", when a batch's fix tasks are used up, when the same failure returns
  after a fix, or when the gate fails twice outside the batch. It offers Spend More Attempts, Change the Task and
  Drop It. The same card ends a run out of retries or recovery attempts, and a pull request out of CI fixes that is
  still open 30 minutes after the stop.
- **The gate has its own budget, per batch:** `FIX_ATTEMPT_LIMIT` fix tasks, each with its own run attempts. The
  spec (`2026-11-27-what-reaches-the-builder-design.md` §5) says no automatic move has a budget of its own.
- **The failure signature is the failing steps and tests, without the error's first line**, which the same
  section names. With no test read it is the first failing line of the output, and with neither it is nothing, which
  never equals another failure.
- The counts live in `app_settings` (`gate_fix.<batch id>`, `ci_out_of_moves.<root batch id>`), deleted when the
  batch or pull request ends.
- A Workbench pass's batch and a batch in a separate local copy keep today's gate card.

## Why

- A fix task is a task with its own steps and retries, so the existing budgets cannot count it: a run's attempts
  belong to one workstream, and a batch has none. A count per batch is the smallest thing that bounds the loop.
- An error's first line carries durations, ports and temp paths, so the same failure would rarely match itself and
  the guard would never fire. Leaving it out can call two different failures of one test the same; that costs one
  early card, which the builder answers with Spend More Attempts.
- A setting avoids a migration while only one open pull request may add one. It moves to a column when something
  needs its history.
- A pass's batch never ships again by itself, and a local copy's failed landing must be reported as interrupted, so
  reopening either would lose something. They wait for their own design.
- CI waits 30 minutes, as the spec's table has it: a stop that a rerun or a pushed commit ends inside the window
  never needed the builder.
