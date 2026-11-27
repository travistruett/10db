# Task 2: pre-migrate copies are written whole and pruned to 5

Read the index's brief and Global Constraints first. Size: Core (deletes backups).

**Files:** `apps/daemon/src/backups/index.ts`, `apps/daemon/src/backups/backups.test.ts` (extend it),
`apps/daemon/src/daemon/start.ts` (the `DEFAULTS` object and the pre-migrate call after `hasPendingMigrations`), the
nearest `AGENTS.md` with one line on what is kept.

**Implements** (from the index's Interfaces, exactly): `preMigrateBackupsKept: 5` in `DEFAULTS`;
`backupBeforeMigrating`; `pruneBackups`' optional `spare`; `backupDatabase`'s fixed `10db-<label>.partial` and rename.

**State-table rows:** the second table, all rows.

**Notes**

- `start.ts` replaces its `backupDatabase(db, backupsDir, 'pre-migrate', startedAt)` with
  `backupBeforeMigrating(db, backupsDir, startedAt, DEFAULTS.preMigrateBackupsKept)` and logs the count removed when
  it is not zero. The nightly path keeps calling `backupDatabase` and `pruneBackups` as today.
- A failed prune (an `rmSync` error) inside `backupBeforeMigrating` is caught there and doesn't stop the copy or the
  start: a copy that couldn't be deleted is no reason to stay down. A failed copy still throws, as today.
- `spare` is compared by full path; the spared file doesn't count toward `keep`, so 5 others may remain beside it in
  the clock-stepped-back case. That is fine.
- A rename within one directory is atomic on APFS.

**Tests:** extend `backups.test.ts` on its rung (a temp directory, a real SQLite file). One test of
`backupBeforeMigrating`: seed 6 `10db-pre-migrate-*.sqlite` files and 2 `10db-nightly-*.sqlite` files, call it, and
assert the 5 newest pre-migrate names remain (the new copy among them), both nightly ones remain, the new copy opens
as SQLite, and no `.partial` is left. Prove it goes red with the prune removed from `backupBeforeMigrating`. The
commit carries a value card (`why_new=data loss: backups`).

**Spec:** the Fable uptime audit's item B (recorded in the 2026-11-27 hand-off and in #948's report).
