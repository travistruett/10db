import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { InvalidError, type ShapeId } from '@10db/contracts';
import { BUILDER_HANDLE, createTestStore, insertPerson, seedProject, type Store } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo, tempDir, type TempDir } from '../../test/fixtures';
import { bundleJson, inlineBodies, P1_BODY, parseBundle } from '../../test/plan-bundle-fixture';
import { createEventBus, createStateStore } from '../events';
import { EXPORT_MARKER, exportPlan } from './export';
import { importBundle, planImportChanges } from './import';
import { loadStoredRecord } from './lookup';

// Every row runs on the real file system: where an export may write is a security rule.

let store: Store;
let close: () => void;
let root: TempDir;
let checkout: string;
let forbidden: Parameters<typeof exportPlan>[0]['forbidden'];
let shapeId: ShapeId;

/** Imports the fixture bundle (or a copy under another id) and answers its Plan. */
function imported(id = 'remote-host.2026-11-12'): ShapeId {
  const state = createStateStore(store, createEventBus());
  const project = seedProject(store, { name: `p-${id}` });
  const bundle = parseBundle({ ...bundleJson(project.id), id });
  const bodies = inlineBodies(bundle);
  return state.write(
    (ctx) =>
      importBundle(ctx, {
        projectId: project.id,
        bundle,
        bodies,
        changes: planImportChanges(loadStoredRecord(ctx.tx, project.id, id), bundle, bodies),
      }).shapeId,
  );
}

beforeEach(() => {
  ({ store, close } = createTestStore());
  store.write((ctx) => insertPerson(ctx, { handle: BUILDER_HANDLE, name: 'You', isBuilder: true }));
  root = tempDir('export');
  checkout = join(root.path, 'checkout');
  mkdirSync(checkout);
  for (const d of ['worktrees', 'data', 'sandbox']) mkdirSync(join(root.path, d));
  forbidden = {
    checkouts: [checkout],
    worktreeRoot: join(root.path, 'worktrees'),
    dataDir: join(root.path, 'data'),
    sandboxRoots: [join(root.path, 'sandbox')],
  };
  shapeId = imported();
});
afterEach(() => {
  root.cleanup();
  close();
});

const run = (dir: string, id: ShapeId = shapeId) =>
  exportPlan({ shapeId: id, dir, forbidden }, store.db);

async function refused(dir: string): Promise<string> {
  const error = await run(dir).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(InvalidError);
  return error instanceof Error ? error.message : '';
}

describe('exportPlan', () => {
  it('exports into a new folder', async () => {
    const dir = join(root.path, 'out', 'remote-host');
    const result = await run(dir);
    expect(result.files).toEqual([
      'README.md',
      'documents/p1.md',
      'documents/s1.md',
      'entries.md',
      'decisions.md',
      'reviews.md',
      'questions.md',
      EXPORT_MARKER,
    ]);
    expect(
      Buffer.from(readFileSync(join(dir, 'documents', 'p1.md'))).equals(Buffer.from(P1_BODY)),
    ).toBe(true);
    expect(readFileSync(join(dir, EXPORT_MARKER), 'utf8')).toContain(shapeId);
  });

  it('exports again into its own marked folder', async () => {
    const dir = join(root.path, 'out');
    await run(dir);
    expect((await run(dir)).files).toContain('README.md');
  });

  it('a relative dir is refused', async () => {
    expect(await refused('out/remote-host')).toMatch(/absolute/);
  });

  it('a folder inside a registered checkout is refused', async () => {
    const dir = join(checkout, 'docs');
    mkdirSync(dir);
    expect(await refused(dir)).toMatch(/registered checkout/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a not-yet-existing folder under a checkout is refused', async () => {
    const dir = join(checkout, 'not', 'yet');
    expect(await refused(dir)).toMatch(/registered checkout/);
    expect(existsSync(join(checkout, 'not'))).toBe(false);
  });

  it('a link to a checkout is refused', async () => {
    const link = join(root.path, 'looks-safe');
    symlinkSync(checkout, link);
    expect(await refused(join(link, 'plans'))).toMatch(/registered checkout/);
    expect(readdirSync(checkout)).toEqual([]);
  });

  it('the worktree root, the data dir and a sandbox root are refused', async () => {
    expect(await refused(join(forbidden.worktreeRoot, 'x'))).toMatch(/worktree root/);
    expect(await refused(join(forbidden.dataDir, 'x'))).toMatch(/data dir/);
    expect(await refused(join(root.path, 'sandbox', 'x'))).toMatch(/sandbox/);
  });

  it('a folder that cannot be resolved is refused, even one that would reach the data dir', async () => {
    const link = join(root.path, 'ln');
    symlinkSync(forbidden.dataDir, link);
    // `join` would fold the `..` away; the kernel follows the link before it.
    expect(await refused(`${link}/missing/../exports`)).toMatch(/could not be resolved/);
    expect(readdirSync(forbidden.dataDir)).toEqual([]);
  });

  it('a git work tree 10db doesn’t know is refused', async () => {
    const repo = createTempRepo();
    try {
      expect(await refused(join(repo.path, 'notes', 'plan'))).toMatch(/git work tree/);
      expect(existsSync(join(repo.path, 'notes'))).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  it('a non-empty folder without the marker is refused', async () => {
    const dir = join(root.path, 'mine');
    mkdirSync(dir);
    writeFileSync(join(dir, 'keep.md'), 'mine');
    expect(await refused(dir)).toMatch(/not empty/);
    expect(readdirSync(dir)).toEqual(['keep.md']);
  });

  it('another Plan’s marked folder is refused', async () => {
    const dir = join(root.path, 'out');
    await run(dir);
    const other = imported('remote-host.other');
    const error = await run(dir, other).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidError);
    expect(error instanceof Error ? error.message : '').toMatch(/another Plan/);
  });

  it('a link planted in a marked folder as documents/p1.md is not followed', async () => {
    const dir = join(root.path, 'out');
    await run(dir);
    const target = join(root.path, 'target.md');
    writeFileSync(target, 'untouched');
    const planted = join(dir, 'documents', 'p1.md');
    // Replace the exported file with a link to a file outside the folder.
    rmSync(planted);
    symlinkSync(target, planted);
    await expect(run(dir)).rejects.toThrow();
    expect(readFileSync(target, 'utf8')).toBe('untouched');
  });
});
