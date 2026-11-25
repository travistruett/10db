import { rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ProjectDto } from '@10db/contracts';
import { findUnfinishedBatch, sharedLaneRan } from '@10db/db';
import { existsAsEntry, type WorktreeOwner } from '../git';
import type { DeliveryContext } from './context';
import { pnpmPackageDirs, ROOT_PACKAGE } from './install-health';
import type { DependencyRefresh } from './worktree-dependencies';
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
  // The lockfile may be the root's or a package's below it (`amps/frontend`): each package's install
  // makes the `node_modules` directories that lie in its folder, the root's all of them.
  const packageDirs = pnpmPackageDirs(path);
  const inPackage = (dir: string, packageDir: string): boolean =>
    packageDir === ROOT_PACKAGE || dir.startsWith(`${packageDir}/`);
  const makingPackages = packageDirs.filter((packageDir) =>
    dirs.some((dir) => basename(dir) === 'node_modules' && inPackage(dir, packageDir)),
  );
  const installMakes = makingPackages.length > 0;
  const cloned = dirs.filter(
    (dir) =>
      basename(dir) !== 'node_modules' ||
      !makingPackages.some((packageDir) => inPackage(dir, packageDir)),
  );
  if (seeded) {
    try {
      // A directory already there is one an earlier, interrupted run of this cut made: the install repairs it.
      const fresh = cloned.filter((dir) => !existsAsEntry(join(path, dir)));
      const copied = await seedWorktree({ from: main, to: path, dirs: fresh, signal });
      ctx.logger.info(
        {
          ...whose,
          path,
          dirs: fresh,
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
  const results: DependencyRefresh[] = [];
  for (const packageDir of packageDirs) {
    const result = await ctx.dependencies.refresh({
      owner,
      project,
      path,
      signal,
      seeded: seeded && !makingPackages.includes(packageDir),
      makeTemplate: true,
      packageDir,
    });
    results.push(result);
    ctx.logger.info(
      {
        ...whose,
        path,
        packageDir,
        outcome: describeOutcome(result),
        ...(result.kind === 'installed' || result.kind === 'failed'
          ? { logPath: result.logPath }
          : {}),
      },
      'worktree package dependencies',
    );
    // A package that failed or was stopped ends the cut; the ones after it would not be used.
    if (result.kind === 'failed' || result.kind === 'aborted') break;
  }
  return { seeded, installMakes, dirs, installed: combined(results) };
}

/** What one package's refresh did, for the log. */
function describeOutcome(result: DependencyRefresh): string {
  switch (result.kind) {
    case 'skipped':
      return 'nothing to do';
    case 'installed':
      return result.fromTemplate === true ? 'cloned from template' : 'installed';
    case 'failed':
      return 'install failed';
    case 'aborted':
      return 'stopped';
  }
}

/** The one outcome a cut's caller reads from every package's: the first stop, else the installs together. */
function combined(results: readonly DependencyRefresh[]): DependencyRefresh {
  const stopped = results.find((result) => result.kind === 'failed' || result.kind === 'aborted');
  if (stopped !== undefined) return stopped;
  const installs = results.filter((result) => result.kind === 'installed');
  const [first, ...rest] = installs;
  if (first === undefined) return { kind: 'skipped' };
  if (rest.length === 0) return first;
  const leftBroken = installs.find((result) => result.leftBroken !== undefined)?.leftBroken;
  return {
    kind: 'installed',
    logPath: first.logPath,
    durationMs: installs.reduce((total, result) => total + result.durationMs, 0),
    startedOver: installs.some((result) => result.startedOver),
    installs: installs.reduce((total, result) => total + result.installs, 0),
    ...(leftBroken === undefined ? {} : { leftBroken }),
    ...(installs.every((result) => result.fromTemplate === true)
      ? { fromTemplate: true as const }
      : {}),
  };
}
