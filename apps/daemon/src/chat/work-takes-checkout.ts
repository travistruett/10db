import { ConflictError, WorkPlace, type ChatId } from '@10db/contracts';
import { findOpenByFoldKey, getChat, setChatWork } from '@10db/db';
import type { StateStore } from '../events';
import { holderWords, type FolderHold } from '../folder-hold';
import { withdrawCard } from '../inbox';
import { chatWorkCardKey } from './work-card';

// Push, open pull request and merge change the builder's checkout state, so a session that has not asked where to
// work becomes a Here session when the judge lets one of them through.

export interface TakeHereDeps {
  readonly state: StateStore;
  readonly folderHold: FolderHold;
}

/**
 * A reading or choosing session becomes a Here session: a compare-and-set on the place it was in, with the card
 * that asked where withdrawn in the same write. A session in any other place is left as it is.
 */
export function enterHere(state: StateStore, chatId: ChatId): void {
  const chat = getChat(state.db, chatId);
  if (chat.workPlace !== null && chat.workPlace !== WorkPlace.Choosing) return;
  state.write((ctx) => {
    if (!setChatWork(ctx, chatId, chat.workPlace, { place: WorkPlace.Here })) return;
    const card = findOpenByFoldKey(ctx.tx, chat.projectId, chatWorkCardKey(chatId));
    if (card !== undefined) withdrawCard(ctx, card.id);
  });
}

/**
 * A reading or choosing session's allowed git call: the session goes Here (a compare-and-set, with its card
 * withdrawn) and its turn takes the checkout. When another holder has it, the call is refused with the holder's
 * words and the session stays Here. A session already Here, or on a branch, is left as it is.
 */
export function takeHereForGitTool(deps: TakeHereDeps, chatId: ChatId): void {
  const chat = getChat(deps.state.db, chatId);
  enterHere(deps.state, chatId);
  if (getChat(deps.state.db, chatId).workPlace !== WorkPlace.Here) return;
  const taken = deps.folderHold.takeTurn(chat.projectId, chatId);
  if (!taken.taken)
    throw new ConflictError(
      `This session works in your checkout now, but ${taken.blockers.map((b) => holderWords(b.holder)).join(' and ')} has it. Try again once it is done.`,
    );
}
