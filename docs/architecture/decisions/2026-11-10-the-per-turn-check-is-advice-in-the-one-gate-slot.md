# The check after each Workbench turn is advice, coalesced per pass, in the one gate slot

- **Date:** 2026-11-10
- **Amends:** `decisions/2026-10-28-gate-slots.md`, `decisions/2026-11-10-a-pass-gates-what-its-pull-request-holds.md`

## Decision

When a page's turn ends Ready (`pass.page_ready`, in the runner or in start-up recovery's finish of an ended
turn), the daemon runs the project's `changedCheckCommand` in Your folder, and nothing else: never the
pre-check or the gate in its place (W16). A project with none runs nothing per turn, and Start Pass says
"No changed-files check: turns run unchecked" (`no_changed_check`).

- It runs through the shipping gates' limiter (`shipGate`: the shared `createGateSlots` slots, held back by
  the load guard), with the project's id (so its Docker rules apply), the project's env and rules, under the
  gate sandbox. Its timeout is `TURN_CHECK_TIMEOUT_MS` (10 minutes), or the gate's timeout when shorter.
- It is coalesced per pass (`runner/turn-check-queue.ts`): at most one check running and one waiting; a turn
  that ends while one waits joins it. "The tasks whose turns ran the check" are every task whose turn ended
  since the last run started.
- Its result is advice: no page is held back from Ready, no `attempt` moves, no turn starts. A pass writes
  `passed` on the run's turns and clears the header's `turn-check` notice; a failure writes `failed`, puts a
  sendable `turn_check` header notice and a sendable thread notice on each page the output names by a whole
  changed path (`runner/check-targets.ts`), else on the run's tasks still held, not signed off and not
  working again; a newer failure withdraws the task's older check offers. A check that could not start (exit
  126, Docker refused) or that threw is a header notice offering nothing, and its turns stay `none`.
- Its process group is `passes.check_pid`/`check_pid_start` (migration 0057), named by the load monitor.
  Start-up stops a recorded one and clears it before recovery runs (`startTurnChecks`), so a check recovery's
  Ready asks for never runs beside a left one or takes its pid's place. A waiting check dies with the daemon.
- A pass that leaves OPEN stops its check (`pass.changed`), and so do the close's and Abandon's
  `stopPassChecks` (`withTurnChecks`); every result write is guarded on the pass being OPEN.

## Why

Workbench spec §8.1: the slot of its own an earlier draft gave the check broke the one-runner rule, and four
checks at once would all exec into one stack. The check reads the folder as it is, so the latest run covers
every turn before it: one waiting check loses nothing. Ten minutes caps advice that would otherwise hold the
Mac's only gate slot for a gate's 30. Recording the pid on the pass, not the batch, keeps it apart from the
gate a pass's pull request runs on the batch row. Turned down: a check per turn (four at once), and running the
gate when no changed-files check is set (W16: the gate is once, at the pull request).
