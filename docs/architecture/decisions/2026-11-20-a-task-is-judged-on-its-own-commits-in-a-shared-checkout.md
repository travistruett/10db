# A task is judged on its own commits in a shared checkout, and another writer's edits cost it no retry

- **Date:** 2026-11-20
- **Amends:** `2026-11-20-a-session-leaves-another-writers-edits-uncommitted.md`

## Decision

In the builder's own checkout, a run's work is the commits its sessions made through the commit tool,
as ranges of first-parent history: a commit of anyone else's between two of them splits the range.
Gate evidence, the check card's facts, the Changes view, the review safety net, the Markdown check that
skips QA and the test-value judge all read those ranges. In a worktree a run's work is every commit
since its `baseHead`, in one range, as before.

A send-back does not count toward the step's retry limit when the session that just ended was sent
back for paths, committed or named every one, named at least one as another writer's, and every path
in the new send-back is new. A task's sessions get five such rounds. A repeated path, a send-back
after a handoff, or one with nothing named as someone else's still counts.

## Why

The gate record already named only the task's commits. The checks beside it still read every commit
since `baseHead`, so a migration the builder committed on Ampsio's `build` between two of a task's
commits forced a review of the task, and the builder's tests went to the test-value judge as the
task's. A builder who kept adding files ran a task whose sessions named each one into its retry
limit.

The cap bounds a session that names someone else's file each round while it keeps leaving its own.
