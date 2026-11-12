import type { PassDto, PassId } from '@10db/contracts';
import { findOpenByFoldKey, getPass, getProject, type DbReader } from '@10db/db';
import { flagCard, withdrawCard } from '../inbox';
import { passBranch, type PassWorkDeps } from './kept-work';

// Workbench spec §5.1, §12: a pass's turns run only while Your folder is on the pass's branch. A
// folder the builder switched away is one card, never a repoint: moving HEAD alone would leave the
// files out of step with the branch the builder chose.

/** The detail key that names the pass a pass card is about. */
export const PASS_CARD_DETAIL = 'passId';
/** The detail key that says which of a pass's cards it is. */
export const PASS_CARD_KIND = 'passCard';
export const PassCardKind = { Folder: 'folder', Abandon: 'abandon' } as const;
export type PassCardKind = (typeof PassCardKind)[keyof typeof PassCardKind];

/** The fold key of a pass's one card about where the folder is. */
export const passFolderCardKey = (passId: PassId): string => `pass-folder:${passId}`;

/** The option that switches the folder back to the pass's branch. */
export const switchBackLabel = (branch: string): string => `Switch to ${branch}`;

/**
 * Raises the pass's folder card, or keeps the open one; with `why`, a switch back that was refused,
 * the card says so and is raised again.
 */
export function raiseFolderCard(
  deps: Pick<PassWorkDeps, 'state'>,
  pass: PassDto,
  found: string | null,
  why?: string,
): void {
  const branch = passBranch(deps.state.db, pass);
  const where = found ?? 'a detached HEAD';
  deps.state.write((ctx) =>
    flagCard(ctx, {
      projectId: pass.projectId,
      workstreamId: null,
      title: `UI Workbench pass "${pass.name}" is waiting for Your folder`,
      body:
        `Your folder is on ${where}, not on the pass's branch ${branch}, so no page of the pass ` +
        `runs a turn or keeps its work. Switch back to ${branch} to go on.` +
        (why === undefined ? '' : `\n\n10db could not switch it: ${why}`),
      foldKey: passFolderCardKey(pass.id),
      ...(why === undefined ? {} : { refresh: true }),
      detail: { [PASS_CARD_DETAIL]: pass.id, [PASS_CARD_KIND]: PassCardKind.Folder },
      options: [
        {
          label: switchBackLabel(branch),
          description: `Checks out ${branch} in Your folder, keeping uncommitted changes; refused while one lies where the switch writes`,
        },
      ],
    }),
  );
}

/** Whether the pass's folder card is open. */
export function folderCardOpen(db: DbReader, pass: PassDto): boolean {
  return findOpenByFoldKey(db, pass.projectId, passFolderCardKey(pass.id)) !== undefined;
}

/** Withdraws the pass's folder card, if one is open. */
export function withdrawFolderCard(deps: Pick<PassWorkDeps, 'state'>, pass: PassDto): void {
  deps.state.write((ctx) => {
    const card = findOpenByFoldKey(ctx.tx, pass.projectId, passFolderCardKey(pass.id));
    if (card) withdrawCard(ctx, card.id);
  });
}

/**
 * The pass's folder card by a read of Your folder's branch already made, `found` being the branch
 * HEAD names: raised when it is not the pass's branch, writing nothing while the card is open, and
 * withdrawn once it is. True when the folder is on the pass's branch.
 */
export function folderSeenOn(
  deps: Pick<PassWorkDeps, 'state'>,
  pass: PassDto,
  found: string | null,
): boolean {
  const on = found === passBranch(deps.state.db, pass);
  const open = folderCardOpen(deps.state.db, pass);
  if (on && open) withdrawFolderCard(deps, pass);
  else if (!on && !open) raiseFolderCard(deps, pass, found);
  return on;
}

/**
 * Whether HEAD names the pass's branch. When it does not, the pass's one folder card is raised, or
 * kept as it is; once it does again, the card is withdrawn.
 */
export async function passFolderOn(deps: PassWorkDeps, passId: PassId): Promise<boolean> {
  const db = deps.state.db;
  const pass = getPass(db, passId);
  const { repoPath } = getProject(db, pass.projectId);
  return folderSeenOn(deps, pass, await deps.git.currentBranch(repoPath));
}
