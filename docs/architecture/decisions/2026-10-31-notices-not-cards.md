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

## Open

- The "Claim deadlock" card stays: two tasks wait on each other, which only the builder or the tasks' agents can
  break, and it has no answer options yet. The start-refusal and ship-failure flag cards also stay as flags that say
  what to fix and close themselves (`resolvesWhen`); giving every one of them an answer is not done here.
