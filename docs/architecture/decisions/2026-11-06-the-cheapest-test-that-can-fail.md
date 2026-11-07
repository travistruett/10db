# Tests start from the cheapest one that can fail

- **Date:** 2026-11-06

## Decision

`.claude/rules/testing.md` replaces "use a real git repo in a temp directory" with an order of work. Extend an existing
test or table when it sits on the cheapest rung that can catch the regression. Otherwise add the cheapest test that can
fail for the regression you fear: pure function, real SQLite, a rendered component or real HTTP, real git, then the real
pipeline.

The ladder has a floor. Tests of merges, pushes, worktrees, migrations where a git merge is the behavior, and every
recovery, trust, sandbox, guard, claim and permission row start on, and never move below, the rung that exercises the
real thing: the state or process the test acts on, such as git for merges or a real database or restart for recovery. A
pure rule table, such as a guard's judge or a schema, stays pure, with one test through the wiring. Any other test moves down only after the cheaper one is seen failing for the same regression, and the
commit says how. An extraction adds a test and keeps one through the wiring. git and SQLite are never mocked. A
dependency passed in with a production default is fine; a new branch, flag or export only a test uses is not.

Each newly tested behavior carries one value card, however many cases it has, and a new row in an existing table needs
none:
`Value: protects=...; fails_when=...; why_new=...; no_claim=...`. It goes in the commit that adds the test, wrapped to
commitlint's 100 columns, and in the plan when there is one.

The `planning`, `test-first` and `review-checklist` harness skills carry the ladder, the floor and the card, so they
reach every project 10db manages. They differ from the rule in two ways, because a skill can't know another repository.
Their floor covers all migrations, and they forbid mocking only a database the test can run, since a hosted one sits
behind the network. The persona files don't change: the daemon seeds a persona only when its key is missing and never
overwrites one, while skills load fresh into each session.

## Why

The old sentence told every task to reach for an expensive fixture. Measured on 2026-11-06, the gate had grown 6x in
nine days, the last 60 pull requests added 1.93 lines of test per line of code, and the slowest 100 files took 85% of
test time, while `packages/contracts` ran 996 tests with its test phase under 2 s. Count is not the cost.

Extending is not unconditional. A row in a table driven by the pipeline pays for the pipeline on every row, so an
"always extend" rule would grow the slowest tests and leave the ladder unreachable for anything one of them touches.

The skills have to carry this. A sandboxed lane loads no project settings, so `.claude/rules/testing.md` reaches it
only if it follows `AGENTS.md`, and another repository has no such rule. A lane has no `test-audit` skill either.

The card and the proof of a moved test are in the commit because an implement step ends without a report:
`complete_step` refuses it, and the reviewer reads commits. `quick` and `standard` flows have no plan step, so a plan
alone would leave most tests with no card. The card has one per behavior because the commit tool caps a message at
2000 characters, and it drops `test-audit`'s `seam` field because the rule forbids seams, so the field could only say
`none`.

Test cost and a missing card never reject a change. A reviewer finding needs a concrete failure, and neither has one.
Rejecting on them would burn a round, and it is the likeliest way to get a real test rewritten cheaper. A named cheaper
replacement goes in `followUps`. A missing card is only noted in the summary: by the time a follow-up task ran, the
commit would have merged, so nobody could finish it. A row needs no card because rows are the shape this rule asks for.

Turned down:

- **Changing only `testing.md`.** Two skills said "real objects" with no ladder, so lanes would have kept the old
  advice.
- **Dropping the rule on real objects.** Cheap tests that mock the code under test would pass while the product
  breaks. The cost saved must come from a smaller test, not a weaker one.
