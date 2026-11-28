import { constants, type Dirent } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readdir, readlink, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ConflictError, type UndoAction } from '@10db/contracts';
import { getProject } from '@10db/db';
import type { StateStore } from '../events';
import { GitError, surelyInside, WorktreeNotOursError, type Git } from '../git';
import { keptRoot } from './kept-files';

/** What putting a removed hand-made worktree back needs. */
export interface HandMadeUndoDeps {
  readonly state: StateStore;
  readonly git: Git;
  /** Where saved files are; the builder's kept folder when absent. */
  readonly keptRoot?: string | undefined;
}

/** The permission bits a restored file keeps from the saved copy. */
const FILE_MODE_BITS = 0o7777;

/** Every file and link under `dir`, as paths relative to it; folders are walked, never followed. */
async function filesUnder(dir: string, prefix = ''): Promise<string[]> {
  const found: string[] = [];
  const entries: Dirent[] = await readdir(join(dir, prefix), { withFileTypes: true });
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : join(prefix, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(dir, relative)));
    else found.push(relative);
  }
  return found.sort();
}

/** True when `error` is a file system error with this code. */
const failedWith = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;

/**
 * Copies each file saved under `keptDir` back to the same relative path in `worktree`, with its mode
 * and a link as a link. Nothing is overwritten: a file already there stays as it is. The kept folder
 * stays too. Resolves with the relative paths copied back.
 */
async function copyKeptBack(keptDir: string, worktree: string): Promise<string[]> {
  const restored: string[] = [];
  for (const file of await filesUnder(keptDir)) {
    const from = join(keptDir, file);
    const to = join(worktree, file);
    const source = await lstat(from);
    await mkdir(dirname(to), { recursive: true });
    if (!surelyInside(dirname(to), worktree)) continue;
    try {
      if (source.isSymbolicLink()) await symlink(await readlink(from), to);
      else if (source.isFile()) {
        await copyFile(from, to, constants.COPYFILE_EXCL);
        await chmod(to, source.mode & FILE_MODE_BITS);
      } else continue;
      restored.push(file);
    } catch (error) {
      if (!failedWith(error, 'EEXIST')) throw error;
    }
  }
  return restored;
}

/**
 * Takes back the removal of a hand-made worktree: makes the worktree again at its path on its branch,
 * then copies the files saved before the removal back. The project must still exist, and the path must
 * lie in its hand-made folders (git refuses any other). A path with anything at it, a branch that is gone, or a branch a
 * worktree has checked out is a `ConflictError` and changes nothing.
 */
export async function undoHandMadeRemoval(
  deps: HandMadeUndoDeps,
  action: Extract<UndoAction, { kind: 'restore_worktree' }>,
): Promise<void> {
  const project = getProject(deps.state.db, action.projectId);
  const saved = action.keptDir;
  if (saved !== null && !surelyInside(saved, deps.keptRoot ?? keptRoot())) {
    throw new ConflictError(`${saved} is not in the kept folder.`);
  }
  let result: 'restored' | 'path_exists' | 'branch_gone';
  try {
    result = await deps.git.restoreHandMadeWorktree(project.repoPath, action.path, action.branch);
  } catch (error) {
    if (error instanceof WorktreeNotOursError || error instanceof GitError) {
      throw new ConflictError(`The worktree could not be made again: ${error.message}`);
    }
    throw error;
  }
  switch (result) {
    case 'path_exists':
      throw new ConflictError(
        `Something is already at ${action.path}, so the worktree was not made again.`,
      );
    case 'branch_gone':
      throw new ConflictError(
        `The branch ${action.branch} no longer exists, so the worktree was not made again.`,
      );
    case 'restored':
      break;
  }
  if (saved !== null) await copyKeptBack(saved, action.path);
}
