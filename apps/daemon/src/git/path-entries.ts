import { lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/** True for anything at `path`, a file or a link whose target is gone included. */
export function existsAsEntry(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
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
