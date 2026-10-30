# A review that ends without a verdict runs once more by itself

- **Date:** 2026-10-30

## Decision

- A review step (`REVIEW_ROLES`) whose session ends its turn without calling `complete_step` runs again in the
  same run, with no card and no builder answer. Only a second such ending in the same step fails the task. The
  count is the step's sessions after its `sessionFloor` that ended `step_done`; a session that handed off, crashed
  or was stopped is not counted, and a review sent back and reviewed again starts a fresh count.
- The rerun's next action is the step's latest handoff when it wrote one, a fresh start otherwise.
- Other read-only steps (plan) are not rerun: they still fail at the first such ending.
- The failure says how the last session ended, in one line: `The review step ended without calling
complete_step: its last turn stopped at the turn limit, with 63% of its context used.` The turn is one of
  _ended normally_, _stopped at the turn limit_, _ended with an error_, or the session closed before any turn
  finished. The context share is the last one the session reported, left out when it reported none.
- A `turn_complete` session event carries `result` (`max_turns` or `error`; absent means it ended normally), mapped
  from the Claude result message's subtype and `is_error`.
- A review that runs low on context already hands off like an implement session: `requestHandoff` sends the
  read-only nudge and the fresh session continues from the handoff. A test now pins it for a review.

## Why

A review of 42 files ended its session without a verdict and the task failed, though the work was never judged.
Nothing on the card said whether the session ran out of context, hit an error or a turn limit, so the builder could
not tell whether a retry would help. One rerun covers a session that simply ended early; a second ending the same way
is evidence that a retry will not help, so it fails with the reason visible. Counting from the sessions table needs
no new step field, so the steps JSON, the contracts and their generated files stay as they are.
