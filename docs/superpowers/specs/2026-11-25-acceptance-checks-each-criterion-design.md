# Acceptance checks each criterion before a run goes on

**Size: Core.** It decides what goes on and what goes back, inside the runner's step-ending write, and it touches
recovery (a fix that resumes its session). Plan review, then an index with cards.

## Brief

**What changes for you.** When a run's gate passes, 10db checks the change against each of the task's acceptance
criteria before the run goes on. A criterion is read as met, not met, or unclear.
- **Not met:** the run goes back to its build session with that criterion's note, for as many rounds as the rigor
  gives review.
- **Unclear, with a Review to follow:** the reviewer gets those criteria to look at.
- **Otherwise the run goes on.** When a criterion is still not met at the last round, or unclear with no Review to
  follow, the run finishes like a reviewer's does at its limit. It leaves one **Acceptance** card listing those
  criteria, with **Accept** and **Send back with a note**. A run never waits on you.

The Board shows three counts per project for the last 7 days: **Completed**, **Sent back** and **Sent to you**.

**What it buys.** A Light task (no Review) is no longer Done just because its gate was green: each criterion was
read against its diff. A Standard or Careful run reaches its reviewer with the clear misses already fixed and the
doubtful criteria named. You see how much the factory finishes without you.

**What could go wrong, and how we'd know.**
- *A miss is waved through.* Only a high-confidence "met" from the cheap call counts, and anything else is asked of
  a stronger model. Acceptance ships switched off. It is turned on only after a replay of past runs passes its bar.
  After that, a task you reopen after Completed shows a miss.
- *Too many send-backs.* Only the stronger model can send a run back, and the replay caps how often it would have
  sent back work the reviewer approved.
- *Too many cards.* Cards come only from Light runs or runs at the round limit. The replay caps the unclear rate,
  and the Sent to you count shows it live.
- *The judge is down.* The run goes on as today, and the existing "10db's judge can't answer" card says so.

**Calls you might disagree with.**
1. Acceptance runs **beside** Review, as you chose. Proposing to drop Review on Light and Standard (one Inbox card
   with the agreement numbers) is milestone 2, after a few weeks of live data.
2. When a Review follows, unclear criteria go **to the reviewer, not to you**.
3. **Nothing waits on you.** At the limit, or unclear with no reviewer, the run ships and leaves one card. Send back
   on that card files a fix task with your note. This follows the rule that a task waiting on the builder is a bug,
   and it matches how the reviewer handles its own limit.
4. "Does it change something the task didn't ask for?" is asked, but it never sends anything back. The reviewer
   sees it, or the card does when there's no reviewer.

**What I need from you.** Nothing. I'll run the replay, build it, and show you the Board counts and the card as
screenshots before switching it on.

---

## Scope

In:
- the acceptance pass after a passing gate;
- the decisions `acceptance` and `acceptance_second`;
- send-back on the rigor's rounds and fix rule, with the fix able to resume its session;
- the `acceptance` Inbox card;
- the Board counts;
- the replay script and its launch bar.

Out:
- milestone 2, the proposal to drop Review;
- Slack routing;
- browser QA and profiling;
- gate-less projects, which already end on a Check card;
- merge-resolution runs and pass pages (any step with `fixedPlan`).

## Where it runs

Acceptance is **not a step role**. A role would add a Playbook row and cell, with a model and persona pick, for
something that has no session. It would also force a `StepResult.sessionId` it doesn't have, and touch every table
that `Object.values(StepRole)` drives.

It is a judge pass like `test_value`, run in `verify` after the gate passes and before the step-ending write
(`runner.ts`, beside `reviewForcedAfter` and `testValueFollowUpsAfter`).

It runs only when all of these hold:
- the gate passed, and the step that ended is an implement step with no implement step after it. Under Commit
  Directly, that means only after the final gate (`implementLeft`);
- no step has `fixedPlan` (merge-resolution runs and pass pages);
- the task has criteria;
- `judge.ready(Acceptance)` is true.

Every fix ends in a gate, so acceptance runs again after each one.

**Two phases, like `test_value`:**
- **Outside the write:** the judge calls. Both get an abort signal tied to the lane's controller, so a cancel stops
  them at once.
- **Inside the step-ending write:** every decision that reads state. That covers:
  - whether a Review follows, from `withSafetyNet(withCurrentPlan(...)).steps`;
  - the round limit and `fixBy`, from `rowProcess` with `ctx.tx`;
  - the fence check, so a run stopped, retried or moved in between drops the result.

  Verdicts are keyed by criterion text, not by position. A criterion the builder edited during the call has no
  verdict, and is treated as unasked (met).

## The questions

The state for both decisions:
- `task`: title, why, description.
- `criteria`: the list.
- `diff`: the run's own work, from `ownWork` and `diffOfRanges` (as `reviewForcedAfter` reads it). This leaves out
  the builder's own commits in a shared checkout, and base merges. It is capped at `ACCEPTANCE_DIFF_CAP` characters.
  Past the cap it sends the changed-file list and the first hunks of each file, with `truncated: true`.
- `gate`: the gate's command and its summary tail.

The questions:
- `met_<n>` for each criterion:
  - instructions: "Does the change meet this acceptance criterion: <criterion>? Read the diff and the gate output.
    A criterion about behavior is met only if the diff makes that behavior happen."
  - criteria: `true` is "The change meets it."; `false` is "The change does not meet it, or only partly."
- `judgeable_<n>` (the second call only, for each criterion it asks): "Do the diff, the gate output and the build's
  report give enough to judge this criterion either way? A criterion about a result 10db didn't see (a CI run, a
  live run, a measurement the report doesn't give) can't be judged; neither can one whose files the diff was cut
  before."
- `unasked`: "Does the change do something the task didn't ask for?"

Reading, at floor f (the decision's floor, clamped to at least 0.5). It lives in `acceptance/read.ts`, a pure rule
table:
- `acceptance` (cheap): `p ≥ f` is met. Anything else goes to `acceptance_second`, for those criteria only.
- `acceptance_second` (strong):
  - `p ≥ f` is met;
  - `p ≤ 1 − f` is not met, but only when `judgeable ≥ f`; otherwise it is unclear, noted "can't be judged from
    the change";
  - anything between is unclear.
- **No answer** (a fallback, the decision switched off, or stopped) from either call leaves the criteria unread.
  Unread criteria don't hold up the run; it goes on as if the judge weren't ready. The first call reports to the
  outage watch as any decision does, so a judge that's down raises the existing card. The second call is
  `secondary`.
- A criterion the builder accepted on an earlier card in this run counts as met from then on.
- `unasked ≥ f` adds a line for the reviewer, or for the card.

Timeouts: `ACCEPTANCE_TIMEOUT_MS` is 20 s and `ACCEPTANCE_SECOND_TIMEOUT_MS` is 60 s. The run waits for them as it
waits for its gate.

**Record:** one `evidence` row of the new `EvidenceKind.Acceptance` per pass. Its summary is readable text, and its
`detail` holds the verdicts by criterion: `{criterion, verdict: met|not_met|unclear|unread, note}`, plus `unasked`.
`EvidenceDto` gains an optional `detail` JSON column. **This is a migration**, generated last per AGENTS.md. The
send-back, the reviewer's brief and the card all read this row.

## What the run does next

Decided inside the write, in this order:
1. **Some criterion is not met and the round limit isn't reached:** send back.
2. **Some criterion is not met at the limit, or some is unclear with no Review following:** go on with `moveAfter`.
   In the same write, raise one `acceptance` card for those criteria.
3. **Otherwise:** go on with `moveAfter`. When a Review follows, the unclear criteria and `unasked` are in the
   Acceptance evidence row, and the first round of the Review reads them into its brief (`runSession`, beside
   `testValueBrief`).

### Send-back

- It goes to the implement step that just ended. The send-back passes that step's index explicitly; it doesn't use
  `sendBackTarget`, which looks for an earlier implement step.
- **Rounds:** the rigor's `reviewRounds`, counted on that step as `WorkstreamStep.acceptanceSentBack`. That's a new
  optional number in the step JSON. A Retry resets it, beside `sentBack` in `clearSendBacks`. It is a separate budget
  from the reviewer's.
- **Fix rule:** `fixBy`. The action is `{kind: 'fix', evidenceId, providerSessionId}`. `fix` gains
  `providerSessionId: z.string().min(1).nullable().default(null)`, so stored rows still parse. With it:
  - `resumedSessionOf` returns it.
  - `nextActionAfterCrash` turns a resumed fix into a fresh one, and `nextActionOnAnotherAccount` clears it, as both
    do for `revise`.
  - `reviseAfterModelDrift` and `withFreshFixEscalated` handle `fix` as they handle `revise`. A fix that can't
    resume runs fresh, one rung up, once.
  - Resumed for Light and Standard sets `providerSessionId`. Fresh for Careful and Critical leaves it null and
    escalates as a reviewer's send-back does.
- **Notes:** the pass that sends back marks its evidence row `detail.sentBack: true`. `outstandingFixEvidence` reads
  only those `Acceptance` rows, with the Builder rule: outstanding until the target step starts again. A crash or a
  fresh session keeps the notes that way. Every other Acceptance row is a record, never fix evidence. A row written
  in the same write that starts the Review would otherwise count as outstanding while the Review runs.
- **The prompt** words the fix by evidence kind: "10db's acceptance check found these criteria not met: …". It
  never says "the builder sent the work back". A resumed session gets the notes inline.
- `step.changed` carries `sentBackBy: 'acceptance'`. `rigor-figures`, which counts reviewer send-backs, leaves it
  out.
- **Provider:** the fix runs on the project's account like any fix. That's a Claude plan, Bedrock or an API key
  through Claude Code's resume, or Codex's thread resume. Where a resume isn't possible, it runs fresh as above.

### The card

- New `InboxKind.Acceptance`. One live card per workstream. It is raised in the write that moves the run on, and
  `targets` the workstream.
- Title: "Check these criteria: <task>". The body lists each criterion with its verdict and note, and the
  `unasked` line if there is one.
- Options:
  - **Accept** closes the card. The criteria count as met for the rest of this run.
  - **Send back with a note** files one Ready follow-up task, linked to the original. Its description holds the
    criteria and the note. It doesn't reopen the shipped run.
- It doesn't hold claims, the lane or the ship. The run is Done, or in Review, either way.
- Recovery has nothing to rebuild, because the card is written in the same write as the move.
- **It is never a run's question.** The card can stay open while a Review runs, so it is handled like Check and
  Plan in three places:
  - the Inbox answers it through its own `applyAcceptanceAnswer`, inside the answering write, never through
    `onParkedAnswer`;
  - `settle` never parks on it (`openItemsForWorkstream(...)[0]`);
  - recovery never picks it as the card a run waits on (`recover.ts`).

## Decisions and providers

`JudgeDecision` gains `acceptance` and `acceptance_second`. Both join `JudgeConfig`, `DEFAULT_JUDGE_CONFIG` and
`JudgeConfigPatch` with `.default`s, `testKind` (Nouls), and the desktop catalogue. **Both default to
`enabled: false`.** `patchJudgeConfig` writes the whole parsed config back, defaults included, so a later code
default would never reach an existing install. **Switching it on is a data change.** Once the replay passes and the
builder has seen the screenshots, both decisions are turned on in Settings › Decisions (`PATCH /judge`) on the
builder's install. The code default turns on later, for new installs only.

Default models:
- **OpenRouter:**
  - `acceptance`: `typesafe/jev-1.13`.
  - `acceptance_second`: a new `OPENROUTER_ACCEPTANCE_SECOND_MODEL`, which the replay chooses. It starts at
    `anthropic/claude-sonnet-5.5` and goes on the allowlist in `tests/repo/src/model-names.test.ts`.
- **Anthropic key and Bedrock:**
  - `acceptance`: the Efficient tier.
  - `acceptance_second`: the Balanced tier.
- Both `defaultModelFor` and `settleSecondOpinionModel` take the decision as a parameter, so they serve both second
  opinions.

Floors: 0.8 for `acceptance` and 0.7 for `acceptance_second`. The replay may change them.

| Account that answers decisions | Acceptance |
| ------------------------------ | ---------- |
| OpenRouter, Anthropic key, Bedrock | Runs as above, whatever account the project builds on (a Claude plan, Bedrock, an API key or Codex). |
| None (the builder has only a Claude plan or a ChatGPT/Codex plan) | `ready()` is false and runs go on as today. The Board says "Acceptance isn't checking: no account can answer decisions". The follow-up in `decisions/2026-11-21-decisions-run-on-any-api-account.md` closes it. |
| Decision switched off | The same, and the Board says it's off. |

## The Board counts

- `GET /projects/:projectId/acceptance-figures?days=7` returns:
  - `completed`: tasks whose last `task.changed` to done falls in the window, and whose run raised no `acceptance`
    card. Pass tasks are left out, as in `rigor-figures.ts`.
  - `sentBack`: `step.changed` events in the window with `sentBackBy` set to anything but `builder`. That covers
    acceptance, review and QA. They are scoped to the project through `workstreams`, leaving out pass batches.
  - `sentToYou`: `inbox_items` of kind `acceptance` created in the window.
  - `checking`: `{on: true}`, or `{on: false, reason: 'no_account' | 'off'}`.
- It needs no migration beyond the evidence `detail` column.
- The Board's header shows the three numbers. Each links to Factory, which lists the runs behind it.

## Replay and launch bar

`apps/daemon/scripts/acceptance-replay.ts` is shaped like `crosses-limit-replay.ts`. It reads a copy of the live
database and the project's git.
- **Sample:** every run with a Review step whose pre-review head git still has, plus every task reopened after Done
  (found from `task.changed`).
- **State:** rebuilt at the head the reviewer saw, the run's last `commit.recorded` before its review step started.
  A head git no longer has is skipped and counted.
- **Ground truth:**
  - the reviewer's first verdict on that head;
  - for each reopened task, a hand label of which criterion it missed. A reopen that missed no criterion is left out
    of the bar and listed.

Launch bar, on at least 200 runs:
- No labelled reopened task is read as all met.
- Of the runs the reviewer approved first time, at most 10% would be sent back.
- On Light-like runs, at most 15% of criteria would come out unclear.
- The results on reviewer send-backs are reported, but don't gate launch: a reviewer's finding is often outside the
  criteria.

A miss tunes the floors or the second model; it doesn't change the rule.

## State table (design, not a test list)

| When                                                         | Result                                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Gate passed after the last implement step; all met or unread | `moveAfter`                                                            |
| Some not met, round < limit                                  | send back, `acceptanceSentBack+1`, `fix` per `fixBy`                   |
| Some not met at the limit                                    | `moveAfter`, plus one `acceptance` card                                |
| None not met, some unclear, Review follows                   | `moveAfter`; the Review's first round reads them                       |
| None not met, some unclear, no Review                        | `moveAfter`, plus one `acceptance` card                                |
| Judge not ready, or both calls unanswered                    | `moveAfter` (today)                                                    |
| Any step has `fixedPlan`, or a gate-less project             | acceptance doesn't run                                                 |
| Commit Directly with an implement step still to come          | acceptance doesn't run yet                                             |
| Stop, cancel, Retry or rigor change during the calls          | aborted or dropped at the fence; the next gate re-runs it              |
| Build account paused during the calls                        | the calls go on (they run on the decisions account); an aborted read stays Verifying and re-runs |
| Gate fails after a resumed fix finished                       | a fresh fix, escalated only for the gate, never again for the send-back |
| Shutdown during the calls                                    | recovery re-runs the gate, then acceptance                             |
| Crash during a resumed acceptance fix                        | it becomes a fresh fix, and the notes stay outstanding                 |
| Project moved to another account during a fix                | `providerSessionId` is cleared and the fix runs fresh                  |
| Retry of the run                                             | `acceptanceSentBack` is reset with `sentBack`; a pending fix drops its session |
| Builder accepts on the card                                  | those criteria are met for the rest of the run                         |
| Builder sends back on the card                               | one follow-up task; the run isn't touched                              |
| Card answered while the Review waits on its own question     | only the acceptance card resolves; the Review stays waiting on its own |
| Acceptance row written as the Review starts (no send-back)   | a record only; a Review crash still resumes the review session         |

## Tests (per `.claude/rules/testing.md`)

- **The reading rule** (`acceptance/read.ts`) is a pure rule table: one test.
- **The wiring:** one case through `createTestEngine` in `runner/test-value.test.ts`'s harness. Its fake OpenRouter
  answers per call: not met on the first pass, met after the fix. The run is sent back once, the fix resumes the
  session, and then the run goes on.
- **Recovery mappings:** extend the `next-action.test.ts` rows for `fix` with a `providerSessionId`.
- **Daemon and desktop together:** the e2e daemon runs with the judge off, so the Board e2e shows only "not
  checking". The card and the live counts are first run together by a click-through against a stub OpenRouter.
  Screenshots go to the builder before the switch-on PR.
