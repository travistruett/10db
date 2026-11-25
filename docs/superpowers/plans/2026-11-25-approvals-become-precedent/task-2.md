# Task 2: contracts, the `trust_precedents` store and the migration

**Size: Core.** Read the index's Brief and Global Constraints first. Needs nothing.

## Files

- `packages/contracts/src/ids.ts`: the `TrustPrecedent` id (`tpd`), with `TrustPrecedentId` exported as
  `TrustGrantId` is.
- `packages/contracts/src/trust-policy.ts`: everything the index quotes under that path.
- `packages/contracts/src/json-schema.ts`: the new DTOs, beside `trust-grant-dto`. Regenerate
  `packages/contracts/generated/`; never edit it.
- `JudgeCallDto` gains `precedentId` and `programKey`; `SkippedActionDto` gains `programKey`. All nullable.
- `packages/db/src/schema.ts`:
  - `trustPrecedents` beside `trustGrants`: the columns in the spec's "The record", a unique index on
    (`project_id`, `program_key`, `scope`), checks on `state` and `scope`, cascade on the project.
  - `judgeCalls.precedentId` and `judgeCalls.programKey`, nullable, no foreign key.
  - `skippedActions.programKey`, nullable.
- `packages/db/src/store/trust-precedents.ts` (new): `PrecedentInput` and the six functions the index quotes.
  `approvePrecedent` is an upsert on the unique index: an existing row in any state moves to `input.state` with
  the new kind, examples and hash; to `active` it sets `conflicts` to 0 and clears `ended_at`. `setPrecedent` to
  `revoked` or `declined` sets `ended_at`. `lastAllowedByPrecedent` reads the call's command out of
  `judge_calls.state`. Mirror `trust-grants.ts` for shape and parsing.
- `packages/db/src/store/judge-calls.ts` and `skipped-actions.ts`: write and read the new columns
  (`SkipInput.programKey`); `listDoubtSkips` and `listUnclearLimitCalls` as the index quotes them. `inCopy` comes
  from the run's copy (`packages/db/src/store/local-copies.ts`).
- **The migration:** generate it here (`packages/db/AGENTS.md`), after checking no other open pull request adds
  one, so Track B's draft pull request is green in CI. Task 7 regenerates it after the final merge of `main`.

## Interfaces

Implements the contracts and `packages/db/src/store/` blocks of the index.

## Spec sections

"The record"; "The program key" (the stored columns); "Records".

## Tests

None of its own. The store is exercised by task 5's answer test on a real SQLite file.
