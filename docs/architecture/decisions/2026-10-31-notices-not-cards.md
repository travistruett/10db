# What asks the builder nothing is a notice on the task, not an Inbox card

- **Date:** 2026-10-31
- **Amends:** `decisions/2026-10-29-per-copy-hazards-and-waiting-claims.md` (the wait is a notice, not a card),
  `decisions/2026-10-29-gate-with-base.md` (a conflict with the base is a notice, not a card) and
  `decisions/2026-10-30-migrations-hazard-takes-the-base-first.md` (a held hazard names no card) and
  `decisions/2026-10-30-a-batch-settles-its-own-conflicts-with-main.md` (the conflict it leaves is a notice)

## Decision

- **The Inbox holds what needs the builder's answer.** On 2026-10-30 the builder dismissed "Waiting for hazard
  migrations" (no options), "Batch … conflicts with main" (raised again on every gate of one batch, three times in
  20 minutes) and "Pull request opened but not set to merge by itself" (twice). Each told the builder something and
  asked nothing. They are now notices, shown where the builder already looks for a task: its card on the Board and
  its drawer.
- **A `Notice`** (`packages/contracts/src/entities.ts`: `key`, `tone` `info` or `warning`, one `line`, a `body`) is
  stored in two places (migration `0018`): `workstreams.notice`, one per run, and `batches.notices`, a list keyed by
  `key`, which every task of the batch shows. `WorkstreamDto.notice` and `BatchDto.notices` carry them, both with
  defaults so an older body still parses.
  - A task **waiting for another task's claim** (`request_claim`, `mcp/claim-wait.ts`) has the run notice
    `claim-wait:<kind>:<name>`: "Waiting for hazard migrations: task "Beta" holds it". It is rewritten when the claim
    changes hands, cleared when the wait ends (granted, stopped session) and at daemon start, and raises no card. The
    "still waiting" answer of `request_claim` has `inboxId: null`.
  - A **batch that conflicts with its base**, or whose base is kept out by files git doesn't track, has the batch
    notice `base-conflict` or `base-kept` (`delivery/notices.ts`, `baseNotices`), written by the gate's base update. Its
    body is what the card said: the files, each with why 10db couldn't settle it, how to resolve them, and for a
    renumbered migration the steps to regenerate it, read from every conflicted path, settled ones included. It is cleared when a gate finds the branch holds the base. Retiring the worktree clears it, except a
    conflict that stood when the batch shipped: that becomes "Pull request conflicts with <base>". Once shipped, the
    pull request watch (`delivery/pr-watch.ts`) follows GitHub's `mergeable`: `MERGEABLE` clears the notice (the
    builder resolved it, or Update branch did), `CONFLICTING` writes "Pull request conflicts with <base>" when no
    conflict notice stands, and `UNKNOWN` (GitHub still working it out) changes nothing.
  - A **pull request that can't merge by itself** (the repository's auto-merge setting is off, GitHub refused
    auto-merge, or the immediate merge of a base with no required checks failed) has the batch notice
    `pull-request-merge` (`mergeNotices`). It is cleared when a later ship turns auto-merge on or merges it.
  - The desktop (`views/board/task-state.ts`, `taskNotices`) adds the notices' lines to a task's state line
    ("Building · Waiting for hazard migrations: task "Beta" holds it"), orange for a `warning` unless the line is
    already yellow, orange or red, and shows each notice's line and body in the drawer. A cancelled or failed run
    shows none; a batch's notices show until it ended without shipping, or its pull request merged or closed.
- **A notice always fits its contract.** `Notice` allows a 500-character line and an 8000-character body
  (`NOTICE_LINE_MAX`, `NOTICE_BODY_MAX`), and the desktop parses every answer against it, so one notice too long would
  stop the board loading for its project. `setBatchNotice` and `setWorkstreamNotice` cut both with `fitNotice`, ending
  in an ellipsis; the merge notices also cut gh's own words to 4000 characters, so the pull request's link after them
  stays.
- **No card is raised again for the same condition.** `setBatchNotice` and `setWorkstreamNotice` compare with what is
  stored and write nothing, and emit no event, when the notice is the same, so a later gate that meets the same
  conflict changes nothing, and the builder has nothing to dismiss. There is no card to fold, so a dismissed card
  can't come back.
- **A conflict that "needs the builder"** is the job of "Resolve a batch's conflicts with main by itself": it
  settles what it can, and what it leaves is the `base-conflict` notice above, not a card. A merge that stands but
  whose generated directories 10db couldn't regenerate still raises its one `base-regenerate:<id>` card: that is not
  one of the cards this decision moves.
- **What stays in the Inbox from here** is a card with answer options, or a question. Cards an earlier build raised for
  a batch's conflict and for waiting (`base-conflict:<id>`, `base-kept:<id>`, `detail.waitingFor`) are still closed:
  the base cards whenever a gate writes or clears the batch's base notice and at worktree removal, the wait cards at
  startup. A ship that writes or clears `pull-request-merge` closes the batch's `auto-merge-refused:<id>` card, and
  one that sets a pull request to merge closes the project's `auto-merge-off:<projectId>` card.

## Ship failures (follow-up, 2026-11-01)

- **Every "Batch … not shipped" card offers Retry and Abandon** (`shipCards`: dirty checkout, gate failed or
  timed out, push rejected or timed out, network, gh not installed or signed out). Each carries
  `detail.actions: ['retry', 'abandon']`; the Inbox shows buttons over the batch's existing ship and abandon routes
  (`batch-card-actions.tsx`), which the daemon acts on, and either closes the card. The card still closes itself when
  the batch ships (`resolvesWhen`). None offers only a Dismiss.
- **What asked nothing is a notice, not a card:** "the gate passed when 10db ran it again" is the batch notice
  `gate-rerun` (info; cleared when the next gate of the batch starts), and "only the pre-check ran, so the pull
  request waits" is the `pull-request-merge` notice (`mergeNotices.preCheckOnly`), which closes the
  `pre-check-only:<id>` card an earlier build raised. The "Batch … abandoned" card is gone: the builder just asked
  for it, an abandoned batch shows no notices, and the branch card (Delete Branch or Keep) already says what stays
  unmerged.

## Why

- A card interrupts: it raises the Inbox count, wants a look and then a dismiss, and these three asked for no
  decision. The task card is where the builder already looks to see what a task is doing, and it is the right place to
  say what it is waiting for.
- A notice is stored, not computed from the live waits in the daemon, so the card and the drawer need nothing but
  the DTOs they already read, and the existing `workstream.changed` and `batch.updated` events refresh them.
- Writing a notice only when it changes is what stops "raised again on every gate": the old card was folded only
  while open, so a dismissed card was raised anew by the next gate.
- Turned down: a new Inbox kind that the desktop filters out (still a row to dismiss, and an Inbox with hidden rows);
  keeping the cards but giving them a Dismiss option (still an interruption); computing the wait from `ClaimWaits`
  at read time (lost on restart, unreachable from the db package that builds the DTO).

## Start refusals (2026-11-01)

A refused start (`startCards`, `worktreeCards`, the wrong-branch card of a join, `landing`'s missing branch) stays an
Inbox card, and `forTasks` gives every one two answers the daemon acts on (`delivery/start-card.ts`,
`createStartCardAnswers`, run before the inbox records the answer):

- **Retry start** repeats the start from `detail.startRefused` (the batch title, and the batch it tried to join) and the
  card's `taskIds`. A start the request itself refuses (a task running, an unfinished dependency) throws, so the card
  stays open and says why; one the background cut refuses raises a fresh card, since the first closed with the answer.
- **Cancel task** removes each named task as the Board's remove does (`cancelTask`); a task that has started since, or
  that another open task waits on, throws and keeps the card open.

The tasks of a CI fix batch get **Cancel task** alone: a start can't repeat a fix cut, and the pull request's CI-stop
card, raised with it, has the Retry. No start refusal became a notice: a task that never started has neither a run nor a
batch to hold one (`workstreams.notice`, `batches.notices`), and each refusal has a real next step the builder takes
by answering, so none "asks nothing". The Board already shows a refused task's line from its card (`start-note.ts`).

## The gh card and the account cards (2026-11-02)

Each of these stays an Inbox card with an answer the daemon acts on; none became a notice, because none belongs to a
task (a notice lives on a run or a batch: `workstreams.notice`, `batches.notices`) and each has a next step the
builder takes by answering. None offers only a Dismiss, and the cards below that wait for a fix still close
themselves once it is made (`resolvesWhen`, or the existing closing of settled cards).

- **"Pull request status unknown: gh …"** (`prCards.ghUnavailable`) offers **Check again**
  (`delivery/gh-card.ts`, `createGhCardAnswers`): the pull request watch reads every followed pull request now
  (`recheck`) instead of at its next interval. If gh still fails, that round raises a fresh card saying how,
  though every pull request it reads was unknown already; a later round raises none while that card is open.
- **Sign in, Fix the credentials, Set the secret** offer **Check again**: `AccountPreparer.retry` probes at once,
  whatever the last probe's time. A ready account closes the cards that asked for the fix and asks for a tick; a
  secret that is still missing throws a `ConflictError`, which keeps the card open and says what is missing.
- **"<account> runs as <email>"** (the default account's login, recorded on its first probe) offers **Record again**:
  after the builder signed in as the right login, 10db forgets the recorded identity and records the one the directory
  holds now (`retry` with `forgetIdentity`).
- **"<project> moved to <fallback>"** (10db moved the project on its own) offers **Move back** (the project returns to
  the account it left, as the move-back card's answer does) and **Stay** (keeps the project where it is and forgets the
  move back).
- **"<account> reached its monthly cap"** offers **Raise cap to $N**: N is a whole-dollar figure a $10 step above
  the spend (or the old cap, if higher). The answer sets the cap, never lowering one raised since, and lifts the pause
  (`accounts.saved`). The option and its figure are rewritten with the body as running sessions add spend.
- `verify/` and `sandbox/` raise no card of their own: they return text (a blocked host's note, a sandbox failure)
  that the gate and the runner put in cards raised elsewhere. The gate's blocked-host card already offers to allow the
  host; the runner's cards for a repo MCP server that can't run are not part of this change.

## Open

- The "Claim deadlock" card now offers answers the daemon acts on (each task yields its claim, or either is
  cancelled; see `2026-10-29-per-copy-hazards-and-waiting-claims.md`). The start-refusal and ship-failure flag cards
  still stay as flags that say what to fix and close themselves (`resolvesWhen`); giving every one of them an answer
  is not done here. The builder agreed on 2026-10-31 that this change's "every card that remains offers a choice"
  covers only the cards it changed (the wait, the conflict with the base, the unmerged pull request), and that
  follow-up tasks give the other flag cards real answers.
