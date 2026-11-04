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
- **Failed minutes** (`failedMinutes`) are the same overlap for a failed run: the time a workstream-failure card (a
  flag with the `WORKSTREAM_FAILED_TITLE_PREFIX` title) was open while the workstream it targets was in `FAILED`,
  from its `workstream.changed` event into `FAILED` to the next change (now, while it is still failed). A run that
  fails at 01:00 and is retried at 08:00 adds 7 hours, however the card closes: Retry, Start and Start over all end
  it. Other cards open on a failed workstream add nothing here. The time also ends when the run can no longer be
  retried, even though the card can stay open: at the `task.changed` event that closes its task, or the `batch.updated`
  event that moves its batch to `SHIPPED`, `CLOSED` or `ABANDONED`. A failure card cancelled before cards kept their
  targets (below) has lost its target, so it adds nothing. The builder decided this on 2026-11-03 (a failed run waiting for
  Retry is waiting on a person) and chose a figure apart from `waitingMinutes`, so each number says one thing:
  `waitingMinutes` stays `WAITING_HUMAN` time only, the panel shows the two as "Waited on an answer" and "Waited on a
  retry", and the two never overlap because a workstream is in one state at a time.
- **A cancelled card keeps its target.** `cancelForWorkstream` leaves `targets` on a card it cancels outright, because
  these figures attribute a card's time through them. A card with other targets still loses the cancelled one and
  stays open.

## Why

The builder was running a SQL query over `inbox_items` each morning. Computing from existing rows and events
needs no migration and cannot drift from them. Whether a card blocked the work is not on the card: the workstream
state history in the event log says it, so waiting time reads both. UTC days match the ISO timestamps the rows
hold; a local-time day would need the builder's zone in the daemon.
