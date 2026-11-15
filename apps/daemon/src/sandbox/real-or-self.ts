import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/** How many links a dangling chain is followed through before its text is taken as it stands. */
const MAX_LINKS = 16;

/**
 * The real path of `path`. A path that doesn't exist yet is the real path of the nearest dir that does,
 * with the rest appended, so it still sits under the entries its dirs resolve to. A link whose target
 * doesn't exist yet is judged by that target, since a write through it creates the target.
 */
export function realOrSelf(path: string, links = 0): string {
  try {
    // The native call resolves a link before the `..` after it, as the kernel does when it opens the path.
    return realpathSync.native(path);
  } catch {
    if (links < MAX_LINKS) {
      try {
        if (lstatSync(path).isSymbolicLink()) {
          const target = readlinkSync(path);
          return realOrSelf(
            isAbsolute(target) ? target : resolve(realOrSelf(dirname(path), links), target),
            links + 1,
          );
        }
      } catch {
        // Not a link, or not readable: the nearest existing parent decides.
      }
    }
    const parent = dirname(path);
    return parent === path ? path : join(realOrSelf(parent, links), basename(path));
  }
}
