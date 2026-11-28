# A claim deadlock breaks itself: the later asker yields, and a repeat queues it

Size: Core (claims). Four tasks, built in order 1 → 2 → 3 → 4, each after its predecessor has merged. Stage 5 of
`docs/superpowers/specs/2026-11-27-what-reaches-the-builder-design.md` (§9, and the "Claim deadlock" row of §3);
it builds stage F2 of `docs/superpowers/specs/2026-11-27-inbox-cards-that-mean-something-design.md`.
Status: designed, not built. This pull request holds the plan only.

## Brief

**What changes for the builder.** Two tasks that each wait for a claim the other holds no longer raise a card.

- After 2 minutes the task that asked later gives up the claims the other waits for. The other takes them and
  gets the yielder's committed work only; the yielder's uncommitted edits stay in its folder and stay its own.
- A second deadlock between the same two tasks does the same and also queues the yielder: it hands off, and 10db
  starts it again when the other task has finished or no longer holds what they fought over.
- A third files a defect task in 10db's own project, once per pair of claims, and still yields and queues.
- Each yield and each queueing is a row in Activity with Undo. Ask Me Next Time brings back today's card.

**What it buys.** 30 deadlock cards in the spec's 7-day count, every one answered "the later one waits". Two
tasks stop passing one claim back and forth (seen three times in one run).

**What could go wrong, and how we'd know.**

- A queued task that never starts again. Its turn ends when the other task is terminal or holds none of the
  contested claims, and its queue wait counts toward the Stuck card like any other; a `Turn` wait older than the
  other task's run is the bug.
- A claim taken from a task that is working in it. A claim is released only from a task that is told through its
  wait, or taken from one that is Queued with no lease, in the same write that checks both.
- A yield that frees nothing (the waits changed in the 2 minutes). Then nothing is released and the wait goes on.

**Calls the builder might disagree with.**

1. Undo never takes a claim back. On a first yield it forgets the yield, so the next deadlock between the two
   counts as the first; on a queue row it ends the queue, so the yielder may start and ask again now.
2. The third repeat still yields and queues: the defect task is the report, not a stop.
3. A queued task that ignores the handoff instruction and ends its step keeps its gate run; only its next session
   waits.
4. The defect task, in 10db's own project, quotes the other project's two task titles and claim names. Both live
   in the builder's local database only.
5. The pair's state lives in one `app_settings` key, with no migration.

**Needed from the builder:** nothing.

## Global Constraints

- `.claude/rules/code-style.md` and `.claude/rules/testing.md`. No migration. Contract changes are additive: one
  `DecisionRule`, one `UndoAction` kind, one `QueueWaitKind`.
- A claim leaves a task in two ways only: released from a task that is told through its live wait
  (`ClaimWaits.yielded`), or taken from a task that is `Queued` with no lease (task 3). Never otherwise.
- One write per move: the release, the pair's record and the notice commit together.
- No Inbox card on this path while the rule is not set to ask. With `isRuleAsking(db, projectId,
  DecisionRule.ClaimDeadlock)` true, today's card is raised, unchanged.
- The pair's state is read through zod from `CLAIM_DEADLOCKS_KEY` and written only by the functions below.
- Notice lines and bodies are sentence case and name both tasks by title.
- The decision is `docs/architecture/decisions/2026-11-27-a-claim-deadlock-is-broken-by-the-later-asker-yielding.md`.

## Provider parity

The rule, the pair's record, the queue and the notices are 10db's own and the same on a Claude plan, Claude
through Bedrock or an API key, and a ChatGPT/Codex plan. A yield reaches the agent as the result of
`request_claim`, which both adapters serve, and a handoff is asked for through `askedToHandOff`, as today. Nothing
here asks the judge.

## Interfaces

```ts
// packages/contracts/src/activity.ts (additive)
DecisionRule.ClaimDeadlock = 'claim-deadlock'; // name: 'A claim deadlock, ended by the later task yielding'
// UndoAction gains:
z.strictObject({ kind: z.literal('forget_claim_deadlock'), a: WorkstreamId, b: WorkstreamId });

// packages/contracts/src/queue-wait.ts (additive)
QueueWaitKind.Turn = 'turn'; // It gave up a claim to another task twice and waits for that task.

// apps/daemon/src/mcp/claim-deadlock-rule.ts (pure)
export const DEADLOCK_YIELD_AFTER_MS = 2 * 60_000;
export const DeadlockMove = {
  Wait: 'wait', // younger than 2 minutes, or nothing to give up
  Card: 'card', // the rule is set to ask
  Yield: 'yield',
  YieldAndQueue: 'yield_and_queue',
  YieldQueueAndReport: 'yield_queue_and_report',
} as const;
export function deadlockMove(input: {
  readonly asking: boolean; // isRuleAsking
  readonly ageMs: number; // since this wait first found the cycle
  readonly breaks: number; // earlier breaks between this pair
  readonly gives: number; // claimsAwaitedFrom(me, holder).length
}): DeadlockMove;

// apps/daemon/src/mcp/claim-deadlock-pairs.ts
export const CLAIM_DEADLOCKS_KEY = 'claim_deadlocks';
type ClaimRef = { kind: ClaimKind; name: string };
export const DeadlockPair = z.object({
  a: WorkstreamId, // a < b, so a pair has one record
  b: WorkstreamId,
  breaks: z.number().int().nonnegative(),
  contested: z.array(ClaimRef), // every claim either side waited for at a break
  queued: z.object({ yielder: WorkstreamId, behind: WorkstreamId }).nullable(),
  reported: z.boolean(), // a defect task was filed for this pair
});
export function readPair(db: DbReader, x: WorkstreamId, y: WorkstreamId): DeadlockPair | null;
export function recordBreak(
  w: WriteContext,
  input: { yielder: WorkstreamId; other: WorkstreamId; contested: readonly ClaimRef[]; queue: boolean },
): DeadlockPair;
export function markReported(w: WriteContext, x: WorkstreamId, y: WorkstreamId): void;
/** False when the pair has no record. */
export function dropPair(w: WriteContext, x: WorkstreamId, y: WorkstreamId): boolean;
/** The task `id` is queued behind, or null. Ends the turn (nulls `queued`) only through `endTurn`. */
export function queuedBehind(db: DbReader, id: WorkstreamId): WorkstreamId | null;
export function turnOver(db: DbReader, pair: DeadlockPair): boolean; // other terminal, or holds none of contested
export function endTurn(w: WriteContext, pair: DeadlockPair): void;
/** Drops the records of pairs with a terminal task; called where `forgetEndedYields` listens. */
export function forgetEndedPairs(w: WriteContext): void;

// apps/daemon/src/mcp/claim-wait.ts
export interface Yielded {
  readonly claims: readonly ClaimRef[];
  readonly inboxId: InboxItemId | null; // null: the rule yielded, no card
  readonly to: WorkstreamId | null; // the task the claims went to, for the wording
  readonly queued: boolean;
}
// ClaimResult's refusal gains `readonly queued: boolean`.
// Asking gains `readonly now: () => number` (production default Date.now) and
// `reportRepeat(pair: DeadlockPair): void` (task 4; a no-op until then).

// apps/daemon/src/defects/file-defect.ts (task 4)
export function fileDefect(
  w: WriteContext,
  input: { signature: string; title: string; description: string },
): TaskId | null; // null: no 10db project on this Mac, or an open task already carries the signature
```

## State table (design, not a test list)

`deadlockMove` checks in this order; the first row that matches wins.

| #   | Case                         | Move                     |
| --- | ---------------------------- | ------------------------ |
| 1   | `asking`                     | `card` (today's card)    |
| 2   | `ageMs < 2 min` or `gives=0` | `wait`                   |
| 3   | `breaks = 0`                 | `yield`                  |
| 4   | `breaks = 1`                 | `yield_and_queue`        |
| 5   | `breaks >= 2`                | `yield_queue_and_report` |

| Event                                                    | What 10db does                                                                                                                                              |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A wait finds the cycle (it is the later asker)           | No card. The wait remembers `deadlockSince`; its notice says it waits. The cycle gone before 2 minutes: cleared, a plain wait.                              |
| `yield`                                                  | One write: release `claimsAwaitedFrom(me, holder)` from me, `recordBreak`, a notice with Undo. `waits.yielded(me, …)` ends my waits with the yield refusal. |
| `yield_and_queue`                                        | The same with `queue: true`; the refusal is the queued wording and `askedToHandOff` is called.                                                              |
| A queued task calls `request_claim`                      | Answered at once with the queued refusal.                                                                                                                   |
| A queued task's session ends by handoff                  | `QUEUED`, lease cleared, `continue_from_handoff` kept, the claims it still holds kept.                                                                      |
| A queued task ends its step instead                      | Its gate runs as usual; its next session start is passed over with `Turn`.                                                                                  |
| The other task asks for a claim the queued task holds    | Taken in one write if the record says queued, the holder is `Queued` and has no lease; else a plain wait.                                                   |
| The other is terminal, or holds none of `contested`      | `endTurn`: `queued` nulled, `breaks` kept. The yielder launches from its handoff.                                                                           |
| `yield_queue_and_report`                                 | As `yield_and_queue`, and `fileDefect` once per pair; no 10db project: the report is in the notice body.                                                    |
| Undo on a row                                            | `dropPair`. `ConflictError` when the record is gone. No claim moves.                                                                                        |
| A cycle of three or more                                 | `breaks`, `queued` and `contested` are keyed on (me, the direct holder) only; `claimsAwaitedFrom` still releases what the whole chain waits for.            |
| Either task of a pair reaches a terminal state           | `forgetEndedPairs` drops the record.                                                                                                                        |

## Tracks and tasks

One track; each task is one pull request and a fresh implementer.

1. `task-1.md`: the rule and the pair's record. `deadlockMove`, the `claim_deadlocks` setting, the contract
   additions. Nothing calls them yet.
2. `task-2.md`: the automatic yield. The 2-minute clock in the wait, the release, the notice with Undo.
3. `task-3.md`: the queue. The queued refusal, the handoff, the loop-top requeue, the `Turn` wait, taking a queued
   task's claim.
4. `task-4.md`: the defect task on the third repeat.

Follow-ups, filed when they are met: the daily ceiling counting nothing here (no work is started); the rule
switched to asking after two undos (spec stage 11) reads `DecisionRule.ClaimDeadlock` with no change here.
