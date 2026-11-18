import { join } from 'node:path';
import { DB_MIGRATIONS_DIR, migrateDatabase, openDatabase } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { hasPendingMigrations } from './index';

let dir: { path: string; cleanup(): void };
beforeEach(() => {
  dir = tempDir('backups');
});
afterEach(() => {
  dir.cleanup();
});

describe('backups', () => {
  it('detects pending migrations before and not after migrating', () => {
    const db = openDatabase(join(dir.path, 'db.sqlite'));
    expect(hasPendingMigrations(db, DB_MIGRATIONS_DIR)).toBe(true);
    migrateDatabase(db);
    expect(hasPendingMigrations(db, DB_MIGRATIONS_DIR)).toBe(false);
    db.$client.close();
  });
});
