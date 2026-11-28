# Task 2: a stuck run is restarted once from its handoff

Read the index's Brief and Global Constraints first. Size: Core (recovery). Starts after task 1 has merged. After
it a first stall of an active run restarts it with no card; until task 3 a second stall raises today's Stuck card.

**Files:**

- New `apps/daemon/src/stalls/restart-record.ts`: the `STALL_RESTARTS_KEY` setting and its six functions.
- New `apps/daemon/src/stalls/notices.ts`: the restart's notice.
- `apps/daemon/src/runner/runner.ts`: `'stalled'` in `StopReason`; `Runner.restartStalled`; `clearRestart` where
  a finished step resets `recoveryAttempts` (the `progressed` patch). Adding `'stalled'` touches each place that
  reads a stop reason: the reading's abort (`ctl.stopReason !== 'paused'`), the three gate and check aborts that
  test `'cancelled' || 'shutdown'` (add `'stalled'`), the `outcome.kind === 'stopped'` handling that requeues or
  parks, the three `!== 'shutdown'` base-update branches, and `stop()`'s own `reason !== 'paused'` branch. Check
  every one; a `stalled` stop must end the session and the gate and write no workstream state.
- `apps/daemon/src/stalls/sweep.ts`: the in-flight set, the call to `stallMove`, new deps `restart` (the runner's
  `restartStalled`), `isRunning`, `maxRecoveryAttempts`.
- `apps/daemon/src/daemon/start.ts`: pass those deps; subscribe `forgetEndedRestarts` where `forgetEndedPairs` is.
- `apps/daemon/src/stalls/restart.test.ts` (new) on `createTestEngine`. `apps/daemon/src/stalls/AGENTS.md`: the
  sweep now writes a restart as well as cards; `apps/daemon/src/runner/AGENTS.md`: `stalled`.

**Implements:** the `restart-record.ts` block, `StopReason`, `Runner.restartStalled`. **Calls:** `stallMove`,
`STALL_STOP_DEADLINE_MS`, `StallFault` (task 1); `isRuleAsking`, `postNotice`, `freshAction`, `Runner.isRunning`.

**`restartStalled(id, opts)`.**

- A live lane: set `stopReason = 'stalled'`, abort the session and the gate as a cancel does, and race the lane's
  end against `opts.deadlineMs ?? STALL_STOP_DEADLINE_MS` on the injected clock. The lane's own ending writes
  nothing for `stalled`.
- In time: one write under the row's fence. If the row is no longer Starting, Running or Verifying (it finished
  while stopping), answer `not_active` and write nothing. Else requeue it as recovery does, `nextAction:
  freshAction(tx, id)` (which is `continue_from_handoff` when a handoff exists), `recoveryAttempts + 1`, claims
  untouched, then `recordRestart` and the notice in the same write. Answer `restarted`.
- Deadline passed: answer `stop_hung` and write nothing here; the sweep's write marks it. A stop that finishes
  later still writes nothing, so the row stays Running with no live lane. The Stall card's answers (task 3) act on
  that row through the next case.
- No live lane (`isRunning` false): the same fenced write, moving Running → Recovering → Queued.
- `opts.note` is carried into the next brief the way `retryWorkstream`'s note is.

**The sweep.** For each stall, before `flagCard`: `stallMove` with `asking` from `isRuleAsking(db, projectId,
DecisionRule.StuckRun)`, `inFlight` from the set, `restarted`/`stopHung` from `readRestart`, `recoveryLeft` from
the row, and `fault`: `NeverStarted` when the state is Starting, `GatePastLimit` when the stall's gate is past
its timeout, `NoLane` when `isRunning` is false, else null.

- `card`, and until task 3 `out_of_moves`: today's path, unchanged.
- `wait`: no card, and an open Stuck card for the key is kept (add the key to `unknown`).
- `restart`: add the id to `inFlight`, call `restart(id)` without awaiting the sweep on it, remove the id in its
  `finally`. On `stop_hung`, one write calls `markHung` and raises today's Stuck card (task 3 makes it the Stall
  card). A rejection is logged and ends the same way as `stop_hung`: every stall ends in a notice or a card.
- The set is in memory. A daemon restart during a stop is left to startup recovery; no record exists yet at that
  point, so the one restart is not spent.

**The notice.** `tier: CardTier.Notice`, on the run's task, key `stall-restart:<workstream id>`, `decision: { by:
Rule, rule: StuckRun, confidence: null, undo: { state: 'final', reason: 'The stopped session can’t be brought
back; cancel the run if you don’t want it.' } }`.

- Line: `Restarted "<title>" after it showed no activity`.
- Body: the state it was in, since when (a fixed time, as the Stuck card writes it), whether it continues from a
  handoff or starts the step again, and that its claims and committed work are kept.

**State-table rows:** the three `restart` rows, "The restarted step finishes", "The run moves, or ends" (the
record only), "The daemon restarts during a stop".

**Tests.** One file, three cases, on `createTestEngine` with the fake adapter and the injected clock:

- (a) A run with a handoff whose session goes silent past `STALL.activeIdleMs`: after the sweep it is Queued with
  `continue_from_handoff`, its claims are still active, one notice with rule `stuck-run` is posted, no Inbox
  item exists, and a second sweep while the stop is pending makes no second `restartStalled` call.
- (b) A session whose stop never returns: after the deadline the run is not requeued and a card is open.
- (c) A run that reaches a terminal state before the fenced write: not requeued, no notice, no attempt charged.

Show (a) red with the sweep's `restart` branch removed, (b) red with the deadline ignored.

`Value: protects=a silent run restarting once from its handoff with its claims, and a hung stop reaching the
builder; fails_when=a stalled run is requeued twice, loses its claims, is requeued after it finished, or a hung
stop leaves neither notice nor card; why_new=recovery; no_claim=the defect task or the Stall card's answers`.

**Spec:** the "Stuck run" row of "3. The decision-rights table" and the Loops guard of "5. How self-healing fails,
and its guards" in the what-reaches-the-builder spec; "3.2" item 5 in the inbox-cards spec.
