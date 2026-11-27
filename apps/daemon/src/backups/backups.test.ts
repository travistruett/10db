import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DB_MIGRATIONS_DIR, migrateDatabase, openDatabase } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { backupBeforeMigrating, hasPendingMigrations } from './index';

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

  it('keeps the 5 newest pre-migrate copies and every nightly one, and a leftover partial blocks nothing', async () => {
    const backups = join(dir.path, 'backups');
    mkdirSync(backups);
    for (let day = 1; day <= 6; day++) {
      writeFileSync(join(backups, `10db-pre-migrate-2026010${String(day)}T000000.sqlite`), 'x');
    }
    for (const day of [1, 2]) {
      writeFileSync(join(backups, `10db-nightly-2026010${String(day)}T000000.sqlite`), 'x');
    }
    writeFileSync(join(backups, '10db-pre-migrate.partial'), 'not a database');
    const db = openDatabase(join(dir.path, 'db.sqlite'));

    const { file } = await backupBeforeMigrating(db, backups, new Date('2026-02-01T00:00:00Z'), 5);
    db.$client.close();

    const names = readdirSync(backups).sort();
    expect(names.filter((n) => n.startsWith('10db-pre-migrate-'))).toEqual([
      '10db-pre-migrate-20260103T000000.sqlite',
      '10db-pre-migrate-20260104T000000.sqlite',
      '10db-pre-migrate-20260105T000000.sqlite',
      '10db-pre-migrate-20260106T000000.sqlite',
      '10db-pre-migrate-20260201T000000.sqlite',
    ]);
    expect(names.filter((n) => n.startsWith('10db-nightly-'))).toHaveLength(2);
    expect(existsSync(join(backups, '10db-pre-migrate.partial'))).toBe(false);
    const copy = openDatabase(file);
    expect(copy.$client.pragma('integrity_check', { simple: true })).toBe('ok');
    copy.$client.close();
  });
});
