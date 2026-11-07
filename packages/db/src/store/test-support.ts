import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountDto, AccountInput, ProjectDto, ProjectInput } from '@10db/contracts';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { z } from 'zod';
import { DB_MIGRATIONS_DIR, migrateDatabase, openDatabase, type TendbDatabase } from '../database';
import { insertAccount, seedDefaultAccount } from './accounts';
import { insertProject } from './projects';
import { createStore, type Store } from './store';

const TEMPLATE_DIR = '10db-test-db-templates';
/** The template for each temp directory this process has used, or null when that one isn't safe. */
const templates = new Map<string, string | null>();
let shipped: { readonly hashes: readonly string[]; readonly key: string } | undefined;

/**
 * The shipped migrations' hashes, and a key for a template built from them. The key also covers each
 * migration's timestamp and the code that opens and migrates a database, so a change to either
 * builds a new template instead of reusing an old one.
 */
function shippedMigrations(): { readonly hashes: readonly string[]; readonly key: string } {
  if (shipped) return shipped;
  const migrations = readMigrationFiles({ migrationsFolder: DB_MIGRATIONS_DIR });
  const key = createHash('sha256')
    .update(migrations.map((m) => `${m.hash}:${String(m.folderMillis)}`).join('\n'))
    .update(openDatabase.toString())
    .update(migrateDatabase.toString())
    .digest('hex')
    .slice(0, 16);
  shipped = { hashes: migrations.map((m) => m.hash), key };
  return shipped;
}

/**
 * Whether `dir` can hold a template: a real directory this user owns that nobody else can write.
 * On Linux the temp directory is shared, so another user could otherwise create it first or plant a
 * database in it. Anything else, or any error, means no template.
 */
function safeDirectory(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    return stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

/**
 * A database file with every shipped migration applied, built once and copied for each store:
 * migrating took about 27 ms per store, and a copy takes about 2. A worker builds it under a name of
 * its own and renames it into place, so another worker never copies a half-written file. Null when
 * the directory isn't safe, and each store then migrates its own.
 */
function migratedTemplate(): string | null {
  const temp = tmpdir();
  const known = templates.get(temp);
  if (known !== undefined) return known;
  const dir = join(temp, TEMPLATE_DIR);
  const path = safeDirectory(dir) ? join(dir, `${shippedMigrations().key}.sqlite`) : null;
  templates.set(temp, path);
  if (path === null || existsSync(path)) return path;
  const building = `${path}.${String(process.pid)}.${randomUUID()}`;
  const db = openDatabase(building);
  try {
    migrateDatabase(db);
    // Closing the only connection folds the WAL into the file, so the file alone holds it all.
    db.$client.close();
    renameSync(building, path);
  } finally {
    if (db.$client.open) db.$client.close();
    for (const leftover of [building, `${building}-wal`, `${building}-shm`]) {
      rmSync(leftover, { force: true });
    }
  }
  return path;
}

const AppliedHash = z.object({ hash: z.string() });

/** Whether `db` holds exactly the shipped migrations; a copy of a damaged template doesn't. */
function holdsShippedMigrations(db: TendbDatabase): boolean {
  try {
    const applied = db.$client
      .prepare('SELECT hash FROM __drizzle_migrations ORDER BY rowid')
      .all()
      .map((row) => AppliedHash.parse(row).hash);
    const { hashes } = shippedMigrations();
    return applied.length === hashes.length && applied.every((hash, i) => hash === hashes[i]);
  } catch {
    return false;
  }
}

/** A migrated database at `path`: a copy of the template when it holds the shipped migrations. */
function openMigrated(path: string): TendbDatabase {
  const template = migratedTemplate();
  if (template !== null) {
    copyFileSync(template, path);
    const copy = openDatabase(path);
    if (holdsShippedMigrations(copy)) return copy;
    // A damaged template: drop it so the next store builds a new one, and migrate this store afresh.
    copy.$client.close();
    rmSync(template, { force: true });
    templates.delete(tmpdir());
    for (const file of [path, `${path}-wal`, `${path}-shm`]) rmSync(file, { force: true });
  }
  const db = openDatabase(path);
  migrateDatabase(db);
  return db;
}

// `close` is a property, not a method, so tests can destructure it (typescript-eslint `unbound-method`).
export function createTestStore(clock?: () => Date): { store: Store; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), '10db-store-'));
  const db = openMigrated(join(dir, 'db.sqlite'));
  return {
    store: createStore(db, clock),
    close: () => {
      db.$client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The email the default test account is confirmed for; the fake adapter reports what each session expects. */
export const TEST_ACCOUNT_EMAIL = 'builder@example.com';

export function seedProject(store: Store, overrides: Partial<ProjectInput> = {}): ProjectDto {
  return store.write((ctx) => {
    seedDefaultAccount(ctx, { expectedIdentity: TEST_ACCOUNT_EMAIL });
    return insertProject(ctx, {
      name: 'demo',
      repoPath: `/tmp/demo-${Math.random().toString(36).slice(2)}`,
      gateCommand: 'true',
      areas: [
        { name: 'api', globs: ['src/api/**'] },
        { name: 'ui', globs: ['src/ui/**'] },
      ],
      ...overrides,
    });
  }).value;
}

/** An account for a test; its config directory is a path no test creates. */
export function seedAccount(store: Store, input: AccountInput): AccountDto {
  return store.write((ctx) =>
    insertAccount(ctx, input, { configDirFor: (id) => `/tmp/10db-test-accounts/${id}/claude` }),
  ).value;
}
