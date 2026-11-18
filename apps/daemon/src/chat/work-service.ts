import {
  CHAT_DEFAULT_TITLE,
  ChatId as ChatIdSchema,
  ConflictError,
  ConversationItemAuthor,
  ConversationItemKind,
  WorkPlace,
  type ChatId,
  type ChatWork,
  type ChatWorkStateDto,
  type InboxAnswer,
  type InboxItemDto,
  type InboxOption,
  type ProjectDto,
  type SessionId,
} from '@10db/contracts';
import {
  chatsInPlace,
  chatView,
  findOpenByFoldKey,
  getChat,
  getProject,
  insertItem,
  setChatWork,
  type ChatRow,
  type WriteContext,
} from '@10db/db';
import { BUSY, type ExploreEngine } from '../conversation';
import type { StateStore } from '../events';
import type { FolderHold } from '../folder-hold';
import { flagCard, withdrawCard } from '../inbox';
import type { Logger } from '../log';

import { chatWorkCardKey, CHAT_WORK_CARD_DETAIL } from './work-card';
import type { ChatWorkStateReader } from './work-state';
import { enterHere, takeHereForGitTool } from './work-takes-checkout';
import { checkoutBranchNow } from './checkout-branch';

// Where a session's work happens (the place table in the sessions plan): the question a first change asks, and the
// choice that answers it. The state machine is `work-place.ts`; this applies it to the store and the engine.

export interface ChatWorkServiceDeps {
  readonly state: StateStore;
  readonly engine: ExploreEngine;
  readonly folderHold: FolderHold;
  /** Posts the message that resumes a session after the builder's choice, and asks for its turn. */
  readonly carryOn: (chatId: ChatId, text: string) => void;
  readonly log: Logger;
  readonly now: () => Date;
  /** What the move to a new branch needs of git and the worktree root. */
  readonly move: ChatMoveDeps;
  /** The git and GitHub facts the title row reads. */
  readonly facts: ChatWorkStateReader;
  /** The sessions whose next start says they moved: the move adds a chat, the session's start takes it. */
  readonly firstStartAfterMove: Set<ChatId>;
}

export interface ChatMoveDeps {
  /** Picks the branch and the worktree path a session's title claims, unique among git's and the recorded ones. */
  pick(
    project: ProjectDto,
    title: string,
  ): Promise<{ readonly branch: string; readonly path: string }>;
  /** A free worktree path for a branch that already exists, for a session reopened from it. */
  pathFor(project: ProjectDto, branch: string): Promise<string>;
  /** Cuts the worktree the row names; null when the daemon is stopping, with everything left for the restart. */
  cut(
    chat: ChatRow,
    project: ProjectDto,
    signal: AbortSignal,
  ): Promise<{ readonly baseHead: string } | null>;
  /** Aborts when the daemon stops. */
  readonly signal: AbortSignal;
}

export interface ChatWorkService {
  /** A reading session's first change: asks where, once; a later one only raises `askedAt`. */
  firstChange(chatId: ChatId, sessionId?: SessionId): void;
  /**
   * The builder's choice of where the work happens. A repeat of the settled choice answers it; any other
   * choice is a `ChatWorkConflict` carrying the settled state.
   */
  choose(chatId: ChatId, place: 'here' | 'branch'): Promise<ChatWork>;
  /** A push, pull request or merge the judge allowed: Here, and the turn takes the checkout. */
  takeHereForGitTool(chatId: ChatId): void;
  /** A reading or choosing session works Here from now on, its card withdrawn; any other place is untouched. */
  enterHere(chatId: ChatId): void;
  /** The facts the title row and the bar are drawn from, read now from the session's root. */
  state(chatId: ChatId, signal: AbortSignal): Promise<ChatWorkStateDto>;
  /** A pull request of the session's branch was opened or merged: its next read asks GitHub afresh. */
  forgetPullRequest(chatId: ChatId, branch?: string): void;
  /** Why the last move of this session failed, in the bar's words; null once it works or before any move. */
  moveFailure(chatId: ChatId): string | null;
  /** Resolves once the session's move, if one runs, has ended; for a caller that must not act mid-move. */
  moveSettled(chatId: ChatId): Promise<void>;
  /**
   * A branch session with no worktree (archived, swept) is reopened: it records a fresh path and remakes the
   * worktree from its branch, with no turn, notice or carry-on. One that is not such a session is left alone.
   */
  reopen(chatId: ChatId): Promise<void>;
  /** Holds the starts of every session a restart found moving, before the engine recovers. */
  holdMoving(): void;
  /** Runs each session's interrupted move again, idempotent by path, and waits for them. */
  finishMoves(): Promise<void>;
}

/** A choice that arrived after another one won, or that the session's place does not take. */
export class ChatWorkConflict extends ConflictError {
  readonly work: ChatWork | null;
  constructor(message: string, work: ChatWork | null) {
    super(message);
    this.work = work;
  }
}

const NOT_ASKED_WORDS = 'This session has not asked where to work.';
const SETTLED_WORDS = 'Where this session works is already chosen.';

/**
 * Acts on the answer to the card a first change raised, inside the write that closes it: the choice is read from
 * the answered option's position, never from its label. The card's choice runs once that write has committed,
 * since naming a branch needs git; a choice the bar already made is ignored.
 */
export function applyChatWorkAnswer(
  work: Pick<ChatWorkService, 'choose'>,
  log: Logger,
  _ctx: WriteContext,
  item: InboxItemDto,
  answer: InboxAnswer,
): (() => void) | undefined {
  const named = ChatIdSchema.safeParse(item.detail?.[CHAT_WORK_CARD_DETAIL]);
  if (!named.success) return undefined;
  const index = item.options.findIndex((o) => o.label === answer.choice);
  const place = index === 0 ? 'here' : index === 1 ? 'branch' : null;
  if (place === null) return undefined;
  return () => {
    work.choose(named.data, place).catch((error: unknown) => {
      if (error instanceof ConflictError) return;
      log.warn({ err: error, chatId: named.data }, 'the answer to a session’s question failed');
    });
  };
}

/** The options of the card a first change raises, in the order a card's answer maps them. */
export function chatWorkOptions(branch: string | null): readonly InboxOption[] {
  const here = branch === null ? 'Here' : `Here, on ${branch}`;
  return [
    {
      label: here,
      description:
        branch === null
          ? 'The session changes files in your checkout, as a chat does today.'
          : `The session changes files in your checkout, on ${branch}.`,
    },
    {
      label: 'On a New Branch',
      description:
        'The same conversation goes on in its own worktree, on a new branch cut from the commit you are on.',
    },
  ];
}

/** Raises the card that asks where a session's work goes; one per session, folded by its key. */
function raiseChoiceCard(
  ctx: WriteContext,
  chat: ChatRow,
  project: ProjectDto,
  branch: string | null,
): void {
  flagCard(ctx, {
    projectId: chat.projectId,
    workstreamId: null,
    title: 'Where should this session change files?',
    body: `The session “${chat.title ?? 'New session'}” wants to change files in ${project.name}. It has only read so far.`,
    foldKey: chatWorkCardKey(chat.id),
    options: chatWorkOptions(branch),
    detail: { [CHAT_WORK_CARD_DETAIL]: chat.id, conversationId: chat.conversationId },
  });
}

export function createChatWorkService(deps: ChatWorkServiceDeps): ChatWorkService {
  const { state, engine, log } = deps;
  const choosing = new Set<ChatId>();
  const failures = new Map<ChatId, string>();
  const moves = new Map<ChatId, Promise<void>>();
  const workOf = (chatId: ChatId): ChatWork | null => chatView(state.db, chatId).work;

  async function chooseHere(chatId: ChatId): Promise<ChatWork> {
    const chat = getChat(state.db, chatId);
    engine.holdStarts(chat.conversationId);
    try {
      if (BUSY.has(engine.view(chat.conversationId).state)) {
        await engine.stop(chat.conversationId);
        await engine.settled(chat.conversationId);
      }
      const applied = state.write((ctx) => {
        if (!setChatWork(ctx, chatId, WorkPlace.Choosing, { place: WorkPlace.Here })) return false;
        const card = findOpenByFoldKey(ctx.tx, chat.projectId, chatWorkCardKey(chatId));
        if (card !== undefined) withdrawCard(ctx, card.id);
        return true;
      });
      if (!applied) throw new ChatWorkConflict(SETTLED_WORDS, workOf(chatId));
      const branch = checkoutBranchNow(getProject(state.db, chat.projectId).repoPath);
      deps.carryOn(
        chatId,
        `The builder chose to work here${branch === null ? '' : `, on ${branch}`}. Carry on.`,
      );
    } finally {
      // A turn that waits for the checkout stays parked: its wait releases it.
      if (!deps.folderHold.waiting(chatId)) engine.releaseStarts(chat.conversationId);
    }
    const settled = workOf(chatId);
    if (settled === null) throw new ChatWorkConflict(NOT_ASKED_WORDS, null);
    return settled;
  }

  /** Records the move and starts it: the answer does not wait for the cut. */
  async function chooseBranch(chatId: ChatId): Promise<ChatWork> {
    const chat = getChat(state.db, chatId);
    const project = getProject(state.db, chat.projectId);
    engine.holdStarts(chat.conversationId);
    let recorded = false;
    try {
      for (let attempt = 0; !recorded; attempt += 1) {
        const picked = await deps.move.pick(project, chat.title ?? CHAT_DEFAULT_TITLE);
        try {
          recorded = state.write((ctx) => {
            if (
              !setChatWork(ctx, chatId, WorkPlace.Choosing, {
                place: WorkPlace.Moving,
                branch: picked.branch,
                worktreePath: picked.path,
              })
            )
              return false;
            const card = findOpenByFoldKey(ctx.tx, chat.projectId, chatWorkCardKey(chatId));
            if (card !== undefined) withdrawCard(ctx, card.id);
            return true;
          });
          if (!recorded) throw new ChatWorkConflict(SETTLED_WORDS, workOf(chatId));
        } catch (error) {
          // Another session took the same path between the pick and the write: pick again, once.
          if (error instanceof ChatWorkConflict || attempt > 0) throw error;
        }
      }
      // A turn still running is stopped here, not waited for: the move's own step closes the warm session.
      if (BUSY.has(engine.view(chat.conversationId).state)) await engine.stop(chat.conversationId);
    } catch (error) {
      if (!recorded) engine.releaseStarts(chat.conversationId);
      throw error;
    }
    failures.delete(chatId);
    startMove(chatId);
    const settled = workOf(chatId);
    if (settled === null) throw new ChatWorkConflict(NOT_ASKED_WORDS, null);
    return settled;
  }

  /** Runs a recorded move on its own; the one run per chat is kept so nothing starts a second. */
  function startMove(chatId: ChatId): void {
    if (moves.has(chatId)) return;
    const run = runMove(chatId)
      .catch((error: unknown) => {
        log.warn({ err: error, chatId }, 'a session’s move failed');
      })
      .finally(() => {
        moves.delete(chatId);
      });
    moves.set(chatId, run);
  }

  async function runMove(chatId: ChatId): Promise<void> {
    const chat = getChat(state.db, chatId);
    const project = getProject(state.db, chat.projectId);
    const reopen = chat.baseHead !== null;
    try {
      let made: { readonly baseHead: string } | null;
      try {
        made = await deps.move.cut(chat, project, deps.move.signal);
      } catch (error) {
        failMove(chat, project, error instanceof Error ? error.message : String(error), reopen);
        return;
      }
      // A stopping daemon leaves the move for its restart: the row stays moving and the starts stay held.
      if (made === null) return;
      await engine.relocate(chat.conversationId);
      const base = checkoutBranchNow(project.repoPath) ?? made.baseHead.slice(0, 7);
      const branch = chat.branch ?? '';
      const done = state.write((ctx) => {
        if (
          !setChatWork(ctx, chatId, WorkPlace.Moving, {
            place: WorkPlace.Branch,
            baseHead: made.baseHead,
          })
        )
          return false;
        if (!reopen)
          insertItem(ctx, chat.conversationId, {
            author: ConversationItemAuthor.System,
            kind: ConversationItemKind.Notice,
            body: { text: `Moved to a new branch, ${branch}, from ${base}.` },
          });
        return true;
      });
      if (!done) return;
      if (!reopen) {
        deps.firstStartAfterMove.add(chatId);
        deps.carryOn(chatId, `The builder chose a new branch, ${branch}. Carry on.`);
      }
      engine.releaseStarts(chat.conversationId);
    } catch (error) {
      engine.releaseStarts(chat.conversationId);
      throw error;
    }
  }

  /** A move that could not make its worktree: back to the question, or for a reopen to a branch with none. */
  function failMove(chat: ChatRow, project: ProjectDto, words: string, reopen: boolean): void {
    failures.set(chat.id, words);
    const at = deps.now().toISOString();
    state.write((ctx) => {
      if (reopen) {
        setChatWork(ctx, chat.id, WorkPlace.Moving, {
          place: WorkPlace.Branch,
          worktreePath: null,
        });
        insertItem(ctx, chat.conversationId, {
          author: ConversationItemAuthor.System,
          kind: ConversationItemKind.Notice,
          body: { text: `This session's worktree could not be made again: ${words}` },
        });
        return;
      }
      if (
        setChatWork(ctx, chat.id, WorkPlace.Moving, {
          place: WorkPlace.Choosing,
          branch: null,
          worktreePath: null,
          askedAt: at,
        })
      )
        raiseChoiceCard(ctx, chat, project, checkoutBranchNow(project.repoPath));
    });
    engine.releaseStarts(chat.conversationId);
  }

  return {
    async reopen(chatId) {
      const chat = getChat(state.db, chatId);
      if (
        chat.workPlace !== WorkPlace.Branch ||
        chat.worktreePath !== null ||
        chat.branch === null ||
        chat.baseHead === null ||
        chat.archivedAt !== null ||
        moves.has(chatId)
      )
        return;
      const project = getProject(state.db, chat.projectId);
      engine.holdStarts(chat.conversationId);
      let recorded = false;
      try {
        for (let attempt = 0; !recorded && attempt < 2; attempt += 1) {
          const path = await deps.move.pathFor(project, chat.branch);
          try {
            recorded = state.write((ctx) =>
              setChatWork(ctx, chatId, WorkPlace.Branch, {
                place: WorkPlace.Moving,
                worktreePath: path,
              }),
            );
            if (!recorded) return;
          } catch {
            // Another session took the same path between the pick and the write: pick again, once.
          }
        }
      } finally {
        if (!recorded) engine.releaseStarts(chat.conversationId);
      }
      if (recorded) startMove(chatId);
    },

    holdMoving() {
      for (const chat of chatsInPlace(state.db, WorkPlace.Moving))
        engine.holdStarts(chat.conversationId);
    },

    async finishMoves() {
      const moving = chatsInPlace(state.db, WorkPlace.Moving);
      for (const chat of moving) startMove(chat.id);
      for (const chat of moving) await moves.get(chat.id);
    },

    state: (chatId, signal) => deps.facts.read(chatId, signal, failures.get(chatId) ?? null),
    forgetPullRequest(chatId, branch) {
      const chat = getChat(state.db, chatId);
      const named = branch ?? chat.branch;
      if (named !== null) deps.facts.forgetPullRequest(chat.projectId, named);
    },
    moveFailure: (chatId) => failures.get(chatId) ?? null,
    moveSettled: async (chatId) => {
      await moves.get(chatId);
    },

    enterHere: (chatId) => {
      enterHere(state, chatId);
    },

    takeHereForGitTool: (chatId) => {
      takeHereForGitTool({ state, folderHold: deps.folderHold }, chatId);
    },

    async choose(chatId, place) {
      const chat = getChat(state.db, chatId);
      const current = workOf(chatId);
      if (chat.workPlace === null) throw new ChatWorkConflict(NOT_ASKED_WORDS, null);
      const settledChoice =
        place === 'here'
          ? chat.workPlace === WorkPlace.Here
          : chat.workPlace === WorkPlace.Moving || chat.workPlace === WorkPlace.Branch;
      if (settledChoice && current !== null) return current;
      if (chat.workPlace !== WorkPlace.Choosing || choosing.has(chatId))
        throw new ChatWorkConflict(SETTLED_WORDS, current);
      choosing.add(chatId);
      try {
        return place === 'branch' ? await chooseBranch(chatId) : await chooseHere(chatId);
      } finally {
        choosing.delete(chatId);
      }
    },

    firstChange(chatId) {
      const at = deps.now().toISOString();
      const chat = getChat(state.db, chatId);
      const project = getProject(state.db, chat.projectId);
      const branch = checkoutBranchNow(project.repoPath);
      const place = state.write((ctx) => {
        if (setChatWork(ctx, chatId, null, { place: WorkPlace.Choosing, askedAt: at })) {
          raiseChoiceCard(ctx, chat, project, branch);
          return WorkPlace.Choosing;
        }
        // Another first change while choosing only asks the bar to show again.
        if (
          setChatWork(ctx, chatId, WorkPlace.Choosing, { place: WorkPlace.Choosing, askedAt: at })
        )
          return WorkPlace.Choosing;
        return getChat(ctx.tx, chatId).workPlace;
      });
      if (place !== WorkPlace.Choosing) return;
      // The turn stops once the hook has answered: a stop from inside the call would cancel the call's answer,
      // and the denied call would read as cancelled instead of as waiting for the builder.
      setImmediate(() => {
        // A store closed since (a daemon stopping) has nothing left to stop.
        const stopping = (async () => {
          if (!BUSY.has(engine.view(chat.conversationId).state)) return;
          await engine.stop(chat.conversationId);
        })();
        stopping.catch((error: unknown) => {
          log.warn({ err: error, chatId }, 'a session could not be stopped for its first change');
        });
      });
    },
  };
}
