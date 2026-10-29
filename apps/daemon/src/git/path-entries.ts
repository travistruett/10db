import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** True for anything at `path`, a file or a link whose target is gone included. */
export function existsAsEntry(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * What is at `rel` under `root`, read without following a link there: nothing, a real directory, or
 * anything else (a file, a link, a link whose target is gone). A path under a file reads as nothing.
 */
export function entryAt(root: string, rel: string): 'missing' | 'directory' | 'other' {
  try {
    return lstatSync(join(root, rel)).isDirectory() ? 'directory' : 'other';
  } catch {
    return 'missing';
  }
}

/** `path` as the file system names it, or resolved as text once nothing is there. */
export function comparablePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
