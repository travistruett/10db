import { describe, expect, it } from 'vitest';
import type { WorkPlace } from '@10db/contracts';
import { WAIT_FOR_MOVE, workTransition, type WorkEffect, type WorkEvent } from './work-place';

// The state table of the sessions plan, one row per outcome: where a session's place goes on an event, and what
// the service must then do. Persistence and the effects themselves are tested where they run.

type Place = WorkPlace | null;
type Row =
  | { name: string; from: Place; event: WorkEvent; to: Place; effects: readonly WorkEffect[] }
  | { name: string; from: Place; event: WorkEvent; refused: string | RegExp };

const rows: Row[] = [
  // Reading
  {
    name: '1 reading: a first change asks',
    from: null,
    event: { kind: 'first_change' },
    to: 'choosing',
    effects: ['raise_card', 'stop_turn_after_deny'],
  },
  {
    name: '4 reading: an older session changes nothing',
    from: null,
    event: { kind: 'stale_call' },
    to: null,
    effects: ['deny_turn_ended'],
  },
  {
    name: '5 reading: push after the judge allows takes here',
    from: null,
    event: { kind: 'git_tool_allowed' },
    to: 'here',
    effects: ['take_turn_hold'],
  },
  {
    name: '7 reading: a message runs at once',
    from: null,
    event: { kind: 'message' },
    to: null,
    effects: [],
  },
  {
    name: 'reading: Archive',
    from: null,
    event: { kind: 'archive', grew: false },
    to: null,
    effects: [],
  },
  {
    name: 'reading: a title-row git step',
    from: null,
    event: { kind: 'git_step' },
    to: null,
    effects: [],
  },
  {
    name: '16 reading: the terminal takes here',
    from: null,
    event: { kind: 'open_terminal', hasWorktree: false },
    to: 'here',
    effects: [],
  },
  {
    name: 'reading: choosing a place needs a question',
    from: null,
    event: { kind: 'choose', place: 'here', turnRunning: false },
    refused: /not been asked/,
  },
  // Choosing
  {
    name: '8 choosing: another first change bumps askedAt',
    from: 'choosing',
    event: { kind: 'first_change' },
    to: 'choosing',
    effects: ['bump_asked', 'stop_turn_after_deny'],
  },
  {
    name: '9 choosing: Here with no turn',
    from: 'choosing',
    event: { kind: 'choose', place: 'here', turnRunning: false },
    to: 'here',
    effects: ['hold_starts', 'withdraw_card', 'post_carry_on', 'release_starts'],
  },
  {
    name: '10 choosing: Here while a turn runs',
    from: 'choosing',
    event: { kind: 'choose', place: 'here', turnRunning: true },
    to: 'here',
    effects: [
      'hold_starts',
      'stop_turn',
      'await_settled',
      'withdraw_card',
      'post_carry_on',
      'release_starts',
    ],
  },
  {
    name: '11 choosing: On a New Branch',
    from: 'choosing',
    event: { kind: 'choose', place: 'branch', turnRunning: false },
    to: 'moving',
    effects: ['hold_starts', 'withdraw_card', 'run_move'],
  },
  {
    name: '11 choosing: On a New Branch while a turn runs',
    from: 'choosing',
    event: { kind: 'choose', place: 'branch', turnRunning: true },
    to: 'moving',
    effects: ['hold_starts', 'stop_turn', 'withdraw_card', 'run_move'],
  },
  {
    name: '13 choosing: a message is a reading turn',
    from: 'choosing',
    event: { kind: 'message' },
    to: 'choosing',
    effects: [],
  },
  {
    name: '15 choosing: a restart keeps the question',
    from: 'choosing',
    event: { kind: 'restart' },
    to: 'choosing',
    effects: [],
  },
  {
    name: '16 choosing: the terminal takes here',
    from: 'choosing',
    event: { kind: 'open_terminal', hasWorktree: false },
    to: 'here',
    effects: ['withdraw_card'],
  },
  {
    name: '17 choosing: a model change',
    from: 'choosing',
    event: { kind: 'model_change' },
    to: 'choosing',
    effects: [],
  },
  {
    name: '18 choosing: Archive withdraws the card',
    from: 'choosing',
    event: { kind: 'archive', grew: false },
    to: 'choosing',
    effects: ['withdraw_card'],
  },
  // Moving
  {
    name: '19 moving: a message is parked',
    from: 'moving',
    event: { kind: 'message' },
    to: 'moving',
    effects: ['park_message'],
  },
  {
    name: '20 moving: Stop answers at once',
    from: 'moving',
    event: { kind: 'stop' },
    to: 'moving',
    effects: ['answer_stop_keep_holds'],
  },
  {
    name: '20 moving: Redo is refused',
    from: 'moving',
    event: { kind: 'redo' },
    refused: WAIT_FOR_MOVE,
  },
  {
    name: '21 moving: Archive is refused',
    from: 'moving',
    event: { kind: 'archive', grew: false },
    refused: WAIT_FOR_MOVE,
  },
  {
    name: '21 moving: the terminal is refused',
    from: 'moving',
    event: { kind: 'open_terminal', hasWorktree: false },
    refused: WAIT_FOR_MOVE,
  },
  {
    name: '21 moving: a git step is refused',
    from: 'moving',
    event: { kind: 'git_step' },
    refused: WAIT_FOR_MOVE,
  },
  {
    name: '12 moving: a second choice is refused',
    from: 'moving',
    event: { kind: 'choose', place: 'branch', turnRunning: false },
    refused: /already chosen/,
  },
  {
    name: '25 moving: a restart finishes the move',
    from: 'moving',
    event: { kind: 'restart' },
    to: 'moving',
    effects: ['hold_starts', 'finish_move'],
  },
  {
    name: '24 moving: a failed move goes back to choosing',
    from: 'moving',
    event: { kind: 'move_failed', reopen: false },
    to: 'choosing',
    effects: ['clear_branch', 'keep_refusal', 'raise_card', 'release_starts'],
  },
  {
    name: '24 moving: a failed reopen goes back to a branch with no worktree',
    from: 'moving',
    event: { kind: 'move_failed', reopen: true },
    to: 'branch',
    effects: ['clear_path', 'keep_refusal', 'release_starts'],
  },
  {
    name: '11 moving: a finished move is a branch',
    from: 'moving',
    event: { kind: 'move_done', reopen: false },
    to: 'branch',
    effects: ['post_move_notice', 'post_carry_on', 'release_starts'],
  },
  {
    name: '36 moving: a finished reopen only remakes the worktree',
    from: 'moving',
    event: { kind: 'move_done', reopen: true },
    to: 'branch',
    effects: ['release_starts'],
  },
  // Branch
  {
    name: '28 branch: a turn runs with no hold',
    from: 'branch',
    event: { kind: 'message' },
    to: 'branch',
    effects: [],
  },
  {
    name: '29 branch: an edit aimed at the checkout is denied',
    from: 'branch',
    event: { kind: 'edit_in_checkout' },
    to: 'branch',
    effects: ['deny_names_worktree'],
  },
  {
    name: '31 branch: the terminal works in the worktree',
    from: 'branch',
    event: { kind: 'open_terminal', hasWorktree: true },
    to: 'branch',
    effects: ['terminal_in_worktree'],
  },
  {
    name: '48 branch with no worktree: the terminal holds the checkout',
    from: 'branch',
    event: { kind: 'open_terminal', hasWorktree: false },
    to: 'branch',
    effects: ['terminal_in_checkout'],
  },
  {
    name: '32 branch: a git step runs on the worktree',
    from: 'branch',
    event: { kind: 'git_step' },
    to: 'branch',
    effects: [],
  },
  {
    name: '33 branch: Archive that was warned runs',
    from: 'branch',
    event: { kind: 'archive', grew: false },
    to: 'branch',
    effects: ['remove_worktree', 'clear_path'],
  },
  {
    name: '33 branch: Archive whose lists grew is refused',
    from: 'branch',
    event: { kind: 'archive', grew: true },
    refused: /changed since/,
  },
  {
    name: '34 branch: closing the tab keeps the worktree',
    from: 'branch',
    event: { kind: 'close_tab' },
    to: 'branch',
    effects: [],
  },
  {
    name: '36 branch with no worktree: Reopen remakes it',
    from: 'branch',
    event: { kind: 'reopen', branchExists: true },
    to: 'moving',
    effects: ['hold_starts', 'run_move'],
  },
  {
    name: '37 branch with no worktree: Reopen with the branch gone',
    from: 'branch',
    event: { kind: 'reopen', branchExists: false },
    to: 'branch',
    effects: ['notice_no_worktree'],
  },
  {
    name: '27 branch: a restart has nothing to finish',
    from: 'branch',
    event: { kind: 'restart' },
    to: 'branch',
    effects: [],
  },
  // Here
  {
    name: '39 here: a turn takes the hold',
    from: 'here',
    event: { kind: 'message' },
    to: 'here',
    effects: ['take_turn_hold'],
  },
  {
    name: '47 here: the terminal holds the checkout',
    from: 'here',
    event: { kind: 'open_terminal', hasWorktree: false },
    to: 'here',
    effects: [],
  },
  {
    name: '41 here: a git step',
    from: 'here',
    event: { kind: 'git_step' },
    to: 'here',
    effects: ['reserve_git'],
  },
  {
    name: '12 here: a second choice is refused',
    from: 'here',
    event: { kind: 'choose', place: 'here', turnRunning: false },
    refused: /already chosen/,
  },
];

describe('workTransition', () => {
  it.each(rows)('$name', (row) => {
    const out = workTransition(row.from, row.event);
    if ('refused' in row) {
      expect(out).toHaveProperty('refused');
      if ('refused' in out) expect(out.refused).toMatch(row.refused);
    } else {
      expect(out).toEqual({ to: row.to, effects: row.effects });
    }
  });

  it('refuses an event the place cannot see rather than guessing', () => {
    expect(workTransition('here', { kind: 'move_done', reopen: false })).toHaveProperty('refused');
    expect(workTransition(null, { kind: 'move_failed', reopen: false })).toHaveProperty('refused');
  });
});
