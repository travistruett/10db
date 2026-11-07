---
name: test-first
description: Use when you add or change behavior, before writing the implementation.
---

# Test first, with red proof

1. Find the tests that already cover the behavior (search by name, module, fixture). Extend
   one or add a table row when one fits.
2. Otherwise name the regression you fear and pick the cheapest test that can fail for it: a
   pure function, then a real database, then real git, then the whole flow. Merges, pushes,
   migrations, recovery, permissions and trust stay real. On every level use real objects;
   mock only at process and network boundaries, and add no hook that only a test uses.
   Give each new test, not a new row, a value card in your step report:
   `Value: protects=<behavior>; fails_when=<regression>; why_new=<the tests you checked and what they miss>; seam=<what only the test needs, or none>; no_claim=<what green does not prove>`.
3. Run only that test and watch it fail. Read the failure: it must fail because the
   behavior is missing, not because of a typo, an import error or a broken fixture.
4. Write the smallest implementation that makes it pass. Run it again and see it pass.
5. Run the checks for what you changed (its packages' tests, typecheck and lint). Never
   run the full gate: 10db runs it after your step and records the result as evidence, so a
   red gate sends the work back to you.
6. Attach anything extra you ran (a manual check, a benchmark) with
   `mcp__10db__record_evidence`.

Never weaken or delete a test to make it pass. If a test is wrong, say why in the commit
message. Never skip a failing test without asking with `mcp__10db__ask_human`.

Commit with `mcp__10db__commit`, naming every path. Never run `git commit`, `git add -A`,
`git stash`, `git checkout`, `git reset` or `git push`; 10db denies them and pushes for you.
