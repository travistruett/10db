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

/** The database's applied migrations disagree with the ones this build ships; it is not opened. */
export class SchemaMismatchError extends Error {
  override readonly name: string = 'SchemaMismatchError';
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.path = path;
  }
}

/**
 * The database was migrated under a schema baseline that has since been regenerated. Until the
 * first published release the baseline is rewritten instead of extended, so the fix is to delete
 * the data directory.
 */
export class StaleSchemaBaselineError extends SchemaMismatchError {
  override readonly name = 'StaleSchemaBaselineError';

  constructor(path: string) {
    super(
      path,
      `${path} was created under an older schema baseline. Stop 10db and delete its data directory; pre-release databases are not migrated.`,
    );
  }
}

/** A newer 10db has migrated the database further than this build knows how to. */
export class NewerSchemaError extends SchemaMismatchError {
  override readonly name = 'NewerSchemaError';

  constructor(path: string) {
    super(
      path,
      `${path} was migrated by a newer version of 10db. Run that version or a later one; this build leaves the database untouched.`,
    );
  }
}

/** A migration left rows that reference a row that does not exist; the schema change is unsafe. */
export class MigrationIntegrityError extends Error {
  override readonly name = 'MigrationIntegrityError';
  readonly violations: number;

  constructor(path: string, violations: number) {
    super(`${path} has ${String(violations)} dangling foreign key reference(s) after migrating.`);
    this.violations = violations;
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
 * database whose applied migrations are not a prefix of the ones this build ships.
 */
export function migrateDatabase(
  db: TendbDatabase,
  migrationsDir: string = DB_MIGRATIONS_DIR,
): void {
  const baseline = readMigrationFiles({ migrationsFolder: migrationsDir }).map((m) => m.hash);
  const applied = appliedHashes(db);
  const shared = Math.min(applied.length, baseline.length);
  if (applied.slice(0, shared).some((hash, i) => hash !== baseline[i])) {
    throw new StaleSchemaBaselineError(db.$client.name);
  }
  if (applied.length > baseline.length) throw new NewerSchemaError(db.$client.name);
  // SQLite rebuilds a table to drop a NOT NULL, and a rebuilt table that others reference can only be
  // dropped with foreign keys off. The pragma is a no-op inside the migration's transaction, so it is
  // switched off around it and restored after.
  const enforced = db.$client.pragma('foreign_keys', { simple: true }) === 1;
  db.$client.pragma('foreign_keys = OFF');
  try {
    migrate(db, { migrationsFolder: migrationsDir });
    // With enforcement off a migration can leave a dangling reference unnoticed, so check them all.
    const violations = db.$client.pragma('foreign_key_check');
    if (Array.isArray(violations) && violations.length > 0) {
      throw new MigrationIntegrityError(db.$client.name, violations.length);
    }
  } finally {
    if (enforced) db.$client.pragma('foreign_keys = ON');
  }
}
