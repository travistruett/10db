# Tests start from the cheapest one that can fail

- **Date:** 2026-11-06

## Decision

`.claude/rules/testing.md` replaces "use a real git repo in a temp directory" with an order of work. Extend an existing
test first. A new test is the cheapest one that can fail for the regression you fear: pure function, real SQLite, a
rendered component or real HTTP, real git, then the real pipeline.

The ladder has a floor. Merges, pushes, worktrees, migrations where a git merge is the behavior, and every recovery,
trust, sandbox, guard, claim and permission row never move down a rung, and any other test moves down only once the
cheaper one is shown failing for the same regression. An extraction adds a test and keeps one through the wiring. git
and SQLite are never mocked. A dependency passed in with a production default is fine; a branch, flag or export only a
test uses is a seam, and is not.

A new test, not a new row, carries a value card:
`Value: protects=...; fails_when=...; why_new=...; seam=...; no_claim=...`. It goes in the plan and in the commit that
adds the test, wrapped to commitlint's 100 columns.

The `planning`, `test-first` and `review-checklist` harness skills say the same, so the rule reaches every project 10db
manages. Their floor is broader on migrations, because a skill can't know which of another repository's migrations are
behavior. The persona files don't change: the daemon seeds a persona only when its key is missing and never overwrites
one, while skills load fresh into each session.

## Why

The old sentence told every task to reach for an expensive fixture. Measured on 2026-11-06, the gate had grown 6x in
nine days, the last 60 pull requests added 1.93 lines of test per line of code, and the slowest 100 files took 85% of
test time, while `packages/contracts` ran 996 tests in under 2 s. Count is not the cost.

The skills have to carry all of it. A sandboxed lane loads no project settings, so `.claude/rules/testing.md` reaches
it only if it follows `AGENTS.md`, and another repository has neither file. A lane has no `test-audit` skill either.

The card is in the commit because an implement step ends without a report: `complete_step` refuses it, and the
reviewer reads commits. `quick` and `standard` flows have no plan step, so a plan alone would leave most tests with no
card. A table row needs none, because rows are the shape this rule asks for.

Test cost and a missing card go in `followUps` and never reject a change. A reviewer finding needs a concrete failure,
and neither has one. Rejecting on them would burn a round, and it is the likeliest way to get a real test rewritten
cheaper.

Turned down:

- **Changing only `testing.md`.** Two skills said "real objects" with no ladder, so lanes would have kept the old
  advice.
- **Dropping the rule on real objects.** Cheap tests that mock the code under test would pass while the product
  breaks. The cost saved must come from a smaller test, not a weaker one.
