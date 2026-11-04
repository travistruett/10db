import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DRIZZLE_CONFIG, drizzleGenerate } from '../../test/drizzle-kit';
import { schemaOf, stepSchema } from './snapshot-schema';

vi.setConfig({ testTimeout: 120_000 });

const column = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  type: 'text',
  primaryKey: false,
  notNull: false,
  autoincrement: false,
  ...extra,
});

const table = (name: string, columns: Record<string, unknown>) => ({
  name,
  columns,
  indexes: {},
  foreignKeys: {},
  compositePrimaryKeys: {},
  uniqueConstraints: {},
  checkConstraints: {},
});

const snapshot = (tables: Record<string, unknown>, id = 'id'): string =>
  JSON.stringify({
    id,
    prevId: `before-${id}`,
    version: '6',
    dialect: 'sqlite',
    tables,
    views: {},
    enums: {},
    _meta: { schemas: {}, tables: {}, columns: {} },
    internal: { indexes: {} },
  });

const a = { x: column('x') };

describe('merging a step of the branch with the base', () => {
  const merged = (ancestor: string, ours: string, theirs: string) => {
    const step = stepSchema(ancestor, ours, theirs);
    if (step.kind !== 'schema') return step.why;
    return ['y', 'z', 'w', 'b'].filter((word) => step.text.includes(`"${word}"`)).join(' ');
  };

  it.each([
    {
      name: 'a column on each side of one table',
      ours: { a: table('a', { ...a, y: column('y') }) },
      theirs: { a: table('a', { ...a, z: column('z') }) },
      expected: 'y z',
    },
    {
      name: 'a table on each side',
      ours: { a: table('a', a), b: table('b', a) },
      theirs: { a: table('a', { ...a, z: column('z') }) },
      expected: 'z b',
    },
    {
      name: 'the same table added on both sides',
      ours: { a: table('a', a), b: table('b', { y: column('y') }) },
      theirs: { a: table('a', a), b: table('b', { z: column('z') }) },
      expected: 'y z b',
    },
    {
      name: 'the same change on both sides',
      ours: { a: table('a', { x: column('x', { notNull: true }) }) },
      theirs: { a: table('a', { x: column('x', { notNull: true }) }) },
      expected: '',
    },
    {
      name: 'a column one side dropped',
      ours: { a: table('a', {}) },
      theirs: { a: table('a', { ...a, z: column('z') }) },
      expected: 'z',
    },
    {
      name: 'a column changed two ways',
      ours: { a: table('a', { x: column('x', { default: "'one'" }) }) },
      theirs: { a: table('a', { x: column('x', { default: "'two'" }) }) },
      expected: 'both sides changed tables.a.columns.x.default',
    },
    {
      name: 'a column one side dropped and the other changed',
      ours: { a: table('a', {}) },
      theirs: { a: table('a', { x: column('x', { notNull: true }) }) },
      expected: 'both sides changed tables.a.columns.x',
    },
  ])('$name', ({ ours, theirs, expected }) => {
    expect(merged(snapshot({ a: table('a', a) }), snapshot(ours), snapshot(theirs))).toBe(expected);
  });

  it('says so of what is not a snapshot', () => {
    const fine = snapshot({ a: table('a', a) });
    expect(stepSchema(fine, 'not json', fine)).toEqual({
      kind: 'refused',
      why: 'a snapshot could not be read',
    });
  });

  it.each([
    ['a view', { views: { v: {} } }],
    ['a generated column', { tables: { a: table('a', { x: column('x', { generated: {} }) }) } }],
    ['an expression index', { internal: { indexes: { i: { columns: { 'lower(x)': {} } } } } }],
  ])('refuses %s, which it does not write as a schema file', (_name, extra) => {
    const held = JSON.stringify({ ...(JSON.parse(snapshot({})) as object), ...extra });
    expect(stepSchema(held, held, held).kind).toBe('refused');
  });
});

describe('a snapshot as a schema file', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it("holds everything drizzle-kit reads in this repository's schema: generate finds nothing to do", () => {
    dir = mkdtempSync(join(tmpdir(), 'snapshot-schema-'));
    const drizzle = join(import.meta.dirname, '../../../../packages/db/drizzle');
    cpSync(drizzle, join(dir, 'drizzle'), { recursive: true });
    const before = readdirSync(join(dir, 'drizzle')).length;
    const tags = (
      JSON.parse(readFileSync(join(drizzle, 'meta/_journal.json'), 'utf8')) as {
        entries: { tag: string }[];
      }
    ).entries.map((entry) => entry.tag);
    const last = readFileSync(
      join(drizzle, `meta/${(tags.at(-1) ?? '').slice(0, 4)}_snapshot.json`),
      'utf8',
    );
    const step = stepSchema(last, last, last);
    if (step.kind !== 'schema') throw new Error(step.why);
    writeFileSync(join(dir, 'drizzle.config.ts'), DRIZZLE_CONFIG);
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/schema.ts'), step.text);

    expect(drizzleGenerate(dir, 'nothing')).toContain('No schema changes');

    expect(readdirSync(join(dir, 'drizzle'))).toHaveLength(before);
  });
});

describe('telling a --custom migration by its snapshot', () => {
  const snapshotAt = (number: string): string =>
    readFileSync(
      join(import.meta.dirname, '../../../../packages/db/drizzle', `meta/${number}_snapshot.json`),
      'utf8',
    );

  it("reads this repository's baseline custom migration as repeating the snapshot before it", () => {
    expect(schemaOf(snapshotAt('0000'))).toBe(schemaOf(snapshotAt('0001')));
  });

  it('ignores ids, bookkeeping and key order, and sees a changed schema', () => {
    const schema = schemaOf('{"id":"a","_meta":{"x":1},"tables":{"t":{"p":1,"q":2}}}');
    expect(schemaOf('{"tables":{"t":{"q":2,"p":1}},"id":"b","prevId":"a"}')).toBe(schema);
    expect(schemaOf('{"id":"b","tables":{"t":{"p":1,"q":3}}}')).not.toBe(schema);
  });

  it('is no schema at all for what is not a snapshot', () => {
    expect(schemaOf('[]')).toBeNull();
    expect(schemaOf('not json')).toBeNull();
  });
});
