---
name: review-checklist
description: Use when you review a change, yours before you finish or someone else's.
---

# Review checklist

Read the whole diff, then check each item. Report findings with file and line, most
severe first. Skip praise.

- **Criteria:** every acceptance criterion is met and has a test that would fail without
  the change.
- **Correctness:** edge cases (empty input, missing file, concurrent calls, retries,
  restarts) behave as a careful user would expect. Errors are typed and actionable.
- **Boundaries:** inputs from outside (HTTP, files, tool output) are validated. Untrusted
  text is shown as data, never run or rendered as markup.
- **Scope:** no edits outside the task's claims and no unrelated refactors. Generated
  files are regenerated, not hand-edited.
- **Tests:** real objects, no sleeps where a condition can be awaited, no assertions that
  can never fail, no mock of the change's own code, git or a database it can run, no new
  branch, flag or export only a test uses. Flag a new test that covers the same behavior as
  an existing one on the same level, and ask to merge it or fold it into a table row, not only to add tests.
  Reject a test moved to a cheaper level unless its commit names the failure seen for the
  same regression. Reject any test of merges, pushes, worktrees, migrations, recovery, sandboxes, guards,
  permissions, claims and other trust boundaries below the level exercising the real thing.
- **Test cost:** each newly tested behavior, not table case, has a value card in its commit
  or plan: protects,
  fails_when, why_new, no_claim. Note a missing card in your summary. Put a named cheaper
  replacement in `followUps`. Neither rejects the change.
- **Style:** names say what things are, comments say what and why, no dead code, no
  `utils` grab-bags, no new dependency without a reason.
- **Secrets:** no tokens, keys or personal data in code, logs or fixtures.

If you find a problem in your own change, fix it, then rerun the checks for what you changed.
