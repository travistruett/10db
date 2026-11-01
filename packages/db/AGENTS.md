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
- Every row has a prefixed UUIDv7 ID (`tsk_<uuidv7>`, sortable by creation) plus `created_at` and
  `updated_at` as ISO text.
  Settings-style tables keyed by a natural key are the first exception; append-only record tables
  (`events`, `tool_ops`, `evidence`, `handoffs`, `sources`; `created_at` only, none for `events`),
  immutable once written, are the second. Join tables keyed by their two foreign keys (`task_deps`)
  have no ID or timestamps.
- Every state change writes its row and appends its event in one transaction (M1a adds the helper).
- Full-text search lives in one module so the storage engine can change later.
- Tests use a real database file in a temp directory, never `:memory:`, so WAL and file paths are
  exercised.
- The daemon bundle ships its own copy of `drizzle/`; pass its path to `migrateDatabase`.
- Repositories are synchronous functions over `DbReader` (reads) or `WriteContext` (writes); never open a second connection.
- `board_columns` holds the builder's human columns; `tasks.board_column_id` set means parked (never started: `insertWorkstream` refuses it), null means planned. `moveTask` refuses to park a task that a started dependent waits on.
- `cancelTask` removes a task that never started (status `cancelled`, row kept, decision `2026-10-28-remove-unstarted-task.md`); `listTasks` leaves cancelled tasks out, so a reader of the project's tasks never sees one. A task whose only run is `HELD` is removed too, and `cancelTask` cancels that run in the same write.
- Goals (`store/goals.ts`, goals spec §4, §5, §8, phase 1; migration 0015): `insertGoal` writes a `draft` goal, its tasks (`tasks.goal_id`), their `task_deps` and its `unproven` `goal_criteria` in the caller's transaction, turning brief keys into the TaskIds it makes; a repeated or unknown key, a dependency cycle, an unknown area or person throws, so nothing is left behind. The owner defaults to the builder (handle `me`). `markGoalViewed` upserts `goal_views` and answers the previous mark, the digest's window.
- `holdTask` and `resumeTask` (`store/holds.ts`) move a task's `QUEUED` run that has not run to `HELD` and back (decision `2026-10-29-hold-a-queued-task.md`). `HELD` is non-terminal and derives the Blocked board status.
