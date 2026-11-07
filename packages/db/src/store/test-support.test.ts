import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DB_MIGRATIONS_DIR } from '../database';
import { createTestStore, seedProject } from './test-support';

const TEMPLATES = '10db-test-db-templates';
const shipped = readMigrationFiles({ migrationsFolder: DB_MIGRATIONS_DIR }).length;

// Each test gets a temp directory of its own: the template lives under `tmpdir()`, which reads
// TMPDIR when it is called.
const realTmp = process.env['TMPDIR'];
let tmp: string;
const closers: (() => void)[] = [];
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'test-support-'));
  process.env['TMPDIR'] = tmp;
});
afterEach(() => {
  for (const close of closers.splice(0)) close();
  if (realTmp === undefined) delete process.env['TMPDIR'];
  else process.env['TMPDIR'] = realTmp;
  rmSync(tmp, { recursive: true, force: true });
});

function open() {
  const opened = createTestStore();
  closers.push(opened.close);
  return opened.store;
}

const count = (store: ReturnType<typeof open>, table: string): unknown =>
  store.db.$client.prepare(`SELECT count(*) AS n FROM ${table}`).get();

/** A store is usable: every shipped migration applied, WAL on, foreign keys enforced. */
function expectMigrated(store: ReturnType<typeof open>): void {
  expect(count(store, '__drizzle_migrations')).toEqual({ n: shipped });
  expect(store.db.$client.pragma('journal_mode', { simple: true })).toBe('wal');
  expect(store.db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
}

const templates = (): string[] => readdirSync(join(tmp, TEMPLATES));
/** What sits at the template path and behind it, followed through a symlink. */
const contents = (): string[] =>
  [join(tmp, TEMPLATES), join(tmp, 'elsewhere')].flatMap((path) =>
    existsSync(path) && statSync(path).isDirectory() ? readdirSync(path) : [],
  );

describe('createTestStore', () => {
  it('builds one template in a directory only this user can write, and leaves nothing else', () => {
    expectMigrated(open());
    expectMigrated(open());
    expect(templates()).toEqual([expect.stringMatching(/^[0-9a-f]{16}\.sqlite$/)]);
    expect(statSync(join(tmp, TEMPLATES)).mode & 0o777).toBe(0o700);
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

  it('replaces a template that holds the wrong migrations, and still migrates the store', () => {
    open();
    const [name = ''] = templates();
    writeFileSync(join(tmp, TEMPLATES, name), '');
    expectMigrated(open());
    expectMigrated(open());
    expect(statSync(join(tmp, TEMPLATES, name)).size).toBeGreaterThan(0);
  });

  it('migrates the store itself when the template is removed during a run, and builds it again', () => {
    open();
    const [name = ''] = templates();
    rmSync(join(tmp, TEMPLATES, name));
    expectMigrated(open());
    expectMigrated(open());
    expect(templates()).toEqual([name]);
  });

  it.each([
    [
      'its directory is read-only, so no template can be built',
      () => {
        mkdirSync(join(tmp, TEMPLATES), { mode: 0o500 });
      },
    ],
    [
      'a file stands at its path',
      () => {
        writeFileSync(join(tmp, TEMPLATES), 'x');
      },
    ],
    [
      'a dangling symlink stands at its path',
      () => {
        symlinkSync(join(tmp, 'gone'), join(tmp, TEMPLATES));
      },
    ],
    [
      'a symlink to a directory stands at its path',
      () => {
        mkdirSync(join(tmp, 'elsewhere'));
        symlinkSync(join(tmp, 'elsewhere'), join(tmp, TEMPLATES));
      },
    ],
    [
      'others can write its directory, and a database waits in it',
      () => {
        mkdirSync(join(tmp, TEMPLATES));
        chmodSync(join(tmp, TEMPLATES), 0o777);
        writeFileSync(join(tmp, TEMPLATES, 'planted.sqlite'), '');
      },
    ],
  ])('migrates each store itself and changes nothing there when %s', (_name, arrange) => {
    arrange();
    const before = contents();
    expectMigrated(open());
    expectMigrated(open());
    expect(contents()).toEqual(before);
  });
});
