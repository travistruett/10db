import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { z } from 'zod';
import * as schema from './schema';

export type TendbDatabase = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/** Migrations shipped with this package; a bundled daemon passes its own copy instead. */
export const DB_MIGRATIONS_DIR = resolve(import.meta.dirname, '../drizzle');

/**
 * Opens (creating if needed) the database file with the pragmas every connection needs.
 * `nativeBinding` points at `better_sqlite3.node` when the daemon runs from a bundle with no node_modules.
 */
export function openDatabase(
  path: string,
  opts: { readonly nativeBinding?: string } = {},
): TendbDatabase {
  const client = new Database(
    path,
    opts.nativeBinding ? { nativeBinding: opts.nativeBinding } : {},
  );
  client.pragma('journal_mode = WAL');
  client.pragma('foreign_keys = ON');
  client.pragma('busy_timeout = 5000');
  client.pragma('synchronous = NORMAL');
  return drizzle({ client, schema });
}

/**
 * The database was migrated under a schema baseline that has since been regenerated. Until the
 * first published release the baseline is rewritten instead of extended, so the fix is to delete
 * the data directory.
 */
export class StaleSchemaBaselineError extends Error {
  override readonly name = 'StaleSchemaBaselineError';
  readonly path: string;

  constructor(path: string) {
    super(
      `${path} was created under an older schema baseline. Stop 10db and delete its data directory; pre-release databases are not migrated.`,
    );
    this.path = path;
  }
}

const AppliedMigration = z.object({ hash: z.string() });

// Drizzle declares `id SERIAL`, which SQLite leaves NULL, so insertion order is the rowid.
function appliedHashes(db: TendbDatabase): string[] {
  const table = db.$client
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
    .get();
  if (table === undefined) return [];
  return db.$client
    .prepare('SELECT hash FROM __drizzle_migrations ORDER BY rowid')
    .all()
    .map((row) => AppliedMigration.parse(row).hash);
}

/**
 * Applies pending migrations, all in one transaction: either every one lands or none. Refuses a
 * database whose applied migrations are not a prefix of this baseline.
 */
export function migrateDatabase(
  db: TendbDatabase,
  migrationsDir: string = DB_MIGRATIONS_DIR,
): void {
  const baseline = readMigrationFiles({ migrationsFolder: migrationsDir }).map((m) => m.hash);
  const applied = appliedHashes(db);
  if (applied.length > baseline.length || applied.some((hash, i) => hash !== baseline[i])) {
    throw new StaleSchemaBaselineError(db.$client.name);
  }
  migrate(db, { migrationsFolder: migrationsDir });
}
