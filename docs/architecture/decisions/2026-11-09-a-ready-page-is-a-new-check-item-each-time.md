# A Ready page is a new check item each time; Ready in a pass is pass_review, and Approve and Send Back are refused

- **Date:** 2026-11-09
- **Amends:** `decisions/2026-11-08-the-inbox-holds-what-needs-the-builder.md`; sits beside
  `decisions/2026-10-28-optional-gate.md`

## Decision

Each turn of a pass page that ends Ready raises a new `check` item (`runner/pass-check.ts`), with no fold key and
a `PassCheckDetail` naming the turn and its kept commit; the item before it was withdrawn when the builder's
message started the next turn, in that same write. The workstream waits as `WAITING_HUMAN` on the next action
`pass_review { inboxId }` with its session still attached. The built Approve and Send Back answer 409 for an item
of a task a pass holds, before the choice is read; the item's one option, Sign Off, answers 409 until sign-off
lands with closing. The desktop Inbox folds a pass's open Ready items into one row, "Workbench: n pages ready",
with no Approve or Send Back; a failed turn's flag keeps its own row.

## Why

A turn is a look-and-reply round, not a step's end: each round's facts (which files the turn changed, the page
against the pass's branch) belong to that round, and a new item notifies each time. Approve would land
unreviewed work and Send Back would spend a fix attempt, neither of which a pass has.

Turned down: one folded check item per page, which would hide each round's notification and facts.
