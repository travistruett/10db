# The human-touch panel is computed on read from inbox rows and the event log

- **Date:** 2026-11-03

## Decision

`GET /projects/:projectId/human-touch` answers `HumanTouchDto` (`packages/contracts/src/human-touch.ts`): the
project's last 14 UTC days, today first. `humanTouchDays` in `packages/db` computes it on each read; nothing is
stored. For each day:

- **Cards by kind** are that day's `inbox_items` rows grouped by `kind`, by `created_at`. A flag whose title starts
  with `WORKSTREAM_FAILED_TITLE_PREFIX` (the title the runner and recovery give a failure card) counts as
  `workstreamFailed`, every other flag as `flag`. `review` and `check` cards have their own columns, so `cards`
  is the day's row count.
- **Cards per task** is `cards` over the tasks with a session running at some point of that day; null when none.
- **Waiting minutes** are the time a card was open while a workstream it targets was in `WAITING_HUMAN`. A card
  is open from `created_at` to its first `inbox.changed` event whose state is not `OPEN` (now, while it is
  open); a workstream is blocked from a `workstream.changed` event into `WAITING_HUMAN` to the next change. The
  overlap is cut at UTC midnight and added to each day. Cards open together on one workstream count once. A card
  answered while the task stayed `RUNNING` overlaps no blocked time and adds nothing.

## Why

The builder was running a SQL query over `inbox_items` each morning. Computing from existing rows and events
needs no migration and cannot drift from them. Whether a card blocked the work is not on the card: the workstream
state history in the event log says it, so waiting time reads both. UTC days match the ISO timestamps the rows
hold; a local-time day would need the builder's zone in the daemon.
