import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase, openDatabase, schema, type TendbDatabase } from './index';

let dir: string;
let db: TendbDatabase;

beforeEach(() => {
  // A space in the path mirrors ~/Library/Application Support/10db.
  dir = mkdtempSync(join(tmpdir(), '10db db test '));
  db = openDatabase(join(dir, '10db.sqlite'));
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('openDatabase', () => {
  it('uses WAL and enforces foreign keys', () => {
    expect(db.$client.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('has FTS5 compiled in', () => {
    const row = db.$client
      .prepare("SELECT 1 AS ok FROM pragma_compile_options WHERE compile_options = 'ENABLE_FTS5'")
      .get();
    expect(row).toEqual({ ok: 1 });
  });
});

describe('migrateDatabase', () => {
  it('creates app_settings and round-trips a JSON value', () => {
    migrateDatabase(db);
    db.insert(schema.appSettings)
      .values({
        key: 'keepAwake',
        value: { mode: 'while-running' },
        updatedAt: '2026-10-13T12:00:00.000Z',
      })
      .run();
    const row = db
      .select()
      .from(schema.appSettings)
      .where(eq(schema.appSettings.key, 'keepAwake'))
      .get();
    expect(row?.value).toEqual({ mode: 'while-running' });
  });

  it('is idempotent', () => {
    migrateDatabase(db);
    expect(() => {
      migrateDatabase(db);
    }).not.toThrow();
  });
});
