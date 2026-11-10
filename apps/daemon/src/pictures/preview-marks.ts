import type { ScreenKind } from '@10db/contracts';
import {
  Delivery,
  PassNoticeKind,
  PassPreview,
  PassState,
  TASK_MESSAGE_MAX_CHARS,
  type PassId,
  type PassTurnId,
  type TaskId,
} from '@10db/contracts';
import {
  clearPassNotice,
  countPreviewTurn,
  findPass,
  getPassPreview,
  getPassProgress,
  getPassTurn,
  getProject,
  getTask,
  insertPreviewMark,
  insertSystemNotice,
  listOpenPreviewMarks,
  mendPreviewMark,
  offerToAgent,
  openHolds,
  openPassTurn,
  passHoldingTask,
  setPassNotice,
  setPassPreview,
  setPreviewMarkCard,
  setPreviewMarkNotice,
  takeOffer,
  type WriteContext,
} from '@10db/db';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import { askMoveToCopy } from '../pass';
import { ShotOutcome } from './camera';
import { previewStep } from './preview-rule';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §8.2, §8.4, D19: what one
// load of a pass page's route means for the pass's preview, written in one write. A page whose turn
// broke the preview gets a mark and a thread notice offered with Send to Agent, never sent by itself;
// two broken turns running raise the Move to a Separate Copy card where copies are allowed; a clean
// turn mends the mark. A break no turn is named for is a header notice until a clean load.

/** The start of the thread notice on the page whose turn broke the preview. */
export const PREVIEW_NOTICE = 'The preview of';

/** The id of the header's one notice that the preview is broken with no turn named. */
const UNNAMED_NOTICE_ID = 'preview';

const MINUTE_MS = 60_000;

/** One load of a page's route, the viewports and themes of the capture taken together. */
export interface RouteLoad {
  readonly route: string;
  readonly outcome: ShotOutcome;
  /** The first overlay's text, for an `overlay`. */
  readonly overlayText: string | null;
  /** Why the document failed, for a `failed`. */
  readonly reason: string | null;
}

/**
 * The route's loads as one: broken when any shot was (the first broken shot's words), else clean when
 * any shot was, else elsewhere.
 */
export function routeLoad(
  route: string,
  shots: readonly Omit<RouteLoad, 'route'>[],
): RouteLoad | null {
  const broken = shots.find(
    (s) => s.outcome === ShotOutcome.Overlay || s.outcome === ShotOutcome.Failed,
  );
  if (broken) return { route, ...broken };
  const first = shots.find((s) => s.outcome === ShotOutcome.Clean) ?? shots[0];
  return first === undefined ? null : { route, ...first };
}

/** What the thread says of the break: what the overlay showed, or why the document did not load. */
function breakWords(load: RouteLoad): string {
  return load.outcome === ShotOutcome.Overlay
    ? `the dev server's error overlay says: ${load.overlayText ?? '(no text)'}`
    : `the page did not load (${load.reason ?? 'no reason given'})`;
}

/** What Send to Agent sends for the break, at most one message long. */
function previewOffer(load: RouteLoad, seq: number): string {
  const head = `The preview of ${load.route} broke after your turn ${String(seq)}: `;
  const foot = '\n\nFix it so the page loads again.';
  const words = breakWords(load);
  const room = TASK_MESSAGE_MAX_CHARS - head.length - foot.length;
  return `${head}${words.length <= room ? words : `${words.slice(0, room - 1)}…`}${foot}`;
}

export interface PreviewMarksDeps {
  readonly state: StateStore;
  readonly logger: Logger;
}

/** The load the rule judges: a page's route after a turn, at its before or at its after. */
export interface JudgedLoad {
  readonly passId: PassId;
  readonly taskId: TaskId;
  readonly kind: ScreenKind;
  /** The turn a turn load followed; null for a before or an after. */
  readonly turnId: PassTurnId | null;
  readonly load: RouteLoad;
}

/** Opens the page's mark and offers it on the thread. */
function openMark(ctx: WriteContext, input: JudgedLoad & { readonly turnId: PassTurnId }): void {
  const seq = getPassTurn(ctx.tx, input.turnId).seq;
  const mark = insertPreviewMark(ctx, {
    passId: input.passId,
    taskId: input.taskId,
    turnId: input.turnId,
    route: input.load.route,
    overlay: input.load.outcome === ShotOutcome.Overlay ? input.load.overlayText : null,
  });
  const notice = insertSystemNotice(
    ctx,
    input.taskId,
    `${PREVIEW_NOTICE} \`${input.load.route}\` broke after turn ${String(seq)}: ${breakWords(input.load)}`,
  );
  offerToAgent(ctx, notice.id, previewOffer(input.load, seq));
  setPreviewMarkNotice(ctx, mark.id, notice.id);
}

/**
 * Judges one load of a pass page's route and writes what it means: the pass's preview, the page's
 * mark, the Move card and the header's notice. A pass no longer open, or a task it no longer holds,
 * is left alone.
 */
export function judgePreview(deps: PreviewMarksDeps, input: JudgedLoad): void {
  deps.state.write((ctx) => {
    const pass = findPass(ctx.tx, input.passId);
    if (pass?.state !== PassState.Open) return;
    const task = getTask(ctx.tx, input.taskId);
    if (passHoldingTask(ctx.tx, task)?.id !== pass.id) return;
    const held = (taskId: TaskId) =>
      passHoldingTask(ctx.tx, getTask(ctx.tx, taskId))?.id === pass.id;
    const marks = listOpenPreviewMarks(ctx.tx, pass.id).filter((m) => held(m.taskId));
    const mark = marks.find((m) => m.taskId === task.id);
    const unnamed = getPassProgress(ctx.tx, pass.id).notices.some(
      (n) => n.id === UNNAMED_NOTICE_ID,
    );
    const halfWritten =
      openPassTurn(ctx.tx, task.id) !== undefined ||
      openHolds(ctx.tx, pass.id).some((h) => h.taskId !== task.id);
    const step = previewStep(
      {
        preview: getPassPreview(ctx.tx, pass.id),
        mark: mark === undefined ? null : { turns: mark.turns },
        otherMarks: marks.some((m) => m.taskId !== task.id),
        unnamed,
      },
      { kind: input.kind, outcome: input.load.outcome, halfWritten },
    );
    if (step.preview !== null) setPassPreview(ctx, pass.id, step.preview);
    switch (step.mark) {
      case 'none':
        break;
      case 'open':
        if (input.turnId !== null) openMark(ctx, { ...input, turnId: input.turnId });
        break;
      case 'count': {
        if (mark === undefined) break;
        countPreviewTurn(ctx, mark.id);
        const project = getProject(ctx.tx, pass.projectId);
        if (
          step.offerMove &&
          mark.cardId === null &&
          project.delivery === Delivery.PullRequest &&
          task.workstreamId !== null
        ) {
          const asked = askMoveToCopy(ctx, {
            pass,
            taskId: task.id,
            workstreamId: task.workstreamId,
            cause: { route: mark.route },
          });
          if (!asked.notNow) setPreviewMarkCard(ctx, mark.id, asked.inboxId);
        }
        break;
      }
      case 'mend': {
        if (mark === undefined) break;
        const mended = mendPreviewMark(ctx, mark.id);
        if (mended === null) break;
        if (mended.noticeId !== null) takeOffer(ctx, mended.noticeId);
        deps.logger.info(
          {
            passId: pass.id,
            taskId: task.id,
            route: mended.route,
            minutesBroken: Math.round(
              (Date.parse(ctx.now) - Date.parse(mended.brokenAt)) / MINUTE_MS,
            ),
            turns: mended.turns,
          },
          'the preview mended',
        );
        break;
      }
    }
    switch (step.unnamed) {
      case 'keep':
        break;
      case 'set':
        setPassNotice(ctx, pass.id, {
          id: UNNAMED_NOTICE_ID,
          kind: PassNoticeKind.Preview,
          text: `The preview of \`${input.load.route}\` is broken and no turn is named: it was already broken before this turn. Last load: ${breakWords(input.load)}`,
          sendable: false,
          cardId: null,
          at: ctx.now,
        });
        break;
      case 'clear':
        clearPassNotice(ctx, pass.id, UNNAMED_NOTICE_ID);
        break;
    }
    if (step.preview === PassPreview.Broken && step.mark === 'open')
      deps.logger.info(
        { passId: pass.id, taskId: task.id, route: input.load.route },
        'a turn broke the preview',
      );
  });
}
