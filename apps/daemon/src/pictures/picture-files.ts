import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InvalidError } from '@10db/contracts';
import { hashNamed, insertTaskScreen, type DbReader, type NewTaskScreen } from '@10db/db';
import type { TaskScreenDto } from '@10db/contracts';
import type { StateStore } from '../events';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §10, §11, §12: a picture's
// file under the data directory, named by its hash. The file comes before its row, under a temporary
// name renamed into place, so a crash leaves no half picture and no row naming a missing file.

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const TEMP_SUFFIX = '.part';

/** Where the pictures of every task are kept: `<dataDir>/screens/<2 hex>/<sha256>.png`. */
export const screensDir = (dataDir: string): string => join(dataDir, 'screens');

const pictureDir = (dataDir: string, sha256: string): string =>
  join(screensDir(dataDir), sha256.slice(0, 2));

const picturePath = (dataDir: string, sha256: string): string =>
  join(pictureDir(dataDir, sha256), `${sha256}.png`);

/** A PNG's size in pixels, read from its IHDR chunk; null for bytes that are not a whole PNG header. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Writes a picture's file once, private to this user; answers its hash and where it lies. */
function writePicture(dataDir: string, png: Uint8Array): { sha256: string; storedPath: string } {
  const sha256 = createHash('sha256').update(png).digest('hex');
  const storedPath = picturePath(dataDir, sha256);
  if (existsSync(storedPath)) return { sha256, storedPath };
  mkdirSync(screensDir(dataDir), { recursive: true, mode: 0o700 });
  mkdirSync(pictureDir(dataDir, sha256), { recursive: true, mode: 0o700 });
  const temporary = join(pictureDir(dataDir, sha256), `.${sha256}.${randomUUID()}${TEMP_SUFFIX}`);
  try {
    writeFileSync(temporary, png, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, storedPath);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return { sha256, storedPath };
}

/** A picture taken, to keep for a task: its bytes and what it shows. */
export type ScreenToKeep = Omit<
  NewTaskScreen,
  'sha256' | 'size' | 'width' | 'height' | 'storedPath'
> & {
  readonly png: Uint8Array;
};

/**
 * Keeps a picture: its file, then its row. A turn picture the store does not keep (the same as the last
 * one) answers null, and its file is removed when nothing else names it.
 */
export function keepScreen(
  state: StateStore,
  dataDir: string,
  screen: ScreenToKeep,
): TaskScreenDto | null {
  const size = pngSize(screen.png);
  if (size === null) throw new InvalidError('The browser answered a picture that is not a PNG');
  const { png, ...shown } = screen;
  const file = writePicture(dataDir, png);
  const kept = state.write((ctx) =>
    insertTaskScreen(ctx, {
      ...shown,
      sha256: file.sha256,
      size: png.length,
      width: size.width,
      height: size.height,
      storedPath: file.storedPath,
    }),
  );
  if (kept === null) removeUnnamed(state.db, dataDir, file.sha256);
  return kept;
}

/** Removes the file of `sha256` when no unpruned row names it; answers whether it did. */
export function removeUnnamed(db: DbReader, dataDir: string, sha256: string): boolean {
  if (hashNamed(db, sha256)) return false;
  const path = picturePath(dataDir, sha256);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/** At start-up: removes the temporary files a stopped write left, which no row names. */
export function sweepPictureTemps(dataDir: string): number {
  const root = screensDir(dataDir);
  if (!existsSync(root)) return 0;
  let removed = 0;
  for (const sub of readdirSync(root, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue;
    for (const name of readdirSync(join(root, sub.name)))
      if (name.startsWith('.') && name.endsWith(TEMP_SUFFIX)) {
        rmSync(join(root, sub.name, name), { force: true });
        removed += 1;
      }
  }
  return removed;
}
