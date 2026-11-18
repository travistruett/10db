---
name: review-checklist
description: Use when you review a change, yours before you finish or someone else's.
---

# Review checklist

Read the whole diff, then check each item. Report findings with file and line, most
severe first. Skip praise.

- **Criteria:** every acceptance criterion is met. A criterion needs no test of its own.
- **Correctness:** edge cases (empty input, missing file, concurrent calls, retries,
  restarts) behave as a careful user would expect. Errors are typed and actionable.
- **Boundaries:** inputs from outside (HTTP, files, tool output) are validated. Untrusted
  text is shown as data, never run or rendered as markup.
- **Scope:** no edits outside the task's claims and no unrelated refactors. Generated
  files are regenerated, not hand-edited.
- **Tests:** a test belongs only to core behavior or an escaped bug. Ask for one only
  there. Real objects, no sleeps where a condition can be awaited, no assertions that can
  never fail, no mock of the change's own code, git or a database it can run, no branch,
  flag or export only a test uses. Reject a test of merges, pushes, worktrees, migrations,
  recovery, sandboxes, guards, permissions or claims below the level exercising the real thing.
- **Test cost:** a commit that adds a test has a value card (protects, fails_when, why_new,
  no_claim). Put a new non-core test, a duplicate or a missing card in `followUps` to cut
  or fix. None rejects the change.
- **Style:** names say what things are, comments say what and why, no dead code, no
  `utils` grab-bags, no new dependency without a reason.
- **Secrets:** no tokens, keys or personal data in code, logs or fixtures.

If you find a problem in your own change, fix it, then rerun the checks for what you changed.
