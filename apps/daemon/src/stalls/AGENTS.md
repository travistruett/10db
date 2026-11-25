# apps/daemon/src/stalls

The watchdog (`decisions/2026-11-25-queue-waits-live-in-the-scheduler.md`).

- `thresholds.ts` holds every threshold (`STALL`) and the queued waits that never count by time
  (`UNCOUNTED_WAITS`). Change them there only.
- `rules.ts` is pure: `findStalls` reads the queued runs with their waits, the active runs, the open, shipping
  and cutting batches with the latest run of each of their tasks, and the `since` of each open card. A batch
  stall replaces its members' run stalls. Its test is the rule table.
- `sweep.ts` reads the active projects every minute (`STALL.sweepMs`, on the injected clock) and writes only
  Stuck cards: one `flagCard` refresh per stall whose card is missing or says something else
  (`fingerprint`), then `resolveStaleCards` for the `stall_cleared` cards whose stall is gone. A queued run with
  no wait yet (the first tick after a start has not run) is skipped, and its card, and its batch's, kept.
- `card.ts` builds the card (Ask, high, a condition card folded by its key) and its answers. The body names the time
  the item stopped ("since …", in the Mac's own time), never a duration: the card is rewritten only when its
  fingerprint changes, so a duration would go stale. The answers act;
  the sweep never cancels, retries or abandons.
