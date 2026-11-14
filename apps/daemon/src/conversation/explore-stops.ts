import {
  ConversationItemAuthor,
  ConversationItemKind,
  ConversationState,
  type ConversationId,
} from '@10db/contracts';
import { deleteItem, lastItems, type ConversationItemRow } from '@10db/db';
import type { InterruptReceipt } from '../sessions';
import type { EngineCore, Runtime, Session } from './explore-runtime';
import type { ExploreTurns } from './explore-turns';

// Sessions spec §6.3 and calls 22, 25 and 30: how a turn stops. Stop interrupts; a receipt or the
// turn's own end settles the stop, and past the grace the session is stopped. Stop and Redo replaces
// the message it redoes when the agent never took it.

const S = ConversationState;

/** How far back a Redo looks for the builder's message it replaces. */
const REDO_LOOKBACK = 50;

export interface ExploreStops {
  /** Stops a session the engine is done with; resolves once it has ended, or the grace has passed. */
  stopSession(rt: Runtime, session: Session, reason: string): Promise<void>;
  /** `p`, or `fallback` once the stop grace has passed without it. */
  withinGrace<T>(p: Promise<T>, fallback: T): Promise<T>;
  /** A receipt that came while the stop waits: it settles the stop, unless a Redo decides first. */
  receiptCame(rt: Runtime, session: Session, receipt: InterruptReceipt | null): void;
  /** Neither a receipt nor the turn's end came within the grace: the session is stopped. */
  graceOver(rt: Runtime, session: Session): void;
  /** Stop, then the edited message as the next turn (call 30). */
  redo(
    id: ConversationId,
    post: () => ConversationItemRow,
    queued: (id: ConversationId) => void,
  ): Promise<ConversationItemRow>;
}

export function createStops(core: EngineCore, turns: ExploreTurns): ExploreStops {
  const { state, clock, log } = core.deps;

  const withinGrace = <T>(p: Promise<T>, fallback: T): Promise<T> =>
    new Promise((resolve) => {
      const timer = clock.setTimeout(() => {
        resolve(fallback);
      }, core.stopGraceMs);
      void p.then((value) => {
        timer.cancel();
        resolve(value);
      });
    });

  return {
    stopSession(rt, session, reason) {
      session.asked = true;
      session.endReason = reason;
      session.open.detach();
      rt.lastSession = session;
      if (rt.session === session) rt.session = null;
      rt.resuming = false;
      const ended = (async () => {
        try {
          await session.open.handle.stop();
        } catch (error) {
          log.warn(
            { err: error, conversationId: rt.id },
            'an explore session did not stop cleanly',
          );
        }
        await session.open.done;
        await session.released;
      })();
      // A session that does not end within the grace is let go: nothing after it waits on it forever.
      const stopped = withinGrace(ended, undefined).then(() => undefined);
      rt.closing = stopped;
      return stopped;
    },
    withinGrace,
    receiptCame(rt, session, receipt) {
      if (rt.session !== session || rt.state !== S.Stopping || !rt.inTurn || rt.redo !== null)
        return;
      session.open.skipTurn();
      turns.settleTurn(rt, turns.itemsOf(rt, receipt?.stillQueued ?? []));
      rt.ended = 'stopped';
      core.reduce(rt, { type: 'stop_settled' });
      turns.freshIfFull(rt);
    },
    graceOver(rt, session) {
      rt.grace = null;
      if (rt.session !== session || rt.state !== S.Stopping) return;
      turns.settleTurn(rt);
      turns.handBack(rt);
      rt.ended = 'stopped';
      core.reduce(rt, { type: 'stop_grace_passed' });
    },
    async redo(id, post, queued) {
      const rt = core.runtimeOf(id);
      const original =
        lastItems(state.db, id, REDO_LOOKBACK)
          .reverse()
          .find(
            (item) =>
              item.author === ConversationItemAuthor.Builder &&
              item.kind === ConversationItemKind.Message,
          ) ?? null;
      rt.redo = original?.id ?? null;
      core.reduce(rt, { type: 'stop' });
      // The interrupt is asked for on the chain; its receipt says whether the agent took the original.
      await new Promise<void>((resolve) => {
        core.enqueue(rt, resolve);
      });
      const asked = rt.receipt;
      const receipt = asked === null ? null : await withinGrace(asked, null);
      rt.redo = null;
      const session = rt.session;
      if (rt.state !== S.Stopping || session === null) {
        const edit = post();
        queued(id);
        return edit;
      }
      const untaken =
        original !== null &&
        receipt !== null &&
        turns.itemsOf(rt, receipt.stillQueued).has(original.id);
      if (rt.inTurn) {
        // The turn's own end is still to come: it is dropped when it does, unless its session goes.
        if (!untaken) session.open.skipTurn();
        turns.settleTurn(rt, turns.itemsOf(rt, receipt?.stillQueued ?? []));
      }
      rt.ended = 'stopped';
      // The edit is stored first: if it can't be, the original stays. The stop settles either way.
      try {
        const edit = post();
        // The agent would run the original by itself: it goes, and so does its session, so the edit
        // alone is sent.
        if (untaken)
          state.write((ctx) => {
            deleteItem(ctx, original.id);
          });
        return edit;
      } finally {
        if (untaken) {
          turns.handBack(rt);
          core.reduce(rt, { type: 'stop_grace_passed' });
        } else core.reduce(rt, { type: 'stop_settled' });
      }
    },
  };
}
