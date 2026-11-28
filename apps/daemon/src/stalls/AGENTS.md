# apps/daemon/src/stalls

The watchdog (`decisions/2026-11-25-queue-waits-live-in-the-scheduler.md`).

- `thresholds.ts` holds every threshold (`STALL`) and the queued waits that never count by time
  (`UNCOUNTED_WAITS`, which includes a claim or dependency wait that can still end: waiting one's turn behind
  live work is not stuck, `decisions/2026-11-26-a-run-waiting-its-turn-behind-live-work-is-not-stuck.md`).
  Change them there only.
- `rules.ts` is pure: `findStalls` reads the queued runs with their waits, the active runs, the open, shipping
  and cutting batches with the latest run of each of their tasks, and the `since` of each open card. A batch
  stall replaces its members' run stalls. Its test is the rule table.
- `restart-rule.ts` is pure: `stallMove` says what to do about a stall, in order: the Stuck card (the rule is set to
  ask, or the stall is not an active run's), wait (a restart of the run is in flight), restart (never restarted,
  stop not hung, recovery attempts left), else out of moves, filing a defect only when a `StallFault` is set. Its
  test is the rule table.
- `sweep.ts` reads the active projects every minute (`STALL.sweepMs`, on the injected clock) and writes only
  Stuck cards: one `flagCard` refresh per stall whose card is missing or says something else
  (`fingerprint`), then `resolveStaleCards` for the `stall_cleared` cards whose stall is gone. A queued run with
  no wait yet (the first tick after a start has not run) is skipped, and its card, and its batch's, kept.
- Silence is counted from `countFrom` at the earliest: the later of the sweep's creation (the daemon's start,
  so a resumed run is not blamed for the time the daemon was down) and the last sweep that found
  `admission.held()` (load, low disk or an update's drain), so a STARTING run waiting for the hold to clear is
  not flagged the moment its session launches. The lane cap needs no entry: a queued run waiting for a lane is
  an uncounted wait.
- A run with a gate process recorded (`gate_pid`) is not idle while its newest log (`logs/gate/<run id>-*.log`,
  `live-gate.ts`) is still growing: the later of the run's own activity and the log's last write is its
  activity. A gate past its own timeout (`gateTimeoutFor`) no longer counts, so a gate that hangs is still
  stuck; its card says how long the gate wrote for, or its limit, as fixed text (never the time since).
- `card.ts` builds the card (Ask, high, a condition card folded by its key) and its answers. The body names the time
  the item stopped ("since …", in the Mac's own time), never a duration: the card is rewritten only when its
  fingerprint changes, so a duration would go stale. The answers act;
  the sweep never cancels, retries or abandons.
- A stalled active run is restarted instead of carded when `stallMove` says so (`Runner.restartStalled`; the Stuck run
  rule is not set to ask). The sweep calls it without waiting, and keeps any open Stuck card for the run: the runner
  marks the restart in flight before it returns, so the next sweep waits. A stop that outlasts
  `STALL_STOP_DEADLINE_MS` (or a restart that throws) is marked in the record (`markHung`) and raises the Out of
  Moves card in the same write, so every stall ends in a notice or a card.
- `out_of_moves` (`out-of-moves.ts`) raises one Out of Moves card in one write (`stallOutOfMovesCard`, `card.ts`): the
  Stuck card's `detail[STALL_CARD]`, `foldKey` and `stall_cleared` closing, with `OutOfMovesKind.Stall`'s answers.
  When `stallMove` says `fileDefect` (a `StallFault`: never started, no lane, gate past its limit, stop hung) and the
  record has no `defectTaskId`, `fileDefect` files `stall:<fault>:<state>` first and `markDefect` records it; the card
  names that task, or says the report could not be filed (no 10db project, or an open task already has the signature).
  The case (stop hung, stalled again, no attempts left) is read from the record; "what it holds" is fixed text, and
  both are in the fingerprint, so the sweep rewrites the card only when it changes. A fault of `StopHung` wins over
  the others once the record has `stopHungAt`. The card's answers: Spend More Attempts and Change the Task (a note is
  required) call `Runner.restartStalled`, whose write replaces the record; Drop It cancels the run. The inbox hook is
  synchronous, so the card closes with the answer, and a stop that hangs again calls `StallSweep.stopHung`, which marks
  the record and sweeps, raising the card again. `restart-record.ts` holds the per-run record in
  `app_settings` (`stall_restarts`) and `forgetEndedRestarts` drops a terminal run's; `notices.ts` posts the
  restart's notice (rule `stuck-run`, undo `final`). The sweep writes a restart record and a card, never a requeue
  itself: the runner does that, in one write with the record and notice.
