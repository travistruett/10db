# A drain refuses a claim wait on a parked holder, so the waiting session ends by itself

- **Date:** 2026-11-03
- **Amends:** `decisions/2026-11-03-app-follows-main-by-itself.md`

## Decision

While an update drains the factory, a `request_claim` wait whose holder runs nothing is answered with a
refusal instead of going on waiting. A holder runs nothing when the runner has no live lane for it (a queued
or between-steps task) or its lane waits at the start hold before its next session or its gate
(`Runner.isParked`). The refusal is `granted: false, waiting: false`, names the holder, raises no card and
tells the agent to leave the claim alone and, if it can't finish without the claim, to commit, call
`write_handoff` and end its turn. `ClaimWaits` takes the test as its `parked` option, and `startDaemon` wires
it to the drain and the runner. Each look of a wait asks it, so a wait that began before the drain ends within
one poll (2 s) of the drain parking its holder.

The handoff matters: a turn that ends without one finishes the step, so unfinished work would go to the gate.
A recorded handoff starts a fresh session of the same step instead, which waits at the start hold, so the
drain still finishes and that session asks again after the update.

The refusal is not recorded under the caller's opId, unlike a yield refusal. It says how things stand now, so
a later call with the same opId asks again, like a "still waiting" answer.

No running session is stopped by this. The session ends because its agent obeys the instruction, and the
update installs when it has.

## Why

A parked lane keeps its claims and starts nothing until the update installs. A session waiting for one of
those claims therefore never ends, `midSession` never reaches 0, and the update waits for a switch-off by the
builder: the drain turned a wait that always ended (the load hold) into a hang. Killing the waiting session
was turned down (the drain stops nothing that runs), as was subtracting waiting sessions from `midSession`
(the quit would cut off a live session). Releasing the parked lane's claim was turned down too: the claim
protects its uncommitted work. A refusal on the existing request_claim path costs the agent one answer and
keeps the claim rules as they are.

An agent that ignores the instruction keeps its session running, and nothing bounds that: the update's wait
limit only starts the drain. Only the builder turning the switch off ends the wait then.
