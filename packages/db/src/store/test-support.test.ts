import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { DB_MIGRATIONS_DIR } from '../database';
import { createTestStore, seedProject } from './test-support';

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function open() {
  const opened = createTestStore();
  closers.push(opened.close);
  return opened.store;
}

const count = (store: ReturnType<typeof open>, table: string): unknown =>
  store.db.$client.prepare(`SELECT count(*) AS n FROM ${table}`).get();

describe('createTestStore', () => {
  it('opens a database with every shipped migration applied, in WAL with foreign keys on', () => {
    // Twice: the second store is the one built from what the first left behind.
    for (const store of [open(), open()]) {
      const shipped = readMigrationFiles({ migrationsFolder: DB_MIGRATIONS_DIR }).length;
      expect(count(store, '__drizzle_migrations')).toEqual({ n: shipped });
      expect(store.db.$client.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(store.db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
    }
  });

  it('gives each store a database of its own, empty however many came before', () => {
    const first = open();
    seedProject(first);
    const second = open();
    expect(count(first, 'projects')).toEqual({ n: 1 });
    expect(count(second, 'projects')).toEqual({ n: 0 });
    seedProject(second);
    seedProject(second);
    expect(count(first, 'projects')).toEqual({ n: 1 });
    expect(second.db.$client.name).not.toBe(first.db.$client.name);
  });
});
