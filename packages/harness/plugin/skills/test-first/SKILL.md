---
name: test-first
description: Use when you add or change behavior, before writing the implementation.
---

# Test first, with red proof

1. Find the tests that already cover the behavior (search by name, module, fixture). Extend
   one or add a case to a table when one fits, at any fixture cost.
2. If none fits, name the regression you fear and pick the cheapest test that can fail for
   it: a pure function, then a real database, then a rendered view or an HTTP call, then
   real git, then the whole flow.
3. Write the test. Use real objects: never mock your own code, git or the database; mock
   only the network, the clock and processes you don't own. Add no branch, flag or export
   that only a test uses. Tests of merges, pushes, worktrees, migrations, recovery,
   sandboxes, guards, permissions, claims and other trust boundaries never move to a
   cheaper level.
4. Run only that test and watch it fail. Read the failure: it must fail because the
   behavior is missing, not because of a typo, an import error or a broken fixture.
5. Write the smallest implementation that makes it pass. Run it and see it pass.
6. Run the checks for what you changed (its packages' tests, typecheck and lint). Never
   run the full gate: 10db runs it after your step and records the result as evidence, so a
   red gate sends the work back to you.
7. Attach anything extra you ran (a manual check, a benchmark) with
   `mcp__10db__record_evidence`.

Never weaken or delete a test to make it pass. If a test is wrong, say why in the commit
message. Never skip a failing test without asking with `mcp__10db__ask_human`.

Commit with `mcp__10db__commit`, naming every path. Each new test, not case, gets a value
card there, wrapped to fit:
`Value: protects=<behavior>; fails_when=<regression>; why_new=<tests checked, what they miss>; seam=<test-only code added, or none>; no_claim=<what green does not prove>`.

Never run `git commit`, `git add -A`, `git stash`, `git checkout`, `git reset` or `git push`; 10db denies them and pushes for you.
