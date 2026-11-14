import { randomUUID } from 'node:crypto';
import type { ConversationOwnerKind } from '@10db/contracts';
import {
  agentKind,
  ConflictError,
  ConversationItemAuthor,
  ConversationItemKind,
  ConversationState,
  mintId,
  ModelSwitch,
  providerOf,
  SessionMode,
  type AccountId,
  type AgentAccountKind,
  type ConversationDto,
  type ConversationId,
  type ConversationItemId,
  type ConversationLiveDto,
  type ProjectId,
} from '@10db/contracts';
import {
  conversationCostUsd,
  deleteItem,
  endSession,
  getAccountRow,
  getConversation,
  getProject,
  insertItem,
  insertSession,
  lastItems,
  listPushedTurnStarters,
  listQueuedTurnStarters,
  markFilesInline,
  markItemPushedUnder,
  markItemsDelivered,
  markItemsHandedBack,
  findItemByPushUuid,
  patchConversation,
  type ConversationItemRow,
  type ConversationRow,
  type WriteContext,
} from '@10db/db';
import type { Clock, Timer } from '../clock';
import type { EventBus, LiveFrames, StateStore } from '../events';
import type { Logger } from '../log';
import type { AgentAdapter, InterruptReceipt, SessionHandle } from '../sessions';
import type { Hold } from '../verify';
import { clientUuid, pushedAgainAfter } from './delivery-rules';
import type { ExploreLaunch, ExploreOwnerHooks, Outgoing, TurnEnd } from './explore-hooks';
import { openSession, type OpenSession } from './explore-session';
import {
  ExploreEffect,
  reduceExplore,
  type ExploreEvent,
  type ExploreFacts,
} from './explore-state';
import { pictureLimitsFor, type PictureLimits } from './picture-limits';

// Sessions spec §6.3–§6.8: the engine that owns every explore conversation's live session. Each
// conversation's state moves only through the reducer, is written with the conversation, and its
// effects run one at a time on the conversation's chain (call 24).

export const IDLE_MS = 10 * 60_000;
export const STOP_GRACE_MS = 10_000;
export const WARM_CAP = 4;
/** A live session this close to its credentials' expiry is closed before a push, so the next start has fresh ones. */
const CREDENTIALS_MARGIN_MS = 5 * 60_000;
/** How far back a Redo looks for the builder's message it replaces. */
const REDO_LOOKBACK = 50;

const S = ConversationState;
const E = ExploreEffect;
const BUSY: ReadonlySet<ConversationState> = new Set([
  S.Starting,
  S.Running,
  S.WaitingCard,
  S.Stopping,
]);

export interface ExploreEngine {
  register(
    kind: typeof ConversationOwnerKind.Shape | typeof ConversationOwnerKind.Chat,
    hooks: ExploreOwnerHooks,
  ): void;
  /** A turn starter was stored (rule 1); reduces `builder_message`, or parks it behind a hold (call 23). */
  queued(id: ConversationId): void;
  stop(id: ConversationId): Promise<void>;
  /** Stop, then the edited message as the next turn (call 30). */
  redo(id: ConversationId, post: () => ConversationItemRow): Promise<ConversationItemRow>;
  /** Refused with the state's words when nothing would run (call 29). */
  sendNow(id: ConversationId): void;
  modelChanged(id: ConversationId, model: string | null): Promise<void>;
  holdStarts(id: ConversationId): void;
  releaseStarts(id: ConversationId): void;
  view(id: ConversationId): ConversationDto;
  live(id: ConversationId): ConversationLiveDto;
  /** Conversations `starting`, `running`, `waiting_card` or `stopping`: what an update drain waits for (call 28). */
  busy(): readonly ConversationId[];
  /** A queue waits on a hold; Plan's view reads it for `waitingForUpdate`. */
  parked(id: ConversationId): boolean;
  /** Resolves once the conversation runs no turn and has no effect left to apply. */
  settled(id: ConversationId): Promise<void>;
  recover(): Promise<void>;
  close(): Promise<void>;
}

export interface ExploreEngineDeps {
  readonly state: StateStore;
  readonly adapter: AgentAdapter;
  readonly clock: Clock;
  readonly log: Logger;
  readonly dataDir: string;
  readonly frames: LiveFrames;
  readonly hold?: Hold;
  readonly bus: EventBus;
  /** A token for a session's MCP calls, and the hash its row keeps. */
  readonly mintToken: () => { readonly token: string; readonly hash: string };
  readonly accountBlocked: (
    accountId: AccountId,
    projectId: ProjectId,
  ) => { readonly until: Date | null } | null;
  readonly defaultPauseMs: number;
  readonly idleMs?: number;
  readonly stopGraceMs?: number;
  readonly warmCap?: number;
}

/** What a reduction saw, for its effects to act on: the starters waiting, and the turn that ended. */
interface Taken {
  readonly waiting: ReadonlySet<ConversationItemId>;
  readonly end: TurnEnd;
}

interface Session {
  readonly open: OpenSession;
  /** The engine asked it to end: its `ended` is no event of the conversation's. */
  asked: boolean;
}

interface Runtime {
  readonly id: ConversationId;
  state: ConversationState;
  session: Session | null;
  /** The effects, applied one at a time. */
  chain: Promise<void>;
  /** Resolves once the session the engine last stopped has ended and released what it held. */
  closing: Promise<void>;
  /** The turn starters the running turn began with. */
  starters: ConversationItemId[];
  /** A turn has begun and not ended. */
  inTurn: boolean;
  /** How the turn that ended last ended, for `on_turn_ended`. */
  ended: TurnEnd['how'];
  idle: Timer | null;
  idleSince: number | null;
  /** A starter waits on a hold (call 23). */
  parked: boolean;
  /** Convert's hold on this conversation. */
  held: boolean;
  /** A start under way was cancelled. */
  cancelled: boolean;
  /** Ends a stop that neither a receipt nor the turn's end settled in time. */
  grace: Timer | null;
  /** What the last interrupt answers. */
  receipt: Promise<InterruptReceipt> | null;
  /** A receipt settled the stop: the interrupted turn's own end is still to come, and is dropped (call 25). */
  lateComplete: boolean;
  /** The message a Redo replaces, while its stop settles (call 30). */
  redo: ConversationItemId | null;
  /** The session the engine last stopped or saw end, whose stream a partial is stored from. */
  lastSession: Session | null;
  /** Told when the state or the chain moves, for `settled`. */
  waiters: (() => void)[];
}

export function createExploreEngine(deps: ExploreEngineDeps): ExploreEngine {
  const { state, adapter, clock, log } = deps;
  const idleMs = deps.idleMs ?? IDLE_MS;
  const stopGraceMs = deps.stopGraceMs ?? STOP_GRACE_MS;
  const owners = new Map<ConversationOwnerKind, ExploreOwnerHooks>();
  const runtimes = new Map<ConversationId, Runtime>();

  const conversation = (id: ConversationId): ConversationRow => getConversation(state.db, id);
  const hooksOf = (conv: ConversationRow): ExploreOwnerHooks => {
    const hooks = owners.get(conv.ownerKind);
    if (hooks === undefined) throw new ConflictError(`No explore owner runs a ${conv.ownerKind}`);
    return hooks;
  };
  const accountOf = (conv: ConversationRow): { id: AccountId; kind: AgentAccountKind } => {
    const project = getProject(state.db, conv.projectId);
    return {
      id: project.accountId,
      kind: agentKind(getAccountRow(state.db, project.accountId).kind),
    };
  };
  const capabilitiesOf = (conv: ConversationRow) =>
    adapter.capabilities({ kind: accountOf(conv).kind }, conv.model);

  const runtimeOf = (id: ConversationId): Runtime => {
    let rt = runtimes.get(id);
    if (rt === undefined) {
      rt = {
        id,
        state: conversation(id).state ?? S.IdleCold,
        session: null,
        chain: Promise.resolve(),
        closing: Promise.resolve(),
        starters: [],
        inTurn: false,
        ended: 'complete',
        idle: null,
        idleSince: null,
        parked: false,
        held: false,
        cancelled: false,
        grace: null,
        receipt: null,
        lateComplete: false,
        redo: null,
        lastSession: null,
        waiters: [],
      };
      runtimes.set(id, rt);
    }
    return rt;
  };

  const wake = (rt: Runtime): void => {
    const waiters = rt.waiters;
    rt.waiters = [];
    for (const waiter of waiters) waiter();
  };

  const holding = (rt: Runtime): boolean => rt.held || deps.hold?.holding() === true;
  const unpushed = (rt: Runtime): ConversationItemRow[] => listQueuedTurnStarters(state.db, rt.id);
  const handed = (rt: Runtime): ConversationItemRow[] =>
    rt.session === null ? [] : listPushedTurnStarters(state.db, rt.id);

  /** The reducer's facts; a hold counts nothing queued, except to a Stop, which clears a parked start. */
  const factsOf = (rt: Runtime, event: ExploreEvent): ExploreFacts => {
    const conv = conversation(rt.id);
    const parked = holding(rt) && event.type !== 'stop';
    return {
      queued: parked ? 0 : unpushed(rt).length + handed(rt).length,
      providerSessionId: conv.providerSessionId !== null,
      restartedWhilePaused: false,
      steer: capabilitiesOf(conv).steer,
      resuming: false,
    };
  };

  const setState = (rt: Runtime, next: ConversationState): void => {
    if (rt.state === next) return;
    const was = rt.state;
    rt.state = next;
    state.write((ctx) => {
      patchConversation(ctx, rt.id, { state: next });
    });
    if (was === S.IdleWarm) {
      rt.idle?.cancel();
      rt.idle = null;
      rt.idleSince = null;
    }
    if (next === S.IdleWarm) {
      rt.idleSince = clock.now().getTime();
      rt.idle = clock.setTimeout(() => {
        rt.idle = null;
        reduce(rt, { type: 'idle_close' });
      }, idleMs);
    }
    wake(rt);
  };

  const enqueue = (rt: Runtime, work: () => Promise<void> | void): void => {
    rt.chain = rt.chain
      .then(work)
      .catch((error: unknown) => {
        log.error({ err: error, conversationId: rt.id }, 'an explore effect failed');
      })
      .finally(() => {
        wake(rt);
      });
  };

  /** Reduces `event`; answers the refusal's words, or null. */
  const reduce = (rt: Runtime, event: ExploreEvent): string | null => {
    const outcome = reduceExplore(rt.state, event, factsOf(rt, event));
    if ('refused' in outcome) return outcome.refused;
    // Flags a later effect reads, set now: a start under way sees its cancel at once.
    if (outcome.effects.includes(E.CancelStart)) rt.cancelled = true;
    if (outcome.effects.includes(E.DropPendingStart)) rt.parked = false;
    // What streamed is kept as it stands now: the next turn may begin streaming before the chain runs.
    if (outcome.effects.includes(E.StorePartial)) storePartialNow(rt);
    // A start sends what waited when it was asked for; what lands later is the next turn's.
    const taken: Taken = {
      waiting: new Set(unpushed(rt).map((item) => item.id)),
      end: { how: rt.ended, starters: [...rt.starters] },
    };
    setState(rt, outcome.next);
    for (const effect of outcome.effects) enqueue(rt, () => apply(rt, effect, taken));
    return null;
  };

  // --- Turn starters ------------------------------------------------------------------------------

  /** Several starters as one message, in `seq` order: what waited goes in one turn. */
  const combined = (outs: readonly Outgoing[]): Outgoing => ({
    text: outs.map((o) => o.text).join('\n\n'),
    images: outs.flatMap((o) => o.images),
    blocks: outs.flatMap((o) => o.blocks),
    sent: (ctx) => {
      for (const o of outs) o.sent(ctx);
    },
  });

  /** Marks each starter pushed under the one uuid, before a session is handed them (rule 1). */
  const markPushed = (
    ctx: WriteContext,
    rt: Runtime,
    items: readonly ConversationItemRow[],
    out: Outgoing,
    uuid: string,
    fresh: boolean,
  ): void => {
    for (const item of items) markItemPushedUnder(ctx, item.id, uuid);
    out.sent(ctx);
    markFilesInline(ctx, rt.id, out.blocks, fresh);
  };

  /** Hands the live session every starter waiting, as one message; answers them. */
  const pushWaiting = (rt: Runtime, session: Session): ConversationItemRow[] => {
    const items = unpushed(rt);
    const first = items[0];
    if (first === undefined) return [];
    const conv = conversation(rt.id);
    const hooks = hooksOf(conv);
    const limits = session.open.launch.limits;
    const out = combined(
      items.map((item) => hooks.outgoing(conv, item, { fresh: false, digest: null, limits })),
    );
    const uuid = clientUuid(first, randomUUID);
    state.write((ctx) => {
      markPushed(ctx, rt, items, out, uuid, false);
    });
    session.open.handle.send(out.text, out.images, uuid);
    return items;
  };

  /** A turn begins with what waits: pushed now, or handed earlier and not taken. */
  const beginTurn = (rt: Runtime): void => {
    const session = rt.session;
    if (session === null) return;
    const earlier = handed(rt).map((item) => item.id);
    const pushed = pushWaiting(rt, session).map((item) => item.id);
    if (earlier.length === 0 && pushed.length === 0) {
      // Nothing was left to run: the queue emptied while the effect waited.
      setState(rt, S.IdleWarm);
      return;
    }
    rt.starters = [...earlier, ...pushed];
    rt.inTurn = true;
    session.open.newTurn();
  };

  /** Every starter the session holds goes back to 10db's queue (call 22). */
  const handBack = (rt: Runtime): void => {
    const held = handed(rt).map((item) => item.id);
    if (held.length > 0)
      state.write((ctx) => {
        markItemsHandedBack(ctx, rt.id, held);
      });
  };

  // --- Sessions ------------------------------------------------------------------------------------

  const notice = (rt: Runtime, text: string): void => {
    state.write((ctx) => {
      insertItem(ctx, rt.id, {
        author: ConversationItemAuthor.System,
        kind: ConversationItemKind.Notice,
        body: { text },
      });
    });
  };

  /** Stops a session the engine is done with; `closing` resolves once it has ended. */
  const stopSession = (rt: Runtime, session: Session): Promise<void> => {
    session.asked = true;
    session.open.detach();
    rt.lastSession = session;
    if (rt.session === session) rt.session = null;
    const stopped = (async () => {
      try {
        await session.open.handle.stop();
      } catch (error) {
        log.warn({ err: error, conversationId: rt.id }, 'an explore session did not stop cleanly');
      }
      await session.open.done;
    })();
    rt.closing = stopped;
    return stopped;
  };

  const storePartialNow = (rt: Runtime): void => {
    const open = (rt.session ?? rt.lastSession)?.open;
    if (open !== undefined)
      state.write((ctx) => {
        open.storePartial(ctx);
      });
  };

  /** The running turn is over: it took what it began with. */
  const settleTurn = (rt: Runtime): void => {
    rt.grace?.cancel();
    rt.grace = null;
    rt.inTurn = false;
    state.write((ctx) => {
      markItemsDelivered(ctx, rt.id, rt.starters);
    });
  };

  /** `p`, or `fallback` once the stop grace has passed without it. */
  const withinGrace = <T>(p: Promise<T>, fallback: T): Promise<T> =>
    new Promise((resolve) => {
      const timer = clock.setTimeout(() => {
        resolve(fallback);
      }, stopGraceMs);
      void p.then((value) => {
        timer.cancel();
        resolve(value);
      });
    });

  /** The starters a session holds that went under one of `uuids`: every one a combined push carried. */
  const itemsOf = (rt: Runtime, uuids: readonly string[]): Set<ConversationItemId> => {
    const named = new Set(uuids);
    return new Set(
      handed(rt)
        .filter((item) => item.pushUuids.some((uuid) => named.has(uuid)))
        .map((item) => item.id),
    );
  };

  /** A receipt that came while the stop waits: it settles the stop, unless a Redo decides first. */
  const receiptCame = (rt: Runtime, session: Session): void => {
    if (rt.session !== session || rt.state !== S.Stopping || !rt.inTurn || rt.redo !== null) return;
    rt.lateComplete = true;
    settleTurn(rt);
    rt.ended = 'stopped';
    reduce(rt, { type: 'stop_settled' });
  };

  /** Neither a receipt nor the turn's end came within the grace: the session is stopped. */
  const graceOver = (rt: Runtime, session: Session): void => {
    rt.grace = null;
    if (rt.session !== session || rt.state !== S.Stopping) return;
    settleTurn(rt);
    handBack(rt);
    rt.ended = 'stopped';
    reduce(rt, { type: 'stop_grace_passed' });
  };

  /** Pushes again, as one message under a uuid of its own, what an interrupt may have lost (rule 4). */
  const pushAgain = (
    rt: Runtime,
    session: Session,
    items: readonly ConversationItemRow[],
  ): void => {
    const first = items[0];
    if (first === undefined) return;
    const conv = conversation(rt.id);
    const hooks = hooksOf(conv);
    const limits = session.open.launch.limits;
    const out = combined(
      items.map((item) => hooks.outgoing(conv, item, { fresh: false, digest: null, limits })),
    );
    const uuid = clientUuid(first, randomUUID);
    state.write((ctx) => {
      markPushed(ctx, rt, items, out, uuid, false);
    });
    session.open.handle.send(out.text, out.images, uuid);
  };

  const start = async (rt: Runtime, waiting: ReadonlySet<ConversationItemId>): Promise<void> => {
    // A new handle never opens on an agent session the last one still holds (call 24).
    await rt.closing;
    const cancelled = (): boolean => {
      if (!rt.cancelled) return false;
      rt.cancelled = false;
      return true;
    };
    if (cancelled()) return;
    const items = unpushed(rt).filter((item) => waiting.has(item.id));
    const first = items[0];
    if (first === undefined) {
      setState(rt, S.IdleCold);
      return;
    }
    const conv = conversation(rt.id);
    const hooks = hooksOf(conv);
    const account = accountOf(conv);
    const resume = conv.providerSessionId;
    const fresh = resume === null;
    const limits: PictureLimits = pictureLimitsFor(account.kind);
    const out = combined(
      items.map((item) => hooks.outgoing(conv, item, { fresh, digest: null, limits })),
    );
    const uuid = clientUuid(first, randomUUID);
    const sessionId = mintId('Session');
    const { token, hash } = deps.mintToken();
    /** A start that could not open a session: the builder is told why, and the conversation ends in error. */
    const failed = (error: unknown): void => {
      notice(rt, error instanceof Error ? error.message : String(error));
      rt.inTurn = false;
      reduce(rt, { type: 'ended', how: 'error' });
    };
    let launch: ExploreLaunch;
    try {
      launch = await hooks.spec(conv, {
        sessionId,
        mcpToken: token,
        resume,
        digest: null,
        first: out,
        observer: { onWaitStart: () => undefined, onWaitEnd: () => undefined },
      });
    } catch (error) {
      failed(error);
      return;
    }
    if (cancelled()) {
      await launch.release();
      return;
    }
    state.write((ctx) => {
      insertSession(ctx, {
        id: sessionId,
        conversationId: rt.id,
        provider: providerOf(launch.spec.account.kind),
        model: launch.spec.model,
        effort: launch.spec.effort,
        mode: SessionMode.Managed,
        mcpTokenHash: hash,
        accountId: launch.accountId,
      });
      markPushed(ctx, rt, items, out, uuid, fresh);
    });
    let handle: SessionHandle;
    try {
      handle = adapter.open({ ...launch.spec, promptUuid: uuid });
    } catch (error) {
      // The row was written with its token hash: ended, so no live row keeps a token MCP would accept.
      state.write((ctx) => {
        endSession(ctx, sessionId, 'start_failed');
        markItemsHandedBack(
          ctx,
          rt.id,
          items.map((item) => item.id),
        );
      });
      await launch.release();
      failed(error);
      return;
    }
    // Set once the session is made; its events are read only after, on a later turn of the loop.
    let self: Session | null = null;
    const open = openSession({
      state,
      clock,
      log,
      dataDir: deps.dataDir,
      frames: deps.frames,
      conversationId: rt.id,
      sessionId,
      handle,
      launch,
      fresh,
      sink: {
        started: () => {
          if (rt.session === self) reduce(rt, { type: 'started' });
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
        rateLimited: () => undefined,
        turnComplete: (event) => {
          if (rt.session !== self) return;
          if (rt.lateComplete) {
            rt.lateComplete = false;
            return;
          }
          settleTurn(rt);
          // A Redo settles its stop once it has read the receipt.
          if (rt.state === S.Stopping && rt.redo !== null) return;
          rt.ended =
            rt.state === S.Stopping ? 'stopped' : event.result === 'error' ? 'failed' : 'complete';
          reduce(rt, { type: 'turn_complete' });
        },
        ended: (event) => {
          state.write((ctx) => {
            endSession(ctx, sessionId, event.reason);
          });
          void launch.release();
          if (self === null || self.asked || rt.session !== self) return;
          rt.grace?.cancel();
          rt.grace = null;
          rt.lastSession = self;
          rt.session = null;
          rt.inTurn = false;
          handBack(rt);
          rt.ended = 'ended';
          reduce(rt, { type: 'ended', how: 'error' });
        },
      },
    });
    self = { open, asked: false };
    rt.session = self;
    rt.starters = items.map((item) => item.id);
    rt.inTurn = true;
    open.newTurn();
  };

  // --- Effects ---------------------------------------------------------------------------------------

  const apply = async (rt: Runtime, effect: ExploreEffect, taken: Taken): Promise<void> => {
    switch (effect) {
      case E.Start:
        await start(rt, taken.waiting);
        return;
      case E.Push:
      case E.NextTurn:
        // A session's first message is its prompt, so its turn has begun by `started`.
        if (!rt.inTurn) beginTurn(rt);
        return;
      case E.OnTurnEnded: {
        const conv = conversation(rt.id);
        await hooksOf(conv).onTurnEnded(conv, taken.end);
        return;
      }
      case E.Close: {
        const session = rt.session;
        if (session === null) return;
        handBack(rt);
        await stopSession(rt, session);
        return;
      }
      case E.RunQueue:
        if (unpushed(rt).length > 0) reduce(rt, { type: 'builder_message' });
        return;
      case E.Inject: {
        // One push each, under its own uuid, so a receipt can name each one.
        const session = rt.session;
        if (session !== null) for (const item of unpushed(rt)) pushAgain(rt, session, [item]);
        return;
      }
      case E.CancelStart: {
        // The start has run by now: it saw the cancel and opened nothing, or it opened a session.
        rt.cancelled = false;
        const session = rt.session;
        if (session === null) return;
        handBack(rt);
        rt.inTurn = false;
        await stopSession(rt, session);
        return;
      }
      case E.Interrupt: {
        const session = rt.session;
        if (session === null) return;
        rt.grace?.cancel();
        rt.grace = clock.setTimeout(() => {
          graceOver(rt, session);
        }, stopGraceMs);
        const receipt = session.open.handle.interrupt().catch(() => null);
        rt.receipt = receipt;
        void receipt.then(() => {
          receiptCame(rt, session);
        });
        return;
      }
      case E.RepushStillQueued: {
        const session = rt.session;
        const asked = rt.receipt;
        rt.receipt = null;
        if (session === null) return;
        const receipt = asked === null ? null : await withinGrace(asked, null);
        const still = receipt === null ? null : itemsOf(rt, receipt.stillQueued);
        pushAgain(rt, session, pushedAgainAfter(handed(rt), still));
        return;
      }
      case E.StopHandle: {
        const session = rt.session;
        if (session !== null) await stopSession(rt, session);
        return;
      }
      // Stored when reduced.
      case E.StorePartial:
      case E.DropPendingStart:
      case E.WithdrawCard:
      case E.FreshNext:
      case E.StartFreshFromDigest:
      case E.PausedNotice:
      case E.SendNow:
      case E.HandBackNotice:
      case E.Archive:
      case E.ArchiveAfterStop:
        return;
    }
  };

  // --- The engine -------------------------------------------------------------------------------------

  const queued = (id: ConversationId): void => {
    const rt = runtimeOf(id);
    if (holding(rt)) {
      rt.parked = true;
      if (!rt.held && deps.hold !== undefined)
        void deps.hold.untilClear().then(() => {
          release(rt);
        });
      return;
    }
    const expiresAt = rt.session?.open.launch.expiresAt ?? null;
    if (
      rt.state === S.IdleWarm &&
      expiresAt !== null &&
      Date.parse(expiresAt) - CREDENTIALS_MARGIN_MS <= clock.now().getTime()
    )
      reduce(rt, { type: 'idle_close' });
    reduce(rt, { type: 'builder_message' });
  };

  const release = (rt: Runtime): void => {
    if (holding(rt) || !rt.parked) return;
    rt.parked = false;
    if (unpushed(rt).length > 0) reduce(rt, { type: 'builder_message' });
  };

  return {
    register(kind, hooks) {
      owners.set(kind, hooks);
    },
    queued,
    /** Resolves once the stop's effects have been applied: the interrupt asked, or the start cancelled. */
    async stop(id) {
      const rt = runtimeOf(id);
      reduce(rt, { type: 'stop' });
      await new Promise<void>((resolve) => {
        enqueue(rt, resolve);
      });
    },
    async redo(id, post) {
      const rt = runtimeOf(id);
      const original =
        lastItems(state.db, id, REDO_LOOKBACK)
          .reverse()
          .find(
            (item) =>
              item.author === ConversationItemAuthor.Builder &&
              item.kind === ConversationItemKind.Message,
          ) ?? null;
      rt.redo = original?.id ?? null;
      reduce(rt, { type: 'stop' });
      // The interrupt is asked for on the chain; its receipt says whether the agent took the original.
      await new Promise<void>((resolve) => {
        enqueue(rt, resolve);
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
      if (rt.inTurn) {
        // The turn's own end is still to come: it is dropped when it does.
        rt.lateComplete = true;
        settleTurn(rt);
      }
      rt.ended = 'stopped';
      if (
        original !== null &&
        receipt !== null &&
        itemsOf(rt, receipt.stillQueued).has(original.id)
      ) {
        // The agent would run the original by itself: its session goes, and the edit alone is sent.
        rt.lateComplete = false;
        state.write((ctx) => {
          deleteItem(ctx, original.id);
        });
        const edit = post();
        handBack(rt);
        reduce(rt, { type: 'stop_grace_passed' });
        return edit;
      }
      const edit = post();
      reduce(rt, { type: 'stop_settled' });
      return edit;
    },
    sendNow: () => undefined,
    async modelChanged(id, model) {
      const rt = runtimeOf(id);
      if (BUSY.has(rt.state)) throw new ConflictError('Stop first');
      const conv = conversation(id);
      const hooks = hooksOf(conv);
      const before = hooks.describeModel(conv, conv.model);
      const after = hooks.describeModel(conv, model);
      state.write((ctx) => {
        patchConversation(ctx, id, { model });
        if (after.model !== before.model)
          insertItem(ctx, id, {
            author: ConversationItemAuthor.System,
            kind: ConversationItemKind.Notice,
            body: { kind: 'model_change', label: after.label, model: after.model },
          });
      });
      const session = rt.session;
      if (rt.state !== S.IdleWarm || session === null || after.model === before.model) return;
      if (capabilitiesOf(conv).modelSwitch === ModelSwitch.NextTurn)
        await session.open.handle.setModel(after.launchId);
      else reduce(rt, { type: 'idle_close' });
    },
    holdStarts(id) {
      runtimeOf(id).held = true;
    },
    releaseStarts(id) {
      const rt = runtimeOf(id);
      rt.held = false;
      release(rt);
    },
    view(id) {
      const rt = runtimeOf(id);
      const conv = conversation(id);
      const capabilities = capabilitiesOf(conv);
      return {
        id,
        owner: { kind: conv.ownerKind, id: conv.ownerId },
        state: rt.state,
        capabilities,
        model: conv.model,
        contextPct: conv.contextPct,
        queued: unpushed(rt).length,
        costUsd: capabilities.costUsd ? (conversationCostUsd(state.db, id) ?? 0) : null,
        sendNow: false,
        pausedUntil: null,
      };
    },
    live(id) {
      return { conversationId: id, items: runtimeOf(id).session?.open.buffers.snapshot() ?? [] };
    },
    busy: () => [...runtimes.values()].filter((rt) => BUSY.has(rt.state)).map((rt) => rt.id),
    parked: (id) => runtimeOf(id).parked,
    async settled(id) {
      const rt = runtimeOf(id);
      for (;;) {
        const chain = rt.chain;
        await chain;
        if (rt.chain === chain && !BUSY.has(rt.state)) return;
        if (rt.chain === chain)
          await new Promise<void>((resolve) => {
            rt.waiters.push(resolve);
          });
      }
    },
    recover: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}
