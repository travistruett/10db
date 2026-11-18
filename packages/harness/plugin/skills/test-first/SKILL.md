---
name: test-first
description: Use when you add or change behavior, before writing the implementation.
---

# Test first, with red proof

1. Decide whether a test is needed. Write one only for core behavior (what the project's
   testing rules call core; otherwise trust boundaries, persisted data, git, recovery) or a
   bug that escaped. A criterion or review finding alone is no reason. A user-visible change
   extends an end-to-end flow. Otherwise add none.
2. Extend a test that covers it before adding one. Else pick the cheapest that can fail: a
   pure function, a real database, real git, then the whole flow.
3. Use real objects: never mock your own code, git or a database you can run; mock only the
   network, the clock and processes you don't own. Add no branch, flag or export only a test
   uses. Tests of merges, pushes, worktrees, migrations, recovery, sandboxes, guards,
   permissions and claims run on the level that exercises the real thing.
4. Run only that test and watch it fail because the behavior is missing, not because of a
   typo, an import error or a broken fixture.
5. Write the smallest implementation that makes it pass. Run it and see it pass.
6. Run the checks for what you changed (its packages' tests, typecheck and lint). Never
   run the full gate: 10db runs it after your step.
7. Attach any extra run with `mcp__10db__record_evidence`.

Never weaken a test to make it pass; if a test is wrong, say why in the commit message.
Removing a test that guards neither core nor an escaped bug is welcome, in its own commit.
Never skip a failing test without asking with `mcp__10db__ask_human`.

Commit with `mcp__10db__commit`, naming every path. A commit that adds a test carries one
value card, wrapped to fit:
`Value: protects=<behavior>; fails_when=<regression>; why_new=<core area or escaped bug>; no_claim=<what green does not prove>`.

Never run `git commit`, `git add -A`, `git stash`, `git checkout`, `git reset` or `git push`; 10db denies them and pushes for you.
