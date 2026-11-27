# packages/db

Drizzle schema, migrations and (from M1a) repositories over SQLite in WAL mode. The daemon is the
only process that writes the database.

- `src/schema.ts` is the schema. Never edit a generated migration by hand.
- **Until the first published release (`v0.1.0`), the baseline is regenerated, not extended.** The
  baseline is `0000_init` (generated) plus `0001_decisions_fts` (the hand-written FTS5 DDL, made with
  `drizzle-kit generate --custom` and kept byte for byte). To change the schema: save
  `0001_decisions_fts.sql`, delete `drizzle/`, run `pnpm exec drizzle-kit generate --name init` and
  then `pnpm exec drizzle-kit generate --custom --name decisions_fts` in this package, and put the
  saved SQL back. Nothing migrates an old database: `migrateDatabase` refuses one made under an
  older baseline (`StaleSchemaBaselineError`), the daemon exits with code 3, and the builder deletes
  the data directory by hand.
- **From `v0.1.0` on, migrations are forward-only.** After changing the schema, run
  `pnpm --filter @10db/db generate` and commit the new file under `drizzle/`; never delete or
  regenerate a migration. A `--custom` migration is authored by hand once and never regenerated. A
  database migrated by a newer build is refused with `NewerSchemaError`, never wiped. A migration that drops a NOT NULL is a table rebuild (drizzle-kit writes it); `migrateDatabase` switches `foreign_keys` off around the migrations, because the pragma is a no-op inside their transaction and the rebuild's `DROP TABLE` would otherwise fail on rows that reference the table. It then runs `foreign_key_check` and throws `MigrationIntegrityError` on any dangling reference, since enforcement was off. Migration 0007 rebuilds `projects` (`gate_command` nullable) and `evidence` (`command` and `exit_code` nullable, for builder evidence).
- **A column a rebuild needs comes in an earlier migration.** drizzle-kit's rebuild copies every
  new column from the old table with `INSERT … SELECT`, so it fails on a column added in the same
  step: add the column by `ALTER TABLE` in one generated migration, then rebuild in the next (as
  migrations 0027 and 0028 do).
- **What each store and migration holds** is catalogued by feature in
  `docs/architecture/db-storage.md`. Read the entries for the stores you touch, and add or extend
  one when a migration adds or changes a store.
- Every row has a prefixed UUIDv7 ID (`tsk_<uuidv7>`, sortable by creation) plus `created_at` and
  `updated_at` as ISO text.
  Settings-style tables keyed by a natural key are the first exception; append-only record tables
  (`events`, `tool_ops`, `evidence`, `handoffs`, `sources`; `created_at` only, none for `events`),
  immutable once written, are the second. `events` is the one that is pruned: the nightly run deletes a finished
  task's `session.context` and `session.activity` rows after 14 days (`deleteSessionEventsEndedBefore`,
  `docs/architecture/decisions/2026-11-27-finished-sessions-lose-their-context-and-activity-events-after-14-days.md`). Join tables keyed by their two foreign keys (`task_deps`)
  have no ID or timestamps.
- Every state change writes its row and appends its event in one transaction (M1a adds the helper). `composeKnowledgeText` is an exception: it composes stored Knowledge text at daemon start and appends no event (see Knowledge repositories in `docs/architecture/db-storage.md`).
- Full-text search lives in one module so the storage engine can change later.
- Tests use a real database file in a temp directory, never `:memory:`, so WAL and file paths are
  exercised. `createTestStore` copies a migrated template instead of migrating each store: about 2 ms
  against 27. The template sits in `10db-test-db-templates` under the temp directory, named by a hash
  of the shipped migrations and of `openDatabase` and `migrateDatabase`. It is used only from a real
  directory this user owns that nobody else can write, and each copy is checked for the shipped
  migrations; a damaged template is rebuilt in place, and an unsafe directory or a failed build means each store
  migrates its own. A test of migrating itself opens and migrates its own database, as
  `database.test.ts` does.
- The daemon bundle ships its own copy of `drizzle/`; pass its path to `migrateDatabase`.
- Repositories are synchronous functions over `DbReader` (reads) or `WriteContext` (writes); never open a second connection.
- `board_columns` holds the builder's human columns; `tasks.board_column_id` set means parked (never started: `insertWorkstream` refuses it), null means planned. `moveTask` refuses to park a task that a started dependent waits on.
- `cancelTask` removes a task that never started (status `cancelled`, row kept, decision `2026-10-28-remove-unstarted-task.md`); `listTasks` leaves cancelled tasks out, so a reader of the project's tasks never sees one. A task whose only run is `HELD` is removed too, and `cancelTask` cancels that run in the same write.
- `retireTaskUnconditionally` retires a task and never refuses, for an Abandon, which must finish: status `cancelled`, parked column cleared, Shape questions detached as every retire does, and its `task_deps` edges deleted both ways. An Abandon calls it for each task the pass made (`tasks.made_by_pass_id`, read by `madeByPass`). `removeTaskFromBoard` (the Board's Remove and the builder's `remove_task`) is `cancelTask` that also takes a task with nothing left in it (every run `CANCELLED`, no pass, no saved work), keeping every other refusal: a task not open, an open dependent, a batch being cut.
- `pageActivity` (`src/store/activity.ts`, `decisions/2026-11-17-every-card-has-a-tier.md`) reads `notice.posted`
  rows of `events` newest first by keyset on `seq`, in chunks, and `groupNotices` folds repeats. A task's notice is
  read by `events_entity_idx`; a project's adds its tasks' through `tasks.project_id`. `hasNoticeKey` reads one
  project's notices for a key. No index was added: medians of 20 on 250,000 events, in ms, dense (10,000 notices) and
  sparse (20): first page 2.21 and 24.76, middle page 1.13 and 4.16, one project 4.01 and 0.17, one task 0.19 and
  0.07. A read past 50 ms would need an index, which is a migration.
- A project patch with `areaSplits` (`store/projects.ts`) splits an area in the same write as the new area list:
  it is refused while a claim names the split area, and every open task that names it names each of its parts
  instead, written to `tasks.areas` directly (not through `patchTask`, whose guards would refuse a superset that
  loses no file). A project's `isolate` that names the split area gains its parts.
- Separate copies (`schema.ts` `local_copies`, `store/local-copies.ts`): a batch is a local copy exactly when it has a journal row (`isLocalCopy`), written in the cut's transaction with the pinned teardown command. `copyIdOf` is the one place the id is derived and is stored, never recomputed. `unfinishedCopyOf` is every copy of the project in CUTTING, OPEN, SHIPPING or FAILED, one waiting its turn (journal step `queued`) included, and `copyInProgressOf` is the one-copy-at-a-time rule: the unfinished copy that is not queued, which `queuedCopiesOf` (oldest first) waits for (`decisions/2026-11-25-a-copy-task-waits-for-the-copy-in-progress.md`). A queued copy's CUTTING row has begun no cut, so `queuedCopyBatchIds` keeps it out of `countBatchesInFlight` and out of the Remove refusal for a batch being cut. `isLivePromoting` and a wait's `retryAt` keep a parked landing out of the in-flight count, and `patchProject` refuses a `delivery` change while a copy is unfinished.
