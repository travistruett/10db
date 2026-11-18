# A pull request over its unit-test budget says why

- **Date:** 2026-11-18
- **Amends:** `decisions/2026-11-18-tests-cover-core-behavior-and-escaped-bugs.md` (it turned down a CI cap on
  test count), `decisions/2026-11-17-pr-title-lint-runs-in-its-own-workflow.md` (its one job now checks the
  budget too)

## Decision

CI fails a pull request that adds more unit tests than its budget, unless its body says why.

- The budget is max(3, floor(added code lines / 200)). Code lines are the lines added to files the test
  report counts as code (`classifyPath` in `tests/repo/src/test-report.ts`).
- A unit test is an added `it(` or `test(` call, `.each`, `.skip` and the like included, in a `*.test.ts` or
  `*.test.tsx` file, net of removed ones. An `it.each` table counts as one. Files under `apps/desktop/e2e` do
  not count: the core e2e flows are the main check.
- Over budget, the check passes when the body has a line starting `Test-budget:` followed by a reason.
- The check is a step of the `pr-title` job (`.github/workflows/pr-title.yml`, `scripts/test-budget.mjs`). That
  workflow already runs on `edited`, so saving the body reruns it with no new push, and `pr-title` is already a
  required check, so no ruleset changes. The body reaches the script through an env var only.
- A lane cannot edit a pull request body, but it writes commit messages. A lane over budget puts
  `Test-budget: <reason>` in the message of the commit that adds the tests, and the shipper copies every such
  line of the batch's non-merge commits into the body when it opens the pull request (`testBudgetLines` in
  `apps/daemon/src/delivery/pr-text.ts`).

Provider parity: the check runs in GitHub CI whatever account built the change, and lanes on every provider
write commit messages, so the escape works the same on each.

## Why

The builder: "I would rather have SIGNIFICANTLY less tests but just covering core functionality ... The most
important thing right now is that I can MOVE FAST. Once things stabilize we can always add more tests based on
actual bugs." A rule that matters ships with a mechanism, and the testing rule had none in CI.

The earlier record turned down a cap because counts move with every split or merge of a test and a cap fails on
noise. This one counts only cases a pull request adds, net of what it removes, and gives a written escape: noise
costs one line in the body, not a stuck pull request.

Measured on 2026-11-18 from CI timing artefacts: 28,242 tests in 1,238 files and 4,238 CPU-seconds a run, while
in two weeks of pull request CI only 15 test files failed for a real bug.

Turned down:

- **A new job in `ci.yml`.** `ci.yml` must not run on `edited`, and a new job is a new required check name, a
  ruleset change.
- **Counting each `it.each` row.** Rows are cheap and often data, and the test-value judge counts a table as
  one case too.
- **Refreshing the body on later pushes.** The body is written when the pull request opens; a later commit that
  adds tests needs its line added by hand until a follow-up rewrites it.
- **Matching multi-line or wrapped calls.** The count reads one line per case; a miss lets a test through, which
  errs toward moving fast.
