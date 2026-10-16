import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DB_MIGRATIONS_DIR } from '@10db/db';
import type { DaemonEnv } from './env';

/** All 10db state lives under this one directory (spec §12). */
export function resolveDataDir(env: DaemonEnv): string {
  return env.TENDB_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', '10db');
}

/** The bundle carries migrations beside itself; from source, use the db package's folder. */
export function resolveMigrationsDir(): string {
  const bundled = join(import.meta.dirname, 'drizzle');
  return existsSync(bundled) ? bundled : DB_MIGRATIONS_DIR;
}

/** The SQLite addon: an explicit path, else the bundle's own copy, else node_modules (source runs). */
export function resolveSqliteBinding(env: DaemonEnv): string | undefined {
  if (env.TENDB_SQLITE_BINDING) return env.TENDB_SQLITE_BINDING;
  const bundled = join(import.meta.dirname, 'better_sqlite3.node');
  return existsSync(bundled) ? bundled : undefined;
}
