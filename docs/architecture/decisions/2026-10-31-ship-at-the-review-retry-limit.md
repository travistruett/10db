# A rejection that uses up the retry limit ships the work and files its findings as a follow-up task

- **Date:** 2026-10-31

## Decision

- When a review or QA step's rejection would send the work back past `maxFixAttempts` (the `send_back` case of
  `finishReadOnlyStep`), the runner no longer fails the task if `shipsAtRetryLimit` holds: the rejecting step's
  role is review or QA, the task has neither the `security` nor the `auth` risk tag, and the latest gate evidence
  is not a failure (a project with no gate has none). A plan review's rejection still fails, as nothing is built.
- The task then moves on as an approved one does. When a step follows the rejecting one (QA after review in the
  `full` flow), it advances to that step through the same `advanceTo` as the `advance` move, and QA runs. When
  none follows, it ends through the same `completeReadOnlySteps` as the `done` move: `DONE` with its claims and
  lease released, or, in a project with no gate, waiting on the builder's check card. Either way, in the same
  write 10db files one follow-up task with `insertRetryLimitFollowUp` and sets `shippedAtLimit`
  (`followUpTaskId`, `followUpTitle`) on the rejecting step. The rejection stays that step's result, so the
  rounds list still holds it, and it is not counted as a send-back.
- The attempt count is not reset, so a QA step that then rejects is past the limit too: it ships the same way and
  files its own follow-up with its findings. The card and drawer name every follow-up filed, in step order.
- The follow-up is a task in the source's project with no human column, so it is in the Ready column, not started;
  it has the source's landing and areas, no dependencies, and no risk tags. Its title is
  `Resolve the open findings of "<source title>"` (cut to the title limit), its description names the source's
  title and id and holds the last rejection's notes (without any earlier follow-up list), and each finding is an
  acceptance criterion.
- The card says "Shipped at the retry limit with open findings. Follow-up task: <title>" (or "Follow-up tasks:"
  with the titles joined by "; " when review and QA each filed one) in orange, the drawer
  shows the same sentence in an alert above the review rounds, and that last round's badge reads "Open at the
  limit" instead of "Sent back".
- The other limits (uncommitted changes, the builder's send-backs, gate failures) still fail the task, and so does
  a security or auth task at this limit.

## Why

At the limit the builder had to choose by hand whether to ship, abandon or retry, and the work that passed the
gate sat waiting. Tasks land on the `next` integration branch and CI runs on the pull request into main, so
shipping work with known findings that a task tracks is acceptable for ordinary work; for a security or auth task
an open finding is the thing review exists to stop, so it keeps failing. The gate is judged by its latest
evidence because a review only runs after a passing gate, and a failed one must not ship by this path. The
follow-up goes in Ready, not the Icebox that review follow-ups use, because these findings were blocking: they
should be picked up next, not parked. Filing in the same write as the ship keeps a shipped task and its follow-up
from existing without each other, and the marker lives on the step (steps are JSON, so it needs no migration)
where the drawer already reads the rounds.
