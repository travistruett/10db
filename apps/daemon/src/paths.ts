import { existsSync } from 'node:fs';
// Aliased: the bundle's banner declares its own `createRequire`.
import { createRequire as requireFrom } from 'node:module';
import { dirname, join } from 'node:path';
import { DB_MIGRATIONS_DIR } from '@10db/db';
import { HARNESS_PLUGIN_DIR } from '@10db/harness';
import type { DaemonEnv } from './env';
import { defaultDataDir } from './runtime-files';
import type { SandboxRuntime } from './sandbox';

/** All 10db state lives under this one directory (spec §12). */
export function resolveDataDir(env: DaemonEnv): string {
  return env.TENDB_DATA_DIR ?? defaultDataDir();
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

export class SandboxRuntimeError extends Error {
  override readonly name = 'SandboxRuntimeError';
}

/**
 * srt's command-line host, which runs the gate under the sandbox, and the node that runs it, for
 * the daemon module at `moduleFile`. Source runs (tsx, vitest) load it as TypeScript and use the
 * dependency's. The bundle is a single `.mjs` and runs only its own copy beside it: it never looks
 * up a `node_modules`, which from the app's directory could be one a project wrote.
 */
export function sandboxRuntimeFor(moduleFile: string): SandboxRuntime {
  if (moduleFile.endsWith('.ts')) {
    return {
      node: process.execPath,
      cli: requireFrom(moduleFile).resolve('@anthropic-ai/sandbox-runtime/dist/cli.js'),
    };
  }
  const bundled = join(dirname(moduleFile), 'srt.mjs');
  if (!existsSync(bundled)) {
    throw new SandboxRuntimeError(`The daemon bundle has no srt.mjs beside it: ${bundled}`);
  }
  return { node: process.execPath, cli: bundled };
}

/** srt for this daemon: see `sandboxRuntimeFor`. */
export function resolveSandboxRuntime(): SandboxRuntime {
  return sandboxRuntimeFor(import.meta.filename);
}
