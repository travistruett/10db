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
  wrong. Only https links are kept. GitHub's answer that the pull request isn't there for gh's account counts
  as no pull request. gh looks a URL up by number and prints GitHub's GraphQL error as it came:
  `Could not resolve to a PullRequest`, or `Could not resolve to a Repository` for a repository that is gone
  or closed to the account (`no pull requests found` is only its branch lookup's wording). The status becomes
  unknown with that reason, and no gh card is raised, since gh answered.
- **When.** `delivery/pr-watch.ts` polls every 2 minutes on the injected clock, once at startup and right
  after a batch becomes SHIPPED, one gh call at a time. A gh call has a 2 minute timeout, so every answer
  arrives within the 5 minutes the task asks for. It runs outside the delivery job queues: a ship or a cut
  never waits behind a poll, and a slow gh stops nothing else.
- **A failed read.** A failure of gh itself ends the round and marks its pull request and the rest of the
  round unknown with that failure: gh signed out, not installed, no answer within the timeout, or GitHub out
  of reach (`unreachable`: gh's line for a DNS failure, or Go's network error, such as a `dial tcp` that
  timed out, `connection refused` or a TLS handshake timeout, any of which can take nearly as long as the
  timeout). Every later read would fail the same way or wait as long, so offline costs one wait per round, not
  one per pull request. Any other failure (`failed`: an error GitHub answered with, such as an organization's
  SAML enforcement or a 502) marks only its own pull request unknown, with its own reason, and the round goes
  on: one pull request gh can't read, read first because it is the oldest, never keeps the others unread. The
  next round starts after the pull request whose failure ended the last one and reads it last, so one whose
  read always times out holds up no other either.
- **Which batches.** SHIPPED, with a pull request url, whose state was never read or reads `open` or
  `unknown`. **Merged and closed are final:** a pull request the builder reopens is not followed again.
  After the upgrade every older SHIPPED batch is read once, and a pull request that was closed unmerged, or
  is open with failing checks, raises its card then. That is true, and it is the only time a card is late.
- **Upgrade note, for the release notes.** The first poll after the upgrade reads every older SHIPPED batch
  at once, and nothing was stored for any of them before, so each read is a transition. Each one whose pull
  request was closed without merging raises its closed card, and each open one whose checks fail raises its
  failing-checks card. A builder with many such batches sees that many cards together, one per pull request;
  each is dismissed once read.
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
  - gh is down: **one card per daemon** (`pr-watch-gh`), raised when a failure of gh itself ended a round, or
    when no read in a round answered (each failed on its own, as in a GitHub outage), in the project of the
    first pull request the round turned unknown, since fold keys are per project. It says what to do for
    signed out, not installed or any other failure, and that the status stays unknown and nothing else is
    affected. Its detail names that batch and pull request but has no `link`: no page there says why gh
    fails. While it is open, a round in which gh is down rewrites its title and body to say how gh fails now
    (signed out after a timeout, say); its detail stays. It is withdrawn after a round gh answered in which gh
    itself didn't fail, even if one pull request's read failed on its own: that one shows its own reason, and
    gh works. The open-card check, the rewrite and the withdraw look in every project, not only those the
    round read: the card's project can drop out of the watch (its last pull request merged) while the card is
    still open.
- **One write.** A read's status and the card its change raises, rewrites or withdraws commit in one
  transaction (`raiseIn`, `rewriteIn` and `withdrawIn` in `delivery/context.ts`, over the inbox's own writes,
  `flagCard`, `rewordCard` and `withdrawCard`), so a crash or a failed write never stores a transition
  without its card: the next read finds nothing stored and raises it then. The unknown statuses a round's
  failed reads leave are stored at the round's end, in the write that raises or rewrites the gh card.
- **The desktop link.** A flag card whose `detail.link` is a github.com page shows "Open on GitHub"; those are
  the only pages the app's opener may open (`opener:allow-open-url`). A check hosted elsewhere, such as a
  third-party CI's status, gets no button, and its address is in the card's text. The gh card has no link.
- **An unknown read keeps the last known checks.** When gh can't say, `state` becomes `unknown` with its
  reason, but `checks` and `failingChecks` keep what gh last said (`unknown` only if it never said). A failed
  read is therefore not a transition: a failing-checks card the builder dismissed is not raised again when gh
  answers after a sleep, a wake or a network flap with the same failing checks. Nor does it count toward any
  rule about checks: only a read gh answered withdraws the failing-checks card, so the two reads that find no
  checks are two answered reads, with nothing but unknown reads between them.
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
Raising a card on a stored change is what makes "one card" true across restarts, and storing the change with
its card in one write keeps it true across a crash. Polling beats webhooks for a local app that has no public
address. A separate `prStatus` keeps shipping on its smaller, already-tested query.

Ending a round on every failure let one pull request gh couldn't read (its repository gone, an organization's
SAML enforcement), read first because it is the oldest, keep every later pull request unknown for good, under
a gh card that never went. Ending it on no failure would make offline cost one wait per pull request, since
a connection that times out takes as long for each. So a failure ends the round only when it is about gh
itself, which every later read would meet too; everything else stays with its own pull request. Telling
"GitHub out of reach" from "GitHub answered with an error" needs gh's wording, which `github/` alone reads.
