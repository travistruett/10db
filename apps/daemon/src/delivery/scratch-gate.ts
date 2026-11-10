import { BRANCH_PREFIX, type BatchDto, type PassId, type ProjectDto } from '@10db/contracts';
import { listProjects } from '@10db/db';
import { existsSync } from 'node:fs';
import { existsAsEntry } from '../git';
import type { GateResult } from '../verify';
import { projectAtCheckout } from './checkout';
import type { DeliveryContext } from './context';
import { runGate, type ShipGateDeps } from './ship';
import { worktreeLockReason } from './worktree-cut';
import { madeWorktreeRoot, worktreePathFor } from './worktree-path';

// Workbench spec §8.3 (call 7): where the project allows separate copies, a pass's gate reads the
// pushed commit in a scratch worktree of its own, so it never reads a page still open in the folder
// and the builder keeps working there.

/** Where a pass's scratch gates are made: a branch of their own, named after the pass. */
const SCRATCH_PREFIX = `${BRANCH_PREFIX}gate-`;

/** The branch a pass's scratch worktree is on: `10db/gate-<6 hex of the pass id>`. */
export const scratchBranchName = (passId: PassId): string => `${SCRATCH_PREFIX}${passId.slice(-6)}`;

export type ScratchGateDeps = ShipGateDeps & Pick<DeliveryContext, 'worktreeRoot' | 'dependencies'>;

/** What a scratch gate came to: the gate's own result, a failed install, or stopped. */
export type ScratchGate =
  | { readonly kind: 'ran'; readonly result: GateResult }
  | { readonly kind: 'install_failed'; readonly logPath: string | null }
  | { readonly kind: 'aborted' };

/**
 * Runs the project's gate on commit `sha` in a scratch worktree of it: a locked worktree under the
 * worktree root on the pass's scratch branch, installed as a batch's worktree is but never seeded
 * from the folder, whose pages are still open. The gate runs through the shipping gate's runner (the
 * one slot), its process group on the pass's batch row; `beforeStart` runs once it holds the slot,
 * and a false answer stops it as an abort would. The worktree and its branch go in `finally`, and
 * one a crash left is removed first.
 */
export async function gateInScratch(
  deps: ScratchGateDeps,
  input: {
    readonly batch: BatchDto;
    readonly project: ProjectDto;
    readonly passId: PassId;
    readonly sha: string;
    readonly signal: AbortSignal;
    readonly beforeStart: () => Promise<boolean>;
  },
): Promise<ScratchGate> {
  const main = input.project.repoPath;
  const branch = scratchBranchName(input.passId);
  const path = worktreePathFor(madeWorktreeRoot(deps.worktreeRoot), input.project, branch);
  await removeScratch(deps, main, branch, path);
  if (input.signal.aborted) return { kind: 'aborted' };
  await deps.git.addWorktree({
    repo: main,
    path,
    branch,
    startPoint: input.sha,
    lockReason: worktreeLockReason(input.batch.id),
  });
  try {
    // The folder's ignored directories hold what the pass's lanes wrote: nothing is cloned from it.
    const installed = await deps.dependencies.refresh({
      batch: input.batch,
      project: input.project,
      path,
      signal: input.signal,
      seeded: false,
    });
    switch (installed.kind) {
      case 'aborted':
        return { kind: 'aborted' };
      case 'failed':
        return { kind: 'install_failed', logPath: installed.logPath };
      case 'installed':
      case 'skipped':
        break;
    }
    const result = await runGate(
      deps,
      input.batch,
      projectAtCheckout(input.project, path),
      input.signal,
      input.beforeStart,
    );
    return result === null ? { kind: 'aborted' } : { kind: 'ran', result };
  } finally {
    await removeScratch(deps, main, branch, path).catch((error: unknown) => {
      deps.logger.warn(
        { passId: input.passId, path, err: error instanceof Error ? error.message : String(error) },
        'scratch gate worktree not removed',
      );
    });
  }
}

/** Removes a scratch worktree and its branch, each only when it is there. */
async function removeScratch(
  deps: Pick<DeliveryContext, 'git'>,
  main: string,
  branch: string,
  path: string,
): Promise<void> {
  const listed = (await deps.git.listWorktrees(main)).some((e) => e.branch === branch);
  if (listed || existsAsEntry(path)) await deps.git.removeWorktree(main, path);
  const tip = await deps.git.branchTip(main, branch);
  if (tip !== null && (await deps.git.branchInUse(main, branch)) === null)
    await deps.git.deleteBranchIfAt(main, branch, tip);
}

/**
 * At startup, after the worktree sweep: the scratch gate branches a crash left, in each project, go
 * once no worktree has them, so none is named a stray 10db branch. Nothing else is touched.
 */
export async function removeScratchLeftovers(
  ctx: Pick<DeliveryContext, 'state' | 'git' | 'logger'>,
): Promise<string[]> {
  const removed: string[] = [];
  for (const project of listProjects(ctx.state.db)) {
    if (!existsSync(project.repoPath)) continue;
    try {
      // git lists refs by whole path parts, so the scratch branches are picked from all of 10db's.
      for (const { name, sha } of await ctx.git.localBranches(project.repoPath, BRANCH_PREFIX)) {
        if (!name.startsWith(SCRATCH_PREFIX)) continue;
        if ((await ctx.git.branchInUse(project.repoPath, name)) !== null) continue;
        if (await ctx.git.deleteBranchIfAt(project.repoPath, name, sha)) removed.push(name);
      }
    } catch (error) {
      ctx.logger.warn(
        { projectId: project.id, err: error instanceof Error ? error.message : String(error) },
        'scratch gate branches not swept',
      );
    }
  }
  return removed;
}
