import {
  ConflictError,
  ConversationState,
  Delivery,
  DO_IT_CHANGED_MAX,
  DoItPlace,
  FolderAsker,
  FolderHolderKind,
  InvalidError,
  WorkspaceMode,
  type ChatId,
  type DoItOfferDto,
  type DoItPreviewDto,
  type DoItRefusalDto,
  type DoItRequest,
  type DoItResult,
  type ProjectDto,
  type ProjectId,
  type TaskDto,
  type TaskId,
  type TaskInput,
} from '@10db/contracts';
import {
  chatsHandedToCopies,
  getChat,
  getProject,
  getTask,
  latestWorkstreamOf,
  linkChatToTask,
  listItems,
  storeHandedTo,
  unlinkChatFromTask,
  type DbReader,
} from '@10db/db';
import type { ExploreEngine } from '../conversation';
import type { StateStore } from '../events';
import { holderWords, type FolderHold } from '../folder-hold';
import type { Git } from '../git';
import type { Logger } from '../log';
import type { PendingOpens } from '../pass';
import { areasOfChat, editedPathsOf } from './chat-areas';
import type { ChatService } from './service';

// Sessions spec §7.3 (Do it): what the sheet shows before the builder decides, and the refusals each place
// has. The refusals are read here so the sheet says them up front, not only at submit.

export interface DoItDeps {
  readonly state: StateStore;
  readonly engine: Pick<ExploreEngine, 'view'>;
  readonly folderHold: Pick<FolderHold, 'blockers'>;
  readonly pendingOpens: Pick<PendingOpens, 'get'>;
  readonly git: Pick<
    Git,
    'changedEntries' | 'currentBranch' | 'operationInProgress' | 'trackingTip' | 'commitsSince'
  >;
  readonly chat: Pick<ChatService, 'briefOf' | 'stopForOpen' | 'seal'>;
  /** Why a pass of one can't open in the project, from the database alone, or null. */
  readonly openProblem: (db: DbReader, project: ProjectDto) => string | null;
  /** Why the branch HEAD names can't be a pass's return branch, or null. */
  readonly returnBranchProblem: (
    db: DbReader,
    project: ProjectDto,
    branch: string,
  ) => string | null;
  /** The name of the closed pass a new pass of one would stack on, or null. */
  readonly stacksOn: (db: DbReader, project: ProjectDto) => string | null;
}

/** What a copy's own task does: the services Do It reaches for the task it makes. */
export interface DoItTasks {
  create(projectId: ProjectId, input: TaskInput): Promise<TaskDto>;
  settleSizing(taskIds: readonly TaskId[]): Promise<void>;
  start(taskId: TaskId): unknown;
  remove(taskId: TaskId): unknown;
}

/** The criterion a copy's task gets when the brief names none. */
export const DEFAULT_CRITERION = "Does what the brief asks, and the project's checks pass.";

const refusal = (code: string, message: string, link: string | null): DoItRefusalDto => ({
  code,
  message,
  link,
});
const offered: DoItOfferDto = { offered: true, refusal: null, whenBusy: false };
const refused = (why: DoItRefusalDto, whenBusy = false): DoItOfferDto => ({
  offered: false,
  refusal: why,
  whenBusy,
});

/** Where a refusal sends the builder, as the desktop reads it. */
export const DoItLink = { Workbench: 'workbench', Board: 'board', Session: 'session' } as const;

export async function previewDoIt(deps: DoItDeps, chatId: ChatId): Promise<DoItPreviewDto> {
  const db = deps.state.db;
  const chat = getChat(db, chatId);
  const project = getProject(db, chat.projectId);
  const at = deps.engine.view(chat.conversationId).state;
  const own = refusalOfChat(chat.archivedAt !== null, at, chatId);
  const changed = await deps.git.changedEntries(project.repoPath, DO_IT_CHANGED_MAX);
  const branch = await deps.git.currentBranch(project.repoPath).catch(() => null);
  return {
    brief: deps.chat.briefOf(chatId),
    changed: changed.entries,
    more: changed.more,
    worktree:
      own !== null
        ? refused(own)
        : project.delivery === Delivery.Local
          ? refused(
              refusal(
                'local',
                'This project lands locally, so it has no separate copies. Do It goes to Your folder.',
                null,
              ),
            )
          : offered,
    here: own !== null ? refused(own) : await hereOffer(deps, project, chatId, branch),
    runningTurn:
      at === ConversationState.Starting ||
      at === ConversationState.Running ||
      at === ConversationState.WaitingCard ||
      at === ConversationState.Stopping,
    stacksOn: deps.stacksOn(db, project),
    base: project.delivery === Delivery.Local ? null : project.baseBranch,
    leftOut: project.delivery === Delivery.Local ? null : await leftOut(deps, project, branch),
  };
}

function refusalOfChat(
  archived: boolean,
  at: ConversationState,
  chatId: ChatId,
): DoItRefusalDto | null {
  if (archived) return refusal('archived', 'This session is archived.', null);
  if (at === ConversationState.Sealed)
    return refusal('sealed', 'This session was handed to a task.', null);
  if (at === ConversationState.TakenOver)
    return refusal(
      'taken_over',
      'Hand back first: the session is open in Claude Code.',
      `${DoItLink.Session}:${chatId}`,
    );
  return null;
}

async function hereOffer(
  deps: DoItDeps,
  project: ProjectDto,
  chatId: ChatId,
  branch: string | null,
): Promise<DoItOfferDto> {
  const db = deps.state.db;
  const open = deps.openProblem(db, project);
  if (open !== null) return refused(refusal('pass', open, `${DoItLink.Workbench}:${project.id}`));
  const pending = deps.pendingOpens.get(project.id);
  if (pending !== null)
    return refused(
      refusal(
        'pending_open',
        `A pass is already waiting to open: ‘${pending.name}’`,
        `${DoItLink.Workbench}:${project.id}`,
      ),
    );
  const others = deps.folderHold
    .blockers(project.id, { kind: FolderAsker.GitWork })
    .filter((b) => b.holder.chatId !== chatId);
  if (others.length > 0) {
    const words = others.map((b) => holderWords(b.holder)).join(' and ');
    const onlyChats = others.every((b) => b.holder.kind === FolderHolderKind.ChatTurn);
    return refused(
      refusal(
        'folder_in_use',
        `Your folder is in use by ${words}.`,
        onlyChats ? null : `${DoItLink.Board}:${project.id}`,
      ),
      onlyChats,
    );
  }
  const operation = await deps.git.operationInProgress(project.repoPath).catch(() => null);
  if (operation !== null)
    return refused(
      refusal(
        'operation',
        `Your folder is in the middle of ${operation.what}; finish it or stop it (${operation.end}) first.`,
        null,
      ),
    );
  if (branch === null)
    return refused(
      refusal(
        'detached',
        'Your folder is on no branch (a detached HEAD); switch to a branch first.',
        null,
      ),
    );
  const stray = deps.returnBranchProblem(db, project, branch);
  if (stray !== null) return refused(refusal('return_branch', stray, null));
  return offered;
}

/** The commits HEAD has that origin's base lacks, which a separate copy leaves out. */
async function leftOut(
  deps: DoItDeps,
  project: ProjectDto,
  branch: string | null,
): Promise<DoItPreviewDto['leftOut']> {
  try {
    const base = await deps.git.trackingTip(project.repoPath, project.baseBranch);
    if (base === null || branch === null) return null;
    const count = (await deps.git.commitsSince(project.repoPath, base, 'HEAD')).length;
    return count === 0 ? null : { branch, count };
  } catch {
    // What can't be counted says nothing; the copy starts from its base either way.
    return null;
  }
}

export interface DoItCopyDeps extends DoItDeps {
  readonly tasks: DoItTasks;
}

/**
 * Do It in a separate copy: the chat's turn stops, an ordinary task is made from the brief in its own
 * worktree and started, the chat is linked to it and closes its tab, and the chat is sealed. A start that is
 * refused leaves the chat as it was and the task removed.
 */
export async function doItInCopy(
  deps: DoItCopyDeps,
  chatId: ChatId,
  input: DoItRequest,
): Promise<DoItResult> {
  const db = deps.state.db;
  const chat = getChat(db, chatId);
  const project = getProject(db, chat.projectId);
  const own = refusalOfChat(
    chat.archivedAt !== null,
    deps.engine.view(chat.conversationId).state,
    chatId,
  );
  if (own !== null) throw new ConflictError(own.message);
  if (project.delivery === Delivery.Local)
    throw new ConflictError(
      'This project lands locally, so it has no separate copies. Do It goes to Your folder.',
    );
  const named = input.areas ?? [];
  for (const name of named)
    if (!project.areas.some((a) => a.name === name))
      throw new InvalidError(`${name} is not an area of ${project.name}`);
  const release = await deps.chat.stopForOpen(chatId, DoItPlace.Worktree);
  let task: TaskDto | null = null;
  try {
    const changed = await deps.git.changedEntries(project.repoPath, DO_IT_CHANGED_MAX);
    const areas =
      named.length > 0
        ? named
        : areasOfChat(project, [
            ...editedPathsOf(listItems(db, chat.conversationId), project.repoPath),
            ...changed.entries.map((e) => e.path),
          ]);
    const criteria = input.acceptanceCriteria ?? [];
    task = await deps.tasks.create(project.id, {
      title: input.title,
      description: input.brief,
      acceptanceCriteria: criteria.length > 0 ? [...criteria] : [DEFAULT_CRITERION],
      areas,
      workspaceMode: WorkspaceMode.Worktree,
    });
    await deps.tasks.settleSizing([task.id]);
    const made = task;
    // In one synchronous run: the link, then the start, then the notice that closes the tab.
    deps.state.write((ctx) => {
      linkChatToTask(ctx, chatId, { taskId: made.id, passId: null });
    });
    try {
      deps.tasks.start(made.id);
    } catch (error) {
      deps.state.write((ctx) => {
        unlinkChatFromTask(ctx, chatId, made.id);
      });
      throw error;
    }
    deps.state.write((ctx) => {
      storeHandedTo(
        ctx,
        chatId,
        { kind: 'handed_to', taskId: made.id, title: input.title, place: DoItPlace.Worktree },
        true,
      );
    });
  } catch (error) {
    if (task !== null) {
      const failed = task;
      try {
        deps.tasks.remove(failed.id);
      } catch {
        // A task that can't be removed stays on the Board for the builder; the refusal is what is reported.
      }
    }
    release();
    throw error;
  }
  try {
    await deps.chat.seal(chatId);
  } finally {
    release();
  }
  return { taskId: task.id, place: DoItPlace.Worktree };
}

export interface FinishSealsDeps {
  readonly state: StateStore;
  readonly engine: Pick<ExploreEngine, 'view'>;
  readonly chat: Pick<ChatService, 'seal'>;
  readonly tasks: Pick<DoItTasks, 'start'>;
  readonly logger: Logger;
}

/**
 * After recovery: a chat Do It linked to a task in a separate copy but did not finish with (the daemon stopped
 * between its steps) is sealed, its task started when it has no run, and its notice and closed tab stored. A start
 * that is refused shows as the task's Board state; the chat is sealed either way.
 */
export async function finishSeals(deps: FinishSealsDeps): Promise<void> {
  for (const chat of chatsHandedToCopies(deps.state.db)) {
    if (chat.taskId === null) continue;
    const taskId = chat.taskId;
    try {
      if (deps.engine.view(chat.conversationId).state !== ConversationState.Sealed)
        await deps.chat.seal(chat.id);
      if (latestWorkstreamOf(deps.state.db, taskId) === undefined) {
        try {
          deps.tasks.start(taskId);
        } catch (error) {
          deps.logger.warn(
            {
              chatId: chat.id,
              taskId,
              err: error instanceof Error ? error.message : String(error),
            },
            'the task of a chat Do It handed over could not start',
          );
        }
      }
      const task = getTask(deps.state.db, taskId);
      deps.state.write((ctx) => {
        storeHandedTo(
          ctx,
          chat.id,
          { kind: 'handed_to', taskId, title: task.title, place: DoItPlace.Worktree },
          true,
        );
      });
    } catch (error) {
      deps.logger.warn(
        { chatId: chat.id, err: error instanceof Error ? error.message : String(error) },
        'a chat Do It handed over could not be sealed',
      );
    }
  }
}
