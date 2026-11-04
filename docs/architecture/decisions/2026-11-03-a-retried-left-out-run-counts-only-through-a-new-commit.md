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

The step that can commit is the one asked to redo the work. A retry at a read-only step (review or QA) with an
implement step before it restarts that implement step, not the read-only step: the retry's target moves back to it,
as a reviewer's rejection moves it, and the note is that step's fix. A step that runs before the first implement
step (a plan or plan review, on a retry or on a joined run's start) restarts as usual and gets a note that says
only what happened, since it cannot commit. When the run then moves forward into its implement step, that step gets
the full note as its fix, unless an implement step has started since the last note.

The note is repeated. Every Retry of a run whose revert still stands writes it again, so a second Retry of a run
that committed nothing tells the new session once more. A commit made since the last note ends that: it brings work
back, and 10db never undoes a revert, so the run is not told again. A commit that resolved conflict markers does
not end it. A Retry of a run whose `left-out` notice names no revert, when the batch's open left-out card holds
none either, writes a `no_revert` record and tells nothing
(`decisions/2026-11-04-the-failure-line-reads-whether-a-run-was-told-of-a-revert-from-the-run.md`).

A later Ship without it gives a run with a commit listed by a revert on the branch the `left-out` notice `reverted`,
whether or not the run was ever retried. The notice names that revert, or this answer's own revert when it also
undoes newer commits of the run. It gives a run the `left-out` notice `alreadyReverted` only when no commit of the
task is listed by a revert on the branch, this answer reverted none of them, and the run's record names a revert
still on the branch. That notice names the revert and does not say the run failed again or that a retry added none,
since neither has to be true of such a run. The revert line of either notice is what a Retry reads to tell the
session.

A run that was not told does not count. That covers a merge run the shipping gate sends to the task, whose commit
resolves the base's conflicts and brings none of the work back.

A told run's own commit does not count either when it resolved conflict markers. The runner queues the same run
again when the base merge at its gate leaves markers (`sendToMerge`), so a retried run can skip the redo and commit
only the resolution. 10db commits that merge with the markers in it, so the branch itself says which commits resolve
them: the commit tool compares each commit with its parent, and stores `resolvedMarkers: true` in the commit's
tool-op result (the session's answer is unchanged) when a file it changed held markers at the parent. The pull
request leaves those commits out when it asks whether a told run committed again, and Retry leaves them out when it
asks whether to tell the session again, so one commit is judged one way. It holds whichever session makes the
commit: one that asked the builder a question, was paused by the usage limit, handed off, or left the resolution
uncommitted for the next session.

A run that resolves the markers and redoes the work in another commit counts through that commit. One commit that
does both does not count, and the task is under Not done with its work on the branch, because the record cannot
separate the two; that errs towards saying less was shipped. So does a redo that edits a file with marker lines in
it. A commit by a told run that is neither work nor a resolution still counts: a caller adapted to the base in a
commit of its own, once the markers are gone.

A told run's commit made while its session was fixing a failed gate does not count either. The commit tool stores
`throughGate: true` in the tool-op result when the latest of the run's gate and builder evidence is a gate run that
failed (`fixingFailedGate`, the record the runner's `outstandingFixEvidence` reads), so the mark holds after a
question, a usage limit or a handoff replaced the next action. A told run's gate runs on the merged branch, so such
a commit repairs or adapts the work to the base. The pull request and Retry read it with the markers mark. A Retry's
note comes after the failure, so a session told to redo the work is not marked, and a redo made before the gate failed
counts. A redo made only in a session fixing a failed gate errs to Not done, as one commit doing both does. The
caller commit above is not covered: it is made in the merge session before any gate runs again, and a redo committed
in that session after the resolution counts by the rule above, so no record separates the two.

## Why

The retried step may commit nothing: a retry that restarted a review or QA step would reach `DONE` with its work
absent from the branch. The pull request body would call the task finished while the diff has none of it. So a
run with a revert standing goes back to the implement step, which can commit, and is told again on each Retry
until it has.

Reverting the revert was turned down. The commits were left out because they passed no gate or review, so
putting them back without a session would ship what the builder chose to keep out.

Reading the notes from the task's latest run alone was turned down: the shipping gate can give the task a merge
run after the retry, and that run has no note, so the task would be listed as finished again. Excluding merge runs
by their flow is not possible, because a run does not store the flow it was planned from, and a new column would
do no more than the rule above. The rule also keeps the case where a left-out merge run is itself retried and
redoes the work: that run was told, so its commit counts.

The note is the record rather than the notice, because a run's notice shares one slot with its waits, so a wait
for a claim can replace it.

A run that never heard of the revert stays under Not done even if it did the work again; that errs towards saying
less was shipped, not more.

Marking commits by the `merge` next action was turned down, because the action does not last as long as the
resolution: a question, a usage limit, a handoff or an uncommitted resolution replaces it, and every commit of a
merge session would carry it, the redo too. Comparing the branch with what the revert undid was turned down too. A
redo may rewrite the work or put it in other files, so a match on content or paths would list finished work as not
done, and a resolution in a file the revert also touched would pass as work.
