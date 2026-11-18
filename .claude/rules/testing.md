# Testing

A test is a cost: CI time on every run, and code to keep in step with every change. Write few, and
make each one guard something that matters.

- **A unit test is added only for core behavior or an escaped bug.**
  - Core: the git guard and its judge, the sandboxes, permissions, trust, claims, recovery, git
    merges, pushes and worktrees, migrations, and pure rule tables and parsers.
  - A bug that escaped to a user, a merge or CI gets one regression test, on the cheapest rung that
    fails for it.
  - Nothing else earns a test by existing: not a behavior, a state-table row, an acceptance criterion
    or a review finding. State tables and criteria are design and review tools, not a test list.
- **A user-visible feature extends a core e2e flow** (`apps/desktop/e2e`) through the real daemon and
  app. It adds no rendered-component test.
- **Count is a cost. Extend before you add**, and removing a test that guards neither core nor an
  escaped bug is welcome, in its own commit.
- **Prove each test goes red first**, and **fix production code, not the test**: assume the code is
  wrong until you have shown the test is.
- **Take the cheapest rung that fails for the regression:** a pure function; a real SQLite file in a
  temp directory; a real git repo in a temp directory; the real pipeline (`createTestEngine`,
  `createDeliveryHarness`, e2e). Core tests of merges, pushes, worktrees, recovery, claims and
  permissions start on the rung that exercises the real thing; a pure rule table stays pure, with
  one test through the wiring.
- **Real objects, mocks only at boundaries.** Never mock your own code, git or SQLite. Mock only the
  network, the clock and child processes you don't own (the fake Claude adapter is one).
- **No new test-only code.** An injected dependency with a production default is fine; a branch,
  flag or export only a test uses is not.
- **A commit that adds a test carries one value card**, wrapped to fit, with `why_new` naming the
  core area or the escaped bug:
  `Value: protects=<behavior>; fails_when=<regression>; why_new=<core area or escaped bug>; no_claim=<what green does not prove>`.
- **Test behavior, not implementation.** Assert on outputs, persisted rows and emitted events.
- **Tests never inherit `GIT_*`.** Git exports `GIT_DIR` and more to hooks, and the pre-push hook
  runs tests: `tests/git-isolation.setup.ts` (first in every project's `setupFiles`) strips them,
  and every git call in test code passes an isolated `env` (ESLint enforces it).
- **Test repositories turn off git's background maintenance.** A fixture that creates a
  repository, bare ones included, sets `maintenance.auto=false`, `gc.auto=0` and
  `receive.autogc=false` in its local config before the first commit or push. On Apple Git 2.50 a
  commit's `git maintenance run --auto` and a push's receive-pack gc detach and keep writing under the
  repository after the command returns, racing any test that reads or removes it.
- **CI's git differs from local git.** Developers run Apple Git 2.50; CI's shards run the
  `ubuntu-24.04` runner's git, which moves with the image, and the e2e step runs the Playwright
  image's git 2.43.0 (`.github/workflows/ci.yml`), where a commit runs maintenance without
  `--detach` and a push runs `git gc --auto` in receive-pack. Test repositories ignore global and
  system config (`isolatedGitEnvironment`), so a fixture sets the git config it relies on locally.
  A test that checks git's own text names the wording of every git it runs on, or checks what 10db
  does with the text instead.
- **No sleeps.** Wait on a condition with a deadline; inject the clock where time matters.
- **Never pipe test output through `tail` or append `; echo $?`.** It hides failures and exit
  codes.
- **Every knowledge write is read back through search** in its test.
