# A drain refuses a claim wait on a parked holder, so the waiting session ends by itself

- **Date:** 2026-11-03
- **Amends:** `decisions/2026-11-03-app-follows-main-by-itself.md`

## Decision

While an update drains the factory, a `request_claim` wait whose holder runs nothing is answered with a
refusal instead of going on waiting. A holder runs nothing when the runner has no live lane for it (a queued
or between-steps task) or its lane waits at the start hold before its next session or its gate
(`Runner.isParked`). The refusal is `granted: false, waiting: false`, names the holder, raises no card and
tells the agent to leave the claim alone, commit and end its turn; the task asks again in its next session
after the update. `ClaimWaits` takes the test as its `parked` option, and `startDaemon` wires it to the drain
and the runner. Each look of a wait asks it, so a wait that began before the drain ends within one poll
(2 s) of the drain parking its holder.

No running session is stopped by this. The session ends because its agent obeys the instruction, and the
update installs when it has.

## Why

A parked lane keeps its claims and starts nothing until the update installs. A session waiting for one of
those claims therefore never ends, `midSession` never reaches 0, and the update waits for a switch-off by the
builder: the drain turned a wait that always ended (the load hold) into a hang. Killing the waiting session
was turned down (the drain stops nothing that runs), as was subtracting waiting sessions from `midSession`
(the quit would cut off a live session). Releasing the parked lane's claim was turned down too: the claim
protects its uncommitted work. A refusal on the existing request_claim path costs the agent one answer and
keeps the claim rules as they are; an agent that ignores it keeps its session running, and the update's
wait limit (the builder's switch) still applies.
