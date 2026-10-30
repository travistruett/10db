---
name: test-first
description: Use when you add or change behavior, before writing the implementation.
---

# Test first, with red proof

1. Write the test for the behavior you are about to add or fix. Use real objects;
   mock only at process and network boundaries.
2. Run only that test and watch it fail. Read the failure: it must fail because the
   behavior is missing, not because of a typo, an import error or a broken fixture.
3. Write the smallest implementation that makes it pass. Run it again and see it pass.
4. Run the checks for what you changed (its packages' tests, typecheck and lint). Never
   run the full gate: 10db runs it after your step and records the result as evidence, so a
   red gate sends the work back to you.
5. Attach anything extra you ran (a manual check, a benchmark) with
   `mcp__10db__record_evidence`.

Never weaken or delete a test to make it pass. If a test is wrong, say why in the commit
message. Never skip a failing test without asking with `mcp__10db__ask_human`.

Commit with `mcp__10db__commit`, naming every path. Never run `git commit`, `git add -A`,
`git stash`, `git checkout`, `git reset` or `git push`; 10db denies them and pushes for you.
