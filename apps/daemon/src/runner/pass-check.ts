import {
  InboxKind,
  PASS_RETRY_TURN_CHOICE,
  PASS_SIGN_OFF_CHOICE,
  type InboxItemDto,
  type PassCheckDetail,
  type PassDto,
  type PassFileChange,
  type PassTurnId,
  type TaskDto,
  type WorkstreamId,
} from '@10db/contracts';
import { insertInboxItem, type WriteContext } from '@10db/db';
import { flagCard } from '../inbox';

// Workbench spec §6.1, §6.2: a Ready page is a new `check` item each time, answered only by Sign Off;
// a turn that cannot go on is a flag answered by Retry Turn.

/** What the Ready item of one turn shows: the turn's kept commit and the files it and the page changed. */
export interface PassCheck {
  readonly pass: PassDto;
  readonly task: TaskDto;
  readonly workstreamId: WorkstreamId;
  readonly turnId: PassTurnId;
  readonly keptSha: string | null;
  readonly keptBaseSha: string;
  readonly turnFiles: readonly PassFileChange[];
  readonly pageFiles: readonly PassFileChange[];
}

const fileLine = (f: PassFileChange): string =>
  `- ${f.path} +${String(f.added)} −${String(f.removed)}`;

function checkBody(check: PassCheck): string {
  if (check.turnFiles.length === 0) return 'This turn changed no file of the page.';
  const n = check.turnFiles.length;
  return [
    `This turn changed ${String(n)} file${n === 1 ? '' : 's'}:`,
    ...check.turnFiles.map(fileLine),
  ].join('\n');
}

/**
 * Raises the page's Ready item for the turn: always a new item, never folded, so each Ready page
 * notifies. Its detail names the pass, which the Inbox folds a pass's items on.
 */
export function raisePassCheck(ctx: WriteContext, check: PassCheck): InboxItemDto {
  const detail: PassCheckDetail = {
    passId: check.pass.id,
    taskId: check.task.id,
    workstreamId: check.workstreamId,
    turnId: check.turnId,
    keptSha: check.keptSha,
    keptBaseSha: check.keptBaseSha,
    turnFiles: [...check.turnFiles],
    pageFiles: [...check.pageFiles],
  };
  return insertInboxItem(ctx, {
    projectId: check.pass.projectId,
    kind: InboxKind.Check,
    title: `Ready: ${check.task.title}`,
    body: checkBody(check),
    options: [{ label: PASS_SIGN_OFF_CHOICE, description: 'The page is right' }],
    recommendation: null,
    category: 'product',
    urgency: 'normal',
    detail,
    foldKey: null,
    targets: [{ workstreamId: check.workstreamId, sessionId: null }],
  });
}

/** The detail key of a failed turn's flag that names the turn Retry Turn runs again. */
export const PASS_TURN_DETAIL = 'passTurnId';

/** Raises the flag of a turn that cannot go on, whose one option runs the turn again. */
export function raiseTurnFailed(
  ctx: WriteContext,
  input: {
    readonly pass: PassDto;
    readonly task: TaskDto;
    readonly workstreamId: WorkstreamId;
    readonly turnId: PassTurnId;
    readonly reason: string;
  },
): InboxItemDto {
  return flagCard(ctx, {
    projectId: input.pass.projectId,
    workstreamId: input.workstreamId,
    title: `Turn failed: ${input.task.title}`,
    body: input.reason,
    detail: { passId: input.pass.id, [PASS_TURN_DETAIL]: input.turnId },
    options: [
      {
        label: PASS_RETRY_TURN_CHOICE,
        description: "Sends the builder's last message to the agent again",
      },
    ],
  });
}
