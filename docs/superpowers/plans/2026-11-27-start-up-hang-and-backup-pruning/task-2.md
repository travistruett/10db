# Task 2: pre-migrate copies are written whole and pruned to 5

Read the index's brief and Global Constraints first. Size: Core (deletes backups).

**Files:** `apps/daemon/src/backups/index.ts`, `apps/daemon/src/daemon/start.ts` (the `DEFAULTS` object and the
pre-migrate call near `hasPendingMigrations`), a new `apps/daemon/src/backups/index.test.ts` (or the module's
existing test file if one appears), the nearest `AGENTS.md` with one line on what is kept.

**Implements** (from the index's Interfaces, exactly): `preMigrateBackupsKept: 5` in `DEFAULTS`;
`backupDatabase` writes `<file>.partial`, then renames it to `<file>`.

**State-table rows:** the second table, all rows.

**Notes**

- In `start.ts`, prune right after the pre-migrate copy resolves and before `migrateDatabase`:
  `pruneBackups(backupsDir, 'pre-migrate', DEFAULTS.preMigrateBackupsKept)`. Log the count removed when it is not
  zero. A failed prune (an `rmSync` error) is logged and the start goes on: a copy we couldn't delete is not a
  reason to stay down.
- The new copy is the newest, so it is always among the 5 kept.
- `.partial` files never match `pruneBackups`' filter (it needs `.sqlite` at the end), so they're never counted
  or deleted by it. Leave them; a stray one is rare and the builder can see it. Do not add a sweep.
- A rename within one directory is atomic on APFS.
- The nightly path keeps working unchanged: it calls the same `backupDatabase`.

**Tests:** one test on the cheapest rung that's real: a temp directory and a real SQLite file. Seed 6
`10db-pre-migrate-*.sqlite` files and 2 `10db-nightly-*.sqlite` files, take one pre-migrate copy and prune as
`start.ts` does, and assert the 5 newest pre-migrate names remain, both nightly ones remain, and no `.partial` is
left. If driving `startDaemon` with a pending migration is cheap with the existing test helpers, go through it
instead, so the wiring is covered. Prove it goes red without the prune. The commit carries a value card
(`why_new=data loss: backups`).

**Spec:** the Fable uptime audit's item B (recorded in the 2026-11-27 hand-off and in #948's report).
