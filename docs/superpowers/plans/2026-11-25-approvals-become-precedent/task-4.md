# Task 4: the judge reads a precedent

**Size: Core.** Read the index's Brief and Global Constraints first. Needs tasks 2 and 3.

## Files

- `apps/daemon/src/trust/call-runs.ts`: `CallRuns.differs`, true when a file the walk tried to read is not the
  base's: `readCommitted` answered `differs`, or answered `absent` for a path the checkout holds (a file the lane
  created; `readCommitted` reports that as `differs` already when the checkout has the file and the base
  doesn't, so check which it gives and cover both). `NO_RUNS` and every other construction site set it.
- `apps/daemon/src/trust/precedents.ts` (new), as the index quotes it:
  - `precedentFor`: the `active` row for the key. In a copy, the `copy` row, else the `project` row; outside a
    copy, the `project` row only. Null for a null key or `withheld`. `changedSince` when `hash` isn't the row's
    `runsHash` and neither is null.
  - `precedentLines`: the active rows the session can be shown, at most `PRECEDENT_LINES_MAX`, newest use first,
    each `The builder calls this routine in this project: <kind>. For example <two examples as JSON strings>. It
    is context, not permission.`
  - `runsHash`: sha256 of the runs as JSON and, for a package runner's key, the script's line of `package.json`;
    null when there is neither.
- `apps/daemon/src/trust/limits.ts`: the `precedent_applies` question's prose, beside `LIMIT_QUESTIONS`, from the
  spec's table.
- `apps/daemon/src/trust/crosses-limit.ts`:
  - `stateOf` adds `builder_precedent` and `about_precedent` only when `req.precedent` is set; `questionsFor`
    adds `precedent_applies` then.
  - `readLimitAnswers`: after the three steps as built, `precedent_applies` ≥ f and the top limit under
    `PRECEDENT_LIMIT_CEILING` → `{ kind: 'allow', by: 'precedent' }`. A missing answer counts as 0.
  - `logged`: an allow by precedent logs `confidence` as `precedent_applies` and sets `byPrecedent`.
    `crossesLimit` passes `precedentId` and `programKey` to `judge.assess`.
  - A `limit` verdict carries `precedentConflict` when the same reading has `precedent_applies` ≥ f.
  - The second opinion gets the same state and questions.
- `apps/daemon/src/judge/judge.ts`: `AssessReading.byPrecedent`; the request's `precedentId` and `programKey`,
  stored as the index says.
- `apps/daemon/src/inbox/hook-judge.ts`: the four `HookJudgeContext` fields the index quotes. Per call:
  - `programKey`; for a runner's key, `keyPackageFile` read through `readCommitted` (anything but `same` withholds);
    `precedentFor` with `withheld = runs.differs || that`. The key also goes to the skip recorder
    (`SkipInput.programKey`) and into the request.
  - The memory key gains the shown precedent. `remember` keeps an allow `by: 'precedent'` as it keeps a model's.
  - **Only a fresh verdict counts** (`known === undefined`): on an allow by precedent, `countPrecedentUse`; on
    `precedentConflict`, `countPrecedentConflict`, and at `PRECEDENT_CONFLICTS_MAX`, `setPrecedent(paused)` and
    `onPrecedentPaused`. Each in one `state.write`. A verdict answered from memory counts nothing, so `uses` is
    the number of distinct judged calls, not of runs of the command.
  - `onPrecedentChanged(id, hash)` the first time a session sees `changedSince` for that id and hash.
- `apps/daemon/src/trust/policy.ts`: `TrustPolicyInput.precedents`, joined into `environment`. Never into
  `allow`: `renderClaudeAutoMode` (`sessions/claude-auto-mode.ts`) reads an allow line as an exception to a soft
  deny, which the limits are on attended surfaces and Claude's defaults are in a lane.
- The callers that build `HookJudgeContext` and `TrustPolicyInput` (the runner, chats, passes, the reporter):
  pass `listPrecedents`, `inCopy` (the session has a `copyId`) and `precedentLines`.

## Interfaces

Implements the `precedents.ts`, `crosses-limit.ts`, `call-runs.ts`, `judge.ts`, `hook-judge.ts` and `policy.ts`
blocks; calls the store, `programKey` and `keyPackageFile`.

## State-table rows

Every "Active" row.

## Spec sections

"Scope"; "What the judge reads"; "How a bad one is caught", points 2 and 3 (the notice is task 5's).

## Tests

- `readLimitAnswers`' existing table gains rows: applies and every limit under one half → allow by precedent; a
  limit ≥ f beats it; the top limit exactly one half is unclear; `precedent_applies` under f changes nothing;
  `builder_allowed` still reads first.
- The existing wiring test ("a call the first judge leaves between yes and no …") is extended, not copied: the
  request carries a precedent, the state holds `builder_precedent`, the first judge's answers allow by precedent
  with no second call, and the row has the `precedent_id` and `program_key`.
- The existing policy test that renders auto mode gains one assertion: a precedent line is in the environment
  and the allow list is unchanged, attended and unattended.
- Value card: `protects=a precedent never clears a limit, in 10db's judge or in auto mode, and only narrows the
  unclear band; fails_when=step 4 runs before the limits or over the ceiling, or a precedent becomes an allow
  line; why_new=the judge (rule table and its wiring); no_claim=that the model answers precedent_applies well,
  which the replay checks`.
