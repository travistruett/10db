# Testing

- **Prove each test goes red first.** Run it before the code that makes it pass and watch it fail
  for the expected reason. A test that never failed proves nothing.
- **Fix production code, not the test.** When a test fails, assume the code is wrong until you
  have shown the test is.
- **Real objects, mocks only at boundaries.** Use a real SQLite file in a temp directory, a real
  git repo in a temp directory, real HTTP via `app.request()`. Mock only the network, the clock
  and child processes you don't own (the fake Claude adapter is such a boundary).
- **Table-driven tests** for state machines, rules and parsers: one row per case, named.
- **Test behavior, not implementation.** Assert on outputs, persisted rows and emitted events,
  not on which private function ran.
- **Match rigor to impact.** Recovery, permissions, claims and the git guard get exhaustive cases;
  a label component gets one render test.
- **Tests never inherit `GIT_*` from the environment.** Git exports `GIT_DIR` and more to hooks,
  and the pre-push hook runs tests: `tests/git-isolation.setup.ts` (first in every project's
  `setupFiles`) strips them, and every git call in test code passes an isolated `env` too (ESLint
  enforces it).
- **Test repositories turn off git's background maintenance.** A fixture that creates a repository
  sets `maintenance.auto=false` and `gc.auto=0` in its local config before the first commit. Git
  2.55 and later otherwise leave a detached `git maintenance run --auto` writing under `.git` after
  a commit returns, which races any test that reads the repository's files.
- **No sleeps.** Wait on a condition with a deadline; inject the clock where time matters.
- **Never pipe test output through `tail` or append `; echo $?`.** It hides failures and exit
  codes.
- **Every knowledge write is read back through search** in its test.
