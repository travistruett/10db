import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

export type TendbDatabase = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/** Migrations shipped with this package; a bundled daemon passes its own copy instead. */
export const DB_MIGRATIONS_DIR = resolve(import.meta.dirname, '../drizzle');

/** Opens (creating if needed) the database file with the pragmas every connection needs. */
export function openDatabase(path: string): TendbDatabase {
  const client = new Database(path);
  client.pragma('journal_mode = WAL');
  client.pragma('foreign_keys = ON');
  client.pragma('busy_timeout = 5000');
  client.pragma('synchronous = NORMAL');
  return drizzle({ client, schema });
}

/** Applies pending forward-only migrations, all in one transaction: either every one lands or none. */
export function migrateDatabase(
  db: TendbDatabase,
  migrationsDir: string = DB_MIGRATIONS_DIR,
): void {
  migrate(db, { migrationsFolder: migrationsDir });
}
