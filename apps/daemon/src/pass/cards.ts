import { passHoldsFolder, PassId, type InboxAnswer, type InboxItemDto } from '@10db/contracts';
import { findPass, getPass, getProject } from '@10db/db';
import { jobKey, JobQueue } from '../delivery';
import { GitError, type SwitchBack } from '../git';
import {
  PASS_CARD_DETAIL,
  PASS_CARD_KIND,
  PassCardKind,
  passFolderOn,
  raiseFolderCard,
  switchBackLabel,
  withdrawFolderCard,
} from './folder';
import { passBranch, type PassWorkDeps } from './kept-work';

// Workbench spec §5.1, §5.4: the answers to a pass's cards.

/** Why a switch back left the folder as it was, in words. */
function refusal(outcome: Exclude<SwitchBack, { kind: 'switched' }>): string {
  switch (outcome.kind) {
    case 'moved':
      return `the folder moved to ${outcome.found ?? 'a detached HEAD'} meanwhile`;
    case 'dirty':
      return `uncommitted changes lie where the switch writes: ${outcome.paths.join(', ')}`;
    case 'gone':
      return "the pass's branch is gone";
    case 'checked_out':
      return `the branch is checked out in ${outcome.path}`;
    case 'ignored':
      return `ignored files lie where the switch writes: ${outcome.paths.join(', ')}`;
  }
}

/**
 * Acts on the answer to a pass's card before the inbox records it. The folder card's switch runs as
 * a job under the project's delivery key: the built switch, keeping uncommitted changes the switch
 * does not write. A refusal, or a branch that cannot be read, raises the card again with the reason;
 * a folder back on the pass's branch loses its card, as does a pass that no longer holds the folder,
 * whose branch is no place to switch to.
 */
export function answerPassCard(deps: PassWorkDeps, item: InboxItemDto, answer: InboxAnswer): void {
  // The detail is JSON read back from the database: a boundary, so parse it.
  const passId = PassId.safeParse(item.detail?.[PASS_CARD_DETAIL]);
  if (!passId.success || item.detail?.[PASS_CARD_KIND] !== PassCardKind.Folder) return;
  const db = deps.state.db;
  const found = findPass(db, passId.data);
  if (!found) return;
  deps.jobs.run(
    jobKey({ projectId: found.projectId, worktreePath: null }, JobQueue.Cut),
    async () => {
      const pass = getPass(db, found.id);
      if (!passHoldsFolder(pass.state)) {
        withdrawFolderCard(deps, pass);
        return;
      }
      const branch = passBranch(db, pass);
      if (answer.choice !== switchBackLabel(branch)) return;
      const repo = getProject(db, pass.projectId).repoPath;
      const on = await deps.git.currentBranch(repo);
      if (on === null) {
        raiseFolderCard(deps, pass, on, 'check out a branch first: 10db switches only from one');
        return;
      }
      if (on !== branch) {
        const sha = await deps.git.commitAt(repo, branch).catch((error: unknown) => {
          if (error instanceof GitError) return null;
          throw error;
        });
        if (sha === null) {
          raiseFolderCard(deps, pass, on, refusal({ kind: 'gone' }));
          return;
        }
        const outcome = await deps.git.switchBack(repo, on, { branch, sha }, { keepChanges: true });
        if (outcome.kind !== 'switched') {
          raiseFolderCard(deps, pass, on, refusal(outcome));
          return;
        }
      }
      await passFolderOn(deps, pass.id);
    },
  );
}
