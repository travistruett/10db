---
name: test-first
description: Use when you add or change behavior, before writing the implementation.
---

# Test first, with red proof

1. Decide whether a test is needed. Write one only for core behavior (as the project's
   testing rules define it; else trust boundaries, persisted data, git, recovery) or a bug
   that escaped. A criterion or review finding alone is no reason. A user-visible change
   extends an end-to-end flow. Otherwise add none.
2. Extend a test that covers it before adding one. Else pick the cheapest that can fail: a
   pure function, a real database, real git, then the whole flow.
3. Use real objects: never mock your own code, git or a database; mock only the network,
   the clock and processes you don't own. Add no branch, flag or export only a test uses.
   Tests of merges, pushes, worktrees, migrations, recovery, sandboxes, guards, permissions
   and claims exercise the real thing.
4. Run only that test and watch it fail because the behavior is missing, not because of a
   typo, import error or broken fixture.
5. Write the smallest implementation that passes it.
6. Run the checks for what you changed (its packages' tests, typecheck and lint), never
   the full gate: 10db runs it after your step. Attach extra runs with
   `mcp__10db__record_evidence`.

Never weaken a test to pass it; if a test is wrong, say why in the commit message.
Removing a test that guards neither core nor an escaped bug is welcome, in its own commit.
Never skip a failing test without `mcp__10db__ask_human`.

Commit with `mcp__10db__commit`, naming every path. A commit that adds a test carries one
value card, wrapped to fit:
`Value: protects=<behavior>; fails_when=<regression>; why_new=<core area or escaped bug>; no_claim=<what green does not prove>`.

CI fails a PR adding more unit tests than max(3, one per 200 added code lines). If yours
must, add `Test-budget: <reason>` to the commit message.

Never run `git commit`, `git add -A`, `git stash`, `git checkout`, `git reset` or `git push`.
