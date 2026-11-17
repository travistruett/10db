import {
  ChatId as ChatIdSchema,
  ConflictError,
  WorkPlace,
  type ChatId,
  type ChatWork,
  type InboxAnswer,
  type InboxItemDto,
  type InboxOption,
  type SessionId,
} from '@10db/contracts';
import {
  chatView,
  findOpenByFoldKey,
  getChat,
  getProject,
  setChatWork,
  type WriteContext,
} from '@10db/db';
import { BUSY, type ExploreEngine } from '../conversation';
import type { StateStore } from '../events';
import type { FolderHold } from '../folder-hold';
import { flagCard, withdrawCard } from '../inbox';
import type { Logger } from '../log';
import { chatWorkCardKey, CHAT_WORK_CARD_DETAIL } from './work-card';
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
}

export interface ChatWorkService {
  /** A reading session's first change: asks where, once; a later one only raises `askedAt`. */
  firstChange(chatId: ChatId, sessionId?: SessionId): void;
  /**
   * The builder's choice of where the work happens. A repeat of the settled choice answers it; any other
   * choice is a `ChatWorkConflict` carrying the settled state.
   */
  choose(chatId: ChatId, place: 'here' | 'branch'): Promise<ChatWork>;
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

export function createChatWorkService(deps: ChatWorkServiceDeps): ChatWorkService {
  const { state, engine, log } = deps;
  const choosing = new Set<ChatId>();
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

  return {
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
      if (place === 'branch')
        throw new ChatWorkConflict('Starting a new branch is not available yet.', current);
      choosing.add(chatId);
      try {
        return await chooseHere(chatId);
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
          flagCard(ctx, {
            projectId: chat.projectId,
            workstreamId: null,
            title: 'Where should this session change files?',
            body: `The session “${chat.title ?? 'New session'}” wants to change files in ${project.name}. It has only read so far.`,
            foldKey: chatWorkCardKey(chatId),
            options: chatWorkOptions(branch),
            detail: { [CHAT_WORK_CARD_DETAIL]: chatId, conversationId: chat.conversationId },
          });
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
