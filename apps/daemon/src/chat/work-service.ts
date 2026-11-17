import { WorkPlace, type ChatId, type InboxOption, type SessionId } from '@10db/contracts';
import { getChat, getProject, setChatWork } from '@10db/db';
import { BUSY, type ExploreEngine } from '../conversation';
import type { StateStore } from '../events';
import { flagCard } from '../inbox';
import type { Logger } from '../log';
import { chatWorkCardKey, CHAT_WORK_CARD_DETAIL } from './work-card';
import { checkoutBranchNow } from './checkout-branch';

// Where a session's work happens (the place table in the sessions plan): the question a first change asks, and the
// choice that answers it. The state machine is `work-place.ts`; this applies it to the store and the engine.

export interface ChatWorkServiceDeps {
  readonly state: StateStore;
  readonly engine: ExploreEngine;
  readonly log: Logger;
  readonly now: () => Date;
}

export interface ChatWorkService {
  /** A reading session's first change: asks where, once; a later one only raises `askedAt`. */
  firstChange(chatId: ChatId, sessionId?: SessionId): void;
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

  return {
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
