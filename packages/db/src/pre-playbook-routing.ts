import { z } from 'zod';
import type { TendbDatabase } from './database';

/** The app setting the move to the playbook recorded when it ran. */
const MOVED_SETTING = 'playbook.moved';

/** Tables that held routing settings before the playbook. */
const PRE_PLAYBOOK_TABLES = ['flows', 'patterns', 'role_settings', 'team_bindings'] as const;

/** Columns of kept tables that held routing settings, with the SQL that says a row carries one. */
const PRE_PLAYBOOK_COLUMNS = [
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
 * Whether the database holds routing settings from before the playbook: a row in a table the playbook replaced, or a
 * value in a column it replaced. Reads only what exists, so a database from any earlier schema answers
 * without error.
 */
export function holdsPrePlaybookRouting(db: TendbDatabase): boolean {
  const tables = tableNames(db);
  for (const table of PRE_PLAYBOOK_TABLES) {
    if (
      tables.has(table) &&
      db.$client.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() !== undefined
    )
      return true;
  }
  return PRE_PLAYBOOK_COLUMNS.some(
    ({ table, column, set }) =>
      tables.has(table) &&
      hasColumn(db, table, column) &&
      db.$client.prepare(`SELECT 1 FROM ${table} WHERE ${set} LIMIT 1`).get() !== undefined,
  );
}

/** A stored setting value: JSON text, read as nothing when it is not. */
const StoredJson = z.string().transform((text, ctx): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'not JSON' });
    return z.NEVER;
  }
});

/** Whether a 10db build that moved the routing settings to the playbook has run on this database. */
export function playbookMoveRan(db: TendbDatabase): boolean {
  if (!tableNames(db).has('app_settings')) return false;
  const row = db.$client.prepare('SELECT value FROM app_settings WHERE key = ?').get(MOVED_SETTING);
  // A value that does not read as `true` means the move did not run.
  const stored = z.object({ value: StoredJson }).safeParse(row);
  return stored.success && stored.data.value === true;
}
