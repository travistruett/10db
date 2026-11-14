import { z } from 'zod';
import type { TendbDatabase } from './database';

/** The app setting the move to the playbook recorded when it ran. */
const MOVED_SETTING = 'playbook.moved';

/** Tables that held routing settings before the playbook. */
const OLD_TABLES = ['flows', 'patterns', 'role_settings', 'team_bindings'] as const;

/** Columns of kept tables that held routing settings, with the SQL that says a row carries one. */
const OLD_COLUMNS = [
  {
    table: 'tasks',
    column: 'risk_tags',
    set: "risk_tags IS NOT NULL AND risk_tags NOT IN ('', '[]')",
  },
  { table: 'tasks', column: 'flow_id', set: 'flow_id IS NOT NULL' },
  { table: 'projects', column: 'flow_id', set: 'flow_id IS NOT NULL' },
  { table: 'personas', column: 'model_pin', set: 'model_pin IS NOT NULL' },
  { table: 'personas', column: 'minimum_score', set: 'minimum_score IS NOT NULL' },
] as const;

const Named = z.object({ name: z.string() });
const Value = z.object({ value: z.string() });

function tableNames(db: TendbDatabase): Set<string> {
  return new Set(
    z
      .array(Named)
      .parse(db.$client.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all())
      .map((row) => row.name),
  );
}

function hasColumn(db: TendbDatabase, table: string, column: string): boolean {
  return z
    .array(Named)
    .parse(db.$client.pragma(`table_info(${table})`))
    .some((row) => row.name === column);
}

/**
 * Whether the database holds routing settings from before the playbook: a row in an old table, or a
 * value in an old column. Reads only what exists, so a database from any earlier schema answers
 * without error.
 */
export function holdsOldRouting(db: TendbDatabase): boolean {
  const tables = tableNames(db);
  for (const table of OLD_TABLES) {
    if (
      tables.has(table) &&
      db.$client.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() !== undefined
    )
      return true;
  }
  return OLD_COLUMNS.some(
    ({ table, column, set }) =>
      tables.has(table) &&
      hasColumn(db, table, column) &&
      db.$client.prepare(`SELECT 1 FROM ${table} WHERE ${set} LIMIT 1`).get() !== undefined,
  );
}

/** Whether a 10db build that moved the routing settings to the playbook has run on this database. */
export function playbookMoveRan(db: TendbDatabase): boolean {
  if (!tableNames(db).has('app_settings')) return false;
  const row = db.$client.prepare('SELECT value FROM app_settings WHERE key = ?').get(MOVED_SETTING);
  if (row === undefined) return false;
  // The setting's value is JSON written by this package's settings store.
  return JSON.parse(Value.parse(row).value) === true;
}
