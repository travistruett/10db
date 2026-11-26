# Task 7: the migration regenerated, and the notes

**Size: Small.** Read the index's Global Constraints first. Needs every other Track B task merged into the
branch, and the branch's final merge of `main`.

## Files

- `packages/db/drizzle/`: regenerate the migration task 2 generated, never editing it (`packages/db/AGENTS.md`
  says how; until the first published release the baseline is regenerated, not extended). It holds
  `trust_precedents`, `judge_calls.precedent_id`, `judge_calls.program_key` and `skipped_actions.program_key`.
  Check no other open pull request adds a migration.
- `apps/daemon/src/trust/AGENTS.md`: `program-key.ts`, `precedents.ts`, `precedent-candidates.ts`, the fifth
  step of `readLimitAnswers`, `CallRuns.differs`, that a precedent is withheld and never refused on, and that it
  reaches auto mode through `TrustPolicy.autoModePrecedents` only, which `stateOf` never reads.
- `apps/daemon/src/inbox/AGENTS.md`: the precedent card and its answer route; the conflict card; that only fresh
  verdicts count uses and conflicts.
- `apps/daemon/src/judge/AGENTS.md`: `judge_calls.precedent_id`, `program_key` and `AssessReading.byPrecedent`.
- The spec's status line: P1 built.

## Tests

None. Run `make precheck`; CI runs the suite.
