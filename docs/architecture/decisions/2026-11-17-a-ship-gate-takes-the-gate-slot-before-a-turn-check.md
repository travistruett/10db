# A ship gate takes the gate slot before a waiting turn check, and a running check is not stopped for it

- **Date:** 2026-11-17
- **Amends:** `decisions/2026-11-10-the-per-turn-check-is-advice-in-the-one-gate-slot.md`

## Decision

- The check after a Workbench turn waits for a gate slot at advice priority (`GatePriority.Advice`, through
  its own `limitGates` wrapper over the shared slots, with the same load hold as the shipping gates). When a
  slot frees, every waiting gate that decides whether work lands (a batch's ship gate, a pass's gate, a lane's
  step check and verify gate) is served before any waiting turn check, whichever asked first. Within each
  kind the order is the order they asked.
- A turn check that waited behind a ship gate still runs once no such gate waits, and its result is written
  and shown as before.
- A turn check that is already running is **not** stopped for a waiting ship gate.

## Why

The check is advice and a ship gate decides whether work lands, so the advice must not delay the decision
because it happened to ask first. Stopping a running check was turned down: it is capped at 10 minutes, it
holds the slot only once it has begun, a stopped check's work is lost and would have to run again (the
coalescing queue would re-run it at once, looping against a busy ship queue), and a killed check would give
the builder no result at all, where a delayed one gives the true one. The wait a ship gate can still meet is
bounded by that cap. Killing it can be added later if ship gates are seen waiting out checks.
