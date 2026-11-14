import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * The real path of `path`. A path that doesn't exist yet is the real path of the nearest dir that does,
 * with the rest appended, so it still sits under the entries its dirs resolve to.
 */
export function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realOrSelf(parent), basename(path));
  }
}
