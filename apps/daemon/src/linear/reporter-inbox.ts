import { Urgency, type InboxItemDto, type ProjectId } from '@10db/contracts';
import {
  dismissLinearPosts,
  findOpenByFoldKey,
  latestLinearPostProblem,
  linearPostCounts,
  linearPostProblems,
  getTask,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import type { StateStore } from '../events';
import { BY_ANSWER, CardTier, type InboxService } from '../inbox';
import { linearLinkOf } from './task-link';

// The project's one Inbox card for Linear updates that need the builder:
// what waits on a retry, failed for good or was withheld by the secret scan.

/** The detail key that marks a card as the reporter's, holding the project id. */
const REPORTER_DETAIL = 'linearReporter';
const DISMISS = 'Dismiss';

export const linearReporterFoldKey = (projectId: ProjectId): string =>
  `linear-reporter:${projectId}`;

const LISTED_ROWS = 10;

/** One line per row the card counts: the task, its issue, the event and the post id, so each can be found on the issue. */
function problemLines(db: DbReader, projectId: ProjectId): string[] {
  const rows = linearPostProblems(db, projectId, LISTED_ROWS + 1);
  const lines = rows.slice(0, LISTED_ROWS).map((p) => {
    const task = getTask(db, p.taskId);
    const issue = linearLinkOf(db, p.taskId)?.link.id ?? 'no issue';
    return `- ${task.title} (${issue}): ${p.event}, attempt ${String(p.attempt)}, ${p.state}, ${p.id}`;
  });
  return rows.length > LISTED_ROWS ? [...lines, '- and more'] : lines;
}

/**
 * Brings the project's card in line with its rows: withdrawn when nothing is left, otherwise one card with
 * the counts and the latest reason, refreshed in place.
 */
export function refreshReporterCard(
  deps: { readonly state: StateStore; readonly inbox: InboxService },
  projectId: ProjectId,
): void {
  const { waiting, failed, withheld } = linearPostCounts(deps.state.db, projectId);
  if (waiting + failed + withheld === 0) {
    const open = findOpenByFoldKey(deps.state.db, projectId, linearReporterFoldKey(projectId));
    if (open !== undefined) deps.inbox.withdraw(open.id);
    return;
  }
  const latest = latestLinearPostProblem(deps.state.db, projectId);
  const reason =
    latest === null
      ? null
      : (latest.lastError ??
        (latest.withheldPattern === null ? null : `held back: ${latest.withheldPattern}`));
  const counts = [
    waiting > 0 ? `${String(waiting)} waiting` : null,
    failed > 0 ? `${String(failed)} failed` : null,
    withheld > 0
      ? `${String(withheld)} withheld${latest?.withheldPattern ? ` (${latest.withheldPattern})` : ''}`
      : null,
  ].filter((part) => part !== null);
  deps.inbox.flag({
    projectId,
    tier: CardTier.Status,
    urgency: Urgency.Normal,
    closesWhen: BY_ANSWER,
    workstreamId: null,
    title: 'Linear Updates Need You',
    body: [
      reason === null ? counts.join(', ') : `${counts.join(', ')}. Latest: ${reason}`,
      ...problemLines(deps.state.db, projectId),
    ].join('\n'),
    detail: { [REPORTER_DETAIL]: projectId },
    options: [
      {
        label: DISMISS,
        description: 'Close this card; failed and withheld updates stay on the task',
      },
    ],
    recommendation: null,
    foldKey: linearReporterFoldKey(projectId),
    refresh: true,
  });
}

/** Answering the card marks the project's failed and withheld rows dismissed, in the answer's own write. */
export function dismissReporterPosts(ctx: WriteContext, item: InboxItemDto): void {
  if (typeof item.detail?.[REPORTER_DETAIL] !== 'string') return;
  dismissLinearPosts(ctx, item.projectId);
}
