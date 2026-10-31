# The builder sees what a reviewer found, and a retry hands it to the implementer

- **Date:** 2026-10-29

## Decision

- A step keeps every verdict it gave. `WorkstreamStep.earlier` holds the results a step replaced when it ran
  again or a retry restarted it (only results with a verdict); `result` is the latest. `reviewRounds(steps)`
  lists all of them newest first. `WorkstreamStep.sentBack` counts the times a step's rejection sent the work
  back; a retry sets every step's count to 0, as it resets `attempt`. `rejectionsSentBack({ steps })` is their
  sum, shown against the limit (`FIX_ATTEMPT_LIMIT`, 3). The rejection that uses the last attempt up fails the
  workstream instead of sending the work back, so the count stops at 3.
- The steps column reads a stored step with the fields it lacks set to their defaults (`earlier` [],
  `sentBack` 0), so a workstream started before either existed runs and shows as one started after.
- `parseFindings` reads a review's notes: each numbered note is a finding with the severity word (`BLOCKING`,
  `[nit]`, …) and the `file:line` it names, if any. Notes with no numbering are one finding. The full notes stay
  as the reviewer wrote them.
- The failed-workstream card raised when a review's rejection uses the retry limit up carries the review in
  `detail.reviewRejection` (`ReviewCardDetail`: the findings and the whole summary). The Inbox shows each
  finding with its severity and `file:line`, and "Show the full review" opens the notes in place.
- The task drawer lists every review round, newest first, with its verdict and findings. A board card whose
  review sent the work back says "Review sent back 2 of 3".
- Retry takes a note: `POST /workstreams/:id/retry` accepts `{ note }`, and the failed card's Retry answer
  passes its note on. When a reviewer's rejection failed the workstream, a retry no longer restarts the review:
  it sends the work to the step the rejection goes back to (as the rejection did), with `attempt` reset. The
  session gets the review's notes under "Earlier steps", and the builder's note when there is one.
- A note reaches the next session whatever failed the workstream (the gate, a crash, the builder's own
  send-back). It is recorded as builder evidence and the step that runs next gets `nextAction`
  `{ kind: 'fix' }` for it, as when the builder sends work back from a check card; a read-only step is told to
  take it into account and complete its step, since it has nothing to commit. With no note, a retry behaves as
  before.

## Why

The review's result lived only in the workstream's `steps` JSON, and a step that ran again dropped it, so the
builder could neither see why a task was sent back nor judge Retry, Ship anyway or a rewrite. A card copy
(`detail`) keeps what the card needs when it is raised; the rounds themselves are read from the steps, so the
drawer shows past rounds the card never did.

Retrying the review of unchanged code rejects it again, so the retry runs the step that did the work. That is
what the builder wants when they read the findings and decide to try again, and it is the only place a note
can reach the implementer.

The count covers only the send-backs since the attempts last started over: after a retry the limit is fresh, so
"2 of 3" must not carry old rounds. It can't be read from `attempt`, which gate failures and the builder's
send-backs also raise, nor from the rounds, which a retry keeps; capping one by the other said "2 of 3" for a
review that had not run since the retry. So each step counts its own send-backs.

The drawer offers the note on every failed workstream, and the failed card's Retry takes one too. A note the
daemon dropped for any failure but a review's would vanish without a word, so it is used on every retry. A
note given with a gate failure becomes the fix in place of the gate output; the gate runs again after the step
either way.

Turned down: a table of review rounds (a migration for text the steps already hold); parsing findings in the
daemon and storing them (the notes are the record, the parse is a view and may improve); a separate "Retry with
note" action (the card already has a note field); offering the note only after a review's rejection and
refusing it otherwise (the builder has as much to say after a gate failure or a crash); a workstream column for
the send-back count or the time of the last retry (a migration, where the steps JSON already holds per-step
state).
