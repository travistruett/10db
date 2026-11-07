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
  can never fail. Flag a new test that covers the same behavior as an existing one, and ask
  to merge it or fold it into a table row, not only to add tests. Flag a test that builds
  real git or a whole flow when a cheaper one could fail for the same regression, but never
  one for merges, pushes, migrations, recovery, permissions or trust. A new test, not a new
  row, has a value card: protects, fails_when, why_new, seam, no_claim. A seam other than
  `none` needs a production caller.
- **Style:** names say what things are, comments say what and why, no dead code, no
  `utils` grab-bags, no new dependency without a reason.
- **Secrets:** no tokens, keys or personal data in code, logs or fixtures.

If you find a problem in your own change, fix it, then rerun the checks for what you changed.
