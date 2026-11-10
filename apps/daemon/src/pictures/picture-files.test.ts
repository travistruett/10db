import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mintId, NotFoundError, ScreenKind, ScreenTheme, type TaskId } from '@10db/contracts';
import { createTestStore, insertTask, listTaskScreens, seedProject, type Store } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { pngOfSize } from '../../test/png';
import { keepScreen, pngSize, sweepPictureTemps } from './picture-files';

// Workbench spec §10, §11, §12: a picture is a file named by its hash under the data directory before
// it is a row; a file is written once however many rows name it, and removed once none does.

let dir: TempDir;
let store: Store;
let state: StateStore;
let close: () => void;
let taskId: TaskId;

beforeEach(() => {
  dir = tempDir('pictures');
  ({ store, close } = createTestStore());
  state = createStateStore(store, createEventBus());
  const project = seedProject(store, { areas: [{ name: 'people', globs: ['src/**'] }] });
  taskId = store.write((ctx) =>
    insertTask(ctx, project.id, { title: 'People', acceptanceCriteria: ['x'], areas: ['people'] }),
  ).value.id;
});
afterEach(() => {
  close();
  dir.cleanup();
});

const shot = (png: Uint8Array, kind: ScreenKind = ScreenKind.Before) => ({
  taskId,
  turnId: null,
  kind,
  route: '/people',
  viewport: { width: 1440, height: 900 },
  theme: ScreenTheme.Default,
  keptSha: null,
  png,
});

const mode = (path: string): number => statSync(path).mode & 0o777;

describe('pngSize', () => {
  it.each([
    { name: 'a PNG', bytes: pngOfSize(1440, 900), size: { width: 1440, height: 900 } },
    { name: 'cut inside its header', bytes: pngOfSize(1440, 900).subarray(0, 20), size: null },
    { name: 'not a PNG', bytes: Buffer.from('GIF89a and more bytes than a header'), size: null },
  ])('$name', ({ bytes, size }) => {
    expect(pngSize(bytes)).toEqual(size);
  });
});

describe('keepScreen', () => {
  it('writes the file under its hash, private, and then its row naming it', () => {
    const kept = keepScreen(state, dir.path, shot(pngOfSize(1440, 900)));
    const row = listTaskScreens(store.db, taskId)[0];
    expect(row).toMatchObject({ id: kept?.id, width: 1440, height: 900, sha256: kept?.sha256 });
    const sha = kept?.sha256 ?? '';
    const file = join(join(dir.path, 'screens'), sha.slice(0, 2), `${sha}.png`);
    expect(readFileSync(file)).toEqual(pngOfSize(1440, 900));
    expect(mode(file)).toBe(0o600);
    expect(mode(join(dir.path, 'screens'))).toBe(0o700);
    expect(mode(join(join(dir.path, 'screens'), sha.slice(0, 2)))).toBe(0o700);
  });

  it('keeps one file for two rows of the same picture', () => {
    const png = pngOfSize(1440, 900);
    const before = keepScreen(state, dir.path, shot(png, ScreenKind.Before));
    const after = keepScreen(state, dir.path, shot(png, ScreenKind.After));
    expect(after?.sha256).toBe(before?.sha256);
    const sha = before?.sha256 ?? '';
    expect(readdirSync(join(join(dir.path, 'screens'), sha.slice(0, 2)))).toEqual([`${sha}.png`]);
    expect(listTaskScreens(store.db, taskId)).toHaveLength(2);
  });

  it('refuses bytes that are not a PNG, writing nothing', () => {
    expect(() => keepScreen(state, dir.path, shot(Buffer.from('not a png at all')))).toThrow(
      /not a PNG/,
    );
    expect(existsSync(join(dir.path, 'screens'))).toBe(false);
    expect(listTaskScreens(store.db, taskId)).toEqual([]);
  });
});

describe('removing files', () => {
  it('removes the file when its row cannot be written', () => {
    const png = pngOfSize(1440, 900);
    expect(() => keepScreen(state, dir.path, { ...shot(png), taskId: mintId('Task') })).toThrow(
      NotFoundError,
    );
    const sub = join(dir.path, 'screens');
    const left = existsSync(sub)
      ? readdirSync(sub, { recursive: true }).filter((name) => String(name).endsWith('.png'))
      : [];
    expect(left).toEqual([]);
  });

  it('keeps a file another row still names when a row of the same picture cannot be written', () => {
    const png = pngOfSize(1440, 900);
    const kept = keepScreen(state, dir.path, shot(png));
    expect(() => keepScreen(state, dir.path, { ...shot(png), taskId: mintId('Task') })).toThrow(
      NotFoundError,
    );
    const sha = kept?.sha256 ?? '';
    expect(existsSync(join(dir.path, 'screens', sha.slice(0, 2), `${sha}.png`))).toBe(true);
  });

  it('removes a temporary file a stopped write left, which no row names', () => {
    const kept = keepScreen(state, dir.path, shot(pngOfSize(1440, 900)));
    const sha = kept?.sha256 ?? '';
    const sub = join(join(dir.path, 'screens'), sha.slice(0, 2));
    const left = join(sub, `.${'e'.repeat(64)}.1234.part`);
    writeFileSync(left, 'half a picture');
    expect(sweepPictureTemps(dir.path)).toBe(1);
    expect(readdirSync(sub)).toEqual([`${sha}.png`]);
    expect(listTaskScreens(store.db, taskId).map((s) => s.sha256)).toEqual([sha]);
  });

  it('sweeps nothing before any picture was taken', () => {
    expect(sweepPictureTemps(dir.path)).toBe(0);
  });
});
