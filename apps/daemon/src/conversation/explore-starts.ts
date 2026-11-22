import { randomUUID } from 'node:crypto';
import {
  ConversationItemAuthor,
  ConversationItemKind,
  ConversationState,
  mintId,
  ModelMarkBasis,
  SessionMode,
  type ConversationItemId,
} from '@10db/contracts';
import {
  endSession,
  findItemByPushUuid,
  insertItem,
  insertSession,
  markFilesInline,
  markItemPushedUnder,
  markItemsDelivered,
  markItemsHandedBack,
} from '@10db/db';
import { markModelUnusable } from '../catalogue';
import { SessionEndReason } from '../sessions';
import { clientUuid } from './delivery-rules';
import { openSession } from './explore-session';
import {
  endedHow,
  type EngineCore,
  type Made,
  type Runtime,
  type Session,
} from './explore-runtime';
import { combined, type ExploreTurns } from './explore-turns';
import { capItemBody, writeFullOutput } from './full-output';
import { pictureLimitsFor, type PictureLimits } from './picture-limits';

// Sessions spec §6.3, §6.4 and §6.6: how a conversation's session starts. The owner says what it
// resumes, carries and launches; the session row is written before the session is prepared, and a
// start that goes no further undoes what it made. The session's events become the engine's.

const S = ConversationState;

export interface ExploreStarts {
  /** Opens a session for the starters `waiting` named when the start was asked for. */
  start(rt: Runtime, waiting: ReadonlySet<ConversationItemId>): Promise<void>;
}

export function createStarts(core: EngineCore, turns: ExploreTurns): ExploreStarts {
  const { state, adapter, clock, log } = core.deps;

  /** What a start made goes, and its starters wait as they were. */
  const unmake = async (rt: Runtime, made: Made): Promise<void> => {
    const { sessionId } = made;
    state.write((ctx) => {
      if (sessionId !== null) endSession(ctx, sessionId, 'start_failed');
      markItemsHandedBack(ctx, rt.id, [...made.pushed]);
    });
    if (made.launch !== null) await made.launch.release();
    rt.session = null;
    rt.resuming = false;
    rt.inTurn = false;
  };

  /**
   * A start that could not open a session: what it made goes (the row ends, so no live row keeps a
   * token MCP would accept; the launch is released; what it marked pushed waits again), the builder is
   * told why, and the conversation ends in error. No failure here is a failed resume.
   */
  const startFailed = async (rt: Runtime, made: Made, error: unknown): Promise<void> => {
    await unmake(rt, made);
    const reason = error instanceof Error ? error.message : String(error);
    const words = core.owners.get(core.conversation(rt.id).ownerKind)?.words;
    core.notice(rt, words?.startFailed?.(reason) ?? reason);
    core.reduce(rt, { type: 'ended', how: 'error' });
  };

  const start = async (rt: Runtime, waiting: ReadonlySet<ConversationItemId>): Promise<void> => {
    // A new handle never opens on an agent session the last one still holds.
    await rt.closing;
    const made: Made = { launch: null, sessionId: null, pushed: [] };
    try {
      await openFor(rt, waiting, made);
    } catch (error) {
      await startFailed(rt, made, error);
    }
  };

  const openFor = async (
    rt: Runtime,
    waiting: ReadonlySet<ConversationItemId>,
    made: Made,
  ): Promise<void> => {
    const cancelled = (): boolean => {
      if (!rt.cancelled) return false;
      rt.cancelled = false;
      return true;
    };
    // Once the engine has closed, nothing starts: the starters wait for the next start's Send now.
    if (cancelled() || core.isClosed()) return;
    const items = core.unpushed(rt).filter((item) => waiting.has(item.id));
    const first = items[0];
    if (first === undefined) {
      core.setState(rt, S.IdleCold);
      return;
    }
    const conv = core.conversation(rt.id);
    const hooks = core.hooksOf(conv);
    const account = core.accountOf(conv);
    // A start the account runtime holds reads as an end for the limit: nothing is sent.
    const blocked = core.deps.accountBlocked(account.id, conv.projectId);
    if (blocked !== null) {
      rt.pausedUntil = blocked.until;
      rt.inTurn = false;
      core.reduce(rt, { type: 'ended', how: 'paused' });
      return;
    }
    // The owner may refuse a resume (what it would carry no longer fits the account): fresh, from the digest.
    const resume =
      conv.providerSessionId !== null && hooks.keepsResume?.(conv) === false
        ? null
        : conv.providerSessionId;
    const fresh = resume === null;
    // A fresh session after the agent has spoken is told what came before; the digest is kept with the
    // session's row, so a start that fails or is cancelled stores none.
    const digest = fresh && turns.spoke(rt) ? hooks.digest(conv) : null;
    const limits: PictureLimits = hooks.limits?.(conv) ?? pictureLimitsFor(account.kind);
    const out = combined(
      items.map((item) => hooks.outgoing(conv, item, { fresh, digest, limits })),
    );
    const uuid = clientUuid(first, randomUUID);
    const sessionId = mintId('Session');
    const { token, hash } = core.deps.mintToken();
    // The row is written with its token's hash before the session is prepared, as what is prepared
    // names it; a start that goes no further ends it, so no live row keeps a token MCP would accept.
    // It bills the project's account as it is now, never the conversation's stored one.
    const running = hooks.describeModel(conv, conv.model);
    state.write((ctx) => {
      insertSession(ctx, {
        id: sessionId,
        conversationId: rt.id,
        provider: account.harness,
        model: running.launchId,
        effort: running.effort,
        mode: SessionMode.Managed,
        mcpTokenHash: hash,
      });
    });
    made.sessionId = sessionId;
    // Set once the session is made; its events and cards come only after, on a later turn of the loop.
    let self: Session | null = null;
    const launch = await hooks.spec(conv, {
      sessionId,
      mcpToken: token,
      resume,
      digest,
      first: out,
      observer: {
        // A card this session waits on is an item and a state (§6.6).
        onWaitStart: (item) => {
          if (self === null || rt.session !== self) return;
          rt.cards.add(item.id);
          state.write((ctx) => {
            insertItem(ctx, rt.id, {
              author: ConversationItemAuthor.Agent,
              kind: ConversationItemKind.Card,
              body: { inboxItemId: item.id },
            });
          });
          core.reduce(rt, { type: 'card_raised' });
        },
        onWaitEnd: (item) => {
          if (!rt.cards.delete(item.id) || rt.cards.size > 0) return;
          core.reduce(rt, { type: 'card_settled' });
        },
      },
    });
    made.launch = launch;
    rt.judge = launch.spec.profile.judge ?? null;
    // A start Stop cancelled, or one the engine's close overtook, ends here: the row ends, the
    // launch is released, and its starters wait as they were.
    if (cancelled() || core.isClosed()) {
      await unmake(rt, made);
      return;
    }
    const kept =
      digest === null ? null : capItemBody(ConversationItemKind.Digest, { text: digest });
    const digestItem = state.write((ctx) => {
      const stored =
        kept === null
          ? null
          : insertItem(ctx, rt.id, {
              author: ConversationItemAuthor.System,
              kind: ConversationItemKind.Digest,
              body: kept.body,
            });
      // Pushed under its uuid before the session is handed it; what the owner marks told
      // waits for the handle, so a start that fails tells nothing.
      for (const item of items) markItemPushedUnder(ctx, item.id, uuid);
      return stored;
    });
    // What the digest's item left out is kept on disk, once the write has committed.
    if (digestItem !== null && kept?.full != null)
      writeFullOutput(core.deps.dataDir, rt.id, digestItem.id, kept.full);
    made.pushed = items.map((item) => item.id);
    const handle = adapter.open({ ...launch.spec, promptUuid: uuid });
    state.write((ctx) => {
      out.sent(ctx);
      markFilesInline(ctx, rt.id, out.blocks, fresh);
    });
    const open = openSession({
      state,
      clock,
      log,
      dataDir: core.deps.dataDir,
      frames: core.deps.frames,
      conversationId: rt.id,
      sessionId,
      handle,
      launch,
      fresh,
      sink: {
        started: () => {
          if (self === null || rt.session !== self) return;
          self.started = true;
          rt.resuming = false;
          core.reduce(rt, { type: 'started' });
        },
        consumed: (uuids) => {
          const ids = uuids.flatMap((u) => {
            const found = findItemByPushUuid(state.db, rt.id, u);
            return found === null ? [] : [found];
          });
          if (ids.length > 0)
            state.write((ctx) => {
              markItemsDelivered(ctx, rt.id, ids);
            });
        },
        rateLimited: (resetsAt) => {
          rt.rateReset = resetsAt;
        },
        turnComplete: (event) => {
          if (rt.session !== self) return;
          // What the turn dropped untaken goes back to the queue, to be pushed again under a new uuid.
          const dropped = turns.itemsOf(rt, event.dropped ?? []);
          if (dropped.size > 0) {
            state.write((ctx) => {
              markItemsHandedBack(ctx, rt.id, [...dropped]);
            });
            rt.starters = rt.starters.filter((id) => !dropped.has(id));
          }
          turns.settleTurn(rt);
          // A Redo settles its stop once it has read the receipt.
          if (rt.state === S.Stopping && rt.redo !== null) return;
          rt.ended =
            rt.state === S.Stopping ? 'stopped' : event.result === 'error' ? 'failed' : 'complete';
          core.reduce(rt, { type: 'turn_complete' });
          turns.freshIfFull(rt);
        },
        ended: (event) => {
          state.write((ctx) => {
            endSession(ctx, sessionId, self?.endReason ?? event.reason);
          });
          const released = launch.release();
          if (self !== null) self.released = released;
          if (self === null || self.asked || rt.session !== self) return;
          rt.grace?.cancel();
          rt.grace = null;
          rt.lastSession = self;
          // A turn that ran took what it began with; the rest of what the session held goes back to
          // the queue before it stops counting as live.
          if (self.started && rt.inTurn) turns.settleTurn(rt);
          turns.handBack(rt);
          rt.session = null;
          rt.inTurn = false;
          rt.ended = 'ended';
          if (event.reason === SessionEndReason.ModelRefused)
            markModelUnusable(
              { state, clock },
              launch.accountId,
              launch.model,
              event.refusalBasis ?? ModelMarkBasis.Error,
            );
          const how = endedHow(event.reason);
          // An end in error says why; a limit has its own notice, and an exit says nothing.
          if (how === 'error')
            core.notice(rt, event.message ?? `The session ended (${event.reason}).`);
          if (how === 'paused')
            rt.pausedUntil =
              rt.rateReset ?? new Date(clock.now().getTime() + core.deps.defaultPauseMs);
          rt.rateReset = null;
          core.reduce(rt, { type: 'ended', how });
        },
      },
    });
    self = { open, asked: false, started: false, endReason: null, released: null };
    rt.session = self;
    rt.resuming = !fresh;
    rt.starters = items.map((item) => item.id);
    rt.inTurn = true;
    open.newTurn();
  };
  return { start };
}
