# A notice may keep a record for 10db that no card or drawer shows

- **Date:** 2026-11-04
- **Amends:** `decisions/2026-10-31-notices-not-cards.md` (its `Notice` has a fifth field, `record`, and `fitNotice` treats
  it differently from `line` and `body`)

## Decision

- **`Notice.record`** (`packages/contracts/src/entities.ts`) is an optional string of at most 100,000 characters
  (`NOTICE_RECORD_MAX`). It is what 10db keeps with a notice to read back after a restart, usually JSON: the runs
  GitHub took for a rerun notice and whether 10db is done with the head, the kind of a cancelled notice (`again` or
  `stopped`) and the head it was written for, or the list of migrations a merge renumbered or could not carry over. It
  is stored with the notice, in `workstreams.notice` or `batches.notices`, and travels in the DTOs with it.
- **No card or drawer shows it.** The task's state line and the drawer show the notice's `line` and `body` only, so
  the prose the builder reads has no JSON and no run ids in it. A notice an older daemon stored carried the record at
  the end of its `body`; the daemon still reads one from there (`rerunRecord`), and writes the new notice with the
  record in its own field.
- **`fitNotice` leaves a record that is too long off; it does not cut it.** `line` and `body` are still cut to
  `NOTICE_LINE_MAX` and `NOTICE_BODY_MAX`, ending in an ellipsis (decision `2026-10-31-notices-not-cards.md`, "A notice
  always fits its contract"). A record cut at its limit would no longer parse, or would parse as another record, so a
  record over `NOTICE_RECORD_MAX` is omitted and the notice is stored without one. A record within the limit is kept
  whole, however long the displayed `body` was, and is part of what `setBatchNotice` and `setWorkstreamNotice` compare,
  so a changed record alone rewrites the notice.
- **What a notice with no record reads as depends on the notice.** The rerun and cancelled-check readers treat it as
  an older notice and take the cautious reading: `rerunRecord` gives null, so the head counts as fully asked, and
  `cancelledNoticeHead` gives null, so the notice stays up. The migration notices have no such reading: with its record
  left off, a lost-migrations or renumbered-migrations notice reads as an empty list (`recordIn`). That is not
  cautious: an empty lost list counts as nothing left to re-create, so the notice goes and the gate goes ahead, whatever
  the notice's `body` says, and an empty renumbered list forgets the earlier migrations.

## Why

- The rerun notice stored the runs it had asked GitHub for inside its body, where the builder read them as noise, and
  where `fitNotice` could cut them in the middle, so after a restart 10db forgot what it had asked and could ask again.
  A separate field keeps the body true prose and the state whole.
- Cutting a record to fit is worse than losing it: a half-read record can say something false. Leaving it off gives a
  reader no record instead of a wrong one, though only a reader with a reading for no record can tell the difference;
  the migration notices' `recordIn` cannot, as above.
- Turned down: a new column or table for the records (a notice already has its place, its event and its comparison);
  validating the record in the contract (each kind of notice has its own shape, read by the code that writes it).
