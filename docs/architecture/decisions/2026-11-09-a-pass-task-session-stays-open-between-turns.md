# A pass task's session stays open between turns; the end of a turn is not the end of a step

- **Date:** 2026-11-09
- **Amends:** `decisions/2026-11-08-a-handoff-that-names-work-left-stands.md`

## Decision

For a lane of a task a Workbench pass holds, a turn completing records no `step_done`, stops nothing and never
enters verify, the uncommitted-work Send Back or the background hold (`runner/pass-turn.ts`). If a message the
session was handed has not been taken, the turn is not over and the next completion decides. Otherwise the turn
ends in one function every ending runs (`endTurnSteps`: `ready`, `stopped` or `failed`): its end and the agent's
reply in one write, its page work kept (`keepTurnWork`), then one write that settles it. The session stays open
and the next builder message goes into it; a warm session closes after ten idle minutes
(`RunnerLimits.warmIdleMs`) or yields its lane to work with no room, and the next message resumes it. A message
to a warm session with no turn open while Your folder is off the pass's branch is held, not refused: the session
closes, the message waits untaken with the pass's folder card, and the page goes on by itself once the folder is
back, so no turn runs on a branch the builder switched to and the builder's words are not lost.

A handoff asked of a pass lane between turns closes the session and sends nothing; a working one is nudged as any
lane is, and a run of handoffs nobody asked for is keyed by the task's kept commit. A pass lane never goes
`FAILED`: a turn that cannot go on ends `failed`, keeps its work and claims, and waits on a "Turn failed" flag
whose Retry Turn starts a new turn from the failed turn's message. A stop (`Runner.stopPassLane`) ends the turn
`stopped` and queues the page to resume that session, raising no Ready.

Built in slice 5: the turn, the stop, the idle close, the yield, the handoff rules, Retry Turn (resuming the failed
turn's session, else a fresh one from the thread's digest) and recovery. Lane sessions taking pictures are
designed (Workbench spec §10).

## Why

A page is looked at and answered many times; starting a session per message would lose the agent's context
each time and spend tokens rebuilding it. A turn's end is where the builder looks, not where a plan's step is
done, so the step machinery (verify, the gate, Send Back's attempts) would fail a pass on its third turn.
Closing between turns instead of nudging keeps a handoff from making a turn nobody wrote.

Turned down: ending the session at each Ready, which costs the context; a grace period before Ready for a
message on its way, replaced by reading the turn's own result frame (Workbench plan, coordinator's verdict).
