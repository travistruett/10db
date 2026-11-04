# A drain also refuses a claim wait on a lane waiting on a card

- **Date:** 2026-11-04
- **Amends:** `decisions/2026-11-03-a-drain-refuses-a-claim-wait-on-a-parked-holder.md`

## Decision

That record names two holders that run nothing: a task with no live lane in the runner (queued or between
steps) and a lane parked at the start hold (`Runner.isParked`). A third is refused the same way: a lane in
`WAITING_HUMAN` with a live session and no gate process, waiting on a permission or ask card
(`isLaneWaitingOnCard`). The `parked` test that `startDaemon` hands to `ClaimWaits` is therefore: the drain
is on, and the holder has no live lane, or is parked, or is waiting on a card. A `request_claim` wait on such
a holder is answered as that record says: `granted: false, waiting: false`, the holder named, no card, not
recorded under the caller's opId, and the instruction to leave the claim alone and, if the agent can't finish
without it, to commit, call `write_handoff` and end its turn.

A lane that also runs a gate is not refused: the gate is running work, and `isLaneWaitingOnCard` is false for
it. Only a drain refuses; outside one, a wait on a lane waiting on a card goes on waiting as before.

## Why

The earlier record spoke of parked lanes, but this lane is not parked: its session is live. It still runs
nothing. Its agent is blocked on the card, so it frees no claim until the builder answers, and the drain has
stopped counting it as mid-session (`decisions/2026-11-03-app-follows-main-by-itself.md`): the quit ends its
session and recovery parks the lane on the same card. A session waiting in `request_claim` for that lane's
claim would be waiting on something that may not happen before the update installs, and, being a live session
that counts as mid-session, it would hold the update up until the builder answered the card or turned the
switch off. Refusing the wait lets that session end by itself, and the drain no longer waits for it.

Left unrefused, the one case the earlier record's two holders left open would have kept the same hang that
record was written to remove. Releasing the lane's claim was turned down for the reason given there: it
protects the lane's uncommitted work. The behaviour shipped in #500; this record brings the decision in line
with it.
