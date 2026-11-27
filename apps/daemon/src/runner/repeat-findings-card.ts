import { Urgency, type InboxItemDto, type TaskDto, type WorkstreamId } from '@10db/contracts';
import { findOpenByFoldKey, type RetryLimitFindings, type WriteContext } from '@10db/db';
import { BY_ANSWER, CardTier, flagCard } from '../inbox';

/** The fold key of a retry-limit follow-up's repeat-findings card: one per task. */
const foldKeyOf = (task: TaskDto): string => `findings-repeat:${task.id}`;

/**
 * Raises the card for a retry-limit follow-up whose own run shipped at the limit too, in place of a
 * further follow-up: it carries the open findings for the builder. A second rejection of the same run
 * (QA after review) adds its findings to the open card, so the run keeps one card.
 */
export function raiseRepeatFindings(
  ctx: WriteContext,
  input: {
    readonly task: TaskDto;
    readonly parent: TaskDto;
    readonly workstreamId: WorkstreamId;
    readonly found: RetryLimitFindings;
  },
): InboxItemDto {
  const { task, parent, found } = input;
  const foldKey = foldKeyOf(task);
  const open = findOpenByFoldKey(ctx.tx, task.projectId, foldKey);
  const body =
    open === undefined
      ? [
          `"${task.title}" was filed to fix the open findings of "${parent.title}" (${parent.id}), and its ${found.role} step still rejected the work at the retry limit. 10db filed no further follow-up. These findings are open:`,
          found.notes,
        ].join('\n\n')
      : [
          open.body,
          `The ${found.role} step rejected the work again at the retry limit:`,
          found.notes,
        ].join('\n\n');
  return flagCard(ctx, {
    projectId: task.projectId,
    workstreamId: input.workstreamId,
    tier: CardTier.Ask,
    urgency: Urgency.Normal,
    closesWhen: BY_ANSWER,
    title: `Findings repeat: ${task.title}`,
    body,
    foldKey,
    refresh: open !== undefined,
  });
}
