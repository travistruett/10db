# Tests start from the cheapest one that can fail

- **Date:** 2026-11-06

## Decision

`.claude/rules/testing.md` replaces "use a real git repo in a temp directory" with a ladder: pick the cheapest test
that can fail for the regression you fear. Pure function or table row, real SQLite, real HTTP, real git, then the real
pipeline. Merges, pushes, worktrees, migrations where a git merge is the behavior, and every recovery, trust, sandbox,
guard and permission row stay real. A cheaper test is a smaller real thing, so mocks stay at the boundaries and no
export, flag or hook exists only for a test.

A new test, not a new row, carries a value card in the plan or step report:
`Value: protects=...; fails_when=...; why_new=...; seam=...; no_claim=...`.

The `planning`, `test-first` and `review-checklist` harness skills say the same, so the rule reaches every project 10db
manages. The persona files don't change: the daemon seeds a persona once and never overwrites it, while skills load
fresh into each session.

## Why

The old sentence told every task to build the most expensive fixture available. The gate grew 6x in nine days, and
the last 60 pull requests added 1.93 lines of test per line of code. Count is not the cost: `packages/contracts` runs
966 tests in 1 s, while the slowest 100 files take 85% of test time.

The skills hold the card because a lane has no `test-audit` skill to read it from, and `review-checklist` alone reaches
both the reviewer and the plan reviewer. The card lives in the report, not in test files, so it adds nothing to the
suite to maintain. A table row needs none, because rows are the shape this rule asks for.

Turned down:

- **Changing only `testing.md`.** A lane is told what to do by the skills, and two of them said "real objects" with no
  ladder, so they would have kept the old advice.
- **Dropping the rule on real objects.** Cheap tests that mock the code under test would pass while the product
  breaks. The cost saved must come from a smaller test, not a weaker one.
