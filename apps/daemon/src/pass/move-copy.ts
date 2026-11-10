import {
  Delivery,
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
  getTask,
  insertSystemNotice,
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
// and the thread says the page will be slow.

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
export function moveToCopyInstruction(name: string): string {
  return `The ${name} hazard runs in a separate copy, not in the Workbench pass's folder, and the builder is asked whether to move this task to one. Don't change any file of the ${name} hazard: finish what you can without it, end your turn and say what is left.`;
}

/** Raises, or refreshes, the task's one Move to a Separate Copy card, in the caller's write. */
export function askMoveToCopy(
  ctx: WriteContext,
  input: {
    readonly pass: PassDto;
    readonly taskId: TaskId;
    readonly workstreamId: WorkstreamId;
    readonly hazard: string;
  },
): InboxItemId {
  const task = getTask(ctx.tx, input.taskId);
  const detail: PassMoveToCopyDetail = {
    kind: 'pass_move_to_copy',
    passId: input.pass.id,
    taskId: input.taskId,
    workstreamId: input.workstreamId,
    hazard: input.hazard,
  };
  return flagCard(ctx, {
    projectId: input.pass.projectId,
    workstreamId: input.workstreamId,
    title: `Move "${task.title}" to a separate copy?`,
    body: `"${task.title}" asked for the ${input.hazard} hazard, which runs in a separate copy, not in Your folder while Workbench pass "${input.pass.name}" is open. Move takes the page out of the pass with its work kept and starts the task in a separate copy, its work put back there. Not Now leaves it in the pass without the hazard.`,
    foldKey: moveToCopyKey(input.taskId),
    refresh: true,
    detail,
    options: [
      {
        label: PASS_MOVE_TO_COPY_CHOICE,
        description: 'Takes the page out of the pass and starts it in a separate copy',
      },
      { label: PASS_NOT_NOW_CHOICE, description: 'Leaves the page in the pass without the hazard' },
    ],
  }).id;
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
  const { taskId, workstreamId, hazard } = detail.data;
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
        reason: `touches ${hazard}`,
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
