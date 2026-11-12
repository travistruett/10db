import {
  Delivery,
  InboxState,
  PASS_MOVE_TO_COPY_CHOICE,
  PASS_NOT_NOW_CHOICE,
  PassMoveToCopyDetail,
  WorkspaceMode,
  type InboxAnswer,
  type InboxItemDto,
  type InboxItemId,
  type PassDto,
  type ProjectDto,
  type TaskDto,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import {
  findOpenByFoldKey,
  getTask,
  insertSystemNotice,
  listInbox,
  passHoldingTask,
  placeTaskByRule,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import { flagCard } from '../inbox';
import { takeOut, TakeOutWithin, type TakeOutDeps } from './take-out';

// Workbench spec §8.4: a pass task that asks for the migrations or deps hazard runs it in a separate
// copy, never in Your folder, where the project allows copies. The ask is refused and the builder
// gets one card per task, Move to a Separate Copy, which takes the task out of the pass and starts it
// in a copy, where the start puts its kept work back. With no copies the hazard is granted as today,
// and the thread says the page will be slow. A task that broke the preview on two turns running
// (§8.2) is offered the same card where copies are allowed; its Not Now tells the agent nothing.

/** The hazards a pass task leaves Your folder for. */
const COPY_HAZARDS: readonly string[] = ['migrations', 'deps'];

/** The fold key of a task's one Move to a Separate Copy card. */
const moveToCopyKey = (taskId: TaskId): string => `pass-move-copy:${taskId}`;

/** What a pass lane's ask for a hazard meets: the move's card, a slow page, or nothing of a pass. */
export type PassHazardAsk =
  | { readonly kind: 'move'; readonly pass: PassDto }
  | { readonly kind: 'slow' }
  | { readonly kind: 'none' };

/** How a pass treats `task` asking for hazard `name` in `project`. */
export function passHazardAsk(
  db: DbReader,
  project: Pick<ProjectDto, 'delivery'>,
  task: Pick<TaskDto, 'passId'>,
  name: string,
): PassHazardAsk {
  if (!COPY_HAZARDS.includes(name)) return { kind: 'none' };
  const pass = passHoldingTask(db, task);
  if (pass === undefined) return { kind: 'none' };
  return project.delivery === Delivery.PullRequest ? { kind: 'move', pass } : { kind: 'slow' };
}

/** The thread's line when a page of a project with no copies gets hazard `name` in Your folder. */
export function slowPageLine(name: string): string {
  return `Granted the ${name} hazard in Your folder: this project has no separate copies, so the page may be slow while it changes.`;
}

/** What the agent is told when its ask for hazard `name` waits for the builder's move. */
export function moveToCopyInstruction(name: string, notNow = false): string {
  return notNow
    ? `The ${name} hazard runs in a separate copy, not in the Workbench pass's folder, and the builder chose Not Now: this task stays in the pass without it. Don't change any file of the ${name} hazard: finish what you can without it, end your turn and say what is left.`
    : `The ${name} hazard runs in a separate copy, not in the Workbench pass's folder, and the builder is asked whether to move this task to one. Don't change any file of the ${name} hazard: finish what you can without it, end your turn and say what is left.`;
}

/**
 * The task's Move card in `pass` for the same kind of cause (a hazard, or a broken preview) the
 * builder answered Not Now: the page is asked no more for that kind of cause.
 */
function notNowAnswered(
  db: DbReader,
  pass: PassDto,
  taskId: TaskId,
  cause: MoveToCopyCause,
): InboxItemDto | undefined {
  return listInbox(db, {
    projectId: pass.projectId,
    states: [InboxState.Answered, InboxState.Delivering, InboxState.Resolved],
  }).find((item) => {
    // The detail is JSON read back from the database: a boundary, so parse it.
    const detail = PassMoveToCopyDetail.safeParse(item.detail);
    return (
      detail.success &&
      detail.data.passId === pass.id &&
      detail.data.taskId === taskId &&
      (detail.data.hazard !== null) === 'hazard' in cause &&
      item.answer?.choice === PASS_NOT_NOW_CHOICE
    );
  });
}

/** Why a pass task is offered a separate copy: a hazard it asked for, or a preview it broke twice running. */
export type MoveToCopyCause = { readonly hazard: string } | { readonly route: string };

/** The card's body and the thread's line for a cause. */
function moveWords(
  cause: MoveToCopyCause,
  task: Pick<TaskDto, 'title'>,
  pass: Pick<PassDto, 'name'>,
): { readonly body: string; readonly line: string; readonly notNow: string } {
  const move =
    'Move takes the page out of the pass with its work kept and starts the task in a separate copy, its work put back there.';
  return 'hazard' in cause
    ? {
        body: `"${task.title}" asked for the ${cause.hazard} hazard, which runs in a separate copy, not in Your folder while UI Workbench pass "${pass.name}" is open. ${move} Not Now leaves it in the pass without the hazard.`,
        line: `The agent asked for the ${cause.hazard} hazard, which runs in a separate copy: "Move to a Separate Copy" waits in the Inbox.`,
        notNow: 'Leaves the page in the pass without the hazard',
      }
    : {
        body: `"${task.title}" broke the preview of \`${cause.route}\` on two turns running in UI Workbench pass "${pass.name}". ${move} Not Now leaves it in the pass as it is.`,
        line: `The preview of \`${cause.route}\` broke on two turns running: "Move to a Separate Copy" waits in the Inbox.`,
        notNow: 'Leaves the page in the pass as it is',
      };
}

/**
 * Raises, or refreshes, the task's one Move to a Separate Copy card, in the caller's write; a new
 * card puts one line on the page's thread. Once the builder answered Not Now in this pass, no card
 * is raised again: the answered one is named, with `notNow`.
 */
export function askMoveToCopy(
  ctx: WriteContext,
  input: {
    readonly pass: PassDto;
    readonly taskId: TaskId;
    readonly workstreamId: WorkstreamId;
    readonly cause: MoveToCopyCause;
  },
): {
  readonly inboxId: InboxItemId;
  readonly notNow: boolean;
  /** A broken preview met the task's open hazard card and left it as it is. */
  readonly hazardCard: boolean;
} {
  const answered = notNowAnswered(ctx.tx, input.pass, input.taskId, input.cause);
  if (answered !== undefined) return { inboxId: answered.id, notNow: true, hazardCard: false };
  const task = getTask(ctx.tx, input.taskId);
  const key = moveToCopyKey(input.taskId);
  const open = findOpenByFoldKey(ctx.tx, input.pass.projectId, key);
  // A hazard's card says what the agent waits on: a broken preview never words it over.
  if (open !== undefined && 'route' in input.cause) {
    // The detail is JSON read back from the database: a boundary, so parse it.
    const held = PassMoveToCopyDetail.safeParse(open.detail);
    if (held.success && held.data.hazard !== null)
      return { inboxId: open.id, notNow: false, hazardCard: true };
  }
  const raised = open === undefined;
  const detail: PassMoveToCopyDetail = {
    kind: 'pass_move_to_copy',
    passId: input.pass.id,
    taskId: input.taskId,
    workstreamId: input.workstreamId,
    hazard: 'hazard' in input.cause ? input.cause.hazard : null,
    route: 'route' in input.cause ? input.cause.route : null,
  };
  const words = moveWords(input.cause, task, input.pass);
  const card = flagCard(ctx, {
    projectId: input.pass.projectId,
    workstreamId: input.workstreamId,
    title: `Move "${task.title}" to a separate copy?`,
    body: words.body,
    foldKey: key,
    refresh: true,
    detail,
    options: [
      {
        label: PASS_MOVE_TO_COPY_CHOICE,
        description: 'Takes the page out of the pass and starts it in a separate copy',
      },
      { label: PASS_NOT_NOW_CHOICE, description: words.notNow },
    ],
  });
  if (raised) insertSystemNotice(ctx, input.taskId, words.line);
  return { inboxId: card.id, notNow: false, hazardCard: false };
}

/** What the move needs: a take-out's, and the start of a task in a separate copy. */
export type MoveToCopyDeps = TakeOutDeps & {
  /** Starts the task, placed in a separate copy, as the Board's Start does. */
  readonly startInCopy: (taskId: TaskId) => void;
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The card's answer. Move takes the task out of its pass, places it in a separate copy and starts
 * it there; a task no longer in the card's pass, or on another run than the card's, is left as it
 * is. Not Now does nothing. A move that fails says why on the task's thread. Never rejects.
 */
export async function answerMoveToCopy(
  deps: MoveToCopyDeps,
  item: InboxItemDto,
  answer: InboxAnswer,
): Promise<void> {
  // The detail is JSON read back from the database: a boundary, so parse it.
  const detail = PassMoveToCopyDetail.safeParse(item.detail);
  if (!detail.success || answer.choice !== PASS_MOVE_TO_COPY_CHOICE) return;
  const { taskId, workstreamId, hazard, route } = detail.data;
  const db = deps.state.db;
  const task = getTask(db, taskId);
  if (passHoldingTask(db, task)?.id !== detail.data.passId || task.workstreamId !== workstreamId)
    return;
  try {
    const out = await takeOut(deps, { taskId, within: TakeOutWithin.Alone });
    if (!out.tookOut) return;
    deps.state.write((ctx) => {
      placeTaskByRule(ctx, taskId, {
        workspaceMode: WorkspaceMode.Worktree,
        reason:
          hazard === null ? `broke the preview of ${route ?? 'its page'}` : `touches ${hazard}`,
      });
    });
    deps.startInCopy(taskId);
  } catch (error) {
    deps.logger.warn({ taskId, err: errorText(error) }, 'task not moved to a separate copy');
    deps.state.write((ctx) => {
      insertSystemNotice(ctx, taskId, `Not moved to a separate copy: ${errorText(error)}`);
    });
  }
}
