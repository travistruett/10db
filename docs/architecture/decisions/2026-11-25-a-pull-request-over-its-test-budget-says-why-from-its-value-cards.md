# A pull request over its test budget says why from its value cards

- **Date:** 2026-11-25
- **Amends:** `decisions/2026-11-18-a-pull-request-over-its-unit-test-budget-says-why.md` (a lane no longer has to
  remember the line)

## Decision

When 10db writes a pull request's body (`createPr`, and the later pushes that add missing lines), a batch with no
`Test-budget:` line in its commit messages gets one when:

- the project has the budget check (`scripts/test-budget.mjs` at the shipped commit);
- the batch's new unit tests, counted as CI counts them, are over max(3, one per 200 added code lines); and
- every non-merge commit that adds a test (net of those it removes) carries a value card whose `why_new` names a
  core area or an escaped bug (`.claude/rules/testing.md`).

The line summarises those `why_new` values. When some such commit has no such card (none, or a `why_new` that names
neither), or a diff is too long to count, no line is written and CI's failed check starts a Fix CI batch as today.
That batch's description tells the fix session to read the message in the job's log, since the job's name
(`pr-title`) does not say it also checks the unit-test budget.

The counting rules are copied from `tests/repo/src/test-budget.ts` into the daemon, which cannot import `tests/`;
`test-budget-reason.test.ts` runs both over one diff so a drift fails.

Provider parity: git and commit messages only; no provider is involved.

## Why

A lane adds the line by hand or the pull request fails a required check for what its own commits already say. Only a
value card that names a core area or an escaped bug earns the exemption, so the line stays an honest summary.
