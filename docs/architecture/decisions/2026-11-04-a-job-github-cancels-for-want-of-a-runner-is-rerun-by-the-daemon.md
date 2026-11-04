# A job GitHub cancels for want of a runner is rerun by the daemon, with no agent and no card

- **Date:** 2026-11-04
- **Amends:** `decisions/2026-10-29-pull-request-watch.md` (the watch's handling of cancelled required checks)

## Decision

The pull request watch reruns a required job that GitHub cancelled because no hosted runner picked it
up. The test is `Gh.jobHadNoRunner` (two `gh api` reads of the cancelled check's job id): the job is
`cancelled`, has no runner (`runner_id`, `runner_name` null) and no steps, and its check run has an
annotation saying "was not acquired by Runner of type hosted". A job that had a runner or ran a step, and a
run a person cancelled (no such annotation), are not this case and stay with the ordinary cancelled-check
rule (rerun once, from the second read in a row).

- The rerun is `gh run rerun --failed` of the job's run, made at the first read that lists the job, with
  no CI-fix session and no card. The batch shows a `checks-no-runner:<head>` notice that says it was a
  runner shortage, not a test failure, and names the attempt.
- Reruns are limited to 3 for one head of the pull request (`MAX_RUNNER_RERUNS`). A rerun makes a new job
  id, so the notice's record keeps the job ids already dealt with: GitHub listing the old cancelled job
  for a moment is no new shortage. When a fresh job is cancelled the same way at the limit, the watch
  raises one card (`pr-no-runner:<root>`) naming the job and the reruns made, and starts nothing more.
- The count is the stored notice's record, per head: a restart keeps it, a push starts again from zero and
  takes the old head's notice and card back. A refused rerun counts as an attempt and is not asked for
  again; one refused as "already running" is asked again next round without counting.
- A pull request in the merge queue, one that conflicts, one with a failing required check (a fix pushes a
  new head), and a fix batch's pull request are left alone, as the ordinary cancelled-check rule leaves them.

## Why

On 2026-11-04 #522 and #523 sat for hours with `desktop` cancelled after 15 minutes without a macOS arm64
runner, and #523 reached attempt 6. That is no code failure, so a CI-fix session would only spend tokens,
and a card per cancellation would ask the builder to do what the daemon can do. The annotation and the
missing runner and steps are what tell it from a cancelled run that did something, so a rerun costs nothing
but runner time. The limit exists because a shortage can outlast any number of reruns; past it a person
decides. Waiting for a second read, as the ordinary rule does to avoid rerunning a run a newer push
replaced, is not needed: a superseded run is cancelled by concurrency, with no such annotation.
