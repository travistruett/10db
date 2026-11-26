# A run waiting its turn behind live work is not stuck

- **Date:** 2026-11-26
- **Amends:** decisions/2026-11-25-queue-waits-live-in-the-scheduler.md

## Decision

A claim wait or a dependency wait that can still end no longer counts toward a Stuck card by time: both join
`UNCOUNTED_WAITS`. A wait that can never end (`endless`) still counts at once, whatever its kind, and the Retry
Dependency answer on a failed dependency is unchanged. A Stuck card already open for such a wait closes on the
next sweep, because the sweep closes every `stall_cleared` card whose stall it no longer finds. The sweep runs
in the daemon, so this holds on every provider.

## Why

A run queued behind another live task that held its area raised a high "Stuck" card after 15 minutes, and the
clock restarted each time the holder changed, so one run raised and closed several cards over hours. Waiting
one's turn behind live work is not stuck, and the card gave the builder nothing to do. The Board's Waiting line
already shows the wait. A holder that stops making progress is caught by the 20-minute active-idle rule on the
holder itself.
