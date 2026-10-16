import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DB_MIGRATIONS_DIR, migrateDatabase, openDatabase } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { ManualClock } from '../clock';
import {
  backupDatabase,
  hasPendingMigrations,
  msUntilNextHour,
  pruneBackups,
  scheduleNightlyBackup,
} from './index';

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

  it('writes an openable backup', async () => {
    const db = openDatabase(join(dir.path, 'db.sqlite'));
    migrateDatabase(db);
    const file = await backupDatabase(
      db,
      join(dir.path, 'backups'),
      'nightly',
      new Date('2026-10-13T03:00:00.000Z'),
    );
    const copy = openDatabase(file);
    expect(
      copy.$client.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'projects'").get(),
    ).toEqual({ n: 1 });
    copy.$client.close();
    db.$client.close();
  });

  it('keeps only the newest backups for a label', () => {
    for (const day of ['20261001', '20261002', '20261003'])
      writeFileSync(join(dir.path, `10db-nightly-${day}T030000.sqlite`), '');
    const removed = pruneBackups(dir.path, 'nightly', 2);
    expect(removed.map((f) => f.split('/').at(-1))).toEqual([
      '10db-nightly-20261001T030000.sqlite',
    ]);
    expect(readdirSync(dir.path).filter((f) => f.startsWith('10db-nightly'))).toHaveLength(2);
  });

  it.each([
    ['before the hour', '2026-10-13T01:30:00', 90 * 60_000],
    ['after the hour', '2026-10-13T04:00:00', 23 * 3_600_000],
  ])('waits until the next 03:00 local time %s', (_name, local, ms) => {
    expect(msUntilNextHour(new Date(local), 3)).toBe(ms);
  });

  it('reports a failed nightly backup and keeps the schedule', async () => {
    const clock = new ManualClock(new Date('2026-10-13T01:00:00'));
    const errors: unknown[] = [];
    const nightly = scheduleNightlyBackup(
      clock,
      () => Promise.reject(new Error('disk full')),
      3,
      (error) => {
        errors.push(error);
      },
    );
    clock.advance(2 * 3_600_000);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(errors).toHaveLength(1);
    expect(clock.pendingTimers()).toBe(1);
    nightly.cancel();
  });
});
