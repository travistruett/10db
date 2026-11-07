# Testing

- **Prove each test goes red first.** Run it before the code that makes it pass and watch it fail
  for the expected reason. A test that never failed proves nothing.
- **Fix production code, not the test.** When a test fails, assume the code is wrong until you
  have shown the test is.
- **Pick the cheapest test that can fail for the regression you fear.** Name the regression, then
  take the first rung that can catch it:
  1. A pure function, or a row in a table that already exists.
  2. A real SQLite file in a temp directory, for a query, a transaction or a persisted row.
  3. Real HTTP via `app.request()`, for a route's contract.
  4. A real git repo in a temp directory, when git's own behavior is what can break.
  5. The real pipeline (`createTestEngine`, `createDeliveryHarness`, e2e), when the failure needs
     the parts working together.

  Count is not the cost: `packages/contracts` runs 966 tests in 1 s, and one runner step spawns
  about 33 git processes. When a decision can only be reached through an expensive fixture, move it
  into a function production calls and test that.

- **Some tests stay real, even when they look repetitive.** Merges, pushes, worktrees, migrations
  where a git merge is the behavior, and every recovery, trust, sandbox, guard and permission row.
- **Real objects on every rung, mocks only at boundaries.** A cheaper test is a smaller real thing,
  not a mock of your own code. Mock only the network, the clock and child processes you don't own
  (the fake Claude adapter is such a boundary). Add no export, flag or hook that only a test uses:
  test at the real boundary instead.
- **Extend before you add.** Before writing a test, find the tests that already cover the
  behavior. Extend one or add a table row when one fits. A new test, not a new row, carries a value
  card in the plan or step report:
  `Value: protects=<behavior>; fails_when=<regression>; why_new=<the tests you checked and what they miss>; seam=<what only the test needs, or none>; no_claim=<what green does not prove>`.
  Reviewers may ask to merge overlapping tests or fold them into a table, not only to add tests.
- **Table-driven tests** for state machines, rules and parsers: one row per case, named.
- **Test behavior, not implementation.** Assert on outputs, persisted rows and emitted events,
  not on which private function ran.
- **Match rigor to impact.** Recovery, permissions, claims and the git guard get exhaustive cases;
  a label component gets one render test.
- **Tests never inherit `GIT_*` from the environment.** Git exports `GIT_DIR` and more to hooks,
  and the pre-push hook runs tests: `tests/git-isolation.setup.ts` (first in every project's
  `setupFiles`) strips them, and every git call in test code passes an isolated `env` too (ESLint
  enforces it).
- **Test repositories turn off git's background maintenance.** A fixture that creates a repository,
  bare ones included, sets `maintenance.auto=false`, `gc.auto=0` and `receive.autogc=false` in its
  local config before the first commit or push. Otherwise a commit starts
  `git maintenance run --auto`, and a push into the repository starts receive-pack's own auto gc.
  On Apple Git 2.50 both detach and keep writing under the repository after the command returns,
  which races any test that reads its files or removes it. On CI's git, `receive.autogc` is what
  stops the receive-pack gc.
- **CI's git is older than local git, so fixtures set the config they rely on.** The gate runs in
  the Playwright image, whose git is 2.43.0 on Ubuntu 24.04 (`.github/workflows/ci.yml`); developers
  run Apple Git 2.50. The two differ: on 2.43 a commit runs `git maintenance run --auto --quiet`
  without `--detach`, and a push runs `git gc --auto` in receive-pack. Test repositories ignore
  global and system config (`isolatedGitEnvironment`), so a fixture that depends on a git setting
  sets it in its own local config and never relies on a version's default.
- **No sleeps.** Wait on a condition with a deadline; inject the clock where time matters.
- **Never pipe test output through `tail` or append `; echo $?`.** It hides failures and exit
  codes.
- **Every knowledge write is read back through search** in its test.
