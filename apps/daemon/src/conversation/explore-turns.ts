import { randomUUID } from 'node:crypto';
import {
  ConversationItemKind,
  ConversationState,
  TurnMarker,
  type ConversationItemId,
} from '@10db/contracts';
import {
  hasItemOfKind,
  markFilesInline,
  markItemPushedUnder,
  markItemsDelivered,
  markItemsHandedBack,
  openTurnMarker,
  updateItem,
  type ConversationItemRow,
} from '@10db/db';
import { clientUuid } from './delivery-rules';
import type { Outgoing } from './explore-hooks';
import type { EngineCore, Runtime, Session } from './explore-runtime';

// Sessions spec §6.3: how a turn takes its starters. What waits is handed to the live session as
// one message under one uuid (rule 1), a turn begins with what it was handed, and what a session
// leaves untaken goes back to 10db's queue.

const S = ConversationState;

export interface ExploreTurns {
  /** Hands the live session starters as one message; false when the send failed and they went back. */
  handTo(rt: Runtime, session: Session, items: readonly ConversationItemRow[]): boolean;
  /** A turn begins with what waits: pushed now, or handed earlier and not taken. */
  beginTurn(rt: Runtime): void;
  /** Every starter the session holds goes back to 10db's queue (call 22). */
  handBack(rt: Runtime): void;
  /** The running turn is over: it took what it began with, but for what a receipt says is still queued. */
  settleTurn(rt: Runtime, stillQueued?: ReadonlySet<ConversationItemId>): void;
  /** The starters a session holds that went under one of `uuids`: every one a combined push carried. */
  itemsOf(rt: Runtime, uuids: readonly string[]): Set<ConversationItemId>;
  /** The open "Send now" line is resolved: what waited under it is on its way (calls 12, 29). */
  resolveSendNow(rt: Runtime): void;
  /** What streamed is kept as it stands now. */
  storePartialNow(rt: Runtime): void;
  /** The agent has spoken in the conversation, so a fresh session lacks what it said. */
  spoke(rt: Runtime): boolean;
  /** The session's context is strictly past the owner's limit. */
  pastContextLimit(rt: Runtime): boolean;
  /** Strictly past the owner's limit at a turn's end, the next start is fresh from the digest. */
  freshIfFull(rt: Runtime): void;
}

/** Several starters as one message, in `seq` order: what waited goes in one turn. */
export const combined = (outs: readonly Outgoing[]): Outgoing => ({
  text: outs.map((o) => o.text).join('\n\n'),
  images: outs.flatMap((o) => o.images),
  blocks: outs.flatMap((o) => o.blocks),
  sent: (ctx) => {
    for (const o of outs) o.sent(ctx);
  },
});

export function createTurns(core: EngineCore): ExploreTurns {
  const { state } = core.deps;

  /**
   * Pushed under the one uuid before the session is handed them (rule 1), then what the owner marks
   * once they are sent. A send that throws hands them back, tells nothing, says why, and answers false.
   */
  const handTo = (
    rt: Runtime,
    session: Session,
    items: readonly ConversationItemRow[],
  ): boolean => {
    const first = items[0];
    if (first === undefined) return true;
    const conv = core.conversation(rt.id);
    const hooks = core.hooksOf(conv);
    const limits = session.open.launch.limits;
    const out = combined(
      items.map((item) => hooks.outgoing(conv, item, { fresh: false, digest: null, limits })),
    );
    const uuid = clientUuid(first, randomUUID);
    const ids = items.map((item) => item.id);
    state.write((ctx) => {
      for (const id of ids) markItemPushedUnder(ctx, id, uuid);
    });
    try {
      session.open.handle.send(out.text, out.images, uuid);
    } catch (error) {
      state.write((ctx) => {
        markItemsHandedBack(ctx, rt.id, ids);
      });
      const reason = error instanceof Error ? error.message : String(error);
      core.notice(rt, hooks.words?.startFailed?.(reason) ?? reason);
      return false;
    }
    state.write((ctx) => {
      out.sent(ctx);
      markFilesInline(ctx, rt.id, out.blocks, false);
    });
    return true;
  };

  const pastContextLimit = (rt: Runtime): boolean => {
    const conv = core.conversation(rt.id);
    const pct = conv.contextPct;
    return pct !== null && pct > core.hooksOf(conv).freshAtContextPct;
  };

  /** Hands the live session every starter waiting, as one message; answers them, or null on a failed send. */
  const pushWaiting = (rt: Runtime, session: Session): ConversationItemRow[] | null => {
    const items = core.unpushed(rt);
    return handTo(rt, session, items) ? items : null;
  };

  return {
    handTo,
    beginTurn(rt) {
      const session = rt.session;
      // The state moved on while the effect waited (an end, a close): no turn begins now.
      if (session === null || rt.state !== S.Running) return;
      const earlier = core.handed(rt).map((item) => item.id);
      const waiting = pushWaiting(rt, session);
      // A send that failed began no turn: what it carried waits for the next.
      const pushed = waiting?.map((item) => item.id) ?? [];
      if (earlier.length === 0 && pushed.length === 0) {
        // Nothing was left to run: the queue emptied while the effect waited.
        core.setState(rt, S.IdleWarm);
        return;
      }
      rt.starters = [...earlier, ...pushed];
      rt.inTurn = true;
      session.open.newTurn();
    },
    handBack(rt) {
      const held = core.handed(rt).map((item) => item.id);
      if (held.length > 0)
        state.write((ctx) => {
          markItemsHandedBack(ctx, rt.id, held);
        });
    },
    settleTurn(rt, stillQueued = new Set()) {
      rt.grace?.cancel();
      rt.grace = null;
      rt.inTurn = false;
      const taken = rt.starters.filter((id) => !stillQueued.has(id));
      state.write((ctx) => {
        markItemsDelivered(ctx, rt.id, taken);
      });
    },
    itemsOf(rt, uuids) {
      const named = new Set(uuids);
      return new Set(
        core
          .handed(rt)
          .filter((item) => item.pushUuids.some((uuid) => named.has(uuid)))
          .map((item) => item.id),
      );
    },
    resolveSendNow(rt) {
      const marker = openTurnMarker(state.db, rt.id);
      if (marker === null) return;
      state.write((ctx) => {
        updateItem(ctx, marker.id, {
          body: { marker: TurnMarker.SendNow, resolvedAt: ctx.now },
        });
      });
    },
    storePartialNow(rt) {
      (rt.session ?? rt.lastSession)?.open.storePartial();
    },
    spoke: (rt) => hasItemOfKind(state.db, rt.id, ConversationItemKind.AgentMessage),
    pastContextLimit,
    freshIfFull(rt) {
      if (rt.state === S.IdleWarm && pastContextLimit(rt))
        core.reduce(rt, { type: 'context_full' });
    },
  };
}
