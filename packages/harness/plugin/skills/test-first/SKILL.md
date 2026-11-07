---
name: test-first
description: Use when you add or change behavior, before writing the implementation.
---

# Test first, with red proof

1. Find the tests that already cover the behavior. Extend one or add a case to a table when
   it sits on the cheapest level that can catch the regression you fear.
2. If not, pick the cheapest test that can fail for it: a pure function, then a real
   database, then a rendered view or an HTTP call, then real git, then the whole flow.
3. Write the test. Use real objects: never mock your own code, git or a database you can
   run; mock only the network, the clock and processes you don't own. Add no branch, flag
   or export that only a test uses. Tests of merges, pushes, worktrees, migrations, recovery,
   sandboxes, guards, permissions, claims and other trust boundaries start on, and never
   move below, the level that exercises the real thing.
4. Run only that test and watch it fail. Read the failure: it must fail because the
   behavior is missing, not because of a typo, an import error or a broken fixture.
5. Write the smallest implementation that makes it pass. Run it and see it pass.
6. Run the checks for what you changed (its packages' tests, typecheck and lint). Never
   run the full gate: 10db runs it after your step, so a red gate sends the work back to you.
7. Attach any extra run with `mcp__10db__record_evidence`.

Never weaken or delete a test to make it pass. If a test is wrong, say why in the commit
message. Never skip a failing test without asking with `mcp__10db__ask_human`.

Commit with `mcp__10db__commit`, naming every path. Each newly tested behavior, not table case, gets one
value card there, wrapped to fit, and a test moved to a cheaper level names the failure you saw:
`Value: protects=<behavior>; fails_when=<regression>; why_new=<tests checked, what they miss>; no_claim=<what green does not prove>`.

Never run `git commit`, `git add -A`, `git stash`, `git checkout`, `git reset` or `git push`; 10db denies them and pushes for you.
