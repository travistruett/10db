import type { ConversationOwnerKind, JudgeKind } from '@10db/contracts';
import {
  ConversationState,
  type AccountId,
  type AgentCapabilitiesDto,
  type ConversationId,
  type ConversationItemId,
  type InboxItemId,
  type ProjectId,
  type SessionId,
} from '@10db/contracts';
import type { ConversationItemRow, ConversationRow } from '@10db/db';
import type { Clock, Timer } from '../clock';
import type { AccountAgent } from '../environment';
import type { EventBus, LiveFrames, StateStore } from '../events';
import type { Logger } from '../log';
import { SessionEndReason, type AgentAdapter, type InterruptReceipt } from '../sessions';
import type { Hold } from '../verify';
import type { ExploreLaunch, ExploreOwnerHooks, TurnEnd } from './explore-hooks';
import type { OpenSession } from './explore-session';
import type { ExploreEvent, ExploreOutcome } from './explore-state';

// What the explore engine keeps for each conversation, and what its parts (starts, turns, stops,
// pauses) share: the conversation's runtime, and the engine's core, which moves a state only
// through the reducer.

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

const S = ConversationState;

/** The states a turn is under way in: what an update drain waits for. */
export const BUSY: ReadonlySet<ConversationState> = new Set([
  S.Starting,
  S.Running,
  S.WaitingCard,
  S.Stopping,
]);

/** What a state is, in the words a refused Send Now gives. */
export function stateWords(state: ConversationState): string {
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

/** How a session's own end reads to the reducer. */
export function endedHow(reason: SessionEndReason): 'error' | 'paused' | 'unasked' {
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

/** What a reduction saw, for its effects to act on: the starters waiting, and the turn that ended. */
export interface Taken {
  readonly waiting: ReadonlySet<ConversationItemId>;
  readonly end: TurnEnd;
  readonly event: ExploreEvent['type'];
}

export interface Session {
  readonly open: OpenSession;
  /** The engine asked it to end: its `ended` is no event of the conversation's. */
  asked: boolean;
  /** It reported `started`: the turn its first message began ran on it. */
  started: boolean;
  /** Why the engine ended it, kept on its row; its own end reason otherwise. */
  endReason: string | null;
  /** Resolves once what the session was prepared with has been released, after its end. */
  released: Promise<void> | null;
}

/** What a start has made so far, for a failure to undo. */
export interface Made {
  launch: ExploreLaunch | null;
  sessionId: SessionId | null;
  pushed: readonly ConversationItemId[];
}

export interface Runtime {
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
  /** A starter waits on a hold. */
  parked: boolean;
  /** Convert's hold on this conversation. */
  held: boolean;
  /** A start under way was cancelled. */
  cancelled: boolean;
  /** Ends a stop that neither a receipt nor the turn's end settled in time. */
  grace: Timer | null;
  /** What the last interrupt answers. */
  receipt: Promise<InterruptReceipt> | null;
  /** The message a Redo replaces, while its stop settles. */
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
  /** The Inbox cards the session waits on; the turn goes on once none is left. */
  readonly cards: Set<InboxItemId>;
  /** A restart found the conversation paused: its account's return waits under Send now. */
  restartedWhilePaused: boolean;
  /** Why the next close of a warm session is asked for, when it is not the idle timer's. */
  closeReason: string | null;
  /** A parked starter waits for the update hold to clear. */
  parkWait: boolean;
  /** Its owner archived it: nothing it is sent starts a turn until it is brought back. */
  retired: boolean;
  /**
   * The judge its last session started on, which the view shows: the rules where the account's judge is 10db's and
   * it wasn't ready. Null before a session starts, when the view shows the account's.
   */
  judge: JudgeKind | null;
  /** Told when the state or the chain moves, for `settled`. */
  waiters: (() => void)[];
}

/** A conversation's runtime as the engine first sees it, in the state it was stored in. */
export function newRuntime(id: ConversationId, state: ConversationState): Runtime {
  return {
    id,
    state,
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
    redo: null,
    lastSession: null,
    resuming: false,
    rateReset: null,
    pausedUntil: null,
    pauseTimer: null,
    cards: new Set(),
    restartedWhilePaused: false,
    closeReason: null,
    parkWait: false,
    retired: false,
    judge: null,
    waiters: [],
  };
}

/** What the engine's parts share: its deps, its conversations, and the one way a state moves. */
export interface EngineCore {
  readonly deps: ExploreEngineDeps;
  readonly stopGraceMs: number;
  readonly owners: ReadonlyMap<ConversationOwnerKind, ExploreOwnerHooks>;
  readonly runtimes: ReadonlyMap<ConversationId, Runtime>;
  /** The engine has closed: nothing starts. */
  isClosed(): boolean;
  conversation(id: ConversationId): ConversationRow;
  hooksOf(conv: ConversationRow): ExploreOwnerHooks;
  accountOf(conv: ConversationRow): AccountAgent & { id: AccountId };
  capabilitiesOf(conv: ConversationRow): AgentCapabilitiesDto;
  runtimeOf(id: ConversationId): Runtime;
  /** Convert's hold or the update hold keeps new turns from starting. */
  holding(rt: Runtime): boolean;
  /** The starters waiting, not yet handed to a session. */
  unpushed(rt: Runtime): ConversationItemRow[];
  /** The starters the live session holds, untaken. */
  handed(rt: Runtime): ConversationItemRow[];
  /** Reduces `event` and applies what it says; answers the outcome. */
  reduce(rt: Runtime, event: ExploreEvent): ExploreOutcome;
  setState(rt: Runtime, next: ConversationState): void;
  /** Runs `work` on the conversation's chain, after every effect before it. */
  enqueue(rt: Runtime, work: () => Promise<void> | void): void;
  notice(rt: Runtime, text: string): void;
}
