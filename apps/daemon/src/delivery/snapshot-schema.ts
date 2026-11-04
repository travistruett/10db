import { z } from 'zod';

/** What `generate` writes into every snapshot whatever the schema: never part of the comparison. */
const SNAPSHOT_BOOKKEEPING: ReadonlySet<string> = new Set(['id', 'prevId', '_meta']);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `value` with each object's keys sorted: `--custom` copies a snapshot in another key order. */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, field]) => [key, sortedKeys(field)]),
  );
}

/** A snapshot's schema with its keys sorted; null when `text` is not a snapshot. */
function schemaFields(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isObject(parsed)) return null;
    const fields = Object.entries(parsed).filter(([key]) => !SNAPSHOT_BOOKKEEPING.has(key));
    const sorted = sortedKeys(Object.fromEntries(fields));
    return isObject(sorted) ? sorted : null;
  } catch {
    return null;
  }
}

/** A snapshot's schema, comparable with another's; null when it is not a snapshot. */
export function schemaOf(text: string): string | null {
  const fields = schemaFields(text);
  return fields === null ? null : JSON.stringify(fields);
}

const same = (one: unknown, other: unknown): boolean =>
  JSON.stringify(one) === JSON.stringify(other);

/**
 * A three-way merge by key, over values whose keys are sorted: a table, a column or an index is the
 * unit, so two sides adding beside each other never meet. `at` is where it stands. Where both sides
 * changed one value two ways, `conflicts` gets that place.
 */
function mergedValue(
  ancestor: unknown,
  ours: unknown,
  theirs: unknown,
  at: string,
  conflicts: string[],
): unknown {
  if (same(ours, theirs) || same(theirs, ancestor)) return ours;
  if (same(ours, ancestor)) return theirs;
  if (!isObject(ours) || !isObject(theirs)) {
    conflicts.push(at);
    return ours;
  }
  const base = isObject(ancestor) ? ancestor : {};
  const merged = Object.keys({ ...base, ...ours, ...theirs }).map((key) => [
    key,
    mergedValue(base[key], ours[key], theirs[key], at === '' ? key : `${at}.${key}`, conflicts),
  ]);
  return Object.fromEntries(merged.filter(([, value]) => value !== undefined));
}

const none = z.record(z.string(), z.never());

/** A snapshot this module can write as a schema file: anything else is refused, never left out. */
const SchemaSnapshot = z.object({
  tables: z.record(
    z.string(),
    z.strictObject({
      name: z.string(),
      columns: z.record(
        z.string(),
        z.strictObject({
          name: z.string(),
          type: z.string(),
          primaryKey: z.boolean(),
          notNull: z.boolean(),
          autoincrement: z.boolean(),
          default: z.union([z.string(), z.number(), z.boolean()]).optional(),
        }),
      ),
      indexes: z.record(
        z.string(),
        z.strictObject({
          name: z.string(),
          columns: z.array(z.string()),
          isUnique: z.boolean(),
          where: z.string().optional(),
        }),
      ),
      foreignKeys: z.record(
        z.string(),
        z.strictObject({
          name: z.string(),
          tableFrom: z.string(),
          columnsFrom: z.array(z.string()),
          tableTo: z.string(),
          columnsTo: z.array(z.string()),
          onDelete: z.string().optional(),
          onUpdate: z.string().optional(),
        }),
      ),
      compositePrimaryKeys: z.record(
        z.string(),
        z.strictObject({ name: z.string(), columns: z.array(z.string()) }),
      ),
      // drizzle-kit writes a unique constraint among a table's indexes, and this stays empty.
      uniqueConstraints: none,
      checkConstraints: z.record(
        z.string(),
        z.strictObject({ name: z.string(), value: z.string() }),
      ),
    }),
  ),
  views: none,
  internal: z.object({ indexes: none }),
});
type SchemaSnapshot = z.infer<typeof SchemaSnapshot>;
type SnapshotTable = SchemaSnapshot['tables'][string];
type SnapshotColumn = SnapshotTable['columns'][string];

const text = (value: unknown): string => JSON.stringify(value);

function columnSource(column: SnapshotColumn): string {
  const parts = column.autoincrement
    ? [`integer(${text(column.name)})`, 'primaryKey({ autoIncrement: true })']
    : [`type(${text(column.type)})(${text(column.name)})`];
  if (column.primaryKey && !column.autoincrement) parts.push('primaryKey()');
  if (column.notNull) parts.push('notNull()');
  if (typeof column.default === 'string') parts.push(`default(sql.raw(${text(column.default)}))`);
  else if (column.default !== undefined) parts.push(`default(${text(column.default)})`);
  return parts.join('.');
}

function tableConfigSource(table: SnapshotTable): string[] {
  const own = (names: readonly string[]): string =>
    names.map((name) => `t[${text(name)}]`).join(', ');
  const config: string[] = [];
  for (const { name, columns, isUnique, where } of Object.values(table.indexes)) {
    const make = isUnique ? 'uniqueIndex' : 'index';
    const filter = where === undefined ? '' : `.where(sql.raw(${text(where)}))`;
    config.push(`${make}(${text(name)}).on(${own(columns)})${filter}`);
  }
  for (const key of Object.values(table.foreignKeys)) {
    const to = key.columnsTo.map((name) => `tables[${text(key.tableTo)}][${text(name)}]`);
    const actions = [
      ...(key.onDelete === undefined ? [] : [`.onDelete(${text(key.onDelete)})`]),
      ...(key.onUpdate === undefined ? [] : [`.onUpdate(${text(key.onUpdate)})`]),
    ];
    config.push(
      `foreignKey({ name: ${text(key.name)}, columns: [${own(key.columnsFrom)}], foreignColumns: [${to.join(', ')}] })${actions.join('')}`,
    );
  }
  for (const { name, columns } of Object.values(table.compositePrimaryKeys))
    config.push(`primaryKey({ name: ${text(name)}, columns: [${own(columns)}] })`);
  for (const { name, value } of Object.values(table.checkConstraints))
    config.push(`check(${text(name)}, sql.raw(${text(value)}))`);
  return config;
}

/**
 * `snapshot` as a schema file drizzle-kit reads back to the same snapshot. `customType` takes a
 * snapshot's SQL type as it stands; an autoincrement is the one thing that needs `integer` itself.
 * Each table's config is read once all the tables exist, so a foreign key can name a later one.
 */
function schemaSource(snapshot: SchemaSnapshot): string {
  const tables = Object.values(snapshot.tables).map((table, i) => {
    const columns = Object.values(table.columns).map(
      (column) => `  ${text(column.name)}: ${columnSource(column)},`,
    );
    const config = tableConfigSource(table).map((line) => `  ${line},`);
    return [
      `export const t${String(i)} = tables[${text(table.name)}] = sqliteTable(${text(table.name)}, {`,
      ...columns,
      '}, (t) => [',
      ...config,
      ']);',
    ].join('\n');
  });
  return [
    "import { sql } from 'drizzle-orm';",
    "import { check, customType, foreignKey, index, integer, primaryKey, sqliteTable, uniqueIndex } from 'drizzle-orm/sqlite-core';",
    '',
    'const type = (dataType) => customType({ dataType: () => dataType });',
    'const tables = {};',
    '',
    ...tables,
    '',
  ].join('\n');
}

export type StepSchema =
  | { readonly kind: 'schema'; readonly text: string }
  | { readonly kind: 'refused'; readonly why: string };

/**
 * The schema file that stands for a step of the branch: the snapshot `ours` of that step, merged with
 * the snapshot `theirs` of the base from `ancestor`, their common one. A schema file's history can't
 * give this, since one commit may hold several steps, and a snapshot of its own keeps each.
 */
export function stepSchema(ancestor: string, ours: string, theirs: string): StepSchema {
  const base = schemaFields(ancestor);
  const mine = schemaFields(ours);
  const other = schemaFields(theirs);
  if (base === null || mine === null || other === null)
    return { kind: 'refused', why: 'a snapshot could not be read' };
  const conflicts: string[] = [];
  const merged = mergedValue(base, mine, other, '', conflicts);
  const conflict = conflicts[0];
  if (conflict !== undefined) return { kind: 'refused', why: `both sides changed ${conflict}` };
  const snapshot = SchemaSnapshot.safeParse(merged);
  if (!snapshot.success)
    return { kind: 'refused', why: 'its snapshot holds what 10db does not write as a schema file' };
  return { kind: 'schema', text: schemaSource(snapshot.data) };
}
