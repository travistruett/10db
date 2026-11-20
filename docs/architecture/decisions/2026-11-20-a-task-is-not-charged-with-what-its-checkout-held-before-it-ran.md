# A task is not charged with what its checkout held uncommitted before it first ran

- **Date:** 2026-11-20

## Decision

When a task's workstream first launches a session (not in a pass), 10db records every path its
checkout holds uncommitted, each with an lstat fingerprint (inode, size, modification and change
times), in `task_start_dirt`, once per task. A later run of the task keeps that first record. At a
step's end, a changed path in the step's claims whose fingerprint still matches the record is not
the step's work: the step is not sent back to commit it and the gate does not wait on it. A path
the task changed since, or one it deleted, is the task's again. A checkout that can't be read when
the task first launches records nothing, so every change stays the task's, and so does a task
for which any session has already run (a pass page's, or one from before this record existed):
what its checkout holds may be its own work, put back from a pass or left by an earlier run.

## Why

In a shared checkout the builder works beside the lanes. A file the builder left uncommitted inside
a task's area was charged to the task: Ampsio's AMP-144 finished its step three times and was sent
back each time to commit the builder's eleven-day-old edit to `docs/architecture/decisions.md`,
until its agent refused and the run failed. Keying the record by task, not by workstream, keeps a
retry or a new run of the same task owing what an earlier run of it left uncommitted.

The fingerprint is read with lstat: hashing contents would open files an agent can replace with a
pipe or a link. Turned down: refusing to start a lane while its areas are dirty, which makes a task
wait on the builder; and a pass's start-dirt commit, which passes need for put-back but a lane does
not.

A file both the builder and the task edited is still the task's to commit whole, as before.
