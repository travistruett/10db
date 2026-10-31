# A not-shipped card names the failing step and tests, and a failure the batch couldn't have caused runs once more

- **Date:** 2026-10-29
- **Amends:** decisions/2026-10-29-gate-with-base.md

## Decision

- **What the card says.** When the shipping gate fails, the shipper reads the failing steps from the gate's
  output: its `FAILED <step>: <command> (log <path>)` lines, or else its `GATE FAIL: <steps> — logs in <dir>/`
  summary line (`readGateFailures` in `apps/daemon/src/delivery/gate-failures.ts`). It reads each step's log in
  the batch's checkout (never one outside it) and takes the failing tests from vitest's
  `FAIL <project> <file> > <suite> > <test>` lines. The card's title names the steps ("the gate failed (exit 1) in test"); its
  body lists each step with its command, up to 5 failing tests and "and N more", and each step's full log
  path. `detail.logPath` carries the first step's log, which the Inbox card opens as a file:// link ("Open
  the step log", the path as its tooltip), as the Board drawer's Gate log link does. A gate that names no
  steps keeps the old card: its last output and the batch's gate log.
- **When it runs once more.** Only when every failing step named failing tests, no failing test is in a file
  the batch changed since its base (`git diff-tree` from the base the branch holds now to its tip, a printed
  path matching a changed path or its end), and every done member's latest gate evidence passed. Anything
  10db can't read counts as the batch's. Then the shipper logs it and runs the gate once more, in the same
  slot and with the same base update as any shipping gate. One rerun per ship attempt; Retry starts a new one.
- **After the rerun.** If it passes, the batch ships and a card says the gate passed when 10db ran it again
  and lists the tests that may be flaky. If it fails and the new failure is again outside the batch, the
  card says the failure looks unrelated to the batch's work, that 10db ran the gate again by itself and
  started no fix session, and offers Retry and Abandon (`detail.actions`), which the Inbox card shows as
  buttons over the batch's existing ship and abandon routes, dismissing the card once done. It doesn't
  suggest a fix task. If the rerun fails in the batch's own files, the usual card says 10db reran it.

## Why

A batch's card read "the gate failed (exit 2) Last output:" and nothing a builder could use: the batch
gate's output ends in the summary line, and the failing tests sat in `.gate/test.log` in the worktree. All 8
failing tests were in files the task didn't change and had passed in its own gate, and feedback item 146
records fix sessions spent on exactly such failures. One automatic rerun separates a flaky failure from a
real one without the builder; a second failure outside the batch is the builder's call, not a fix session's.

Turned down:

- **Rerunning on any failure**: a real failure would cost a second full gate before the builder hears of it.
- **Rerunning only the failing tests**: the gate is the project's command; 10db doesn't know how to run part
  of it, and the pull request needs the whole gate to have passed.
- **Reading the task's own gate log for each test**: only the summary is kept per run (the step logs in
  `.gate/` are overwritten by the next gate), so the shipper relies on the task's gate having passed, which
  every test in it did.
- **A daemon route that serves the log**: a separate task, as the drawer's decision already says.

Left open: a test file the base merge added after the task's gate ran didn't run in that gate, but it is not
the batch's file, so it counts as outside the batch.
