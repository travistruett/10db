import type { PassId } from '@10db/contracts';
import { findOpenByFoldKey, getPass, getProject } from '@10db/db';
import { flagCard, withdrawCard } from '../inbox';
import { passBranch, type PassWorkDeps } from './kept-work';

// Workbench spec §5.1, §12: a pass's turns run only while Your folder is on the pass's branch. A
// folder the builder switched away is one card, never a repoint: moving HEAD alone would leave the
// files out of step with the branch the builder chose.

/** The detail key that names the pass a folder card is about. */
export const PASS_CARD_DETAIL = 'passId';

/** The fold key of a pass's one card about where the folder is. */
export const passFolderCardKey = (passId: PassId): string => `pass-folder:${passId}`;

/** The option that switches the folder back to the pass's branch. */
export const switchBackLabel = (branch: string): string => `Switch to ${branch}`;

/**
 * Whether HEAD names the pass's branch. When it does not, the pass's one folder card is raised, or
 * kept as it is; once it does again, the card is withdrawn.
 */
export async function passFolderOn(deps: PassWorkDeps, passId: PassId): Promise<boolean> {
  const db = deps.state.db;
  const pass = getPass(db, passId);
  const branch = passBranch(db, pass);
  const { repoPath } = getProject(db, pass.projectId);
  const found = await deps.git.currentBranch(repoPath);
  const key = passFolderCardKey(passId);
  if (found === branch) {
    deps.state.write((ctx) => {
      const card = findOpenByFoldKey(ctx.tx, pass.projectId, key);
      if (card) withdrawCard(ctx, card.id);
    });
    return true;
  }
  const where = found ?? 'a detached HEAD';
  deps.state.write((ctx) =>
    flagCard(ctx, {
      projectId: pass.projectId,
      workstreamId: null,
      title: `Workbench pass "${pass.name}" is waiting for Your folder`,
      body:
        `Your folder is on ${where}, not on the pass's branch ${branch}, so no page of the pass ` +
        `runs a turn or keeps its work. Switch back to ${branch} to go on.`,
      foldKey: key,
      detail: { [PASS_CARD_DETAIL]: passId },
      options: [
        {
          label: switchBackLabel(branch),
          description: `Checks out ${branch} in Your folder; refused while a changed file is in the way`,
        },
      ],
    }),
  );
  return false;
}
