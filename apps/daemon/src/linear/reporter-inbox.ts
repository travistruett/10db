import {
  clipText,
  Urgency,
  type InboxAnswer,
  type InboxItemDto,
  type LinearPostDto,
  type ProjectId,
} from '@10db/contracts';
import {
  dismissLinearPosts,
  findOpenByFoldKey,
  linearPostCounts,
  linearPostProblems,
  getProject,
  getTask,
  retryLinearPosts,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import type { StateStore } from '../events';
import { BY_ANSWER, CardTier, type InboxService } from '../inbox';
import { linearLinkOf } from './task-link';

// The project's one Inbox card for Linear updates that need the builder:
// what is held for a Linear sign-in, waits on a retry, failed for good or was withheld by the secret scan.

/** The detail key that marks a card as the reporter's, holding the project id. */
const REPORTER_DETAIL = 'linearReporter';

/** The card's answers. */
export const ReporterChoice = { Retry: 'Retry', Dismiss: 'Dismiss' } as const;
export type ReporterChoice = (typeof ReporterChoice)[keyof typeof ReporterChoice];

export const linearReporterFoldKey = (projectId: ProjectId): string =>
  `linear-reporter:${projectId}`;

const LISTED_ROWS = 10;
/** The most characters of a reason the title carries. */
const TITLE_REASON_MAX = 90;

/** One line per row the card counts: the task, its issue, the event and the post id, so each can be found on the issue. */
function problemLines(db: DbReader, rows: readonly LinearPostDto[]): string[] {
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
  const { waiting, held, failed, withheld } = linearPostCounts(deps.state.db, projectId);
  if (waiting + held + failed + withheld === 0) {
    const open = findOpenByFoldKey(deps.state.db, projectId, linearReporterFoldKey(projectId));
    if (open !== undefined) deps.inbox.withdraw(open.id);
    return;
  }
  // Held rows come first, so with any held the first row's reason names the account that needs a Linear sign-in.
  const problems = linearPostProblems(deps.state.db, projectId, LISTED_ROWS + 1);
  const latest = problems[0] ?? null;
  const reason =
    latest === null
      ? null
      : (latest.lastError ??
        (latest.withheldPattern === null ? null : `held back: ${latest.withheldPattern}`));
  const counts = [
    held > 0 ? `${String(held)} held for a Linear sign-in` : null,
    waiting > 0 ? `${String(waiting)} waiting` : null,
    failed > 0 ? `${String(failed)} failed` : null,
    withheld > 0
      ? `${String(withheld)} withheld${latest?.withheldPattern ? ` (${latest.withheldPattern})` : ''}`
      : null,
  ].filter((part) => part !== null);
  const titleReason = clipText(
    (reason ?? counts.join(', ')).replace(/\s+/g, ' ').trim(),
    TITLE_REASON_MAX,
  );
  deps.inbox.flag({
    projectId,
    tier: CardTier.Status,
    urgency: Urgency.Normal,
    closesWhen: BY_ANSWER,
    workstreamId: null,
    title: `Linear updates for ${getProject(deps.state.db, projectId).name} ${held > 0 ? 'are held' : 'are not going through'}: ${titleReason}`,
    body: [
      reason === null
        ? counts.join(', ')
        : `${counts.join(', ')}. ${held > 0 ? reason : `Latest: ${reason}`}`,
      ...problemLines(deps.state.db, problems),
    ].join('\n'),
    detail: { [REPORTER_DETAIL]: projectId },
    options: [
      { label: ReporterChoice.Retry, description: 'Try every failed update again now' },
      {
        label: ReporterChoice.Dismiss,
        description: 'Close this card and stop retrying; the updates stay on the task',
      },
    ],
    recommendation: null,
    foldKey: linearReporterFoldKey(projectId),
    refresh: true,
  });
}

/**
 * Applies an answer to the card, in the answer's own write. Retry makes the project's failed rows (not dismissed)
 * and its rows waiting on a retry due now, and answers the project, whose reporter is then woken. Any other
 * answer dismisses: failed and withheld rows are marked seen and rows waiting on a retry stop. Null for a card
 * that is not the reporter's, or once dismissed.
 */
export function answerReporterCard(
  ctx: WriteContext,
  item: InboxItemDto,
  answer: InboxAnswer,
): ProjectId | null {
  if (typeof item.detail?.[REPORTER_DETAIL] !== 'string') return null;
  if (answer.choice === ReporterChoice.Retry) {
    retryLinearPosts(ctx, item.projectId, ctx.now);
    return item.projectId;
  }
  dismissLinearPosts(ctx, item.projectId);
  return null;
}
