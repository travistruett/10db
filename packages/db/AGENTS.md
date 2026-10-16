# packages/db

Drizzle schema, migrations and (from M1a) repositories over SQLite in WAL mode. The daemon is the
only process that writes the database.

- `src/schema.ts` is the schema. After changing it, run `pnpm --filter @10db/db generate` and commit
  the new file under `drizzle/`. Never edit a generated migration; never delete one. Migrations are
  forward-only. A `drizzle-kit generate --custom` migration (the FTS5 DDL) is authored by hand once
  and never regenerated.
- Every row has a prefixed sortable ID (`tsk_…`) plus `created_at` and `updated_at` as ISO text.
  Settings-style tables keyed by a natural key are the first exception; append-only record tables
  (`events`, `tool_ops`, `evidence`, `handoffs`, `sources`; `created_at` only, none for `events`),
  immutable once written, are the second. Join tables keyed by their two foreign keys (`task_deps`)
  have no ID or timestamps.
- Every state change writes its row and appends its event in one transaction (M1a adds the helper).
- Full-text search lives in one module so the storage engine can change later.
- Tests use a real database file in a temp directory, never `:memory:`, so WAL and file paths are
  exercised.
- The daemon bundle ships its own copy of `drizzle/`; pass its path to `migrateDatabase`.
