import type { ConversationOwnerKind } from '@10db/contracts';
import {
  agentKind,
  ConflictError,
  ConversationItemAuthor,
  ConversationItemKind,
  ConversationProfile,
  ConversationState,
  ModelSwitch,
  TurnMarker,
  type ConversationDto,
  type ConversationId,
  type ConversationLiveDto,
} from '@10db/contracts';
import {
  conversationCostUsd,
  getAccountRow,
  getConversation,
  getProject,
  getSession,
  insertItem,
  listConversationsOfProfile,
  listPushedTurnStarters,
  listQueuedTurnStarters,
  markItemsHandedBack,
  openTurnMarker,
  patchConversation,
  type ConversationItemRow,
  type ConversationRow,
} from '@10db/db';
import { pushedAgainAfter } from './delivery-rules';
import type { ExploreOwnerHooks } from './explore-hooks';
import { settleRestart } from './explore-recovery';
import {
  BUSY,
  newRuntime,
  stateWords,
  type EngineCore,
  type ExploreEngineDeps,
  type Runtime,
  type Taken,
} from './explore-runtime';
import { createPauses } from './explore-pauses';
import { createStarts } from './explore-starts';
import {
  ExploreEffect,
  reduceExplore,
  type ExploreEvent,
  type ExploreFacts,
  type ExploreOutcome,
} from './explore-state';
import { createStops } from './explore-stops';
import { createTurns } from './explore-turns';
import { warmToClose } from './warm-cap';

// Sessions spec §6.3–§6.8: the engine that owns every explore conversation's live session. Each
// conversation's state moves only through the reducer, is written with the conversation, and its
// effects run one at a time on the conversation's chain. Its parts: how a session starts
// (explore-starts), how a turn takes its starters (explore-turns), how a turn stops and is redone
// (explore-stops), and how a paused account is checked again (explore-pauses).

export const IDLE_MS = 10 * 60_000;
export const STOP_GRACE_MS = 10_000;
export const WARM_CAP = 4;
/** A live session this close to its credentials' expiry is closed before a push, so the next start has fresh ones. */
const CREDENTIALS_MARGIN_MS = 5 * 60_000;
/** What a conversation reads when its next session starts fresh past the context limit. */
export const FRESH_SESSION_NOTICE = 'Continued in a fresh session. Nothing is lost.';
/** What a chat reads once it is handed back from the builder's terminal. */
export const HAND_BACK_NOTICE =
  "Turns from your terminal are in the agent's memory; they aren't shown here.";
/** What a conversation paused for the account's usage limit reads, naming when it resumes. */
export const pausedNotice = (until: Date): string =>
  `Paused for the account's usage limit until ${until.toISOString()}. What you send waits, and runs then.`;
/** What a conversation paused at a metered account's monthly cap reads; it has no time to name. */
export const CAPPED_NOTICE =
  'Paused: the account reached its monthly limit. What you send waits, and runs once the account can run again.';

const S = ConversationState;
const E = ExploreEffect;
const NOT_IN_TERMINAL_WORDS = 'Not in your terminal';

/** The events whose outcome never starts a turn, so a hold does not hide the queue from them. */
const COUNTED_UNDER_HOLD: ReadonlySet<ExploreEvent['type']> = new Set([
  'stop',
  'ended',
  'daemon_restart',
]);

export interface ExploreEngine {
  register(kind: typeof ConversationOwnerKind.Chat, hooks: ExploreOwnerHooks): void;
  /** A turn starter was stored; reduces `builder_message`, or parks it behind a hold. */
  queued(id: ConversationId): void;
  stop(id: ConversationId): Promise<void>;
  /** Stop, then the edited message as the next turn. */
  redo(id: ConversationId, post: () => ConversationItemRow): Promise<ConversationItemRow>;
  /** Refused with the state's words when nothing would run. */
  sendNow(id: ConversationId): void;
  modelChanged(id: ConversationId, model: string | null): Promise<void>;
  holdStarts(id: ConversationId): void;
  /** Lets parked starters run; whether a turn began, which it doesn't when nothing waits or the update hold is on. */
  releaseStarts(id: ConversationId): boolean;
  view(id: ConversationId): ConversationDto;
  live(id: ConversationId): ConversationLiveDto;
  /** Conversations `starting`, `running`, `waiting_card` or `stopping`: what an update drain waits for. */
  busy(): readonly ConversationId[];
  /** A queue waits on a hold; Plan's view reads it for `waitingForUpdate`. */
  parked(id: ConversationId): boolean;
  /** Resolves once the conversation runs no turn and has no effect left to apply. */
  settled(id: ConversationId): Promise<void>;
  /**
   * Its owner archives it (sessions spec §6.7): a start is cancelled, a turn stopped within the stop
   * grace (its partial text kept), a card withdrawn, and a warm session closed with its row ended, so
   * its token reaches nothing. Until `unretire`, nothing it is sent starts a turn.
   */
  retire(id: ConversationId): Promise<void>;
  unretire(id: ConversationId): void;
  /**
   * A chat's work moved to another folder: a turn still running is stopped (its stop, not its end, is awaited as
   * far as the grace allows), then the warm session is closed so the next start opens in the new root, resuming
   * the same provider session. Nothing else changes; starts held by the caller stay held.
   */
  relocate(id: ConversationId): Promise<void>;
  /**
   * Do It hands the conversation's work to a task (sessions spec §7.3): a start is cancelled, a turn stopped
   * with its partial text kept, a card withdrawn, and a warm session closed with its row ended, so its token
   * reaches nothing. The conversation is `sealed` and its owner hears it. Refused while it is taken over.
   */
  seal(id: ConversationId): Promise<void>;
  /**
   * Takes the chat to the builder's terminal: `taken_over`, with its session closed. `closed` settles once the
   * close has run. Throws `ConflictError` for a retired chat or the state's busy words.
   */
  openTerminal(id: ConversationId): { readonly closed: Promise<void> };
  /** Gives the chat back, with the notice, and runs what waited. Throws `ConflictError` unless `taken_over`. */
  handBack(id: ConversationId): void;
  /** The terminal never opened: gives the chat back with no notice, and runs what waited. */
  terminalFailed(id: ConversationId): void;
  recover(): Promise<void>;
  close(): Promise<void>;
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
        pauses.recheckPause(rt);
  });
  const hooksOf = (conv: ConversationRow): ExploreOwnerHooks => {
    const hooks = owners.get(conv.ownerKind);
    if (hooks === undefined) throw new ConflictError(`No explore owner runs a ${conv.ownerKind}`);
    return hooks;
  };
  const accountOf = (conv: ConversationRow) => {
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
      rt = newRuntime(id, conversation(id).state ?? S.IdleCold);
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

  /** The starters waiting: queued, or handed to the live session and not taken. */
  const queuedNow = (rt: Runtime): number => unpushed(rt).length + handed(rt).length;

  /**
   * The reducer's facts. A hold counts nothing queued, except to the events whose outcome
   * never starts a turn: a Stop, which clears a parked start, an end and a restart, which put what
   * waits under Send now.
   */
  const factsOf = (
    rt: Runtime,
    event: ExploreEvent,
    queued: number = queuedNow(rt),
  ): ExploreFacts => {
    const conv = conversation(rt.id);
    const parked = holding(rt) && !COUNTED_UNDER_HOLD.has(event.type);
    return {
      queued: parked || rt.retired ? 0 : queued,
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
    if (!BUSY.has(next)) waitOutHold(rt);
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
    if (close === null) return;
    // A session past its context limit closes as a full one does, so its next start is fresh.
    const rt = runtimeOf(close);
    reduce(rt, { type: turns.pastContextLimit(rt) ? 'context_full' : 'idle_close' });
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

  /**
   * Reduces `event` and applies what it says; answers the outcome. A builder message from outside a turn asks
   * its owner to take what the turn needs first, closing a warm session opened for the other kind of turn so
   * this one starts cold on the right profile; the owner is told the state after every reduce, so what the
   * take held goes back when no turn began. The close and the reduce that follow run in one synchronous
   * sequence with one state report at its end, so the close cannot release what was just taken.
   */
  const reduce = (rt: Runtime, event: ExploreEvent): ExploreOutcome => {
    const conv = conversation(rt.id);
    const hooks = hooksOf(conv);
    if (
      event.type === 'builder_message' &&
      !BUSY.has(rt.state) &&
      !rt.retired &&
      hooks.turnStarting !== undefined &&
      takesTurn(reduceExplore(rt.state, event, factsOf(rt, event)))
    ) {
      const { writes } = hooks.turnStarting(conv);
      const open = rt.session?.open;
      if (
        rt.state === S.IdleWarm &&
        open !== undefined &&
        (open.launch.writes ?? false) !== writes
      ) {
        rt.closeReason = 'the folder changed hands';
        reduceOnce(rt, { type: 'idle_close' });
      }
    }
    let outcome: ExploreOutcome;
    try {
      outcome = reduceOnce(rt, event);
    } finally {
      // The owner hears the state even when the reduce threw, so what the take held goes back.
      hooks.onState?.(conversation(rt.id), rt.state);
    }
    return outcome;
  };

  const reduceOnce = (rt: Runtime, event: ExploreEvent): ExploreOutcome => {
    const queued = queuedNow(rt);
    const facts = factsOf(rt, event, queued);
    const outcome = reduceExplore(rt.state, event, facts);
    if ('refused' in outcome) return outcome;
    // What a hold kept from running (a turn's next starters, what a stop handed back) is parked, so
    // the release runs it.
    const parks =
      facts.queued !== queued && takesTurn(reduceExplore(rt.state, event, { ...facts, queued }));
    // Flags a later effect reads, set now: a start under way sees its cancel at once.
    if (outcome.effects.includes(E.CancelStart)) rt.cancelled = true;
    if (outcome.effects.includes(E.DropPendingStart)) rt.parked = false;
    // What streamed is kept as it stands now: the next turn may begin streaming before the chain runs.
    if (outcome.effects.includes(E.StorePartial)) turns.storePartialNow(rt);
    if (outcome.effects.includes(E.WithdrawCard)) {
      for (const card of rt.cards) deps.withdrawCard?.(card);
      rt.cards.clear();
    }
    // A start sends what waited when it was asked for; what lands later is the next turn's.
    const taken: Taken = {
      waiting: new Set(unpushed(rt).map((item) => item.id)),
      end: { how: rt.ended, starters: [...rt.starters] },
      event: event.type,
    };
    setState(rt, outcome.next);
    for (const effect of outcome.effects) enqueue(rt, () => apply(rt, effect, taken));
    if (parks) park(rt);
    return outcome;
  };

  /** A starter waits on a hold; the owner is told, and the release runs it. */
  const park = (rt: Runtime): void => {
    rt.parked = true;
    const conv = conversation(rt.id);
    hooksOf(conv).onParked?.(conv, true);
    waitOutHold(rt);
  };

  /** Whether an outcome takes the queue into a turn: a start, a push, the next turn or the queue run. */
  const takesTurn = (outcome: ExploreOutcome): boolean =>
    'effects' in outcome &&
    outcome.effects.some(
      (e) => e === E.Start || e === E.Push || e === E.NextTurn || e === E.RunQueue,
    );

  /** Whether an outcome sends something now: a start, a push or an injection. */
  const runs = (outcome: ExploreOutcome): boolean =>
    'effects' in outcome &&
    outcome.effects.some((e) => e === E.Start || e === E.Push || e === E.Inject);

  const notice = (rt: Runtime, text: string): void => {
    state.write((ctx) => {
      insertItem(ctx, rt.id, {
        author: ConversationItemAuthor.System,
        kind: ConversationItemKind.Notice,
        body: { text },
      });
    });
  };

  const core: EngineCore = {
    deps,
    stopGraceMs,
    owners,
    runtimes,
    isClosed: () => closed,
    conversation,
    hooksOf,
    accountOf,
    capabilitiesOf,
    runtimeOf,
    holding,
    unpushed,
    handed,
    reduce,
    setState,
    enqueue,
    notice,
  };
  const turns = createTurns(core);
  const stops = createStops(core, turns);
  const pauses = createPauses(core);
  const starts = createStarts(core, turns);

  // --- Effects ---------------------------------------------------------------------------------------

  const apply = async (rt: Runtime, effect: ExploreEffect, taken: Taken): Promise<void> => {
    switch (effect) {
      case E.Start:
        await starts.start(rt, taken.waiting);
        return;
      case E.Push:
      case E.NextTurn:
        // A session's first message is its prompt, so its turn began with it: `started` pushes nothing.
        if (taken.event !== 'started' && !rt.inTurn) turns.beginTurn(rt);
        return;
      case E.OnTurnEnded: {
        const conv = conversation(rt.id);
        await hooksOf(conv).onTurnEnded(conv, taken.end);
        return;
      }
      case E.Close: {
        const session = rt.session;
        if (session === null) return;
        turns.handBack(rt);
        const reason = rt.closeReason ?? (taken.event === 'context_full' ? 'continued' : 'idle');
        rt.closeReason = null;
        await stops.stopSession(rt, session, reason);
        return;
      }
      case E.HandBackNotice:
        notice(rt, HAND_BACK_NOTICE);
        return;
      case E.RunQueue:
        if (unpushed(rt).length === 0) return;
        // Under a hold the queue waits, parked, for the release.
        if (holding(rt)) park(rt);
        else reduce(rt, { type: 'builder_message' });
        return;
      case E.Inject: {
        // One push each, under its own uuid, so a receipt can name each one.
        const session = rt.session;
        if (session !== null) for (const item of unpushed(rt)) turns.handTo(rt, session, [item]);
        return;
      }
      case E.CancelStart: {
        // The start has run by now: it saw the cancel and opened nothing, or it opened a session.
        rt.cancelled = false;
        rt.resuming = false;
        const session = rt.session;
        if (session === null) return;
        turns.handBack(rt);
        rt.inTurn = false;
        await stops.stopSession(rt, session, 'stopped');
        return;
      }
      case E.Interrupt: {
        const session = rt.session;
        if (session === null) return;
        rt.grace?.cancel();
        rt.grace = clock.setTimeout(() => {
          stops.graceOver(rt, session);
        }, stopGraceMs);
        const receipt = session.open.handle.interrupt().catch(() => null);
        rt.receipt = receipt;
        void receipt.then((answered) => {
          stops.receiptCame(rt, session, answered);
        });
        return;
      }
      case E.RepushStillQueued: {
        const session = rt.session;
        const asked = rt.receipt;
        rt.receipt = null;
        if (session === null) return;
        const receipt = asked === null ? null : await stops.withinGrace(asked, null);
        const still = receipt === null ? null : turns.itemsOf(rt, receipt.stillQueued);
        const again = pushedAgainAfter(handed(rt), still);
        if (!holding(rt)) {
          turns.handTo(rt, session, again);
          return;
        }
        // Under a hold nothing new runs: what may have been lost waits, parked, for the release.
        if (again.length > 0) {
          state.write((ctx) => {
            markItemsHandedBack(
              ctx,
              rt.id,
              again.map((item) => item.id),
            );
          });
          rt.parked = true;
        }
        return;
      }
      case E.StopHandle: {
        const session = rt.session;
        if (session !== null) await stops.stopSession(rt, session, 'stopped');
        return;
      }
      case E.FreshNext:
        state.write((ctx) => {
          patchConversation(ctx, rt.id, { providerSessionId: null });
          insertItem(ctx, rt.id, {
            author: ConversationItemAuthor.System,
            kind: ConversationItemKind.Notice,
            body: {
              text: hooksOf(conversation(rt.id)).words?.freshSession ?? FRESH_SESSION_NOTICE,
            },
          });
        });
        return;
      case E.StartFreshFromDigest:
        // The resume failed before it started: once, a fresh session from the digest.
        rt.resuming = false;
        state.write((ctx) => {
          patchConversation(ctx, rt.id, { providerSessionId: null });
        });
        await starts.start(rt, taken.waiting);
        return;
      case E.PausedNotice: {
        const until = rt.pausedUntil;
        notice(rt, until === null ? CAPPED_NOTICE : pausedNotice(until));
        pauses.armPause(rt);
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
      // Stored or cleared when reduced; this engine stores no takeover or archive.
      case E.StorePartial:
      case E.DropPendingStart:
      case E.WithdrawCard:
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
    if (rt.retired) return;
    if (holding(rt)) {
      park(rt);
      return;
    }
    const expiresAt = rt.session?.open.launch.expiresAt ?? null;
    if (
      rt.state === S.IdleWarm &&
      expiresAt !== null &&
      Date.parse(expiresAt) - CREDENTIALS_MARGIN_MS <= clock.now().getTime()
    )
      reduce(rt, { type: 'idle_close' });
    if (runs(reduce(rt, { type: 'builder_message' }))) turns.resolveSendNow(rt);
  };

  /** Runs what a hold parked; whether a turn began. */
  const release = (rt: Runtime): boolean => {
    if (closed || holding(rt) || !rt.parked) return false;
    rt.parked = false;
    const began = unpushed(rt).length > 0 && runs(reduce(rt, { type: 'builder_message' }));
    if (began) turns.resolveSendNow(rt);
    const conv = conversation(rt.id);
    hooksOf(conv).onParked?.(conv, false);
    return began;
  };

  /**
   * A parked starter waits on the update hold only once no turn runs: while one does, the drain waits
   * for that turn, and a waiter here would count it parked twice.
   */
  const waitOutHold = (rt: Runtime): void => {
    if (!rt.parked || rt.parkWait || deps.hold === undefined || BUSY.has(rt.state)) return;
    rt.parkWait = true;
    void deps.hold.untilClear().then(() => {
      rt.parkWait = false;
      release(rt);
    });
  };

  /** One conversation that can't be recovered is logged and left; the rest still recover. */
  const recover = async (): Promise<void> => {
    for (const conv of listConversationsOfProfile(state.db, ConversationProfile.Explore))
      try {
        await recoverOne(conv);
      } catch (error) {
        log.error(
          { err: error, conversationId: conv.id },
          'an explore conversation did not recover',
        );
      }
  };

  const recoverOne = async (conv: ConversationRow): Promise<void> => {
    const hooks = owners.get(conv.ownerKind);
    if (hooks === undefined) return;
    const found = await settleRestart({ state, adapter, log }, conv, hooks, capabilitiesOf(conv));
    for (const card of found.cards) deps.withdrawCard?.(card);
    const rt = runtimeOf(conv.id);
    // The restart row reads the state the conversation was left in.
    rt.state = conversation(conv.id).state ?? S.IdleCold;
    if (rt.state === S.PausedAccount) {
      // The reset a pause waited for is not kept: it is checked again after the default pause.
      rt.restartedWhilePaused = true;
      rt.pausedUntil =
        deps.accountBlocked(accountOf(conv).id, conv.projectId)?.until ??
        new Date(clock.now().getTime() + deps.defaultPauseMs);
      pauses.armPause(rt);
    }
    reduce(rt, { type: 'daemon_restart' });
    // Its Send now line is written before the API serves.
    await rt.chain;
  };

  const settled = async (id: ConversationId): Promise<void> => {
    const rt = runtimeOf(id);
    for (;;) {
      const chain = rt.chain;
      await chain;
      // Once closed, nothing moves the state again: a restart's recovery settles it.
      if (rt.chain === chain && (!BUSY.has(rt.state) || closed)) return;
      if (rt.chain === chain)
        await new Promise<void>((resolve) => {
          rt.waiters.push(resolve);
        });
    }
  };

  let closedDown: Promise<void> | null = null;
  const close = (): Promise<void> => (closedDown ??= closeDown());
  const closeDown = async (): Promise<void> => {
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
      // Its events stop first; what it held goes back and what streamed is kept.
      session.open.detach();
      turns.handBack(rt);
      turns.storePartialNow(rt);
      stopping.push(stops.stopSession(rt, session, 'stopped'));
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
      const outcome = reduce(rt, { type: 'stop' });
      // An interrupt is asked for on the chain; a cancelled start answers at once, as its preparation
      // may still be under way.
      if ('effects' in outcome && outcome.effects.includes(E.Interrupt))
        await new Promise<void>((resolve) => {
          enqueue(rt, resolve);
        });
    },
    redo: (id, post) => stops.redo(id, post, queued),
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
      turns.resolveSendNow(rt);
    },
    async modelChanged(id, model) {
      const rt = runtimeOf(id);
      if (BUSY.has(rt.state)) throw new ConflictError('Stop first');
      const conv = conversation(id);
      const hooks = hooksOf(conv);
      const before = hooks.describeModel(conv, conv.model);
      const after = hooks.describeModel(conv, model);
      // The pick is the conversation's at once; a warm session takes it on the chain, and only once it
      // has is the change noted. A switch that fails puts the old pick back.
      state.write((ctx) => {
        patchConversation(ctx, id, { model });
      });
      // The warm session as the pick finds it: a message sent right after queues behind the switch.
      const session = rt.state === S.IdleWarm ? rt.session : null;
      const switching = session !== null && after.model !== before.model;
      // No agent changes a live session's effort, and some can't change its model: that session
      // closes at once, before a message sent right after can reach it, and the next start runs the pick.
      const reEffort =
        session !== null && getSession(state.db, session.open.sessionId).effort !== after.effort;
      const closes =
        reEffort || (switching && capabilitiesOf(conv).modelSwitch !== ModelSwitch.NextTurn);
      if (closes) {
        rt.closeReason = 'model changed';
        reduce(rt, { type: 'idle_close' });
      }
      await new Promise<void>((resolve, reject) => {
        enqueue(rt, async () => {
          try {
            if (switching && !closes) await session.open.handle.setModel(after.launchId);
            if (after.model !== before.model)
              state.write((ctx) => {
                insertItem(ctx, id, {
                  author: ConversationItemAuthor.System,
                  kind: ConversationItemKind.Notice,
                  body: { kind: 'model_change', label: after.label, model: after.model },
                });
              });
            resolve();
          } catch (error) {
            state.write((ctx) => {
              patchConversation(ctx, id, { model: conv.model });
            });
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });
    },
    holdStarts(id) {
      runtimeOf(id).held = true;
    },
    releaseStarts(id) {
      const rt = runtimeOf(id);
      rt.held = false;
      return release(rt);
    },
    view(id) {
      const rt = runtimeOf(id);
      const conv = conversation(id);
      const capabilities = capabilitiesOf(conv);
      return {
        id,
        owner: { kind: conv.ownerKind, id: conv.ownerId },
        state: rt.state,
        capabilities: rt.judge === null ? capabilities : { ...capabilities, judge: rt.judge },
        model: conv.model,
        effort: conv.effort,
        contextPct: conv.contextPct,
        queued: unpushed(rt).length,
        costUsd: capabilities.costUsd ? (conversationCostUsd(state.db, id) ?? 0) : null,
        sendNow: openTurnMarker(state.db, id) !== null,
        pausedUntil:
          rt.state === S.PausedAccount && rt.pausedUntil !== null
            ? rt.pausedUntil.toISOString()
            : null,
        commands: conv.commands,
        backgroundTasks: [...(rt.session?.open.backgroundTasks() ?? [])],
      };
    },
    live(id) {
      return {
        conversationId: id,
        items: runtimeOf(id).session?.open.buffers.snapshot() ?? [],
        waitingForFolder: false,
      };
    },
    busy: () => [...runtimes.values()].filter((rt) => BUSY.has(rt.state)).map((rt) => rt.id),
    parked: (id) => runtimeOf(id).parked,
    settled,
    async retire(id) {
      const rt = runtimeOf(id);
      rt.retired = true;
      rt.parked = false;
      reduce(rt, { type: 'archive', confirmed: true });
      await settled(id);
      // A stop leaves its session warm; an archived conversation keeps none.
      if (rt.session !== null) reduce(rt, { type: 'idle_close' });
      await rt.chain;
      await rt.closing;
    },
    unretire(id) {
      runtimeOf(id).retired = false;
    },
    async relocate(id) {
      const rt = runtimeOf(id);
      if (BUSY.has(rt.state)) {
        const outcome = reduce(rt, { type: 'stop' });
        if ('effects' in outcome && outcome.effects.includes(E.Interrupt))
          await new Promise<void>((resolve) => {
            enqueue(rt, resolve);
          });
      }
      await settled(id);
      // A stop leaves its session warm, and a session in the old root must not take the next turn.
      if (rt.session !== null) reduce(rt, { type: 'idle_close' });
      await rt.chain;
      await rt.closing;
    },
    async seal(id) {
      const rt = runtimeOf(id);
      // Refused before anything is touched: a taken-over conversation keeps what waits in it.
      const would = reduceExplore(rt.state, { type: 'do_it' }, factsOf(rt, { type: 'do_it' }));
      if ('refused' in would) throw new ConflictError(would.refused);
      rt.parked = false;
      reduce(rt, { type: 'do_it' });
      await settled(id);
      // A stop leaves its session warm, and a sealed conversation keeps none.
      const session = rt.session;
      if (session !== null) {
        turns.handBack(rt);
        await stops.stopSession(rt, session, 'stopped');
      }
      await rt.chain;
      await rt.closing;
    },
    openTerminal(id) {
      const rt = runtimeOf(id);
      if (rt.retired) throw new ConflictError('This chat is archived');
      const outcome = reduce(rt, { type: 'open_terminal' });
      if ('refused' in outcome) throw new ConflictError(outcome.refused);
      // Queued behind the close the reduce asked for, so it settles once that has run.
      const closed = new Promise<void>((resolve) => {
        enqueue(rt, resolve);
      });
      return { closed };
    },
    handBack(id) {
      const rt = runtimeOf(id);
      if (rt.state !== S.TakenOver) throw new ConflictError(NOT_IN_TERMINAL_WORDS);
      reduce(rt, { type: 'hand_back' });
    },
    terminalFailed(id) {
      reduce(runtimeOf(id), { type: 'terminal_failed' });
    },
    recover,
    close,
  };
}
