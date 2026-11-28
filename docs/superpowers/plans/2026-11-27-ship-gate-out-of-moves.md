# A failing ship gate is worked by 10db; the builder hears once, when it is out of moves

Size: Core (git merges, recovery, the pull request watch). Four tasks, built in order 1 → 2 → 3 → 4, each after
its predecessor has merged. Stage 4 of `docs/superpowers/specs/2026-11-27-what-reaches-the-builder-design.md`;
it builds stage F1 of `docs/superpowers/specs/2026-11-27-inbox-cards-that-mean-something-design.md`.
Status: designed, not built. This pull request holds the plan only.

## Brief

**What changes for the builder.** A ship gate that fails no longer raises a card with Retry and Abandon.

- A failure only in tests the batch did not change is run again once, as today, with no card.
- A failure in the batch's own files files a fix task in the batch and reopens it. The batch ships itself when the
  fix is done. No card.
- 10db stops when the batch's fix tasks are used up (3, `FIX_ATTEMPT_LIMIT`), when the same tests fail again after
  a fix, or when the gate fails twice outside the batch. Then one card, "Out of moves", asks: Spend More Attempts,
  Change the Task, or Drop It.
- The same card ends a run that used up its retries or its recovery attempts, and a pull request whose CI fixes are
  used up. The CI card waits 30 minutes first; until then the task shows a notice.

**What it buys.** Starting a fix can be undone, so 10db does it without asking (6 gate cards in the spec's 7-day
count). The one card left asks a question only the builder can answer.

**What could go wrong, and how we'd know.**

- A fix loop. Bounded three ways: the count, the signature, and the batch's own tasks' retry limits. The Activity
  panel shows each fix task filed; more than 3 for one batch without a card is the bug.
- A fix task for a failure the batch did not cause. The outside check runs first and never files one; the card for
  it says so, and its Spend More Attempts starts a fix in the batch anyway.
- A signature that calls two different failures the same costs one early card, never a loop.

**Calls the builder might disagree with.**

1. The gate budget is per batch: up to 3 fix tasks, each with its own run attempts. Spec §5 gives no move a budget
   of its own, and #953 counts fixes against the project's attempts.
2. A CI-fix batch gets that gate budget beside `maxCiFixes`.
3. The signature is the failing steps and tests, without the error's first line (spec §5 names it): error lines
   carry timings and paths. The decision file records it.
4. On a run that used up its retries, the out-of-moves answers replace Ship Anyway on the card. The task's drawer
   keeps it.

**Known limit.** A Workbench pass's batch and a batch in a separate local copy get no automatic fix and keep today's
gate card. A follow-up task closes it.

**Needed from the builder:** nothing.

## Global Constraints

- `.claude/rules/code-style.md` and `.claude/rules/testing.md`. No migration and no contract removed: state lives
  in `app_settings`, read through zod, with keys only from the exported builders below.
- One write per move: the batch's transition, the fix task, the count and the card's withdrawal commit together.
- A stop has its card or its pending notice, never neither (`apps/daemon/src/inbox/AGENTS.md` is updated in task 4).
- Every out-of-moves card declares `decidedByBuilder(BuilderOwns.OutOfMoves)` and has `options`, no
  `detail.actions`.
- Labels are Title Case; bodies are sentence case and name the count in words the builder reads.
- The departure from spec §5 (calls 1 and 3) is recorded in
  `docs/architecture/decisions/2026-11-27-a-failing-ship-gate-is-fixed-by-10db-until-it-is-out-of-moves.md`.

## Provider parity

The rules, counts, settings and cards are 10db's own and the same on a Claude plan, Claude through Bedrock or an
API key, and a ChatGPT/Codex plan. A fix task is planned with `planForStart` and runs on the project's account, as
a CI fix does. Nothing here asks the judge.

## Interfaces

```ts
// apps/daemon/src/delivery/context.ts
export interface DeliveryLimits {
  /* existing fields */
  /** The most fix tasks 10db files for one batch's failing ship gate before it asks. */
  readonly maxFixAttempts: number;
}
// DEFAULT_DELIVERY_LIMITS.maxFixAttempts = FIX_ATTEMPT_LIMIT (from @10db/contracts), as runner.ts does.

// apps/daemon/src/delivery/gate-failure-action.ts
/** Null when neither a step with tests nor a worrying tail line could be read; null equals nothing. */
export function failureSignature(steps: readonly GateStepFailure[], tail: string): string | null;

export const OutOfMovesReason = {
  Budget: 'budget',
  SameFailure: 'same_failure',
  OutsideTwice: 'outside_twice',
} as const;

export type GateFailureAction =
  | { readonly kind: 'rerun' }
  | { readonly kind: 'legacy_card' }
  | { readonly kind: 'fix' }
  | { readonly kind: 'out_of_moves'; readonly reason: OutOfMovesReason };

export function gateFailureAction(input: {
  readonly outside: boolean; // outsideTheBatch(...)
  readonly reran: boolean; // this ship attempt already ran the gate a second time
  readonly eligible: boolean; // not a pass batch, not a local-copy batch
  readonly signature: string | null;
  readonly fix: GateFix;
}): GateFailureAction;

// apps/daemon/src/delivery/gate-fix.ts
export const gateFixKey = (batchId: BatchId): string => `gate_fix.${batchId}`;
export const GateFix = z.object({
  count: z.number().int().nonnegative(), // fix tasks filed for this batch's gate
  allowed: z.number().int().nonnegative(),
  signature: z.string().nullable(), // the failure the last fix task was filed for
  forceInside: z.boolean(), // the builder asked for a fix of an outside failure
});
export function readGateFix(db: DbReader, batchId: BatchId, maxFixAttempts: number): GateFix;
export function recordFix(w: WriteContext, batchId: BatchId, signature: string | null, max: number): void;
export function grantMore(w: WriteContext, batchId: BatchId, max: number, forceInside: boolean): void;
export function clearGateFix(w: WriteContext, batchId: BatchId): void;

// apps/daemon/src/inbox/out-of-moves-card.ts
export const OUT_OF_MOVES_DETAIL = 'outOfMoves';
export const OutOfMovesChoice = {
  More: 'Spend More Attempts',
  Change: 'Change the Task',
  Drop: 'Drop It',
} as const;
export const OutOfMovesKind = { Gate: 'gate', Run: 'run', Recovery: 'recovery', Ci: 'ci' } as const;
export function outOfMovesFields(input: {
  readonly kind: OutOfMovesKind;
  readonly more: number; // N in "Spend N more attempts"
  readonly batchId: BatchId | null;
  readonly workstreamId: WorkstreamId | null;
}): { options: InboxOption[]; detail: Record<string, Json> };
export function createOutOfMovesAnswers(deps: OutOfMovesMoves): (item: InboxItemDto, answer: InboxAnswer) => void;

// apps/daemon/src/delivery/ci-stop.ts
export const ciOutOfMovesKey = (rootId: BatchId): string => `ci_out_of_moves.${rootId}`;
export const CI_OUT_OF_MOVES_AFTER_MS = 30 * 60_000;

// apps/daemon/src/delivery/ci-failure-action.ts: one more argument
export function ciFailureAction(root, required, fixes, head, ignoreFixesBefore: string | null): CiFailureAction;

// apps/daemon/src/github/gh.ts, and its fake
closePullRequest(input: { repo: string; number: number }, call: GhCall): Promise<void>;
```

## State table (design, not a test list)

`gateFailureAction` checks in this order; the first row that matches wins.

| #   | Case                                                | Result                             |
| --- | --------------------------------------------------- | ---------------------------------- |
| 1   | `outside && !reran`                                 | `rerun` (today's second gate run)  |
| 2   | `!eligible`                                         | `legacy_card` (today's two cards)  |
| 3   | `outside && reran && !fix.forceInside`              | `out_of_moves`, `outside_twice`    |
| 4   | `fix.signature !== null && fix.signature === signature` | `out_of_moves`, `same_failure` |
| 5   | `fix.count >= fix.allowed`                          | `out_of_moves`, `budget`           |
| 6   | otherwise                                           | `fix`                              |

| Batch                                   | Eligible | Why                                                                |
| --------------------------------------- | -------- | ------------------------------------------------------------------ |
| A Workbench pass's (`passId != null`)   | no       | `checkBatch` never ships it again by itself                        |
| In a separate local copy                | no       | a reopened batch would lose the landing `failWith` must report     |
| A CI-fix batch (`ciFixOf != null`)      | yes      | its own count, beside `maxCiFixes`                                 |
| Shipping on the pre-check               | yes      | the same setting; the texts say "pre-check"                        |
| Any other                               | yes      |                                                                    |

| Out-of-moves card  | N (More)              | More                                                          | Change the Task (needs a note)             | Drop It                                         |
| ------------------ | --------------------- | ------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------- |
| Gate               | `maxFixAttempts`      | `grantMore`, then the shipper's retry                         | a fix task carrying the note, not counted  | `Shipper.abandon`                               |
| Run, retries spent | `maxFixAttempts`      | `retryWorkstream`                                             | `retryWorkstream` with the note            | in a batch: Ship Without It; alone: cancel it   |
| Recovery           | `maxRecoveryAttempts` | `retryWorkstream`                                             | `retryWorkstream` with the note            | as a run                                        |
| CI                 | `maxCiFixes`          | `ignoreFixesBefore = now`, lift the stop, rerun failed jobs   | the same, and the next fix carries the note | close the pull request; its fix batches end     |

Other rows: a gate that times out, a conflicted base, a broken install and lost migrations keep their cards. A
flaky pass (`rerunFlaky`) ships as today. `CiStopped.NoLog` and `NoCut` keep today's immediate card.

## Tracks and tasks

One track; each task is one pull request and a fresh implementer.

1. `task-1.md`: the rule and its state. `gateFailureAction`, `failureSignature`, the `gate_fix` setting,
   `DeliveryLimits.maxFixAttempts`. Nothing calls them yet.
2. `task-2.md`: the ship wiring. `sendToFix` files the fix task; out-of-moves still raises today's gate card.
3. `task-3.md`: the out-of-moves card and its answers, for the gate, a run out of retries and recovery.
4. `task-4.md`: the CI path: the 30-minute window, the card, More and Drop, `closePullRequest`.

Follow-ups filed with this plan: a gate fix for pass and local-copy batches; the error line in the signature once
it can be normalised; the daily ceiling counting these fix tasks (spec stage 11); a 10db defect filed when one
batch reaches out of moves three times (spec §5); runner patterns beyond vitest for the signature (#953 §5.2).
