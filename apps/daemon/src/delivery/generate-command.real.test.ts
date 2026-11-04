import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { carriedSoFar, copyCustomSql } from './migration-carry';
import { schemaOf as snapshotSchemaOf } from './snapshot-schema';
import { MIGRATIONS_DIR, generateCommand, type CarriedMigration } from './worktree-generated';

/**
 * `generateCommand` run for real: the pnpm on this machine and the repository's own drizzle-kit, on a
 * temp copy of packages/db. `migration-carry.test.ts` and `pr-catch-up.test.ts` fake the generators and
 * `worktree-generated.test.ts` compares strings, so this is what shows that pnpm passes `--custom` and
 * `--name` through, that drizzle-kit writes the tag and stub the journal check expects, and that it
 * exits 0 with no file when the schema holds nothing new.
 */
const TEST_TIMEOUT = 120_000;
vi.setConfig({ testTimeout: TEST_TIMEOUT });

const DB_PACKAGE = join(import.meta.dirname, '../../../../packages/db');
const JOURNAL = `${MIGRATIONS_DIR}meta/_journal.json`;
const CUSTOM_STUB = '-- Custom SQL migration file, put your code below! --';

/** The first `pnpm` on PATH: the daemon resolves one outside every checkout, which is not under test. */
function findPnpm(): string {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    const candidate = join(dir, 'pnpm');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error('no pnpm on PATH');
}

const schemaOf = (...columns: string[]): string =>
  [
    "import { sqliteTable, text } from 'drizzle-orm/sqlite-core';",
    '',
    "export const sessions = sqliteTable('sessions', {",
    "  id: text('id').primaryKey(),",
    ...columns.map((column) => `  ${column}: text('${column}'),`),
    '});',
    '',
  ].join('\n');

let root: string;
let pnpm: string;

/** A workspace whose only package is a copy of packages/db, with the database package's modules linked in. */
function workspace(schema: string): void {
  const dir = join(root, 'packages/db');
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (const file of ['package.json', 'drizzle.config.ts'])
    cpSync(join(DB_PACKAGE, file), join(dir, file));
  writeFileSync(join(dir, 'src/schema.ts'), schema);
  symlinkSync(join(DB_PACKAGE, 'node_modules'), join(dir, 'node_modules'));
  writeFileSync(join(root, 'package.json'), '{ "name": "workspace", "private": true }\n');
  // pnpm would install before it runs a script; the package's modules are linked in already.
  writeFileSync(
    join(root, 'pnpm-workspace.yaml'),
    "packages:\n  - 'packages/*'\nverifyDepsBeforeRun: false\n",
  );
}

/**
 * spawnSync blocks the worker, so the test timeout cannot interrupt it: a hung pnpm or drizzle-kit (a
 * new interactive prompt, say) would hold it until the gate's own timeout. This is below that.
 */
const COMMAND_TIMEOUT = TEST_TIMEOUT - 30_000;

const run = (migrations: readonly CarriedMigration[]) => {
  const result = spawnSync('/bin/sh', ['-c', generateCommand(pnpm, [MIGRATIONS_DIR], migrations)], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
    timeout: COMMAND_TIMEOUT,
  });
  if (result.error !== undefined)
    throw new Error(
      `the generate command did not finish within ${String(COMMAND_TIMEOUT)} ms (a hung pnpm or drizzle-kit, ` +
        `such as a prompt waiting for input): ${result.error.message}\n${result.stdout}${result.stderr}`,
    );
  return result;
};

const tagsOf = (): string[] =>
  (
    JSON.parse(readFileSync(join(root, JOURNAL), 'utf8')) as { entries: { tag: string }[] }
  ).entries.map((entry) => entry.tag);

const sqlFiles = (): string[] =>
  readdirSync(join(root, MIGRATIONS_DIR))
    .filter((file) => file.endsWith('.sql'))
    .sort();

const made = (name: string, custom = false): CarriedMigration => ({
  tag: `0001_${name}`,
  name,
  custom,
});

describe('generateCommand, run with the real pnpm and drizzle-kit', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'generate-command-'));
    pnpm = findPnpm();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('makes a generated migration and then a custom one, and carries them over', async () => {
    workspace(schemaOf('note'));
    const migrations = [made('add_note'), { tag: '0002_backfill', name: 'backfill', custom: true }];

    const result = run(migrations);

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(tagsOf()).toEqual(['0000_add_note', '0001_backfill']);
    expect(readFileSync(join(root, MIGRATIONS_DIR, '0000_add_note.sql'), 'utf8')).toContain(
      'CREATE TABLE `sessions`',
    );
    expect(readFileSync(join(root, MIGRATIONS_DIR, '0001_backfill.sql'), 'utf8').trim()).toBe(
      CUSTOM_STUB,
    );
    // The journal check reads what drizzle-kit wrote: both made, in order, under the numbers it chose.
    const carried = carriedSoFar(root, [], migrations);
    expect(carried.missing).toBeNull();
    expect(carried.made.map(({ tag }) => tag)).toEqual(['0000_add_note', '0001_backfill']);
    expect(carried.renumbered).toEqual([
      { from: '0001_add_note', to: '0000_add_note' },
      { from: '0002_backfill', to: '0001_backfill' },
    ]);

    // ownMigrations calls a migration custom when its snapshot's schema equals the previous one's. That
    // is drizzle-kit's behaviour: `--custom` must write a snapshot with the schema it started from.
    const snapshot = (number: string): string | null =>
      snapshotSchemaOf(
        readFileSync(join(root, MIGRATIONS_DIR, `meta/${number}_snapshot.json`), 'utf8'),
      );
    expect(snapshot('0000')).not.toBeNull();
    expect(snapshot('0001')).toBe(snapshot('0000'));

    // The custom stub is replaced by the branch's own SQL, byte for byte.
    const sql = Buffer.from('UPDATE sessions SET note = 1;\n');
    const copied = await copyCustomSql(
      { bytesAt: () => Promise.resolve(sql) },
      root,
      'tip',
      carried.made,
    );
    expect(copied).toBeNull();
    expect(readFileSync(join(root, MIGRATIONS_DIR, '0001_backfill.sql'))).toEqual(sql);
  });

  it('exits 0 with no file for a second generated migration when nothing is left to generate', () => {
    workspace(schemaOf('note'));
    const migrations = [made('add_note'), { tag: '0002_again', name: 'again', custom: false }];

    const result = run(migrations);

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(sqlFiles()).toEqual(['0000_add_note.sql']);
    expect(existsSync(join(root, MIGRATIONS_DIR, 'meta/0001_snapshot.json'))).toBe(false);
    expect(tagsOf()).toEqual(['0000_add_note']);
    // What the catch-up goes by: the journal lacks the second, so it names it.
    const carried = carriedSoFar(root, [], migrations);
    expect(carried.made.map(({ tag }) => tag)).toEqual(['0000_add_note']);
    expect(carried.missing).toEqual(migrations[1]);
  });
});
