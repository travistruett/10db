# A project that left an account for its usage limit moves back by itself once the limit resets

- **Date:** 2026-11-08
- **Amends:** the accounts spec (`docs/superpowers/specs/2026-10-17-10db-accounts-design.md` §3), which had 10db
  ask before moving a project back

## Decision

A project whose move was caused by a usage limit (`MoveCause.UsageLimit`: 10db's own fallback at the threshold or
the limit, or the builder answering a limit or threshold card) is moved back to the account it left by 10db,
with no card, when that limit has reset. `projects.move_back_automatic` (migration 0051) records the cause; it is
set only by a `UsageLimit` move and cleared by any other move or by Stay.

- The checks before the old card still apply, unchanged: the account it left is archived (the record is
  forgotten), paused (it waits for the pause, or the default pause when it has no end) or still reports usage
  past the project's threshold (it checks again later).
- Lanes running at the move back are not asked to hand off. Like every move, they finish their current session,
  and the next one runs on the account the project returned to (`MoveCause.MoveBack` in `AccountMoves.move`,
  which also withdraws the card that told the builder about the move).
- A move the builder made by hand (`MoveCause.Builder`, including one off an account whose pause is in force)
  stays put: the old "move back?" card is still raised for it, and nothing moves until it is answered.
- A move back that falls due while the daemon is stopped happens on the next start: `restore()` runs it at once.
- Each move back writes a `project.changed` event whose data is
  `{ movedBack: { fromAccountId, toAccountId } }`, `from` being the fallback it left.
- Projects that were moved before the migration have `move_back_automatic` false, so they still raise the card.
- If the automatic move is refused (the move itself throws), the card is raised instead of the error reaching a
  timer or the start.

## Why

The builder reported that 10db and orgtools sat on Bedrock for days after a quota episode, unnoticed: a card in
the Inbox is easy to miss, and the cost of missing it is spend on the fallback. The whole cycle, plan, fallback,
plan, should run unattended, and it already did for the first half. Only a limit-caused move is reversed, because
the builder who moved a project by hand chose where it runs. Storing the cause is needed because the
account's pause state at the time of a hand move cannot tell the two apart later.

This also covers what the open task about adding the builder's Bedrock key as a backup account was after: the
fallback already moves a project to Bedrock at the plan's limit, and now the project comes back.
