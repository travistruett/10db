import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile } from 'node:fs/promises';
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

/** Opens a file to write without following a link at its name. */
async function writeNoFollow(path: string, text: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o644,
  );
  try {
    await handle.writeFile(text, 'utf8');
  } finally {
    await handle.close();
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
      const marker = await readFile(join(real, EXPORT_MARKER), {
        encoding: 'utf8',
        flag: constants.O_RDONLY | constants.O_NOFOLLOW,
      });
      if (marker.trim() !== shapeId)
        throw new InvalidError(`${real} is the export of another Plan`);
    }
  }

  const files = exportLayout(readRecordForExport(db, shapeId));
  await folderAt(real);
  await folderAt(join(real, 'documents'));
  for (const file of files) await writeNoFollow(join(real, file.path), file.text);
  await writeNoFollow(join(real, EXPORT_MARKER), `${shapeId}\n`);
  return { dir: real, files: [...files.map((f) => f.path), EXPORT_MARKER] };
}
