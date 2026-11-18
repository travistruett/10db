import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ProjectDto } from '@10db/contracts';
import { findUnfinishedBatch, sharedLaneRan } from '@10db/db';
import { existsAsEntry, type WorktreeOwner } from '../git';
import type { DeliveryContext } from './context';
import { PNPM_LOCKFILE, type DependencyRefresh } from './worktree-dependencies';
import { seedDirs, seedWorktree } from './worktree-seed';

/**
 * Brings a new worktree's ignored directories and packages in, for a batch's cut and a session's alike: the
 * seed is cloned from the checkout, then the install makes it match the worktree's own lockfile.
 *
 * A shared lane writes the main checkout's ignored directories, `node_modules` included, and a clone would carry
 * that into this copy. So nothing is cloned while a shared batch is unfinished (CUTTING, OPEN, SHIPPING or
 * FAILED), nor once any shared lane has run in the project, since its writes outlive its batch. In a pnpm project
 * the install then builds `node_modules` from the copy's own lockfile (`seeded: false`), and the caller names
 * every seed directory left unmade. Cards and notices stay with the caller, which knows its owner.
 */
export async function seedAndInstall(
  ctx: Pick<DeliveryContext, 'state' | 'git' | 'logger' | 'dependencies'>,
  input: {
    readonly owner: WorktreeOwner;
    readonly project: ProjectDto;
    readonly main: string;
    readonly path: string;
    readonly signal: AbortSignal;
  },
): Promise<
  | { seeded: boolean; installMakes: boolean; dirs: string[]; installed: DependencyRefresh }
  | { failed: 'seed'; error: unknown }
> {
  const { owner, project, main, path, signal } = input;
  const db = ctx.state.db;
  // The log names its owner as each kind's own field.
  const whose = owner.kind === 'batch' ? { batchId: owner.id } : { chatId: owner.id };
  const sharedLanes = (): boolean =>
    findUnfinishedBatch(db, project.id) !== undefined || sharedLaneRan(db, project.id);
  let seeded = !sharedLanes();
  let dirs: string[];
  try {
    dirs = seedDirs(await ctx.git.ignoredDirectories(main), project.worktreeSeed);
  } catch (error) {
    return { failed: 'seed', error };
  }
  // In a pnpm project the copy's install makes its `node_modules` from its own lockfile, cloned from the
  // daemon's template for it or installed from nothing, so Your folder's is not cloned: pnpm would remove it
  // anyway, since it names another store
  // (`decisions/2026-11-17-a-copys-node-modules-is-cloned-from-a-template-made-once-per-lockfile.md`).
  const installMakes =
    existsSync(join(path, PNPM_LOCKFILE)) && dirs.some((dir) => basename(dir) === 'node_modules');
  const cloned = installMakes ? dirs.filter((dir) => basename(dir) !== 'node_modules') : dirs;
  if (seeded) {
    try {
      // A directory already there is one an earlier, interrupted run of this cut made: the install repairs it.
      const fresh = cloned.filter((dir) => !existsAsEntry(join(path, dir)));
      const copied = await seedWorktree({ from: main, to: path, dirs: fresh, signal });
      ctx.logger.info(
        {
          ...whose,
          path,
          files: copied.files,
          links: copied.links,
          skipped: copied.skipped,
        },
        'worktree seeded',
      );
      // The clone holds no lock the shared cut takes: a shared batch that started meanwhile may have launched a
      // lane that wrote what the clone read. Asked again, the answer is final: a lane launches only after its
      // batch has been cut, and the batch stays visible from its insert until it ends, after which the lane's
      // session does.
      if (sharedLanes()) {
        await Promise.all(
          cloned.map((dir) => rm(join(path, dir), { recursive: true, force: true })),
        );
        seeded = false;
      }
    } catch (error) {
      return { failed: 'seed', error };
    }
  }
  if (!seeded) {
    ctx.logger.info(
      { ...whose, path, dirs },
      'worktree not seeded: a shared lane may have written the main checkout; a pnpm install builds node_modules, and nothing else is made',
    );
  }
  if (signal.aborted) return { seeded, dirs, installMakes, installed: { kind: 'aborted' } };
  const installed = await ctx.dependencies.refresh({
    owner,
    project,
    path,
    signal,
    seeded: seeded && !installMakes,
    makeTemplate: true,
  });
  return { seeded, installMakes, dirs, installed };
}
