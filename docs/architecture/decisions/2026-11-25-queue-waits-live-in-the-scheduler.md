# What a queued run waits for lives in the scheduler's memory, and a sweep raises one Stuck card per stall

- **Date:** 2026-11-25

## Decision

Each scheduler tick records, for every QUEUED run it passes over, what it waits for: a `QueueWait`
(`packages/contracts/src/queue-wait.ts`) with its kind, a plain-words line, whether it can never end by itself
(`endless`), the run or task it waits on, and since when. The store is `createQueueWaits`
(`apps/daemon/src/scheduler/queue-waits.ts`): in memory, never in a table, so the change needs no migration.
`since` holds while the kind, what it waits on and `endless` stay the same. A tick emits one
`workstream.wait_changed` per run whose wait changed, in one write at its end, and `GET /workstreams` adds
`wait` to each run. The Board's queued line says `Waiting …` when the run has no notice, in orange when the
wait is endless.

A wait is endless when a dependency was cancelled or its latest run failed, when a dependency waits to land in
the run's own copy (that copy lands only once the run is done), when a claim it needs is held by a finished
run, or when its batch is failed, abandoned, shipped or closed.

A sweep (`apps/daemon/src/stalls/`) runs every minute on the injected clock and raises one condition card,
`Stuck: <task or batch>`, per stall, folded by `stuck:run:<id>` or `stuck:batch:<id>`, closed by the
`stall_cleared` event closer once the sweep no longer finds it. It counts a queued wait at once when endless,
else after 15 minutes unless its kind is one `UNCOUNTED_WAITS` leaves out; an active run idle for 20 minutes;
an open batch whose every unfinished member is a stuck queued run (one batch card in place of theirs); and a
batch shipping or cutting for 60 minutes. The thresholds are `STALL` in `stalls/thresholds.ts`. The sweep
writes only cards: the card's answers cancel, retry or abandon, never the sweep.

## Why

The 2026-11-25 copy deadlock left a batch OPEN with six of seven tasks done and the seventh queued for good,
and nothing said so. The scheduler already decides why a run waits at every tick; recording it there, in one
place, gives every queued run a reason without a second reading of the same rules.

Memory, not a column: the wait is recomputed at every tick, so a stored one would only be a cache with a
migration and a write per tick. After a restart the first tick finds every wait again; until then a run with no
wait is skipped by the sweep and its card kept, and the card's own `since` carries the count across the
restart.

The tests sit on the scheduler's wait recording and on the sweep's rule table (`stalls/rules.test.ts`), the two
places where a wrong reason or a missed stall would leave work stuck without a word.

A condition card, not a notice, because a stall needs the builder to choose a way out, and only once per stall.
The left-out kinds (lane, account, the Mac's load, checkout, a pass, parked, a copy being made) each have their
own card or status line already, or are the builder's own choice.
