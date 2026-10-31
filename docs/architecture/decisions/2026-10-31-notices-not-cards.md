# What asks the builder nothing is a notice on the task, not an Inbox card

- **Date:** 2026-10-31
- **Amends:** `decisions/2026-10-29-per-copy-hazards-and-waiting-claims.md` (the wait is a notice, not a card),
  `decisions/2026-10-29-gate-with-base.md` (a conflict with the base is a notice, not a card) and
  `decisions/2026-10-30-migrations-hazard-takes-the-base-first.md` (a held hazard names no card)

## Decision

- **The Inbox holds what needs the builder's answer.** On 2026-10-30 the builder dismissed "Waiting for hazard
  migrations" (no options), "Batch … conflicts with main" (raised again on every gate of one batch, three times in
  20 minutes) and "Pull request opened but not set to merge by itself" (twice). Each told the builder something and
  asked nothing. They are now notices, shown where the builder already looks for a task: its card on the Board and
  its drawer.
- **A `Notice`** (`packages/contracts/src/entities.ts`: `key`, `tone` `info` or `warning`, one `line`, a `body`) is
  stored in two places (migration `0017`): `workstreams.notice`, one per run, and `batches.notices`, a list keyed by
  `key`, which every task of the batch shows. `WorkstreamDto.notice` and `BatchDto.notices` carry them, both with
  defaults so an older body still parses.
  - A task **waiting for another task's claim** (`request_claim`, `mcp/claim-wait.ts`) has the run notice
    `claim-wait:<kind>:<name>`: "Waiting for hazard migrations: task "Beta" holds it". It is rewritten when the claim
    changes hands, cleared when the wait ends (granted, stopped session) and at daemon start, and raises no card. The
    "still waiting" answer of `request_claim` has `inboxId: null`.
  - A **batch that conflicts with its base**, or whose base is kept out by files git doesn't track, has the batch
    notice `base-conflict` or `base-kept` (`delivery/notices.ts`, `baseNotices`), written by the gate's base update. Its
    body is what the card said: the files, how to resolve them, and for a renumbered migration the steps to
    regenerate it. It is cleared when a gate finds the branch holds the base. Retiring the worktree clears it, except a
    conflict that stood when the batch shipped: that becomes "Pull request conflicts with <base>" until the pull
    request merges or closes.
  - A **pull request that can't merge by itself** (the repository's auto-merge setting is off, GitHub refused
    auto-merge, or the immediate merge of a base with no required checks failed) has the batch notice
    `pull-request-merge` (`mergeNotices`). It is cleared when a later ship turns auto-merge on or merges it.
  - The desktop (`views/board/task-state.ts`, `taskNotices`) adds the notices' lines to a task's state line
    ("Building · Waiting for hazard migrations: task "Beta" holds it"), orange for a `warning` unless the line is
    already yellow, orange or red, and shows each notice's line and body in the drawer. A cancelled or failed run
    shows none; a batch's notices show until it ended without shipping, or its pull request merged or closed.
- **No card is raised again for the same condition.** `setBatchNotice` and `setWorkstreamNotice` compare with what is
  stored and write nothing, and emit no event, when the notice is the same, so a later gate that meets the same
  conflict changes nothing, and the builder has nothing to dismiss. There is no card to fold, so a dismissed card
  can't come back.
- **A conflict that "needs the builder"** is the job of "Resolve a batch's conflicts with main by itself": it
  settles what it can and raises the one card for the rest. This change gives that card nothing to compete with: the
  gate no longer raises a conflict card. Until it lands, a conflict that stands is shown on the tasks and, once
  shipped, on the pull request.
- **What stays in the Inbox from here** is a card with answer options, or a question. Cards an earlier build raised for
  a batch's conflict and for waiting (`base-conflict:<id>`, `base-kept:<id>`, `detail.waitingFor`) are still closed
  at worktree removal and at startup.

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
