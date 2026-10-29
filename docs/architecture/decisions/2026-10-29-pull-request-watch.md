# 10db watches each shipped pull request's checks and merge

- **Date:** 2026-10-29

## Decision

_Built:_ the daemon reads every shipped batch's pull request and keeps what it read on the batch.

- **Where it lives.** `batches` has nullable `pr_state` (`open`, `merged`, `closed`, `unknown`), `pr_checks`
  (`pending`, `passing`, `failing`, `none`, `unknown`), `pr_failing_checks` (JSON: name and an https link or
  null), `pr_checked_at` and `pr_unknown_reason`. `BatchDto.pr` is that status, or null before the first read.
  `none` means the pull request has no checks at all; `unknown` means gh could not say, or GitHub listed a
  check 10db can't read (below).
- **How it reads.** `Gh.prStatus` runs `gh pr view <url> -R <repo> --json url,state,statusCheckRollup`.
  `prView`, which shipping and the dependency check use, is unchanged. `summariseChecks` is pure: a check run
  that concluded `FAILURE`, `TIMED_OUT`, `ACTION_REQUIRED` or `STARTUP_FAILURE`, or a status in `FAILURE` or
  `ERROR`, is failing, and failing wins over pending; a run that is not `COMPLETED`, or a status `PENDING` or
  `EXPECTED`, is pending; an empty rollup is `none`; anything else, cancelled, skipped, neutral and stale runs
  included, is passing. A value GitHub adds later reads as passing. Each rollup entry is read on its own: an
  entry 10db can't read (a kind GitHub adds later, or a known kind missing a field) makes the checks
  `unknown`, unless another check failed (failing) or is still running (pending). The pull request's state is
  still read, the round goes on, and no gh card is raised, since gh answered. Output that is not JSON, a rollup
  that is not a list, or a state 10db doesn't know is a failed read, so the status becomes unknown rather than
  wrong. Only https links are kept.
- **When.** `delivery/pr-watch.ts` polls every 2 minutes on the injected clock, once at startup and right
  after a batch becomes SHIPPED, one gh call at a time. A gh call has a 2 minute timeout, so every answer
  arrives within the 5 minutes the task asks for. It runs outside the delivery job queues: a ship or a cut
  never waits behind a poll, and a slow gh stops nothing else. Any error ends the round and marks the
  batch and the rest of the round unknown, so an offline round costs one timeout, not one per pull request.
- **Which batches.** SHIPPED, with a pull request url, whose state was never read or reads `open` or
  `unknown`. **Merged and closed are final:** a pull request the builder reopens is not followed again.
  After the upgrade every older SHIPPED batch is read once, and a pull request that was closed unmerged raises
  its card then. That is true, and it is the only time a card is late.
- **Upgrade note, for the release notes.** The first poll after the upgrade reads every older SHIPPED batch
  at once, and each one whose pull request was closed without merging raises its closed card then. A builder
  with many such batches sees that many cards together, one per pull request; each is dismissed once read.
- **Cards fire only on a stored transition,** so a restart, or a card the builder dismissed, never raises
  another:
  - checks become failing: one card naming the first failing check (and "and N more"), with its link first
    in the body and in `detail.link` (`pr-checks:<batch>`). While it is open, every read that finds the checks
    failing brings it up to date: its title, body and link follow the checks failing now and their latest
    runs, such as a fixed check dropping out or a new commit's run. A card that already says this is not
    written again, and a dismissed card stays dismissed; the next one comes with the next transition into
    failing, such as a run that fails after a pending one. It is withdrawn when checks pass, or the pull
    request merges or closes, or two reads in a row find no checks. One read of none is not enough: right
    after a push GitHub can list no checks for the new head until its runs appear, and withdrawing then
    would raise a second card when the new run fails;
  - the pull request becomes closed: one card, saying the tasks stay done, the code is not on the base and the
    local branch is kept (`pr-closed:<batch>`). Shipped tasks are done and can't start again, so it offers
    what works: reopen and merge the pull request on GitHub, which 10db doesn't follow, then dismiss the card,
    or dismiss it at once if the work isn't wanted;
  - a status becomes unknown because gh failed: **one card per daemon** (`pr-watch-gh`, raised in the first
    affected project, since fold keys are per project), saying what to do for signed out, not installed or
    any other failure, and that the status stays unknown and nothing else is affected. While it is open, a
    round that fails rewrites its title and body to say how gh fails now (signed out after a timeout, say);
    its detail stays. It is withdrawn after the next round in which every call gh was asked answered; a round
    that half answers leaves it open. The open-card check, the rewrite and the withdraw look in every project,
    not only those the round read: the card's project can drop out of the watch (its last pull request
    merged) while the card is still open.
- **The desktop link.** A flag card whose `detail.link` is a github.com page shows "Open on GitHub"; those are
  the only pages the app's opener may open (`opener:allow-open-url`). A check hosted elsewhere, such as a
  third-party CI's status, gets no button, and its address is in the card's text.
- **An unknown read keeps the last known checks.** When gh can't say, `state` becomes `unknown` with its
  reason, but `checks` and `failingChecks` keep what gh last said (`unknown` only if it never said). A failed
  read is therefore not a transition: a failing-checks card the builder dismissed is not raised again when gh
  answers after a sleep, a wake or a network flap with the same failing checks.
- **Every failing check counts.** The rollup does not say which checks are required, so a failing optional
  check raises the card too. This is a known gap; filtering to required checks is a follow-up.
- **Only a change writes an event.** A read that changes the state, checks, failing checks or unknown reason
  bumps the batch's `updatedAt` and emits `batch.updated` with `changed: ['pr']`. A read that changes
  nothing only advances `pr_checked_at`, with no event, so a pull request left open for weeks does not grow
  the event log every 2 minutes. The desktop sees the new `checkedAt` with the next change or on its next
  fetch.

_Designed, not built:_ shipping waits for CI, and gates run as pre-checks; the decision "CI decides"
(`decisions/2026-10-29-sandbox-is-the-boundary.md`) says work is done when CI is green and the pull request
merges, and this decision only records and shows that state. The Board and Factory badges that use `pr`, and
reopening tasks when a pull request closes, are follow-ups.

## Why

One batch has one pull request, so the batch row is the natural home, and `BatchDto` already reaches the
desktop through the project views, the batch list and `batch.updated` events. Storing the status, rather than
asking gh when the desktop asks, makes it survive a restart and keeps the desktop working with gh offline.
Raising a card on a stored change is what makes "one card" true across restarts. Polling beats webhooks for a
local app that has no public address. A separate `prStatus` keeps shipping on its smaller, already-tested
query.
