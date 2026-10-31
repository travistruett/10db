import { join } from 'node:path';
import type { Git } from '../git';
import { checkConcreteHost } from '../permissions';
import {
  CONFIG_FORMATS,
  LOCK_FORMATS,
  namesNpmRegistry,
  type FolderContext,
  type PackageFileFormat,
} from './package-file-formats';
import { MAX_FILE_BYTES, readRegularFile, realSubfolders } from './read-project-files';

/** A host a project file names as a place packages or toolchains come from, and the file that names it. */
export interface FoundHost {
  readonly host: string;
  /** The file's path from the project root, such as `Cargo.lock` or `apps/api/Cargo.lock`. */
  readonly file: string;
}

/** Folders are read this deep from the root: the root and three levels below it, as in `apps/desktop/src-tauri`. */
const MAX_DEPTH = 3;
const MAX_FOLDERS = 400;
const MAX_HOSTS = 40;
/** Folders that hold downloaded or built files, not the project's own package setup. */
const SKIPPED_FOLDERS: ReadonlySet<string> = new Set([
  'node_modules',
  'target',
  'dist',
  'build',
  'out',
  'vendor',
  'venv',
  '__pycache__',
  'coverage',
  'Pods',
]);

function isSkipped(name: string): boolean {
  return SKIPPED_FOLDERS.has(name) || name.startsWith('.');
}

/** Where a reading takes a project's files from: a folder on disk, or the files of a commit. */
interface ProjectFiles {
  /** The text of a regular file (a path from the project root), or null when it is not one. */
  read(file: string): Promise<string | null>;
  /** The names of the real folders directly inside a folder (`''` for the root), sorted. */
  subfolders(folder: string): Promise<string[]>;
}

interface Named {
  readonly host: string;
  readonly file: string;
}

async function readFormats(
  files: ProjectFiles,
  folder: string,
  formats: readonly PackageFileFormat[],
  context: FolderContext,
): Promise<Named[]> {
  const found: Named[] = [];
  for (const format of formats) {
    const text = await files.read(join(folder, format.path));
    if (text === null) continue;
    const file = folder === '' ? format.path : `${folder}/${format.path}`;
    for (const host of format.hosts(text, context)) found.push({ host, file });
  }
  return found;
}

/** True when the folder's own registry settings name a default registry. */
async function registryNamed(files: ProjectFiles, folder: string): Promise<boolean> {
  for (const name of ['.npmrc', '.yarnrc.yml']) {
    const text = await files.read(join(folder, name));
    if (text !== null && namesNpmRegistry(text)) return true;
  }
  return false;
}

async function readHosts(files: ProjectFiles): Promise<FoundHost[]> {
  const hosts = new Map<string, string>();
  let folders = 0;
  // The root's settings hold for every folder, so they are read once, not once per folder.
  const rootNamed = await registryNamed(files, '');
  const queue: { readonly folder: string; readonly depth: number }[] = [{ folder: '', depth: 0 }];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (folders >= MAX_FOLDERS || hosts.size >= MAX_HOSTS) break;
    folders += 1;
    const context: FolderContext = {
      npmRegistryNamed:
        rootNamed || (next.folder !== '' && (await registryNamed(files, next.folder))),
    };
    const named = [
      ...(await readFormats(files, next.folder, CONFIG_FORMATS, context)),
      ...(await readFormats(files, next.folder, LOCK_FORMATS, context)),
    ];
    for (const { host, file } of named) {
      if (hosts.size >= MAX_HOSTS) break;
      const allowed = allowable(host);
      if (allowed !== null && !hosts.has(allowed)) hosts.set(allowed, file);
    }
    if (next.depth >= MAX_DEPTH) continue;
    for (const name of await files.subfolders(next.folder)) {
      if (isSkipped(name)) continue;
      queue.push({
        folder: next.folder === '' ? name : `${next.folder}/${name}`,
        depth: next.depth + 1,
      });
    }
  }
  return [...hosts].map(([host, file]) => ({ host, file }));
}

/**
 * The hosts a project's own package files name: lockfiles, package manager settings and toolchain
 * files, in the project root and its package folders. The files are only read as text (never
 * followed through a link, never run), and only the host of a URL is kept, so a token or password
 * in a URL is never returned. A host the project may not be given (this machine, an address that
 * isn't one, a whole top-level domain) is left out. Each host is reported with the first file that
 * names it, root first.
 */
export function findRegistryHosts(root: string): Promise<FoundHost[]> {
  return readHosts({
    read: (file) => readRegularFile(root, file),
    subfolders: (folder) => realSubfolders(root, folder),
  });
}

/**
 * The hosts the package files committed at `rev` name, read as `findRegistryHosts` reads a folder but
 * from the object store through the daemon's git, so nothing in the checkout is read, followed or run:
 * a lane's uncommitted edits are not seen, and a link or a file over the size cap counts as absent.
 * A `rev` git can't resolve is an error, not an empty answer.
 */
export async function findRegistryHostsAt(
  git: Pick<Git, 'regularFilesAt' | 'fileAt'>,
  repo: string,
  rev: string,
): Promise<FoundHost[]> {
  const sizes = new Map<string, number>();
  const folders = new Map<string, Set<string>>();
  for (const { path, bytes } of await git.regularFilesAt(repo, rev)) {
    sizes.set(path, bytes);
    // Every folder on the way to a regular file is a real folder: a link or a submodule holds none.
    const parts = path.split('/');
    for (let i = 0; i < parts.length - 1; i += 1) {
      const parent = parts.slice(0, i).join('/');
      const children = folders.get(parent) ?? new Set<string>();
      children.add(parts[i] ?? '');
      folders.set(parent, children);
    }
  }
  return readHosts({
    async read(file) {
      const bytes = sizes.get(file);
      if (bytes === undefined || bytes > MAX_FILE_BYTES) return null;
      const found = await git.fileAt(repo, rev, file, MAX_FILE_BYTES);
      return found.kind === 'file' ? found.text : null;
    },
    subfolders: (folder) => Promise.resolve([...(folders.get(folder) ?? [])].sort()),
  });
}

/** The host as a project may be given it, or null when the project may not. */
function allowable(host: string): string | null {
  try {
    return checkConcreteHost(host);
  } catch {
    return null;
  }
}
