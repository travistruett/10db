# The builder sees what a reviewer found, and a retry hands it to the implementer

- **Date:** 2026-10-29

## Decision

- A step keeps every verdict it gave. `WorkstreamStep.earlier` holds the results a step replaced when it ran
  again or a retry restarted it (only results with a verdict); `result` is the latest. `reviewRounds(steps)`
  lists all of them newest first, and `rejectionsSentBack({ steps, attempt })` counts the rejections within the
  attempts the limit (`FIX_ATTEMPT_LIMIT`, 3) counts. A retry resets `attempt`, so its count starts over.
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
  session gets the review's notes under "Earlier steps", and the builder's note, recorded as builder evidence,
  when there is one. A retry after any other failure behaves as before and ignores a note.

## Why

The review's result lived only in the workstream's `steps` JSON, and a step that ran again dropped it, so the
builder could neither see why a task was sent back nor judge Retry, Ship anyway or a rewrite. A card copy
(`detail`) keeps what the card needs when it is raised; the rounds themselves are read from the steps, so the
drawer shows past rounds the card never did.

Retrying the review of unchanged code rejects it again, so the retry runs the step that did the work. That is
what the builder wants when they read the findings and decide to try again, and it is the only place a note
can reach the implementer.

The count uses the attempts the limit really counts, not every rejection ever given: after a retry the limit is
fresh, so "2 of 3" must not carry old rounds. Gate failures and the builder's send-backs share that counter, so
the count is the lesser of the two numbers.

Turned down: a table of review rounds (a migration for text the steps already hold); parsing findings in the
daemon and storing them (the notes are the record, the parse is a view and may improve); a separate "Retry with
note" action (the card already has a note field).
