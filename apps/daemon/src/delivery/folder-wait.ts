import { FOLDER_HOLD_WAIT_NOTICE_KEY, type BatchId, type ProjectId } from '@10db/contracts';
import { holderWords } from '../folder-hold';
import { hideNotices, showNotice, type DeliveryContext } from './context';

// Sessions spec §7.3: 10db's own git work that moves Your folder's branch waits for a chat's turn to end, and
// the batch it belongs to says who it waits for.

export interface FolderGitWait {
  readonly projectId: ProjectId;
  /** The batch whose tasks show the wait. */
  readonly batchId: BatchId;
  /** What the git work is, in words, for whoever else asks for the folder. */
  readonly what: string;
  readonly signal?: AbortSignal;
}

/**
 * Reserves Your folder for 10db's git work, waiting for a chat's turn or a takeover to end first. While it
 * waits, the batch carries a notice naming the holder; the notice goes when the wait does. The wait holds the
 * project's delivery slot, so other work for the project queues behind it, and the notice says so. It rejects
 * when the signal aborts.
 */
export async function reserveGitNaming(
  ctx: Pick<DeliveryContext, 'state' | 'folderHold'>,
  wait: FolderGitWait,
): Promise<symbol> {
  const first = ctx.folderHold.reserveGit(wait.projectId, wait.what);
  if (first.reserved) return first.token;
  const holders = first.blockers.map((b) => holderWords(b.holder)).join(' and ');
  showNotice(ctx.state, wait.batchId, {
    key: FOLDER_HOLD_WAIT_NOTICE_KEY,
    tone: 'info',
    line: `Waits for ${holders} to finish with Your folder`,
    body: `10db moves Your folder's branch (${wait.what}) once it is done. Other delivery work for this project waits behind it.`,
  });
  try {
    return await ctx.folderHold.reserveGitWhenFree(wait.projectId, wait.what, wait.signal);
  } finally {
    hideNotices(ctx.state, wait.batchId, [FOLDER_HOLD_WAIT_NOTICE_KEY]);
  }
}
