import { lstatSync, readdirSync, realpathSync, rmdirSync } from 'node:fs';
import { samePath, surelyInside } from '../git';
import { realPathOf } from '../guard';

/**
 * Removes `path` when it is an empty, real directory under the worktree root `root` (not the root
 * itself); false, with nothing touched, when anything else is there.
 */
export function removeIfEmptyDirectory(root: string, path: string): boolean {
  try {
    if (!lstatSync(path).isDirectory()) return false;
    if (!surelyInside(path, root) || samePath(realpathSync(path), realPathOf(root))) return false;
    if (readdirSync(path).length > 0) return false;
    rmdirSync(path);
    return true;
  } catch {
    return false;
  }
}
