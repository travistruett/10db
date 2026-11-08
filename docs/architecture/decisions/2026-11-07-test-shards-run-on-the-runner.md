# CI's test shards run on the runner, not in the Playwright image

- **Date:** 2026-11-07
- **Amends:** decision 87

## Decision

The six `gate-test-<n>` jobs in `.github/workflows/ci.yml` run on the `ubuntu-24.04` runner itself, with no job
container. `gate-e2e` still runs in Microsoft's Playwright image for the locked Playwright version, pinned by digest,
as uid 1001 under `--init`. `tests/repo/src/ci.test.ts` checks both.

## Why

Decision 87 put the whole gate in the Playwright image for its browsers. Since the gate was split into jobs
(decisions/2026-11-06-ci-splits-the-gate-into-required-jobs.md), only `gate-e2e` opens a browser. Every test shard
still pulled the image before running a test.

**What the pull cost** (Measured, `main` run 42433783704 and pull request #553's run): "Initialize containers" took
26 to 43 s of each shard job, which ran for 165 to 235 s in all. In one shard's log, 26 of its 27 s were
`docker pull`. A pull request waits for its slowest shard, so this time is on every pull request's critical path.

**The image's other two reasons hold on the runner without it:**

- **The user.** The runner runs jobs as uid 1001, which owns the checkout, so git trusts the repository without a
  `safe.directory` exception.
- **Reaping.** In a container, PID 1 never reaps an orphan, so `--init` made tini PID 1. On the runner, systemd
  reaps orphaned processes, which the recovery, gate runner and login-env tests wait on.

**What differs on the runner:**

- **git.** The runner's git is GitHub's current one (2.56.0 on image 20261101), not the image's 2.43.0, and it can
  move whenever GitHub updates the image. The first run on it failed one test, in
  `apps/daemon/src/folders/inspect.test.ts`, which matched git's own wording for a gitfile that points nowhere.
  Git 2.43 and 2.50 name the target, and 2.56 names the gitfile. The code passes git's line through, as `RepoRefusal`
  documents, so the test now names both lines. `.claude/rules/testing.md` says a test must not depend on one
  version's wording. e2e keeps exercising 2.43.
- **Installed tools.** The runner has tools the image doesn't, such as `make` and `cargo`. A test that skips when a
  tool is missing may now run, as the `make install-app` rows in `tests/repo/src/install-app.test.ts` can. No skip
  condition in the tests turns on when a tool is present. Per-file test counts in the timing artifacts, which
  include skipped tests, matched those of `main`'s run at the same base (74c252d, run 42435814034), apart from the
  new row in `tests/repo/src/ci.test.ts`.

Turned down:

- **A smaller image** with git 2.43 and procps. It still pulls on every job, and it is another image to pin and
  keep current.
- **Caching the image between runs.** GitHub-hosted runners keep no Docker layers between jobs, and restoring an
  image from `actions/cache` is itself a download of the same size.
