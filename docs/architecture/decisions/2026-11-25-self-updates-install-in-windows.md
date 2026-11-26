# Self-updates install in windows, and a drain is capped

- **Date:** 2026-11-25
- **Amends:** `2026-11-03-app-follows-main-by-itself.md`

## Decision

- With nothing running (no lane, gate or ship), a staged update installs at once, as before.
- With work running, the factory is not drained for an update until the builder's wait limit has run from
  staging and 90 minutes (`UPDATE_WINDOW_MS`) have run since the last install, so the merges of that window
  come in one install. A newer build that arrives meanwhile replaces the staged one. Install Now skips the
  window. The last install's time is stored (`self_update.installed_at`) when startup settles an install that
  took; with none stored there is no window.
- A drain a running gate has held for 30 minutes (`DRAIN_HOLD_CAP_MS`) is released: lanes and gates start
  again, and the update tries once more at the next quiet moment or a window after the release.
- While an update waits for its window, the status line says so and until when. The log records each wait's
  length: `waitedMs` when the drain starts and when the install starts, `drainedMs` at the install, `heldMs`
  when a drain ends.

## Why

On 2026-11-25 the app installed 21 times, and at least nine of them drained first, holding new lanes for 16 to
45 minutes each, while a gate (which the install never goes over, up to its own timeout) ran. Each install also
restarts the daemon. Batching the merges of 90 minutes into one install cuts both costs and keeps the app
following main by itself. Only the gate wait can outlast the drain limit, so the cap bounds exactly the long
holds. Turned down: a longer wait limit setting alone (it does not count from the last install, so back-to-back
merges would still install back to back), and installing over a running gate (a restart starts its suite over).
