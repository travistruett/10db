import { join } from 'node:path';
import { checkConcreteHost } from '../permissions';
import {
  CONFIG_FORMATS,
  LOCK_FORMATS,
  namesNpmRegistry,
  type FolderContext,
  type PackageFileFormat,
} from './package-file-formats';
import { readRegularFile, realSubfolders } from './read-project-files';

/** A host a project file names as a place packages or toolchains come from, and the file that names it. */
export interface FoundHost {
  readonly host: string;
  /** The file's path from the project root, such as `Cargo.lock` or `apps/api/Cargo.lock`. */
  readonly file: string;
}

/** Folders are read this deep from the root: the root, a package folder and one level inside it. */
const MAX_DEPTH = 2;
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

interface Named {
  readonly host: string;
  readonly file: string;
}

async function readFormats(
  root: string,
  folder: string,
  formats: readonly PackageFileFormat[],
  context: FolderContext,
): Promise<Named[]> {
  const found: Named[] = [];
  for (const format of formats) {
    const text = await readRegularFile(root, join(folder, format.path));
    if (text === null) continue;
    const file = folder === '' ? format.path : `${folder}/${format.path}`;
    for (const host of format.hosts(text, context)) found.push({ host, file });
  }
  return found;
}

/** True when the folder's or the project root's registry settings name a default registry. */
async function registryNamed(root: string, folder: string): Promise<boolean> {
  const folders = folder === '' ? [''] : ['', folder];
  for (const dir of folders) {
    for (const name of ['.npmrc', '.yarnrc.yml']) {
      const text = await readRegularFile(root, join(dir, name));
      if (text !== null && namesNpmRegistry(text)) return true;
    }
  }
  return false;
}

/**
 * The hosts a project's own package files name: lockfiles, package manager settings and toolchain
 * files, in the project root and its package folders. The files are only read as text (never
 * followed through a link, never run), and only the host of a URL is kept, so a token or password
 * in a URL is never returned. A host the project may not be given (this machine, an address that
 * isn't one, a whole top-level domain) is left out. Each host is reported with the first file that
 * names it, root first.
 */
export async function findRegistryHosts(root: string): Promise<FoundHost[]> {
  const hosts = new Map<string, string>();
  let folders = 0;
  const queue: { readonly folder: string; readonly depth: number }[] = [{ folder: '', depth: 0 }];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (folders >= MAX_FOLDERS || hosts.size >= MAX_HOSTS) break;
    folders += 1;
    const context: FolderContext = { npmRegistryNamed: await registryNamed(root, next.folder) };
    const named = [
      ...(await readFormats(root, next.folder, CONFIG_FORMATS, context)),
      ...(await readFormats(root, next.folder, LOCK_FORMATS, context)),
    ];
    for (const { host, file } of named) {
      if (hosts.size >= MAX_HOSTS) break;
      const allowed = allowable(host);
      if (allowed !== null && !hosts.has(allowed)) hosts.set(allowed, file);
    }
    if (next.depth >= MAX_DEPTH) continue;
    for (const name of await realSubfolders(root, next.folder)) {
      if (isSkipped(name)) continue;
      queue.push({
        folder: next.folder === '' ? name : `${next.folder}/${name}`,
        depth: next.depth + 1,
      });
    }
  }
  return [...hosts].map(([host, file]) => ({ host, file }));
}

/** The host as a project may be given it, or null when the project may not. */
function allowable(host: string): string | null {
  try {
    return checkConcreteHost(host);
  } catch {
    return null;
  }
}
