import { lstatSync, readdirSync, realpathSync, rmdirSync, rmSync } from 'node:fs';
import { InvalidError } from '@10db/contracts';
import { samePath, surelyInside } from '../git';
import { realPathOf } from '../guard';

/**
 * The builder's Delete directory answer: deletes `path` and everything in it, but only a real directory
 * under the worktree root `root` (not the root itself), and never a link. Throws an InvalidError saying
 * why when it is anything else. A path that is already gone counts as deleted.
 */
export function deleteStrayDirectory(root: string, path: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }
  if (!stat.isDirectory())
    throw new InvalidError(`10db deletes only a directory, and ${path} is a link or a file`);
  if (!surelyInside(path, root) || samePath(realpathSync(path), realPathOf(root)))
    throw new InvalidError(`10db deletes only inside its worktree root, and ${path} is not`);
  rmSync(path, { recursive: true, force: true });
}

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
