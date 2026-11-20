# A session leaves another writer's edits uncommitted, and a shared checkout's gate names only the task's commits

- **Date:** 2026-11-20
- **Amends:** `2026-11-20-a-task-is-not-charged-with-what-its-checkout-held-before-it-ran.md` (the record also holds paths a session named later)

## Decision

When a step in the builder's own checkout, outside a Workbench pass, is sent back to commit
uncommitted paths in its claims, its session may name any that are not the task's work in `report_deviation`'s `leaveUncommitted`, with its signed reason. 10db
adds each to the task's `task_start_dirt` record with `leftBy` set to the deviation, and
`claimedChanges` leaves that path out from then on, whatever the file holds later. The deviation's
signed reason lists the paths, so the builder sees them with the run.

A gate's evidence in the builder's own checkout names only the commits the run's sessions made
through the commit tool. In a worktree it names every commit since the run's `baseHead`, as before.

## Why

AMP-144 ran in Ampsio's shared checkout while the builder edited Plans files in it. The start-dirt
record (`2026-11-20-a-task-is-not-charged-with-what-its-checkout-held-before-it-ran.md`) covers only
what the checkout held before the task first ran. The builder's edits came later, inside the claims
the task held, so the finished, committed step was sent back twice to commit 10, then 25, Plans
files. Its sessions reported deviations saying the files were not theirs, which 10db had no way to
act on, and the run ended Blocked. Later, the builder committed those files on the same branch, so a
retried gate would have named the builder's commit as the task's.

10db can't tell these writes apart on its own: a lane's shell writes are not tracked, and the
builder's edits keep changing, so a fingerprint taken later does not hold. The session knows what it
changed, and the deviation keeps its claim on record.

Turned down: tracking every path a session's edit tools wrote, which misses shell writes such as
generators, and refusing to run a lane while the builder edits its areas, which makes a task wait
on the builder.

A session can name its own forgotten change and leave it uncommitted. The deviation names the path,
and in a shared checkout the change stays in the builder's checkout, where the builder sees it.
