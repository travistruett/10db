# Task 4: the judge reads a precedent

**Size: Core.** Read the index's Brief and Global Constraints first. Needs tasks 2 and 3.

## Files

- `apps/daemon/src/trust/call-runs.ts`: `CallRuns.differs`, true when a file the walk tried to read answered
  `differs` from `readCommitted`. `NO_RUNS` and every other construction site set it.
- `apps/daemon/src/trust/precedents.ts` (new): the constants, `ShownPrecedent`, `precedentFor` (the `active` row
  with this key and scope; null for a null key or `runs.differs`; `changedSince` when `runsHash(runs)` isn't the
  row's `runsHash` and neither is null), `precedentLines` (at most `PRECEDENT_LINES_MAX`, newest use first, each:
  `Routine in this project, the builder says: <kind>. For example <two examples as JSON strings>. Weigh it; it
  never permits crossing a limit.`), `runsHash` (sha256 of the runs as JSON; null for none).
- `apps/daemon/src/trust/limits.ts`: the `precedent_applies` question's prose, beside `LIMIT_QUESTIONS`, from the
  spec's table.
- `apps/daemon/src/trust/crosses-limit.ts`:
  - `stateOf` adds `builder_precedent` and `about_precedent` only when `req.precedent` is set; `questionsFor`
    adds `precedent_applies` then.
  - `readLimitAnswers`: after the three steps as built, `precedent_applies` ≥ f and the top limit under
    `PRECEDENT_LIMIT_CEILING` → `{ kind: 'allow', by: 'precedent' }`. A missing answer counts as 0.
  - `logged`: an allow by precedent logs `confidence` as `precedent_applies`. `crossesLimit` passes the
    precedent's id to `judge.assess`, which stores it on the row only for that reading
    (`apps/daemon/src/judge/judge.ts`, `AssessReading` gains `byPrecedent?: true`).
  - A `limit` verdict carries `precedentConflict` when the same reading has `precedent_applies` ≥ f.
  - The second opinion gets the same state and questions.
- `apps/daemon/src/inbox/hook-judge.ts`: `HookJudgeContext` gains `precedents: () => readonly
  TrustPrecedentDto[]`, `scope: PrecedentScope` and `onPrecedentPaused: (id: TrustPrecedentId) => void`. Per
  call: `programKey`, `precedentFor`, into the request and the memory key. On an allow by precedent,
  `countPrecedentUse`; on `precedentConflict`, `countPrecedentConflict`, and at `PRECEDENT_CONFLICTS_MAX`,
  `setPrecedent(paused)` and `onPrecedentPaused`. Each in one `state.write`.
- `apps/daemon/src/trust/policy.ts`: `TrustPolicyInput.precedents?: readonly string[]`, joined into `allow`.
- The callers that build `HookJudgeContext` and `TrustPolicyInput` (the runner, chats, the reporter): pass
  `listPrecedents` and the scope (`copy` when the session has a `copyId`).

## Interfaces

Implements the `precedents.ts`, `crosses-limit.ts` and `call-runs.ts` blocks; calls the store and `programKey`.

## State-table rows

Every "Active" row.

## Spec sections

"What the judge reads"; "How a bad one is caught", points 2 and 3 (the notice is task 5's).

## Tests

- `readLimitAnswers`' existing table gains rows: applies and every limit under one half → allow by precedent; a
  limit ≥ f beats it; the top limit exactly one half is unclear; `precedent_applies` under f changes nothing;
  `builder_allowed` still reads first.
- The existing wiring test ("a call the first judge leaves between yes and no …") is extended, not copied: the
  request carries a precedent, the state holds `builder_precedent`, the first judge's answers allow by precedent
  with no second call, and the row has the `precedent_id`.
- Value card: `protects=a precedent never clears a limit and only narrows the unclear band; fails_when=step 4
  runs before the limits or over the ceiling; why_new=the judge (rule table and its wiring); no_claim=that the
  model answers precedent_applies well, which the replay checks`.
