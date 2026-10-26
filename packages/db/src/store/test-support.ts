import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountDto, AccountInput, ProjectDto, ProjectInput } from '@10db/contracts';
import { migrateDatabase, openDatabase } from '../database';
import { insertAccount, seedDefaultAccount } from './accounts';
import { insertProject } from './projects';
import { createStore, type Store } from './store';

// `close` is a property, not a method, so tests can destructure it (typescript-eslint `unbound-method`).
export function createTestStore(clock?: () => Date): { store: Store; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), '10db-store-'));
  const db = openDatabase(join(dir, 'db.sqlite'));
  migrateDatabase(db);
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
