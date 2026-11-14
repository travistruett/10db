import { randomUUID } from 'node:crypto';
import type { ConversationOwnerKind } from '@10db/contracts';
import {
  agentKind,
  ConflictError,
  ConversationItemAuthor,
  ConversationItemKind,
  ConversationProfile,
  ConversationState,
  mintId,
  ModelMarkBasis,
  ModelSwitch,
  providerOf,
  SessionMode,
  TurnMarker,
  type AccountId,
  type AgentAccountKind,
  type ConversationDto,
  type ConversationId,
  type ConversationItemId,
  type ConversationLiveDto,
  type InboxItemId,
  type ProjectId,
} from '@10db/contracts';
import {
  conversationCostUsd,
  deleteItem,
  endSession,
  getAccountRow,
  getConversation,
  getProject,
  hasItemOfKind,
  insertItem,
  insertSession,
  lastItems,
  listConversationsOfProfile,
  listPushedTurnStarters,
  listQueuedTurnStarters,
  markFilesInline,
  markItemPushedUnder,
  markItemsDelivered,
  markItemsHandedBack,
  findItemByPushUuid,
  openTurnMarker,
  patchConversation,
  updateItem,
  type ConversationItemRow,
  type ConversationRow,
  type WriteContext,
} from '@10db/db';
import { timerAt, type Clock, type Timer } from '../clock';
import type { EventBus, LiveFrames, StateStore } from '../events';
import type { Logger } from '../log';
import { markModelUnusable } from '../catalogue';
import {
  SessionEndReason,
  type AgentAdapter,
  type InterruptReceipt,
  type SessionHandle,
} from '../sessions';
import type { Hold } from '../verify';
import { clientUuid, pushedAgainAfter } from './delivery-rules';
import type { ExploreLaunch, ExploreOwnerHooks, Outgoing, TurnEnd } from './explore-hooks';
import { openSession, type OpenSession } from './explore-session';
import {
  ExploreEffect,
  reduceExplore,
  type ExploreEvent,
  type ExploreFacts,
  type ExploreOutcome,
} from './explore-state';
import { pictureLimitsFor, type PictureLimits } from './picture-limits';
import { settleRestart } from './explore-recovery';
import { warmToClose } from './warm-cap';

// Sessions spec §6.3–§6.8: the engine that owns every explore conversation's live session. Each
// conversation's state moves only through the reducer, is written with the conversation, and its
// effects run one at a time on the conversation's chain (call 24).

export const IDLE_MS = 10 * 60_000;
export const STOP_GRACE_MS = 10_000;
export const WARM_CAP = 4;
/** A live session this close to its credentials' expiry is closed before a push, so the next start has fresh ones. */
const CREDENTIALS_MARGIN_MS = 5 * 60_000;
/** What a conversation reads when its next session starts fresh past the context limit. */
export const FRESH_SESSION_NOTICE = 'Continued in a fresh session. Nothing is lost.';
/** What a conversation paused for the account's usage limit reads, naming when it resumes. */
export const pausedNotice = (until: Date): string =>
  `Paused for the account's usage limit until ${until.toISOString()}. What you send waits, and runs then.`;
/** What a conversation paused at a metered account's monthly cap reads; it has no time to name. */
export const CAPPED_NOTICE =
  'Paused: the account reached its monthly limit. What you send waits, and runs once the account can run again.';
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

/** What a state is, in the words a refused Send Now gives (call 17). */
function stateWords(state: ConversationState): string {
  switch (state) {
    case S.Starting:
      return 'the session is starting';
    case S.Running:
      return 'a turn runs';
    case S.WaitingCard:
      return 'a card waits for your answer';
    case S.Stopping:
      return 'the turn is stopping';
    case S.TakenOver:
      return 'the session is open in a terminal';
    case S.PausedAccount:
      return 'the account is paused';
    case S.Sealed:
      return 'this session handed its work to a task';
    case S.IdleCold:
    case S.IdleWarm:
    case S.EndedError:
      return 'nothing waits';
  }
}

/** How a session's own end reads to the reducer (call 7). */
function endedHow(reason: SessionEndReason): 'error' | 'paused' | 'unasked' {
  switch (reason) {
    case SessionEndReason.RateLimited:
      return 'paused';
    case SessionEndReason.Completed:
    case SessionEndReason.Stopped:
      return 'unasked';
    case SessionEndReason.Error:
    case SessionEndReason.BillingRefused:
    case SessionEndReason.AccountRefused:
    case SessionEndReason.SandboxRefused:
    case SessionEndReason.ModelRefused:
      return 'error';
  }
}

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
  /** Withdraws an Inbox card the session waited on, when Stop or an end leaves it unanswered. */
  readonly withdrawCard?: (id: InboxItemId) => void;
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
  /** It reported `started`: the turn its first message began ran on it. */
  started: boolean;
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
  /** The session starting resumes an earlier one, and has not started yet. */
  resuming: boolean;
  /** The reset the session's last refused rate limit named. */
  rateReset: Date | null;
  /** While paused: when it resumes, null when it waits on the account; and the timer that checks. */
  pausedUntil: Date | null;
  pauseTimer: Timer | null;
  /** The Inbox card the session waits on. */
  card: InboxItemId | null;
  /** A restart found the conversation paused: its account's return waits under Send now. */
  restartedWhilePaused: boolean;
  /** Told when the state or the chain moves, for `settled`. */
  waiters: (() => void)[];
}

export function createExploreEngine(deps: ExploreEngineDeps): ExploreEngine {
  const { state, adapter, clock, log } = deps;
  const idleMs = deps.idleMs ?? IDLE_MS;
  const stopGraceMs = deps.stopGraceMs ?? STOP_GRACE_MS;
  const warmCap = deps.warmCap ?? WARM_CAP;
  const owners = new Map<ConversationOwnerKind, ExploreOwnerHooks>();
  const runtimes = new Map<ConversationId, Runtime>();
  let closed = false;

  const conversation = (id: ConversationId): ConversationRow => getConversation(state.db, id);
  // A change to an account (saved, a cap raised, a card answered) checks the conversations paused on it.
  const unsubscribeAccounts = deps.bus.subscribe((event) => {
    if (event.entityType !== 'account') return;
    for (const rt of runtimes.values())
      if (rt.state === S.PausedAccount && accountOf(conversation(rt.id)).id === event.entityId)
        recheckPause(rt);
  });
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
        resuming: false,
        rateReset: null,
        pausedUntil: null,
        pauseTimer: null,
        card: null,
        restartedWhilePaused: false,
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
      restartedWhilePaused: rt.restartedWhilePaused,
      steer: capabilitiesOf(conv).steer,
      resuming: rt.resuming,
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
    if (next === S.IdleWarm) enforceWarmCap();
  };

  /**
   * At most `warmCap` sessions stay open app-wide: a session going idle past it closes the one idle
   * longest, never one in a turn, with no notice (it resumes on its next message).
   */
  const enforceWarmCap = (): void => {
    const all = [...runtimes.values()];
    const busy = all.filter((rt) => BUSY.has(rt.state) && rt.session !== null).length;
    const idle = all.flatMap((rt) =>
      rt.state === S.IdleWarm && rt.idleSince !== null
        ? [{ id: rt.id, idleSince: rt.idleSince }]
        : [],
    );
    const close = warmToClose(idle, Math.max(0, warmCap - busy));
    if (close !== null) reduce(runtimeOf(close), { type: 'idle_close' });
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

  /** Reduces `event` and applies what it says; answers the outcome. */
  const reduce = (rt: Runtime, event: ExploreEvent): ExploreOutcome => {
    const outcome = reduceExplore(rt.state, event, factsOf(rt, event));
    if ('refused' in outcome) return outcome;
    // Flags a later effect reads, set now: a start under way sees its cancel at once.
    if (outcome.effects.includes(E.CancelStart)) rt.cancelled = true;
    if (outcome.effects.includes(E.DropPendingStart)) rt.parked = false;
    // What streamed is kept as it stands now: the next turn may begin streaming before the chain runs.
    if (outcome.effects.includes(E.StorePartial)) storePartialNow(rt);
    if (outcome.effects.includes(E.WithdrawCard) && rt.card !== null) {
      deps.withdrawCard?.(rt.card);
      rt.card = null;
    }
    // A start sends what waited when it was asked for; what lands later is the next turn's.
    const taken: Taken = {
      waiting: new Set(unpushed(rt).map((item) => item.id)),
      end: { how: rt.ended, starters: [...rt.starters] },
    };
    setState(rt, outcome.next);
    for (const effect of outcome.effects) enqueue(rt, () => apply(rt, effect, taken));
    return outcome;
  };

  /** Whether an outcome sends something now: a start, a push or an injection. */
  const runs = (outcome: ExploreOutcome): boolean =>
    'effects' in outcome &&
    outcome.effects.some((e) => e === E.Start || e === E.Push || e === E.Inject);

  /** The open "Send now" line is resolved: what waited under it is on its way (calls 12, 29). */
  const resolveSendNow = (rt: Runtime): void => {
    const marker = openTurnMarker(state.db, rt.id);
    if (marker === null) return;
    state.write((ctx) => {
      updateItem(ctx, marker.id, {
        body: { marker: TurnMarker.SendNow, resolvedAt: ctx.now },
      });
    });
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

  /**
   * Checks again, at the pause's end (or the next month's first instant for a cap), whether the account
   * can run; a check that finds it still blocked waits silently for the next (call 6).
   */
  const armPause = (rt: Runtime): void => {
    rt.pauseTimer?.cancel();
    const now = clock.now();
    const at = rt.pausedUntil ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    rt.pauseTimer = timerAt(clock, at, () => {
      rt.pauseTimer = null;
      recheckPause(rt);
    });
  };

  const recheckPause = (rt: Runtime): void => {
    if (rt.state !== S.PausedAccount) return;
    const conv = conversation(rt.id);
    const blocked = deps.accountBlocked(accountOf(conv).id, conv.projectId);
    if (blocked === null) {
      rt.pauseTimer?.cancel();
      rt.pauseTimer = null;
      rt.pausedUntil = null;
      reduce(rt, { type: 'account_resumed' });
      rt.restartedWhilePaused = false;
      return;
    }
    rt.pausedUntil = blocked.until;
    if (rt.pauseTimer === null || blocked.until !== null) armPause(rt);
  };

  /** The agent has spoken in the conversation, so a fresh session lacks what it said. */
  const spoke = (rt: Runtime): boolean =>
    hasItemOfKind(state.db, rt.id, ConversationItemKind.AgentMessage);

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
    // A start the account runtime holds reads as an end for the limit (call 6): nothing is sent.
    const blocked = deps.accountBlocked(account.id, conv.projectId);
    if (blocked !== null) {
      rt.pausedUntil = blocked.until;
      rt.inTurn = false;
      reduce(rt, { type: 'ended', how: 'paused' });
      return;
    }
    const resume = conv.providerSessionId;
    const fresh = resume === null;
    // A fresh session after the agent has spoken is told what came before, and the digest is kept.
    const digest = fresh && spoke(rt) ? hooks.digest(conv) : null;
    if (digest !== null)
      state.write((ctx) => {
        insertItem(ctx, rt.id, {
          author: ConversationItemAuthor.System,
          kind: ConversationItemKind.Digest,
          body: { text: digest },
        });
      });
    const limits: PictureLimits = pictureLimitsFor(account.kind);
    const out = combined(
      items.map((item) => hooks.outgoing(conv, item, { fresh, digest, limits })),
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
    // Set once the session is made; its events and cards come only after, on a later turn of the loop.
    let self: Session | null = null;
    let launch: ExploreLaunch;
    try {
      launch = await hooks.spec(conv, {
        sessionId,
        mcpToken: token,
        resume,
        digest,
        first: out,
        observer: {
          // A card this session waits on is an item and a state (§6.6).
          onWaitStart: (item) => {
            if (self === null || rt.session !== self) return;
            rt.card = item.id;
            state.write((ctx) => {
              insertItem(ctx, rt.id, {
                author: ConversationItemAuthor.Agent,
                kind: ConversationItemKind.Card,
                body: { inboxItemId: item.id },
              });
            });
            reduce(rt, { type: 'card_raised' });
          },
          onWaitEnd: (item) => {
            if (rt.card !== item.id) return;
            rt.card = null;
            reduce(rt, { type: 'card_settled' });
          },
        },
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
          if (self === null || rt.session !== self) return;
          self.started = true;
          rt.resuming = false;
          reduce(rt, { type: 'started' });
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
          // Strictly past the owner's limit, the next start is fresh from the digest.
          const pct = conversation(rt.id).contextPct;
          if (rt.state === S.IdleWarm && pct !== null && pct > hooks.freshAtContextPct)
            reduce(rt, { type: 'context_full' });
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
          // A turn that ran took what it began with; the rest of what the session held goes back to
          // the queue before it stops counting as live (call 22).
          if (self.started && rt.inTurn) settleTurn(rt);
          handBack(rt);
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
          if (how === 'paused')
            rt.pausedUntil = rt.rateReset ?? new Date(clock.now().getTime() + deps.defaultPauseMs);
          rt.rateReset = null;
          reduce(rt, { type: 'ended', how });
        },
      },
    });
    self = { open, asked: false, started: false };
    rt.session = self;
    rt.resuming = !fresh;
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
      case E.FreshNext:
        state.write((ctx) => {
          patchConversation(ctx, rt.id, { providerSessionId: null });
          insertItem(ctx, rt.id, {
            author: ConversationItemAuthor.System,
            kind: ConversationItemKind.Notice,
            body: { text: FRESH_SESSION_NOTICE },
          });
        });
        return;
      case E.StartFreshFromDigest:
        // The resume failed before it started: once, a fresh session from the digest (call 8).
        rt.resuming = false;
        state.write((ctx) => {
          patchConversation(ctx, rt.id, { providerSessionId: null });
        });
        await start(rt, taken.waiting);
        return;
      case E.PausedNotice: {
        const until = rt.pausedUntil;
        notice(rt, until === null ? CAPPED_NOTICE : pausedNotice(until));
        armPause(rt);
        return;
      }
      case E.SendNow:
        if (openTurnMarker(state.db, rt.id) === null)
          state.write((ctx) => {
            insertItem(ctx, rt.id, {
              author: ConversationItemAuthor.System,
              kind: ConversationItemKind.TurnMarker,
              body: { marker: TurnMarker.SendNow, resolvedAt: null },
            });
          });
        return;
      // Stored or cleared when reduced; takeover and archive are Sessions' (M5a, M6).
      case E.StorePartial:
      case E.DropPendingStart:
      case E.WithdrawCard:
      case E.HandBackNotice:
      case E.Archive:
      case E.ArchiveAfterStop:
        return;
    }
  };

  // --- The engine -------------------------------------------------------------------------------------

  const queued = (id: ConversationId): void => {
    // Once the engine has closed, a starter stays queued for the next start's Send now.
    if (closed) return;
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
    if (runs(reduce(rt, { type: 'builder_message' }))) resolveSendNow(rt);
  };

  const release = (rt: Runtime): void => {
    if (closed || holding(rt) || !rt.parked) return;
    rt.parked = false;
    if (unpushed(rt).length > 0 && runs(reduce(rt, { type: 'builder_message' })))
      resolveSendNow(rt);
  };

  const recover = async (): Promise<void> => {
    for (const conv of listConversationsOfProfile(state.db, ConversationProfile.Explore)) {
      const hooks = owners.get(conv.ownerKind);
      if (hooks === undefined) continue;
      const found = await settleRestart({ state, adapter, log }, conv, hooks, capabilitiesOf(conv));
      for (const card of found.cards) deps.withdrawCard?.(card);
      const rt = runtimeOf(conv.id);
      rt.state = conversation(conv.id).state ?? S.IdleCold;
      if (rt.state === S.PausedAccount) {
        // The reset a pause waited for is not kept: it is checked again after the default pause.
        rt.restartedWhilePaused = true;
        rt.pausedUntil =
          deps.accountBlocked(accountOf(conv).id, conv.projectId)?.until ??
          new Date(clock.now().getTime() + deps.defaultPauseMs);
        armPause(rt);
      }
      reduce(rt, { type: 'daemon_restart' });
      // Its Send now line is written before the API serves.
      await rt.chain;
    }
  };

  const close = async (): Promise<void> => {
    closed = true;
    unsubscribeAccounts();
    const stopping: Promise<void>[] = [];
    for (const rt of runtimes.values()) {
      for (const timer of [rt.idle, rt.grace, rt.pauseTimer]) timer?.cancel();
      rt.idle = null;
      rt.grace = null;
      rt.pauseTimer = null;
      const session = rt.session;
      if (session === null) continue;
      // Its events stop first (call 25); what it held goes back and what streamed is kept (call 22).
      session.open.detach();
      handBack(rt);
      storePartialNow(rt);
      stopping.push(stopSession(rt, session));
    }
    await Promise.all(stopping);
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
    sendNow(id) {
      const rt = runtimeOf(id);
      if (openTurnMarker(state.db, id) === null)
        throw new ConflictError('Nothing waits under Send now');
      if (holding(rt)) throw new ConflictError('Nothing can run while 10db holds new turns');
      const facts = factsOf(rt, { type: 'builder_message' });
      const would = reduceExplore(rt.state, { type: 'builder_message' }, facts);
      if ('refused' in would) throw new ConflictError(would.refused);
      if (!runs(would)) throw new ConflictError(`Nothing can run while ${stateWords(rt.state)}`);
      reduce(rt, { type: 'builder_message' });
      resolveSendNow(rt);
    },
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
        sendNow: openTurnMarker(state.db, id) !== null,
        pausedUntil:
          rt.state === S.PausedAccount && rt.pausedUntil !== null
            ? rt.pausedUntil.toISOString()
            : null,
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
    recover,
    close,
  };
}
