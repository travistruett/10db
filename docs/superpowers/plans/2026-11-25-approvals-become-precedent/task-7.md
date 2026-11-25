# Task 7: the migration and the notes

**Size: Small.** Read the index's Global Constraints first. Needs every other Track B task merged into the
branch, and the branch's final merge of `main`.

## Files

- `packages/db/drizzle/`: generated, never edited (`packages/db/AGENTS.md` says how; until the first published
  release the baseline is regenerated, not extended). It adds `trust_precedents` and `judge_calls.precedent_id`.
  Check no other open pull request adds a migration.
- `apps/daemon/src/trust/AGENTS.md`: `program-key.ts`, `precedents.ts`, `precedent-candidates.ts`, the fifth
  step of `readLimitAnswers`, `CallRuns.differs`, and that a precedent is withheld, never refused on.
- `apps/daemon/src/inbox/AGENTS.md`: the precedent card and its answer route; the conflict card.
- `apps/daemon/src/judge/AGENTS.md`: `judge_calls.precedent_id` and `AssessReading.byPrecedent`.
- The spec's status line: P1 built.

## Tests

None. Run `make precheck`; CI runs the suite.
