import type { InboxItemDto, ProjectId, WorkstreamId } from '@10db/contracts';
import {
  insertInboxItem,
  openItemsForWorkstream,
  type DbReader,
  type WriteContext,
} from '@10db/db';

/** What the builder is asked to check once a gate-less task has finished its last step. */
export interface BuilderCheck {
  readonly workstreamId: WorkstreamId;
  readonly projectId: ProjectId;
  readonly taskTitle: string;
  readonly baseHead: string;
  readonly head: string;
  readonly commits: readonly string[];
}

function commitsReady(count: number): string {
  if (count === 0) return 'No commits were made.';
  return count === 1 ? '1 commit is ready.' : `${String(count)} commits are ready.`;
}

/** The live `check` card of a workstream, if the builder has not finished with it. */
export function liveCheckCard(db: DbReader, workstreamId: WorkstreamId): InboxItemDto | undefined {
  return openItemsForWorkstream(db, workstreamId).find((item) => item.kind === 'check');
}

/**
 * Asks the builder to check finished work. A workstream has at most one live check card, so a second
 * verify or a restart finds the first and raises nothing new.
 */
export function raiseBuilderCheck(ctx: WriteContext, check: BuilderCheck): InboxItemDto {
  const existing = liveCheckCard(ctx.tx, check.workstreamId);
  if (existing) return existing;
  return insertInboxItem(ctx, {
    projectId: check.projectId,
    kind: 'check',
    title: `Ready for you to check: ${check.taskTitle}`,
    body: `${commitsReady(check.commits.length)} Approve to finish the task, or send it back with a note.`,
    options: [
      { label: 'approve', description: 'The work is right' },
      { label: 'send_back', description: 'It needs more work' },
    ],
    recommendation: null,
    category: 'product',
    urgency: 'normal',
    detail: {
      workstreamId: check.workstreamId,
      baseHead: check.baseHead,
      head: check.head,
      commits: [...check.commits],
    },
    foldKey: null,
    targets: [{ workstreamId: check.workstreamId, sessionId: null }],
  });
}
