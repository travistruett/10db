# 10db watches each shipped pull request's checks and merge

- **Date:** 2026-10-29

## Decision

_Built:_ the daemon reads every shipped batch's pull request and keeps what it read on the batch.

- **Where it lives.** `batches` has nullable `pr_state` (`open`, `merged`, `closed`, `unknown`), `pr_checks`
  (`pending`, `passing`, `failing`, `none`, `unknown`), `pr_failing_checks` (JSON: name and an https link or
  null), `pr_checked_at` and `pr_unknown_reason`. `BatchDto.pr` is that status, or null before the first read.
  `none` means the pull request has no checks at all; `unknown` means gh could not say.
- **How it reads.** `Gh.prStatus` runs `gh pr view <url> -R <repo> --json url,state,statusCheckRollup`.
  `prView`, which shipping and the dependency check use, is unchanged. `summariseChecks` is pure: a check run
  that concluded `FAILURE`, `TIMED_OUT`, `ACTION_REQUIRED` or `STARTUP_FAILURE`, or a status in `FAILURE` or
  `ERROR`, is failing, and failing wins over pending; a run that is not `COMPLETED`, or a status `PENDING` or
  `EXPECTED`, is pending; an empty rollup is `none`; anything else, cancelled, skipped, neutral and stale runs
  included, is passing. A value GitHub adds later reads as passing. A rollup 10db can't parse is an error, so
  the status becomes unknown rather than wrong. Only https links are kept.
- **When.** `delivery/pr-watch.ts` polls every 2 minutes on the injected clock, once at startup and right
  after a batch becomes SHIPPED, one gh call at a time. A gh call has a 2 minute timeout, so every answer
  arrives within the 5 minutes the task asks for. It runs outside the delivery job queues: a ship or a cut
  never waits behind a poll, and a slow gh stops nothing else. Any error ends the round and marks the
  batch and the rest of the round unknown, so an offline round costs one timeout, not one per pull request.
- **Which batches.** SHIPPED, with a pull request url, whose state was never read or reads `open` or
  `unknown`. **Merged and closed are final:** a pull request the builder reopens is not followed again.
  After the upgrade every older SHIPPED batch is read once, and a pull request that was closed unmerged raises
  its card then. That is true, and it is the only time a card is late.
- **Cards fire only on a stored transition,** so a restart, or a card the builder dismissed, never raises
  another:
  - checks become failing: one card naming the first failing check (and "and N more"), with its link first
    in the body and in `detail.link`; withdrawn when checks pass or there are none, or the pull request merges
    or closes (`pr-checks:<batch>`);
  - the pull request becomes closed: one card, saying the tasks stay done, the code is not on the base and the
    branch is kept (`pr-closed:<batch>`);
  - a status becomes unknown because gh failed: **one card per daemon** (`pr-watch-gh`, raised in the first
    affected project, since fold keys are per project), saying what to do for signed out, not installed or
    any other failure, and that the status stays unknown and nothing else is affected. It is withdrawn after
    the next round that gets an answer.
- **Every failing check counts.** The rollup does not say which checks are required, so a failing optional
  check raises the card too. This is a known gap; filtering to required checks is a follow-up.
- Every recorded read writes the batch and emits `batch.updated` with `changed: ['pr']`, so `checkedAt`
  stays fresh while a pull request waits.

_Designed, not built:_ shipping waits for CI, and gates run as pre-checks; the decision "CI decides"
(`decisions/2026-10-29-sandbox-is-the-boundary.md`) says work is done when CI is green and the pull request
merges, and this decision only records and shows that state. The Board and Factory badges that use `pr`, and
reopening tasks when a pull request closes, are follow-ups. The desktop shows the failing check's link on the
card ("Open on GitHub"); the app opens github.com only, and the address is in the card's text regardless.

## Why

One batch has one pull request, so the batch row is the natural home, and `BatchDto` already reaches the
desktop through the project views, the batch list and `batch.updated` events. Storing the status, rather than
asking gh when the desktop asks, makes it survive a restart and keeps the desktop working with gh offline.
Raising a card on a stored change is what makes "one card" true across restarts. Polling beats webhooks for a
local app that has no public address. A separate `prStatus` keeps shipping on its smaller, already-tested
query.
