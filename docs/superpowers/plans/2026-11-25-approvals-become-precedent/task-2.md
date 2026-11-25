# Task 2: contracts and the `trust_precedents` store

**Size: Core.** Read the index's Brief and Global Constraints first. Needs nothing.

## Files

- `packages/contracts/src/ids.ts`: the `TrustPrecedent` id (`tpr`), with `TrustPrecedentId` exported as
  `TrustGrantId` is.
- `packages/contracts/src/trust-policy.ts`: `PrecedentScope`, `PrecedentState`, `PrecedentChoice`, the three
  caps, `TrustPrecedentDto`, `PrecedentCandidateDto`, `PrecedentAnswer`, as the index quotes them.
- `packages/contracts/src/json-schema.ts`: the three DTOs, beside `trust-grant-dto`. Regenerate
  `packages/contracts/generated/`; never edit it.
- `packages/contracts/src/judge.ts` (or where `JudgeCallDto` lives): `precedentId: TrustPrecedentId.nullable()`.
- `packages/db/src/schema.ts`: `trustPrecedents` beside `trustGrants`: the columns in the spec's "The record",
  a unique index on (`project_id`, `program_key`, `scope`), a check on `state` and on `scope`, cascade on the
  project. `judgeCalls.precedentId`, nullable, no foreign key (calls outlive a removed project's rows as today).
- `packages/db/src/store/trust-precedents.ts` (new): the five functions the index quotes. `insertPrecedent`
  returns the existing row when the unique index already holds one. `setPrecedent` to `active` sets `conflicts`
  to 0; to `revoked` or `declined` sets `ended_at`. Mirror `trust-grants.ts` for shape and parsing.
- `packages/db/src/store/judge-calls.ts`: write and read `precedent_id`.
- **Don't commit a migration** (task 7). Where a test in this track needs the table, generate the migration
  locally and leave it out of the commit, as other plans' schema tasks do.

## Interfaces

Implements the contracts and `packages/db/src/store/trust-precedents.ts` blocks of the index.

## Spec sections

"The record"; "Records".

## Tests

None of its own. The store is exercised by task 5's answer test on a real SQLite file.
