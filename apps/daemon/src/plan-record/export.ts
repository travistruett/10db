import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { InvalidError, type PlanExportResult, type ShapeId } from '@10db/contracts';
import type { DbReader } from '@10db/db';
import { realPathOf } from '../guard';
import { exportLayout } from './export-layout';
import { daemonRoots, forbiddenPlaceOf } from './forbidden-places';
import { readRecordForExport } from './lookup';

// Exporting a Plan's record as Markdown, only ever outside every checkout, 10db's own roots and any
// git work tree, into a folder that is new, empty or this Plan's own earlier export.

/** The file that marks a folder as a Plan's export; it names the Plan. */
export const EXPORT_MARKER = '.10db-plan-export';

export interface ExportForbidden {
  readonly checkouts: readonly string[];
  readonly worktreeRoot: string;
  readonly dataDir: string;
  readonly sandboxRoots: readonly string[];
}

/** The real path a folder names, made or not yet; a folder that can't be resolved is refused. */
function realFolderOf(dir: string): string {
  try {
    return realPathOf(dir);
  } catch {
    throw new InvalidError(`${dir} could not be resolved`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Refuses a folder at or under any forbidden place, read both as written and as the kernel opens it. */
function refuseForbidden(dir: string, real: string, forbidden: ExportForbidden): void {
  const place = forbiddenPlaceOf(
    [real, resolve(dir)],
    [
      ...forbidden.checkouts.map((path) => ({ path, what: 'a registered checkout' })),
      ...daemonRoots(forbidden),
    ],
  );
  if (place !== null)
    throw new InvalidError(`${real} lies at or under ${place.what} (${place.path})`);
}

/** Refuses a folder in a git work tree: a `.git`, folder or file, at it or any folder above it. */
async function refuseGitTree(real: string): Promise<void> {
  for (let at = real; ; at = dirname(at)) {
    if (await exists(join(at, '.git')))
      throw new InvalidError(`${real} lies in a git work tree (${at})`);
    if (dirname(at) === at) return;
  }
}

/**
 * Writes a file under a fresh name opened with O_EXCL and O_NOFOLLOW, then renames it over `path`, so
 * a link, hard link or FIFO planted at `path` is replaced rather than written through.
 */
async function writeReplacing(path: string, text: string): Promise<void> {
  const fresh = `${path}.${randomUUID()}.tmp`;
  const handle = await open(
    fresh,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o644,
  );
  try {
    try {
      await handle.writeFile(text, 'utf8');
    } finally {
      await handle.close();
    }
    await rename(fresh, path);
  } catch (error) {
    await rm(fresh, { force: true });
    throw error;
  }
}

/** Runs one file step of the export; a file system error is refused naming the file. */
async function onFile<T>(path: string, verb: 'read' | 'write', run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof InvalidError) throw error;
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'failed';
    throw new InvalidError(`10db could not ${verb} ${path} (${code})`);
  }
}

/** Makes a folder, refusing one that is a link or not a folder. */
async function folderAt(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new InvalidError(`${path} is not a folder of the export`);
}

export async function exportPlan(
  input: { readonly shapeId: ShapeId; readonly dir: string; readonly forbidden: ExportForbidden },
  db: DbReader,
): Promise<PlanExportResult> {
  const { dir, shapeId } = input;
  if (!isAbsolute(dir)) throw new InvalidError('The export folder must be an absolute path');
  const real = realFolderOf(dir);
  refuseForbidden(dir, real, input.forbidden);
  await refuseGitTree(real);
  if (await exists(real)) {
    const stat = await lstat(real);
    if (!stat.isDirectory()) throw new InvalidError(`${real} is not a folder`);
    const held = await readdir(real);
    if (held.length > 0) {
      if (!held.includes(EXPORT_MARKER))
        throw new InvalidError(`${real} is not empty and is not an export of this Plan`);
      const markerPath = join(real, EXPORT_MARKER);
      const marker = await onFile(markerPath, 'read', () =>
        readFile(markerPath, {
          encoding: 'utf8',
          flag: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        }),
      );
      if (marker.trim() !== shapeId)
        throw new InvalidError(`${real} is the export of another Plan`);
    }
  }

  const files = exportLayout(readRecordForExport(db, shapeId));
  // The marker goes first, so an export that fails part-way leaves a folder its retry accepts.
  await onFile(real, 'write', () => folderAt(real));
  const markerPath = join(real, EXPORT_MARKER);
  await onFile(markerPath, 'write', () => writeReplacing(markerPath, `${shapeId}\n`));
  const documents = join(real, 'documents');
  await onFile(documents, 'write', () => folderAt(documents));
  for (const file of files) {
    const path = join(real, file.path);
    await onFile(path, 'write', () => writeReplacing(path, file.text));
  }
  return { dir: real, files: [...files.map((f) => f.path), EXPORT_MARKER] };
}
