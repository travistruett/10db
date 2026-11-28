# Task 2: the daily ceiling

Read the index's Brief and Global Constraints first. Size: Core (money; the scheduler and the runner). Builds on
task 1's marks and `selfStartedToday`. Covers tsk_01a21f6d-42eb: a gate fix task is `selfStarted`, so it counts.

**Files:**

- `packages/contracts`: `autoCeilingUsd`, `autoCeilingShare`, `autoCeilingSessions` on the project's DTO, input and
  patch (beside `budgetCeiling`); `QueueWaitKind.Ceiling`; `AutoCeilingTodayDto`. Additive only.
- New `apps/daemon/src/accounts/auto-ceiling.ts` and its test; `scheduler/queue-waits.ts`; `scheduler/scheduler.ts`
  (beside the account checks, lines 613-638); `runner/runner.ts` (before the `blocked` check near line 6114).
- New `apps/daemon/src/inbox/auto-ceiling-card.ts`, its answer wired where `createAccountCardAnswers` is;
  `apps/daemon/src/api/app.ts`: `GET /projects/:id/auto-ceiling` (the day's sums and the measure in use).
- `apps/desktop/src/views/settings/project-billing.tsx`; the `AGENTS.md` of `accounts` and `inbox`; the decision file
(`decisions/2026-11-28-10dbs-own-work-has-a-daily-ceiling.md`, which already holds how an unpriced metered session
is counted; keep that section and add the rest).

**Implements**, exactly: `CeilingMeasure`, `autoCeilingDayKey`, `AutoCeilingDay`, `ceilingStatus`, `isChecked`,
`queueWait.ceiling`, `AutoCeilingChoice`, `autoCeilingFoldKey`.

**State-table rows:** the marker table, the order of `ceilingStatus`, and the three "where it is met" rows. The
scheduler never launches a checked run at the ceiling, so the runner's check is reached only when the ceiling is
passed mid-run; it calls `requeue` once and the scheduler holds the Queued run. No loop.

**The card.** `InboxKind.Flag`, `decidedByBuilder(BuilderOwns.Money)`, raised by the scheduler when it finds a
checked run waiting and no open card has the fold key. Title: "<Project>'s own work reached today's ceiling"; on
the project's fallback account, "<Account> has spent $N today: carry on or wait for the plan". Body: the measure
passed in words ("$10.40 of $10", "11% of the plan's limit", "20 sessions that could not be measured"), the runs
waiting by task title, and, for a builder run whose 10db re-run waits, "Retry starts it now".

- Carry On Today: writes `{ day, carryOns + 1 }` and requests a scheduler tick. A setting of another day reads as
  `{ today, 0 }`.
- Wait Until Tomorrow: closes the card. The fold key is unchanged that day, so the tick raises no second card:
  it skips a fold key whose card was answered.

**Settings.** Three number fields under Billing with a hint each, and today's line: "$x · y% of the plan's limit ·
n sessions not measured", then the measure the project's account uses and the Known limit's sentence. It says "the
plan's limit", not "the weekly limit": one day's sum can mix limits. "Not measured" covers a plan session that
reported no share and a metered session that used tokens but has no cost (a model its list gives no price, or a
Codex report of $0); the hint under the sessions field says so, and the sessions ceiling counts both.

**Tests.** One pure `it.each` on `ceilingStatus` (each measure alone, the order, a Carry On raising all three). One
through `createTestEngine`: at the ceiling a 10db-filed run waits and one card exists; a builder run launches; a
builder run crash-retried once has its re-run counted, then moves to its next step at the ceiling and that step
launches; Carry On Today launches the waiting run; the second ceiling that day raises a second card. Extend
`apps/desktop/e2e/loop.spec.ts` with the Billing fields and today's line.
`Value: protects=10db's own work stops at the project's daily ceiling and the builder's never does; fails_when=a
checked run launches past the ceiling, a builder run waits, or Carry On releases nothing; why_new=money (the spend
brake); no_claim=that the share a plan reports is the session's own`.

**Spec:** "5." (Budget burn), "1." row 1, "10." (The ceiling), "3." row "Account moved to the fallback".
