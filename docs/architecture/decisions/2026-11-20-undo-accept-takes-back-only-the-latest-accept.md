# Undo Accept takes back only a plan's latest Accept, and never a task that has run

- **Date:** 2026-11-20

## Decision

- Each Accept of a plan is recorded (`shape_accepts`, and `accept_id` on the proposals it accepted and the landing
  groups it made). Undo Accept takes back only the plan's latest Accept that is not undone; older ones are undone
  in order, newest first.
- Undo refuses, before writing anything, when any task it would remove has any run (queued, held, or cancelled
  before a session included), or when a goal it would remove holds a live task it did not make. The refusal says
  to cancel the run and remove the task from the Board first. The panel shows Undo Accept disabled with that reason.
- What Undo can't take back stays and is counted as kept: a change or removal of a Board task, a decision
  superseded or a principle replaced since, and a landing group holding a task it didn't make. A record already
  withdrawn counts as taken back.
- Accept and Start starts the tasks that Accept made that are ready. A task waiting on unfinished work outside the
  start, on a task that runs in another place, or (in local delivery) on another task of the same start stays on
  the Board, and the confirm names it. An error after the Accept leaves the Accept standing and says so.

## Why

Undo removes Board rows, so it must never take a lane's work, a worktree or a task it did not write. Refusing on
any run keeps the store's cancellation of held runs from leaving an orphan worktree and branch. Latest-only keeps
every Undo exact: later Accepts can depend on what earlier ones wrote. Turned down: undoing any Accept in any order
(what a later Accept built on would dangle), and cancelling runs as part of Undo (it would hide lost work behind one
click).

The spec is `docs/superpowers/specs/2026-11-19-10db-plan-in-sessions-design.md` and the plan is
`docs/superpowers/plans/2026-11-20-10db-plan-in-sessions-s3.md`.
