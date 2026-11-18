import { existsSync } from 'node:fs';
import { InboxState, PassId } from '@10db/contracts';
import { findPass, listInbox, listProjects } from '@10db/db';
import type { CheckoutReturnDeps } from './checkout-return';
import { PASS_UNOPENED_DETAIL, passCards } from './cards';
import { raise } from './context';

/** The pass id in `refs/10db/passes/<pass id>/dirt`, or null for any other ref. */
function passIdOf(ref: string): PassId | null {
  const parsed = PassId.safeParse(/^refs\/10db\/passes\/([^/]+)\/dirt$/.exec(ref)?.[1]);
  return parsed.success ? parsed.data : null;
}

/**
 * Start-up, before the batches: a pass the daemon stopped opening between `Git.openPassBranch` and
 * the pass's write left its dirt ref, maybe its branch, and maybe HEAD on that branch, with no pass
 * row. While nothing was built on it, it is taken back as a refused open is (`Git.undoPassBranch`:
 * HEAD names the branch it came from again, no file written); otherwise one card names the branch and
 * says how to go back, and links to Your folder. A card whose branch has gone since closes. A checkout git won't read is logged and left for the next start.
 */
export async function recoverUnopenedPasses(deps: CheckoutReturnDeps): Promise<void> {
  const db = deps.state.db;
  for (const project of listProjects(db)) {
    if (!existsSync(project.repoPath)) continue;
    try {
      // A card whose branch the builder deleted since has nothing left to say: it closes.
      for (const card of listInbox(db, { states: [InboxState.Open], projectId: project.id })) {
        const branch = card.detail?.[PASS_UNOPENED_DETAIL];
        if (
          typeof branch === 'string' &&
          (await deps.git.branchTip(project.repoPath, branch)) === null
        )
          deps.inbox.withdraw(card.id);
      }
      for (const record of await deps.git.passDirtRecords(project.repoPath)) {
        const id = passIdOf(record.ref);
        if (id === null || findPass(db, id) !== undefined) continue;
        const log = { projectId: project.id, passId: id, branch: record.branch };
        const undone = await deps.git.undoPassBranch({
          repo: project.repoPath,
          branch: record.branch,
          returnBranch: record.returnBranch,
          startSha: record.startSha,
          dirtRef: record.ref,
        });
        if (undone) {
          deps.logger.info(log, 'unopened pass taken back');
          continue;
        }
        raise(deps.inbox, project.id, passCards.unopened(record, project.repoPath));
        deps.logger.warn(log, 'unopened pass left with a card');
      }
    } catch (error) {
      deps.logger.warn(
        { projectId: project.id, err: error instanceof Error ? error.message : String(error) },
        'unopened passes not read',
      );
    }
  }
}
