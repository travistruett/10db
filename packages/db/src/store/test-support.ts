import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
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
import { DB_MIGRATIONS_DIR, migrateDatabase, openDatabase } from '../database';
import { insertAccount, seedDefaultAccount } from './accounts';
import { insertProject } from './projects';
import { createStore, type Store } from './store';

const TEMPLATE_DIR = join(tmpdir(), '10db-test-db-templates');
let templatePath: string | null | undefined;

/**
 * Whether the template directory can be trusted: a real directory this user owns that nobody else
 * can write. On Linux `tmpdir()` is shared, so another user could otherwise create it first or plant
 * a database in it. A directory of this user's that is too open is closed up.
 */
function ownTemplateDir(): boolean {
  mkdirSync(TEMPLATE_DIR, { recursive: true, mode: 0o700 });
  const stat = lstatSync(TEMPLATE_DIR);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.()) return false;
  if ((stat.mode & 0o077) !== 0) chmodSync(TEMPLATE_DIR, 0o700);
  return true;
}

/**
 * A database file with every shipped migration applied, which each test store copies: migrating
 * took about 25 ms per store, and a copy takes under 2. It is named by the migrations it holds, so
 * a worktree on another schema never reads it, and it outlives the run for the next one. A worker
 * builds it under a name of its own and renames it into place, so a concurrent worker never copies
 * a half-written file. Null when the directory can't be trusted: each store then migrates its own.
 */
function migratedTemplate(): string | null {
  if (templatePath === undefined && !ownTemplateDir()) templatePath = null;
  if (templatePath === null) return null;
  templatePath ??= join(
    TEMPLATE_DIR,
    `${createHash('sha256')
      .update(
        readMigrationFiles({ migrationsFolder: DB_MIGRATIONS_DIR })
          .map((migration) => migration.hash)
          .join('\n'),
      )
      .digest('hex')
      .slice(0, 16)}.sqlite`,
  );
  if (existsSync(templatePath)) return templatePath;
  const building = `${templatePath}.${String(process.pid)}.${randomUUID()}`;
  const db = openDatabase(building);
  migrateDatabase(db);
  // Closing the only connection folds the WAL into the file, so the file alone holds the migrations.
  db.$client.close();
  renameSync(building, templatePath);
  return templatePath;
}

// `close` is a property, not a method, so tests can destructure it (typescript-eslint `unbound-method`).
export function createTestStore(clock?: () => Date): { store: Store; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), '10db-store-'));
  const path = join(dir, 'db.sqlite');
  const template = migratedTemplate();
  if (template !== null) copyFileSync(template, path);
  const db = openDatabase(path);
  if (template === null) migrateDatabase(db);
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
