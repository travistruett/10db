# Task 1: mark and measure 10db's own work

Read the index's Brief and Global Constraints first. Size: Core (money; a migration). Nothing reads the marks or
the sums until task 2, so behavior does not change.

**First, a check.** Read the Claude Agent SDK's type for `rate_limit_event` and Codex's `RateLimitSnapshot`
(`sessions/codex-generated/ts/v2/`), and write what each plan reports into `apps/daemon/src/accounts/AGENTS.md`.
The daemon's logs are outside a lane's sandbox, so how often a Claude Max plan reports stays "not verified".

**Files:** `packages/db` (the seven columns in one migration, generated last; `insertWorkstream` and
`insertSession` take `selfStarted`); `docs/architecture/db-storage.md`; new
`apps/daemon/src/accounts/limit-share.ts` and its test; `packages/db/src/store/usage.ts`; the marker sites below;
`apps/daemon/src/runner/runner.ts` at `insertSession` (near line 3903) and the `rate_limit` case (near 4779).

**Implements**, exactly: `limitShare`, `ceilingLimit`, `UNNAMED_LIMIT`, `LimitShareState`, `selfStartedToday`.

**Marker sites.** Confirm each by reading it; typecheck finds every `insertWorkstream` caller.

| Site                                                                                        | Write               |
| ------------------------------------------------------------------------------------------- | ------------------- |
| `delivery/ship.ts` (the gate fix task, near 749); `delivery/ci-fix.ts` (near 182)           | `selfStarted: true` |
| A start nobody asked for (the skip follow-up starter in `daemon/start.ts`)                  | `selfStarted: true` |
| A start from the API, the builder's tools or a card's answer (sign-in setup, a shape)       | false               |
| Crash retry (`runner.ts` near 2794), `requeueStalled` (near 6331), `recovery/recover.ts` (near 190) | `autoRerun: true` |
| `retryWorkstream` and the builder's start of an existing run                                | `autoRerun: false`  |

**The measure.** `limitShare` keeps, per limit type, the last utilization and the rise: null after one report;
then each report adds `u - last`, or `u` when `u < last` (a reset). A null type is `UNNAMED_LIMIT`; a null
utilization changes nothing. The runner holds the state per session and at each report writes
`sessions.limit_share`, the rise of `ceilingLimit(types heard)`. `selfStartedToday` sums the `self_started`
sessions whose workstream is the project's and whose `started_at` is in the day. Where the session's account
`isMetered`, a session with a cost above zero adds it to `usd`; a session that used tokens (input, output or cached,
any above zero) and has no cost (null or 0) adds one to `unmeasured` instead, and one with neither adds nothing.
That is the OpenRouter session on a model its list gives no price (`priceSessionAtListing` leaves its cost as it
was) and a Codex session that reports `costUsd: 0`: without this they would add to no measure and the ceiling
would never stop them. Where the account is not metered, `share` and `unmeasured` (a null share) are summed as
before and `usd` never is. `unmeasured` therefore means "sessions with nothing to measure them by", and it is the
sessions ceiling's count on every kind of account. One day's share can mix limits (one session heard the weekly
limit, another only the five-hour one): it errs toward stopping early.

**Tests.** One pure `it.each` on `limitShare` and `ceilingLimit`: a rise, a reset, weekly over five-hour, the
unnamed limit used only alone, one report gives null. One on real SQLite for `selfStartedToday`: of a counted and a
builder session in one project and day only the first is summed, yesterday's is left out, a ChatGPT plan's
dollars are not summed, and a metered session with tokens and no cost (null or 0) adds one to `unmeasured` while a
priced one adds its dollars and a metered one with no tokens adds nothing. Show each red first.
`Value: protects=which sessions count against a project's daily ceiling and what each measures; fails_when=builder
work is counted, a reset loses use, a plan's dollars are summed, or an unpriced metered session counts nowhere;
why_new=money (a pure measure and its query);
no_claim=that every site carries the mark, or the ceiling itself`.

**Spec:** "5. How self-healing fails, and its guards" (Budget burn) and "10. Per provider" (The ceiling).
