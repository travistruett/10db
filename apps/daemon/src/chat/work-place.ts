import type { WorkPlace } from '@10db/contracts';

// Where a session's work happens, as a pure state machine: for each place and event, the place after and what
// the work service must then do, or why the event is refused. A session that has not asked yet is reading, which is
// `null`. The service applies the place as a compare-and-set in one write with its card; this module decides.

/** What a title-row action, a restart or a message that lands mid-move is refused with. */
export const WAIT_FOR_MOVE = 'Wait for the move to finish';

export type WorkEvent =
  | { readonly kind: 'first_change' }
  /** A call from a session the chat has since replaced, or whose turn ended. */
  | { readonly kind: 'stale_call' }
  /** Push, open pull request or merge, after the judge let the call through. */
  | { readonly kind: 'git_tool_allowed' }
  | { readonly kind: 'choose'; readonly place: 'here' | 'branch'; readonly turnRunning: boolean }
  | { readonly kind: 'message' }
  | { readonly kind: 'stop' }
  | { readonly kind: 'redo' }
  | { readonly kind: 'model_change' }
  /** `grew`: the files at risk are more than the builder was warned about. */
  | { readonly kind: 'archive'; readonly grew: boolean }
  | { readonly kind: 'close_tab' }
  | { readonly kind: 'open_terminal'; readonly hasWorktree: boolean }
  | { readonly kind: 'git_step' }
  | { readonly kind: 'edit_in_checkout' }
  | { readonly kind: 'restart' }
  | { readonly kind: 'move_done'; readonly reopen: boolean }
  | { readonly kind: 'move_failed'; readonly reopen: boolean }
  | { readonly kind: 'reopen'; readonly branchExists: boolean };

export type WorkEffect =
  | 'raise_card'
  | 'bump_asked'
  | 'withdraw_card'
  | 'stop_turn'
  | 'stop_turn_after_deny'
  | 'await_settled'
  | 'hold_starts'
  | 'release_starts'
  | 'take_turn_hold'
  | 'post_carry_on'
  | 'post_move_notice'
  | 'run_move'
  | 'finish_move'
  | 'park_message'
  | 'answer_stop_keep_holds'
  | 'deny_turn_ended'
  | 'deny_names_worktree'
  | 'clear_branch'
  | 'clear_path'
  | 'keep_refusal'
  | 'remove_worktree'
  | 'terminal_in_worktree'
  | 'terminal_in_checkout'
  | 'reserve_git'
  | 'notice_no_worktree';

export type WorkOutcome =
  | { readonly to: WorkPlace | null; readonly effects: readonly WorkEffect[] }
  | { readonly refused: string };

const stay = (to: WorkPlace | null, ...effects: WorkEffect[]): WorkOutcome => ({ to, effects });
const refuse = (refused: string): WorkOutcome => ({ refused });

const NOT_ASKED = 'This session has not been asked where to work.';
const ALREADY_CHOSEN = 'Where this session works is already chosen.';
const FILES_CHANGED = 'Files have changed since you were warned, so nothing was removed.';
const cannot = (place: WorkPlace | null, kind: WorkEvent['kind']): WorkOutcome =>
  refuse(
    `A session ${place === null ? 'reading' : `on ${place}`} has no ${kind.replace('_', ' ')}.`,
  );

function reading(event: WorkEvent): WorkOutcome {
  switch (event.kind) {
    case 'first_change':
      return { to: 'choosing', effects: ['raise_card', 'stop_turn_after_deny'] };
    case 'stale_call':
      return stay(null, 'deny_turn_ended');
    case 'git_tool_allowed':
      return { to: 'here', effects: ['take_turn_hold'] };
    case 'open_terminal':
      return stay('here');
    case 'choose':
      return refuse(NOT_ASKED);
    case 'message':
    case 'stop':
    case 'redo':
    case 'model_change':
    case 'archive':
    case 'close_tab':
    case 'git_step':
    case 'restart':
      return stay(null);
    case 'edit_in_checkout':
    case 'move_done':
    case 'move_failed':
    case 'reopen':
      return cannot(null, event.kind);
  }
}

function choosing(event: WorkEvent): WorkOutcome {
  switch (event.kind) {
    case 'first_change':
      return stay('choosing', 'bump_asked', 'stop_turn_after_deny');
    case 'stale_call':
      return stay('choosing', 'deny_turn_ended');
    case 'choose':
      if (event.place === 'here')
        return {
          to: 'here',
          effects: [
            'hold_starts',
            ...(event.turnRunning ? (['stop_turn', 'await_settled'] as const) : []),
            'withdraw_card',
            'post_carry_on',
            'release_starts',
          ],
        };
      return {
        to: 'moving',
        effects: [
          'hold_starts',
          ...(event.turnRunning ? (['stop_turn'] as const) : []),
          'withdraw_card',
          'run_move',
        ],
      };
    case 'open_terminal':
      return { to: 'here', effects: ['withdraw_card'] };
    case 'archive':
      return stay('choosing', 'withdraw_card');
    case 'message':
    case 'stop':
    case 'redo':
    case 'model_change':
    case 'close_tab':
    case 'git_step':
    case 'restart':
      return stay('choosing');
    case 'git_tool_allowed':
      return { to: 'here', effects: ['take_turn_hold'] };
    case 'edit_in_checkout':
    case 'move_done':
    case 'move_failed':
    case 'reopen':
      return cannot('choosing', event.kind);
  }
}

function moving(event: WorkEvent): WorkOutcome {
  switch (event.kind) {
    case 'message':
      return stay('moving', 'park_message');
    case 'stop':
      return stay('moving', 'answer_stop_keep_holds');
    case 'redo':
    case 'archive':
    case 'open_terminal':
    case 'git_step':
      return refuse(WAIT_FOR_MOVE);
    case 'choose':
      return refuse(ALREADY_CHOSEN);
    case 'restart':
      return stay('moving', 'hold_starts', 'finish_move');
    case 'move_done':
      return event.reopen
        ? stay('branch', 'release_starts')
        : stay('branch', 'post_move_notice', 'post_carry_on', 'release_starts');
    case 'move_failed':
      return event.reopen
        ? stay('branch', 'clear_path', 'keep_refusal', 'release_starts')
        : stay('choosing', 'clear_branch', 'keep_refusal', 'raise_card', 'release_starts');
    case 'stale_call':
      return stay('moving', 'deny_turn_ended');
    case 'model_change':
    case 'close_tab':
      return stay('moving');
    case 'first_change':
    case 'git_tool_allowed':
    case 'edit_in_checkout':
    case 'reopen':
      return cannot('moving', event.kind);
  }
}

function branch(event: WorkEvent): WorkOutcome {
  switch (event.kind) {
    case 'message':
    case 'stop':
    case 'redo':
    case 'model_change':
    case 'close_tab':
    case 'git_step':
    case 'restart':
    case 'first_change':
    case 'git_tool_allowed':
      return stay('branch');
    case 'stale_call':
      return stay('branch', 'deny_turn_ended');
    case 'edit_in_checkout':
      return stay('branch', 'deny_names_worktree');
    case 'open_terminal':
      return stay('branch', event.hasWorktree ? 'terminal_in_worktree' : 'terminal_in_checkout');
    case 'archive':
      return event.grew ? refuse(FILES_CHANGED) : stay('branch', 'remove_worktree', 'clear_path');
    case 'reopen':
      return event.branchExists
        ? { to: 'moving', effects: ['hold_starts', 'run_move'] }
        : stay('branch', 'notice_no_worktree');
    case 'choose':
      return refuse(ALREADY_CHOSEN);
    case 'move_done':
    case 'move_failed':
      return cannot('branch', event.kind);
  }
}

function here(event: WorkEvent): WorkOutcome {
  switch (event.kind) {
    case 'message':
      return stay('here', 'take_turn_hold');
    case 'git_step':
      return stay('here', 'reserve_git');
    case 'choose':
      return refuse(ALREADY_CHOSEN);
    case 'stale_call':
      return stay('here', 'deny_turn_ended');
    case 'stop':
    case 'redo':
    case 'model_change':
    case 'close_tab':
    case 'restart':
    case 'first_change':
    case 'git_tool_allowed':
    case 'open_terminal':
    case 'archive':
      return stay('here');
    case 'edit_in_checkout':
    case 'move_done':
    case 'move_failed':
    case 'reopen':
      return cannot('here', event.kind);
  }
}

/** What `event` does to a session at `place` (null while it only reads). */
export function workTransition(place: WorkPlace | null, event: WorkEvent): WorkOutcome {
  switch (place) {
    case null:
      return reading(event);
    case 'choosing':
      return choosing(event);
    case 'moving':
      return moving(event);
    case 'branch':
      return branch(event);
    case 'here':
      return here(event);
  }
}
