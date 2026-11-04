# A check that fails only in tests is rerun once on just the failing files, and each flake is filed

- **Date:** 2026-11-03
- **Amends:** decisions/2026-10-29-ship-gate-failing-tests-and-one-rerun.md

## Decision

- **When it reruns.** When a lane's check after an implement step (the runner's verify step) or a batch's check before its
  push (the shipper's pre-check or gate) fails, and every failing step the output names (`readGateFailures`)
  has a log that names failing vitest tests (`FAIL <project> <file> > <test>`), 10db runs just those test files
  once: `pnpm exec vitest run <file…>` (`rerunFlaky` in `apps/daemon/src/delivery/flaky-tests.ts`), under the
  same gate runner, sandbox and slot as any gate, and without a base update, since the tree is the one the
  first run tested. A test file path the command cannot carry safely (anything but letters, digits and
  `@ + . - /`, a `..` part, a leading `-`) means no rerun: the log is lane-written, and the command is made from it. A failing step
  that names no test (lint, typecheck, drift, a log 10db cannot read) means no rerun either. A check that
  itself timed out, or was stopped, is not rerun.
- **What it reads.** `make check-changed` and `make precheck` (`scripts/check-changed.mjs`) leave what `make gate`
  leaves: each step's output in `.gate/<step>.log`, cleared at the start of a run, and a `FAILED <step>: <command>
(log <path>)` line per failing step just before the summary line. A step name with a space takes a `-` in both
  (`drift-10db-x`), and a command past 200 characters (format and lint list every changed file) is replaced by the
  check's own command, since 10db keeps only the end of the output and a dropped line would hide a failing step.
- **Timeouts.** A failure whose first line says `Test timed out in N ms` is recorded as a timeout, but it is
  rerun like any other: a timeout counts as flaky only when the file passes on the rerun. The first run's
  first line for each failing test is read before the rerun and kept in the record.
- **A pass** lets the step continue as if the check had passed, with no card and no retry or fix attempt
  counted. The runner records the passing rerun as the step's gate evidence, headed by a note naming each test that
  failed once and passed on rerun with its first failure, outside the 2000 characters a gate summary keeps so that
  none is cut. The shipper shows the same note as a notice on the
  batch's tasks (`gate-flaky`, no card) and ships.
- **A failure that reproduces** is the failure it was: the runner counts the attempt and queues the fix, or fails
  the workstream past the limit with its card; the shipper goes on to its earlier rules (a second whole-gate run for
  tests the batch did not change, else the failed-gate card).
- **One Icebox task per flaky test file** (`fileFlakyTests`), titled `Fix flaky test file <file>`, naming each test
  and its first failure and the task whose check flaked (the runner's task; the batch's newest task for a ship).
  Deduplication is against open tasks by that title: while the file's task is open, a later flake is appended to its
  description ("Flaked again") and no second task is filed; once it is done or removed, the next flake files a new one.

## Why

19 of 2026-11-03's 60 cards were workstream-failed, and the orchestrator still answered Retry when a check failed
only because the Mac was loaded: delivery tests timed out at 30 s, and an earlier ship gate failed on 8 unrelated
desktop tests at load average 116. A fix session cannot repair a timeout, and a retry spends the limit on it. One
rerun of just the failing files is cheap, answers whether the failure reproduces, and the flake is not lost: it
becomes a task someone can fix.

Turned down:

- **Treating a timeout alone as passed.** A test that times out twice is a real failure (or a test that needs
  its limit raised); the rerun is what tells them apart.
- **Rerunning the whole check.** Minutes of load for the files that failed; the earlier decision's rerun of the whole
  gate stays, for the shipper's tests the batch did not change.
- **Parsing the `▶ <step>` sections of the check's full log.** A second format to read for the same facts, and the
  `FAILED` lines also give a fix session's brief the step, its rerun command and its log.
- **Keeping the rerun out of the evidence.** The record would not name the flake, and the first failure would be lost.
