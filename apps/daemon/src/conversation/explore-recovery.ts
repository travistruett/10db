import {
  ConversationItemAuthor,
  ConversationItemKind,
  ConversationState,
  InboxItemId,
  type InboxItemId as InboxItemIdType,
} from '@10db/contracts';
import {
  endConversationSessions,
  insertItem,
  lastItems,
  listPushedTurnStarters,
  markItemsHandedBack,
  markItemsTakenUnder,
  type ConversationItemRow,
  type ConversationRow,
} from '@10db/db';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import type { AgentAdapter } from '../sessions';
import type { AgentCapabilitiesDto } from '@10db/contracts';
import type { ExploreOwnerHooks } from './explore-hooks';

// Sessions spec §6.3, §6.4: what a start does for an explore conversation before its state is reduced
// by the restart row. Its sessions ended with the daemon; what they were handed and never seen taken
// is taken when the agent's conversation shows it (rule 5), else handed back to wait; a turn cut off
// with nothing stored says so; a card it waited on goes.

/** What a conversation reads when a turn was running as 10db stopped and nothing of it was kept. */
export const INTERRUPTED_NOTICE = 'The turn was interrupted when 10db stopped.';

/** How far back the restart looks for the cut-off turn's own items. */
const TURN_LOOKBACK = 500;

const CUT_OFF: ReadonlySet<ConversationState> = new Set([
  ConversationState.Running,
  ConversationState.WaitingCard,
  ConversationState.Stopping,
]);

const isStarter = (item: ConversationItemRow): boolean =>
  (item.author === ConversationItemAuthor.Builder && item.kind === ConversationItemKind.Message) ||
  (item.kind === ConversationItemKind.ShapeEvent &&
    typeof item.body === 'object' &&
    item.body !== null &&
    !Array.isArray(item.body) &&
    typeof item.body['prompt'] === 'string');

/**
 * The cut-off turn's items, newest first, back to the last starter a turn was seen to take: what the
 * cut-off turn began with, and what was injected into it, were handed and not yet seen taken.
 */
function turnItems(state: StateStore, conv: ConversationRow): ConversationItemRow[] {
  const turn: ConversationItemRow[] = [];
  for (const item of lastItems(state.db, conv.id, TURN_LOOKBACK).reverse()) {
    if (isStarter(item) && item.deliveredAt !== null) break;
    turn.push(item);
  }
  return turn;
}

export interface RestartFound {
  /** The cards the cut-off turn waited on, to withdraw. */
  readonly cards: readonly InboxItemIdType[];
}

/** The restart's writes for one conversation, before the restart row is reduced. */
export async function settleRestart(
  deps: {
    readonly state: StateStore;
    readonly adapter: Pick<AgentAdapter, 'readClientUuids'>;
    readonly log: Logger;
  },
  conv: ConversationRow,
  hooks: ExploreOwnerHooks,
  capabilities: Pick<AgentCapabilitiesDto, 'readBack'>,
): Promise<RestartFound> {
  const { state } = deps;
  const cutOff = conv.state !== null && CUT_OFF.has(conv.state);
  const turn = cutOff ? turnItems(state, conv) : [];
  state.write((ctx) => {
    endConversationSessions(ctx, conv.id, 'daemon_restart');
  });
  // Rule 5: what the agent's own conversation shows taken is delivered; the rest waits again.
  const pushed = listPushedTurnStarters(state.db, conv.id);
  const oldest = pushed[0];
  if (
    oldest !== undefined &&
    capabilities.readBack &&
    conv.providerSessionId !== null &&
    hooks.readBackSpec !== undefined
  ) {
    try {
      const spec = await hooks.readBackSpec(conv);
      const held = await deps.adapter.readClientUuids({
        ...spec,
        providerSessionId: conv.providerSessionId,
        wanted: pushed.flatMap((item) => item.pushUuids),
        since: oldest.createdAt,
      });
      state.write((ctx) => markItemsTakenUnder(ctx, conv.id, held));
    } catch (error) {
      deps.log.warn(
        { err: error, conversationId: conv.id },
        'an explore conversation was not read back',
      );
    }
  }
  const left = listPushedTurnStarters(state.db, conv.id).map((item) => item.id);
  state.write((ctx) => {
    markItemsHandedBack(ctx, conv.id, left);
    // A turn cut off by a crash kept nothing; a clean stop stored what streamed, marked partial.
    if (cutOff && !turn.some((item) => item.partial))
      insertItem(ctx, conv.id, {
        author: ConversationItemAuthor.System,
        kind: ConversationItemKind.Notice,
        body: { text: INTERRUPTED_NOTICE },
      });
  });
  const cards = turn.flatMap((item) => {
    if (item.kind !== ConversationItemKind.Card) return [];
    const id = InboxItemId.safeParse(
      typeof item.body === 'object' && item.body !== null && !Array.isArray(item.body)
        ? item.body['inboxItemId']
        : undefined,
    );
    return id.success ? [id.data] : [];
  });
  return { cards };
}
