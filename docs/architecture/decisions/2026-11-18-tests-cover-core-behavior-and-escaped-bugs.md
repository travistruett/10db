# Tests cover core behavior and escaped bugs, not every behavior, row, criterion or finding

- **Date:** 2026-11-18
- **Amends:** `decisions/2026-11-06-the-cheapest-test-that-can-fail.md`
- **Supersedes:** in part, `decisions/2026-11-06-pull-requests-report-their-test-cost.md` (one reason it gave
  for turning down a required check)

## Decision

A change adds a unit test only for core behavior or for a bug that escaped.

- Core is the git guard and its judge, the sandboxes, permissions, trust, claims, recovery, git merges, pushes
  and worktrees, migrations, and pure rule tables and parsers.
- An escaped bug gets one regression test.
- A user-visible feature extends a core e2e flow in `apps/desktop/e2e` and adds no rendered-component test.
- No test is owed per behavior, state-table row, acceptance criterion or review finding. State tables and
  criteria are design and review tools. A review finding asks for a test only in core or for an escaped
  regression.
- Count is a cost. Removing a test that guards neither core nor an escaped bug is welcome, in its own commit.
- Red first, fix the code not the test, real objects with mocks only at boundaries, no test-only code, git
  isolation, no sleeps, and reading a knowledge write back through search all stay.

This amends `decisions/2026-11-06-the-cheapest-test-that-can-fail.md`: its ladder, the real-thing floor for core
and its real objects stay; "count is not the cost" and a value card per newly tested behavior go. The value card
keeps its format, so the test-value judge still parses it, but it is required on a commit that adds a test, with
`why_new` naming the core area or the escaped bug, and no longer goes in plans.

It supersedes the reason "pressure a lane to delete tests" given in
`decisions/2026-11-06-pull-requests-report-their-test-cost.md` for turning down a required check on test cost.
That pressure is now wanted. The check itself stays turned down: it would still fail on noise.

The rules live in `.claude/rules/testing.md`, `AGENTS.md` (plan cards), `.claude/agents/` (implementer,
plan-reviewer, code-reviewer), the harness personas (implementer, planner, plan-reviewer, qa) and the harness
skills test-first, review-checklist and planning. `tests/repo/src/agent-docs.test.ts` ("test guidance") fails
when any of those, or the lane brief in `apps/daemon/src/briefing/prompts.ts`, asks for a test per behavior,
state-table row or criterion, for exhaustive cases or one row per case, or says count is not the cost, and when
`testing.md` reaches 650 words.

The lane brief in `prompts.ts` is unchanged: its one line about tests asks for no per-item test, and lanes get
the rules through the skills. The personas and skills also run in other projects, where core means what that
project's testing rules call core, and otherwise trust boundaries, persisted data, git and recovery. A project
that already stored the stock personas keeps its stored text; the skills reach every lane at once.

Claude and Codex read the same rule, agent and skill bodies, so both providers get the change.

## Why

The builder (2026-11-18): "I would rather have SIGNIFICANTLY less tests but just covering core functionality ...
The most important thing right now is that I can MOVE FAST. Once things stabilize we can always add more tests
based on actual bugs."

CI ran 28,242 tests in 1,238 files, 4,238 CPU-seconds a run. In two weeks of pull-request CI, 15 test files
failed for a real bug: sandboxes, the gate, the trust fast path, recovery, CI and repo rules, and the e2e flows.
None was a rendered-component or a SQLite test, though desktop views alone took 35% of CI time. The old guidance
chose the rung for a test but never whether it should exist, and several lines asked for one per behavior, row,
criterion or finding.

Turned down:

- **A CI cap on test count.** Counts move with every split or merge of a test, and a cap fails on noise.
- **Pruning tests in this change.** It is separate work, sized by area, and this change makes it welcome.
- **Removing the test-value judge.** It still reads the card; a verdict for a non-core test is a follow-up.
