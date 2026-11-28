import {
  BuilderOwns,
  InboxKind,
  Urgency,
  type InboxAnswer,
  type InboxItemDto,
  type ProjectId,
} from '@10db/contracts';
import {
  findOpenByFoldKey,
  getTask,
  getWorkstreamRow,
  setAppSetting,
  type WriteContext,
} from '@10db/db';
import { BY_ANSWER, CardTier, decidedByBuilder, flagCard } from '../inbox';
import { readActs, readAllowed, readAllowedKey, watchpointReadAgreement } from './read-agreement';

/** The detail key that marks the card as the project's question about letting the judge's read act. */
const READ_DISAGREEMENT_DETAIL = 'watchpointReadDisagreement';

/** The answers of the card; it shows them as written. */
export const ReadDisagreementChoice = {
  LetItAct: 'Let It Act',
  KeepAsking: 'Keep Asking Me',
} as const;
export type ReadDisagreementChoice =
  (typeof ReadDisagreementChoice)[keyof typeof ReadDisagreementChoice];

/** The fold key of a project's card: one per project, ever. */
export const readDisagreementFoldKey = (projectId: ProjectId): string =>
  `watchpoint-read:${projectId}`;

/** The most clean reads the card names; the title says how many there were. */
const NAMED_MAX = 10;

/**
 * Raises the project's one card when the judge read a change as clean and the builder sent it back, once the read's
 * shadow week is over and the builder has not answered it (`readActs` says `ask`). It names the changes, and updates
 * the open card as more are sent back. Until it is answered the read stays in shadow, so nothing waits on it. Run in
 * the write that records a reading.
 */
export function raiseReadDisagreement(ctx: WriteContext, projectId: ProjectId): void {
  const allowed = readAllowed(ctx.tx, projectId);
  // The builder answered: the scan below can only say what they already settled.
  if (allowed !== null) return;
  const { firstAskedAt, cleanButSentBack, sentBack } = watchpointReadAgreement(ctx.tx, projectId);
  const { ask } = readActs({
    firstAskedAt,
    cleanButSentBack,
    allowed,
    now: new Date(ctx.now),
  });
  if (!ask) return;
  const named = sentBack.slice(0, NAMED_MAX).map(({ workstreamId, label }) => {
    const task = getTask(ctx.tx, getWorkstreamRow(ctx.tx, workstreamId).taskId);
    return `- ${label}, in ${JSON.stringify(task.title)}`;
  });
  const n = sentBack.length;
  const title = `The judge read ${String(n)} watchpoint ${n === 1 ? 'change' : 'changes'} as clean that you sent back`;
  const body = [
    "For its first week the judge's read of watchpoints set to Ask only watched. It said these changes were clean, and you sent them back:",
    ...named,
    ...(n > named.length ? [`- and ${String(n - named.length)} more`] : []),
    'Let It Act lets it clear clean changes with a notice and hold the pull request on anything else. Keep Asking Me keeps every Ask hit a card for you, as before. Until you answer, it stays in watch mode.',
  ].join('\n');
  const open = findOpenByFoldKey(ctx.tx, projectId, readDisagreementFoldKey(projectId));
  // A card that already says this is left alone: every reading of the project passes here.
  if (open?.title === title && open.body === body) return;
  flagCard(ctx, {
    projectId,
    workstreamId: null,
    tier: CardTier.Ask,
    urgency: Urgency.Normal,
    closesWhen: BY_ANSWER,
    decision: decidedByBuilder(BuilderOwns.ProductAndTaste),
    title,
    body,
    options: [
      {
        label: ReadDisagreementChoice.LetItAct,
        description:
          'A clean read becomes a notice with no card; any other read holds the pull request',
      },
      {
        label: ReadDisagreementChoice.KeepAsking,
        description: 'Every Ask hit stays a card for you; the read keeps watching',
      },
    ],
    recommendation: null,
    detail: { [READ_DISAGREEMENT_DETAIL]: true },
    foldKey: readDisagreementFoldKey(projectId),
    refresh: true,
  });
}

/**
 * Stores the builder's answer to the card for its project, in the answer's own write, so the next reading acts or
 * stays in shadow by it. Any other card, and any other answer, is left alone.
 */
export function applyReadAllowedAnswer(
  ctx: WriteContext,
  item: InboxItemDto,
  answer: InboxAnswer,
): void {
  if (item.kind !== InboxKind.Flag || item.detail?.[READ_DISAGREEMENT_DETAIL] !== true) return;
  if (answer.choice === ReadDisagreementChoice.LetItAct)
    setAppSetting(ctx, readAllowedKey(item.projectId), true);
  else if (answer.choice === ReadDisagreementChoice.KeepAsking)
    setAppSetting(ctx, readAllowedKey(item.projectId), false);
}
