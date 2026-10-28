# A worktree is removed only by what git lists as 10db's, and never with uncommitted work

- **Date:** 2026-10-27

## Decision

`SHIPPED` and `CLOSED` remove the worktree in the ship queue after the state is recorded (`remove --force
--force`, since the worktree is locked), then in one transaction delete the pin and clear `worktree_path`.
That removal makes no check of its own for uncommitted changes: it relies on ship step 0's clean check, as
recovery's re-run of it does;
`CLOSED` also deletes the branch when its tip is still `base_sha`. A batch's `worktree_path` is the one
column saying what exists, so recovery re-runs a removal whose clear did not land. `ABANDONED` removes the
worktree only when `git status` is clean; with uncommitted changes it is kept, `worktree_path` stays set, and
a card names the path and `git -C <main checkout> worktree remove --force --force <path>`, a command that
works wherever it is pasted (shown as code spans to type instead when either path is not plain). `FAILED` keeps it for Retry. Retry
and reopen replace a missing, half-made (no `index`) or clean worktree; they refuse, with a card, a worktree
on another branch or detached with uncommitted changes, one git can't read, one git won't trust, and anything
at the path git doesn't list as 10db's. Uncommitted work is never thrown away without the builder.

Every removal re-checks that the path is under the root by real path, is a directory and not a link, is
locked with a `10db ` reason and is listed by git as a worktree of the project's repository. A directory git
does not list is removed only when empty; otherwise it is left, a card names it, and `worktree_path` is
cleared so the daemon stops treating it as live.

At startup a sweep runs for every `pull_request` project (a project switched back to shared can still hold
orphans). It looks only at entries under this daemon's hashed level of the root, locked `10db bat_...`, whose
batch has no row or a cleared or different `worktree_path`. A clean one is removed, with its stored pin
unless the batch's live worktree holds that pin; one with uncommitted changes, or one git can't read, is kept
and named on a card with the same removal command. Then it prunes. Entries without the marker, other lock
reasons and paths outside the level are never touched. A project or an entry git refuses is logged and
skipped, so startup goes on.

## Why

Shipped work is on the remote and the local branch, so the worktree is disposable; uncommitted work is not.
The root, the hashed level, the lock marker and git's own list bound what the daemon may delete, so a path
a lane or the builder put elsewhere is never removed by mistake.
