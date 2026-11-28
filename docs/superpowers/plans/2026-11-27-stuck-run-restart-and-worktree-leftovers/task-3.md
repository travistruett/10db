# Task 3: a second stall files the defect and raises the Stall card

Read the index's Brief and Global Constraints first. Size: Core (recovery; answers that cancel a run). Starts
after task 2 has merged, and needs stage 4's task 3 merged
(`docs/superpowers/plans/2026-11-27-ship-gate-out-of-moves/task-3.md`): it adds to `out-of-moves-card.ts`. If
that file does not exist yet, build tasks 4 to 6 first. Stage 4 may have renamed things; the names below are its
plan's, so read the merged file and use what it exports.

**Files:**

- `apps/daemon/src/inbox/out-of-moves-card.ts`: `OutOfMovesKind.Stall`; its case in `createOutOfMovesAnswers`.
- `apps/daemon/src/stalls/card.ts`: `stallOutOfMovesCard(stall, { fault, defect, holds })`.
- `apps/daemon/src/stalls/sweep.ts`: the `out_of_moves` branch, and `stop_hung` raising this card.
- `apps/daemon/src/daemon/start.ts`: pass `restartStalled` and `cancel` to the answers.
- `apps/desktop/e2e/inbox.spec.ts`: extended. `apps/daemon/src/stalls/AGENTS.md`, `apps/daemon/src/inbox/AGENTS.md`.

**Calls**, exactly: `fileDefect(w, { signature, title, description })`, `markDefect`, `markHung`, `clearRestart`,
`readRestart`, `Runner.restartStalled`, `outOfMovesFields`, `OutOfMovesChoice`, `decidedByBuilder(BuilderOwns.OutOfMoves)`.

**The `out_of_moves` branch.** One write:

- When `fileDefect` is true and the record has no `defectTaskId`: `fileDefect` with signature
  `stall:<fault>:<state>` (state lowercased), a title that says what stalled ("A run's stop did not finish in 2
  minutes"), and a description with the project, the task's title, the state, the times and the fault. A task id
  goes to `markDefect`. Null means no 10db project here or an open task already has the signature.
- Then the card, whatever `fileDefect` answered. There is no wait and no silent path.

**The card.** `stallCard`'s shape with the out-of-moves answers: it keeps `detail[STALL_CARD]`, `foldKey` and
`closesWhen: { by: 'event', when: { event: 'stall_cleared', key } }`, so the sweep still closes it when the run
moves, and adds `outOfMovesFields({ kind: OutOfMovesKind.Stall, more: 1, … })`.

- Title: `Out of moves: <task title> stalled again`, or `… would not stop` for `StopHung`.
- Body: what stalled and since when; "10db restarted it once from its handoff, and it stalled again." (or the
  hung-stop sentence); the defect line: "10db filed this as its own defect: <title>." or "This looks like a 10db
  defect; the report could not be filed here."; then what the run holds.
- "What it holds" (its lane, its claims by name, a gate slot when a gate process is recorded) is fixed text written
  when the card is raised, like `since`; the fingerprint includes it, so a change rewrites the card.
- Options: Spend More Attempts ("Stops it and starts it once more from its handoff"), Change the Task ("The same,
  with your note in its brief"), Drop It ("Cancels the run").

**The answers.** Parse the detail (JSON from the database).

- More: `clearRestart`, then `restartStalled(id)`. `stop_hung` throws so the card stays; `not_active` closes it.
- Change: refused without a note (throw); with one, `restartStalled(id, { note })`.
- Drop: cancel, as `StallAction.CancelRun` does.
- A row left Running with no live lane by a late stop is restarted through `restartStalled`'s no-lane path.

**State-table rows:** `out_of_moves`, the three Stall card rows, "The run moves, or ends" (the card).

**Test.** No new unit test. Extend the case task 2 added: (d) a restarted run whose session goes silent again gets
one open card with `OutOfMovesChoice`'s labels and no second restart; with the fault `NeverStarted` and a 10db
project seeded, an Icebox task carrying `stall:never_started:starting` exists and the card's body names it; Drop
It cancels the run. Extend `apps/desktop/e2e/inbox.spec.ts`'s out-of-moves case to seed a Stall card and check its
three answers show. Click it through against the real daemon before review.

**Spec:** the "Stuck run" row (Escalates when, What you see then) of "3. The decision-rights table", "8. Where this
departs from #953" item 5, and the Loops guard of §5 in the what-reaches-the-builder spec. The index's call 1 and
the decision file say how the "unless" of that row is met.
