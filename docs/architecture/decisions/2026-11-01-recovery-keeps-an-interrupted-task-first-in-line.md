# Recovery puts an interrupted task back at the front of the queue

- **Date:** 2026-11-01
- **Amends:** `decisions/2026-10-30-run-next.md`

## Decision

When startup recovery re-queues a workstream that was mid-lane (a restart, an app install, a crash), it stamps
`workstreams.run_next_at` in the same write as the move to QUEUED. Every workstream one recovery run re-queues gets
the same stamp, read once at the start of the run. `queueOrder` (`packages/contracts/src/run-next.ts`) orders
stamped workstreams first with the latest stamp leading, and now breaks a tie on the stamp by start order (creation
time, then id) instead of by the later id. So:

- a recovered workstream launches before every task that had not started, whatever their ages;
- recovered workstreams keep the order they started in among themselves;
- a Run Next press after the restart carries a later stamp and still leads everything, recovered work included;
- a stamp the builder pressed before the restart is passed by recovered work, which was running ahead of it.

The stamp is cleared when the workstream gets its lane, as for a press, so a run queued again later (a usage pause
that ended, a retry) still waits in start order. Recovery stamps only what it re-queues: work it fails, parks on a
card, or finds already QUEUED, HELD or PAUSED_LIMIT is left as it was.

## Why

The stamp is consumed when a workstream first launches, so a restart returned the workstream to the back of the
line behind every older queued task. On 2026-10-30 "Find out why review sessions end without a verdict" was first in
line, launched, and sat behind older tasks after 10db was reinstalled. The queue already has one ordering
mechanism; reusing it needs no migration and the Board's place-in-line numbers follow without a change. A shared
stamp plus the start-order tie-break keeps recovered work from reversing (a stamp per workstream would put the one
recovered last at the front). The tie-break change touches no real case: two presses in one millisecond.
