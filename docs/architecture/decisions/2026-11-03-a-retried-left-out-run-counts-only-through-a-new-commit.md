# A retried left-out run counts as finished only through a new commit

- **Date:** 2026-11-03
- **Amends:** `decisions/2026-11-03-ship-without-it-leaves-out-every-failed-task.md`

## Decision

Retry on a run left out by Ship without it no longer simply clears the `left-out` notice. When the notice names
a revert commit, the write that queues the run replaces it with a `reverted-work` notice and adds a builder note
that tells the session its commits were reverted, names the revert and asks it to redo the work. A left-out run
that had nothing to revert loses its notice, as before. Nothing restores the reverted commits.

The pull request reads those notes across all of the task's runs in the batch. A task whose runs were told of a
revert is listed as finished only if a run that was told made a commit that is on the branch and is not an
ancestor of the latest revert. Otherwise the task is under Not done, even when its latest run reached `DONE`.

Starting the task over in the same batch is read the same way. In a shared project, Start with fresh on a
left-out run whose batch holds other tasks keeps the batch, and the start joins it (`findUnfinishedBatch` takes a
failed batch too). The joined run is inserted by `insertJoinedWorkstream`, which gives its session the same
builder note as a retry and sets it as the step's fix. The revert is read from an earlier run's `left-out` or
`reverted-work` notice when no note exists (a left-out run never retried), and from the notes otherwise. A
`left-out` notice that names a revert wins over a note: a retry swaps it for `reverted-work` in the write that adds
the note, so a run still holding it was left out after that note. A joined
run is therefore one that was told. Runs started before this change have no note: when their task has only a
`left-out` notice behind it, the task is listed as not done unless a told run committed, which errs towards saying
less was shipped.

A run that was not told does not count. That covers a merge run the shipping gate sends to the task, whose commit
resolves the base's conflicts and brings none of the work back.

## Why

The retried step may commit nothing: a retry can re-run a review or QA step, and the run then reaches `DONE`
with its work absent from the branch. The pull request body would call the task finished while the diff has
none of it.

Reverting the revert was turned down. The commits were left out because they passed no gate or review, so
putting them back without a session would ship what the builder chose to keep out.

Reading the notes from the task's latest run alone was turned down: the shipping gate can give the task a merge
run after the retry, and that run has no note, so the task would be listed as finished again. Excluding merge runs
by their flow is not possible, because a run does not store the flow it was planned from, and a new column would
do no more than the rule above. The rule also keeps the case where a left-out merge run is itself retried and
redoes the work: that run was told, so its commit counts.

The note is the record rather than the notice, because a run's notice shares one slot with its waits, so a wait
for a claim can replace it.

The check does not read what a commit changed. A run that was told and whose only later commit resolves conflict
markers counts as having committed again, and a run that never heard of the revert stays under Not done even if
it did the work again. The first would need a comparison of the reverted changes with the branch, and the second
errs towards saying less was shipped, not more.
