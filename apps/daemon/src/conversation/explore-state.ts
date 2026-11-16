import { ConversationState, type SteerMode } from '@10db/contracts';

// Sessions spec §6.7: an explore conversation's state × event table, as a pure reducer. The engine
// stores a builder message before it reduces, so "store" is no effect here; every other phrase of a
// cell is one effect, in the order the engine applies them.

export type ExploreEvent =
  | { readonly type: 'builder_message' }
  | { readonly type: 'started' }
  | { readonly type: 'card_raised' }
  | { readonly type: 'card_settled' }
  | { readonly type: 'stop' }
  | { readonly type: 'stop_settled' }
  | { readonly type: 'stop_grace_passed' }
  | { readonly type: 'turn_complete' }
  | { readonly type: 'idle_close' }
  | { readonly type: 'context_full' }
  | { readonly type: 'ended'; readonly how: 'error' | 'paused' | 'unasked' }
  | { readonly type: 'account_resumed' }
  | { readonly type: 'open_terminal' }
  | { readonly type: 'hand_back' }
  /** The builder's terminal never opened after the chat was taken over. */
  | { readonly type: 'terminal_failed' }
  | { readonly type: 'daemon_restart' }
  | { readonly type: 'archive'; readonly confirmed: boolean }
  | { readonly type: 'do_it' };

export interface ExploreFacts {
  /** The turn starters waiting in the queue. */
  readonly queued: number;
  /** The conversation has an agent session to resume or take over. */
  readonly providerSessionId: boolean;
  /** The account resumed after a restart found the conversation paused. */
  readonly restartedWhilePaused: boolean;
  readonly steer: SteerMode;
  /** The session starting resumes an earlier one. */
  readonly resuming: boolean;
}

export const ExploreEffect = {
  Start: 'start',
  Push: 'push',
  Inject: 'inject',
  DropPendingStart: 'drop_pending_start',
  CancelStart: 'cancel_start',
  Interrupt: 'interrupt',
  WithdrawCard: 'withdraw_card',
  RepushStillQueued: 'repush_still_queued',
  NextTurn: 'next_turn',
  StopHandle: 'stop_handle',
  StorePartial: 'store_partial',
  Close: 'close',
  FreshNext: 'fresh_next',
  StartFreshFromDigest: 'start_fresh_from_digest',
  OnTurnEnded: 'on_turn_ended',
  PausedNotice: 'paused_notice',
  RunQueue: 'run_queue',
  SendNow: 'send_now',
  HandBackNotice: 'hand_back_notice',
  Archive: 'archive',
  ArchiveAfterStop: 'archive_after_stop',
} as const;
export type ExploreEffect = (typeof ExploreEffect)[keyof typeof ExploreEffect];

export type ExploreOutcome =
  | { readonly next: ConversationState; readonly effects: readonly ExploreEffect[] }
  | { readonly refused: string };

const E = ExploreEffect;
const S = ConversationState;
const SEALED_WORDS = 'This session handed its work to a task';
const NO_SESSION_WORDS = 'Send a message first';

const to = (next: ConversationState, ...effects: ExploreEffect[]): ExploreOutcome => ({
  next,
  effects,
});
const refuse = (refused: string): ExploreOutcome => ({ refused });

/** What an early end of a turn always does: store what streamed, and tell the owner (§6.3). */
const EARLY_END = [E.StorePartial, E.OnTurnEnded] as const;

/** A stop's settling: the receipt or the turn's end after Stop. */
function stopSettled(facts: ExploreFacts): ExploreOutcome {
  const settled = [...EARLY_END, E.RepushStillQueued];
  return facts.queued > 0 ? to(S.Running, ...settled, E.NextTurn) : to(S.IdleWarm, ...settled);
}

/** An `ended` from a state the table names for it. */
function endedFrom(
  state: ConversationState,
  how: 'error' | 'paused' | 'unasked',
  facts: ExploreFacts,
): ExploreOutcome {
  const turnWas =
    state === S.Running || state === S.Stopping
      ? [...EARLY_END]
      : state === S.WaitingCard
        ? [E.WithdrawCard, ...EARLY_END]
        : [];
  const sendNow = facts.queued > 0 ? [E.SendNow] : [];
  switch (how) {
    case 'error':
      if (state === S.Starting && facts.resuming) return to(S.Starting, E.StartFreshFromDigest);
      return to(S.EndedError, ...turnWas, ...sendNow);
    case 'paused':
      return to(S.PausedAccount, ...turnWas, E.PausedNotice);
    case 'unasked':
      return to(state === S.Starting ? S.EndedError : S.IdleCold, ...turnWas, ...sendNow);
  }
}

/** A restart from a state the restart moves to `idle_cold`; anything queued waits under Send now. */
function restarted(facts: ExploreFacts, ...effects: ExploreEffect[]): ExploreOutcome {
  return to(S.IdleCold, ...effects, ...(facts.queued > 0 ? [E.SendNow] : []));
}

/** Whether `ended` has a cell in `state`. */
const endsIn = (state: ConversationState): boolean =>
  state === S.IdleWarm ||
  state === S.Starting ||
  state === S.Running ||
  state === S.WaitingCard ||
  state === S.Stopping;

/** The words a refused action gives in a state that runs or is starting. */
function busyWords(state: ConversationState): string {
  switch (state) {
    case S.Starting:
      return 'The session is starting';
    case S.Running:
      return 'Stop first';
    case S.WaitingCard:
      return 'Answer the card first';
    case S.Stopping:
      return 'The turn is stopping';
    case S.IdleCold:
    case S.IdleWarm:
    case S.TakenOver:
    case S.PausedAccount:
    case S.EndedError:
    case S.Sealed:
      return NO_SESSION_WORDS;
  }
}

function sealed(event: ExploreEvent): ExploreOutcome {
  switch (event.type) {
    case 'builder_message':
    case 'stop':
    case 'open_terminal':
      return refuse(SEALED_WORDS);
    case 'archive':
      return to(S.Sealed, E.Archive);
    case 'started':
    case 'card_raised':
    case 'card_settled':
    case 'stop_settled':
    case 'stop_grace_passed':
    case 'turn_complete':
    case 'idle_close':
    case 'context_full':
    case 'ended':
    case 'account_resumed':
    case 'hand_back':
    case 'terminal_failed':
    case 'daemon_restart':
    case 'do_it':
      return to(S.Sealed);
  }
}

/** The next state and the effects of `event` in `state`, or why it is refused. Pure. */
export function reduceExplore(
  state: ConversationState,
  event: ExploreEvent,
  facts: ExploreFacts,
): ExploreOutcome {
  if (state === S.Sealed) return sealed(event);
  const stay = to(state);
  switch (event.type) {
    case 'builder_message':
      switch (state) {
        case S.IdleCold:
        case S.EndedError:
          return to(S.Starting, E.Start);
        case S.IdleWarm:
          return to(S.Running, E.Push);
        case S.Running:
        case S.WaitingCard:
          return facts.steer === 'inject' ? to(state, E.Inject) : stay;
        case S.Starting:
        case S.Stopping:
        case S.TakenOver:
        case S.PausedAccount:
          return stay;
      }
      return stay;
    case 'started':
      return state === S.Starting ? to(S.Running, E.Push) : stay;
    case 'card_raised':
      return state === S.Running ? to(S.WaitingCard) : stay;
    case 'card_settled':
      return state === S.WaitingCard ? to(S.Running) : stay;
    case 'stop':
      switch (state) {
        case S.IdleCold:
          return facts.queued > 0 ? to(S.IdleCold, E.DropPendingStart) : stay;
        case S.Starting:
          return to(S.IdleCold, E.CancelStart);
        case S.Running:
          return to(S.Stopping, E.Interrupt);
        case S.WaitingCard:
          return to(S.Stopping, E.WithdrawCard, E.Interrupt);
        case S.IdleWarm:
        case S.Stopping:
        case S.TakenOver:
        case S.PausedAccount:
        case S.EndedError:
          return stay;
      }
      return stay;
    case 'stop_settled':
      return state === S.Stopping ? stopSettled(facts) : stay;
    case 'stop_grace_passed':
      return state === S.Stopping
        ? to(S.IdleCold, E.StopHandle, ...EARLY_END, ...(facts.queued > 0 ? [E.RunQueue] : []))
        : stay;
    case 'turn_complete':
      if (state === S.Running)
        return facts.queued > 0
          ? to(S.Running, E.OnTurnEnded, E.NextTurn)
          : to(S.IdleWarm, E.OnTurnEnded);
      return state === S.Stopping ? stopSettled(facts) : stay;
    case 'idle_close':
      return state === S.IdleWarm ? to(S.IdleCold, E.Close) : stay;
    case 'context_full':
      return state === S.IdleWarm ? to(S.IdleCold, E.Close, E.FreshNext) : stay;
    case 'ended':
      return endsIn(state) ? endedFrom(state, event.how, facts) : stay;
    case 'account_resumed':
      if (state !== S.PausedAccount) return stay;
      if (!facts.restartedWhilePaused) return to(S.IdleCold, E.RunQueue);
      return to(S.IdleCold, ...(facts.queued > 0 ? [E.SendNow] : []));
    case 'open_terminal':
      switch (state) {
        case S.IdleCold:
        case S.EndedError:
          return facts.providerSessionId ? to(S.TakenOver) : refuse(NO_SESSION_WORDS);
        case S.IdleWarm:
          return to(S.TakenOver, E.Close);
        case S.PausedAccount:
          return to(S.TakenOver);
        case S.TakenOver:
          return stay;
        case S.Starting:
        case S.Running:
        case S.WaitingCard:
        case S.Stopping:
          return refuse(busyWords(state));
      }
      return stay;
    case 'hand_back':
      return state === S.TakenOver ? to(S.IdleCold, E.HandBackNotice, E.RunQueue) : stay;
    case 'terminal_failed':
      return state === S.TakenOver ? to(S.IdleCold, E.RunQueue) : stay;
    case 'daemon_restart':
      switch (state) {
        case S.IdleCold:
        case S.IdleWarm:
        case S.Starting:
        case S.Stopping:
          return restarted(facts);
        case S.Running:
          return restarted(facts, E.StorePartial);
        case S.WaitingCard:
          return restarted(facts, E.WithdrawCard, E.StorePartial);
        case S.TakenOver:
        case S.PausedAccount:
        case S.EndedError:
          return stay;
      }
      return stay;
    case 'archive':
      switch (state) {
        case S.IdleWarm:
          return to(S.IdleCold, E.Close, E.Archive);
        case S.Starting:
          return to(S.IdleCold, E.CancelStart, E.Archive);
        case S.Running:
          return to(S.Stopping, E.Interrupt, E.ArchiveAfterStop);
        case S.WaitingCard:
          return to(S.Stopping, E.WithdrawCard, E.Interrupt, E.ArchiveAfterStop);
        case S.Stopping:
          return to(S.Stopping, E.ArchiveAfterStop);
        case S.TakenOver:
          return event.confirmed ? to(S.IdleCold, E.Archive) : refuse('End takeover and archive?');
        case S.IdleCold:
        case S.PausedAccount:
        case S.EndedError:
          return to(state, E.Archive);
      }
      return stay;
    case 'do_it':
      switch (state) {
        case S.IdleWarm:
          return to(S.Sealed, E.Close);
        case S.Starting:
          return to(S.Sealed, E.CancelStart);
        case S.Running:
        case S.Stopping:
          return to(S.Sealed, E.StopHandle, E.StorePartial);
        case S.WaitingCard:
          return to(S.Sealed, E.WithdrawCard, E.StopHandle, E.StorePartial);
        case S.TakenOver:
          return refuse('Hand back first');
        case S.IdleCold:
        case S.PausedAccount:
        case S.EndedError:
          return to(S.Sealed);
      }
      return stay;
  }
}
