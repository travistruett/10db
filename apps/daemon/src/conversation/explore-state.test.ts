import { ConversationState } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import {
  reduceExplore,
  type ExploreEffect,
  type ExploreEvent,
  type ExploreFacts,
  type ExploreOutcome,
} from './explore-state';
import { BUSY } from './explore-runtime';

// Sessions spec §6.7: one row per cell of the explore conversation's state × event table, read by
// the plan's "Reading the cells", then the rows beyond it, named by their section.

type S = ConversationState;
interface EventExtra {
  readonly how?: 'error' | 'paused' | 'unasked';
  readonly confirmed?: boolean;
}
type Row = [
  ExploreEvent['type'],
  S,
  string,
  Partial<ExploreFacts> & { event?: EventExtra },
  ExploreOutcome,
];

const BASE_FACTS: ExploreFacts = {
  queued: 0,
  providerSessionId: false,
  restartedWhilePaused: false,
  steer: 'queue',
  resuming: false,
};
const Q = { queued: 2 };
const go = (next: S, ...effects: ExploreEffect[]): ExploreOutcome => ({ next, effects });
const no = (refused: string): ExploreOutcome => ({ refused });

const S_ = {
  cold: 'idle_cold',
  warm: 'idle_warm',
  starting: 'starting',
  running: 'running',
  card: 'waiting_card',
  stopping: 'stopping',
  taken: 'taken_over',
  paused: 'paused_account',
  error: 'ended_error',
  sealed: 'sealed',
} as const;
const SEALED = 'This session handed its work to a task';
const ended = (how: 'error' | 'paused' | 'unasked') => ({ event: { how } });

const CELLS: Row[] = [
  // builder message
  ['builder_message', S_.cold, 'store; start → starting', {}, go('starting', 'start')],
  ['builder_message', S_.warm, 'store; push → running', {}, go('running', 'push')],
  ['builder_message', S_.starting, 'store (queued)', {}, go('starting')],
  ['builder_message', S_.running, 'inject', { steer: 'inject' }, go('running', 'inject')],
  ['builder_message', S_.running, 'or queue', {}, go('running')],
  ['builder_message', S_.card, 'inject', { steer: 'inject' }, go('waiting_card', 'inject')],
  ['builder_message', S_.card, 'or queue', {}, go('waiting_card')],
  ['builder_message', S_.stopping, 'store (queued)', {}, go('stopping')],
  ['builder_message', S_.taken, 'store; held', {}, go('taken_over')],
  ['builder_message', S_.paused, 'store (queued)', {}, go('paused_account')],
  ['builder_message', S_.error, 'store; start → starting', {}, go('starting', 'start')],
  ['builder_message', S_.sealed, 'refused', {}, no(SEALED)],
  // started
  ['started', S_.cold, 'blank', {}, go('idle_cold')],
  ['started', S_.warm, 'blank', {}, go('idle_warm')],
  ['started', S_.starting, 'push the first queued message → running', {}, go('running', 'push')],
  ['started', S_.running, 'blank', {}, go('running')],
  ['started', S_.card, 'blank', {}, go('waiting_card')],
  ['started', S_.stopping, 'blank', {}, go('stopping')],
  ['started', S_.taken, 'blank', {}, go('taken_over')],
  ['started', S_.paused, 'blank', {}, go('paused_account')],
  ['started', S_.error, 'blank', {}, go('ended_error')],
  ['started', S_.sealed, 'nothing', {}, go('sealed')],
  // card raised
  ['card_raised', S_.cold, 'blank', {}, go('idle_cold')],
  ['card_raised', S_.warm, 'blank', {}, go('idle_warm')],
  ['card_raised', S_.starting, 'blank', {}, go('starting')],
  ['card_raised', S_.running, '→ waiting_card', {}, go('waiting_card')],
  ['card_raised', S_.card, 'blank', {}, go('waiting_card')],
  ['card_raised', S_.stopping, 'blank', {}, go('stopping')],
  ['card_raised', S_.taken, 'blank', {}, go('taken_over')],
  ['card_raised', S_.paused, 'blank', {}, go('paused_account')],
  ['card_raised', S_.error, 'blank', {}, go('ended_error')],
  ['card_raised', S_.sealed, 'nothing', {}, go('sealed')],
  // card answered or withdrawn
  ['card_settled', S_.cold, 'blank', {}, go('idle_cold')],
  ['card_settled', S_.warm, 'blank', {}, go('idle_warm')],
  ['card_settled', S_.starting, 'blank', {}, go('starting')],
  ['card_settled', S_.running, 'blank', {}, go('running')],
  ['card_settled', S_.card, '→ running', {}, go('running')],
  ['card_settled', S_.stopping, 'blank', {}, go('stopping')],
  ['card_settled', S_.taken, 'blank', {}, go('taken_over')],
  ['card_settled', S_.paused, 'blank', {}, go('paused_account')],
  ['card_settled', S_.error, 'blank', {}, go('ended_error')],
  ['card_settled', S_.sealed, 'nothing', {}, go('sealed')],
  // Stop
  [
    'stop',
    S_.cold,
    "if queued: drop the queue's pending start",
    Q,
    go('idle_cold', 'drop_pending_start'),
  ],
  ['stop', S_.cold, 'nothing queued', {}, go('idle_cold')],
  ['stop', S_.warm, 'n/a', {}, go('idle_warm')],
  ['stop', S_.starting, 'cancel the start → idle_cold', {}, go('idle_cold', 'cancel_start')],
  ['stop', S_.running, 'interrupt → stopping', {}, go('stopping', 'interrupt')],
  [
    'stop',
    S_.card,
    'withdraw the card; interrupt → stopping',
    {},
    go('stopping', 'withdraw_card', 'interrupt'),
  ],
  ['stop', S_.stopping, 'n/a', {}, go('stopping')],
  ['stop', S_.taken, 'n/a', {}, go('taken_over')],
  ['stop', S_.paused, 'n/a', {}, go('paused_account')],
  ['stop', S_.error, 'n/a', {}, go('ended_error')],
  ['stop', S_.sealed, 'refused', {}, no(SEALED)],
  // receipt or turn_complete after Stop
  ['stop_settled', S_.cold, 'blank', {}, go('idle_cold')],
  ['stop_settled', S_.warm, 'blank', {}, go('idle_warm')],
  ['stop_settled', S_.starting, 'blank', {}, go('starting')],
  ['stop_settled', S_.running, 'blank', {}, go('running')],
  ['stop_settled', S_.card, 'blank', {}, go('waiting_card')],
  [
    'stop_settled',
    S_.stopping,
    're-push stillQueued; queue non-empty → running',
    Q,
    go('running', 'store_partial', 'on_turn_ended', 'repush_still_queued', 'next_turn'),
  ],
  [
    'stop_settled',
    S_.stopping,
    'else idle_warm',
    {},
    go('idle_warm', 'store_partial', 'on_turn_ended', 'repush_still_queued'),
  ],
  ['stop_settled', S_.taken, 'blank', {}, go('taken_over')],
  ['stop_settled', S_.paused, 'blank', {}, go('paused_account')],
  ['stop_settled', S_.error, 'blank', {}, go('ended_error')],
  ['stop_settled', S_.sealed, 'nothing', {}, go('sealed')],
  // stop grace passes
  ['stop_grace_passed', S_.cold, 'blank', {}, go('idle_cold')],
  ['stop_grace_passed', S_.warm, 'blank', {}, go('idle_warm')],
  ['stop_grace_passed', S_.starting, 'blank', {}, go('starting')],
  ['stop_grace_passed', S_.running, 'blank', {}, go('running')],
  ['stop_grace_passed', S_.card, 'blank', {}, go('waiting_card')],
  [
    'stop_grace_passed',
    S_.stopping,
    'stop() → idle_cold; partial stored; the queue runs',
    Q,
    go('idle_cold', 'stop_handle', 'store_partial', 'on_turn_ended', 'run_queue'),
  ],
  [
    'stop_grace_passed',
    S_.stopping,
    'stop() → idle_cold; partial stored',
    {},
    go('idle_cold', 'stop_handle', 'store_partial', 'on_turn_ended'),
  ],
  ['stop_grace_passed', S_.taken, 'blank', {}, go('taken_over')],
  ['stop_grace_passed', S_.paused, 'blank', {}, go('paused_account')],
  ['stop_grace_passed', S_.error, 'blank', {}, go('ended_error')],
  ['stop_grace_passed', S_.sealed, 'nothing', {}, go('sealed')],
  // turn_complete
  ['turn_complete', S_.cold, 'blank', {}, go('idle_cold')],
  ['turn_complete', S_.warm, 'blank', {}, go('idle_warm')],
  ['turn_complete', S_.starting, 'blank', {}, go('starting')],
  [
    'turn_complete',
    S_.running,
    'queue non-empty → next turn; onTurnEnded',
    Q,
    go('running', 'on_turn_ended', 'next_turn'),
  ],
  [
    'turn_complete',
    S_.running,
    'else → idle_warm; onTurnEnded',
    {},
    go('idle_warm', 'on_turn_ended'),
  ],
  ['turn_complete', S_.card, 'blank', {}, go('waiting_card')],
  [
    'turn_complete',
    S_.stopping,
    '(as above), queue non-empty',
    Q,
    go('running', 'store_partial', 'on_turn_ended', 'repush_still_queued', 'next_turn'),
  ],
  [
    'turn_complete',
    S_.stopping,
    '(as above), else',
    {},
    go('idle_warm', 'store_partial', 'on_turn_ended', 'repush_still_queued'),
  ],
  ['turn_complete', S_.taken, 'blank', {}, go('taken_over')],
  ['turn_complete', S_.paused, 'blank', {}, go('paused_account')],
  ['turn_complete', S_.error, 'blank', {}, go('ended_error')],
  ['turn_complete', S_.sealed, 'nothing', {}, go('sealed')],
  // idle 10 min, or LRU close
  ['idle_close', S_.cold, 'blank', {}, go('idle_cold')],
  ['idle_close', S_.warm, 'close → idle_cold', {}, go('idle_cold', 'close')],
  ['idle_close', S_.starting, 'blank', {}, go('starting')],
  ['idle_close', S_.running, 'blank', {}, go('running')],
  ['idle_close', S_.card, 'blank', {}, go('waiting_card')],
  ['idle_close', S_.stopping, 'blank', {}, go('stopping')],
  ['idle_close', S_.taken, 'blank', {}, go('taken_over')],
  ['idle_close', S_.paused, 'blank', {}, go('paused_account')],
  ['idle_close', S_.error, 'blank', {}, go('ended_error')],
  ['idle_close', S_.sealed, 'nothing', {}, go('sealed')],
  // context past 70% at turn end
  ['context_full', S_.cold, 'blank', {}, go('idle_cold')],
  [
    'context_full',
    S_.warm,
    'close → idle_cold; next start is fresh from the digest',
    {},
    go('idle_cold', 'close', 'fresh_next'),
  ],
  ['context_full', S_.starting, 'blank', {}, go('starting')],
  ['context_full', S_.running, 'blank', {}, go('running')],
  ['context_full', S_.card, 'blank', {}, go('waiting_card')],
  ['context_full', S_.stopping, 'blank', {}, go('stopping')],
  ['context_full', S_.taken, 'blank', {}, go('taken_over')],
  ['context_full', S_.paused, 'blank', {}, go('paused_account')],
  ['context_full', S_.error, 'blank', {}, go('ended_error')],
  ['context_full', S_.sealed, 'nothing', {}, go('sealed')],
  // ended: error (§6.3 early ends tell the owner; call 18 Send now; call 8 resume fails)
  ['ended', S_.cold, 'error: blank', ended('error'), go('idle_cold')],
  ['ended', S_.warm, 'error: → ended_error', ended('error'), go('ended_error')],
  [
    'ended',
    S_.warm,
    'error: → ended_error; Send now',
    { ...ended('error'), ...Q },
    go('ended_error', 'send_now'),
  ],
  ['ended', S_.starting, 'error: → ended_error', ended('error'), go('ended_error')],
  [
    'ended',
    S_.starting,
    'error: → ended_error; Send now',
    { ...ended('error'), ...Q },
    go('ended_error', 'send_now'),
  ],
  [
    'ended',
    S_.starting,
    'error while resuming: a fresh start from the digest (§6.4)',
    { ...ended('error'), resuming: true },
    go('starting', 'start_fresh_from_digest'),
  ],
  [
    'ended',
    S_.running,
    'error: partial stored; → ended_error',
    ended('error'),
    go('ended_error', 'store_partial', 'on_turn_ended'),
  ],
  [
    'ended',
    S_.running,
    'error: partial stored; → ended_error; Send now',
    { ...ended('error'), ...Q },
    go('ended_error', 'store_partial', 'on_turn_ended', 'send_now'),
  ],
  [
    'ended',
    S_.card,
    'error: withdraw the card; → ended_error',
    ended('error'),
    go('ended_error', 'withdraw_card', 'store_partial', 'on_turn_ended'),
  ],
  [
    'ended',
    S_.card,
    'error: withdraw; → ended_error; Send now',
    { ...ended('error'), ...Q },
    go('ended_error', 'withdraw_card', 'store_partial', 'on_turn_ended', 'send_now'),
  ],
  [
    'ended',
    S_.stopping,
    'error: → ended_error',
    ended('error'),
    go('ended_error', 'store_partial', 'on_turn_ended'),
  ],
  [
    'ended',
    S_.stopping,
    'error: → ended_error; Send now',
    { ...ended('error'), ...Q },
    go('ended_error', 'store_partial', 'on_turn_ended', 'send_now'),
  ],
  ['ended', S_.taken, 'error: blank', ended('error'), go('taken_over')],
  ['ended', S_.paused, 'error: blank', ended('error'), go('paused_account')],
  ['ended', S_.error, 'error: blank', ended('error'), go('ended_error')],
  ['ended', S_.sealed, 'error: nothing', ended('error'), go('sealed')],
  // ended: rate_limited or capped (§6.4 paused_notice)
  ['ended', S_.cold, 'paused: blank', ended('paused'), go('idle_cold')],
  [
    'ended',
    S_.warm,
    'paused: → paused_account',
    ended('paused'),
    go('paused_account', 'paused_notice'),
  ],
  [
    'ended',
    S_.starting,
    'paused: → paused_account',
    ended('paused'),
    go('paused_account', 'paused_notice'),
  ],
  [
    'ended',
    S_.running,
    'paused: partial stored; → paused_account',
    ended('paused'),
    go('paused_account', 'store_partial', 'on_turn_ended', 'paused_notice'),
  ],
  [
    'ended',
    S_.card,
    'paused: withdraw; → paused_account',
    ended('paused'),
    go('paused_account', 'withdraw_card', 'store_partial', 'on_turn_ended', 'paused_notice'),
  ],
  [
    'ended',
    S_.stopping,
    'paused: → paused_account',
    ended('paused'),
    go('paused_account', 'store_partial', 'on_turn_ended', 'paused_notice'),
  ],
  ['ended', S_.taken, 'paused: blank', ended('paused'), go('taken_over')],
  ['ended', S_.paused, 'paused: blank', ended('paused'), go('paused_account')],
  ['ended', S_.error, 'paused: blank', ended('paused'), go('ended_error')],
  ['ended', S_.sealed, 'paused: nothing', ended('paused'), go('sealed')],
  // ended: completed or stopped, unasked (call 18 Send now)
  ['ended', S_.cold, 'unasked: blank', ended('unasked'), go('idle_cold')],
  ['ended', S_.warm, 'unasked: → idle_cold', ended('unasked'), go('idle_cold')],
  [
    'ended',
    S_.warm,
    'unasked: → idle_cold; Send now',
    { ...ended('unasked'), ...Q },
    go('idle_cold', 'send_now'),
  ],
  ['ended', S_.starting, 'unasked: → ended_error', ended('unasked'), go('ended_error')],
  [
    'ended',
    S_.starting,
    'unasked: → ended_error; Send now',
    { ...ended('unasked'), ...Q },
    go('ended_error', 'send_now'),
  ],
  [
    'ended',
    S_.running,
    'unasked: partial stored; → idle_cold',
    ended('unasked'),
    go('idle_cold', 'store_partial', 'on_turn_ended'),
  ],
  [
    'ended',
    S_.running,
    'unasked: partial stored; → idle_cold; Send now',
    { ...ended('unasked'), ...Q },
    go('idle_cold', 'store_partial', 'on_turn_ended', 'send_now'),
  ],
  [
    'ended',
    S_.card,
    'unasked: withdraw; → idle_cold',
    ended('unasked'),
    go('idle_cold', 'withdraw_card', 'store_partial', 'on_turn_ended'),
  ],
  [
    'ended',
    S_.card,
    'unasked: withdraw; → idle_cold; Send now',
    { ...ended('unasked'), ...Q },
    go('idle_cold', 'withdraw_card', 'store_partial', 'on_turn_ended', 'send_now'),
  ],
  [
    'ended',
    S_.stopping,
    'unasked: → idle_cold',
    ended('unasked'),
    go('idle_cold', 'store_partial', 'on_turn_ended'),
  ],
  [
    'ended',
    S_.stopping,
    'unasked: → idle_cold; Send now',
    { ...ended('unasked'), ...Q },
    go('idle_cold', 'store_partial', 'on_turn_ended', 'send_now'),
  ],
  ['ended', S_.taken, 'unasked: blank', ended('unasked'), go('taken_over')],
  ['ended', S_.paused, 'unasked: blank', ended('unasked'), go('paused_account')],
  ['ended', S_.error, 'unasked: blank', ended('unasked'), go('ended_error')],
  ['ended', S_.sealed, 'unasked: nothing', ended('unasked'), go('sealed')],
  // account resumes
  ['account_resumed', S_.cold, 'blank', {}, go('idle_cold')],
  ['account_resumed', S_.warm, 'blank', {}, go('idle_warm')],
  ['account_resumed', S_.starting, 'blank', {}, go('starting')],
  ['account_resumed', S_.running, 'blank', {}, go('running')],
  ['account_resumed', S_.card, 'blank', {}, go('waiting_card')],
  ['account_resumed', S_.stopping, 'blank', {}, go('stopping')],
  ['account_resumed', S_.taken, 'blank', {}, go('taken_over')],
  ['account_resumed', S_.paused, '→ idle_cold; run the queue', {}, go('idle_cold', 'run_queue')],
  [
    'account_resumed',
    S_.paused,
    '(after a restart: "Send now")',
    { restartedWhilePaused: true, ...Q },
    go('idle_cold', 'send_now'),
  ],
  [
    'account_resumed',
    S_.paused,
    '(after a restart, nothing queued)',
    { restartedWhilePaused: true },
    go('idle_cold'),
  ],
  ['account_resumed', S_.error, 'blank', {}, go('ended_error')],
  ['account_resumed', S_.sealed, 'nothing', {}, go('sealed')],
  // Open in Terminal
  ['open_terminal', S_.cold, 'no provider id: refused', {}, no('Send a message first')],
  ['open_terminal', S_.cold, 'else → taken_over', { providerSessionId: true }, go('taken_over')],
  [
    'open_terminal',
    S_.warm,
    'close → taken_over',
    { providerSessionId: true },
    go('taken_over', 'close'),
  ],
  ['open_terminal', S_.starting, 'refused', {}, no('The session is starting')],
  ['open_terminal', S_.running, 'refused ("Stop first")', {}, no('Stop first')],
  ['open_terminal', S_.card, 'refused', {}, no('Answer the card first')],
  ['open_terminal', S_.stopping, 'refused', {}, no('The turn is stopping')],
  ['open_terminal', S_.taken, 'n/a', {}, go('taken_over')],
  ['open_terminal', S_.paused, '→ taken_over', {}, go('taken_over')],
  ['open_terminal', S_.error, 'id: → taken_over', { providerSessionId: true }, go('taken_over')],
  ['open_terminal', S_.error, 'none: refused', {}, no('Send a message first')],
  ['open_terminal', S_.sealed, 'refused', {}, no(SEALED)],
  // Hand Back
  ['hand_back', S_.cold, 'blank', {}, go('idle_cold')],
  ['hand_back', S_.warm, 'blank', {}, go('idle_warm')],
  ['hand_back', S_.starting, 'blank', {}, go('starting')],
  ['hand_back', S_.running, 'blank', {}, go('running')],
  ['hand_back', S_.card, 'blank', {}, go('waiting_card')],
  ['hand_back', S_.stopping, 'blank', {}, go('stopping')],
  [
    'hand_back',
    S_.taken,
    '→ idle_cold; notice (§7.5); run held messages',
    {},
    go('idle_cold', 'hand_back_notice', 'run_queue'),
  ],
  ['hand_back', S_.paused, 'blank', {}, go('paused_account')],
  ['hand_back', S_.error, 'blank', {}, go('ended_error')],
  ['hand_back', S_.sealed, 'nothing', {}, go('sealed')],
  // The terminal never opened: the chat is given back with no notice
  ['terminal_failed', S_.cold, 'blank', {}, go('idle_cold')],
  ['terminal_failed', S_.warm, 'blank', {}, go('idle_warm')],
  ['terminal_failed', S_.starting, 'blank', {}, go('starting')],
  ['terminal_failed', S_.running, 'blank', {}, go('running')],
  ['terminal_failed', S_.card, 'blank', {}, go('waiting_card')],
  ['terminal_failed', S_.stopping, 'blank', {}, go('stopping')],
  [
    'terminal_failed',
    S_.taken,
    '→ idle_cold; run held messages; no notice',
    {},
    go('idle_cold', 'run_queue'),
  ],
  ['terminal_failed', S_.paused, 'blank', {}, go('paused_account')],
  ['terminal_failed', S_.error, 'blank', {}, go('ended_error')],
  ['terminal_failed', S_.sealed, 'nothing', {}, go('sealed')],
  // daemon restart (§6.4: Send now when anything is queued)
  ['daemon_restart', S_.cold, 'nothing queued', {}, go('idle_cold')],
  ['daemon_restart', S_.cold, 'queued: Send now', Q, go('idle_cold', 'send_now')],
  ['daemon_restart', S_.warm, '→ idle_cold', {}, go('idle_cold')],
  ['daemon_restart', S_.warm, '→ idle_cold; Send now', Q, go('idle_cold', 'send_now')],
  ['daemon_restart', S_.starting, '→ idle_cold', {}, go('idle_cold')],
  [
    'daemon_restart',
    S_.starting,
    '→ idle_cold; queued messages wait under "Send now"',
    Q,
    go('idle_cold', 'send_now'),
  ],
  [
    'daemon_restart',
    S_.running,
    'partial stored; → idle_cold',
    {},
    go('idle_cold', 'store_partial'),
  ],
  [
    'daemon_restart',
    S_.running,
    'partial stored; → idle_cold; "Send now"',
    Q,
    go('idle_cold', 'store_partial', 'send_now'),
  ],
  [
    'daemon_restart',
    S_.card,
    'withdraw; partial; → idle_cold',
    {},
    go('idle_cold', 'withdraw_card', 'store_partial'),
  ],
  [
    'daemon_restart',
    S_.card,
    'withdraw; partial; → idle_cold; Send now',
    Q,
    go('idle_cold', 'withdraw_card', 'store_partial', 'send_now'),
  ],
  ['daemon_restart', S_.stopping, '→ idle_cold', {}, go('idle_cold')],
  ['daemon_restart', S_.stopping, '→ idle_cold; Send now', Q, go('idle_cold', 'send_now')],
  ['daemon_restart', S_.taken, 'stays', Q, go('taken_over')],
  ['daemon_restart', S_.paused, 'stays', Q, go('paused_account')],
  ['daemon_restart', S_.error, 'stays', Q, go('ended_error')],
  ['daemon_restart', S_.sealed, 'nothing', {}, go('sealed')],
  // archive
  ['archive', S_.cold, 'archive', {}, go('idle_cold', 'archive')],
  ['archive', S_.warm, 'close; archive', {}, go('idle_cold', 'close', 'archive')],
  ['archive', S_.starting, 'cancel; archive', {}, go('idle_cold', 'cancel_start', 'archive')],
  [
    'archive',
    S_.running,
    'Stop, then archive',
    {},
    go('stopping', 'interrupt', 'archive_after_stop'),
  ],
  [
    'archive',
    S_.card,
    'withdraw; Stop; archive',
    {},
    go('stopping', 'withdraw_card', 'interrupt', 'archive_after_stop'),
  ],
  ['archive', S_.stopping, 'after the stop', {}, go('stopping', 'archive_after_stop')],
  ['archive', S_.taken, 'confirm "End takeover and archive?"', {}, no('End takeover and archive?')],
  [
    'archive',
    S_.taken,
    'confirmed: archive',
    { event: { confirmed: true } },
    go('idle_cold', 'archive'),
  ],
  ['archive', S_.paused, 'archive', {}, go('paused_account', 'archive')],
  ['archive', S_.error, 'archive', {}, go('ended_error', 'archive')],
  ['archive', S_.sealed, 'archive (§6.7 sealed)', {}, go('sealed', 'archive')],
  // Do it in a separate copy (§6.7 sealed)
  ['do_it', S_.cold, '→ sealed', {}, go('sealed')],
  ['do_it', S_.warm, 'close → sealed', {}, go('sealed', 'close')],
  ['do_it', S_.starting, 'cancel → sealed', {}, go('sealed', 'cancel_start')],
  [
    'do_it',
    S_.running,
    'stop → sealed; partial stored',
    {},
    go('sealed', 'stop_handle', 'store_partial'),
  ],
  [
    'do_it',
    S_.card,
    'withdraw; stop → sealed; partial stored',
    {},
    go('sealed', 'withdraw_card', 'stop_handle', 'store_partial'),
  ],
  [
    'do_it',
    S_.stopping,
    'stop → sealed; partial stored',
    {},
    go('sealed', 'stop_handle', 'store_partial'),
  ],
  ['do_it', S_.taken, 'refused', {}, no('Hand back first')],
  ['do_it', S_.paused, '→ sealed', {}, go('sealed')],
  ['do_it', S_.error, '→ sealed', {}, go('sealed')],
  ['do_it', S_.sealed, 'nothing', {}, go('sealed')],
];

function eventOf(type: ExploreEvent['type'], extra: EventExtra = {}): ExploreEvent {
  switch (type) {
    case 'ended':
      return { type, how: extra.how ?? 'error' };
    case 'archive':
      return { type, confirmed: extra.confirmed ?? false };
    case 'builder_message':
    case 'started':
    case 'card_raised':
    case 'card_settled':
    case 'stop':
    case 'stop_settled':
    case 'stop_grace_passed':
    case 'turn_complete':
    case 'idle_close':
    case 'context_full':
    case 'account_resumed':
    case 'open_terminal':
    case 'hand_back':
    case 'terminal_failed':
    case 'daemon_restart':
    case 'do_it':
      return { type };
  }
}

describe('reduceExplore', () => {
  it.each(CELLS)('%s in %s: %s', (event, state, _words, facts, expected) => {
    const { event: extra, ...rest } = facts;
    expect(reduceExplore(state, eventOf(event, extra), { ...BASE_FACTS, ...rest })).toEqual(
      expected,
    );
  });

  it('has a row for every state and event', () => {
    const events: ExploreEvent['type'][] = [
      'builder_message',
      'started',
      'card_raised',
      'card_settled',
      'stop',
      'stop_settled',
      'stop_grace_passed',
      'turn_complete',
      'idle_close',
      'context_full',
      'ended',
      'account_resumed',
      'open_terminal',
      'hand_back',
      'terminal_failed',
      'daemon_restart',
      'archive',
      'do_it',
    ];
    const missing = Object.values(ConversationState).flatMap((state) =>
      events
        .filter((event) => !CELLS.some(([e, s]) => e === event && s === state))
        .map((event) => `${event} in ${state}`),
    );
    expect(missing).toEqual([]);
  });

  it('repeats no effect in an outcome', () => {
    for (const [event, state, , facts] of CELLS) {
      const { event: extra, ...rest } = facts;
      const out = reduceExplore(state, eventOf(event, extra), { ...BASE_FACTS, ...rest });
      if ('effects' in out) expect(new Set(out.effects).size).toBe(out.effects.length);
    }
  });

  // The owner takes Your folder before a builder message and gives it back once a state outside a turn is
  // reported, so an outcome that begins a turn must land in one.
  it('lands every outcome that begins a turn in a state a turn runs in', () => {
    const begins: ExploreEffect[] = ['start', 'push', 'next_turn', 'start_fresh_from_digest'];
    const outside = Object.values(ConversationState).filter((state) => !BUSY.has(state));
    const events = new Set(CELLS.map(([event]) => event));
    const landings: string[] = [];
    for (const state of Object.values(ConversationState))
      for (const event of events)
        for (const facts of [
          { ...BASE_FACTS, queued: 0 },
          { ...BASE_FACTS, queued: 2, providerSessionId: true },
          { ...BASE_FACTS, queued: 2, resuming: true },
        ])
          for (const extra of [undefined, ended('error'), ended('paused'), ended('unasked')]) {
            const out = reduceExplore(state, eventOf(event, extra?.event), facts);
            if (
              'effects' in out &&
              out.effects.some((e) => begins.includes(e)) &&
              outside.includes(out.next)
            )
              landings.push(`${event} in ${state} lands in ${out.next}`);
          }
    expect(landings).toEqual([]);
  });
});
