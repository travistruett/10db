# Task 3: a repeat queues the yielder behind the other task

Read the index's Brief and Global Constraints first. Size: Core (claims, the lane loop, the scheduler).

**Files:**

- `apps/daemon/src/mcp/claim-wait.ts`: the queue moves; the queued wording of `yieldRefusal`; taking a queued
  task's claim.
- `apps/daemon/src/mcp/tools.ts`: `askedToHandOff` for a queued refusal; a queued task's `request_claim`.
- `apps/daemon/src/runner/runner.ts`: the loop-top requeue.
- `apps/daemon/src/scheduler/scheduler.ts`, `apps/daemon/src/scheduler/queue-waits.ts`: `turnBehind` and the
  `Turn` wait.
- `apps/daemon/src/stalls/thresholds.ts`: `Turn` is not in `UNCOUNTED_WAITS`, so a turn that never ends reaches
  the Stuck card by time. Say so in the comment there.
- `apps/daemon/src/daemon/start.ts`: wiring only, if any is needed.
- `apps/daemon/src/mcp/AGENTS.md`, `apps/daemon/src/runner/AGENTS.md`.
- Tests: the runner's engine test file and `apps/daemon/src/mcp/mcp.test.ts`.

**Calls**, exactly: `recordBreak(…, queue: true)`, `readPair`, `queuedBehind`, `turnOver`, `endTurn`, `dropPair`
(task 1); `requeue(id, ctl, pausedFor, queuedFor)` and `deps.askedToHandOff(sessionId)` (existing).

**The queue moves.** `yield_and_queue` and `yield_queue_and_report` do task 2's write with `queue: true` and
`waits.yielded(…, queued: true)`. The notice body ends "Undo ends the queue: "<yielder>" may start and ask again
now." (`a.reportRepeat(pair)` is called for the report move; it does nothing until task 4.)

**The queued refusal** (`queued: true` on the result): "You gave up <claims> to task "<title>" and are queued
behind it. Commit what you changed in the claims you still hold. Your uncommitted edits in <given-up claims> stay
in your folder and stay yours; do not commit them. Call write_handoff naming what is left, then end your turn.
10db starts you again when that task finishes."

- `tools.ts` calls `deps.askedToHandOff(sessionId)` for a refusal with `queued: true` in both places a yield
  refusal is answered: where a settled wait's refusal is returned, and where a pending yield answers a new call.
- A `request_claim` by a task for which `queuedBehind` is not null answers the queued refusal at once, without
  waiting.
- Check that the edits left under the given-up claim are not judged "uncommitted work in your claims" when the
  handoff is accepted. If they are, leave them out there, as `handOver` records them.

**The loop-top requeue** (`runner.ts`, the lane loop, after the stop and `verifying` branches and before the
account check):

```ts
const behind = queuedBehind(db, id);
if (behind !== null) {
  requeue(id, ctl, `queued behind ${taskTitleOf(db, behind)}`, 'waits its turn');
  return;
}
```

- A handoff `continue`s to the loop top, so no fresh session starts. `requeue` goes `PausedLimit → Queued` and
  clears the lease in one write and patches no `nextAction`, so `continue_from_handoff` is kept. Confirm which
  state the row is in at the loop top after a handoff; `packages/contracts/src/workflow.ts` allows `PausedLimit`
  from `Starting`, `Running` and `HandingOff`. Add an edge only if the row is in none of them.
- A task that ends its step instead keeps its gate; the same check and the scheduler stop its next session.
- The check also runs on a lane's first pass after launch. That cannot loop: `turnBehind` and this check read the
  same record through `queuedBehind`, so a task this check would requeue is never launched.

**The scheduler.** In `launchQueued`, beside the claim check: `turnBehind(row)` passes a row over with
`QueueWaitKind.Turn`, line `Waits its turn behind "<title>", which it deadlocked with twice`, `on` the other task,
`endless: false`. When the pair's `turnOver` is true it calls `endTurn` in the tick's write and launches the row.

**Taking a queued task's claim.** The other task asks for a claim the queued task still holds. In `tryAcquire`'s
conflict path, in ONE `state.write`, take it only if all three hold:

1. the pair's record reads `queued = { yielder: holder, behind: me }`;
2. the holder's row is `Queued`;
3. its `leaseOwner` is null.

Then release the holder's claim, acquire it for me, add it to `contested`, and `handOver(holder)` after the write
records the holder's uncommitted edits as its own. Any one false: a plain wait. Record `waits.yielded(holder, …)`
so the holder's next `request_claim` is told; its next brief lists its claims from the database.

Why one write closes the race: the `Turn` gate, the loop-top requeue and Undo's `dropPair` read or write the same
record and row in one SQLite database with serial writes, and a launch takes the lease in its own write. Either
the take commits first and the launch finds the claim gone (the scheduler's claim conflict, today's `Claim` queue
wait), or the launch commits first and nothing is taken. Claims never lapse by themselves (`activeHolder` filters
on `releasedAt` only), so without this take the other task would wait on a task that cannot run.

**State-table rows:** `yield_and_queue`, "A queued task calls `request_claim`", "A queued task's session ends by
handoff", "A queued task ends its step instead", "The other task asks for a claim the queued task holds", "The
other is terminal, or holds none of `contested`", "Undo on a row" (the queue's part).

**Tests (two, both extended where a deadlock test exists).**

- `createTestEngine`, two real lanes: the second deadlock's yielder writes a handoff through the real runner.
  Assert its row is `Queued`, its queue wait is `Turn`, and no new session row exists; end the other task; assert
  the yielder launches with `continue_from_handoff`. No row is inserted as `QUEUED`. Red first without the
  loop-top check.
- In task 2's `mcp.test.ts` test: the other task's ask for a claim the yielder holds waits while the yielder's row
  has a lease and takes it once the row is `Queued` with none; Undo drops the queue.

`Value: protects=a twice-deadlocked task staying queued until the other is done, and its claims being taken only
while it cannot run; fails_when=the yielder starts a new session and deadlocks again, never starts again, or loses
a claim while it holds a lease; why_new=claims; no_claim=the defect task, or a cycle of three`.

**Spec:** the same sections as task 2.
