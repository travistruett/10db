# CI on the pull request is the gate; the full local gate is no longer required before a push

- **Date:** 2026-11-13

## Decision

Work in this repository is done when the pull request's CI is green. Before a push, a contributor runs
`make check-changed`: format, lint, typecheck, tests and drift of the packages the diff touches and their
dependents. The pre-push hook still runs `make precheck`. `make gate` stays as it is and anyone may run it, for
example to prove a change on the Mac before CI sees it, but it is no longer required, and the pull request
checklist asks for `make check-changed` and green CI instead of `GATE PASS`.

This rule is about contributors to this repository. What 10db does for a project's lanes (it runs the project's
check after each implement step and the project's gate command before the push) is product behaviour and is not
changed here. `CONTRIBUTING.md`'s first-time setup still ends with a `make gate` that prints `GATE PASS`, which
proves the tools are installed.

## Why

CI already runs every step `make gate` runs (`.github/workflows/ci.yml`): typecheck, build, drift and knip in
`gate-static`, the tests in six shards, e2e in the Playwright image, format, lint and the repo rules in `policy`,
and the Tauri shell's `make rust-check` on macOS when the desktop's files change
(`decisions/2026-11-04-desktop-runs-on-macos-only-when-its-files-change.md`). A required check fails the pull
request, and `main` merges only on green required checks (`decisions/2026-11-02-main-has-no-merge-queue.md`), so
the local gate repeated work whose result CI decides anyway.

The repeat was slow and less reliable than CI. Several Claude Code sessions share one 10-core Mac; on 2026-11-13
its load average was 44. A local gate on 2026-10-28 took 3.3 minutes; one on 2026-11-10 took about 19, 14.5 of
them in the test step. The Settings build that day (PR #594) went red locally only on tests that depend on load:
a 100 ms wall-clock assertion in `apps/daemon/src/folders/code-routes.test.ts` and the git-heavy `pass/*` tests.
Each passed alone, and none failed in CI. A pull request's CI on the same day took 5 to 11 minutes.

Turned down:

- Keeping the local gate and making it faster. The load comes from parallel sessions, not from the gate; a faster
  gate still repeats CI. The tests that fail under load are being made load-proof separately.
- Running the full gate in the pre-push hook. That moves the same 20 minutes to every push.

CI has to be trustworthy for this to hold: a flaky CI test now costs a rerun of the pull request instead of a
local rerun. `main`'s CI was red on 5 of its 13 pushes before this change, from two tests: the opening-pictures
test in `apps/desktop/src/views/workbench/thread.test.tsx` (fixed with this decision) and the link-swap test in
`apps/daemon/src/session-setup/instructions.test.ts`, which caught a real race in the checkout file reader that
PR #592 fixes.
