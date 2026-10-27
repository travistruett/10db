import { existsSync } from 'node:fs';
// Aliased: the bundle's banner declares its own `createRequire`.
import { createRequire as requireFrom } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DB_MIGRATIONS_DIR } from '@10db/db';
import { HARNESS_PLUGIN_DIR } from '@10db/harness';
import type { DaemonEnv } from './env';
import type { SandboxRuntime } from './sandbox';

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

/** The bundle carries the harness plugin beside itself; from source, use the harness package's folder. */
export function resolveHarnessDir(): string {
  const bundled = join(import.meta.dirname, 'harness');
  return existsSync(bundled) ? bundled : HARNESS_PLUGIN_DIR;
}

/**
 * srt's command-line host, which runs the gate under the sandbox, and the node that runs it: the
 * bundle's own copy beside it, else the dependency's (source runs).
 */
export function resolveSandboxRuntime(): SandboxRuntime {
  const bundled = join(import.meta.dirname, 'srt.mjs');
  return {
    node: process.execPath,
    cli: existsSync(bundled)
      ? bundled
      : requireFrom(import.meta.url).resolve('@anthropic-ai/sandbox-runtime/dist/cli.js'),
  };
}
