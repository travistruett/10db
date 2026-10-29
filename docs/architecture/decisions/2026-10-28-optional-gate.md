# A project may have no gate command; the builder checks the work instead

- **Date:** 2026-10-28

## Decision

The gate command is optional (`docs/superpowers/specs/2026-10-28-10db-first-run-design.md`, F5 and F6).
A project with none runs its steps as before, but a task whose last step finishes is not verified by a
program: its workstream goes `RUNNING → VERIFYING → WAITING_HUMAN` with `nextAction.kind = 'builder_review'`,
no session and no lease, and a targeted Inbox card of the new kind `check` ("Ready for you to check") that
shows the task's changes. Only the builder's answer moves it:

- **Approve** completes the workstream (`WAITING_HUMAN → VERIFYING → DONE`), releases its claims and frees
  its lane, in the write that resolves the card. No review card is raised, since the builder has just looked.
- **Send Back** needs a note. The note is stored as builder evidence, the workstream is queued as a fix on the
  step that did the work (the implement step, when the check was raised from a review step), and the fixed
  work comes back for a check. Past `maxFixAttempts` the workstream fails with the note kept, and a retry
  restarts that step with it.

The workflow gains the edges `VERIFYING → WAITING_HUMAN` and `WAITING_HUMAN → VERIFYING`. There is no new
workstream state. A waiting task keeps its claims: it holds its areas while it waits (the builder's answer to
the spec's open question 2, §14 of the first-run spec: "it holds its areas for now; `WAITING_HUMAN` plus a
`check` card, no new state. Revisit with Goals"). Recovery parks such a workstream on its card without
touching git, raises the card again only when it was closed some other way, and never completes it.

A pull request ships without a gate step when its project has no gate command; the PR body's "How it was
checked" section says "No gate command: each task was approved in 10db." in place of the gate command, and
keeps its CI line.

`migrateDatabase` runs migrations with `foreign_keys` off and checks `foreign_key_check` afterwards, failing
with `MigrationIntegrityError` on any dangling reference. Migration 0007 rebuilds `projects`
(`gate_command` becomes nullable) and `evidence` (`command` and `exit_code` become nullable, since builder
evidence has neither).

`GET /workstreams/:id/changes` reads a workstream's changes through git plumbing (`diff-tree`, with every
display option spelled out so no config changes the answer), from `baseHead` to one head read once: the head
on the check card the workstream points at while it waits, else the checkout's head. The diff text is capped
at 512 KiB, cut on a character boundary, with `truncated` set; the per-file counts always cover every file.
Any finished batch with no worktree path, shared or worktree, answers 409: the project's checkout holds none
of a worktree's work, and a shared batch's changes are not told apart from it once it has finished.

## Why

An agent never judges its own work done. With no gate command, something still has to, and failing setup for
the missing command would turn away the projects that need 10db's check most. Moving the judgment to the
builder keeps the rule and drops the requirement.

A new state would have needed the same edges plus a Board column mapping and every exhaustive switch over
states. `WAITING_HUMAN` already shows on the Board as Blocked, and recovery already parks a workstream on a card
that targets it. The `review` card is raised after `DONE` and means something else, so the check is its own kind.

Holding claims while waiting keeps another task from editing the areas under a diff the builder is reading, at
the cost of blocking those areas until the builder answers. The builder chose that for now; goals may change it.

The migrations rebuild tables other tables reference, and SQLite can only drop such a table with foreign keys
off. The pragma is a no-op inside the migration's transaction, so it is switched off around the run, and the
check afterwards makes up for the enforcement that was off.

Plumbing keeps the diff independent of a developer's UI settings, and the cap keeps one huge change from
filling the response while the file counts still show its size.

## Known limits

- A pinned read of a checkout can still raise a trust card, because the changes route reads the checkout
  through the same pin as every other daemon git call.
- A check card can show a head older than the work. A second verify refreshes it; a restart keeps the card as
  it is, because recovery raises a card only when none is live. The changes route reads the head of the card
  the workstream points at, so the card's own text and commit count are as old as its head until then.
- A finished batch without a worktree path may have been shared or worktree; its changes are not shown,
  because the batch does not record which.
- In shared workspace mode the check diff is `baseHead..HEAD` of the project checkout, so another lane's
  commits in the same checkout appear in the card.
