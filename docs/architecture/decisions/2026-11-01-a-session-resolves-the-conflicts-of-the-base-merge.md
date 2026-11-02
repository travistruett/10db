# A task's session resolves the conflicts of the base merge, and the builder hears only about a judgment call

- **Date:** 2026-11-01
- **Amends:** `decisions/2026-10-30-a-batch-settles-its-own-conflicts-with-main.md` (a conflict where both sides
  changed the same lines is no longer the builder's by default)

## Decision

Built for a task's verify gate. When the base merge before a gate (`Git.mergeIntoBranch`) meets conflicts it cannot
settle by itself (both sides added lines, or a generated directory), and every one that remains is a text file where
both sides **changed the same lines**, a gate that has a session to send (`BeforeGateOptions.inSession`, passed by the
runner) asks for `resolve.leaveMarkers`:

- 10db commits the merge anyway, from `merge-tree --write-tree`'s tree, whose conflicted files already hold git's
  `diff3` markers. The merge commit has the branch first and the base second, so the pull request has no conflict
  with its base whatever happens next. Conflicts it can settle are settled as before (both sides' added lines kept; a
  generated directory taken whole from the base). The commit message lists what was settled and what was left.
- It keeps a note at `refs/10db/<worktree root>/merges/<batch id>` (`Git.keepNote`, a blob; `start-refs.ts`
  `mergeRef`): the merge commit, the base it brought in, the files with markers and the generated directories to
  regenerate. A retired worktree and the startup sweep delete it like a task's start.
- The gate does not run: `beforeGate` answers `conflicted`, the batch shows an info notice ("Resolving conflicts with
  main: …", `baseNotices.resolving`, key `base-conflict`), and the runner puts the task's workstream back in the
  queue with `nextAction: { kind: 'merge', base, paths }` (a retry counts against `maxFixAttempts`, like uncommitted
  changes), raising no card.
- The session is told which files hold markers (`briefing/prompts.ts`): keep what both sides do, adapt the other
  side's callers to a changed signature, never edit a generated file, `request_claim` the area of a file outside its
  claims, commit through `mcp__10db__commit`. A resolution that would change what either side does is not guessed: it
  calls `ask_human` naming the files and why. That is the one card, and the workstream waits on it, so no gate runs
  on the stale branch meanwhile.
- The next gate finds the note: while `Git.conflictMarkers` still finds markers in a file at HEAD it answers
  `conflicted` again, without merging. Once none is left it drops the note and the notice, runs the install and the
  generators of the generated directories the merge took from the base (they read the resolved sources, so they
  waited), and answers `merged`: the gate runs on the merged branch.

A conflict that stays the builder's, as before (`not_merged`, the `base-conflict` notice, the gate on the branch as it
is): a lockfile or a drizzle journal outside a generated directory, a file one side deleted or both added, a binary
or large file, a mode change, a JSON file or anything else whose markers would not show the choice. Any one of them
keeps the whole merge from being committed with markers. So does a task asking for the migrations hazard
(`forMigrations`): its session is working in the worktree.

## Why

On 2026-11-01 two batches waited on a hand merge that was mechanical: keep both sides, then adapt one call site. A
lane cannot write the git dir, but it does not have to: 10db makes the merge commit, with the base as its second
parent, and the lane only edits and commits files through the commit tool it already has. The alternative the
request sketched, leaving the markers uncommitted in the worktree and recording the merge after the session, would
show every file the base changed as an uncommitted change outside the task's claims (stray-write cards at step
end, the uncommitted-changes send-back before the gate), and the session's edits of files outside its claims need
`request_claim` either way. Committing the markers keeps all of that untouched; the cost is a commit with markers in
the branch's history, which no gate or push can pass over, because `conflicted` stops the gate and the shipping gate
fails on it.

## Left open

- The shipping gate has no session to send. It never starts such a merge (a conflict that appears only then is the
  `base-conflict` notice with the gate on the stale branch, as before), and finding markers left by an earlier gate
  it runs the gate anyway, which fails on them and raises the gate-failed card. A follow-up can reopen the batch's
  last task with the `merge` action.
- A resolution is judged by the gate that tests the merged result, as a union of added lines is: 10db checks that
  the markers are gone, not that the code is right.
- Conflicts without markers in the tree (a deletion on one side, a binary file) stay the builder's.
