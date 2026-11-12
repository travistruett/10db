import { passHoldsFolder, PassId, type InboxAnswer, type InboxItemDto } from '@10db/contracts';
import { findPass, getBatch, getPass, getProject } from '@10db/db';
import { z } from 'zod';
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
import { abandonLeftFiles, moveToLabel, raiseAbandonCard, withdrawAbandonCard } from './abandon';

const PassCardKindSchema = z.enum(PassCardKind);

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

/** The folder card's answer: the built switch back to the pass's branch. */
async function switchToPass(deps: PassWorkDeps, passId: PassId, choice: string): Promise<void> {
  const db = deps.state.db;
  const pass = getPass(db, passId);
  if (!passHoldsFolder(pass.state)) {
    withdrawFolderCard(deps, pass);
    return;
  }
  const branch = passBranch(db, pass);
  if (choice !== switchBackLabel(branch)) return;
  const repo = getProject(db, pass.projectId).repoPath;
  const on = await deps.git.currentBranch(repo);
  if (on === null) {
    raiseFolderCard(deps, pass, on, 'check out a branch first: 10db switches only from one');
    return;
  }
  if (on !== branch) {
    const why = await switchFolder(deps, repo, on, branch, refusal({ kind: 'gone' }));
    if (why !== null) {
      raiseFolderCard(deps, pass, on, why);
      return;
    }
  }
  await passFolderOn(deps, pass.id);
}

/** The Abandon card's answer: the built switch from the pass's branch to the one it came from. */
async function moveHome(deps: PassWorkDeps, passId: PassId, choice: string): Promise<void> {
  const db = deps.state.db;
  const pass = getPass(db, passId);
  if (choice !== moveToLabel(pass.returnBranch)) return;
  const repo = getProject(db, pass.projectId).repoPath;
  const on = await deps.git.currentBranch(repo);
  const { prUrl } = getBatch(db, pass.batchId);
  const again = (why: string): void => {
    raiseAbandonCard(deps, pass, { on, left: abandonLeftFiles(db, pass), pullRequest: prUrl, why });
  };
  if (on === null) {
    again('check out a branch first: 10db switches only from one');
    return;
  }
  if (on !== pass.returnBranch) {
    const why = await switchFolder(
      deps,
      repo,
      on,
      pass.returnBranch,
      `${pass.returnBranch} is gone`,
    );
    if (why !== null) {
      again(why);
      return;
    }
  }
  withdrawAbandonCard(deps, pass);
}

/**
 * Switches the folder from `from` to `branch`, keeping uncommitted changes; why not, or null. `gone`
 * says why when the branch cannot be read.
 */
async function switchFolder(
  deps: PassWorkDeps,
  repo: string,
  from: string,
  branch: string,
  gone: string,
): Promise<string | null> {
  const sha = await deps.git.commitAt(repo, branch).catch((error: unknown) => {
    if (error instanceof GitError) return null;
    throw error;
  });
  if (sha === null) return gone;
  const outcome = await deps.git.switchBack(repo, from, { branch, sha }, { keepChanges: true });
  return outcome.kind === 'switched' ? null : refusal(outcome);
}

/**
 * Acts on the answer to a pass's card before the inbox records it, as a job under the project's
 * delivery key. The folder card switches back to the pass's branch while the pass holds the folder,
 * else it is withdrawn; the Abandon card moves the folder to the branch the pass came from. Each runs
 * the built switch, keeping uncommitted changes it does not write; a refusal, or a branch that cannot
 * be read, raises the card again with the reason.
 */
export function answerPassCard(deps: PassWorkDeps, item: InboxItemDto, answer: InboxAnswer): void {
  // The detail is JSON read back from the database: a boundary, so parse it.
  const passId = PassId.safeParse(item.detail?.[PASS_CARD_DETAIL]);
  const kind = PassCardKindSchema.safeParse(item.detail?.[PASS_CARD_KIND]);
  if (!passId.success || !kind.success) return;
  const found = findPass(deps.state.db, passId.data);
  if (!found) return;
  deps.jobs.run(
    jobKey({ projectId: found.projectId, worktreePath: null }, JobQueue.Cut),
    async () => {
      switch (kind.data) {
        case PassCardKind.Folder:
          await switchToPass(deps, found.id, answer.choice);
          return;
        case PassCardKind.Abandon:
          await moveHome(deps, found.id, answer.choice);
          return;
      }
    },
  );
}
