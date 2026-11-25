# A failed run reaches the builder only when they're the one who can act

**Status:** designed on 2026-11-25, not built. **Size: Core.** It changes retries, recovery and what the judge's
skips lead to. Plan review, then one plan per milestone (index and cards for the Core ones).

## Brief

**What changes for you.** A failed run no longer lands as a bare "Workstream failed" card with Retry. 10db sorts
it first, and you see it only when you're the one who can act:
- **A crash, no result or a broken install:** 10db retries once by itself. You hear about it only if that retry
  fails too.
- **10db's judge skipped a call the run needed** (about half of today's failures): one card per skipped call per
  project, such as "10db's judge keeps skipping `.agents/bin/gate-query` (7 runs, 4 tasks)". It offers **Allow in
  Ampsio** and **Report to 10db**. The runs it stopped wait on it and retry by themselves once the call is allowed,
  by you or by a later judge.
- **A reason only you can answer** (a missing secret, say): a question in the agent's words. Your answer resumes
  the run.
- **Work a lane can't do** (Aside, another repo): **Run from a Session**, with the brief written.
- **Out of attempts:** a fresh agent reads the logs, the review and the diff, and proposes a next try. You pick
  **Try This**, **Split Task** or **Close**. There's no bare Retry.
- **Waits on other work** (a flaky test that an open batch fixes): the run shows "Waits on <batch>". When that
  batch merges, 10db updates the branch and reruns CI by itself.

Cards get quieter too:
- one card per task, not one per run;
- the CI cap card replaces "checks failed";
- skip cards close once their task is done;
- "Write outside every claim" cards wait out a short window first, since most close on their own;
- a card whose problem has since been fixed elsewhere closes, and so does its task.

**What it buys.** Of the 9 open Ampsio failure cards on Nov 25, 7 were runs the judge's skips stopped and 2 were
work a lane can't do. A bare Retry fixes neither. Of the cards around them, 11 had closed themselves or were stale,
3 were for one task already fixed by hand, and #851 showed 2 for one failure.

**What could go wrong, and how we'd know.**
- *A sort hides a real failure.* Every failure is still in Factory with its class. A diagnosis that fails or times
  out falls back to today's card. Factory › Metrics counts failures by class and how each ended, so a class that
  keeps re-failing shows.
- *A task is closed as already fixed when it isn't.* That needs a cited commit on the base, plus a passing run of
  any command that checks the criterion. It posts a notice with **Reopen**.
- *Diagnosis costs quota.* It's one short read-only session per failure that rules can't sort, capped at 20 per
  project a day.

**Calls you might disagree with.**
- The diagnosis runs on the project's own account, not the Decisions account, so it works on a plan login.
- A skip card on a task that finished closes even when it still lists calls you could run. "Run these now" moves to
  the task drawer. This amends the Nov 24 rule.
- An already-fixed task closes by itself, with Reopen, rather than asking you first.
- Out-of-attempts cards drop Retry. Try This with an empty note is the old Retry.

**Needed from you:** nothing. You approved the brief and chose one Inbox card per skipped call (2026-11-25).

---

The rest is for agents.

## Today, in the code

- `runner.ts` `fail()` raises one "Workstream failed" flag per run (`flagFailed`), with no fold key; it is
  withdrawn only when that run is retried, cancelled or shipped. Three runs of one task are three cards.
- A `blocked` run always has a skip (`report_blocked` refuses without one), and its reason lists every skipped call.
- Retries exist only inside a run: `maxRecoveryAttempts` 3, one review rerun, `SKIP_RESUMES_MAX` 2,
  `FIX_ATTEMPT_LIMIT` 3, `maxCiFixes` 2. `retryWorkstream(state, id, note?)` is the builder's; its note reaches
  the step and the limits judge as the builder's words.
- `failureLine` (`task-state.ts`) says the kind, then what Retry does, never the cause. Factory's `failureCauses`
  offers Retry and Retry All, and no Close.
- `closeFinishedSkippedCards` keeps a done task's skip card open while it lists approvable skips with no follow-up
  (`stillOffersRun`). All 5 stale skip cards on Nov 25 were that case.
- The PR watch has `ci-failure-class.ts` (Base, Change), tsk_01a21408's single rerun with its `flaked` outcome and
  "Flaky check" card, the base-red merge into waiting pull requests, and `checksFailed` and `ciStopped` under
  different fold keys.
- `resolveSettledStrays` closes stray-write cards when a run ends; the 6 copy cards lived about 2 min.

## The sort

When a run reaches `FAILED`, `fail()` sets its `sort` to `sorting` in the same write and raises no card.
`sortFailure` (new module `apps/daemon/src/failures/`) then tries three passes; the first that settles it wins.

1. **Rules over 10db's own records.** These are facts 10db wrote: the failure kind, the run's `skipped_actions`
   rows and the `judge_calls` behind them, gate evidence, and the CI rerun record. Rules here coordinate 10db's own
   work. None decides whether a call crosses a limit.
2. **The diagnosis session**, for anything the rules leave open (below).
3. **Fallback:** today's card, its line cause-first, raised when pass 2 fails, times out (10 min) or is over its
   cap.

Which pass settles each class:

| Class | Settled by rules when | Otherwise |
| --- | --- | --- |
| Transient | kind is `session_failed`, `no_result` (no findings written) or `install_broken`; the failed step has no non-question skip; the failure is not marked `retryable: false`; and the task has had no auto-retry since the builder last acted on it | — |
| Engine | every non-question skip in the failed step falls under one engine pattern (below), and the kind is `blocked`, or `session_failed` with that skip in the last turn | the diagnosis names the skip that stopped the run |
| Question | never (wording is the agent's) | diagnosis |
| Host session | never | diagnosis, from the skip (`read_outside`, `cant_run_in_lane`, a builder tool like `aside`) and the task |
| Out of attempts | kind is `gate_failed`, `retry_limit` or `rejected_at_limit`, or the batch is `ciStopped` with `limit` or `no_change` | — (the diagnosis still runs to write the proposal) |
| Waits on work | the failing check or test names an open task's recorded `fixesCheck` | diagnosis, matching the failing test in the log to an open task or batch |
| Obsolete | never | diagnosis, only when the base moved since the run began |

`retryable: false` is a new field on the runner's `Failure`. It's set where the runner already knows a retry
would fail the same way (`background_hung`, `refused`).

### Engine patterns

A skip is **10db's own** when 10db, not a limit, stopped the call:
- the judges couldn't settle it (`below_floor`, or the second opinion's skip that names no limit);
- 10db's coordination or sandbox refused it (`unread_hazard`, `cant_run_in_lane`, `unread_edit_path`).

A skip the judge settled with a named limit is not 10db's error but a question or host-session case. The sort only
reads what the judge recorded; the judge still decides limits.

The pattern key is the tool plus the program: the first command word after `cd`, `env` and assignments, with the
path normalised to the checkout. An MCP tool keys by its name, and a web call by its host. One `engine_items` row
per project and key counts runs, tasks and skips, from the first and last time it was seen.

## What each class does

### Transient

10db retries once after 5 minutes, once the run's account isn't paused, with the note "10db retried this after
`<kind>`". It uses `retryWorkstream` and so resets nothing else. The run shows "Retrying by itself" and raises no
card. If the retry fails, whatever the kind, the run goes to the diagnosis and never back to Transient.

### Engine

- The run waits on its engine item and raises no card of its own. The item's card (fold key
  `engine:<project>:<key>`) is reworded with each new run.
- The card's options:
  - **Allow in <project>** writes an allow line in the builder's words, which the hook judge reads as
    `builder_allowed` and Claude's auto mode reads in `TrustPolicy.allow`.
  - **Report to 10db** files the pattern, runs and `judge_calls` probabilities as a task in 10db's own project when
    one is registered, else copies them.
  - **Keep Skipping** marks the call as one 10db won't run.
- **The replay.** After a self-update installs, or the judge config or allow lines change, 10db asks the current
  judge again about each open item's latest skipped call, through the same `judge.assess` path. If it would run
  now, the item closes as "fixed by 10db".
- On Allow or a replay that runs it, every run waiting on the item is retried once. On Keep Skipping, each waiting
  run is retried once with the note "10db won't run `<call>`; do the step without it". If it fails again, it's out
  of attempts.

### Question

A question card (`InboxKind.Question`) asks in the agent's words, with the diagnosis's options when it gives any.
It routes like any lane question, Slack routes included. The answer calls `retryWorkstream(id, answer)`, so the
judges read it as the builder's words. Where the question is a setting (Docker, "Agents may read .env files"), the
card links it, as `clearedBy` does today.

### Host session

**Run from a Session** opens a 10db Session on the project with the brief filled in:
- the task and its criteria;
- what the lane did (its handoff and commits);
- what's left;
- why the lane couldn't do it.

The brief ends by telling the session to close the task with the `10db-task` skill when the work lands. The card
withdraws when the task closes. The run itself stays failed and offers no retry.

### Out of attempts

The diagnosis reads the gate evidence, the last review's findings, the diff against the base and the handoff. It
writes one proposal, which the card shows in full:
- **Try This**: a concrete, editable note (what to change, why the last try failed) for `retryWorkstream` with
  fix attempts reset, or Start Over when the proposal says the plan was wrong.
- **Split Task** proposes 2–4 tasks, each with a title, a description and criteria, in dependency order. Choosing
  it files them in the task's place and starts them, and closes the original as "split into …".
- **Close** closes the task, giving the diagnosis's reason.

For a `ciStopped` batch the same card replaces the CI cap card, and Try This starts a CI-fix batch with the note.

### Waits on other work

- **Linking.** The "Flaky check" card gains **File a Fix**, which files a task with the failed run's link and
  records `fixesCheck: <name>` on it. The diagnosis can record the same link on an open task whose description
  names the failing test (tsk_01a21414 names its specs).
- **Waiting.** A check that fails again after tsk_01a21408's single rerun, with an open fixing task, sets the
  batch's `waitsOn`. No CI fix starts, no card is raised, and Factory and the Board say "Waits on <batch>". A run's
  gate failing on a linked test waits the same way.
- **The fixing batch merges:** 10db brings the base into the waiting branch and pushes, as the base-red path does,
  and CI reruns on the new head under the normal path. A local copy re-merges the base and gates again (its race
  path).
- **It ends without merging, or 24 hours pass:** the failure is the change's own, as today.

### Obsolete

When the base has moved since the run began, the diagnosis checks whether the task's criteria already hold on the
base's head. It runs a criterion's command when one checks it. It answers `obsolete` only when it cites the commit
that made the criterion true and, for a command criterion, the passing run. 10db then:
- closes the task as done, with "already true on <base> at <sha>";
- withdraws the card;
- posts an Activity notice with **Reopen** for 7 days.

## The diagnosis session

- A read-only step, run like a review on the project's account (the review sandbox profile, the Balanced model),
  with a fresh checkout of the base for the obsolete check.
- Its input: the failure, skips, judge calls, gate evidence, review, handoff, diff and CI logs, and the project's
  open tasks and batches.
- It answers with one MCP tool, `report_diagnosis`, checked with zod at the boundary:
  `{ class, cause (one line), question?, options?, proposal?, split?, waitsOn?, obsoleteBy?, engineSkipId? }`.
  10db checks every id and sha it cites against its own rows, and a failed check is treated as no answer.
- **Limits.** It can't allow a call, grant a claim or change a setting. Its commands are judged like any lane's.
- **Bounds.** One diagnosis per failed run, at most 10 minutes, and at most 20 per project per day. Past the cap,
  failures get today's card with the line "10db didn't diagnose this: today's diagnoses are used".
- `cause` becomes the run's failure line everywhere: Board, drawer, Factory and goal digest. So "The implement step
  stopped…" turns into "Needs `.agents/bin/gate-query`, which 10db's judge skipped".

## Card hygiene (no diagnosis needed)

- **One card per task.** The failed card's fold key is `failed:<taskId>`. A later run's failure rewords it, adds
  "(3 runs)" and moves its options to the newest run. When a later run of the task finishes, the card closes.
- **The CI cap card replaces "checks failed".** Raising `ciStopped` withdraws the same root's `prCardKey.checks`
  card in the same write.
- **Factory shows a failure once.** A failed run with an open card shows as that card's row in Needs You, with the
  card's actions, not also as a cause row.
- **Skip cards close when the task is done** (`closeFinishedSkippedCards` drops the `stillOffersRun` exception),
  and also when a later run of the task finishes. Run these now stays in the task drawer for that run. Its skips
  still count toward engine items.
- **Stray writes wait.** A "Write outside every claim" card for a non-sensitive path is raised only if
  `resolveSettledStrays` hasn't settled it 3 minutes after the write, or when the step ends, whichever is first. A
  sensitive path still cards at once, because it's a trust decision.

## State table (design, not a test list)

| Class | What 10db does | What the builder sees | How it ends |
| --- | --- | --- | --- |
| Sorting | rules, then diagnosis (≤10 min) | Factory: "Diagnosing"; no card | a class below, or the fallback |
| Transient | one retry after 5 min | "Retrying by itself"; no card | retry passes: done. Fails: diagnosis |
| Engine | run waits on the item; replay after each update or allow change | one card per pattern, its count rising; run: "Waits on 10db's judge" | Allow or replay: runs retried. Keep Skipping: retried once without the call |
| Question | card in the agent's words | question card | answer resumes the run (retry with the answer as note) |
| Host session | brief written | card: Run from a Session | the task closes from the session |
| Out of attempts | diagnosis writes a proposal | card: Try This / Split Task / Close | the chosen action. Try This failing again gets a new proposal |
| Waits on work | no fix and no card; follows the named batch | "Waits on <batch>" | batch merges: base brought in, CI reruns. Batch ends or 24 h: change's own failure |
| Obsolete | task closed as done, with the cited sha | Activity notice with Reopen | Reopen, or 7 days |
| Fallback | today's card, cause-first | "Workstream failed" with Retry | as today |
| Any | the builder retries, closes or edits the task | — | the sort stops. A new failure sorts afresh |
| Any | the daemon restarts mid-sort | — | `sorting` runs are sorted again at start. A transient retry already started is not repeated (`autoRetriedAt`) |

## Provider parity

| | Claude plan | Claude via Bedrock or API key | ChatGPT/Codex plan |
| --- | --- | --- | --- |
| Diagnosis session | Claude Code, project's account | same | Codex, project's account |
| `report_diagnosis` | 10db MCP | same | 10db MCP |
| Engine replay | the Decisions account's judge | same | same |
| No Decisions account (plan-only builder) | the replay asks the rules floor; items close on Allow, Keep Skipping or a 10db build whose rules run the call | same | same |
| Allow line read by | hook judge and auto mode | same | 10db's hook judge (`decisions/2026-11-12-codex-is-judged-by-10dbs-judge.md`) |
| Run from a Session | Claude Code Session with the builder's skills, Aside included | same | Codex Session; where a builder's skill isn't wired into Codex, the brief says which and the card says "Run from a Claude Session works better" |

- The diagnosis spends the project's account: it's the builder's billing line, and works on a plan login, which the
  Decisions account can't be.
- A paused account delays it ("Diagnosing: waits for <account>"); after 30 minutes the fallback card is raised.

## Trust

Every limit stays the judge's: the diagnosis's calls are judged like a lane's, the replay asks the judge, and Allow
writes a builder line the judge reads. The sort only coordinates 10db's own work
(`decisions/2026-11-12-10db-trusts-the-developer-and-contains-the-agent.md`).

## Dependencies and scope

- **#851 (merged, 54edf770).** It fixes five engine causes, among them the judge reading committed scripts and a
  copy's scope. Engine counts are measured only from its install. The 316-skip baseline predates it.
- **bat_01a2140f (merged in #857).** Waits on work builds on tsk_01a21408's single rerun: its
  `checks-failed-rerun:<head>` record, its `flaked` outcome and its "Flaky check" card. The rerun itself is
  unchanged, and tsk_01a21401 and tsk_01a21414's flake fixes are untouched.
- **Fable's e2e flake tasks** (tsk_01a1e044-4a10, tsk_01a1f479): out of scope.
- **Uses, unchanged:** the limits judge's builder notes, `retryWorkstream`, the base-red merge path, Sessions and
  the `10db-task` skill.
- **Out of scope:** the judge's questions and thresholds; lanes getting Aside or another repo; Slack routing;
  parallel copies; Workbench pass turns, whose one answer stays Retry Turn.

## Records

- `workstreams` gains `sort` (`sorting`, `transient`, `engine`, `question`, `host`, `out_of_attempts`, `waits`,
  `obsolete`, `fallback`, `settled`), `diagnosis` (the parsed `report_diagnosis`), `auto_retried_at` and
  `waits_on`; `tasks` gains `fixes_check`.
- `engine_items` (new): project, key, summary, state (`open`, `allowed`, `kept`, `fixed`), counts, first and last
  seen.
- All additive, generated last, one migrating pull request at a time. Contracts: `FailureSort`, `EngineItemDto`,
  `ReportDiagnosisInput`.

## Decided: the judge's skips are one Inbox card per call

The builder chose this on 2026-11-25: one card per project and skipped call, with Allow, Report and Keep Skipping.
Turned down:
- a Factory row plus an auto-filed 10db task, with no card: nothing waiting moves until 10db ships a fix;
- both: two surfaces for one cause.

## Milestones

Each milestone gets its own plan once the one before it merges.

### Builder's cut

Cut by the builder on 2026-11-25, as recommended: F0 is done, F1 to F3 are needed, and F4 is later.

| # | Milestone | Size | Builder's cut | Needs | Migration |
| --- | --- | --- | --- | --- | --- |
| F0 | Cause-first failure lines (from `failureReason` and the skips, before diagnosis exists) and Close for a failed task in Factory, as the Board drawer has | Small | **done** (#859) | — | none |
| F1 | Card hygiene: fold per task, cap card replaces checks card, Factory dedupe, skip cards close when the task is done, stray-write wait | Feature (the stray wait gets one watcher test: claims are core) | **needed** | F0 | none |
| F2 | The sort, transient auto-retry, engine items with replay and Allow, `retryable: false` | Core | **needed** | F1 | `workstreams.sort`, `auto_retried_at`, `waits_on`; `engine_items` |
| F3 | Diagnosis session and `report_diagnosis`: question, host session, out of attempts (Try This / Split / Close, CI cap card), obsolete | Core | **needed** | F2 | `workstreams.diagnosis` |
| F4 | Waits on other work: File a Fix, `fixes_check`, wait, then bring the base in and rerun on merge | Core (git: merges and pushes) | **later** | F3 | `tasks.fixes_check` |

**F0 and F1 can run ahead of F2's plan.** They change no retry, git or judge path.

**Tests** (`.claude/rules/testing.md`):
- F1: one regression test for the fold. It's an escaped bug: three cards for one task.
- F2 (core: recovery and trust):
  - the transient retry happens once across a restart (real SQLite);
  - an engine replay that runs the call retries the waiting runs (real pipeline, fake adapter);
  - the sort's rule table, as a pure test.
- F3: the e2e failure flow extended once, through Try This.
- F4 (core: git): bringing the base in and pushing on merge, in a real temp repo.
